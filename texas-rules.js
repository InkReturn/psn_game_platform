/**
 * 德州扑克纯规则模块（服务端唯一裁决者，浏览器只用于展示）。
 *
 * 规则口径与改造前 texas.js 的客户端本地实现逐条对齐，不新增/删减玩法
 * （保持简化版：固定前注 10、固定加注 20、无盲注位轮转、无底池上限、
 * 筹码不足按 all-in 处理但不做边池——跟注金额被钳制到剩余筹码，
 * 多余部分留在底池由摊牌平分，沿用旧口径）：
 * - 52 张牌，每家 2 张底牌，公共牌分阶段发出（翻牌 3 张 / 转牌 / 河牌）；
 * - 下注轮：所有未弃牌者 acted 且注额追平 currentBet 时进入下一阶段；
 *   加注会把其他未弃牌者的 acted 重置；
 * - 只剩一名未弃牌者时立即结束（弃牌获胜）；
 * - 河牌下注轮结束后摊牌：未弃牌者从 7 张里选最优 5 张比大小，平分底池。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性：洗牌通过注入的随机整数函数完成；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.TexasRules）使用。
 */
"use strict";

/** 花色。 */
const SUITS = Object.freeze(["S", "H", "C", "D"]);
/** 牌面。 */
const RANKS = Object.freeze(["2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K", "A"]);
/** 牌面 -> 权值（2=2 ... A=14）。 */
const RANK_POWER = Object.freeze(Object.fromEntries(RANKS.map((rank, index) => [rank, index + 2])));
/** 固定前注（沿用旧口径）。 */
const ANTE = 10;
/** 固定加注额（沿用旧口径）。 */
const RAISE_STEP = 20;
/** 起始筹码。 */
const START_STACK = 1000;
/** 允许的玩家数范围。 */
const MIN_PLAYERS = 2;
const MAX_PLAYERS = 6;

/**
 * 生成未洗牌的 52 张牌堆。
 *
 * @returns {Array<{rank: string, suit: string, id: string}>} 牌堆（顺序固定）。
 */
function buildDeck() {
  const deck = [];
  SUITS.forEach((suit) => RANKS.forEach((rank) => deck.push({ rank, suit, id: `${rank}${suit}` })));
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
  for (let i = deck.length - 1; i > 0; i -= 1) {
    const j = randomInt(0, i + 1);
    [deck[i], deck[j]] = [deck[j], deck[i]];
  }
  return deck;
}

/**
 * 5 张牌的牌力评分（与旧实现逐条一致）。
 *
 * 返回按字典序比较的数组：[类别, 关键点数...]，
 * 类别 8=同花顺 7=四条 6=葫芦 5=同花 4=顺子 3=三条 2=两对 1=一对 0=高牌。
 *
 * @param {Array<object>} cards - 恰好 5 张牌。
 * @returns {Array<number>} 评分数组。
 */
function scoreFive(cards) {
  const values = cards.map((card) => RANK_POWER[card.rank]).sort((a, b) => b - a);
  const counts = new Map();
  values.forEach((value) => counts.set(value, (counts.get(value) || 0) + 1));
  const groups = [...counts.entries()].sort((a, b) => b[1] - a[1] || b[0] - a[0]);
  const flush = cards.every((card) => card.suit === cards[0].suit);
  const unique = [...new Set(values)].sort((a, b) => b - a);
  const wheel = unique.join(",") === "14,5,4,3,2";
  const straightHigh = wheel ? 5 : unique.length === 5 && unique[0] - unique[4] === 4 ? unique[0] : 0;
  if (flush && straightHigh) return [8, straightHigh];
  if (groups[0][1] === 4) return [7, groups[0][0], groups[1][0]];
  if (groups[0][1] === 3 && groups[1][1] === 2) return [6, groups[0][0], groups[1][0]];
  if (flush) return [5, ...values];
  if (straightHigh) return [4, straightHigh];
  if (groups[0][1] === 3) return [3, groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)];
  if (groups[0][1] === 2 && groups[1][1] === 2) return [2, groups[0][0], groups[1][0], groups[2][0]];
  if (groups[0][1] === 2) return [1, groups[0][0], ...groups.slice(1).map((g) => g[0]).sort((a, b) => b - a)];
  return [0, ...values];
}

