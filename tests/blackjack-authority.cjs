/**
 * 21 点权威房间 WebSocket 联机测试（无需浏览器）——隐私泄漏负向测试重点。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 三人房满员自动发牌、要牌/停牌轮次校验、越权被拒、伪造字段被忽略、
 * 自动结算（庄家补牌/派彩）、断线重连、房主开新一局（筹码延续）、
 * 房主重置、中途离开清空隐私数据。
 *
 * 隐私断言（直接检查 WebSocket payload，不是检查页面显示）：
 * - 每个客户端消息中出现的所有牌 id，必须 ⊆ 该客户端结构性可见的牌集合
 *   （自己的手牌 + 庄家明牌 + 结算后公开的全部手牌）——
 *   这同时覆盖"他人手牌"、"庄家暗牌"、"牌堆顺序"三类泄漏；
 * - 结算前庄家快照只有 1 张明牌（handCount=2），结算后全部公开；
 * - 结算前他人座位只有 handCount，没有 hand 字段。
 *
 * 运行方式：node tests/blackjack-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../blackjack-rules");

const TEST_PORT = 18094;
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
 * @returns {object} 客户端 API。
 */
function makeClient(label) {
  const ws = new WebSocket(BASE_WS);
  /** @type {Map<string, Function[]>} type -> 等待器 */
  const waiters = new Map();
  /** requestId -> resolve */
  const pendingReqs = new Map();
  /** 收到的全部消息（隐私断言直接扫描原始 JSON）。 */
  const received = [];
  /** 原始 JSON 文本（隐私断言用）。 */
  const rawReceived = [];
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

  /** 本客户端最近一次收到的对局快照（game 部分，个性化）。 */
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
   * 轮询等待本地快照满足条件。
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
        throw new Error(`[${label}] snapshot never satisfied predicate (last=${game ? JSON.stringify({ phase: game.phase, moves: game.moves }) : "none"})`);
      }
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
  }

  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    const text = data.toString();
    rawReceived.push(text);
    const m = JSON.parse(text);
    received.push(m);
    if (m.requestId && pendingReqs.has(m.requestId)) {
      const fn = pendingReqs.get(m.requestId);
      pendingReqs.delete(m.requestId);
      fn(m);
    }
    const list = waiters.get(m.type);
    if (list) {
      for (let i = list.length - 1; i >= 0; i -= 1) {
        if (list[i].check(m)) list.splice(i, 1);
      }
    }
  });

  return { ws, open: openPromise, request, waitFor, waitGame, received, rawReceived, lastGame, close: () => ws.close(), terminate: () => ws.terminate(), label };
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

/** 全部 52 张牌 id（隐私断言扫描用）。 */
const ALL_CARD_IDS = rules.buildDeck().map((card) => card.id);

/**
 * 收集某客户端消息中出现过的所有牌 id。
 *
 * @param {object} client - 客户端。
 * @returns {Set<string>} 出现过的牌 id。
 */
function seenCardIds(client) {
  const seen = new Set();
  for (const raw of client.rawReceived) {
    for (const id of ALL_CARD_IDS) {
      if (raw.includes(`"${id}"`)) seen.add(id);
    }
  }
  return seen;
}

/**
 * 计算某客户端"结构性可见"的牌 id 集合：自己的手牌 + 庄家明牌 +
 * 结算后公开的全部手牌（从它收到的快照解析）。
 *
 * @param {object} client - 客户端。
 * @returns {Set<string>} 允许出现的牌 id。
 */
function allowedCardIds(client) {
  const allowed = new Set();
  for (const m of client.received) {
    const game = m.payload?.snapshot?.game;
    if (!game) continue;
    (game.myHand || []).forEach((card) => allowed.add(card.id));
    (game.dealer?.cards || []).forEach((card) => allowed.add(card.id));
    if (game.over) {
      game.seats.forEach((seat) => (seat.hand || []).forEach((card) => allowed.add(card.id)));
    }
  }
  return allowed;
}

/**
 * 隐私断言：客户端消息中出现的所有牌 id 必须在其结构性可见集合内。
 *
 * 该断言同时覆盖三类泄漏：他人手牌、庄家暗牌、牌堆顺序。
 *
 * @param {object} client - 客户端。
 * @param {string} context - 断言上下文描述。
 */
function assertNoCardLeak(client, context) {
  const seen = seenCardIds(client);
  const allowed = allowedCardIds(client);
  for (const id of seen) {
    assert(allowed.has(id), `${context}: ${client.label} 的消息中出现了不应可见的牌 ${id}`);
  }
}

/**
 * 驱动到自动结算：当前玩家 <17 要牌，否则停牌。
 *
 * @param {Array<object>} clients - 全部座位客户端（按座位顺序）。
 * @param {number} [maxRounds] - 最大行动数。
 * @returns {Promise<object>} 结算后的快照。
 */
