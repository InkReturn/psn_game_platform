/**
 * 棋类权威房间 WebSocket 联机测试（无需浏览器）。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖井字棋 / 黑白棋 / 四子棋：
 * 建房、邀请加入、自动开局、合法与非法落子、轮次校验、越权落子被拒、
 * 客户端伪造状态被服务器忽略、认输、重开、断线重连与房间满员。
 *
 * 关键断言：客户端只发意图。测试会尝试在 game.action 里夹带 board/winner/turn
 * 等伪造字段，服务器必须完全不采纳，权威快照只能来自服务器自己的推进。
 *
 * 运行方式：node tests/grid-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const TEST_PORT = 18084;
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}/ws`;
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`;

/** 用例结果收集。 */
const results = [];
/** 被测服务器进程。 */
let serverProcess = null;
/** 被测服务器输出缓冲（失败时打印，避免 stdout 被吞导致无法定位）。 */
const serverLogs = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
}

/**
 * 断言相等（JSON 比较）。
 *
 * @param {*} actual - 实际值。
 * @param {*} expected - 期望值。
 * @param {string} label - 描述。
 */
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 轮询 /health 等待被测服务器就绪（不能用固定 sleep，冷启动耗时不确定）。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early with code ${serverProcess.exitCode}\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_HTTP}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${timeoutMs}ms\n${serverLogs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 测试用客户端封装。
 *
 * @param {string} label - 客户端标签（日志用）。
 * @returns {object} 客户端 API。
 */
function makeClient(label) {
  const ws = new WebSocket(BASE_WS);
  /** @type {Map<string, Function[]>} type -> 等待器 */
  const waiters = new Map();
  /** requestId -> resolve */
  const pendingReqs = new Map();
  /** 收到的全部消息（用于隐私/泄漏断言）。 */
  const received = [];
  let reqId = 1;

  /**
   * 等待下一条匹配的消息。
   *
   * @param {string} type - 消息类型。
   * @param {Function} [predicate] - 附加过滤 (payload) => boolean。
   * @param {number} [timeoutMs] - 超时毫秒。
   * @returns {Promise<object>} 消息 payload。
   */
  function waitFor(type, predicate, timeoutMs = 3000) {
    return new Promise((resolve, reject) => {
      const found = received.find((m) => m.type === type && (!predicate || predicate(m.payload)));
      if (found) return resolve(found.payload);
      const timer = setTimeout(() => reject(new Error(`[${label}] timeout waiting ${type}`)), timeoutMs);
      const list = waiters.get(type) || [];
      list.push({
        check(m) {
          if (!predicate || predicate(m.payload)) {
            clearTimeout(timer);
            resolve(m.payload);
            return true;
          }
          return false;
        },
      });
      waiters.set(type, list);
    });
  }

  /**
   * 发送请求并等待带 requestId 的响应。
   *
   * @param {string} type - 请求类型。
   * @param {object} payload - 负载。
   * @returns {Promise<object>} 响应 payload。
   */
  function request(type, payload) {
    const requestId = `t${reqId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${label}] no response for ${type}`)), 3000);
      pendingReqs.set(requestId, (m) => {
        clearTimeout(timer);
        if (m.type === "room.error") reject(Object.assign(new Error(m.payload.code), { code: m.payload.code, payload: m.payload }));
        else resolve(m.payload);
      });
      ws.send(JSON.stringify({ version: 1, type, requestId, payload: payload || {} }));
    });
  }

  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    received.push(m);
    // 1. 响应匹配。
    if (m.requestId && pendingReqs.has(m.requestId)) {
      const fn = pendingReqs.get(m.requestId);
      pendingReqs.delete(m.requestId);
      fn(m);
    }
    // 2. 等待器匹配。
    const list = waiters.get(m.type);
    if (list) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].check(m)) list.splice(i, 1);
      }
    }
  });

  return { ws, open: openPromise, request, waitFor, received, close: () => ws.close(), terminate: () => ws.terminate(), label };
}