/**
 * 枚举组合（内部辅助）。
 *
 * @param {Array<object>} cards - 候选牌。
 * @param {number} size - 组合大小。
 * @param {number} [start] - 递归起点。
 * @param {Array<number>} [pick] - 已选下标。
 * @param {Array<Array<object>>} [out] - 输出收集。
 * @returns {Array<Array<object>>} 全部组合。
 */
function combinations(cards, size, start = 0, pick = [], out = []) {
  if (pick.length === size) {
    out.push(pick.map((index) => cards[index]));
    return out;
  }
  for (let i = start; i < cards.length; i += 1) combinations(cards, size, i + 1, [...pick, i], out);
  return out;
}

/**
 * 字典序比较两个评分（正数 = a 更大）。
 *
 * @param {Array<number>} a - 评分 a。
 * @param {Array<number>} b - 评分 b。
 * @returns {number} 比较结果。
 */
function compareScore(a, b) {
  const len = Math.max(a.length, b.length);
  for (let i = 0; i < len; i += 1) {
    if ((a[i] || 0) !== (b[i] || 0)) return (a[i] || 0) - (b[i] || 0);
  }
  return 0;
}

/**
 * 从任意张牌中选最优 5 张的评分（7 选 5 用于摊牌）。
 *
 * @param {Array<object>} cards - 候选牌（通常 7 张）。
 * @returns {Array<number>} 最优 5 张的评分。
 */
function bestScore(cards) {
  return combinations(cards, 5).map(scoreFive).sort(compareScore).at(-1);
}

/**
 * 摊牌结算（纯函数）：未弃牌者比大小，最高分并列者平分底池。
 *
 * @param {object} params - 入参。
 * @param {Array<Array<object>>} params.hands - 各座位底牌（与 seats 下标对齐）。
 * @param {Array<boolean>} params.folded - 各座位是否弃牌。
 * @param {Array<object>} params.community - 公共牌。
 * @param {number} params.pot - 底池。
 * @returns {{winners: Array<number>, share: number, scores: Array<Array<number>>}} 摊牌结果。
 */
function evaluateShowdown({ hands, folded, community, pot }) {
  // 1. 计算每个未弃牌座位的评分。
  const scores = hands.map((hand, index) => (folded[index] ? null : bestScore([...hand, ...community])));
  // 2. 找最高分。
  let best = null;
  scores.forEach((score) => {
    if (score && (best === null || compareScore(score, best) > 0)) best = score;
  });
  // 3. 并列最高者平分底池（向下取整，沿用旧口径）。
  const winners = [];
  scores.forEach((score, index) => {
    if (score && best && compareScore(score, best) === 0) winners.push(index);
  });
  const share = winners.length ? Math.floor(pot / winners.length) : 0;
  return { winners, share, scores };
}

/**
 * 下一个未弃牌座位下标（跳过弃牌者）。
 *
 * @param {Array<boolean>} folded - 各座位是否弃牌。
 * @param {number} from - 起始下标（不含）。
 * @returns {number} 下一个未弃牌座位下标。
 */
function nextActiveIndex(folded, from) {
  for (let step = 1; step <= folded.length; step += 1) {
    const index = (from + step) % folded.length;
    if (!folded[index]) return index;
  }
  return from;
}

/**
 * 下注轮是否完成（所有未弃牌者已行动且注额追平当前注）。
 *
 * @param {Array<{folded: boolean, acted: boolean, bet: number}>} seats - 座位状态。
 * @param {number} currentBet - 当前注额。
 * @returns {boolean} true 表示本轮完成。
 */
function roundComplete(seats, currentBet) {
  return seats.filter((seat) => !seat.folded).every((seat) => seat.acted && seat.bet === currentBet);
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  SUITS,
  RANKS,
  RANK_POWER,
  ANTE,
  RAISE_STEP,
  START_STACK,
  MIN_PLAYERS,
  MAX_PLAYERS,
  buildDeck,
  shuffleDeck,
  scoreFive,
  combinations,
  compareScore,
  bestScore,
  evaluateShowdown,
  nextActiveIndex,
  roundComplete,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.TexasRules = api;
