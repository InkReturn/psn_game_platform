/**
 * 服务端协议联机测试（无需浏览器）。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 房间创建/加入/满员/不存在、落子合法性（轮次/占位/越界/未开局/已结束）、
 * 胜负判定、再来一局（换先）、重开清战绩、悔棋、认输、离开、
 * 断线宽限内重连、伪造身份被拒、非法消息、relay 房间转发。
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

const TEST_PORT = 18081;
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}/ws`;
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`;

/** 测试结果收集。 */
const results = [];
let serverProcess = null;
/** 被测服务器最近输出（失败时打印，避免"stdout 被吞"导致无法定位）。 */
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
 * 轮询 /health 等待被测服务器就绪。
 *
 * 不能用固定 sleep 代替：冷启动（首次 require express/ws）耗时不确定，
 * 固定等待会偶发 ECONNREFUSED 假失败。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve；超时抛错。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  // 1. 反复探测健康检查接口，直到返回 status=ok。
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
    if (Date.now() > deadline) {
      throw new Error(`server not ready after ${timeoutMs}ms\n${serverLogs.join("")}`);
    }
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 断言辅助：不相符时抛错。
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
 * 测试用客户端封装。
 *
 * @param {string} [label] - 客户端标签（日志用）。
 * @returns {object} {open, send, request, waitFor, close, closeRaw}
 */
