/**
 * 21 点规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 blackjack-rules.js：牌堆构成、洗牌、点数计算（A 降级）、
 * 下一可操作座位、结算（庄家补牌、赢家判定、派彩），以及
 * "爆牌玩家庄家爆牌时也不赢"的 bug 修复回归。
 *
 * 运行方式：node tests/blackjack-rules.cjs
 */
"use strict";

const rules = require("../blackjack-rules");

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

check("点数：数字牌按面值，JQK 计 10，A 先 11 后降 1", () => {
  assertEq(rules.handValue([card("5S"), card("KH")]), 15, "5+K");
  assertEq(rules.handValue([card("AS"), card("KH")]), 21, "A+K = 21");
  assertEq(rules.handValue([card("AS"), card("2H"), card("9C")]), 12, "A 降级 1");
  assertEq(rules.handValue([card("AS"), card("AD"), card("9C")]), 21, "双 A 一个降级");
  assertEq(rules.handValue([card("AS"), card("AD"), card("AC"), card("AH")]), 14, "四 A");
  assertEq(rules.handValue([card("10S"), card("JH")]), 20, "10+J");
});

check("下一可操作座位：跳过已停牌与已爆牌", () => {
  const seats = [
    { stood: true, busted: false },
    { stood: false, busted: false },
    { stood: false, busted: true },
  ];
  assertEq(rules.nextPlayable(seats, 0), 1, "跳过停牌者");
  assertEq(rules.nextPlayable(seats, 1), 1, "自己仍可操作");
  assertEq(rules.nextPlayable(seats, 2), 1, "从爆牌者往后找");
  // 1. 全部完成时返回起点（调用方用 allSettled 判定）。
  const done = seats.map((s) => ({ ...s, stood: true }));
  assertEq(rules.allSettled(done), true, "全部完成");
  assertEq(rules.nextPlayable(done, 0), 0, "返回起点");
});

check("结算：庄家 <17 必须补牌，赢家获得底注 ×2", () => {
  // 1. 玩家 20，庄家 6+10=16 需要补牌（从 deck 末尾摸 9S）。
  const deck = [card("10S"), card("6H"), card("10C"), card("9S")];
  const result = rules.settle({
    seats: [{ stood: true, busted: false, bet: 10, chips: 1000 }],
    hands: [[card("KH"), card("10H")]],
    dealerHand: [card("6S"), card("10D")],
    deck,
  });
  // 2. 庄家 16+9=25 爆牌（deck.pop() 是 9S）。
  assertEq(result.dealerScore, 25, "庄家补牌后爆牌");
  assertEq(result.winners, [0], "玩家赢");
  assertEq(result.seats[0].chips, 1020, "派彩 +20");
});

check("结算：点数更大者赢，相同点数庄家赢（沿用旧口径无平局退款）", () => {
  const deck = [];
  const result = rules.settle({
    seats: [
      { stood: true, busted: false, bet: 10, chips: 1000 },
      { stood: true, busted: false, bet: 10, chips: 1000 },
    ],
    hands: [
      [card("9H"), card("9S")],
      [card("KH"), card("9C")],
    ],
    dealerHand: [card("10S"), card("9D")],
    deck,
  });
  // 1. 庄家 19：玩家 18 输、玩家 19 不大于庄家（旧口径：庄家赢）。
  assertEq(result.dealerScore, 19, "庄家 19");
  assertEq(result.winners, [], "无赢家（庄家赢）");
});

check("bug 修复回归：爆牌玩家在庄家爆牌时也不赢", () => {
  // 1. 玩家爆牌（25），庄家 16 补 K 爆牌（26）：爆牌玩家不得赢筹码。
  const deck = [card("KH")];
  const result = rules.settle({
    seats: [
      { stood: true, busted: true, bet: 10, chips: 1000 },
      { stood: true, busted: false, bet: 10, chips: 1000 },
    ],
    hands: [
      [card("10S"), card("9H"), card("6C")],
      [card("KH"), card("10H")],
    ],
    dealerHand: [card("10D"), card("6S")],
    deck,
  });
  // 2. 庄家 16+K=26 爆牌。
  assertEq(result.dealerScore, 26, "庄家爆牌");
  assertEq(result.winners, [1], "只有未爆牌的玩家 1 获胜");
  assertEq(result.seats[0].chips, 1000, "爆牌玩家不派彩");
  assertEq(result.seats[1].chips, 1020, "未爆牌玩家派彩");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
