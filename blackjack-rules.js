/**
 * 21 点纯规则模块（服务端唯一裁决者，浏览器只用于展示与提示）。
 *
 * 规则口径与改造前 blackjack.js 的客户端本地实现逐条对齐（多人对庄家简化版：
 * 固定底注 10、无加倍/分牌/保险、庄家 <17 必须要牌），并修复一个原版真实 bug：
 * - 原版结算把爆牌玩家记 0 分，庄家爆牌时 0 分也满足"score <= 21 && dealer > 21"，
 *   导致爆牌玩家反而赢筹码；本模块按 21 点本意排除爆牌玩家（爆牌必输）。
 *
 * 设计约束：
 * - 本文件没有任何 I/O、DOM 依赖与随机性：洗牌通过注入的随机整数函数完成；
 * - 同时被 Node（require）与浏览器（<script> 加载，暴露 window.BlackjackRules）使用，
 *   服务端裁决与客户端点数显示共用同一份实现，避免规则实现漂移成两份。
 */
"use strict";

/** 花色。 */
const SUITS = Object.freeze(["S", "H", "C", "D"]);
/** 牌面。 */
const RANKS = Object.freeze(["A", "2", "3", "4", "5", "6", "7", "8", "9", "10", "J", "Q", "K"]);
/** 固定底注（沿用旧口径）。 */
const BET = 10;
/** 起始筹码。 */
const START_CHIPS = 1000;
/** 庄家要牌阈值（<17 必须要牌）。 */
const DEALER_STAND = 17;
/** 允许的玩家数范围（多人对庄家，最多 3 人）。 */
const MIN_PLAYERS = 1;
const MAX_PLAYERS = 3;

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
 * 计算手牌点数（A 先按 11 计，超 21 时逐张降为 1）。
 *
 * @param {Array<object>} hand - 手牌。
 * @returns {number} 点数。
 */
function handValue(hand) {
  let total = 0;
  let aces = 0;
  hand.forEach((card) => {
    if (card.rank === "A") {
      total += 11;
      aces += 1;
    } else if (["J", "Q", "K"].includes(card.rank)) total += 10;
    else total += Number(card.rank);
  });
  while (total > 21 && aces > 0) {
    total -= 10;
    aces -= 1;
  }
  return total;
}

/**
 * 找下一个可操作的座位（未停牌且未爆牌）。
 *
 * @param {Array<object>} seats - 座位数组（含 stood/busted）。
 * @param {number} from - 起始下标。
 * @returns {number} 可操作座位下标；全部完成时返回 from。
 */
function nextPlayable(seats, from) {
  for (let step = 0; step < seats.length; step += 1) {
    const index = (from + step) % seats.length;
    const seat = seats[index];
    if (!seat.stood && !seat.busted) return index;
  }
  return from;
}

/**
 * 是否所有玩家都已停牌或爆牌（该结算了）。
 *
 * @param {Array<object>} seats - 座位数组。
 * @returns {boolean} true 表示全部完成。
 */
function allSettled(seats) {
  return seats.every((seat) => seat.stood || seat.busted);
}

/**
 * 结算：庄家补牌 + 判定赢家 + 派彩（纯函数）。
 *
 * @param {object} params - 入参。
 * @param {Array<object>} params.seats - 座位状态（stood/busted/bet/chips，不含手牌）。
 * @param {Array<Array<object>>} params.hands - 各座位手牌（与 seats 下标对齐）。
 * @param {Array<object>} params.dealerHand - 庄家手牌（补牌前）。
 * @param {Array<object>} params.deck - 牌堆（从末尾发牌，原样消耗）。
 * @returns {{seats: Array<object>, dealerHand: Array<object>, dealerScore: number, winners: Array<number>}} 结算结果。
 */
function settle({ seats, hands, dealerHand, deck }) {
  // 1. 庄家补牌：<17 必须要牌（沿用旧口径）。
  const hand = [...dealerHand];
  while (handValue(hand) < DEALER_STAND) {
    hand.push(deck.pop());
  }
  const dealerScore = handValue(hand);
  // 2. 判定赢家：未爆牌且点数不超 21，且（庄家爆牌 或 点数更大）。
  //    爆牌玩家一律判负（修复原版"庄家爆牌时爆牌玩家也赢"的 bug）。
  const nextSeats = seats.map((seat) => ({ ...seat }));
  const winners = [];
  nextSeats.forEach((seat, index) => {
    if (seat.busted) return;
    const score = handValue(hands[index]);
    if (score <= 21 && (dealerScore > 21 || score > dealerScore)) winners.push(index);
  });
  // 3. 派彩：赢家获得底注 ×2（沿用旧口径）。
  winners.forEach((index) => {
    nextSeats[index].chips += nextSeats[index].bet * 2;
  });
  return { seats: nextSeats, dealerHand: hand, dealerScore, winners };
}

/** 导出 API（Node 与浏览器共用）。 */
const api = {
  SUITS,
  RANKS,
  BET,
  START_CHIPS,
  DEALER_STAND,
  MIN_PLAYERS,
  MAX_PLAYERS,
  buildDeck,
  shuffleDeck,
  handValue,
  nextPlayable,
  allSettled,
  settle,
};

if (typeof module !== "undefined" && module.exports) module.exports = api;
if (typeof window !== "undefined") window.BlackjackRules = api;