function makeClient(label) {
  const ws = new WebSocket(BASE_WS);
  /** @type {Map<string, {resolve: Function}[]>} type -> pending waiters */
  const waiters = new Map();
  /** requestId -> resolve */
  const pendingReqs = new Map();
  /** 收到的全部消息（调试用）。 */
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
      // 1. 先扫描已收到的消息。
      const found = received.find((m) => m.type === type && (!predicate || predicate(m.payload)));
      if (found) return resolve(found.payload);
      // 2. 否则挂等待器。
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

  /** 原始发送（不经协议封装）。 */
  function sendRaw(raw) {
    ws.send(raw);
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

  return {
    ws,
    open: openPromise,
    request,
    waitFor,
    sendRaw,
    received,
    close: () => ws.close(),
    terminate: () => ws.terminate(),
    label,
  };
}

/**
 * 执行一段用例并记录结果。
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

(async () => {
  // 1. 启动被测服务器（输出进缓冲区，失败时打印便于定位）。
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
  // 2. 等服务器真正可服务（轮询 /health），而不是固定 sleep。
  await waitForServer();

  const A = makeClient("A");
  const B = makeClient("B");
  await Promise.all([A.open, B.open]);

  let hostRoomId = "";
  let hostCreds = null;
  let guestCreds = null;

  // ── 房间生命周期 ────────────────────────────────────────────
  await testCase("create room (gomoku)", async () => {
    const res = await A.request("room.create", { gameType: "gomoku", prefix: "WZ", nickname: "房主甲" });
    assertEq(/^WZ[A-Z0-9]{6}$/.test(res.roomId), true, "roomId format");
    if (!res.playerId || !res.reconnectToken) throw new Error("missing credentials");
    hostRoomId = res.roomId;
    hostCreds = res;
    assertEq(res.snapshot.game.players.black, "房主甲", "host seat name");
  });

  await testCase("join room (joiner gets room.joined, host gets room.player_joined)", async () => {
    // 加入者的凭据走 room.joined 响应，房内已有成员走 player_joined 广播。
    const joined = A.waitFor("room.player_joined");
    const res = await B.request("room.join", { roomId: hostRoomId, nickname: "玩家乙", gameType: "gomoku" });
    guestCreds = res;
    assertEq(res.snapshot.game.players.white, "玩家乙", "guest seat name");
    const ev = await joined;
    assertEq(ev.nickname, "玩家乙", "player_joined event");
    assertEq(ev.snapshot.game.players.white, "玩家乙", "player_joined snapshot");
  });

  await testCase("join invalid room -> ROOM_NOT_FOUND", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId: "ZZZZZZ99", nickname: "路人" });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "ROOM_NOT_FOUND", "error code");
    }
    C.close();
  });

  await testCase("room full -> ROOM_FULL", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId: hostRoomId, nickname: "第三者" });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "error code");
    }
    C.close();
  });

  await testCase("bad room id format -> INVALID_ROOM_ID", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId: "xx", nickname: "路人" });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "INVALID_ROOM_ID", "error code");
    }
    C.close();
  });

  // ── 落子与规则校验 ──────────────────────────────────────────
  await testCase("black (host) moves first, requester gets correlated snapshot", async () => {
    const both = Promise.all([
      A.waitFor("game.updated", (p) => p.snapshot.game.moves.length === 1),
      B.waitFor("game.updated", (p) => p.snapshot.game.moves.length === 1),
    ]);
    const res = await A.request("game.action", { action: "move", row: 7, col: 7 });
    assertEq(res.snapshot.game.moves.length, 1, "requester gets its own action result");
    assertEq(res.snapshot.game.turn, 2, "turn passes to white");
    await both;
    assertEq(B.received.some((m) => m.type === "game.updated" && m.payload.snapshot.game.moves.length === 1), true, "guest got move");
  });

  await testCase("not your turn -> NOT_YOUR_TURN", async () => {
    // 黑刚落子，轮到白；黑再落即越权。
    try {
      await A.request("game.action", { action: "move", row: 8, col: 8 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "error code");
    }
  });

  await testCase("occupied cell -> CELL_OCCUPIED", async () => {
    // 轮到白，白落黑已占的 (7,7) 应被拒。
    try {
      await B.request("game.action", { action: "move", row: 7, col: 7 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "CELL_OCCUPIED", "error code");
    }
  });

  await testCase("out of range -> INVALID_MOVE", async () => {
    try {
      await B.request("game.action", { action: "move", row: 99, col: 7 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "INVALID_MOVE", "error code");
    }
  });

  await testCase("unknown action -> INVALID_ACTION", async () => {
    try {
      await A.request("game.action", { action: "fly", row: 1, col: 1 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "error code");
    }
  });

  await testCase("invalid JSON -> INVALID_MESSAGE", async () => {
    const got = A.waitFor("room.error", (p) => p.code === "INVALID_MESSAGE");
    A.sendRaw("{{{not json");
    const p = await got;
    assertEq(p.code, "INVALID_MESSAGE", "error code");
  });

  await testCase("unknown message type -> INVALID_MESSAGE", async () => {
    const got = A.waitFor("room.error", (p) => p.code === "INVALID_MESSAGE");
    A.sendRaw(JSON.stringify({ version: 1, type: "hack.the.server", payload: {} }));
    await got;
  });

  // ── 胜负 / 再来一局 / 重开 ─────────────────────────────────
  await testCase("win detection + record + swap flag", async () => {
    // 黑 A 已下 (7,7)；补完黑的一线：7 行 3..7 列连五（已有 7,7）
    const seq = [
      ["B", 8, 8],
      ["A", 7, 3],
      ["B", 9, 9],
      ["A", 7, 4],
      ["B", 10, 10],
      ["A", 7, 5],
      ["B", 11, 11],
      ["A", 7, 6],
    ];
    for (const [who, row, col] of seq) {
      const c = who === "A" ? A : B;
      await c.request("game.action", { action: "move", row, col });
    }
    const done = await B.waitFor("game.updated", (p) => p.snapshot.game.winner === 1);
    assertEq(done.snapshot.game.record.total, 1, "record total");
    assertEq(done.snapshot.game.record.players["房主甲"], 1, "winner counted");
    assertEq(done.snapshot.game.nextBlackColor, 1, "winner plays black next");
  });

  await testCase("move after finished -> GAME_ALREADY_FINISHED", async () => {
    try {
      await A.request("game.action", { action: "move", row: 0, col: 0 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "error code");
    }
  });

  await testCase("play_again resets board and winner takes black", async () => {
    const res = await A.request("game.action", { action: "play_again" });
    const g = res.snapshot.game;
    assertEq(g.moves.length, 0, "moves cleared");
    assertEq(g.winner, 0, "winner cleared");
    assertEq(g.turn, 1, "black first");
    assertEq(g.players.black, "房主甲", "winner (host) keeps black");
    assertEq(g.record.total, 1, "record kept");
  });

  // ── 悔棋 / 认输 / 重开 ─────────────────────────────────────
  await testCase("undo request + approve", async () => {
    await A.request("game.action", { action: "move", row: 3, col: 3 });
    await B.request("game.action", { action: "move", row: 4, col: 4 });
    const res = await A.request("game.action", { action: "undo_request" });
    assertEq(res.snapshot.game.undoRequest.requesterColor, 1, "request by black");
    // 请求者不能自己响应。
    try {
      await A.request("game.action", { action: "undo_respond", approved: true });
      throw new Error("should reject self respond");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "self respond rejected");
    }
    const done = await B.request("game.action", { action: "undo_respond", approved: true });
    // 见 gomoku-room._removeMovesFrom：从被悔那一手起整段回滚（对齐旧客户端语义）。
    assertEq(done.snapshot.game.moves.length, 0, "moves rolled back from request point");
    assertEq(done.snapshot.game.turn, 1, "turn back to black");
  });

  await testCase("undo request rejected by peer", async () => {
    await A.request("game.action", { action: "move", row: 3, col: 3 });
    await B.request("game.action", { action: "move", row: 4, col: 4 });
    const res = await B.request("game.action", { action: "undo_request" });
    assertEq(res.snapshot.game.undoRequest.requesterColor, 2, "request by white");
    const done = await A.request("game.action", { action: "undo_respond", approved: false });
    assertEq(done.snapshot.game.undoRequest, null, "request cleared");
    assertEq(done.snapshot.game.moves.length, 2, "moves kept");
  });

  await testCase("surrender", async () => {
    const res = await B.request("game.action", { action: "surrender" });
    assertEq(res.snapshot.game.winner, 1, "black wins by surrender");
    assertEq(res.snapshot.game.record.total, 2, "second game counted");
  });

  await testCase("restart clears record", async () => {
    const res = await A.request("game.action", { action: "restart" });
    assertEq(res.snapshot.game.record.total, 0, "record cleared");
    assertEq(res.snapshot.game.moves.length, 0, "board cleared");
  });

  // ── 断线 / 重连 / 离开 ─────────────────────────────────────
  await testCase("disconnect keeps seat, reconnect restores identity", async () => {
    B.terminate();
    await A.waitFor("room.player_disconnected");
    // 1. 断线后立刻重连（宽限期内）。
    const B2 = makeClient("B2");
    await B2.open;
    const res = await B2.request("room.reconnect", {
      roomId: hostRoomId,
      playerId: guestCreds.playerId,
      reconnectToken: guestCreds.reconnectToken,
    });
    assertEq(res.snapshot.game.players.white, "玩家乙", "seat restored");
    await A.waitFor("room.player_reconnected");
    B2.close();
  });

  await testCase("reconnect with forged token -> UNAUTHORIZED_PLAYER", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.reconnect", {
        roomId: hostRoomId,
        playerId: guestCreds.playerId,
        reconnectToken: "forged-token-should-fail",
      });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "UNAUTHORIZED_PLAYER", "error code");
    }
    C.close();
  });

  await testCase("leave room notifies peer", async () => {
    // 上一用例把 B 的连接断掉了，先用原凭据重连出一个在线对手，再验证离开广播。
    const B3 = makeClient("B3");
    await B3.open;
    await B3.request("room.reconnect", {
      roomId: hostRoomId,
      playerId: guestCreds.playerId,
      reconnectToken: guestCreds.reconnectToken,
    });
    const left = B3.waitFor("room.player_left");
    await A.request("room.leave");
    const ev = await left;
    assertEq(ev.playerId !== undefined, true, "player_left carries playerId");
    assertEq(ev.snapshot.game.players.black, "等待", "seat released after leave");
    B3.close();
  });

  // ── relay 房间（其他游戏共用层）────────────────────────────
  await testCase("relay room create/join/broadcast/target", async () => {
    const R1 = makeClient("R1");
    const R2 = makeClient("R2");
    await Promise.all([R1.open, R2.open]);
    const created = await R1.request("room.create", { gameType: "relay:reversi", prefix: "RV", nickname: "房主" });
    const hostSaw = R1.waitFor("room.player_joined");
    const joined = await R2.request("room.join", { roomId: created.roomId, nickname: "客人", gameType: "relay:reversi" });
    // 1. 加入者从 room.joined 拿到成员表，房主从 player_joined 广播感知。
    assertEq(joined.snapshot.room.players.length, 2, "joiner sees both members");
    assertEq((await hostSaw).nickname, "客人", "host notified");
    // 1. 房主广播快照，客人应收到 relay.message。
    const got = R2.waitFor("relay.message", (p) => p.event === "state");
    R1.ws.send(JSON.stringify({ version: 1, type: "relay.send", payload: { event: "state", data: { board: 1 } } }));
    const msg = await got;
    assertEq(msg.data.board, 1, "broadcast payload");
    assertEq(msg.senderRole, "host", "sender role");
    // 2. 定向消息只发给目标。
    const gotTarget = R1.waitFor("relay.message", (p) => p.event === "secret");
    const gotNothing = R2.waitFor("relay.message", (p) => p.event === "secret").then(
      () => "unexpected",
      () => "timeout-ok",
    );
    R2.ws.send(
      JSON.stringify({
        version: 1,
        type: "relay.send",
        payload: { event: "secret", data: 42, targetId: created.playerId },
      }),
    );
    await gotTarget;
    assertEq(await Promise.race([gotNothing, new Promise((r) => setTimeout(() => r("no-delivery"), 800))]), "no-delivery", "target isolation");
    // 3. gomoku 房不接受 relay。
    R1.close();
    R2.close();
  });

  await testCase("game.action on relay room -> INVALID_ACTION", async () => {
    const R1 = makeClient("R1");
    await R1.open;
    const created = await R1.request("room.create", { gameType: "relay:tictactoe", prefix: "TT", nickname: "房主" });
    try {
      await R1.request("game.action", { action: "move", row: 0, col: 0 });
      throw new Error("should reject");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "error code");
    }
    R1.close();
  });

  await testCase("health endpoint responds", async () => {
    const res = await fetch(`http://127.0.0.1:${TEST_PORT}/health`);
    const body = await res.json();
    assertEq(body.status, "ok", "health status");
    if (typeof body.activeRooms !== "number") throw new Error("activeRooms missing");
  });

  // 收尾。
  A.close();
  B.close();
  setTimeout(() => {
    serverProcess.kill("SIGTERM");
    const failed = results.filter((r) => !r.pass);
    // 1. 有失败时打印服务器输出，便于定位（否则输出被管道吞掉）。
    if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
    console.log(`\n${results.length - failed.length}/${results.length} passed`);
    process.exit(failed.length ? 1 : 0);
  }, 500);
})().catch((err) => {
  console.error("test bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