async function driveToSettle(clients, maxRounds = 60) {
  let game = await clients[0].waitGame((g) => g.started && !g.over, 10000);
  let lastMoves = game.moves;
  for (let round = 0; round < maxRounds; round += 1) {
    if (game.over) return game;
    const seat = game.turn;
    const seatGame = await clients[seat].waitGame((g) => g.moves === game.moves, 10000);
    const value = rules.handValue(seatGame.myHand);
    if (value < 17) {
      await clients[seat].request("game.action", { action: "hit" });
    } else {
      await clients[seat].request("game.action", { action: "stand" });
    }
    game = await clients[0].waitGame((g) => g.over || g.moves > lastMoves, 10000);
    lastMoves = game.moves;
    await new Promise((resolve) => setTimeout(resolve, 120));
  }
  throw new Error(`驱动 ${maxRounds} 轮仍未结算`);
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
  const C = makeClient("C");
  await Promise.all([A.open, B.open, C.open]);

  let roomId = "";
  let aCreds = null;
  /** 甲的存活连接（重连测试后原 A 连接已 terminate，用新连接继续后续用例）。 */
  let aLive = null;

  /**
   * 座位下标 -> 存活连接（重连后甲连接切换）。
   *
   * @param {number} seat - 座位下标（0/1/2）。
   * @returns {object} 对应客户端。
   */
  function seatClient(seat) {
    return seat === 0 ? aLive || A : seat === 1 ? B : C;
  }

  await testCase("三人房：满员自动发牌，各家只看到自己的 2 张，庄家 1 明 1 暗", async () => {
    const created = await A.request("room.create", { gameType: "blackjack", prefix: "BJ", nickname: "玩家甲", playerCount: 3 });
    roomId = created.roomId;
    aCreds = { playerId: created.playerId, reconnectToken: created.reconnectToken };
    assert(/^BJ[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 BJ+6 位，实际 ${roomId}`);
    await B.request("room.join", { roomId, nickname: "玩家乙", gameType: "blackjack" });
    const joined = await C.request("room.join", { roomId, nickname: "玩家丙", gameType: "blackjack" });
    // 1. 满员自动发牌。
    assertEq(joined.snapshot.game.phase, "player", "进入玩家操作阶段");
    assertEq(joined.snapshot.game.myHand.length, 2, "丙的 2 张手牌");
    const aGame = await A.waitGame((g) => g.phase === "player");
    const bGame = await B.waitGame((g) => g.phase === "player");
    assertEq(aGame.myHand.length, 2, "甲的 2 张手牌");
    assertEq(bGame.myHand.length, 2, "乙的 2 张手牌");
    // 2. 庄家：结算前只有 1 张明牌（暗牌不下发）。
    [aGame, bGame, joined.snapshot.game].forEach((game) => {
      assertEq(game.dealer.cards.length, 1, "庄家只发明牌");
      assertEq(game.dealer.handCount, 2, "庄家共 2 张");
      assertEq(game.dealer.hidden, true, "庄家未翻牌");
      game.seats.forEach((seat) => {
        assertEq(seat.handCount, 2, "座位剩余张数");
        assertEq(seat.hand, null, "结算前他人手牌不下发");
      });
    });
  });

  await testCase("隐私：发牌后任何消息不泄漏他人手牌/庄家暗牌/牌堆顺序", async () => {
    [A, B, C].forEach((client) => assertNoCardLeak(client, "发牌后"));
  });

  await testCase("轮次：非当前回合方要牌/停牌被拒（NOT_YOUR_TURN）", async () => {
    const game = await A.waitGame((g) => g.phase === "player" && !g.over);
    // 1. 找一个非当前回合的客户端尝试要牌。
    const notTurn = [A, B, C].filter((_, index) => index !== game.turn)[0];
    try {
      await notTurn.request("game.action", { action: "hit" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "要牌错误码");
    }
    try {
      await notTurn.request("game.action", { action: "stand" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "停牌错误码");
    }
  });

  await testCase("伪造字段：夹带 hands/dealer/turn/over 的要牌只按意图推进", async () => {
    const game = await A.waitGame((g) => g.phase === "player" && !g.over);
    const seat = game.turn;
    const seatGame = await seatClient(seat).waitGame((g) => g.moves === game.moves, 10000);
    const before = seatGame.myHand.length;
    const res = await seatClient(seat).request("game.action", {
      action: "hit",
      hands: [],
      dealer: [],
      turn: 0,
      over: true,
      winners: [0, 1, 2],
    });
    // 1. 服务器按意图发一张牌，无伪造终局。
    assertEq(res.snapshot.game.myHand.length, before + 1, "按意图发牌");
    assertEq(res.snapshot.game.over, false, "没有伪造的终局");
    assertEq(res.snapshot.game.winners, [], "没有伪造的赢家");
  });

  await testCase("驱动到自动结算：庄家补牌公开，赢家派彩一致，隐私无泄漏", async () => {
    const final = await driveToSettle([aLive || A, B, C]);
    assertEq(final.over, true, "对局结束");
    assertEq(final.phase, "showdown", "结算阶段");
    // 1. 庄家手牌全部公开（≥17 才停）。
    [A, B, C].forEach((client) => {
      const game = client.lastGame();
      assertEq(game.dealer.cards.length, game.dealer.handCount, "庄家暗牌已公开");
      assert(rules.handValue(game.dealer.cards) >= 17 || rules.handValue(game.dealer.cards) > 21, `庄家点数应 >=17 或爆牌，实际 ${rules.handValue(game.dealer.cards)}`);
      assertEq(game.over, true, "各端都看到结束");
    });
    // 2. 赢家派彩一致（底注 10 → +20）。
    const chipsBySeat = A.lastGame().seats.map((seat) => seat.chips);
    const winners = A.lastGame().winners;
    winners.forEach((index) => assertEq(chipsBySeat[index], rules.START_CHIPS + rules.BET * 2, `赢家 ${index} 派彩`));
    // 3. 结算后他人手牌公开（可核对）。
    [A, B, C].forEach((client) => {
      client.lastGame().seats.forEach((seat) => assert(Array.isArray(seat.hand), "结算后手牌公开"));
    });
    // 4. 结算后隐私总检（此时全部手牌已公开，断言仍然成立）。
    [A, B, C].forEach((client) => assertNoCardLeak(client, "结算后"));
    // 5. 结束后不能再要牌。
    try {
      await A.request("game.action", { action: "hit" });
      throw new Error("结束后不应再能要牌");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  await testCase("断线重连：座位与手牌恢复，隐私不泄漏", async () => {
    A.terminate();
    await B.waitFor("room.player_disconnected", (p) => p.playerId === aCreds.playerId);
    const A2 = makeClient("A2");
    await A2.open;
    const reconnected = await A2.request("room.reconnect", { roomId, playerId: aCreds.playerId, reconnectToken: aCreds.reconnectToken, gameType: "blackjack" });
    assertEq(reconnected.snapshot.game.mySeatIndex, 0, "重连回原座");
    assertEq(reconnected.snapshot.game.over, true, "结算状态恢复");
    // 1. 等广播快照到达，再执行泄漏断言（否则断言空转）。
    await A2.waitGame((g) => g.over);
    assertNoCardLeak(A2, "重连后");
    A.close();
    aLive = A2;
  });

  await testCase("房主开新一局：保留筹码重新发牌，庄家重新隐藏", async () => {
    const settled = await aLive.waitGame((g) => g.over);
    const chipsBefore = settled.seats.map((seat) => seat.chips);
    const res = await aLive.request("game.action", { action: "start" });
    const g = res.snapshot.game;
    assertEq(g.phase, "player", "重新进入玩家阶段");
    assertEq(g.myHand.length, 2, "重新发 2 张");
    assertEq(g.dealer.cards.length, 1, "庄家暗牌重新隐藏");
    assertEq(g.dealer.handCount, 2, "庄家 2 张");
    assertEq(g.over, false, "新一局进行中");
    assertEq(g.seats.map((seat) => seat.chips), chipsBefore, "筹码延续");
    // 1. 新一局的发牌同样无泄漏。
    [aLive, B, C].forEach((client) => assertNoCardLeak(client, "新一局"));
  });

  await testCase("房主重置：筹码回到起始值，回到等待", async () => {
    const res = await aLive.request("game.action", { action: "restart" });
    const g = res.snapshot.game;
    assertEq(g.phase, "idle", "回到等待");
    assertEq(g.started, false, "未开局");
    assertEq(g.myHand, [], "手牌已清空");
    assertEq(g.seats.map((seat) => seat.chips), Array.from({ length: 3 }, () => rules.START_CHIPS), "筹码复位");
    assertEq(g.dealer.cards, [], "庄家手牌已清空");
  });

  await testCase("中途离开：房间回到等待，隐私数据清空", async () => {
    await C.request("room.leave");
    const waiting = await aLive.waitGame((g) => g.started === false, 10000);
    assertEq(waiting.seats.length, 2, "剩两个座位");
    assertEq(waiting.myHand, [], "手牌已清空");
    const bGame = await B.waitGame((g) => g.started === false, 10000);
    assertEq(bGame.myHand, [], "乙侧手牌已清空");
  });

  aLive.close();
  B.close();
  C.close();

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
