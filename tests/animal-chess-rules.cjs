/**
 * 斗兽棋规则单元测试（纯函数，不需要服务器与浏览器）。
 *
 * 覆盖服务端最终裁决用到的全部规则分支：
 *   棋盘/地形、初始布局、等级吃子、鼠吃象与象不能吃鼠、陷阱降级、河流通行、
 *   狮虎跳河（含"河里有鼠不能跳"）、己方兽穴不可进入、进敌方兽穴获胜、
 *   吃光对手获胜、非法走法分类（越权/非己方棋子/非法目标/未开局/已结束）。
 *
 * 运行方式：node tests/animal-chess-rules.cjs
 */
"use strict";

const path = require("path");
const rules = require(path.join(__dirname, "..", "animal-chess-rules"));

/** 用例结果收集。 */
const results = [];

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
 * 执行一条用例（失败不中断后续）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 同步用例体。
 */
function check(name, fn) {
  try {
    fn();
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
 * 断言相等。
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
 * 造一个只含指定棋子的棋盘（用于精确验证单条规则）。
 *
 * @param {Array<Array>} specs - [[owner, name, row, col], ...]。
 * @returns {Array<object>} 棋子列表。
 */
function board(specs) {
  return specs.map(([owner, name, row, col]) => ({
    id: `${owner}-${name}-${row}-${col}`,
    owner,
    name,
    rank: rules.RANKS[name],
    row,
    col,
    alive: true,
  }));
}

/**
 * 走法是否被判为合法（用服务端同一入口 validateMove）。
 *
 * @param {Array<object>} pieces - 棋子列表。
 * @param {string} side - 发起方阵营。
 * @param {number[]} from - [row, col]。
 * @param {number[]} to - [row, col]。
 * @param {object} [extra] - 覆盖 started/over/turn。
 * @returns {object} validateMove 的结果。
 */
function tryMove(pieces, side, from, to, extra) {
  return rules.validateMove(pieces, {
    side,
    from: { row: from[0], col: from[1] },
    to: { row: to[0], col: to[1] },
    started: true,
    over: false,
    turn: side,
    ...(extra || {}),
  });
}

// ── 棋盘与地形 ────────────────────────────────────────────────
check("棋盘尺寸为 9 行 7 列", () => {
  assertEq(rules.ROWS, 9, "行数");
  assertEq(rules.COLS, 7, "列数");
});

check("地形：兽穴、陷阱、河流位置正确", () => {
  assertEq(rules.terrainAt(0, 3), "blue-den", "蓝方兽穴");
  assertEq(rules.terrainAt(8, 3), "red-den", "红方兽穴");
  assertEq(rules.terrainAt(0, 2), "blue-trap", "蓝方陷阱 1");
  assertEq(rules.terrainAt(0, 4), "blue-trap", "蓝方陷阱 2");
  assertEq(rules.terrainAt(1, 3), "blue-trap", "蓝方陷阱 3");
  assertEq(rules.terrainAt(7, 3), "red-trap", "红方陷阱 1");
  assertEq(rules.terrainAt(8, 2), "red-trap", "红方陷阱 2");
  assertEq(rules.terrainAt(8, 4), "red-trap", "红方陷阱 3");
  assertEq(rules.terrainAt(4, 1), "river", "河道");
  assertEq(rules.terrainAt(4, 3), "land", "河道中央是陆地（不能走）");
  assertEq(rules.terrainAt(4, 0), "land", "河道外侧是陆地");
});

check("初始布局：双方各 8 子，等级与坐标与改造前一致", () => {
  const pieces = rules.createInitialPieces();
  assertEq(pieces.length, 16, "棋子总数");
  assertEq(rules.aliveCount(pieces, "red"), 8, "红方子数");
  assertEq(rules.aliveCount(pieces, "blue"), 8, "蓝方子数");
  const redRat = pieces.find((p) => p.owner === "red" && p.name === "鼠");
  assertEq([redRat.row, redRat.col], [6, 0], "红鼠初始坐标");
  assertEq(redRat.rank, 1, "鼠等级");
  const blueElephant = pieces.find((p) => p.owner === "blue" && p.name === "象");
  assertEq([blueElephant.row, blueElephant.col], [2, 0], "蓝象初始坐标");
  assertEq(blueElephant.rank, 8, "象等级");
});

// ── 基础移动与吃子 ────────────────────────────────────────────
check("普通一步移动合法，斜向/跳格移动非法", () => {
  const pieces = board([["red", "狗", 6, 3], ["blue", "猫", 0, 6]]);
  assert(tryMove(pieces, "red", [6, 3], [5, 3]).ok, "上一步应合法");
  assertEq(tryMove(pieces, "red", [6, 3], [5, 4]).reason, rules.MoveRejection.ILLEGAL_TARGET, "斜向非法");
  assertEq(tryMove(pieces, "red", [6, 3], [4, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "跳格非法");
});

check("等级吃子：高吃低合法，平级合法，低吃高非法", () => {
  const high = board([["red", "狮", 6, 3], ["blue", "狗", 6, 4]]);
  assert(tryMove(high, "red", [6, 3], [6, 4]).ok, "狮吃狗");

  const equal = board([["red", "狼", 6, 3], ["blue", "狼", 6, 4]]);
  assert(tryMove(equal, "red", [6, 3], [6, 4]).ok, "同级可互吃");

  const low = board([["red", "猫", 6, 3], ["blue", "狮", 6, 4]]);
  assertEq(tryMove(low, "red", [6, 3], [6, 4]).reason, rules.MoveRejection.ILLEGAL_TARGET, "猫不能吃狮");
});

check("鼠吃象特例与象不能吃鼠", () => {
  const ratVsElephant = board([["red", "鼠", 6, 3], ["blue", "象", 6, 4]]);
  assert(tryMove(ratVsElephant, "red", [6, 3], [6, 4]).ok, "鼠可吃象");

  const elephantVsRat = board([["red", "象", 6, 3], ["blue", "鼠", 6, 4]]);
  assertEq(tryMove(elephantVsRat, "red", [6, 3], [6, 4]).reason, rules.MoveRejection.ILLEGAL_TARGET, "象不能吃鼠");
});

check("陷阱降级：站进敌方陷阱的棋子可被任意等级吃", () => {
  // 蓝方陷阱在 (1,3)；红方狮子站进去后，红方猫也能吃它。
  const pieces = board([["red", "猫", 1, 2], ["blue", "狮", 1, 3]]);
  assert(tryMove(pieces, "red", [1, 2], [1, 3]).ok, "猫吃陷阱里的狮");
});

check("己方陷阱不降级（只有敌方陷阱才归零）", () => {
  // 红方陷阱在 (7,3)：红方自己的棋子站进去不吃亏。
  const pieces = board([["red", "猫", 7, 2], ["blue", "狮", 7, 3]]);
  assertEq(tryMove(pieces, "red", [7, 2], [7, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "红方陷阱内的蓝狮仍按原等级");
});

// ── 河流 ─────────────────────────────────────────────────────
check("只有鼠能进河，其他棋子不能进河", () => {
  const dog = board([["red", "狗", 4, 0], ["blue", "猫", 0, 6]]);
  assertEq(tryMove(dog, "red", [4, 0], [4, 1]).reason, rules.MoveRejection.ILLEGAL_TARGET, "狗不能进河");

  const rat = board([["red", "鼠", 4, 0], ["blue", "猫", 0, 6]]);
  assert(tryMove(rat, "red", [4, 0], [4, 1]).ok, "鼠可以进河");
});

check("河里的鼠可以自由进出（含横穿河道）", () => {
  const pieces = board([["red", "鼠", 4, 1], ["blue", "猫", 0, 6]]);
  assert(tryMove(pieces, "red", [4, 1], [4, 2]).ok, "河内横移");
  assert(tryMove(pieces, "red", [4, 1], [5, 1]).ok, "河内下移");
  assert(tryMove(pieces, "red", [4, 1], [3, 1]).ok, "河内上移");
});

// ── 狮虎跳河 ─────────────────────────────────────────────────
check("虎/狮可以横向跳过河面", () => {
  // 红虎在 (4,0)，河道在 (4,1)(4,2)，对岸 (4,3) 是陆地。
  const pieces = board([["red", "虎", 4, 0], ["blue", "猫", 0, 6]]);
  const verdict = tryMove(pieces, "red", [4, 0], [4, 3]);
  assert(verdict.ok, "虎应能跳河到 (4,3)");
  assertEq(verdict.target, { row: 4, col: 3 }, "落点");
});

check("狮可以纵向跳过河面", () => {
  // 红狮在 (2,5)，河道在 (3,5)(4,5)，对岸 (5,5) 是河，(6,5) 是陆地。
  const pieces = board([["red", "狮", 2, 5], ["blue", "猫", 0, 0]]);
  const verdict = tryMove(pieces, "red", [2, 5], [6, 5]);
  assert(verdict.ok, "狮应能连跳整片河面");
  assertEq(verdict.target, { row: 6, col: 5 }, "落点");
});

check("河里有鼠（任意一方）时虎/狮不能跳", () => {
  const pieces = board([["red", "虎", 4, 0], ["blue", "鼠", 4, 2]]);
  assertEq(tryMove(pieces, "red", [4, 0], [4, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "被河中的鼠挡住");
  // 但鼠只在河里挡跳河，不影响正常一步走。
  assert(tryMove(pieces, "red", [4, 0], [3, 0]).ok, "一步走不受影响");
});

check("虎/狮跳河落点有敌子时按吃子规则判定", () => {
  const eatable = board([["red", "虎", 4, 0], ["blue", "狗", 4, 3]]);
  assert(tryMove(eatable, "red", [4, 0], [4, 3]).ok, "虎跳河吃狗");
  const notEatable = board([["red", "虎", 4, 0], ["blue", "狮", 4, 3]]);
  assertEq(tryMove(notEatable, "red", [4, 0], [4, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "虎不能吃狮");
});

// ── 兽穴 ─────────────────────────────────────────────────────
check("不能进入己方兽穴", () => {
  const pieces = board([["red", "狗", 7, 3], ["blue", "猫", 0, 0]]);
  assertEq(tryMove(pieces, "red", [7, 3], [8, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "红方不能进红穴");
  // 蓝方也不能进蓝穴。
  const blue = board([["blue", "狗", 1, 3], ["red", "猫", 8, 0]]);
  assertEq(tryMove(blue, "blue", [1, 3], [0, 3]).reason, rules.MoveRejection.ILLEGAL_TARGET, "蓝方不能进蓝穴");
});

check("任何棋子都能进入空着的敌方兽穴", () => {
  // 蓝方兽穴 (0,3) 四周被蓝方陷阱包围，所以只有相邻格的棋子能一步踏入。
  // 红方低级棋子（猫）站进蓝方陷阱 (0,2) 后仍可直接进穴。
  const pieces = board([["red", "猫", 0, 2], ["blue", "狮", 8, 6]]);
  const verdict = tryMove(pieces, "red", [0, 2], [0, 3]);
  assert(verdict.ok, "红猫应能从 (0,2) 进蓝穴");
  assertEq(verdict.target, { row: 0, col: 3 }, "落点为蓝方兽穴");
});

// ── 胜负 ─────────────────────────────────────────────────────
check("进敌方兽穴立即获胜", () => {
  const pieces = board([["red", "狗", 1, 3], ["blue", "猫", 8, 6]]);
  const verdict = tryMove(pieces, "red", [1, 3], [0, 3]);
  assert(verdict.ok, "进蓝穴应合法");
  // 模拟服务端推进后判定。
  verdict.piece.row = 0;
  verdict.piece.col = 3;
  const outcome = rules.evaluateOutcome(pieces, "red", { row: 0, col: 3 });
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, "red", "红方获胜");
  assertEq(outcome.reason, "den", "获胜原因");
});

check("吃光对手全部棋子获胜", () => {
  const pieces = board([["red", "狮", 6, 3], ["blue", "猫", 6, 4]]);
  const verdict = tryMove(pieces, "red", [6, 3], [6, 4]);
  assert(verdict.ok, "吃子应合法");
  // 服务端推进：标记被吃棋子死亡并移动。
  verdict.captured.alive = false;
  verdict.piece.row = 6;
  verdict.piece.col = 4;
  const outcome = rules.evaluateOutcome(pieces, "red", { row: 6, col: 4 });
  assertEq(outcome.over, true, "对局结束");
  assertEq(outcome.winner, "red", "红方获胜");
  assertEq(outcome.reason, "wipeout", "获胜原因");
});

check("普通走子不触发胜负", () => {
  const pieces = rules.createInitialPieces();
  const outcome = rules.evaluateOutcome(pieces, "red", { row: 5, col: 0 });
  assertEq(outcome.over, false, "未结束");
  assertEq(outcome.winner, "", "无获胜方");
});

// ── 非法操作分类 ─────────────────────────────────────────────
check("未开局 / 已结束 / 非本方回合都会被拒", () => {
  const pieces = rules.createInitialPieces();
  assertEq(tryMove(pieces, "red", [6, 0], [5, 0], { started: false }).reason, rules.MoveRejection.NOT_STARTED, "未开局");
  assertEq(tryMove(pieces, "red", [6, 0], [5, 0], { over: true }).reason, rules.MoveRejection.FINISHED, "已结束");
  assertEq(tryMove(pieces, "red", [6, 0], [5, 0], { turn: "blue" }).reason, rules.MoveRejection.NOT_YOUR_TURN, "非本方回合");
});

check("坐标越界与类型错误被拒", () => {
  const pieces = rules.createInitialPieces();
  assertEq(tryMove(pieces, "red", [99, 0], [5, 0]).reason, rules.MoveRejection.BAD_FROM, "起点越界");
  assertEq(tryMove(pieces, "red", [6, 0], [5, 99]).reason, rules.MoveRejection.BAD_TO, "终点越界");
  const bad = rules.validateMove(pieces, { side: "red", from: { row: "x", col: 0 }, to: { row: 5, col: 0 }, started: true, over: false, turn: "red" });
  assertEq(bad.reason, rules.MoveRejection.BAD_FROM, "非数字坐标");
});

check("不能移动对方的棋子，也不能从空格起手", () => {
  const pieces = rules.createInitialPieces();
  assertEq(tryMove(pieces, "red", [2, 0], [3, 0]).reason, rules.MoveRejection.NOT_YOUR_PIECE, "红方不能动蓝子");
  assertEq(tryMove(pieces, "red", [4, 3], [4, 4]).reason, rules.MoveRejection.NOT_YOUR_PIECE, "空格起手");
});

check("非法走法不会改动棋子列表（纯函数无副作用）", () => {
  const pieces = rules.createInitialPieces();
  const before = JSON.stringify(pieces);
  tryMove(pieces, "red", [6, 0], [6, 5]);
  tryMove(pieces, "blue", [0, 0], [4, 4]);
  assertEq(JSON.stringify(pieces), before, "棋子列表保持原样");
});

check("legalTargets 汇总一步与跳河两套走法且去重", () => {
  // 红狮 (2,5)：可上/下/左/右，其中向下可跳河到 (6,5)。
  const pieces = board([["red", "狮", 2, 5], ["blue", "猫", 0, 0]]);
  const lion = rules.pieceAt(pieces, 2, 5);
  const targets = rules.legalTargets(pieces, lion);
  const keys = targets.map((t) => `${t.row},${t.col}`);
  assertEq(new Set(keys).size, keys.length, "目标不重复");
  assert(keys.includes("6,5"), `应包含跳河落点 6,5，实际 ${keys.join(" | ")}`);
  assert(keys.includes("1,5"), `应包含上一步，实际 ${keys.join(" | ")}`);
});

// ── 收尾 ─────────────────────────────────────────────────────
const failed = results.filter((r) => !r.pass);
console.log(`\n${results.length - failed.length}/${results.length} passed`);
process.exit(failed.length ? 1 : 0);
