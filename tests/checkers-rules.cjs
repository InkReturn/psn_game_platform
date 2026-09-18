/**
 * 跳棋规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 checkers-rules.js：星形棋盘几何、开局摆子、走法生成（邻走 + 跳跃）、
 * 走法校验的各拒绝原因、推进与胜负判定。规则模块是服务端权威的唯一裁决依据，
 * 因此必须能脱离网络单独验证。
 *
 * 运行方式：node tests/checkers-rules.cjs
 */
"use strict";

const rules = require("../checkers-rules");

/** 用例结果收集。 */
const results = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 */
function record(name, pass) {
  results.push({ name, pass });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}`);
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
 * 执行一条用例并捕获异常。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 用例函数。
 */
function check(name, fn) {
  try {
    fn();
    record(name, true);
  } catch (err) {
    record(name, false);
    console.error(`    ${err.message}`);
  }
}

check("星形棋盘共 121 格且坐标唯一", () => {
  assertEq(rules.STAR_CELLS.length, 121, "格子总数");
  const keys = new Set(rules.STAR_CELLS.map((c) => `${c.row}-${c.index}`));
  assertEq(keys.size, 121, "坐标唯一");
});

check("开局摆子：按人数取前 N 个座位，红在下方、蓝在左方", () => {
  const two = rules.createPieces(2);
  assertEq(two.map((p) => p.color), ["red", "blue"], "两人局颜色");
  const redCell = rules.cellAt(two[0].row, two[0].index);
  assertEq(redCell.region, "bottom", "红方出发区");
  const blueCell = rules.cellAt(two[1].row, two[1].index);
  assertEq(blueCell.region, "left", "蓝方出发区");
  // 目标区域按"对面玩家出发区"修正后：红奔上区、蓝奔右区。
  assertEq(two[0].target, "top", "红方目标区域");
  assertEq(two[1].target, "right", "蓝方目标区域");
});

check("首步合法落点：都是真实空格且不属于出发格", () => {
  const pieces = rules.createPieces(2);
  const targets = rules.legalTargetsFor(pieces, "red");
  assert(targets.length >= 1, "红方首步应有可走格");
  targets.forEach((t) => {
    const cell = rules.cellAt(t.row, t.index);
    assert(cell, `落点 (${t.row},${t.index}) 必须是真实格子`);
    assert(!rules.occupied(pieces, t.row, t.index), "落点必须为空");
  });
});

check("跳跃：相邻格被占时可跳到正对面空格，被占格本身不可落", () => {
  // 1. 程序化找一个三元组：出发格 c、相邻格 n、延长线落点 j。
  let found = null;
  for (const c of rules.STAR_CELLS) {
    for (const n of rules.STAR_CELLS) {
      const dx = n.x - c.x;
      const dy = (n.y - c.y) * 0.88;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist <= 0 || dist > 0.105) continue;
      const j = rules.STAR_CELLS.find((candidate) => {
        const jx = candidate.x - c.x;
        const jy = candidate.y - c.y;
        return Math.abs(jx - (n.x - c.x) * 2) < 0.035 && Math.abs(jy - (n.y - c.y) * 2) < 0.035;
      });
      if (j && !rules.sameCell(j, c) && !rules.sameCell(j, n)) {
        found = { c, n, j };
        break;
      }
    }
    if (found) break;
  }
  assert(found, "应能找到一个跳跃三元组");
  // 2. 空盘（只有红棋在 c、蓝棋垫在 n）：跳跃落点 j 合法，被占的 n 不可落。
  const pieces = [
    { color: "red", row: found.c.row, index: found.c.index, target: "top" },
    { color: "blue", row: found.n.row, index: found.n.index, target: "right" },
  ];
  const targets = rules.moveTargets(pieces, found.c);
  assert(targets.some((t) => t.row === found.j.row && t.index === found.j.index), "跳跃落点应合法");
  assert(!targets.some((t) => t.row === found.n.row && t.index === found.n.index), "被占相邻格不可直接落");
});

check("校验拒绝：未开始 / 已结束 / 非本回合 / 非己棋子 / 坏起点 / 非法目标", () => {
  const pieces = rules.createPieces(2);
  const red = pieces[0];
  const targets = rules.legalTargetsFor(pieces, "red");
  const to = targets[0];
  const base = { pieces, from: { row: red.row, index: red.index }, to };
  // 1. 状态拒绝。
  assertEq(rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: false, over: false }).reason, "NOT_STARTED", "未开始");
  assertEq(rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: true, over: true }).reason, "FINISHED", "已结束");
  // 2. 轮次拒绝。
  assertEq(rules.validateMove({ ...base, moverIndex: 1, turn: 0, started: true, over: false }).reason, "NOT_YOUR_TURN", "非本回合");
  // 3. 起点拒绝。
  assertEq(
    rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: true, over: false, from: { row: pieces[1].row, index: pieces[1].index } }).reason,
    "NOT_YOUR_PIECE",
    "起点是对方棋子",
  );
  assertEq(
    rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: true, over: false, from: { row: 99, index: 99 } }).reason,
    "BAD_FROM",
    "起点不存在",
  );
  // 4. 目标拒绝。
  assertEq(rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: true, over: false, to: { row: 0, index: 0 } }).reason, "ILLEGAL_TARGET", "非法目标");
  // 5. 合法走法通过。
  assert(rules.validateMove({ ...base, moverIndex: 0, turn: 0, started: true, over: false }).ok, "合法走法应通过");
});

check("推进：正常走子换手、入参不被修改", () => {
  const pieces = rules.createPieces(2);
  const from = { row: pieces[0].row, index: pieces[0].index };
  const to = rules.legalTargetsFor(pieces, "red")[0];
  const snapshot = JSON.stringify(pieces);
  const applied = rules.applyMove(pieces, 0, to);
  // 1. 红棋移动到目标格，蓝棋不动。
  assertEq(applied.pieces[0].row === to.row && applied.pieces[0].index === to.index, true, "红棋已移动");
  assertEq(applied.pieces[1].row === pieces[1].row && applied.pieces[1].index === pieces[1].index, true, "蓝棋未动");
  // 2. 未到目标区：不判胜，轮次推进到蓝方。
  assertEq(applied.won, false, "不应判胜");
  assertEq(applied.nextTurn, 1, "轮到蓝方");
  // 3. 入参数组未被修改（纯函数）。
  assertEq(JSON.stringify(pieces), snapshot, "入参未被修改");
});

check("胜负：棋子到达对面出发区即获胜且轮次停在获胜者", () => {
  // 1. 手工构造：红棋紧邻上区（top）的某个格子。
  const topCells = rules.cellsByRegion("top");
  assert(topCells.length >= 2, "上区应有格子");
  // 找一个 top 格子的邻接格作为红棋当前位置。
  let launch = null;
  for (const t of topCells) {
    for (const n of rules.STAR_CELLS) {
      const dx = n.x - t.x;
      const dy = (n.y - t.y) * 0.88;
      const dist = Math.sqrt(dx * dx + dy * dy);
      if (dist > 0 && dist <= 0.105 && n.region !== "top") {
        launch = { piece: n, goal: t };
        break;
      }
    }
    if (launch) break;
  }
  assert(launch, "应能找到进入上区的入口格");
  const pieces = [
    { color: "red", row: launch.piece.row, index: launch.piece.index, target: "top" },
    { color: "blue", row: 13, index: 0, target: "right" },
  ];
  // 2. 红棋走进 top 区：won 为 true，轮次不再推进。
  const applied = rules.applyMove(pieces, 0, { row: launch.goal.row, index: launch.goal.index });
  assertEq(applied.won, true, "到达目标区域应获胜");
  assertEq(applied.nextTurn, 0, "获胜后轮次停在获胜者");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
