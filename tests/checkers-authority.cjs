/**
 * 跳棋权威房间 WebSocket 联机测试（无需浏览器）。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 三人房建房/满员自动开局、非法与越权走子被拒、客户端伪造状态被服务器忽略、
 * 房间满员、断线重连保座位、中途离开回到等待态并允许补位、房主重开、
 * 以及一局完整双人局的贪心驱动直到分出胜负。
 *
 * 关键断言：客户端只发意图。测试会尝试在 game.action 里夹带 players/turn/winner
 * 等伪造字段，服务器必须完全不采纳，权威快照只能来自服务器自己的推进。
 *
 * 同步约定：操作者的请求响应与旁观者的广播到达时间相差几毫秒，
 * 因此所有断言前都用 waitGame 轮询等待本地快照满足条件，不做同步读。
 *
 * 运行方式：node tests/checkers-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../checkers-rules");

const TEST_PORT = 18086;
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
 * 轮询 /health 等待被测服务器就绪。
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
 * @returns {object} 客户端 API（open/request/waitFor/waitGame/close/terminate/lastGame）。
 */
function makeClient(label) {
  const ws = new WebSocket(BASE_WS);
  /** @type {Map<string, Function[]>} type -> 等待器 */
  const waiters = new Map();
  /** requestId -> resolve */
  const pendingReqs = new Map();
  /** 收到的全部消息。 */
  const received = [];
  let reqId = 1;

  /**
   * 等待下一条匹配的消息。
   *
   * @param {string} type - 消息类型。
   * @param {Function} [predicate] - 附加过滤 (payload) => boolean。
   * @param {number} [timeoutMs] - 超时毫秒数。
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

  /** 本客户端最近一次收到的对局快照（game 部分）。 */
  function lastGame() {
    for (let i = received.length - 1; i >= 0; i -= 1) {
      const m = received[i];
      if ((m.type === "game.updated" || m.type === "room.snapshot") && m.payload?.snapshot?.game) {
        return m.payload.snapshot.game;
      }
    }
    return null;
  }

  /**
   * 轮询等待本地快照满足条件（广播与请求响应存在毫秒级时差，不能同步读）。
   *
   * @param {Function} predicate - (game) => boolean。
   * @param {number} [timeoutMs] - 超时毫秒数。
   * @returns {Promise<object>} 满足条件的快照。
   */
  async function waitGame(predicate, timeoutMs = 3000) {
    const deadline = Date.now() + timeoutMs;
    for (;;) {
      const game = lastGame();
      if (game && predicate(game)) return game;
      if (Date.now() > deadline) {
        throw new Error(`[${label}] snapshot never satisfied predicate (last=${game ? JSON.stringify({ turn: game.turn, started: game.started }) : "none"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

  return { ws, open: openPromise, request, waitFor, waitGame, received, lastGame, close: () => ws.close(), terminate: () => ws.terminate(), label };
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
 * 贪心驱动一局双人局直到红方（0 号位）获胜。
 *
 * 红方每步选择"距目标区域最近"的落点（避开最近走过的位置防振荡）；
 * 蓝方每步选择离自己当前位置最近的落点（原地徘徊，不干扰红方太多）。
 *
 * @param {Array<object>} clients - [红方客户端, 蓝方客户端]。
 * @param {number} [maxRounds] - 最大回合数。
 * @returns {Promise<object>} 结束时的对局快照。
 */
async function driveToWin(clients, maxRounds = 200) {
  const redTrail = [];
  for (let round = 0; round < maxRounds; round += 1) {
    const game = await clients[0].waitGame((g) => g.over || (g.started && g.turn === round % 2));
    if (game.over) return game;
    const seat = game.turn;
    const piece = game.players[seat];
    const cell = rules.cellAt(piece.row, piece.index);
    const targets = rules.moveTargets(game.players, cell);
    if (!targets.length) throw new Error(`seat ${seat} 无棋可走（不应该发生在星形棋盘上）`);
    let chosen;
    if (seat === 0) {
      // 1. 红方：按到目标区域的距离排序，优先选最近走过的位置之外的落点。
      const ranked = targets
        .map((t) => ({ t, d: Math.min(...rules.cellsByRegion(piece.target).map((g) => Math.hypot(g.x - t.x, (g.y - t.y) * 0.88))) }))
        .sort((a, b) => a.d - b.d);
      chosen = ranked.find((item) => !redTrail.some((p) => p.row === item.t.row && p.index === item.t.index)) || ranked[0];
      redTrail.push({ ...chosen.t });
      if (redTrail.length > 8) redTrail.shift();
    } else {
      // 2. 蓝方：选离当前位置最近的落点（小步徘徊）。
      const ranked = targets
        .map((t) => ({ t, d: Math.hypot(t.x - cell.x, (t.y - cell.y) * 0.88) }))
        .sort((a, b) => a.d - b.d);
      chosen = ranked[0];
    }
    await clients[seat].request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to: { row: chosen.t.row, index: chosen.t.index } });
  }
  throw new Error(`驱动 ${maxRounds} 轮仍未分出胜负`);
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

  // ── 三人房：建房 / 满员自动开局 / 越权与伪造 ──────────────
  const A = makeClient("A");
  const B = makeClient("B");
  const C = makeClient("C");
  await Promise.all([A.open, B.open, C.open]);

  let roomId = "";
  let cCreds = null;

  await testCase("三人房：建房带 playerCount=3，未满员不开局", async () => {
    const created = await A.request("room.create", { gameType: "checkers", prefix: "TQ", nickname: "红甲", playerCount: 3 });
    roomId = created.roomId;
    assert(/^TQ[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 TQ+6 位，实际 ${roomId}`);
    assertEq(created.snapshot.game.playerCount, 3, "playerCount");
    assertEq(created.snapshot.game.started, false, "单人未开局");
    assertEq(created.snapshot.game.seatPlayerIds.length, 1, "一个座位");
    const joinedB = await B.request("room.join", { roomId, nickname: "蓝乙", gameType: "checkers" });
    assertEq(joinedB.snapshot.game.started, false, "两人仍未开局");
    assertEq(joinedB.snapshot.game.seatPlayerIds.length, 2, "两个座位");
  });

  await testCase("三人房：第三人加入即自动开局，三端都看到同一开局快照", async () => {
    const joined = await C.request("room.join", { roomId, nickname: "绿丙", gameType: "checkers" });
    cCreds = { playerId: joined.playerId, reconnectToken: joined.reconnectToken };
    assertEq(joined.snapshot.game.started, true, "满员自动开局");
    assertEq(joined.snapshot.game.players.length, 3, "三颗棋子");
    assertEq(joined.snapshot.game.players.map((p) => p.color), ["red", "blue", "green"], "座位颜色");
    assertEq(joined.snapshot.game.turn, 0, "红方先走");
    // 1. 先加入的两端经广播看到开局（轮询等待，不与响应抢时间）。
    const aGame = await A.waitGame((g) => g.started);
    const bGame = await B.waitGame((g) => g.started);
    assertEq(aGame.players.length, 3, "A 侧三颗棋子");
    assertEq(bGame.players.length, 3, "B 侧三颗棋子");
    assertEq(JSON.stringify({ p: aGame.players, t: aGame.turn }), JSON.stringify({ p: bGame.players, t: bGame.turn }), "A/B 状态一致");
  });

  await testCase("越权：非当前回合走子被拒（NOT_YOUR_TURN）且状态不变", async () => {
    const game = await A.waitGame((g) => g.started && g.turn === 0);
    const before = JSON.stringify(game);
    const green = game.players[2];
    try {
      await C.request("game.action", { action: "move", from: { row: green.row, index: green.index }, to: { row: 0, index: 0 } });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
    const after = await A.waitGame((g) => g.started && g.turn === 0);
    assertEq(JSON.stringify(after.players), JSON.stringify(JSON.parse(before).players), "快照未变化");
  });

  await testCase("红方合法走子：三端都收到推进后的同一快照", async () => {
    const game = await A.waitGame((g) => g.started && g.turn === 0);
    const piece = game.players[0];
    const to = rules.moveTargets(game.players, rules.cellAt(piece.row, piece.index))[0];
    const res = await A.request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to });
    assertEq(res.snapshot.game.turn, 1, "轮到蓝方");
    assertEq(res.snapshot.game.players[0].row === to.row && res.snapshot.game.players[0].index === to.index, true, "红棋已移动");
    const bGame = await B.waitGame((g) => g.started && g.turn === 1);
    const cGame = await C.waitGame((g) => g.started && g.turn === 1);
    assertEq(JSON.stringify({ p: bGame.players, t: bGame.turn }), JSON.stringify({ p: cGame.players, t: cGame.turn }), "B/C 状态一致");
  });

  await testCase("伪造状态：夹带 players/turn/winner 的走子只按 from/to 推进", async () => {
    const game = await B.waitGame((g) => g.started && g.turn === 1);
    const piece = game.players[1];
    const to = rules.moveTargets(game.players, rules.cellAt(piece.row, piece.index))[0];
    const res = await B.request("game.action", {
      action: "move",
      from: { row: piece.row, index: piece.index },
      to,
      // 1. 伪造字段：服务器必须全部忽略。
      players: [{ color: "red", row: 0, index: 0, target: "top" }],
      turn: 0,
      winner: "blue",
      over: true,
      started: false,
    });
    // 2. 快照按正常走子推进：轮到绿方，没有伪造的胜负。
    assertEq(res.snapshot.game.turn, 2, "轮到绿方");
    assertEq(res.snapshot.game.over, false, "没有伪造的结束");
    assertEq(res.snapshot.game.winner, null, "没有伪造的胜者");
    assertEq(res.snapshot.game.players.length, 3, "没有采纳伪造的棋子表");
    assertEq(res.snapshot.game.players[1].row === to.row && res.snapshot.game.players[1].index === to.index, true, "蓝棋按意图移动");
  });

  await testCase("越权：移动别人的棋子被拒（NOT_YOUR_PIECE）", async () => {
    const game = await C.waitGame((g) => g.started && g.turn === 2);
    const red = game.players[0];
    try {
      await C.request("game.action", { action: "move", from: { row: red.row, index: red.index }, to: { row: 0, index: 0 } });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_PIECE", "错误码");
    }
  });

  await testCase("非法目标：落点不在合法走法内被拒（ILLEGAL_MOVE_TARGET）", async () => {
    const game = await C.waitGame((g) => g.started && g.turn === 2);
    const piece = game.players[2];
    try {
      await C.request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to: { row: 0, index: 0 } });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "错误码");
    }
  });

  await testCase("未知动作被拒（INVALID_ACTION），不能提交完整棋盘", async () => {
    try {
      await A.request("game.action", { action: "setBoard", players: [] });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
  });

  await testCase("满员：第四人加入被拒（ROOM_FULL）", async () => {
    const D = makeClient("D");
    await D.open;
    try {
      await D.request("room.join", { roomId, nickname: "第四人", gameType: "checkers" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "错误码");
    }
    D.close();
  });

  await testCase("断线重连：座位保留，凭据恢复后可继续走子", async () => {
    C.terminate();
    await A.waitFor("room.player_disconnected", (p) => p.playerId === cCreds.playerId);
    const disconnected = await A.waitGame((g) => g.started);
    assertEq(disconnected.seatPlayerIds[2], cCreds.playerId, "座位仍保留");
    // 1. 新连接凭 playerId + reconnectToken 恢复身份。
    const C2 = makeClient("C2");
    await C2.open;
    const reconnected = await C2.request("room.reconnect", { roomId, playerId: cCreds.playerId, reconnectToken: cCreds.reconnectToken, gameType: "checkers" });
    assertEq(reconnected.snapshot.game.seatPlayerIds[2], cCreds.playerId, "重连回原座");
    assertEq(reconnected.snapshot.game.started, true, "对局仍在进行");
    // 2. 重连后正常走子（轮到绿方）。
    const game = await C2.waitGame((g) => g.started && g.turn === 2);
    const piece = game.players[2];
    const to = rules.moveTargets(game.players, rules.cellAt(piece.row, piece.index))[0];
    const res = await C2.request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to });
    assertEq(res.snapshot.game.turn, 0, "绿方走完轮回红方");
    C2.close();
    C.close();
  });

  let E = null;
  await testCase("中途离开：房间回到等待态，补位后重新自动开局", async () => {
    // 1. B 主动离开：房间不满员，回到等待状态。
    await B.request("room.leave");
    const waiting = await A.waitGame((g) => g.started === false);
    assertEq(waiting.players.length, 0, "棋盘已清空");
    // 2. 补位者加入后满员重新开局。
    E = makeClient("E");
    await E.open;
    const joinedE = await E.request("room.join", { roomId, nickname: "补位戊", gameType: "checkers" });
    assertEq(joinedE.snapshot.game.started, true, "补位后自动开局");
    assertEq(joinedE.snapshot.game.turn, 0, "红方先走");
    assertEq(joinedE.snapshot.game.players.length, 3, "三颗棋子重新摆放");
  });

  await testCase("重开：非房主被拒（UNAUTHORIZED_PLAYER），房主重开清盘归零", async () => {
    const game = await A.waitGame((g) => g.started && g.turn === 0);
    const piece = game.players[0];
    const to = rules.moveTargets(game.players, rules.cellAt(piece.row, piece.index))[0];
    await A.request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to });
    // 1. 非房主（补位者）重开被拒。
    try {
      await E.request("game.action", { action: "restart" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "UNAUTHORIZED_PLAYER", "错误码");
    }
    // 2. 房主重开：棋子回到出发格、轮次归零、进行中状态。
    const res = await A.request("game.action", { action: "restart" });
    assertEq(res.snapshot.game.turn, 0, "轮次归零");
    assertEq(res.snapshot.game.started, true, "重新开局");
    const initial = rules.createPieces(3);
    assertEq(
      res.snapshot.game.players.map((p) => `${p.row}-${p.index}`),
      initial.map((p) => `${p.row}-${p.index}`),
      "棋子回到出发格",
    );
  });

  // ── 双人完整局：贪心驱动直到分出胜负 ──────────────────────
  const R = makeClient("R");
  const S = makeClient("S");
  await Promise.all([R.open, S.open]);

  await testCase("双人完整局：贪心驱动到红方到达目标区，双端胜负一致", async () => {
    const created = await R.request("room.create", { gameType: "checkers", prefix: "TQ", nickname: "贪心红", playerCount: 2 });
    const joined = await S.request("room.join", { roomId: created.roomId, nickname: "陪练蓝", gameType: "checkers" });
    assertEq(joined.snapshot.game.started, true, "双人满员自动开局");
    const final = await driveToWin([R, S]);
    assertEq(final.over, true, "对局结束");
    assertEq(final.winner, "red", "红方获胜");
    assert(final.moves.length > 4, `应有多步走子，实际 ${final.moves.length}`);
    // 1. 双端最终快照一致。
    const rGame = await R.waitGame((g) => g.over);
    const sGame = await S.waitGame((g) => g.over);
    assertEq(JSON.stringify({ p: rGame.players, w: rGame.winner }), JSON.stringify({ p: sGame.players, w: sGame.winner }), "双端一致");
    // 2. 结束后不能再走子。
    const piece = rGame.players[0];
    try {
      await R.request("game.action", { action: "move", from: { row: piece.row, index: piece.index }, to: { row: 0, index: 0 } });
      throw new Error("结束后不应再能走子");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  R.close();
  S.close();
  A.close();
  B.close();
  if (E) E.close();

  // 1. 收尾：关闭服务器并汇总。
  serverProcess.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("test runner failed:", err);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
