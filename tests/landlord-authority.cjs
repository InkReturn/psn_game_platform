/**
 * 斗地主权威房间 WebSocket 联机测试（无需浏览器）——隐私泄漏负向测试重点。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 三人房满员自动发牌、叫分流程（叫/抢/倍率/地主确定）、出牌校验
 * （越权/不在手/未知牌型/压不过/领出时不能不出）、伪造字段被忽略、
 * 断线重连保座位、房主重新发牌、中途离开清空隐私数据、
 * 以及提示策略驱动完整一局到有人出完。
 *
 * 隐私断言（直接检查 WebSocket payload，不是检查页面显示）：
 * - 任何客户端收到的任何消息中，不得出现其他玩家手牌的牌 id
 *   （已公开打出的牌与已公布的底牌除外）；
 * - 地主确定前，任何客户端的任何消息中不得出现底牌 id；
 * - 任何快照的 seats 数组只有 handCount，没有 hand 字段。
 *
 * 运行方式：node tests/landlord-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../landlord-rules");

const TEST_PORT = 18092;
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

/**
 * 收集某客户端"已公开可见"的牌 id（已出的牌 + 已公布的底牌）。
 *
 * @param {object} client - 客户端。
 * @returns {Set<string>} 公开牌 id 集合。
 */
function publicIdsOf(client) {
  const publicIds = new Set();
  for (const m of client.received) {
    const game = m.payload?.snapshot?.game;
    if (!game) continue;
    (game.lastPlay?.cards || []).forEach((card) => publicIds.add(card.id));
    if (game.bottomRevealed) (game.bottomCards || []).forEach((card) => publicIds.add(card.id));
  }
  return publicIds;
}

/**
 * 隐私断言：victim 当前手牌中"从未公开"的牌 id 不得出现在 observer 收到的
 * 任何消息里。已公开的牌豁免：打出的牌（进入 lastPlay）与已公布的底牌
 * （地主收走后既在地主手里、也对所有人公开，属于合法可见）。
 *
 * @param {object} victim - 手牌持有者客户端。
 * @param {Array<object>} observers - 观察者客户端列表（不含 victim 本人）。
 * @param {string} [context] - 断言上下文描述（失败时定位用）。
 */
function assertNoHandLeak(victim, observers, context) {
  const victimGame = victim.lastGame();
  const victimIds = (victimGame?.myHand || []).map((card) => card.id);
  for (const observer of observers) {
    // 1. 该观察者视角下已公开的牌（打出的牌 + 已公布的底牌）。
    const allowed = publicIdsOf(observer);
    for (const id of victimIds) {
      if (allowed.has(id)) continue;
      const needle = `"${id}"`;
      const hit = observer.rawReceived.find((raw) => raw.includes(needle));
      assert(!hit, `${context}: ${observer.label} 的消息中泄漏了 ${victim.label} 的手牌 ${id}`);
    }
  }
}

/**
 * 隐私断言：给定牌 id 列表（如底牌）不得出现在任何客户端的消息里。
 *
 * 可选 fromMarks：只扫描各客户端从该下标之后收到的消息——上一局公开打出
 * 的牌在新一轮可能恰好成为底牌，全历史扫描会误报，因此重发牌后的断言
 * 必须带上重发牌前的历史长度。
 *
 * @param {Array<string>} ids - 不应出现的牌 id。
 * @param {Array<object>} clients - 全部客户端。
 * @param {string} context - 断言上下文描述。
 * @param {Array<number>} [fromMarks] - 各客户端 rawReceived 的起始扫描下标。
 */
