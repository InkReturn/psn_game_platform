/**
 * 斗兽棋服务器权威对局协议测试（WebSocket 双客户端，无需浏览器）。
 *
 * 覆盖服务端权威化的全部关键行为：
 *   1. 创建斗兽棋房间（房间码 DS 前缀、gameType=animal-chess、房主执红）；
 *   2. 第二玩家加入 → 自动开局，双方拿到同一份权威快照与阵营分配；
 *   3. 合法走子：服务器推进状态并向双方广播同一快照；
 *   4. 双方同步：每走一步两个客户端看到的棋盘/轮次完全一致；
 *   5. 非法操作被拒且棋盘不变（非本方回合、越权动对方棋子、非法目标、坐标越界、未开局、已结束）；
 *   6. 特殊规则由服务端最终校验：河流通行、狮虎跳河、陷阱降级、鼠吃象、兽穴胜负；
 *   7. 胜负由服务端判定，双方拿到同一结果；
 *   8. 重新开局：清盘、红方先手、座位保留；
 *   9. 客户端提交伪造棋盘/winner 不生效（服务端只接受 from/to 意图）；
 *  10. 刷新恢复：凭 playerId + reconnectToken 重连后拿到当前 GameState，不重新开局、不产生第三个玩家。
 *
 * 运行方式：node tests/animal-chess-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18084 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器（tests/run-all.cjs 注入）。
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");
// 规则模块只用于"给测试规划一条合法路径"，最终裁决始终由服务端做出。
const rules = require(path.join(__dirname, "..", "animal-chess-rules"));

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18084;
/** 外部注入的站点地址（为空则自拉服务器）。 */
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
const WS_URL = `${BASE_URL.replace(/^https/, "wss").replace(/^http/, "ws")}/ws`;

/** 用例结果收集。 */
const results = [];
/** 被测服务器进程（自拉时才有）。 */
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
 * 执行一段用例并记录结果（失败不中断后续用例）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 异步用例体。
 */
async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

/**
 * 断言为真。
 *
 * @param {*} condition - 断言结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 断言深度相等。
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
 * 轮询 /health 等待服务器就绪。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early (code ${serverProcess.exitCode})\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
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
 * 测试用客户端。
 *
 * @param {string} label - 客户端标签。
 * @returns {object} 客户端封装。
 */
