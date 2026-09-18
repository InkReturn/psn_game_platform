/**
 * 大富翁权威房间 WebSocket 联机测试（无需浏览器）。
 *
 * 直接对本地启动的游戏服务器建立 WebSocket 连接，覆盖：
 * 双人房建房/满员自动开局、掷骰权与轮次校验、待购买未决时掷骰被拒、
 * 他人代买被拒、客户端伪造 dice/chance/players 字段被服务器忽略、
 * 断线重连保座位、房主重开、以及一局"红方全买 / 蓝方全跳"驱动到破产的完整局。
 *
 * 关键断言：
 * - 骰子与机会金额永远来自服务器（快照 dice 字段与资金变化），
 *   action 里夹带的 dice/chance 字段不采纳；
 * - action 里夹带 players/cells/pendingPurchase 等伪造字段一概不采纳。
 *
 * 运行方式：node tests/monopoly-authority.cjs
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
const rules = require("../monopoly-rules");

const TEST_PORT = 18090;
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
        throw new Error(`[${label}] snapshot never satisfied predicate (last=${game ? JSON.stringify({ turn: game.turn, moves: game.moves }) : "none"})`);
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
 * 驱动一局双人局到破产终局：红方（0 号位）能买必买，蓝方（1 号位）全跳。
 *
 * 每轮按权威快照行动：有待购买则由待购买玩家决定，否则由当前回合方掷骰。
 * 以 moves 单调递增驱动，避免对同一状态重复行动。
 *
 * @param {Array<object>} clients - [红方客户端, 蓝方客户端]。
 * @param {number} [maxRounds] - 最大行动数。
 * @returns {Promise<object>} 结束时的对局快照。
 */
