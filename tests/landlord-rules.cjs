/**
 * 斗地主规则模块单测（纯函数，无需服务器与浏览器）。
 *
 * 覆盖 landlord-rules.js：牌堆构成、洗牌（注入随机源）、牌型识别（含不支持
 * 的扩展牌型拒绝）、压牌判定、出牌解析的三种拒绝、移除手牌、提示查找。
 * 规则模块是服务端权威的唯一裁决依据，因此必须能脱离网络单独验证。
 *
 * 运行方式：node tests/landlord-rules.cjs
 */
"use strict";

const rules = require("../landlord-rules");

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

/** 造牌辅助：按 id 找牌（从标准牌堆）。 */
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

check("牌堆：54 张（52 常规 + 大小王），id 唯一", () => {
  assertEq(DECK.length, 54, "牌堆张数");
  assertEq(new Set(DECK.map((c) => c.id)).size, 54, "id 唯一");
  assertEq(DECK.filter((c) => !c.suit).map((c) => c.id), ["joker-small", "joker-big"], "双王");
});

check("洗牌：注入固定随机源结果确定，且是全排列", () => {
  const deck = rules.buildDeck();
  // 1. 固定随机源（恒返回 min）：等价于反向遍历的原地交换，结果确定。
  const shuffled = rules.shuffleDeck(rules.buildDeck(), () => 0);
  assertEq(shuffled.length, 54, "张数不变");
  // 2. 固定源洗出的牌堆与原牌堆内容一致（同一批牌）。
  assertEq(new Set(shuffled.map((c) => c.id)).size, 54, "无重复无丢失");
  // 3. 真随机源（两次洗牌）几乎必然不同顺序。
  const a = rules.shuffleDeck(rules.buildDeck(), (min, max) => Math.floor(min + Math.random() * (max - min)));
  const b = rules.shuffleDeck(rules.buildDeck(), (min, max) => Math.floor(min + Math.random() * (max - min)));
  void deck;
  assert(a.map((c) => c.id).join(",") !== b.map((c) => c.id).join(","), "两次洗牌顺序应不同");
});

check("牌型：单张/对子/三张/炸弹/王炸/顺子", () => {
  assertEq(rules.classify([card("3S")]).type, "single", "单张");
  assertEq(rules.classify([card("3S"), card("3H")]).type, "pair", "对子");
  assertEq(rules.classify([card("3S"), card("3H"), card("3C")]).type, "triple", "三张");
  assertEq(rules.classify([card("3S"), card("3H"), card("3C"), card("3D")]).type, "bomb", "炸弹");
  assertEq(rules.classify([card("joker-small"), card("joker-big")]).type, "rocket", "王炸");
  const straight = ["3S", "4H", "5C", "6D", "7S"].map(card);
  const s = rules.classify(straight);
  assertEq(s.type, "straight", "顺子");
  assertEq(s.count, 5, "顺子张数");
  // 1. 顺子不含 2：3..7 加一张 2 不再是顺子（也无其他牌型）。
  assertEq(rules.classify([...straight, card("2S")]), null, "含 2 的连牌不支持");
  // 2. 不连续不算顺子。
  assertEq(rules.classify(["3S", "4H", "6C", "7D", "8S"].map(card)), null, "不连续拒绝");
});

check("牌型：不支持三带一/四带二等扩展牌型（沿用旧口径）", () => {
  assertEq(rules.classify([card("3S"), card("3H"), card("3C"), card("4D")]), null, "三带一拒绝");
  assertEq(rules.classify([card("3S"), card("3H"), card("3C"), card("3D"), card("4S"), card("4H")]), null, "四带二拒绝");
  assertEq(rules.classify([card("3S"), card("4H")]), null, "非对子的两张拒绝");
});

