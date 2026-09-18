/**
 * 德州扑克规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 texas-rules.js：牌堆、洗牌、5 张牌评估（含 A-5 轮子顺）、
 * 7 选 5 最优、摊牌平分底池、轮次推进辅助。
 *
 * 运行方式：node tests/texas-rules.cjs
 */
"use strict";

const rules = require("../texas-rules");

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

/** 造牌辅助。 */
const DECK = rules.buildDeck();

/**
 * 按 id 取牌。
 *
 * @param {string} id - 牌 id。
 * @returns {object} 牌对象。
 */
function card(id) {
  const found = DECK.find((item) => item.id === id);
  if (!found) throw new Error(`unknown card ${id}`);
  return found;
}

check("牌堆：52 张，id 唯一", () => {
  assertEq(DECK.length, 52, "张数");
  assertEq(new Set(DECK.map((c) => c.id)).size, 52, "id 唯一");
});

check("洗牌：注入固定随机源结果确定，真随机两次顺序不同", () => {
  const fixed = rules.shuffleDeck(rules.buildDeck(), () => 0);
  assertEq(fixed.length, 52, "张数不变");
  assertEq(new Set(fixed.map((c) => c.id)).size, 52, "无丢失");
  const a = rules.shuffleDeck(rules.buildDeck(), (min, max) => Math.floor(min + Math.random() * (max - min)));
  const b = rules.shuffleDeck(rules.buildDeck(), (min, max) => Math.floor(min + Math.random() * (max - min)));
  assert(a.map((c) => c.id).join(",") !== b.map((c) => c.id).join(","), "两次洗牌顺序应不同");
});

check("牌力评估：同花顺 > 四条 > 葫芦 > 同花 > 顺子 > 三条 > 两对 > 一对 > 高牌", () => {
  const straightFlush = rules.scoreFive([card("9S"), card("10S"), card("JS"), card("QS"), card("KS")]);
  const quads = rules.scoreFive([card("9S"), card("9H"), card("9C"), card("9D"), card("KS")]);
  const fullHouse = rules.scoreFive([card("9S"), card("9H"), card("9C"), card("KD"), card("KH")]);
  const flush = rules.scoreFive([card("2S"), card("5S"), card("7S"), card("9S"), card("KS")]);
  const straight = rules.scoreFive([card("9S"), card("10H"), card("JC"), card("QD"), card("KS")]);
  const trips = rules.scoreFive([card("9S"), card("9H"), card("9C"), card("KD"), card("2H")]);
  const twoPair = rules.scoreFive([card("9S"), card("9H"), card("KC"), card("KD"), card("2H")]);
  const pair = rules.scoreFive([card("9S"), card("9H"), card("KC"), card("QD"), card("2H")]);
  const high = rules.scoreFive([card("9S"), card("5H"), card("7C"), card("JD"), card("2H")]);
  assertEq(straightFlush[0], 8, "同花顺");
  assertEq(quads[0], 7, "四条");
  assertEq(fullHouse[0], 6, "葫芦");
  assertEq(flush[0], 5, "同花");
  assertEq(straight[0], 4, "顺子");
  assertEq(trips[0], 3, "三条");
  assertEq(twoPair[0], 2, "两对");
  assertEq(pair[0], 1, "一对");
  assertEq(high[0], 0, "高牌");
  // 1. 类别之间严格大于。
  const ordered = [high, pair, twoPair, trips, straight, flush, fullHouse, quads, straightFlush];
  for (let i = 1; i < ordered.length; i += 1) {
    assert(rules.compareScore(ordered[i], ordered[i - 1]) > 0, `第 ${i} 级应大于第 ${i - 1} 级`);
  }
});

check("牌力评估：A-5 轮子顺（高牌算 5）且是顺子", () => {
  const wheel = rules.scoreFive([card("AS"), card("2H"), card("3C"), card("4D"), card("5S")]);
  assertEq(wheel[0], 4, "轮子是顺子");
  assertEq(wheel[1], 5, "轮子高牌为 5");
  // 1. 轮子顺小于普通 6 高顺。
  const six = rules.scoreFive([card("2S"), card("3H"), card("4C"), card("5D"), card("6S")]);
  assert(rules.compareScore(six, wheel) > 0, "6 高顺大于轮子顺");
});

check("7 选 5 最优：底牌+公共牌中挑最大组合", () => {
  // 1. 底牌一对 A + 公共牌散牌：最优是一对 A。
  const hole = [card("AS"), card("AH")];
  const community = [card("2S"), card("5H"), card("7C"), card("JD"), card("3S")];
  const score = rules.bestScore([...hole, ...community]);
  assertEq(score[0], 1, "一对");
  assertEq(score[1], rules.RANK_POWER["A"], "A 对");
  // 2. 公共牌凑成顺子时选顺子。
  const community2 = [card("2S"), card("3H"), card("4C"), card("5D"), card("9S")];
  const score2 = rules.bestScore([...hole, ...community2]);
  assertEq(score2[0], 4, "顺子");
  assertEq(score2[1], 5, "5 高顺（A 当 1）");
});

check("摊牌：最高分胜出，平分底池", () => {
  // 1. 玩家 0 葫芦，玩家 1 两对，玩家 2 葫芦（同分）：0 与 2 平分。
  const hands = [
    [card("9S"), card("9H")],
    [card("2S"), card("2H")],
    [card("9C"), card("9D")],
  ];
  const community = [card("KD"), card("KH"), card("5S"), card("7C"), card("JD")];
  const result = rules.evaluateShowdown({ hands, folded: [false, false, false], community, pot: 90 });
  assertEq(result.winners, [0, 2], "并列最高者");
  assertEq(result.share, 45, "平分底池");
  // 2. 弃牌者不参与。
  const folded = rules.evaluateShowdown({ hands, folded: [true, false, false], community, pot: 60 });
  assertEq(folded.winners, [2], "弃牌者排除");
});

check("轮次辅助：跳过弃牌者找下一个，下注轮完成判定", () => {
  // 1. nextActiveIndex。
  assertEq(rules.nextActiveIndex([false, true, false], 0), 2, "跳过弃牌者");
  assertEq(rules.nextActiveIndex([false, true, false], 2), 0, "绕回开头");
  // 2. roundComplete：未行动或注额未追平都不算完成。
  assertEq(rules.roundComplete([{ folded: false, acted: true, bet: 10 }, { folded: false, acted: true, bet: 10 }], 10), true, "全部追平");
  assertEq(rules.roundComplete([{ folded: false, acted: true, bet: 10 }, { folded: false, acted: false, bet: 10 }], 10), false, "有人未行动");
  assertEq(rules.roundComplete([{ folded: false, acted: true, bet: 10 }, { folded: false, acted: true, bet: 5 }], 10), false, "注额未追平");
  assertEq(rules.roundComplete([{ folded: true, acted: false, bet: 0 }, { folded: false, acted: true, bet: 10 }], 10), true, "弃牌者不阻塞");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
