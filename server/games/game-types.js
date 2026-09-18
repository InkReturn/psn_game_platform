/**
 * 游戏类型注册表：房间类型校验的唯一定义处。
 *
 * 两种房间模型：
 * - 权威房（AUTHORITATIVE）：服务器持有唯一对局状态，客户端只发操作意图；
 * - 转发房（relay:<gameKey>）：服务器只做成员管理与消息转发，对局状态由房主客户端持有。
 *
 * 本模块同时给出各 gameType 的房间码前缀，保证「五子棋房间」与「斗兽棋房间」
 * 使用不同的房间码前缀，降低误闯概率；真正的隔离仍由 RoomManager 的 gameType 校验保证。
 */
"use strict";

/** 房间模型常量。 */
const RoomModel = Object.freeze({
  /** 服务器权威：对局状态在服务端推进。 */
  AUTHORITATIVE: "authoritative",
  /** 客户端权威 + 服务器转发。 */
  RELAY: "relay",
});

/**
 * 权威房注册表：gameType -> 房间码前缀。
 *
 * 前缀必须全局唯一：RoomManager 在客户端未声明 gameType 时会用房间码前缀反推
 * 房间类型，两个游戏共用前缀会导致「拿 A 游戏房号进 B 游戏页面」的兜底校验失效。
 */
const AUTHORITATIVE_GAME_TYPES = Object.freeze({
  gomoku: "WZ",
  "animal-chess": "DS",
  tictactoe: "JZ",
  reversi: "HB",
  connect4: "SZ",
  checkers: "TQ",
  ludo: "FQ",
  monopoly: "DF",
  landlord: "DD",
  blackjack: "BJ",
});

/** 转发房前缀。 */
const RELAY_PREFIX = "relay:";

/**
 * 判断 gameType 是否受支持。
 *
 * @param {string} gameType - 客户端声明的游戏类型（如 gomoku / animal-chess / relay:reversi）。
 * @returns {boolean} true 表示该 gameType 可建房。
 */
function isSupportedGameType(gameType) {
  if (typeof gameType !== "string" || !gameType) return false;
  if (Object.prototype.hasOwnProperty.call(AUTHORITATIVE_GAME_TYPES, gameType)) return true;
  if (!gameType.startsWith(RELAY_PREFIX)) return false;
  // relay 房的 gameKey 只允许小写字母/数字/短横线，避免把奇怪字符串写进房间类型。
  const gameKey = gameType.slice(RELAY_PREFIX.length);
  return /^[a-z0-9][a-z0-9-]{0,31}$/.test(gameKey);
}

/**
 * 房间模型判定。
 *
 * @param {string} gameType - 游戏类型。
 * @returns {string} RoomModel.AUTHORITATIVE 或 RoomModel.RELAY。
 */
function roomModelOf(gameType) {
  return Object.prototype.hasOwnProperty.call(AUTHORITATIVE_GAME_TYPES, gameType)
    ? RoomModel.AUTHORITATIVE
    : RoomModel.RELAY;
}

/**
 * 房间码前缀（2 位）。
 *
 * @param {string} gameType - 游戏类型。
 * @returns {string} 2 位大写前缀；未知类型回退 RM。
 */
function roomPrefixOf(gameType) {
  if (Object.prototype.hasOwnProperty.call(AUTHORITATIVE_GAME_TYPES, gameType)) {
    return AUTHORITATIVE_GAME_TYPES[gameType];
  }
  const gameKey = String(gameType || "").startsWith(RELAY_PREFIX) ? String(gameType).slice(RELAY_PREFIX.length) : "";
  const prefix = gameKey.replace(/[^a-z0-9]/gi, "").slice(0, 2).toUpperCase();
  return prefix || "RM";
}

module.exports = { RoomModel, AUTHORITATIVE_GAME_TYPES, RELAY_PREFIX, isSupportedGameType, roomModelOf, roomPrefixOf };