check("压牌：同型比大小，炸弹压非炸弹，王炸压一切", () => {
  const single3 = rules.classify([card("3S")]);
  const single4 = rules.classify([card("4S")]);
  const pair3 = rules.classify([card("3S"), card("3H")]);
  const bomb5 = rules.classify([card("5S"), card("5H"), card("5C"), card("5D")]);
  const rocket = rules.classify([card("joker-small"), card("joker-big")]);
  // 1. 领出（无上一手）总是可以。
  assertEq(rules.beats(single3, null), true, "领出");
  // 2. 同型比较。
  assertEq(rules.beats(single4, single3), true, "4 压 3");
  assertEq(rules.beats(single3, single4), false, "3 压不了 4");
  assertEq(rules.beats(pair3, single3), false, "对子压不了单张");
  // 3. 炸弹与王炸。
  assertEq(rules.beats(bomb5, single3), true, "炸弹压单张");
  assertEq(rules.beats(bomb5, rocket), false, "炸弹压不了王炸");
  assertEq(rules.beats(rocket, bomb5), true, "王炸压炸弹");
});

check("出牌解析：不在手/重复/未知牌型/压不过 四种拒绝", () => {
  const hand = ["3S", "3H", "5C", "joker-small", "joker-big"].map(card);
  const lastPlay = rules.classify([card("6S")]);
  // 1. 不在手中。
  assertEq(rules.resolvePlay({ hand, ids: ["9S"], lastPlay: null }).reason, "BAD_IDS", "不在手");
  // 2. 重复 id。
  assertEq(rules.resolvePlay({ hand, ids: ["3S", "3S"], lastPlay: null }).reason, "BAD_IDS", "重复");
  // 3. 空列表。
  assertEq(rules.resolvePlay({ hand, ids: [], lastPlay: null }).reason, "BAD_IDS", "空列表");
  // 4. 未知牌型（三带一）。
  assertEq(rules.resolvePlay({ hand, ids: ["3S", "3H", "5C"], lastPlay: null }).reason, "UNKNOWN_TYPE", "未知牌型");
  // 5. 压不过。
  assertEq(rules.resolvePlay({ hand, ids: ["5C"], lastPlay }).reason, "NOT_BEATING", "压不过");
  // 6. 合法：王炸压 6。
  const ok = rules.resolvePlay({ hand, ids: ["joker-small", "joker-big"], lastPlay });
  assertEq(ok.ok, true, "王炸合法");
  assertEq(ok.play.type, "rocket", "牌型");
});

check("移除手牌：只移除已出的牌（纯函数）", () => {
  const hand = ["3S", "3H", "5C"].map(card);
  const snapshot = JSON.stringify(hand);
  const next = rules.removeCards(hand, [card("3H")]);
  assertEq(next.map((c) => c.id), ["3S", "5C"], "移除指定牌");
  assertEq(JSON.stringify(hand), snapshot, "入参未被修改");
});

check("提示：能找到压过的最小组合，领出时给出最小单张", () => {
  const hand = ["3S", "3H", "6C", "joker-small", "joker-big"].map(card);
  // 1. 领出：最小单张 3。
  const lead = rules.findHint(hand, null);
  assertEq(lead, ["3S"], "领出提示最小单张");
  // 2. 压 5：给 6（普通牌优先于王炸）。
  const beat5 = rules.findHint(hand, rules.classify([card("5S")]));
  assertEq(beat5, ["6C"], "压 5 提示 6");
  // 3. 压 7：单小王即可压过（单张 13 > 7，普通牌型优先于王炸）。
  const beat7 = rules.findHint(hand, rules.classify([card("7S")]));
  assertEq(beat7, ["joker-small"], "压 7 提示单小王");
  // 4. 压 3（单张 3 已是手牌最小）：提示 6？不——3 压不了 3，最小可压是 6。
  const beat3 = rules.findHint(hand, rules.classify([card("3D")]));
  assertEq(beat3, ["6C"], "压另一张 3 提示 6");
});

check("提示：无可出返回空列表", () => {
  const hand = ["3S"].map(card);
  assertEq(rules.findHint(hand, rules.classify([card("5S")])), [], "压不过返回空");
});

(async () => {
  // 1. 汇总结果。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})();