function assertIdsNeverSent(ids, clients, context, fromMarks) {
  clients.forEach((client, index) => {
    const start = fromMarks ? fromMarks[index] : 0;
    const scope = client.rawReceived.slice(start);
    for (const id of ids) {
      const needle = `"${id}"`;
      const hit = scope.find((raw) => raw.includes(needle));
      assert(!hit, `${context}: ${client.label} 的消息中出现了不应下发的 ${id}`);
    }
  });
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

  await testCase("三人房：满员自动洗牌发牌，各家只看到自己的 17 张", async () => {
    const created = await A.request("room.create", { gameType: "landlord", prefix: "DD", nickname: "地主甲" });
    roomId = created.roomId;
    aCreds = { playerId: created.playerId, reconnectToken: created.reconnectToken };
    assert(/^DD[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 DD+6 位，实际 ${roomId}`);
    assertEq(created.snapshot.game.phase, "idle", "两人未开局");
    await B.request("room.join", { roomId, nickname: "农民乙", gameType: "landlord" }).then((res) => {
      assertEq(res.snapshot.game.phase, "idle", "两人仍未开局");
    });
    const joined = await C.request("room.join", { roomId, nickname: "农民丙", gameType: "landlord" });
    // 1. 满员自动发牌：叫分阶段，各家 17 张。
    assertEq(joined.snapshot.game.phase, "bidding", "满员自动进入叫分");
    assertEq(joined.snapshot.game.myHand.length, 17, "丙的 17 张手牌");
    const aGame = await A.waitGame((g) => g.phase === "bidding");
    const bGame = await B.waitGame((g) => g.phase === "bidding");
    assertEq(aGame.myHand.length, 17, "甲的 17 张手牌");
    assertEq(bGame.myHand.length, 17, "乙的 17 张手牌");
    // 2. 三家手牌互不重叠（共 51 张不同 id）。
    const all = [...aGame.myHand, ...bGame.myHand, ...joined.snapshot.game.myHand].map((card) => card.id);
    assertEq(new Set(all).size, 51, "三家手牌无重叠");
    // 3. 座位信息只有张数，没有手牌内容。
    for (const game of [aGame, bGame, joined.snapshot.game]) {
      game.seats.forEach((seat) => {
        assertEq(seat.handCount, 17, "座位剩余张数");
        assert(!("hand" in seat), "座位信息不得包含 hand 字段");
      });
      assertEq(game.bottomRevealed, false, "底牌未公布");
      assertEq(game.bottomCards, [], "底牌内容未下发");
    }
  });

  await testCase("满员：第四人加入被拒（ROOM_FULL）", async () => {
    const D = makeClient("D");
    await D.open;
    try {
      await D.request("room.join", { roomId, nickname: "第四人", gameType: "landlord" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "错误码");
    }
    D.close();
  });

  await testCase("隐私：发牌后任何消息不泄漏他人手牌与底牌", async () => {
    // 1. 他人手牌不泄漏（直接扫描 WebSocket 原始 payload）。
    assertNoHandLeak(A, [B, C], "发牌后");
    assertNoHandLeak(B, [A, C], "发牌后");
    assertNoHandLeak(C, [A, B], "发牌后");
    // 2. 底牌（54 张中不在三家手里的 3 张）不下发给任何人。
    const aGame = A.lastGame();
    const bGame = B.lastGame();
    const cGame = C.lastGame();
    const dealt = new Set([...aGame.myHand, ...bGame.myHand, ...cGame.myHand].map((card) => card.id));
    const bottomIds = rules.buildDeck().map((card) => card.id).filter((id) => !dealt.has(id));
    assertEq(bottomIds.length, 3, "底牌应为 3 张");
    assertIdsNeverSent(bottomIds, [A, B, C], "底牌公布前");
  });

  await testCase("叫分：越权被拒，叫/抢翻倍，最高叫者当地主并收底牌", async () => {
    // 1. 乙（非当前叫分者）抢先叫被拒。
    try {
      await B.request("game.action", { action: "bid", call: true });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
    // 2. 甲叫地主（倍率 x2）。
    const bidA = await A.request("game.action", { action: "bid", call: true });
    assertEq(bidA.snapshot.game.multiplier, 2, "倍率 x2");
    assertEq(bidA.snapshot.game.biddingTurn, 1, "轮到乙叫");
    // 3. 乙不叫，丙抢地主（倍率 x4）→ 丙成为地主。
    await B.request("game.action", { action: "bid", call: false });
    const bidC = await C.request("game.action", { action: "bid", call: true });
    const g = bidC.snapshot.game;
    assertEq(g.multiplier, 4, "倍率 x4");
    assertEq(g.phase, "playing", "进入出牌阶段");
    assertEq(g.landlordIndex, 2, "丙是地主");
    assertEq(g.turn, 2, "地主先出");
    assertEq(g.myHand.length, 20, "地主收底牌后 20 张");
    assertEq(g.bottomRevealed, true, "底牌已公布");
    assertEq(g.bottomCards.length, 3, "底牌内容对所有人公开");
    // 4. 甲乙看到丙 20 张、自己 17 张。
    const aGame = await A.waitGame((x) => x.phase === "playing");
    assertEq(aGame.seats[2].handCount, 20, "甲视角：地主 20 张");
    assertEq(aGame.myHand.length, 17, "甲仍是 17 张");
    assertEq(aGame.bottomCards.length, 3, "甲也能看到公布的底牌");
  });

  await testCase("隐私：地主确定后他人手牌仍不泄漏（底牌除外）", async () => {
    // 1. 底牌已公开（允许出现在消息里），但甲乙丙的私有手牌仍互不可见。
    assertNoHandLeak(A, [B, C], "地主确定后");
    assertNoHandLeak(B, [A, C], "地主确定后");
    assertNoHandLeak(C, [A, B], "地主确定后");
  });

  let leadCardId = null;
  await testCase("出牌：越权/不在手/未知牌型/压不过被拒，合法出牌公开可见", async () => {
    // 1. 甲（非当前回合）出牌被拒。
    const aGame = await A.waitGame((g) => g.phase === "playing");
    try {
      await A.request("game.action", { action: "play", cards: [aGame.myHand[0].id] });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "越权错误码");
    }
    // 2. 丙领出最小单张。
    const cGame = await C.waitGame((g) => g.phase === "playing" && g.turn === 2);
    leadCardId = cGame.myHand[0].id;
    const played = await C.request("game.action", { action: "play", cards: [leadCardId] });
    const g = played.snapshot.game;
    assertEq(g.lastPlay.cards.map((card) => card.id), [leadCardId], "上一手公开");
    assertEq(g.seats[2].handCount, 19, "地主剩 19 张");
    assertEq(g.turn, 0, "轮到甲");
    // 3. 甲出不在手中的牌被拒（INVALID_CARD）。
    const fresh = await A.waitGame((x) => x.turn === 0);
    const notInHand = rules.buildDeck().map((card) => card.id).find((id) => !fresh.myHand.some((card) => card.id === id) && id !== leadCardId);
    try {
      await A.request("game.action", { action: "play", cards: [notInHand] });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_CARD", "不在手错误码");
    }
    // 4. 甲出未知牌型（三带一）被拒。
    const idsByRank = new Map();
    fresh.myHand.forEach((card) => {
      if (!idsByRank.has(card.rank)) idsByRank.set(card.rank, []);
      idsByRank.get(card.rank).push(card.id);
    });
    const triple = [...idsByRank.values()].find((list) => list.length >= 3);
    const single = fresh.myHand.find((card) => idsByRank.get(card.rank)?.length === 1);
    if (triple && single) {
      try {
        await A.request("game.action", { action: "play", cards: [...triple.slice(0, 3), single.id] });
        throw new Error("应被拒绝");
      } catch (err) {
        assertEq(err.code, "INVALID_ACTION", "未知牌型错误码");
      }
    }
    // 5. 甲出压不过的单张被拒（INVALID_MOVE）：出比领出更小的牌。
    const smaller = fresh.myHand.find((card) => rules.RANK_VALUE[card.rank] < rules.RANK_VALUE[g.lastPlay.cards[0].rank] && card.id !== leadCardId);
    if (smaller) {
      try {
        await A.request("game.action", { action: "play", cards: [smaller.id] });
        throw new Error("应被拒绝");
      } catch (err) {
        assertEq(err.code, "INVALID_MOVE", "压不过错误码");
      }
    }
  });

  await testCase("不出：两家中途不出清一轮，领出时不出被拒", async () => {
    // 1. 甲不出（passes=1）。
    await A.waitGame((g) => g.turn === 0);
    const passA = await A.request("game.action", { action: "pass" });
    assertEq(passA.snapshot.game.turn, 1, "轮到乙");
    // 2. 乙不出（passes=2 → 一轮结束，重新领出）。
    const passB = await B.request("game.action", { action: "pass" });
    const g = passB.snapshot.game;
    assertEq(g.lastPlay, null, "上一手已清空");
    assertEq(g.turn, 2, "轮回地主领出");
    // 3. 领出时不能不出。
    try {
      await C.request("game.action", { action: "pass" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "领出时不出错误码");
    }
  });

  await testCase("伪造字段：夹带 hands/multiplier/turn/over 的出牌只按 id 列表推进", async () => {
    // 1. 丙领出一张（夹带大量伪造字段）。
    const cGame = await C.waitGame((g) => g.turn === 2 && !g.lastPlay);
    const cardId = cGame.myHand[0].id;
    const res = await C.request("game.action", {
      action: "play",
      cards: [cardId],
      hands: [[], [], []],
      multiplier: 1,
      turn: 0,
      over: true,
      lastPlay: null,
    });
    // 2. 服务器按意图推进：出牌成功、无伪造终局、倍率不变。
    assertEq(res.snapshot.game.lastPlay.cards.map((card) => card.id), [cardId], "按 id 列表出牌");
    assertEq(res.snapshot.game.over, false, "没有伪造的终局");
    assertEq(res.snapshot.game.multiplier, 4, "倍率未被伪造");
    assertEq(res.snapshot.game.seats[2].handCount, 18, "地主手牌数正确");
    // 3. 甲乙不出，清一轮交回丙。
    await A.request("game.action", { action: "pass" });
    await B.request("game.action", { action: "pass" });
    await C.waitGame((g) => g.turn === 2 && !g.lastPlay);
  });

  await testCase("断线重连：座位与手牌恢复，隐私不泄漏", async () => {
    A.terminate();
    await B.waitFor("room.player_disconnected", (p) => p.playerId === aCreds.playerId);
    // 1. 重连后甲拿回自己的手牌。
    const A2 = makeClient("A2");
    await A2.open;
    const reconnected = await A2.request("room.reconnect", { roomId, playerId: aCreds.playerId, reconnectToken: aCreds.reconnectToken, gameType: "landlord" });
    const g = reconnected.snapshot.game;
    assertEq(g.mySeatIndex, 0, "重连回原座");
    assert(g.myHand.length > 0 && g.myHand.length <= 17, `甲手牌恢复（${g.myHand.length} 张）`);
    assertEq(g.phase, "playing", "对局仍在进行");
    // 2. 重连消息同样不泄漏他人手牌。
    assertNoHandLeak(A2, [B, C], "重连后");
    assertNoHandLeak(B, [A2, C], "重连后");
    assertNoHandLeak(C, [A2, B], "重连后");
    A.close();
    aLive = A2;
  });

  await testCase("完整一局：提示策略驱动到有人出完，全程无泄漏，双端一致", async () => {
    const clients = [aLive, B, C];
    // 1. 驱动：当前玩家用共享规则的提示出牌，无提示则不出。
    let game = await aLive.waitGame((g) => g.started && g.phase === "playing", 10000);
    let lastMoves = game.moves;
    for (let round = 0; round < 400; round += 1) {
      if (game.over) break;
      const seat = game.turn;
      // 1. 等该座位客户端追平当前行动数，再读它的个性化手牌。
      const seatGame = await clients[seat].waitGame((g) => g.moves === game.moves, 10000);
      const hint = rules.findHint(seatGame.myHand, seatGame.lastPlay);
      if (hint.length) {
        await clients[seat].request("game.action", { action: "play", cards: hint });
      } else {
        await clients[seat].request("game.action", { action: "pass" });
      }
      game = await aLive.waitGame((g) => g.over || g.moves > lastMoves, 10000);
      lastMoves = game.moves;
      await new Promise((resolve) => setTimeout(resolve, 120));
    }
    // 2. 终局断言。
    assertEq(game.over, true, "对局结束");
    assert(game.winnerSeat !== null, "有胜者座位");
    assertEq(game.seats[game.winnerSeat].handCount, 0, "胜者手牌出完");
    assert(game.moves > 4, `应有多步行动，实际 ${game.moves}`);
    // 3. 三端终局一致（公共字段）。
    const finals = clients.map((client) => client.lastGame());
    finals.forEach((g) => {
      assertEq(g.over, true, "各端都看到结束");
      assertEq(g.winnerSeat, game.winnerSeat, "各端胜者一致");
    });
    // 4. 终局隐私总检：败方剩余手牌从未泄漏给任何他人。
    assertNoHandLeak(aLive, [B, C], "终局");
    assertNoHandLeak(B, [aLive, C], "终局");
    assertNoHandLeak(C, [aLive, B], "终局");
    // 5. 结束后不能再出牌。
    try {
      await aLive.request("game.action", { action: "pass" });
      throw new Error("结束后不应再能行动");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
  });

  await testCase("房主重新发牌：新手牌、回到叫分、底牌重新隐藏", async () => {
    // 0. 记录重发牌前的消息历史长度：新底牌断言只扫描之后的消息
    //    （上一局公开打出的牌在新一轮可能恰好成为底牌，不能算泄漏）。
    const clients = [aLive, B, C];
    const marks = clients.map((client) => client.rawReceived.length);
    const res = await aLive.request("game.action", { action: "restart" });
    const g = res.snapshot.game;
    assertEq(g.phase, "bidding", "回到叫分");
    assertEq(g.myHand.length, 17, "重新发 17 张");
    assertEq(g.multiplier, 1, "倍率归位");
    assertEq(g.bottomRevealed, false, "底牌重新隐藏");
    assertEq(g.bottomCards, [], "底牌内容不下发");
    // 1. 新手牌与上一局不同（洗牌生效）。
    const bGame = await B.waitGame((x) => x.phase === "bidding" && x.moves === 0);
    assertEq(bGame.myHand.length, 17, "乙新 17 张");
    // 2. 新底牌（不在新三家手里的 3 张）同样不泄漏。
    const cGame = await C.waitGame((x) => x.phase === "bidding" && x.moves === 0);
    const dealt = new Set([...g.myHand, ...bGame.myHand, ...cGame.myHand].map((card) => card.id));
    const bottomIds = rules.buildDeck().map((card) => card.id).filter((id) => !dealt.has(id));
    assertEq(bottomIds.length, 3, "新底牌 3 张");
    assertIdsNeverSent(bottomIds, clients, "重新发牌后", marks);
  });

  await testCase("中途离开：房间回到等待，隐私数据全部清空", async () => {
    await C.request("room.leave");
    const waiting = await aLive.waitGame((g) => g.started === false, 10000);
    assertEq(waiting.phase, "idle", "回到等待");
    assertEq(waiting.seats.length, 2, "剩两个座位");
    assertEq(waiting.myHand, [], "手牌已清空");
    assertEq(waiting.bottomCards, [], "底牌已清空");
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
