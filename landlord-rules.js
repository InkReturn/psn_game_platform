/**
 * 斗地主纯规则模块（服务端唯一裁决者，浏览器只用于展示与提示）。
 *
 * 规则口径与改造前 landlord.js 的客户端本地实现逐条对齐，不新增/删减玩法
 * （保持简化牌型：单张 / 对子 / 三张 / 炸弹 / 王炸 / 顺子（≥5 张且不含 2）；
 * 不支持三带一、四带二、连对、飞机等扩展牌型）：
 * - 54 张牌（52 常规 + 大小王），发 3 家各 17 张，留 3 张底牌；
 * - 叫地主：三家按座位顺序各叫一次，叫/抢使倍率 ×2，全部叫完后最高叫者当地主
 *   （无人叫则 0 号位当地主），地主收底牌（20 张）并先出；
 * - 出牌必须压过上一手（同型同数量更大，或炸弹压非炸弹、王炸压一切）；
 *   炸弹/王炸使倍率 ×2；连续两家不出则一轮结束，可重新领出；
 * - 任意一家先出完手牌即结束（地主或农民一方获胜，沿用旧口径按消息表述）。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性：洗牌通过注入的随机整数函数完成，
 *   同样的 (state, input) 永远得到同样的结果；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.LandlordRules）使用，
 *   服务端裁决与客户端"提示"共用同一份实现，避免规则实现漂移成两份。
 */
"use strict";

/** 牌面顺序（值越大越大）。 */
const RANKS = Object.freeze(["3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A", "2", "小王", "大王"]);
/** 牌面 -> 权值。 */
const RANK_VALUE = Object.freeze(Object.fromEntries(RANKS.map((rank, index) => [rank, index])));
/** 花色。 */
const SUITS = Object.freeze(["S", "H", "C", "D"]);
/** 底牌张数。 */
const BOTTOM_COUNT = 3;
/** 每家手牌张数。 */
const HAND_COUNT = 17;

/**
 * 生成未洗牌的 54 张牌堆。
 *
 * @returns {Array<{rank: string, suit: string, id: string}>} 牌堆（顺序固定）。
 */
function buildDeck() {
  const deck = [];
  SUITS.forEach((suit) => RANKS.slice(0, 13).forEach((rank) => deck.push({ rank, suit, id: `${rank}${suit}` })));
  deck.push({ rank: "小王", suit: "", id: "joker-small" }, { rank: "大王", suit: "", id: "joker-big" });
  return deck;
}

/**
 * 洗牌（Fisher-Yates，随机源由调用方注入）。
 *
 * @param {Array<object>} deck - 牌堆（原样修改并返回）。
 * @param {Function} randomInt - (minInclusive, maxExclusive) => 随机整数（服务器传 crypto.randomInt）。
 * @returns {Array<object>} 洗好的牌堆。
 */