async function driveToBankrupt(clients, maxRounds = 600) {
  // 1. 先拿到当前局面，之后每轮"按当前状态行动 -> 等待服务器推进"。
  let game = await clients[0].waitGame((g) => g.started, 10000);
  for (let round = 0; round < maxRounds; round += 1) {
    if (game.over) return game;
    const lastMoves = game.moves;
    // 2. 待购买：红方买入、蓝方跳过；否则由当前回合方掷骰。
    if (game.pendingPurchase) {
      const seat = game.pendingPurchase.playerIndex;
      await clients[seat].request("game.action", { action: "purchase", buy: seat === 0 });
    } else {
      await clients[game.turn].request("game.action", { action: "roll" });
    }
    // 3. 等待权威快照推进（发起者响应/旁观者广播都会更新本地快照）。
    game = await clients[0].waitGame((g) => g.over || g.moves > lastMoves, 10000);
    // 4. 限速：压到服务器限流阈值（40 条 / 5 秒 / 连接）之下。
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

  /**
   * 座位下标 -> 存活连接（重连后蓝方连接切换）。
   *
   * @param {number} seat - 座位下标（0/1）。
   * @returns {object} 对应客户端。
   */
  function seatClient(seat) {
    return seat === 0 ? A : blueLive || B;
  }

  await testCase("双人房：建房带 playerCount=2，访客加入即自动开局", async () => {
    const created = await A.request("room.create", { gameType: "monopoly", prefix: "DF", nickname: "红甲", playerCount: 2 });
    roomId = created.roomId;
    assert(/^DF[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 DF+6 位，实际 ${roomId}`);
    assertEq(created.snapshot.game.playerCount, 2, "playerCount");
    assertEq(created.snapshot.game.started, false, "单人未开局");
    const joined = await B.request("room.join", { roomId, nickname: "蓝乙", gameType: "monopoly" });
    bCreds = { playerId: joined.playerId, reconnectToken: joined.reconnectToken };
    assertEq(joined.snapshot.game.started, true, "满员自动开局");
    assertEq(joined.snapshot.game.players.length, 2, "两名玩家");
    assertEq(joined.snapshot.game.players.map((p) => p.money), [rules.START_MONEY, rules.START_MONEY], "起始资金");
    assertEq(joined.snapshot.game.players.map((p) => p.pos), [0, 0], "起点");
    assertEq(joined.snapshot.game.turn, 0, "红方先走");
    assertEq(joined.snapshot.game.players[0].name, "红甲", "红方昵称");
    assert(joined.snapshot.game.cells.every((c) => c.owner === null), "地块全部无主");
  });

  await testCase("掷骰权：非当前回合方掷骰被拒（NOT_YOUR_TURN）", async () => {
    try {
      await B.request("game.action", { action: "roll" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
  });

  await testCase("服务器骰子：roll 后快照 dice 为 1..6，位置按骰点推进", async () => {
    const res = await A.request("game.action", { action: "roll" });
    const dice = res.snapshot.game.dice;
    assert(dice >= 1 && dice <= 6, `骰点应 1..6，实际 ${dice}`);
    assertEq(res.snapshot.game.players[0].pos, dice, "位置按骰点推进");
    assertEq(res.snapshot.game.moves, 1, "行动数 +1");
    // 1. 双端看到同一状态。
    const bGame = await B.waitGame((g) => g.moves === 1);
    assertEq(bGame.players[0].pos, dice, "双端位置一致");
  });

  let pendingSeen = false;
  await testCase("待购买流程：他人代买被拒，本人跳过后地块仍无主", async () => {
    // 1. 循环掷骰直到出现待购买（红方先手，蓝方陪走全跳）。
    let game = await A.waitGame((g) => g.moves === 1);
    for (let i = 0; i < 60 && !game.pendingPurchase; i += 1) {
      const seat = game.turn;
      await seatClient(seat).request("game.action", { action: "roll" });
      game = await A.waitGame((g) => g.moves > i + 1);
    }
    assert(game.pendingPurchase, "60 步内应出现待购买");
    pendingSeen = true;
    const pendingSeat = game.pendingPurchase.playerIndex;
    const other = pendingSeat === 0 ? B : A;
    // 2. 他人代买被拒。
    try {
      await other.request("game.action", { action: "purchase", buy: true });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
    // 3. 待购买未决时掷骰被拒。
    try {
      await seatClient(game.turn).request("game.action", { action: "roll" });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
    // 4. 本人跳过：地块仍无主，轮次推进。
    const cellIndex = game.pendingPurchase.cellIndex;
    const res = await seatClient(pendingSeat).request("game.action", { action: "purchase", buy: false });
    assertEq(res.snapshot.game.cells[cellIndex].owner, null, "跳过后仍无主");
    assertEq(res.snapshot.game.pendingPurchase, null, "待购买已清除");
  });
  void pendingSeen;

  await testCase("买入：归属 + 扣款 + 房产清单 + 轮次推进", async () => {
    // 1. 循环行动直到红方出现待购买（蓝方全跳）；每轮"行动 -> 等待推进"。
    let game = await A.waitGame((g) => g.moves > 0, 10000);
    for (let i = 0; i < 80; i += 1) {
      if (game.over || (game.pendingPurchase && game.pendingPurchase.playerIndex === 0)) break;
      const lastMoves = game.moves;
      if (game.pendingPurchase) {
        await B.request("game.action", { action: "purchase", buy: false });
      } else {
        await seatClient(game.turn).request("game.action", { action: "roll" });
      }
      game = await A.waitGame((g) => g.over || g.moves > lastMoves, 10000);
      await new Promise((resolve) => setTimeout(resolve, 180));
    }
    assert(game.pendingPurchase && game.pendingPurchase.playerIndex === 0, "80 步内红方应出现待购买");
    const cellIndex = game.pendingPurchase.cellIndex;
    const price = rules.CELLS[cellIndex].price;
    const moneyBefore = game.players[0].money;
    // 2. 红方买入。
    const res = await A.request("game.action", { action: "purchase", buy: true });
    assertEq(res.snapshot.game.cells[cellIndex].owner, 0, "地块归属红方");
    assertEq(res.snapshot.game.cells[cellIndex].houses, 1, "记 1 所房");
    assertEq(res.snapshot.game.players[0].money, moneyBefore - price, "扣款");
    assert(res.snapshot.game.players[0].properties.includes(rules.CELLS[cellIndex].name), "房产清单");
  });

  await testCase("伪造字段：夹带 dice/chance/players 的掷骰只按服务器随机推进", async () => {
    const before = await A.waitGame((g) => g.moves > 0);
    const mover = before.turn;
    const oldPos = before.players[mover].pos;
    // 1. 夹带伪造字段：想强制骰点 6、机会 +120、伪造玩家表。
    const res = await seatClient(mover).request("game.action", {
      action: "roll",
      dice: 6,
      chance: 120,
      players: [],
      cells: [],
      over: true,
    });
    // 2. 服务器按自己的随机推进：位置 = (旧位置 + 服务器骰点) % 40（进监狱除外）、
    //    无伪造终局、无伪造玩家表。
    const dice = res.snapshot.game.dice;
    assert(dice >= 1 && dice <= 6, `服务器骰点应 1..6，实际 ${dice}`);
    const newPos = res.snapshot.game.players[mover].pos;
    const landedOnJail = newPos === rules.JAIL_INDEX && res.snapshot.game.players[mover].jailed === 1 && oldPos + dice >= rules.JAIL_INDEX + 10;
    if (!landedOnJail) {
      assertEq(newPos, (oldPos + dice) % rules.CELLS.length, "位置按服务器骰点推进");
    }
    assertEq(res.snapshot.game.over, false, "没有伪造的终局");
    assertEq(res.snapshot.game.players.length, 2, "没有采纳伪造的玩家表");
  });

  await testCase("无待购买时 purchase 被拒（INVALID_ACTION）", async () => {
    // 0. 若上一用例的掷骰产生了待购买，先由待购买玩家跳过，回到无待购买状态。
    let game = await A.waitGame((g) => g.moves > 0, 10000);
    if (game.pendingPurchase) {
      await seatClient(game.pendingPurchase.playerIndex).request("game.action", { action: "purchase", buy: false });
      game = await A.waitGame((g) => !g.pendingPurchase, 10000);
    }
    void game;
    try {
      await A.request("game.action", { action: "purchase", buy: true });
      throw new Error("应被拒绝");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
  });

  await testCase("断线重连：座位保留，快照恢复后可继续行动", async () => {
    B.terminate();
    await A.waitFor("room.player_disconnected", (p) => p.playerId === bCreds.playerId);
    const disconnected = await A.waitGame((g) => g.started);
    assertEq(disconnected.seatPlayerIds[1], bCreds.playerId, "座位仍保留");
    // 1. 新连接凭 playerId + reconnectToken 恢复身份。
    const B2 = makeClient("B2");
    await B2.open;
    const reconnected = await B2.request("room.reconnect", { roomId, playerId: bCreds.playerId, reconnectToken: bCreds.reconnectToken, gameType: "monopoly" });
    assertEq(reconnected.snapshot.game.seatPlayerIds[1], bCreds.playerId, "重连回原座");
    assertEq(reconnected.snapshot.game.started, true, "对局仍在进行");
    B.close();
    // 2. 后续用例改用这条存活连接。
    blueLive = B2;
  });

  await testCase("房主重开：清盘归零，资金与地块复位", async () => {
    const res = await A.request("game.action", { action: "restart" });
    assertEq(res.snapshot.game.turn, 0, "轮次归零");
    assertEq(res.snapshot.game.started, true, "重新开局");
    assertEq(res.snapshot.game.players.map((p) => p.money), [rules.START_MONEY, rules.START_MONEY], "资金复位");
    assertEq(res.snapshot.game.players.map((p) => p.pos), [0, 0], "回到起点");
    assert(res.snapshot.game.cells.every((c) => c.owner === null), "地块全部无主");
    assertEq(res.snapshot.game.pendingPurchase, null, "无待购买");
  });

  await testCase("完整局：红方全买 / 蓝方全跳，驱动到破产终局，双端一致", async () => {
    const final = await driveToBankrupt([A, blueLive]);
    assertEq(final.over, true, "对局结束");
    const bankrupt = final.players.find((p) => p.money < 0);
    assert(bankrupt, "应有破产玩家");
    assert(final.status.includes("破产"), `状态应含破产，实际 ${final.status}`);
    assert(final.moves > 4, `应有多步行动，实际 ${final.moves}`);
    // 1. 双端最终快照一致。
    const aGame = await A.waitGame((g) => g.over);
    const bGame = await blueLive.waitGame((g) => g.over);
    assertEq(JSON.stringify({ p: aGame.players, c: aGame.cells }), JSON.stringify({ p: bGame.players, c: bGame.cells }), "双端一致");
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
