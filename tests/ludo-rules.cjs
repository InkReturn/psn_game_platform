/**
 * 飞行棋规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 ludo-rules.js：开局队伍、走法校验的各拒绝原因、起飞/移动/钳制推进、
 * 轮空消耗、胜负判定与纯函数性。规则模块是服务端权威的唯一裁决依据，
 * 因此必须能脱离网络单独验证。
 *
 * 运行方式：node tests/ludo-rules.cjs
 */
"use strict";

const rules = require("../ludo-rules");

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

check("开局队伍：按人数取前 N 支，全部待起飞", () => {
  const two = rules.createTeams(2);
  assertEq(two.map((t) => t.color), ["red", "blue"], "两人局颜色");
  two.forEach((team) => assertEq(team.pieces, [-1, -1], "初始位置"));
  const four = rules.createTeams(4);
  assertEq(four.map((t) => t.color), ["red", "blue", "green", "gold"], "四人局颜色");
});

check("校验拒绝：未开始 / 已结束 / 非本回合 / 未掷骰 / 坏下标", () => {
  const teams = rules.createTeams(2);
  const base = { teams, turn: 0, moverIndex: 0, pieceIndex: 0 };
  // 1. 状态拒绝。
  assertEq(rules.validateMove({ ...base, dice: 3, started: false, over: false }).reason, "NOT_STARTED", "未开始");
  assertEq(rules.validateMove({ ...base, dice: 3, started: true, over: true }).reason, "FINISHED", "已结束");
  // 2. 轮次拒绝。
  assertEq(rules.validateMove({ ...base, moverIndex: 1, dice: 3, started: true, over: false }).reason, "NOT_YOUR_TURN", "非本回合");
  // 3. 骰子拒绝（0 = 未掷）。
  assertEq(rules.validateMove({ ...base, dice: 0, started: true, over: false }).reason, "DICE_NOT_ROLLED", "未掷骰");
  assertEq(rules.validateMove({ ...base, dice: 7, started: true, over: false }).reason, "DICE_NOT_ROLLED", "非法点数");
  // 4. 下标拒绝。
  assertEq(rules.validateMove({ ...base, dice: 3, pieceIndex: 2, started: true, over: false }).reason, "BAD_PIECE", "坏下标");
  assertEq(rules.validateMove({ ...base, dice: 3, pieceIndex: -1, started: true, over: false }).reason, "BAD_PIECE", "负下标");
  // 5. 合法操作通过。
  assert(rules.validateMove({ ...base, dice: 3, started: true, over: false }).ok, "合法走法应通过");
});

check("起飞：掷 6 起飞到航道 0，掷非 6 原地轮空", () => {
  const teams = rules.createTeams(2);
  // 1. 掷 6：起飞。
  const launched = rules.applyMove(teams, 0, 0, 6);
  assertEq(launched.teams[0].pieces[0], 0, "起飞到航道 0");
  assertEq(launched.launched, true, "标记为起飞");
  assertEq(launched.nextTurn, 1, "换手到蓝方");
  assertEq(launched.won, false, "不应判胜");
  // 2. 掷 3：原地轮空（回合仍被消耗）。
  const stalled = rules.applyMove(teams, 0, 1, 3);
  assertEq(stalled.teams[0].pieces[1], -1, "仍待起飞");
  assertEq(stalled.launched, false, "未起飞");
  assertEq(stalled.consumed, false, "未位移");
  assertEq(stalled.nextTurn, 1, "轮空后仍换手");
});

check("移动：按骰点位移，超过终点钳制", () => {
  const teams = rules.createTeams(2);
  teams[0].pieces[0] = 10;
  // 1. 正常位移。
  const moved = rules.applyMove(teams, 0, 0, 5);
  assertEq(moved.teams[0].pieces[0], 15, "10+5=15");
  assertEq(moved.consumed, true, "标记为位移");
  assertEq(moved.nextTurn, 1, "换手");
  // 2. 钳制：20+6=26 超过 24，钳到 24。
  teams[0].pieces[0] = 20;
  const clamped = rules.applyMove(teams, 0, 0, 6);
  assertEq(clamped.teams[0].pieces[0], 24, "钳制到终点");
});

check("胜负：全部到达终点判胜且轮次停在获胜队", () => {
  const teams = rules.createTeams(2);
  teams[0].pieces[0] = 24;
  teams[0].pieces[1] = 22;
  // 1. 最后一架飞到终点：判胜。
  const applied = rules.applyMove(teams, 0, 1, 5);
  assertEq(applied.teams[0].pieces[1], 24, "第二架到达");
  assertEq(applied.won, true, "全部到达判胜");
  assertEq(applied.nextTurn, 0, "轮次停在获胜队");
  // 2. 只有一架到达时不判胜。
  const partial = rules.createTeams(2);
  partial[0].pieces[0] = 24;
  partial[0].pieces[1] = 10;
  const notWon = rules.applyMove(partial, 0, 1, 3);
  assertEq(notWon.won, false, "还有一架未到，不判胜");
});

check("纯函数性：入参队伍数组不被修改", () => {
  const teams = rules.createTeams(2);
  teams[0].pieces[0] = 10;
  const snapshot = JSON.stringify(teams);
  rules.applyMove(teams, 0, 0, 6);
  assertEq(JSON.stringify(teams), snapshot, "入参未被修改");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
