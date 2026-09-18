/**
 * 飞行棋权威房间 WebSocket 联机测试（无需浏览器）。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 双人房建房/满员自动开局、掷骰权与轮次校验、客户端伪造骰子被服务器忽略、
 * 未掷骰先移动被拒、越权移动被拒、断线重连保座位、房主重开、
 * 以及一局完整双人局的服务器骰子驱动直到分出胜负。
 *
 * 关键断言：
 * - 骰子永远来自服务器（快照 dice 字段），move 里夹带的 dice 字段不采纳；
 * - action 里夹带 teams/turn/winner 等伪造字段一概不采纳。
 *
 * 同步约定：操作者的请求响应与旁观者的广播到达时间相差几毫秒，
 * 因此所有断言前都用 waitGame 轮询等待本地快照满足条件，不做同步读。
 *
 * 运行方式：node tests/ludo-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../ludo-rules");

const TEST_PORT = 18088;
const BASE_WS = `ws://127.0.0.1:${TEST_PORT}/ws`;
const BASE_HTTP = `http://127.0.0.1:${TEST_PORT}`;

/** 用例结果收集。 */
const results = [];
/** 被测服务器进程。 */
let serverProcess = null;
/** 被测服务器输出缓冲（失败时打印）。 */
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
        throw new Error(`[${label}] snapshot never satisfied predicate (last=${game ? JSON.stringify({ turn: game.turn, dice: game.dice, moves: game.moves.length }) : "none"})`);
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
 * 用服务器骰子驱动一局双人局直到红方（0 号位）获胜。
 *
 * 选子策略（保证对局能真正结束）：
 * - 掷到 6 且有待起飞飞机 -> 起飞最靠前的待起飞飞机；
 * - 否则 -> 推进航道位置最小的飞机（落后者优先，钳制保证最终全部到达）。
 *
 * 节奏控制：服务器对每条连接限流（40 条 / 5 秒），超限回复不带 requestId 的
 * RATE_LIMITED 错误，请求方会等不到响应；因此每轮加固定间隔把发送频率压到限流之下。
 *
 * @param {Array<object>} clients - [红方客户端, 蓝方客户端]。
 * @param {number} [maxRounds] - 最大回合数。
 * @returns {Promise<object>} 结束时的对局快照。
 */