function shuffleDeck(deck, randomInt) {
  // 1. 从后往前：每张牌与前方（含自身）随机一张交换。
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 手牌排序（按权值升序，原样修改）。
 *
 * @param {Array<object>} hand - 手牌。
 */
function sortHand(hand) {
  hand.sort((a, b) => RANK_VALUE[a.rank] - RANK_VALUE[b.rank]);
}

/**
 * 牌型识别（与旧实现逐条一致）。
 *
 * @param {Array<object>} cards - 出的牌。
 * @returns {{type: string, power: number, count: number}|null} 牌型描述；无法识别返回 null。
 */
function classify(cards) {
  if (!cards.length) return null;
  const values = cards.map((card) => RANK_VALUE[card.rank]).sort((a, b) => a - b);
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const groups = [...counts.values()].sort((a, b) => b - a);
  if (cards.length === 1) return { type: "single", power: values[0], count: 1 };
  if (cards.length === 2 && values.includes(RANK_VALUE["小王"]) && values.includes(RANK_VALUE["大王"])) return { type: "rocket", power: 99, count: 2 };
  if (cards.length === 2 && groups[0] === 2) return { type: "pair", power: values[0], count: 2 };
  if (cards.length === 3 && groups[0] === 3) return { type: "triple", power: values[0], count: 3 };
  if (cards.length === 4 && groups[0] === 4) return { type: "bomb", power: values[0], count: 4 };
  if (cards.length >= 5 && groups.every((count) => count === 1) && values.every((value) => value < RANK_VALUE["2"])) {
    if (values.every((value, index) => index === 0 || value === values[index - 1] + 1)) {
      return { type: "straight", power: values.at(-1), count: cards.length };
    }
  }
  return null;
}

/**
 * 出牌是否能压过上一手。
 *
 * @param {{type: string, power: number, count: number}} play - 本手牌型。
 * @param {{type: string, power: number, count: number}|null} last - 上一手牌型（null 表示领出）。
 * @returns {boolean} true 表示可以出。
 */
function beats(play, last) {
  if (!play) return false;
  if (!last) return true;
  if (play.type === "rocket") return true;
  if (play.type === "bomb" && last.type !== "bomb" && last.type !== "rocket") return true;
  return play.type === last.type && play.count === last.count && play.power > last.power;
}

/**
 * 解析一次出牌意图：校验牌都在手、牌型可识别、能压过上一手。
 *
 * @param {object} params - 入参。
 * @param {Array<object>} params.hand - 出牌者的手牌。
 * @param {Array<string>} params.ids - 要出的牌 id 列表（客户端只发 id）。
 * @param {{type: string, power: number, count: number}|null} params.lastPlay - 上一手牌型（null 表示领出）。
 * @returns {{ok: true, play: object, cards: Array<object>}|{ok: false, reason: string}} 解析结果；
 *   拒绝原因：BAD_IDS（空/重复/不在手中）/ UNKNOWN_TYPE / NOT_BEATING。
 */
function resolvePlay({ hand, ids, lastPlay }) {
  // 1. id 列表校验：非空、无重复、全部在手中。
  if (!Array.isArray(ids) || !ids.length || new Set(ids).size !== ids.length) {
    return { ok: false, reason: "BAD_IDS" };
  }
  const cards = [];
  for (const id of ids) {
    const card = hand.find((item) => item.id === id);
    if (!card) return { ok: false, reason: "BAD_IDS" };
    cards.push(card);
  }
  // 2. 牌型识别。
  const play = classify(cards);
  if (!play) return { ok: false, reason: "UNKNOWN_TYPE" };
  // 3. 压牌校验。
  if (!beats(play, lastPlay)) return { ok: false, reason: "NOT_BEATING" };
  return { ok: true, play, cards };
}

/**
 * 从手牌中移除已出的牌（纯函数：返回新手牌数组）。
 *
 * @param {Array<object>} hand - 手牌。
 * @param {Array<object>} cards - 已出的牌。
 * @returns {Array<object>} 新手牌。
 */
function removeCards(hand, cards) {
  const ids = new Set(cards.map((card) => card.id));
  return hand.filter((card) => !ids.has(card.id));
}

/**
 * 枚举手牌中的候选出牌组合（提示功能的基础，与旧实现逐条一致）。
 *
 * @param {Array<object>} hand - 手牌。
 * @returns {Array<{play: object, indices: Array<number>}>} 候选列表。
 */
function buildHintCandidates(hand) {
  const byRank = new Map();
  hand.forEach((card, index) => {
    if (!byRank.has(card.rank)) byRank.set(card.rank, []);
    byRank.get(card.rank).push(index);
  });
  const candidates = [];

  /**
   * 记录一个候选（内部辅助）。
   *
   * @param {Array<number>} indices - 手牌下标。
   */
  const addCandidate = (indices) => {
    const play = classify(indices.map((index) => hand[index]));
    if (play) candidates.push({ play, indices });
  };

  for (const indices of byRank.values()) {
    addCandidate(indices.slice(0, 1));
    if (indices.length >= 2) addCandidate(indices.slice(0, 2));
    if (indices.length >= 3) addCandidate(indices.slice(0, 3));
    if (indices.length >= 4) addCandidate(indices.slice(0, 4));
  }

  const jokerSmall = hand.findIndex((card) => card.rank === "小王");
  const jokerBig = hand.findIndex((card) => card.rank === "大王");
  if (jokerSmall >= 0 && jokerBig >= 0) addCandidate([jokerSmall, jokerBig]);

  const uniqueRanks = RANKS.slice(0, 12)
    .filter((rank) => byRank.has(rank))
    .map((rank) => ({ index: byRank.get(rank)[0], value: RANK_VALUE[rank] }));

  for (let start = 0; start < uniqueRanks.length; start += 1) {
    const run = [uniqueRanks[start]];
    for (let next = start + 1; next < uniqueRanks.length; next += 1) {
      if (uniqueRanks[next].value !== run.at(-1).value + 1) break;
      run.push(uniqueRanks[next]);
      if (run.length >= 5) addCandidate(run.map((item) => item.index));
    }
  }

  return candidates;
}

/**
 * 找一手能压过上一手的提示（优先普通牌型，炸弹/王炸垫底）。
 *
 * @param {Array<object>} hand - 手牌。
 * @param {{type: string, power: number, count: number}|null} lastPlay - 上一手牌型（null 表示领出）。
 * @returns {Array<string>} 提示牌的 id 列表（按手牌下标顺序）；无可出返回 []。
 */
function findHint(hand, lastPlay) {
  const all = buildHintCandidates(hand).filter((candidate) => beats(candidate.play, lastPlay));
  all.sort((a, b) => {
    if (a.play.type === "rocket" && b.play.type !== "rocket") return 1;
    if (a.play.type !== "rocket" && b.play.type === "rocket") return -1;
    if (a.play.type === "bomb" && b.play.type !== "bomb") return 1;
    if (a.play.type !== "bomb" && b.play.type === "bomb") return -1;
    if (a.play.count !== b.play.count) return a.play.count - b.play.count;
    return a.play.power - b.play.power;
  });
  return all[0] ? all[0].indices.map((index) => hand[index].id) : [];
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  RANKS,
  RANK_VALUE,
  SUITS,
  BOTTOM_COUNT,
  HAND_COUNT,
  buildDeck,
  shuffleDeck,
  sortHand,
  classify,
  beats,
  resolvePlay,
  removeCards,
  buildHintCandidates,
  findHint,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.LandlordRules = api;