function makeClient(label) {
  const ws = new WebSocket(WS_URL);
  const received = [];
  const pending = new Map();
  let reqId = 1;

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    received.push(m);
    if (m.requestId && pending.has(m.requestId)) {
      const handler = pending.get(m.requestId);
      pending.delete(m.requestId);
      handler(m);
    }
  });

  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  /**
   * 发送请求并等待响应。
   *
   * @param {string} type - 消息类型。
   * @param {object} payload - 负载。
   * @param {number} [timeoutMs] - 超时毫秒。
   * @returns {Promise<object>} 响应 payload。
   */
  function request(type, payload, timeoutMs = 4000) {
    const requestId = `${label}-${reqId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`[${label}] timeout for ${type}`));
      }, timeoutMs);
      pending.set(requestId, (m) => {
        clearTimeout(timer);
        if (m.type === "room.error") {
          reject(Object.assign(new Error(`${label} ${m.payload.code}`), { code: m.payload.code, payload: m.payload }));
        } else {
          resolve(m.payload);
        }
      });
      ws.send(JSON.stringify({ version: 1, type, requestId, payload: payload || {} }));
    });
  }

  /** 最近一次收到的权威对局快照（game 部分）。 */
  function lastGame() {
    for (let i = received.length - 1; i >= 0; i -= 1) {
      const g = received[i].payload?.snapshot?.game;
      if (g) return g;
    }
    return null;
  }

  return {
    label,
    ws,
    open: openPromise,
    request,
    received,
    lastGame,
    gameCount: () => received.filter((m) => m.payload?.snapshot?.game).length,
    /** 等待条件成立。 */
    waitUntil(predicate, what, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate()) return resolve(true);
          if (Date.now() > deadline) return reject(new Error(`[${label}] timeout waiting ${what}`));
          setTimeout(tick, 40);
        };
        tick();
      });
    },
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

/**
 * 为某棋子规划到目标格的最短走法（BFS，测试专用）。
 *
 * 只是给测试"选一条合法路径"：每一步仍然提交给服务器，由服务端最终裁决。
 * 用 BFS 而不是贪心，是因为棋盘上存在己方棋子挡路、河流阻挡等需要绕行的情况。
 *
 * @param {object} game - 最近一次权威快照的 game 部分。
 * @param {{name: string, owner: string}} pieceSpec - 目标棋子。
 * @param {{row: number, col: number}} goal - 目标格。
 * @returns {{from: object, to: object}|null} 下一步走法；不可达时返回 null。
 */
function planMove(game, pieceSpec, goal) {
  const start = game.pieces.find((p) => p.alive && p.name === pieceSpec.name && p.owner === pieceSpec.owner);
  if (!start) return null;
  if (start.row === goal.row && start.col === goal.col) return null;
  const keyOf = (point) => `${point.row},${point.col}`;
  const startKey = keyOf(start);
  const goalKey = keyOf(goal);
  /** 已访问格 -> {prevKey, prevPoint}（记录"从哪里来"）。 */
  const cameFrom = new Map([[startKey, null]]);
  const queue = [{ row: start.row, col: start.col }];
  let head = 0;
  // 1. 广度优先搜索：每一步都把"该棋子移到该格之后"的棋盘交给规则模块重新计算合法落点。
  while (head < queue.length) {
    const node = queue[head++];
    const nodeKey = keyOf(node);
    if (nodeKey === goalKey) break;
    const board = game.pieces.map((p) => (p.id === start.id ? { ...p, row: node.row, col: node.col } : p));
    const mover = board.find((p) => p.id === start.id);
    for (const target of rules.legalTargets(board, mover)) {
      const key = keyOf(target);
      if (cameFrom.has(key)) continue;
      // 1. 对方兽穴是"终局格"：走进去就立刻获胜，不能当作通行的中转点。
      if (rules.terrainAt(target.row, target.col) === `${start.owner === "red" ? "blue" : "red"}-den`) continue;
      cameFrom.set(key, { prevKey: nodeKey, prevPoint: { row: node.row, col: node.col } });
      queue.push(target);
    }
  }
  // 2. 目标不可达：本回合无法推进。
  if (!cameFrom.has(goalKey)) return null;
  // 3. 从目标回溯到起点：firstStep 是起点之后的第一格，也就是本回合该走的那一步。
  let cursor = goalKey;
  let previous = cameFrom.get(cursor);
  if (!previous) return null;
  let firstStep = { row: goal.row, col: goal.col };
  while (previous.prevKey !== startKey) {
    firstStep = previous.prevPoint;
    cursor = previous.prevKey;
    previous = cameFrom.get(cursor);
    if (!previous) return null;
  }
  return { from: { row: start.row, col: start.col }, to: { row: firstStep.row, col: firstStep.col } };
}

/**
 * 该走法是否属于该棋子此刻的合法落点（服务端最终裁决前的本地预检）。
 *
 * @param {object} game - 权威快照的 game 部分。
 * @param {string} side - 走子方。
 * @param {object} piece - 棋子。
 * @param {{row: number, col: number}} target - 目标格。
 * @returns {boolean} true 表示合法。
 */
function isLegalFor(game, side, piece, target) {
  if (game.turn !== side) return false;
  const verdict = rules.validateMove(game.pieces, {
    side,
    from: { row: piece.row, col: piece.col },
    to: target,
    started: game.started,
    over: game.over,
    turn: game.turn,
  });
  return Boolean(verdict.ok);
}

/**
 * 交替走子，让红蓝各推一颗棋子走向各自目标，直到两子都到位或无法继续。
 *
 * @param {object} params - 入参。
 * @param {object} params.clients - {red, blue} 客户端。
 * @param {{spec: object, goal: object}} params.red - 红方棋子与目标格。
 * @param {{spec: object, goal: object}} params.blue - 蓝方棋子与目标格。
 * @param {Array<Array<number>>} [params.redStall] - 红方到位后的往返坐标对。
 * @param {Array<Array<number>>} [params.blueStall] - 蓝方到位后的往返坐标对。
 * @param {number} [params.maxTurns] - 最大回合数。
 * @returns {Promise<object|null>} 双方都到位时的权威快照，否则 null。
 */
async function driveBothToGoals({ clients, red, blue, redStall, blueStall, maxTurns = 80 }) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    // 1. 以红方的最新权威快照为基准。
    const base = clients.red.lastGame();
    if (!base || !base.started || base.over) return null;
    // 2. 走子方可能还没收到上一步广播：先等它也看到最新 moveCount，避免拿过期轮次做规划。
    const side = base.turn;
    const actor = clients[side];
    try {
      await actor.waitUntil(() => actor.lastGame()?.moveCount >= base.moveCount, "收到最新快照", 3000);
    } catch {
      return null;
    }
    const game = actor.lastGame();
    if (!game || !game.started || game.over || game.turn !== side) return null;
    const redAt = piecePosition(game, red.spec.name, red.spec.owner);
    const blueAt = piecePosition(game, blue.spec.name, blue.spec.owner);
    const redDone = redAt && redAt.row === red.goal.row && redAt.col === red.goal.col;
    const blueDone = blueAt && blueAt.row === blue.goal.row && blueAt.col === blue.goal.col;
    if (redDone && blueDone) return game;
    const conf = side === "red" ? red : blue;
    const done = side === "red" ? redDone : blueDone;
    const stall = side === "red" ? redStall : blueStall;
    let move = null;
    if (done) {
      // 3. 已到位：按往返坐标对来回走，维持回合。
      if (stall) {
        const piece = game.pieces.find((p) => p.alive && p.name === conf.spec.name && p.owner === conf.spec.owner);
        const [a, b] = stall;
        const target = piece.row === a[0] && piece.col === a[1] ? { row: b[0], col: b[1] } : { row: a[0], col: a[1] };
        if (isLegalFor(game, side, piece, target)) move = { from: { row: piece.row, col: piece.col }, to: target };
      }
    } else {
      move = planMove(game, conf.spec, conf.goal);
    }
    if (process.env.ANIMAL_DEBUG) {
      console.log(`    [debug] turn=${side} redAt=${JSON.stringify(redAt)} blueAt=${JSON.stringify(blueAt)} move=${JSON.stringify(move)}`);
    }
    if (!move) return null;
    try {
      await actor.request("game.action", { action: "move", ...move });
    } catch (err) {
      if (process.env.ANIMAL_DEBUG) console.log(`    [debug] ${side} move ${JSON.stringify(move)} failed: ${err.code || err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 该走法是否属于该棋子此刻的合法落点。
 *
 * @param {object} game - 权威快照的 game 部分。
 * @param {string} side - 走子方。
 * @param {object} piece - 棋子。
 * @param {{row: number, col: number}} target - 目标格。
 * @returns {boolean} true 表示合法。
 */
function isLegalFor(game, side, piece, target) {
  if (game.turn !== side) return false;
  const verdict = rules.validateMove(game.pieces, {
    side,
    from: { row: piece.row, col: piece.col },
    to: target,
    started: game.started,
    over: game.over,
    turn: game.turn,
  });
  return Boolean(verdict.ok);
}

/**
 * 反复走子直到某颗棋子到达目标格（另一方由 otherTurn 提供垫步走法）。
 *
 * 每一步都等走子方看到最新快照后再规划；走法仍由服务器最终裁决。
 *
 * @param {object} params - 入参。
 * @param {object} params.clients - {red, blue} 客户端。
 * @param {string} params.side - 需要达成目标的阵营。
 * @param {{name: string, owner: string}} params.spec - 目标棋子。
 * @param {{row: number, col: number}} params.goal - 目标格。
 * @param {Function} params.otherTurn - (game, otherSide) => move|null，另一方回合的垫步走法。
 * @param {number} [params.maxTurns] - 最大回合数。
 * @returns {Promise<object|null>} 达成目标时的权威快照，否则 null。
 */
async function driveSideToGoal({ clients, side, spec, goal, otherTurn, maxTurns = 80 }) {
  for (let turn = 0; turn < maxTurns; turn += 1) {
    const base = clients.red.lastGame();
    if (!base || !base.started || base.over) return null;
    const currentSide = base.turn;
    const actor = clients[currentSide];
    try {
      await actor.waitUntil(() => actor.lastGame()?.moveCount >= base.moveCount, "收到最新快照", 3000);
    } catch {
      return null;
    }
    const game = actor.lastGame();
    if (!game || !game.started || game.over || game.turn !== currentSide) return null;
    const at = piecePosition(game, spec.name, spec.owner);
    if (at && at.row === goal.row && at.col === goal.col) return game;
    const move = currentSide === side ? planMove(game, spec, goal) : otherTurn(game, currentSide);
    if (!move) return null;
    try {
      await actor.request("game.action", { action: "move", ...move });
    } catch (err) {
      if (process.env.ANIMAL_DEBUG) console.log(`    [debug] ${currentSide} ${JSON.stringify(move)} failed: ${err.code || err.message}`);
      return null;
    }
  }
  return null;
}

/**
 * 让一方的"主棋子"走向目标格，同时另一方由 given 的棋子垫步维持回合。
 *
 * 与 driveSideToGoal 的区别：本函数在"主棋子所在方"的回合推进主棋子，
 * 在"对手方"的回合用 stallSpec 往返垫步；两侧都可以指定，因此可以精确编排局面。
 *
 * @param {object} params - 入参。
 * @param {object} params.clients - {red, blue} 客户端。
 * @param {"red"|"blue"} params.side - 主棋子所属阵营。
 * @param {{name: string, owner: string}} params.spec - 主棋子。
 * @param {{row: number, col: number}} params.goal - 目标格。
 * @param {{name: string, owner: string}} params.stallSpec - 对手方垫步棋子。
 * @param {Array<Array<number>>} params.stallPair - 垫步往返格子 [[row,col],[row,col]]。
 * @param {number} [params.maxTurns] - 最大回合数。
 * @returns {Promise<object|null>} 主棋子到位时的权威快照，否则 null。
 */
async function driveWithStall({ clients, side, spec, goal, stallSpec, stallPair, maxTurns = 90, maxDeadlocks = 14 }) {
  const other = side === "red" ? "blue" : "red";
  const dbg = (...args) => {
    if (process.env.ANIMAL_DEBUG) console.log("    [debug]", ...args);
  };
  /** 主棋子连续无法规划路径的次数：对手垫步棋子会来回摆动，等它让开即可继续。 */
  let deadlocks = 0;
  /** 公网延迟下的竞态预算：请求被拒（轮次竞态/限流）时重新同步后重试。 */
  let retries = 0;
  for (let turn = 0; turn < maxTurns; turn += 1) {
    // 1. 先等双方快照追平同一份权威状态：公网延迟下不能同步读单方快照
    //    （旧快照会把轮次判错，导致请求被 NOT_YOUR_TURN 拒绝）。
    const game = await syncBoth(clients);
    if (!game || !game.started || game.over) {
      dbg(`abort: base invalid (started=${game?.started} over=${game?.over})`);
      return null;
    }
    const currentSide = game.turn;
    const actor = clients[currentSide];
    const at = piecePosition(game, spec.name, spec.owner);
    if (currentSide === side && at && at.row === goal.row && at.col === goal.col) return game;
    let move = null;
    if (currentSide === side) {
      move = planMove(game, spec, goal);
      if (!move) {
        // 规划不出路径：多半是垫步棋子恰好挡住了路径（BFS 把它当静态障碍）。
        // 此时用本方的"过招走法"交棒，等对方棋子摆回去再重试。
        deadlocks += 1;
        if (deadlocks > maxDeadlocks) {
          dbg(`abort: no plan for ${spec.name}@${JSON.stringify(at)} -> ${JSON.stringify(goal)} after ${deadlocks} retries`);
          return null;
        }
        move = findPassMove(game, side);
        dbg(`no plan (retry ${deadlocks}): pass with ${move ? `${move.pieceName} ${JSON.stringify(move.from)}->${JSON.stringify(move.to)}` : "none"}`);
      } else {
        // 1.1 有规划就重置死锁计数：阻塞只是垫步棋子的暂时位置。
        deadlocks = 0;
      }
    } else {
      move = makeOscillator(stallSpec, stallPair[0], stallPair[1])(game, other) || findPassMove(game, other);
    }
    if (!move) {
      dbg(`abort: no move (side=${currentSide} ${spec.name}@${JSON.stringify(at)} goal=${JSON.stringify(goal)})`);
      return null;
    }
    try {
      await actor.request("game.action", { action: "move", from: move.from, to: move.to });
    } catch (err) {
      // 2. 轮次竞态/限流被拒：重新同步后重试（预算内），不直接放弃。
      if ((err.code === "NOT_YOUR_TURN" || err.code === "RATE_LIMITED") && retries < 20) {
        retries += 1;
        dbg(`transient ${err.code} (retry ${retries}), resyncing`);
        continue;
      }
      dbg(`${currentSide} ${JSON.stringify(move)} failed: ${err.code || err.message}`);
      return null;
    }
  }
  dbg("abort: maxTurns reached");
  return null;
}

/**
 * 找一个"过招"走法：把本方任意一颗棋子走到空格，用来在无法推进主棋子时把回合交出去。
 *
 * 优先挑"能原路走回来"的走法，避免垫步棋子越走越偏。
 *
 * @param {object} game - 权威快照的 game 部分。
 * @param {string} side - 需要走子的阵营。
 * @param {string} [excludeName] - 需要避开的棋子名（例如必须留在原位的跳跃棋子）。
 * @returns {{from: object, to: object, pieceName: string}|null} 走法，找不到返回 null。
 */
function findPassMove(game, side, excludeName) {
  const reversible = [];
  const oneWay = [];
  for (const piece of game.pieces) {
    if (!piece.alive || piece.owner !== side) continue;
    if (excludeName && piece.name === excludeName) continue;
    for (const target of rules.legalTargets(game.pieces, piece)) {
      const occupant = game.pieces.find((p) => p.alive && p.row === target.row && p.col === target.col);
      if (occupant) continue;
      const entry = { from: { row: piece.row, col: piece.col }, to: target, pieceName: piece.name };
      // 走回来是否合法：把棋子挪到目标格后，看反向落点是否仍合法。
      const board = game.pieces.map((p) => (p.id === piece.id ? { ...p, row: target.row, col: target.col } : p));
      const moved = board.find((p) => p.id === piece.id);
      const back = rules.legalTargets(board, moved).some((t) => t.row === piece.row && t.col === piece.col);
      (back ? reversible : oneWay).push(entry);
    }
  }
  return reversible[0] || oneWay[0] || null;
}

/**
 * 让某颗棋子在两个格子之间往返（垫步用）。
 *
 * @param {{name: string, owner: string}} spec - 棋子。
 * @param {Array<number>} a - 格子 A [row, col]。
 * @param {Array<number>} b - 格子 B [row, col]。
 * @returns {Function} (game, side) => move|null。
 */
function makeOscillator(spec, a, b) {
  return (game, side) => {
    const piece = game.pieces.find((p) => p.alive && p.name === spec.name && p.owner === spec.owner);
    if (!piece) return null;
    const target = piece.row === a[0] && piece.col === a[1] ? { row: b[0], col: b[1] } : { row: a[0], col: a[1] };
    return isLegalFor(game, side, piece, target) ? { from: { row: piece.row, col: piece.col }, to: target } : null;
  };
}

/**
 * 等待客户端追平最新一步的广播，避免读到过期快照。
 *
 * @param {object} client - 客户端。
 * @param {number} moveCount - 期望至少看到的走子数。
 * @param {number} [timeoutMs] - 超时毫秒。
 * @returns {Promise<boolean>} 是否追平。
 */
async function waitForMoveCount(client, moveCount, timeoutMs = 3000) {
  try {
    await client.waitUntil(() => (client.lastGame()?.moveCount ?? -1) >= moveCount, `moveCount>=${moveCount}`, timeoutMs);
    return true;
  } catch {
    return false;
  }
}
/**
 * 等待两个客户端都看到至少 moveCount 步，并把两者统一到同一个快照。
 *
 * 服务器每次推进都向房内所有连接广播同一份权威快照，因此两条连接看到的
 * moveCount 最终一定一致；本助手只是等它们都追平，避免用过期快照做断言。
 *
 * @param {object} clients - {red, blue} 客户端。
 * @param {number} [timeoutMs] - 超时毫秒。
 * @returns {Promise<object|null>} 双方同步后的权威快照（game 部分），失败返回 null。
 */
async function syncBoth(clients, timeoutMs = 4000) {
  const target = Math.max(clients.red.lastGame()?.moveCount ?? -1, clients.blue.lastGame()?.moveCount ?? -1);
  if (target < 0) return null;
  const okRed = await waitForMoveCount(clients.red, target, timeoutMs);
  const okBlue = await waitForMoveCount(clients.blue, target, timeoutMs);
  if (!okRed || !okBlue) return null;
  return clients.blue.lastGame();
}

/**
 * 某一走子数对应的走子方（红先手，双方严格交替，因此由步数奇偶锁定）。
 *
 * @param {number} moveCount - 已完成步数。
 * @returns {"red"|"blue"} 该轮该走的一方。
 */
function sideForMoveCount(moveCount) {
  return moveCount % 2 === 0 ? "red" : "blue";
}

/**
 * 把轮次对齐到指定阵营：若当前不是它走，就让另一方用垫步棋子走一步。
 *
 * @param {object} params - 入参。
 * @param {object} params.clients - {red, blue} 客户端。
 * @param {"red"|"blue"} params.side - 期望走子的阵营。
 * @param {{name: string, owner: string}} params.stallSpec - 另一方垫步棋子。
 * @param {Array<Array<number>>} params.stallPair - 垫步往返格子。
 * @returns {Promise<boolean>} 是否已对齐轮次。
 */
async function alignTurnTo({ clients, side, stallSpec, stallPair }) {
  const game = await syncBoth(clients);
  if (!game) return false;
  if (sideForMoveCount(game.moveCount) === side) return true;
  const other = side === "red" ? "blue" : "red";
  // 垫步棋子可能不在给定往返点上（例如中途被吃或走偏），退回通用的过招走法。
  const move = makeOscillator(stallSpec, stallPair[0], stallPair[1])(game, other) || findPassMove(game, other);
  if (!move) return false;
  try {
    await clients[other].request("game.action", { action: "move", from: move.from, to: move.to });
    return true;
  } catch {
    return false;
  }
}
/**
 * 编排一个确定的跳河场景（走子序列手写，每一格都按规则核对可达）。
 *
 * 场景：蓝狮经 (1,6)(2,6)(2,5)(2,4)(2,3) 走到起跳点 (2,2)；红鼠 (6,0)->(5,0)->(5,1)->(5,2)
 * 潜入狮的跳河路径 (3,2)(4,2)(5,2)。蓝狮从 (2,2) 向下跳到 (6,2) 吃红豹：
 * 河中有鼠时该跳必须被拒绝；用例主体随后让鼠退到 (5,1) 验证同一跳合法。
 *
 * 前置让位：蓝鼠 (2,6)->(3,6)、蓝狼 (2,2)->(1,2)、蓝豹 (2,4)->(1,4)，各一步。
 * 垫步：红方回合用红狗在 (7,1)<->(7,0) 往返（不在任何推进路径上）。
 * 序列共 19 步（红先手，红蓝严格交替），结束时轮到蓝方（狮的跳河回合）。
 *
 * 为什么手写而不用 driveWithStall：狮/虎的起跳点 (6,5)/(2,2) 邻格被己方棋子围死，
 * BFS 把己方棋子当静态障碍时永远规划不出路径，只能按确定的让位顺序编排。
 *
 * @param {object} clients - {red, blue} 客户端。
 * @returns {Promise<{jump: object}|null>} 编排结果，失败返回 null。
 */
async function buildJumpSetup(clients) {
  // 1. 手写走子序列：红方推鼠/垫狗，蓝方先让位再推狮，严格交替。
  const script = [
    { side: "red", from: [6, 0], to: [5, 0], note: "红鼠出窝" },
    { side: "blue", from: [2, 6], to: [3, 6], note: "蓝鼠让出狮的通道" },
    { side: "red", from: [5, 0], to: [5, 1], note: "红鼠进河" },
    { side: "blue", from: [2, 2], to: [1, 2], note: "蓝狼腾出起跳点" },
    { side: "red", from: [5, 1], to: [5, 2], note: "红鼠挡住狮跳路径" },
    { side: "blue", from: [2, 4], to: [1, 4], note: "蓝豹腾出狮的通道" },
    { side: "red", from: [7, 1], to: [7, 0], note: "红狗垫步" },
    { side: "blue", from: [0, 6], to: [1, 6], note: "蓝狮出动" },
    { side: "red", from: [7, 0], to: [7, 1], note: "红狗垫步" },
    { side: "blue", from: [1, 6], to: [2, 6], note: "蓝狮推进" },
    { side: "red", from: [7, 1], to: [7, 0], note: "红狗垫步" },
    { side: "blue", from: [2, 6], to: [2, 5], note: "蓝狮推进" },
    { side: "red", from: [7, 0], to: [7, 1], note: "红狗垫步" },
    { side: "blue", from: [2, 5], to: [2, 4], note: "蓝狮推进" },
    { side: "red", from: [7, 1], to: [7, 0], note: "红狗垫步" },
    { side: "blue", from: [2, 4], to: [2, 3], note: "蓝狮推进" },
    { side: "red", from: [7, 0], to: [7, 1], note: "红狗垫步" },
    { side: "blue", from: [2, 3], to: [2, 2], note: "蓝狮到达起跳点" },
    { side: "red", from: [7, 1], to: [7, 0], note: "红狗垫步，交棒给蓝方" },
  ];
  for (const step of script) {
    try {
      await clients[step.side].request("game.action", {
        action: "move",
        from: { row: step.from[0], col: step.from[1] },
        to: { row: step.to[0], col: step.to[1] },
      });
    } catch (err) {
      if (process.env.ANIMAL_DEBUG) console.log(`    [debug] 跳河编排失败 @${step.note}: ${err.code || err.message}`);
      return null;
    }
  }
  // 2. 校验局面：狮在起跳点、红鼠挡在河中、此刻 (2,2)->(6,2) 不在合法落点里。
  const game = await syncBoth(clients);
  if (!game) return null;
  if (JSON.stringify(piecePosition(game, "狮", "blue")) !== JSON.stringify({ row: 2, col: 2 })) return null;
  if (JSON.stringify(piecePosition(game, "鼠", "red")) !== JSON.stringify({ row: 5, col: 2 })) return null;
  const lion = game.pieces.find((p) => p.alive && p.owner === "blue" && p.name === "狮");
  const jumpAllowed = rules.legalTargets(game.pieces, lion).some((t) => t.row === 6 && t.col === 2);
  if (jumpAllowed) return null;
  // 3. 返回用例主体需要的场景描述。
  return {
    jump: {
      side: "blue",
      piece: { name: "狮", owner: "blue" },
      from: { row: 2, col: 2 },
      to: { row: 6, col: 2 },
      blockerSide: "red",
      blockerFrom: { row: 5, col: 2 },
      blockerTo: { row: 5, col: 1 },
    },
  };
}
/** 从快照里取某个棋子的位置，取不到返回 null。 */
function piecePosition(game, name, owner) {
  const piece = game.pieces.find((p) => p.alive && p.name === name && p.owner === owner);
  return piece ? { row: piece.row, col: piece.col } : null;
}

/** 从快照里取某格的棋子名，空格返回 ""。 */
function pieceNameAt(game, row, col) {
  const piece = game.pieces.find((p) => p.alive && p.row === row && p.col === col);
  return piece ? `${piece.owner}:${piece.name}` : "";
}

/** 比较两个客户端看到的对局状态是否一致。 */
function sameGame(a, b) {
  const pick = (g) => JSON.stringify({
    pieces: g.pieces.map((p) => `${p.owner}:${p.name}:${p.row}:${p.col}:${p.alive}`).sort(),
    turn: g.turn,
    started: g.started,
    over: g.over,
    winner: g.winner,
    moveCount: g.moveCount,
  });
  return { equal: pick(a) === pick(b), left: pick(a), right: pick(b) };
}

(async () => {
  // 1. 未注入 BASE_URL 时自行拉起被测服务器。
  if (!EXTERNAL_BASE) {
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(SELF_PORT), BIND_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => {
      serverLogs.push(chunk.toString());
      if (serverLogs.length > 200) serverLogs.shift();
    };
    serverProcess.stdout.on("data", collect);
    serverProcess.stderr.on("data", collect);
  }
  await waitForServer();

  /**
   * 开一局全新的斗兽棋：两个客户端各自建房/加入，返回房间与凭据。
   *
   * 每个用例都从干净房间开始，避免排列组合带来的状态耦合（也让失败定位更直接）。
   *
   * @param {string} hostName - 房主昵称。
   * @param {string} guestName - 加入者昵称。
   * @returns {Promise<{roomId: string, host: object, guest: object, a: object, b: object}>} 房间上下文。
   */
  async function freshRoom(hostName, guestName) {
    const a = makeClient(`A-${hostName}`);
    const b = makeClient(`B-${guestName}`);
    await Promise.all([a.open, b.open]);
    const host = await a.request("room.create", { gameType: "animal-chess", prefix: "DS", nickname: hostName });
    const guest = await b.request("room.join", { roomId: host.roomId, nickname: guestName, gameType: "animal-chess" });
    await a.waitUntil(() => a.lastGame()?.started === true, "房主看到开局");
    await b.waitUntil(() => b.lastGame()?.started === true, "加入者看到开局");
    await syncBoth({ red: a, blue: b });
    return { roomId: host.roomId, host, guest, a, b };
  }

  // ── 房间与开局 ──────────────────────────────────────────────
  const main = await freshRoom("红方甲", "蓝方乙");
  const A = main.a;
  const B = main.b;
  const roomId = main.roomId;
  const redCreds = main.host;
  const blueCreds = main.guest;

  await check("创建斗兽棋房间：房间码 DS 前缀、gameType=animal-chess、房主执红", async () => {
    assert(/^DS[A-Z0-9]{6}$/.test(roomId), `房间码应为 DS+6 位，实际 ${roomId}`);
    assertEq(redCreds.snapshot.room.gameType, "animal-chess", "房间类型");
    assertEq(redCreds.role, "host", "创建者角色");
    assertEq(redCreds.snapshot.game.players.red, "红方甲", "红方昵称");
    assertEq(redCreds.snapshot.game.started, false, "单人时未开局");
    assertEq(redCreds.snapshot.game.pieces.length, 16, "初始 16 子");
    assertEq(redCreds.snapshot.game.sidePlayerIds.red, redCreds.playerId, "座位映射");
    assertEq(redCreds.snapshot.game.sidePlayerIds.blue, null, "蓝方座位为空");
  });

  await check("第二玩家加入即自动开局，双方拿到同一份权威快照", async () => {
    assertEq(blueCreds.snapshot.game.started, true, "两人到齐自动开局");
    assertEq(blueCreds.snapshot.game.turn, "red", "红方先手");
    assertEq(blueCreds.snapshot.game.sidePlayerIds.blue, blueCreds.playerId, "加入者执蓝");
    assertEq(blueCreds.snapshot.game.players.blue, "蓝方乙", "蓝方昵称");
    const rooms = await syncBoth({ red: A, blue: B });
    assert(rooms, "双方快照未能同步");
    const diff = sameGame(A.lastGame(), B.lastGame());
    assert(diff.equal, `开局时双方状态应一致：${diff.left} vs ${diff.right}`);
  });

  await check("房间成员变化实时推送：房主不刷新也能看到对手", async () => {
    // 房主侧的 room 快照必须包含两名成员，且加入事件带房间码。
    const snapshot = A.received.filter((m) => m.type === "room.snapshot").pop();
    assert(snapshot, "房主应收到 room.snapshot");
    assertEq(snapshot.payload.snapshot.room.roomId, roomId, "快照携带 roomId");
    const names = snapshot.payload.snapshot.room.players.map((p) => p.nickname);
    assertEq(names, ["红方甲", "蓝方乙"], "房主侧成员列表");
    assertEq(snapshot.payload.snapshot.room.players.filter((p) => p.connected).length, 2, "两名成员都在线");
  });

  // ── 合法走子与双方同步 ─────────────────────────────────────
  await check("红方走子：服务器推进状态并向双方广播同一快照", async () => {
    const res = await A.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
    assertEq(res.snapshot.game.moveCount, 1, "走子计数");
    assertEq(piecePosition(res.snapshot.game, "鼠", "red"), { row: 5, col: 0 }, "红鼠新位置");
    assertEq(res.snapshot.game.turn, "blue", "轮到蓝方");
    await B.waitUntil(() => B.lastGame()?.moveCount === 1, "蓝方收到走子快照");
    const diff = sameGame(res.snapshot.game, B.lastGame());
    assert(diff.equal, `走子后双方状态应一致：${diff.left} vs ${diff.right}`);
  });

  await check("蓝方走子：房主侧同样实时同步", async () => {
    const res = await B.request("game.action", { action: "move", from: { row: 2, col: 6 }, to: { row: 3, col: 6 } });
    assertEq(res.snapshot.game.moveCount, 2, "走子计数");
    assertEq(piecePosition(res.snapshot.game, "鼠", "blue"), { row: 3, col: 6 }, "蓝鼠新位置");
    assertEq(res.snapshot.game.turn, "red", "轮到红方");
    await A.waitUntil(() => A.lastGame()?.moveCount === 2, "红方收到走子快照");
    const diff = sameGame(res.snapshot.game, A.lastGame());
    assert(diff.equal, `走子后双方状态应一致：${diff.left} vs ${diff.right}`);
  });

  // ── 非法操作 ────────────────────────────────────────────────
  await check("非本方回合走子被拒，棋盘不变", async () => {
    const before = JSON.stringify(A.lastGame().pieces);
    try {
      await B.request("game.action", { action: "move", from: { row: 3, col: 6 }, to: { row: 4, col: 6 } });
      throw new Error("非本方回合不应被接受");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_TURN", "错误码");
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
    assertEq(JSON.stringify(A.lastGame().pieces), before, "棋盘未变化");
    assertEq(A.lastGame().moveCount, 2, "走子计数未变化");
  });

  await check("移动对方棋子被拒（NOT_YOUR_PIECE）", async () => {
    try {
      await A.request("game.action", { action: "move", from: { row: 3, col: 6 }, to: { row: 4, col: 6 } });
      throw new Error("不应允许移动对方棋子");
    } catch (err) {
      assertEq(err.code, "NOT_YOUR_PIECE", "错误码");
    }
    assertEq(A.lastGame().moveCount, 2, "走子计数未变化");
  });

  await check("非法目标格被拒（ILLEGAL_MOVE_TARGET）", async () => {
    try {
      await A.request("game.action", { action: "move", from: { row: 5, col: 0 }, to: { row: 5, col: 3 } });
      throw new Error("不应允许非法目标");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "错误码");
    }
    assertEq(piecePosition(A.lastGame(), "鼠", "red"), { row: 5, col: 0 }, "红鼠未移动");
  });

  await check("坐标越界被拒（INVALID_MOVE）", async () => {
    try {
      await A.request("game.action", { action: "move", from: { row: 99, col: 0 }, to: { row: 5, col: 1 } });
      throw new Error("越界坐标不应被接受");
    } catch (err) {
      assertEq(err.code, "INVALID_MOVE", "错误码");
    }
    try {
      await A.request("game.action", { action: "move", from: { row: 5, col: 0 }, to: { row: 5, col: 99 } });
      throw new Error("越界目标不应被接受");
    } catch (err) {
      assertEq(err.code, "INVALID_MOVE", "错误码（终点越界）");
    }
  });

  await check("未知动作被拒（INVALID_ACTION），不能提交完整棋盘", async () => {
    try {
      await A.request("game.action", { action: "set_state", board: [], winner: "red", currentTurn: "blue" });
      throw new Error("未知动作不应被接受");
    } catch (err) {
      assertEq(err.code, "INVALID_ACTION", "错误码");
    }
    assertEq(A.lastGame().winner, "", "胜负未被客户端改写");
    assertEq(A.lastGame().moveCount, 2, "走子计数未变化");
  });

  await check("relay 转发在权威斗兽棋房被拒（INVALID_ACTION）", async () => {
    const relayResult = await Promise.resolve(
      A.ws.send(JSON.stringify({ version: 1, type: "relay.send", payload: { event: "state", data: { hacked: true } } })),
    ).then(() => null, (err) => err);
    assert(relayResult === null, `relay.send 发送异常：${relayResult && relayResult.message}`);
    await A.waitUntil(() => A.received.some((m) => m.type === "room.error" && m.payload.code === "INVALID_ACTION"), "服务器拒绝 relay.send");
    assertEq(A.lastGame().moveCount, 2, "relay 被拒不影响对局状态");
  });

  await check("游戏尚未开始（单人房）时走子被拒", async () => {
    const solo = makeClient("solo");
    await solo.open;
    const created = await solo.request("room.create", { gameType: "animal-chess", prefix: "DS", nickname: "独狼" });
    assertEq(created.snapshot.game.started, false, "单人房未开局");
    try {
      await solo.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
      throw new Error("未开局不应允许走子");
    } catch (err) {
      assertEq(err.code, "GAME_NOT_STARTED", "错误码");
    }
    solo.close();
  });

  // ── 重新开局（独立房间，保证干净局面）──────────────────────
  await check("重新开局：清盘、红方先手、座位与昵称保留", async () => {
    const room = await freshRoom("重开甲", "重开乙");
    await room.a.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
    await room.b.request("game.action", { action: "move", from: { row: 2, col: 6 }, to: { row: 3, col: 6 } });
    const res = await room.a.request("game.action", { action: "restart" });
    await room.b.waitUntil(() => room.b.lastGame()?.moveCount === 0, "加入者收到重开快照");
    const game = res.snapshot.game;
    assertEq(game.moveCount, 0, "走子记录清空");
    assertEq(game.moves.length, 0, "moves 清空");
    assertEq(game.turn, "red", "红方先手");
    assertEq(game.started, true, "仍在开局状态");
    assertEq(game.over, false, "未结束");
    assertEq(game.winner, "", "无胜方");
    assertEq(game.players.red, "重开甲", "红方昵称保留");
    assertEq(game.players.blue, "重开乙", "蓝方昵称保留");
    assertEq(game.pieces.filter((p) => p.alive).length, 16, "16 子全部复活");
    const diff = sameGame(game, room.b.lastGame());
    assert(diff.equal, `重开后双方状态应一致：${diff.left} vs ${diff.right}`);
    room.a.close();
    room.b.close();
  });

  // ── 胜负（独立房间 + 纯规则推演）───────────────────────────
  await check("进入敌方兽穴：服务端判定胜负，双方拿到同一结果", async () => {
    const room = await freshRoom("胜方甲", "负方乙");
    const clients = { red: room.a, blue: room.b };
    const catStall = { name: "猫", owner: "blue" };
    // 红虎先走到蓝方兽穴隔壁的 (1,3)（该格邻接兽穴，且经规则模块核对可从初始局面到达）。
    const parked = await driveWithStall({
      clients,
      side: "red",
      spec: { name: "虎", owner: "red" },
      goal: { row: 1, col: 3 },
      stallSpec: catStall,
      stallPair: [[1, 1], [1, 0]],
    });
    assert(parked, `红虎未能走到 (1,3)：${JSON.stringify(piecePosition(room.a.lastGame(), "虎", "red"))}`);
    assertEq(piecePosition(parked, "虎", "red"), { row: 1, col: 3 }, "红虎就位 (1,3)");
    // 把轮次对齐到红方后再进穴（对齐只让垫步棋子走，不影响 (1,3) 的红虎）。
    const aligned = await alignTurnTo({ clients, side: "red", stallSpec: catStall, stallPair: [[1, 1], [1, 0]] });
    assert(aligned, "轮次未能对齐到红方");
    const before = await syncBoth({ red: room.a, blue: room.b });
    assertEq(sideForMoveCount(before.moveCount), "red", "轮到红方进穴");
    assertEq(before.over, false, "对局尚未结束");
    const entered = await room.a.request("game.action", { action: "move", from: { row: 1, col: 3 }, to: { row: 0, col: 3 } });
    assertEq(entered.snapshot.game.over, true, "服务端判定对局结束");
    assertEq(entered.snapshot.game.winner, "red", "红方获胜");
    await room.b.waitUntil(() => room.b.lastGame()?.over === true, "蓝方收到结束快照");
    assertEq(room.b.lastGame().winner, "red", "蓝方侧胜方一致");
    const diff = sameGame(entered.snapshot.game, room.b.lastGame());
    assert(diff.equal, `终局双方状态应一致：${diff.left} vs ${diff.right}`);
    // 结束后再走子必须继续被拒。
    try {
      await room.b.request("game.action", { action: "move", from: { row: 1, col: 1 }, to: { row: 1, col: 0 } });
      throw new Error("已结束的对局不应允许继续走子");
    } catch (err) {
      assertEq(err.code, "GAME_ALREADY_FINISHED", "错误码");
    }
    room.a.close();
    room.b.close();
  });

  // ── 特殊规则（独立房间）───────────────────────────────────
  await check("河流：只有鼠能进河，其他棋子被拒", async () => {
    const room = await freshRoom("河甲", "河乙");
    const dog = piecePosition(room.a.lastGame(), "狗", "red");
    assert(dog, "红狗在场");
    // 红狗 (7,1) -> (6,1)（陆地，合法）。
    await room.a.request("game.action", { action: "move", from: { row: 7, col: 1 }, to: { row: 6, col: 1 } });
    await room.b.request("game.action", { action: "move", from: { row: 1, col: 1 }, to: { row: 1, col: 0 } });
    // (6,1) 向上是河道 (5,1)：狗不能进河。
    try {
      await room.a.request("game.action", { action: "move", from: { row: 6, col: 1 }, to: { row: 5, col: 1 } });
      throw new Error("狗不应能进河");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "狗进河被拒");
    }
    assertEq(piecePosition(room.a.lastGame(), "狗", "red"), { row: 6, col: 1 }, "红狗未移动");
    // 红鼠 (6,0) -> (5,0) 进河应合法（此时轮到红方）。
    const res = await room.a.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
    assertEq(piecePosition(res.snapshot.game, "鼠", "red"), { row: 5, col: 0 }, "鼠已进入河道");
    assertEq(res.snapshot.game.turn, "blue", "轮到蓝方");
    room.a.close();
    room.b.close();
  });

  await check("狮/虎跳河：河中的鼠挡住跳跃，移开后同一跳合法", async () => {
    const room = await freshRoom("跳甲", "跳乙");
    const clients = { red: room.a, blue: room.b };
    // 拦截点 (5,1)：从蓝鼠初始位 (2,6) 沿 (3,6)->(4,6)->(5,6)->(5,5)->(5,4)->(5,3)->(5,2)->(5,1) 可达。
    const setup = await buildJumpSetup(clients);
    assert(setup, "未能编排出一条完整的跳河场景");
    const { jump } = setup;
    // 1. 河中有鼠：同一跳必须被拒，且棋盘不变。
    const before = await syncBoth({ red: room.a, blue: room.b });
    assertEq(sideForMoveCount(before.moveCount), jump.side, `应轮到${jump.side}跳河`);
    assertEq(piecePosition(before, jump.piece.name, jump.side), jump.from, "跳跃棋子就位");
    const snapshotBefore = JSON.stringify(before.pieces);
    const jumperClient = jump.side === "red" ? room.a : room.b;
    const blockerClient = jump.blockerSide === "red" ? room.a : room.b;
    try {
      await jumperClient.request("game.action", { action: "move", from: jump.from, to: jump.to });
      throw new Error("河中有鼠时不应允许跳河");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "被河中的鼠挡住");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEq(JSON.stringify(jumperClient.lastGame().pieces), snapshotBefore, "被拒后棋盘未变化");
    // 2. 跳跃方用一颗"非跳跃棋子"走一步过招（不能动狮/虎本体，否则起跳点就没了）。
    const passMove = findPassMove(before, jump.side, jump.piece.name);
    assert(passMove, `${jump.side}方需要一步不移动跳跃棋子的过招走法`);
    await jumperClient.request("game.action", { action: "move", from: passMove.from, to: passMove.to });
    // 3. 挡路的鼠离开跳跃路径（红鼠从 (5,2) 退到 (5,1)，仍在河里但不在跳跃线上）。
    await blockerClient.request("game.action", { action: "move", from: jump.blockerFrom, to: jump.blockerTo });
    // 4. 同一跳必须合法（证明拦截来自"河中的鼠"）。
    const jumped = await jumperClient.request("game.action", { action: "move", from: jump.from, to: jump.to });
    assertEq(piecePosition(jumped.snapshot.game, jump.piece.name, jump.side), jump.to, "跳跃成功");
    assertEq(jumped.snapshot.game.moves.at(-1).name, jump.piece.name, "走子记录为跳跃棋子");
    await blockerClient.waitUntil(() => blockerClient.lastGame()?.moveCount === jumped.snapshot.game.moveCount, "对端收到跳河快照");
    const diff = sameGame(jumped.snapshot.game, blockerClient.lastGame());
    assert(diff.equal, `跳河后双方状态应一致：${diff.left} vs ${diff.right}`);
    room.a.close();
    room.b.close();
  });
  await check("陷阱降级：走进敌方陷阱的棋子会被低等级棋子吃掉", async () => {
    const room = await freshRoom("陷甲", "陷乙");
    const clients = { red: room.a, blue: room.b };
    const catStall = { name: "猫", owner: "blue" };
    // 1. 先把蓝狮走到 (1,2)（此时陷阱还空着，狮子的路径不会顺手吃掉任何目标）。
    const lionNear = await driveWithStall({
      clients,
      side: "blue",
      spec: { name: "狮", owner: "blue" },
      goal: { row: 1, col: 2 },
      stallSpec: { name: "狼", owner: "red" },
      stallPair: [[6, 4], [6, 3]],
    });
    assert(lionNear, `蓝狮未能走到 (1,2)：${JSON.stringify(piecePosition(room.a.lastGame(), "狮", "blue"))}`);
    assertEq(piecePosition(lionNear, "狮", "blue"), { row: 1, col: 2 }, "蓝狮在 (1,2)");
    // 2. 红猫再走进蓝方陷阱 (1,3)（紧邻蓝方兽穴，从 (2,3) 方向进入不会途经兽穴）。
    const catInTrap = await driveWithStall({
      clients,
      side: "red",
      spec: { name: "猫", owner: "red" },
      goal: { row: 1, col: 3 },
      stallSpec: { name: "狗", owner: "blue" },
      stallPair: [[1, 5], [1, 4]],
    });
    assert(catInTrap, `红猫未能走进蓝方陷阱 (1,3)：${JSON.stringify(piecePosition(room.a.lastGame(), "猫", "red"))}`);
    assertEq(piecePosition(catInTrap, "猫", "red"), { row: 1, col: 3 }, "红猫站在蓝方陷阱里");
    assertEq(catInTrap.over, false, "走进陷阱不应结束对局");
    assertEq(piecePosition(catInTrap, "狮", "blue"), { row: 1, col: 2 }, "蓝狮仍在 (1,2)");
    // 3. 蓝狮吃掉陷阱里的红猫：陷阱内防守方等级按 0 计，狮（7）可吃猫（2）。
    const aligned = await alignTurnTo({ clients, side: "blue", stallSpec: catStall, stallPair: [[1, 1], [1, 0]] });
    assert(aligned, "轮次未能对齐到蓝方");
    const before = await syncBoth({ red: room.a, blue: room.b });
    assertEq(sideForMoveCount(before.moveCount), "blue", "轮到蓝方吃子");
    assertEq(piecePosition(before, "猫", "red"), { row: 1, col: 3 }, "红猫仍在陷阱里");
    const res = await room.b.request("game.action", { action: "move", from: { row: 1, col: 2 }, to: { row: 1, col: 3 } });
    assertEq(piecePosition(res.snapshot.game, "猫", "red"), null, "红猫已被吃掉");
    assertEq(piecePosition(res.snapshot.game, "狮", "blue"), { row: 1, col: 3 }, "蓝狮占位");
    assertEq(res.snapshot.game.moves.at(-1).capture, "猫", "走子记录标记吃子");
    // 4. 双方状态一致。
    await room.a.waitUntil(() => room.a.lastGame()?.moveCount === res.snapshot.game.moveCount, "房主收到吃子快照");
    const diff = sameGame(res.snapshot.game, room.a.lastGame());
    assert(diff.equal, `吃子后双方状态应一致：${diff.left} vs ${diff.right}`);
    room.a.close();
    room.b.close();
  });

  await check("鼠吃象特例：象不能吃鼠，鼠可以吃象", async () => {
    const room = await freshRoom("鼠甲", "象乙");
    const clients = { red: room.a, blue: room.b };
    const dogStall = { name: "狗", owner: "red" };
    // 1. 红鼠走到 (4,0)。
    const ratReady = await driveWithStall({
      clients,
      side: "red",
      spec: { name: "鼠", owner: "red" },
      goal: { row: 4, col: 0 },
      stallSpec: { name: "狼", owner: "blue" },
      stallPair: [[2, 2], [3, 2]],
    });
    assert(ratReady, `红鼠未能走到 (4,0)：${JSON.stringify(piecePosition(room.a.lastGame(), "鼠", "red"))}`);
    assertEq(piecePosition(ratReady, "鼠", "red"), { row: 4, col: 0 }, "红鼠在 (4,0)");
    // 2. 蓝象走到 (3,0)，与红鼠相邻。
    const elephantReady = await driveWithStall({
      clients,
      side: "blue",
      spec: { name: "象", owner: "blue" },
      goal: { row: 3, col: 0 },
      stallSpec: dogStall,
      stallPair: [[6, 1], [7, 1]],
    });
    assert(elephantReady, `蓝象未能走到 (3,0)：${JSON.stringify(piecePosition(room.a.lastGame(), "象", "blue"))}`);
    assertEq(piecePosition(elephantReady, "象", "blue"), { row: 3, col: 0 }, "蓝象在 (3,0)");
    // 3. 轮到蓝方：象向下吃 (4,0) 的红鼠 -> 必须被拒（象不能吃鼠）。
    const alignedBlue = await alignTurnTo({ clients, side: "blue", stallSpec: dogStall, stallPair: [[6, 1], [7, 1]] });
    assert(alignedBlue, "轮次未能对齐到蓝方");
    const beforeBlocked = await syncBoth({ red: room.a, blue: room.b });
    assertEq(sideForMoveCount(beforeBlocked.moveCount), "blue", "轮到蓝方");
    const frozen = JSON.stringify(beforeBlocked.pieces);
    try {
      await room.b.request("game.action", { action: "move", from: { row: 3, col: 0 }, to: { row: 4, col: 0 } });
      throw new Error("象不应能吃鼠");
    } catch (err) {
      assertEq(err.code, "ILLEGAL_MOVE_TARGET", "象吃鼠被拒");
    }
    await new Promise((resolve) => setTimeout(resolve, 200));
    assertEq(JSON.stringify(room.b.lastGame().pieces), frozen, "被拒后棋盘未变化");
    // 4. 蓝方用一颗"非象棋子"走一步过招（象必须留在 (3,0) 当靶子），红鼠反吃蓝象。
    const bluePass = findPassMove(beforeBlocked, "blue", "象");
    assert(bluePass, "蓝方需要一步不移动象的过招走法");
    await room.b.request("game.action", { action: "move", from: bluePass.from, to: bluePass.to });
    const res = await room.a.request("game.action", { action: "move", from: { row: 4, col: 0 }, to: { row: 3, col: 0 } });
    assertEq(piecePosition(res.snapshot.game, "象", "blue"), null, "蓝象已被鼠吃掉");
    assertEq(piecePosition(res.snapshot.game, "鼠", "red"), { row: 3, col: 0 }, "红鼠占位");
    assertEq(res.snapshot.game.moves.at(-1).capture, "象", "走子记录标记吃子");
    room.a.close();
    room.b.close();
  });

  // ── 刷新恢复（重连）与离开 ─────────────────────────────────
  await check("刷新恢复：重连后拿到当前 GameState，不重新开局、不产生第三个玩家", async () => {
    const room = await freshRoom("刷甲", "刷乙");
    await room.a.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
    await room.b.request("game.action", { action: "move", from: { row: 2, col: 6 }, to: { row: 3, col: 6 } });
    const beforeReload = await syncBoth({ red: room.a, blue: room.b });
    // 模拟浏览器刷新：旧连接断开，新连接凭凭据重连。
    room.b.terminate();
    await room.a.waitUntil(() => {
      const players = room.a.received.filter((m) => m.payload?.snapshot?.room).pop()?.payload.snapshot.room.players;
      return Boolean(players && players.length === 2 && players.some((p) => !p.connected));
    }, "房主看到对手掉线");
    const b2 = makeClient("B2-reload");
    await b2.open;
    const res = await b2.request("room.reconnect", {
      roomId: room.roomId,
      playerId: room.guest.playerId,
      reconnectToken: room.guest.reconnectToken,
    });
    assertEq(res.snapshot.game.moveCount, 2, "重连后走子记录保持");
    assertEq(piecePosition(res.snapshot.game, "鼠", "red"), { row: 5, col: 0 }, "红鼠位置保持");
    assertEq(piecePosition(res.snapshot.game, "鼠", "blue"), { row: 3, col: 6 }, "蓝鼠位置保持");
    assertEq(res.snapshot.game.started, true, "重连不重新开局");
    assertEq(res.snapshot.room.players.length, 2, "不产生第三个玩家");
    const diff = sameGame(res.snapshot.game, beforeReload);
    assert(diff.equal, `重连后棋盘应与刷新前一致：${diff.left} vs ${diff.right}`);
    // 重连后还能继续走子。
    const a2 = room.a;
    await a2.waitUntil(() => a2.lastGame()?.moveCount === 2, "房主追平");
    await a2.request("game.action", { action: "move", from: { row: 5, col: 0 }, to: { row: 4, col: 0 } });
    await b2.waitUntil(() => b2.lastGame()?.moveCount === 3, "重连者收到新走子");
    assertEq(piecePosition(b2.lastGame(), "鼠", "red"), { row: 4, col: 0 }, "红鼠已继续移动");
    b2.close();
    room.a.close();
  });

  await check("玩家离开后房间回到等待状态且不能继续走子", async () => {
    const room = await freshRoom("离甲", "离乙");
    await room.b.request("room.leave");
    await room.a.waitUntil(() => room.a.lastGame()?.started === false, "房主收到回到等待状态的快照");
    const game = room.a.lastGame();
    assertEq(game.players.blue, "等待", "蓝方座位已释放");
    try {
      await room.a.request("game.action", { action: "move", from: { row: 6, col: 0 }, to: { row: 5, col: 0 } });
      throw new Error("未开局不应允许走子");
    } catch (err) {
      assertEq(err.code, "GAME_NOT_STARTED", "错误码");
    }
    room.a.close();
    room.b.close();
  });

  // ── 收尾 ────────────────────────────────────────────────────
  A.close();
  B.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("animal-chess-dual bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});