async function driveToWin(clients, maxRounds = 400) {
  for (let round = 0; round < maxRounds; round += 1) {
    const game = await clients[0].waitGame((g) => g.over || (g.started && g.dice === 0 && g.moves.length === round));
    if (game.over) return game;
    const seat = game.turn;
    // 1. 掷骰（服务器产生点数）。
    const rolled = await clients[seat].request("game.action", { action: "roll" });
    const dice = rolled.snapshot.game.dice;
    // 2. 选子：6 优先起飞；否则推进最落后的航道飞机。
    const pieces = rolled.snapshot.game.teams[seat].pieces;
    let pieceIndex = -1;
    if (dice === rules.LAUNCH_DICE) {
      pieceIndex = pieces.findIndex((pos) => pos < 0);
    }
    if (pieceIndex === -1) {
      let best = Infinity;
      pieces.forEach((pos, index) => {
        if (pos >= 0 && pos < best) {
          best = pos;
          pieceIndex = index;
        }
      });
    }
    if (pieceIndex === -1) pieceIndex = 0;
    // 3. 移动（待起飞 + 非 6 会轮空消耗回合，属于旧玩法允许的操作）。
    await clients[seat].request("game.action", { action: "move", pieceIndex });
    // 4. 限速：把本连接的发送频率压到服务器限流阈值之下。
    await new Promise((resolve) => setTimeout(resolve, 180));
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

  const A = makeClient("A");
  const B = makeClient("B");
  await Promise.all([A.open, B.open]);

  let roomId = "";
  let bCreds = null;
  /** 蓝方的存活连接（重连测试后原 B 连接已 terminate，用新连接继续后续用例）。 */
  let blueLive = null;

  await testCase("双人房：建房带 playerCount=2，访客加入即自动开局", async () => {
    const created = await A.request("room.create", { gameType: "ludo", prefix: "FQ", nickname: "红甲", playerCount: 2 });
    roomId = created.roomId;
    assert(/^FQ[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 FQ+6 位，实际 ${roomId}`);
    assertEq(created.snapshot.game.playerCount, 2, "playerCount");
    assertEq(created.snapshot.game.started, false, "单人未开局");
    const joined = await B.request("room.join", { roomId, nickname: "蓝乙", gameType: "ludo" });
    bCreds = { playerId: joined.playerId, reconnectToken: joined.reconnectToken };
    assertEq(joined.snapshot.game.started, true, "满员自动开局");
    assertEq(joined.snapshot.game.teams.length, 2, "两支队伍");
    assertEq(joined.snapshot.game.teams.map((t) => t.color), ["red", "blue"], "队伍颜色");
    assertEq(joined.snapshot.game.teams.map((t) => t.pieces), [[-1, -1], [-1, -1]], "全部待起飞");
    assertEq(joined.snapshot.game.turn, 0, "红方先走");
    assertEq(joined.snapshot.game.teams[0].name, "红甲", "红方昵称");
    assertEq(joined.snapshot.game.teams[1].name, "蓝乙", "蓝方昵称");
  });

  await testCase("掷骰权：非当前回合方掷骰被拒（NOT_YOUR_TURN）", async () => {
    try {
      await B.request("game.action", { action: "roll" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
  });

  await testCase("服务器骰子：roll 后快照 dice 为 1..6，重复掷被拒", async () => {
    const res = await A.request("game.action", { action: "roll" });
    const dice = res.snapshot.game.dice;
    assert(dice >= 1 && dice <= 6, `骰点应在 1..6，实际 ${dice}`);
    // 1. 双端都看到同一骰子。
    const bGame = await B.waitGame((g) => g.dice >= 1);
    assertEq(bGame.dice, dice, "双端骰子一致");
    // 2. 骰子未消耗前不能重复掷。
    try {
      await A.request("game.action", { action: "roll" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
  });

  await testCase("伪造骰子：move 里夹带 dice/teams/winner 只按服务器状态推进", async () => {
    const game = await A.waitGame((g) => g.dice >= 1);
    const serverDice = game.dice;
    const pieceAt = game.teams[0].pieces[0];
    // 1. 夹带伪造字段：dice 想强制 6、伪造 teams/turn/winner。
    const res = await A.request("game.action", {
      action: "move",
      pieceIndex: 0,
      dice: 6,
      teams: [],
      turn: 1,
      winner: "blue",
      over: true,
    });
    // 2. 服务器按自己保存的骰子推进：骰子被消耗、轮到蓝方、无伪造胜负。
    assertEq(res.snapshot.game.dice, 0, "骰子已消耗");
    assertEq(res.snapshot.game.turn, 1, "换手到蓝方");
    assertEq(res.snapshot.game.over, false, "没有伪造的结束");
    assertEq(res.snapshot.game.winner, null, "没有伪造的胜者");
    // 3. 飞机位移符合服务器骰子：6 起飞到 0，非 6 原地待起飞。
    if (serverDice === 6) {
      assertEq(res.snapshot.game.teams[0].pieces[0], 0, "掷 6 起飞");
    } else {
      assertEq(res.snapshot.game.teams[0].pieces[0], pieceAt, "非 6 原地轮空");
    }
    assertEq(res.snapshot.game.teams.length, 2, "没有采纳伪造的队伍表");
  });

  await testCase("未掷骰先移动被拒（INVALID_ACTION）且状态不变", async () => {
    const before = JSON.stringify((await B.waitGame((g) => g.turn === 1 && g.dice === 0)).teams);
    try {
      await B.request("game.action", { action: "move", pieceIndex: 0 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
    const after = await B.waitGame((g) => g.turn === 1 && g.dice === 0);
    assertEq(JSON.stringify(after.teams), before, "队伍状态未变化");
  });

  await testCase("越权移动：非当前回合方移动被拒（NOT_YOUR_TURN）", async () => {
    // 1. 蓝方先掷骰。
    await B.request("game.action", { action: "roll" });
    // 2. 红方（非当前回合）试图移动。
    try {
      await A.request("game.action", { action: "move", pieceIndex: 0 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
    // 3. 蓝方正常移动消耗骰子。
    await B.request("game.action", { action: "move", pieceIndex: 0 });
    await A.waitGame((g) => g.turn === 0 && g.dice === 0);
  });

  await testCase("坏下标被拒（INVALID_MOVE）", async () => {
    await A.request("game.action", { action: "roll" });
    try {
      await A.request("game.action", { action: "move", pieceIndex: 5 });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_MOVE", "错误码");
    }
    // 1. 消耗骰子恢复轮次。
    await A.request("game.action", { action: "move", pieceIndex: 1 });
    await B.waitGame((g) => g.turn === 1 && g.dice === 0);
  });

  await testCase("满员：第三人加入被拒（ROOM_FULL）", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId, nickname: "第三者", gameType: "ludo" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "错误码");
    }
    C.close();
  });

  await testCase("断线重连：座位保留，快照恢复后可继续掷骰", async () => {
    B.terminate();
    await A.waitFor("room.player_disconnected", (p) => p.playerId === bCreds.playerId);
    const disconnected = await A.waitGame((g) => g.started);
    assertEq(disconnected.seatPlayerIds[1], bCreds.playerId, "座位仍保留");
    // 1. 新连接凭 playerId + reconnectToken 恢复身份。
    const B2 = makeClient("B2");
    await B2.open;
    const reconnected = await B2.request("room.reconnect", { roomId, playerId: bCreds.playerId, reconnectToken: bCreds.reconnectToken, gameType: "ludo" });
    assertEq(reconnected.snapshot.game.seatPlayerIds[1], bCreds.playerId, "重连回原座");
    assertEq(reconnected.snapshot.game.started, true, "对局仍在进行");
    // 2. 重连后正常掷骰移动（轮到蓝方）。
    const game = await B2.waitGame((g) => g.turn === 1 && g.dice === 0);
    void game;
    await B2.request("game.action", { action: "roll" });
    await B2.request("game.action", { action: "move", pieceIndex: 0 });
    await A.waitGame((g) => g.turn === 0 && g.dice === 0);
    // 3. 后续用例改用这条存活连接；原 B 连接已 terminate，只需清理引用。
    blueLive = B2;
  });

  await testCase("房主重开：清盘归零，骰子清空", async () => {
    const res = await A.request("game.action", { action: "restart" });
    assertEq(res.snapshot.game.turn, 0, "轮次归零");
    assertEq(res.snapshot.game.dice, 0, "骰子清空");
    assertEq(res.snapshot.game.started, true, "重新开局");
    assertEq(res.snapshot.game.teams.map((t) => t.pieces), [[-1, -1], [-1, -1]], "全部回到机场");
    assertEq(res.snapshot.game.winner, null, "无胜者");
  });

  await testCase("服务器骰子驱动完整双人局：一方集齐获胜，双端一致", async () => {
    const final = await driveToWin([A, blueLive]);
    assertEq(final.over, true, "对局结束");
    assert(["red", "blue"].includes(final.winner), `胜者应为红/蓝之一，实际 ${final.winner}`);
    // 1. 获胜队伍全部到达终点。
    const winnerTeam = final.teams.find((t) => t.color === final.winner);
    assertEq(rules.teamFinished(winnerTeam), true, "获胜队伍全部到达");
    assert(final.moves.length > 4, `应有多步移动，实际 ${final.moves.length}`);
    // 2. 双端最终快照一致。
    const aGame = await A.waitGame((g) => g.over);
    const bGame = await blueLive.waitGame((g) => g.over);
    assertEq(JSON.stringify({ t: aGame.teams, w: aGame.winner }), JSON.stringify({ t: bGame.teams, w: bGame.winner }), "双端一致");
    // 2. 结束后不能再掷骰。
    try {
      await A.request("game.action", { action: "roll" });
      throw new Error("结束后不应再能掷骰");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  A.close();
  blueLive.close();

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