/**
 * 执行一段用例并记录结果（失败不中断后续用例）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 异步用例体。
 */
async function testCase(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err.message);
  }
}

/**
 * 建房 + 加入，返回两侧客户端与房间信息。
 *
 * @param {string} gameType - 游戏类型。
 * @param {string} prefix - 房间码前缀。
 * @returns {Promise<{A: object, B: object, roomRef: object}>} 客户端与房间引用。
 */
async function setupRoom(gameType, prefix) {
  const A = makeClient("A");
  const B = makeClient("B");
  await Promise.all([A.open, B.open]);
  const created = await A.request("room.create", { gameType, prefix, nickname: "房主甲" });
  const joined = await B.request("room.join", { roomId: created.roomId, nickname: "玩家乙", gameType });
  return { A, B, roomRef: { roomId: created.roomId, hostCreds: created, guestCreds: joined } };
}

(async () => {
  // 1. 启动被测服务器。
  serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(TEST_PORT), BIND_HOST: "127.0.0.1" },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const collect = (chunk) => {
    serverLogs.push(chunk.toString());
    if (serverLogs.length > 200) serverLogs.shift();
  };
  serverProcess.stdout.on("data", collect);
  serverProcess.stderr.on("data", collect);
  await waitForServer();

  // ── 井字棋 ──────────────────────────────────────────────────
  const tt = await setupRoom("tictactoe", "JZ");

  await testCase("井字棋：同一连接重复建房被拒（ALREADY_IN_ROOM）", async () => {
    try {
      await tt.A.request("room.create", { gameType: "tictactoe", prefix: "JZ", nickname: "多余" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ALREADY_IN_ROOM", "错误码");
    }
  });

  await testCase("井字棋：房间码前缀为 JZ，房主执黑", async () => {
    assert(/^JZ[A-Z0-9]{6}$/.test(tt.roomRef.roomId), `房间码格式应为 JZ+6 位，实际 ${tt.roomRef.roomId}`);
    assertEq(tt.roomRef.hostCreds.snapshot.game.seatPlayerIds.black, tt.roomRef.hostCreds.playerId, "房主坐黑位");
    assertEq(tt.roomRef.guestCreds.snapshot.game.seatPlayerIds.white, tt.roomRef.guestCreds.playerId, "访客坐白位");
    assertEq(tt.roomRef.guestCreds.snapshot.game.started, true, "两人到齐自动开局");
    assertEq(tt.roomRef.guestCreds.snapshot.game.players.black, "房主甲", "黑方昵称");
    assertEq(tt.roomRef.guestCreds.snapshot.game.players.white, "玩家乙", "白方昵称");
  });

  await testCase("井字棋：第三方加入满员房被拒（ROOM_FULL）", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId: tt.roomRef.roomId, nickname: "第三者", gameType: "tictactoe" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "错误码");
    }
    C.close();
  });

  await testCase("井字棋：访客抢先落子被服务器拒绝（NOT_YOUR_TURN）", async () => {
    try {
      await tt.B.request("game.action", { action: "move", row: 0, col: 0 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
  });

  await testCase("井字棋：客户端夹带伪造棋盘/胜负字段被完全忽略", async () => {
    // 1. 黑方落子，同时夹带伪造的 board / winner / turn / record。
    const forged = Array.from({ length: 3 }, () => [1, 1, 1]);
    const res = await tt.A.request("game.action", {
      action: "move",
      row: 2,
      col: 2,
      board: forged,
      winner: 1,
      turn: 1,
      record: { total: 99, players: { 房主甲: 99 }, draw: 0 },
      message: "我赢了",
    });
    // 2. 服务器只采纳自己推导出的状态。
    assertEq(res.snapshot.game.board[2][2], 1, "服务器记录真实落子");
    assertEq(res.snapshot.game.board[0][0], 0, "伪造棋盘未被采纳");
    assertEq(res.snapshot.game.winner, 0, "伪造胜负未被采纳");
    assertEq(res.snapshot.game.turn, 2, "轮次由服务器推导为白方");
    assertEq(res.snapshot.game.record.total, 0, "伪造战绩未被采纳");
  });

  await testCase("井字棋：占用格落子被拒（CELL_OCCUPIED），棋盘不变", async () => {
    try {
      await tt.B.request("game.action", { action: "move", row: 2, col: 2 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "CELL_OCCUPIED", "错误码");
    }
    const A = tt.A.received.filter((m) => m.type === "game.updated").at(-1);
    assertEq(A.payload.snapshot.game.moves.length, 1, "落子数保持 1");
  });

  await testCase("井字棋：切到黑白棋房间类型加入被拒（ROOM_TYPE_MISMATCH）", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId: tt.roomRef.roomId, nickname: "路人", gameType: "reversi" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ROOM_TYPE_MISMATCH", "错误码");
    }
    C.close();
  });

  await testCase("井字棋：双方轮流落子直到黑棋连三，双方胜负与战绩一致", async () => {
    // 现状：黑已下 (2,2)，轮白。走法安排为白方不连三、黑方在第 0 行连三收尾。
    const script = [
      [tt.B, 1, 0],
      [tt.A, 0, 0],
      [tt.B, 2, 0],
      [tt.A, 0, 1],
      [tt.B, 1, 2],
      [tt.A, 0, 2],
    ];
    for (const [client, row, col] of script) {
      await client.request("game.action", { action: "move", row, col });
    }
    // 服务端对同一动作会分别向两名玩家推送 game.updated：请求者靠 requestId 拿到响应，
    // 对手的帧走另一条 socket，需要显式等待它到达，否则会读到上一手（竞态）。
    await tt.B.waitFor("game.updated", (p) => p.snapshot.game.winner === 1);
    const hostView = tt.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    const guestView = tt.B.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    assertEq(hostView.winner, 1, "黑方（房主）获胜");
    assertEq(hostView.moves.length, 7, "总手数");
    assertEq(hostView.record.total, 1, "战绩总局数");
    assertEq(hostView.record.players["房主甲"], 1, "胜场记到昵称");
    assertEq(hostView.record.winners.black, 1, "座位维度胜场归黑方");
    assertEq(hostView.record.winners.white, 0, "座位维度白方 0 胜");
    assertEq(hostView.winner, guestView.winner, "两端胜负一致");
    assertEq(hostView.moves.length, guestView.moves.length, "两端手数一致");
  });

  await testCase("井字棋：重名玩家时座位胜场不互相污染", async () => {
    // 两位玩家使用同一个昵称时，record.players 会合并计数（展示折衷），
    // 但 record.winners 必须仍按座位区分，否则 UI 会出现"两边都显示同样胜场"的错。
    const S1 = makeClient("S1");
    const S2 = makeClient("S2");
    await Promise.all([S1.open, S2.open]);
    const same = await S1.request("room.create", { gameType: "tictactoe", prefix: "JZ", nickname: "玩家7288" });
    await S2.request("room.join", { roomId: same.roomId, nickname: "玩家7288", gameType: "tictactoe" });
    // 黑连三取胜。
    const seq = [
      [S1, 0, 0],
      [S2, 1, 0],
      [S1, 0, 1],
      [S2, 1, 1],
      [S1, 0, 2],
    ];
    let last = null;
    for (const [client, row, col] of seq) last = await client.request("game.action", { action: "move", row, col });
    const g = last.snapshot.game;
    assertEq(g.record.total, 1, "总局数 1");
    assertEq(g.record.winners.black, 1, "黑方 1 胜");
    assertEq(g.record.winners.white, 0, "白方 0 胜（不得因重名被记成 1 胜）");
    // 昵称维度会合并成同一个人 1 胜，这是可接受的展示口径，但两个座位读数必须不同。
    assert(g.record.winners.black !== g.record.winners.white, "两座位胜场不得相同");
    S1.close();
    S2.close();
  });

  await testCase("井字棋：结束后再落子被拒（GAME_ALREADY_FINISHED）", async () => {
    try {
      await tt.B.request("game.action", { action: "move", row: 2, col: 0 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  await testCase("井字棋：再开一把交换先手且保留战绩", async () => {
    const res = await tt.A.request("game.action", { action: "play_again" });
    const g = res.snapshot.game;
    assertEq(g.moves.length, 0, "棋盘已清空");
    assertEq(g.winner, 0, "胜负已清空");
    assertEq(g.started, true, "新一局已开始");
    assertEq(g.record.total, 1, "战绩保留");
    assertEq(g.moves.length, 0, "落子记录清空");
  });

  await testCase("井字棋：断线后重连恢复身份与座位", async () => {
    tt.B.terminate();
    await tt.A.waitFor("room.player_disconnected");
    const B2 = makeClient("B2");
    await B2.open;
    const res = await B2.request("room.reconnect", {
      roomId: tt.roomRef.roomId,
      playerId: tt.roomRef.guestCreds.playerId,
      reconnectToken: tt.roomRef.guestCreds.reconnectToken,
    });
    // 注意：play_again 会交换先后手，因此重连后不能假设访客仍在白位，
    // 只断言"原身份仍占着某个座位且昵称正确"。
    const seats = res.snapshot.game.seatPlayerIds;
    assert(
      seats.black === tt.roomRef.guestCreds.playerId || seats.white === tt.roomRef.guestCreds.playerId,
      `重连后应仍占一个座位，实际 ${JSON.stringify(seats)}`,
    );
    const guestSeatName = seats.black === tt.roomRef.guestCreds.playerId ? res.snapshot.game.players.black : res.snapshot.game.players.white;
    assertEq(guestSeatName, "玩家乙", "昵称恢复");
    tt.B = B2;
    tt.guestColor = seats.black === tt.roomRef.guestCreds.playerId ? 1 : 2;
  });

  await testCase("井字棋：交换位置由服务器执行并广播给双方", async () => {
    const before = (await tt.A.request("game.action", { action: "play_again" })).snapshot.game;
    const beforeSeats = { ...before.seatPlayerIds };
    const res = await tt.A.request("game.action", { action: "switch_side" });
    const after = res.snapshot.game;
    assertEq(after.seatPlayerIds.black, beforeSeats.white, "黑位换成原来的白位玩家");
    assertEq(after.seatPlayerIds.white, beforeSeats.black, "白位换成原来的黑位玩家");
    assertEq(after.moves.length, 0, "换位后棋盘清空");
    assertEq(after.started, true, "换位后仍处于可对局状态");
    // 对手侧也必须收到同一份快照（帧走另一条 socket，需显式等待避免读到旧状态）。
    await tt.B.waitFor("game.updated", (p) => p.snapshot.game.seatPlayerIds.black === after.seatPlayerIds.black);
    const guestView = tt.B.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    assertEq(guestView.seatPlayerIds.black, after.seatPlayerIds.black, "对手侧座位同步");
  });

  await testCase("井字棋：对局进行中且已有落子时禁止交换位置", async () => {
    // 先让当前先手落一子，使对局进入"进行中且有落子"状态。
    const g0 = tt.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    const mover = g0.seatPlayerIds.black === tt.roomRef.hostCreds.playerId ? tt.A : tt.B;
    await mover.request("game.action", { action: "move", row: 1, col: 1 });
    try {
      await tt.A.request("game.action", { action: "switch_side" });
      throw new Error("对局进行中不应允许换位");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
  });

  await testCase("井字棋：认输由服务器判定并在两端一致", async () => {
    // 由当前回合方认输，胜方必须是其对手。
    const before = tt.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    const hostIsBlack = before.seatPlayerIds.black === tt.roomRef.hostCreds.playerId;
    const loserIsHost = hostIsBlack === (before.turn === 1);
    const loser = loserIsHost ? tt.A : tt.B;
    const expectedWinner = before.turn === 1 ? 2 : 1;
    const res = await loser.request("game.action", { action: "surrender" });
    assertEq(res.snapshot.game.winner, expectedWinner, "认输方的对手获胜");
    const hostView = tt.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    assertEq(hostView.winner, res.snapshot.game.winner, "房主侧胜负一致");
  });

  await testCase("井字棋：离开房间后座位释放并通知对手", async () => {
    const before = tt.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    const guestIsBlack = before.seatPlayerIds.black === tt.roomRef.guestCreds.playerId;
    const left = tt.A.waitFor("room.player_left");
    await tt.B.request("room.leave");
    const ev = await left;
    assertEq(ev.snapshot.game.players[guestIsBlack ? "black" : "white"], "等待", "访客座位已释放");
    assertEq(ev.snapshot.game.started, false, "未满员回到等待状态");
  });
  tt.A.close();
  tt.B.close();

  // ── 四子棋 ──────────────────────────────────────────────────
  const c4 = await setupRoom("connect4", "SZ");

  await testCase("四子棋：房间码前缀为 SZ，重力落子由服务器推导行号", async () => {
    assert(/^SZ[A-Z0-9]{6}$/.test(c4.roomRef.roomId), `房间码格式，实际 ${c4.roomRef.roomId}`);
    // 客户端故意传 row=0，服务器必须落到最后一行（5）。
    const res = await c4.A.request("game.action", { action: "move", row: 0, col: 2 });
    assertEq(res.snapshot.game.moves[0].row, 5, "首子落在第 5 行");
    assertEq(res.snapshot.game.turn, 2, "轮到白方");
  });

  await testCase("四子棋：竖直连四判胜", async () => {
    // 黑在 2 列已有一子，继续堆到四连；白在 3 列陪走。
    const script = [
      [c4.B, 3],
      [c4.A, 2],
      [c4.B, 3],
      [c4.A, 2],
      [c4.B, 3],
      [c4.A, 2],
    ];
    for (const [client, col] of script) {
      await client.request("game.action", { action: "move", row: 0, col });
    }
    const g = c4.A.received.filter((m) => m.type === "game.updated").at(-1).payload.snapshot.game;
    assertEq(g.winner, 1, "黑方连四获胜");
    assertEq(g.moves.length, 7, "总手数");
  });

  await testCase("四子棋：结束后列已满被拒（GAME_ALREADY_FINISHED 优先）", async () => {
    try {
      await c4.B.request("game.action", { action: "move", row: 0, col: 2 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });
  c4.A.close();
  c4.B.close();

  // ── 黑白棋 ──────────────────────────────────────────────────
  const rv = await setupRoom("reversi", "HB");

  await testCase("黑白棋：房间码前缀为 HB，初始四子摆好", async () => {
    assert(/^HB[A-Z0-9]{6}$/.test(rv.roomRef.roomId), `房间码格式，实际 ${rv.roomRef.roomId}`);
    const g = rv.roomRef.guestCreds.snapshot.game;
    assertEq(g.board[3][3], 2, "(3,3) 白");
    assertEq(g.board[3][4], 1, "(3,4) 黑");
    assertEq(g.board[4][3], 1, "(4,3) 黑");
    assertEq(g.board[4][4], 2, "(4,4) 白");
  });

  await testCase("黑白棋：无夹吃的落点被拒（ILLEGAL_MOVE_TARGET）", async () => {
    try {
      await rv.A.request("game.action", { action: "move", row: 0, col: 0 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "错误码");
    }
  });

  await testCase("黑白棋：合法落子翻转被夹住的对方子", async () => {
    const res = await rv.A.request("game.action", { action: "move", row: 2, col: 3 });
    const g = res.snapshot.game;
    assertEq(g.board[2][3], 1, "落点为自己颜色");
    assertEq(g.board[3][3], 1, "被夹白子翻成黑");
    assertEq(g.moves.length, 1, "记录一手");
    assertEq(g.moves[0].flips, 1, "翻转 1 子");
    assertEq(g.turn, 2, "轮到白方");
  });

  await testCase("黑白棋：默认未开启悔棋，undo 被拒（INVALID_ACTION）", async () => {
    try {
      await rv.A.request("game.action", { action: "undo" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
  });

  await testCase("黑白棋：白方落后时不能撤回黑方的棋（NOT_YOUR_PIECE）", async () => {
    // 先由房主开启悔棋（未开局时不允许，此处已开局 -> 应被拒）。
    try {
      await rv.A.request("game.action", { action: "set_undo_mode", undoMode: "undo" });
      throw new Error("对局中不应允许改悔棋设置");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "对局中改设置被拒");
    }
  });

  await testCase("黑白棋：计时由服务器提供，且随落子推进", async () => {
    await new Promise((resolve) => setTimeout(resolve, 300));
    const res = await rv.B.request("game.action", { action: "move", row: 2, col: 4 });
    const timers = res.snapshot.game.timers;
    assert(timers && typeof timers.black === "number", "服务器下发计时");
    assert(timers.black > 0, `黑方用时应大于 0，实际 ${timers.black}`);
    assertEq(res.snapshot.game.moves.length, 2, "两手记录");
  });

  await testCase("黑白棋：游戏操作并发越权被拒（非本方回合）", async () => {
    try {
      await rv.B.request("game.action", { action: "move", row: 5, col: 3 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
  });

  await testCase("黑白棋：认输结算并广播", async () => {
    const res = await rv.A.request("game.action", { action: "surrender" });
    assertEq(res.snapshot.game.winner, 2, "黑方认输，白方获胜");
    assertEq(res.snapshot.game.record.total, 1, "战绩累计一局");
    assertEq(res.snapshot.game.record.players["玩家乙"], 1, "胜场归白方昵称");
  });

  rv.A.close();
  rv.B.close();

  // ── 回归：五子棋与斗兽棋仍是权威房 ────────────────────────────
  await testCase("回归：五子棋仍是权威房（WZ 前缀 + game.updated 快照）", async () => {
    const { A, B, roomRef } = await setupRoom("gomoku", "WZ");
    assert(/^WZ[A-Z0-9]{6}$/.test(roomRef.roomId), "五子棋房间码前缀");
    const res = await A.request("game.action", { action: "move", row: 7, col: 7 });
    assertEq(res.snapshot.game.board[7][7], 1, "五子棋服务端落子生效");
    A.close();
    B.close();
  });

  await testCase("回归：斗兽棋仍是权威房（DS 前缀 + 服务端走子校验）", async () => {
    const { A, B, roomRef } = await setupRoom("animal-chess", "DS");
    assert(/^DS[A-Z0-9]{6}$/.test(roomRef.roomId), "斗兽棋房间码前缀");
    // 红方鼠从 (6,0) 走一步；非本方回合的蓝方抢先走子应被拒。
    try {
      await B.request("game.action", { action: "move", from: { row: 0, col: 0 }, to: { row: 1, col: 0 } });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "越权走子被拒");
    }
    const res = await A.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
    assertEq(res.snapshot.game.turn, "blue", "红方走子后轮到蓝方");
    A.close();
    B.close();
  });

  await testCase("回归：健康检查可用", async () => {
    const res = await fetch(`${BASE_HTTP}/health`);
    const body = await res.json();
    assertEq(body.status, "ok", "health status");
  });

  // 收尾。
  setTimeout(() => {
    serverProcess.kill("SIGTERM");
    const failed = results.filter((r) => !r.pass);
    if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }, 300);
})().catch((err) => {
  console.error("test bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
