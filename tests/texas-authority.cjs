/**
 * 德州扑克权威房间 WebSocket 联机测试（无需浏览器）——隐私泄漏负向测试重点。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 双人房满员自动发牌（前注/底池/轮转）、下注轮次校验、越权被拒、
 * 无注时弃牌被拒（旧 UI 口径）、伪造字段被忽略、过牌推进到摊牌、
 * 弃牌获胜路径、断线重连、房主开下一手（庄家位轮转/筹码延续）、
 * 房主重置、中途离开清空隐私数据。
 *
 * 隐私断言（直接检查 WebSocket payload，不是检查页面显示）：
 * - 每个客户端消息中出现的所有牌 id，必须 ⊆ 该客户端结构性可见的牌集合
 *   （自己的底牌 + 已发的公共牌 + 终局后公开的全部底牌）——
 *   同时覆盖"他人底牌"、"未来公共牌"、"牌堆顺序"三类泄漏；
 * - 公共牌张数必须与阶段严格一致（翻牌 3 / 转牌 4 / 河牌 5），不提前下发；
 * - 终局前他人座位只有 handCount，没有 hand 字段。
 *
 * 运行方式：node tests/texas-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../texas-rules");

const TEST_PORT = 18097;
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
  /** 收到的全部消息。 */
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
 * 计算某客户端"结构性可见"的牌 id 集合：自己的底牌 + 已发公共牌 +
 * 终局后公开的全部底牌（从它收到的快照解析）。
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
    (game.community || []).forEach((card) => allowed.add(card.id));
    if (game.over) {
      game.seats.forEach((seat) => (seat.hand || []).forEach((card) => allowed.add(card.id)));
    }
  }
  return allowed;
}

/**
 * 隐私断言：客户端消息中出现的所有牌 id 必须在其结构性可见集合内。
 *
 * 该断言同时覆盖三类泄漏：他人底牌、未来公共牌、牌堆顺序。
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
 * 阶段 -> 公共牌张数（进度断言用）。
 */
const COMMUNITY_COUNT = { idle: 0, preflop: 0, flop: 3, turn: 4, river: 5, showdown: 5 };

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
  let aCreds = null;
  /** 甲的存活连接（重连测试后原 A 连接已 terminate，用新连接继续后续用例）。 */
  let aLive = null;

  await testCase("双人房：满员自动发牌（前注 10、庄家位轮转、底池 20）", async () => {
    const created = await A.request("room.create", { gameType: "texas", prefix: "TX", nickname: "玩家甲", playerCount: 2 });
    roomId = created.roomId;
    aCreds = { playerId: created.playerId, reconnectToken: created.reconnectToken };
    assert(/^TX[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 TX+6 位，实际 ${roomId}`);
    const joined = await B.request("room.join", { roomId, nickname: "玩家乙", gameType: "texas" });
    // 1. 满员自动发牌。
    assertEq(joined.snapshot.game.phase, "preflop", "翻牌前下注轮");
    assertEq(joined.snapshot.game.myHand.length, 2, "乙的 2 张底牌");
    assertEq(joined.snapshot.game.pot, rules.ANTE * 2, "底池 = 前注 ×2");
    assertEq(joined.snapshot.game.currentBet, rules.ANTE, "当前注 = 前注");
    assertEq(joined.snapshot.game.seats.map((seat) => seat.stack), [rules.START_STACK - rules.ANTE, rules.START_STACK - rules.ANTE], "扣前注");
    const aGame = await A.waitGame((g) => g.phase === "preflop");
    assertEq(aGame.myHand.length, 2, "甲的 2 张底牌");
    // 2. 首手庄家位为 0，先行动的是庄家的下一位（座位 1）。
    assertEq(aGame.dealer, 0, "首手庄家位");
    assertEq(aGame.turn, 1, "庄家下一位先行动");
    // 3. 终局前他人座位只有张数。
    [aGame, joined.snapshot.game].forEach((game) => {
      assertEq(game.community.length, 0, "翻牌前无公共牌");
      game.seats.forEach((seat) => {
        assertEq(seat.handCount, 2, "底牌张数");
        assertEq(seat.hand, null, "终局前他人底牌不下发");
      });
    });
  });

  await testCase("隐私：发牌后任何消息不泄漏他人底牌/未来公共牌/牌堆顺序", async () => {
    [A, B].forEach((client) => assertNoCardLeak(client, "发牌后"));
  });

  await testCase("越权：非当前回合方行动被拒（NOT_YOUR_TURN）", async () => {
    const game = await A.waitGame((g) => g.phase === "preflop" && !g.over);
    const notTurn = game.turn === 0 ? B : A;
    for (const action of ["check_call", "raise", "fold"]) {
      try {
        await notTurn.request("game.action", { action });
        throw new Error("应被拒绝");
      } catch (err) {
        assertEq(err.code, "NOT_YOUR_TURN", `${action} 错误码`);
      }
    }
  });

  await testCase("伪造字段：夹带 hands/pot/winners 的过牌只按意图推进", async () => {
    const game = await A.waitGame((g) => g.phase === "preflop" && !g.over);
    const seat = game.turn;
    const client = seat === 0 ? A : B;
    const res = await client.request("game.action", {
      action: "check_call",
      hands: [],
      pot: 9999,
      turn: 0,
      over: true,
      winners: [0],
      community: [],
    });
    // 1. 服务器按意图推进：过牌（前注已追平）、无伪造终局、底池不变。
    assertEq(res.snapshot.game.over, false, "没有伪造的终局");
    assertEq(res.snapshot.game.winners, [], "没有伪造的赢家");
    assertEq(res.snapshot.game.pot, rules.ANTE * 2, "底池未被伪造");
  });

  await testCase("过牌驱动到摊牌：公共牌按阶段推进，不提前下发，终局公开", async () => {
    let game = await A.waitGame((g) => g.started && !g.over, 10000);
    let lastMoves = game.moves;
    let foldFreeTested = false;
    for (let round = 0; round < 40 && !game.over; round += 1) {
      const seat = game.turn;
      const client = seat === 0 ? A : B;
      const seatGame = await client.waitGame((g) => g.moves === game.moves, 10000);
      // 1. 公共牌张数必须与阶段严格一致（未来公共牌不提前下发）。
      assertEq(seatGame.community.length, COMMUNITY_COUNT[seatGame.phase] ?? 0, `${seatGame.phase} 阶段公共牌张数`);
      // 2. 无注时（currentBet=0）弃牌被拒（旧 UI 口径），只测一次。
      if (!foldFreeTested && seatGame.currentBet === 0) {
        try {
          await client.request("game.action", { action: "fold" });
          throw new Error("应被拒绝");
        } catch (err) {
          assertEq(err.code, "INVALID_ACTION", "无注弃牌错误码");
        }
        foldFreeTested = true;
      }
      // 3. 过牌/跟注推进。
      await client.request("game.action", { action: "check_call" });
      game = await A.waitGame((g) => g.over || g.moves > lastMoves, 10000);
      lastMoves = game.moves;
      // 4. 阶段推进中的隐私检查。
      assertNoCardLeak(A, "对局中");
      assertNoCardLeak(B, "对局中");
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
    // 5. 摊牌断言。
    assertEq(game.over, true, "对局结束");
    assertEq(game.phase, "showdown", "摊牌阶段");
    assertEq(game.community.length, 5, "公共牌 5 张");
    assert(game.winners.length >= 1, "有赢家");
    // 6. 底池守恒：赢家分得底池。
    const stacks = game.seats.map((seat) => seat.stack);
    const potBefore = rules.ANTE * 2;
    const total = stacks[0] + stacks[1];
    assertEq(total, rules.START_STACK * 2, "筹码守恒");
    game.winners.forEach((index) => {
      const expectedShare = Math.floor(potBefore / game.winners.length);
      assertEq(stacks[index], rules.START_STACK - rules.ANTE + expectedShare, `赢家 ${index} 分池`);
    });
    // 7. 终局后底牌公开。
    [A, B].forEach((client) => {
      const g = client.lastGame();
      g.seats.forEach((seat) => assert(Array.isArray(seat.hand) && seat.hand.length === 2, "终局后底牌公开"));
    });
    // 8. 终局隐私总检。
    [A, B].forEach((client) => assertNoCardLeak(client, "终局"));
    // 9. 结束后不能再行动。
    try {
      await A.request("game.action", { action: "check_call" });
      throw new Error("结束后不应再能行动");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  await testCase("断线重连：座位与底牌恢复，隐私不泄漏", async () => {
    A.terminate();
    await B.waitFor("room.player_disconnected", (p) => p.playerId === aCreds.playerId);
    const A2 = makeClient("A2");
    await A2.open;
    const reconnected = await A2.request("room.reconnect", { roomId, playerId: aCreds.playerId, reconnectToken: aCreds.reconnectToken, gameType: "texas" });
    assertEq(reconnected.snapshot.game.mySeatIndex, 0, "重连回原座");
    assertEq(reconnected.snapshot.game.over, true, "终局状态恢复");
    assertEq(reconnected.snapshot.game.myHand.length, 2, "底牌恢复（终局公开）");
    await A2.waitGame((g) => g.over);
    assertNoCardLeak(A2, "重连后");
    A.close();
    aLive = A2;
  });

  await testCase("房主开下一手：庄家位轮转、筹码延续，弃牌获胜路径", async () => {
    const stacksBefore = aLive.lastGame().seats.map((seat) => seat.stack);
    const res = await aLive.request("game.action", { action: "start" });
    const g = res.snapshot.game;
    // 1. 下一手：庄家位轮转到 1，筹码延续。
    assertEq(g.phase, "preflop", "重新进入翻牌前");
    assertEq(g.dealer, 1, "庄家位轮转");
    assertEq(g.myHand.length, 2, "重新发 2 张底牌");
    assertEq(g.community.length, 0, "公共牌清空");
    const afterAnte = g.seats.map((seat) => seat.stack);
    assertEq(afterAnte[0], stacksBefore[0] - rules.ANTE, "甲筹码延续并扣前注");
    assertEq(afterAnte[1], stacksBefore[1] - rules.ANTE, "乙筹码延续并扣前注");
    // 2. 新一手隐私检查。
    [aLive, B].forEach((client) => assertNoCardLeak(client, "下一手"));
    // 3. 弃牌获胜路径：轮到谁谁弃牌，另一人赢底池。
    let game = await aLive.waitGame((x) => x.phase === "preflop" && !x.over, 10000);
    const potNow = game.pot;
    const seat = game.turn;
    const client = seat === 0 ? aLive : B;
    await client.request("game.action", { action: "fold" });
    game = await aLive.waitGame((x) => x.over, 10000);
    assertEq(game.over, true, "弃牌后立即结束");
    const expectedWinner = seat === 0 ? 1 : 0;
    assertEq(game.winners, [expectedWinner], "未弃牌者获胜");
    assertEq(game.seats[expectedWinner].stack, afterAnte[expectedWinner] + potNow, "赢家收底池");
  });

  await testCase("房主重置：筹码回到起始值，回到等待", async () => {
    const res = await aLive.request("game.action", { action: "restart" });
    const g = res.snapshot.game;
    assertEq(g.phase, "idle", "回到等待");
    assertEq(g.started, false, "未开局");
    assertEq(g.myHand, [], "底牌已清空");
    assertEq(g.community, [], "公共牌已清空");
    assertEq(g.seats.map((seat) => seat.stack), [rules.START_STACK, rules.START_STACK], "筹码复位");
  });

  await testCase("中途离开：房间回到等待，隐私数据清空", async () => {
    await B.request("room.leave");
    const waiting = await aLive.waitGame((g) => g.started === false, 10000);
    assertEq(waiting.seats.length, 1, "剩一个座位");
    assertEq(waiting.myHand, [], "底牌已清空");
  });

  aLive.close();
  B.close();

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
