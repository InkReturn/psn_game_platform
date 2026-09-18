/**
 * 斗地主服务器权威房间（3 人，隐藏信息）。
 *
 * 权威边界（本房间是平台内第一个"私有状态"房间）：
 * - 服务器持有完整牌堆、三家手牌、底牌、地主身份、倍率、上一手牌与轮次；
 * - 客户端只发操作意图（bid / play / pass / restart）；
 * - 洗牌由服务器 crypto 完成；客户端在 action 里夹带的任何手牌/倍率/轮次字段
 *   一概不采纳；
 * - 快照按玩家个性化下发（personalizedSnapshots）：每个玩家只收到
 *   自己的手牌 + 其他玩家的剩余张数 + 已出的牌 + 已公布的底牌；
 *   其他玩家手牌、未公布的底牌、牌堆顺序在任何消息里都不下发。
 */
"use strict";

const crypto = require("crypto");
const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于提示），避免规则实现漂移成两份。
const rules = require("../../landlord-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

/** 斗地主固定 3 人。 */
const LANDLORD_PLAYERS = 3;

/** 出牌拒绝原因 -> 协议错误码。 */
const REJECTION_TO_ERROR = Object.freeze({
  BAD_IDS: ErrorCodes.INVALID_CARD,
  UNKNOWN_TYPE: ErrorCodes.INVALID_ACTION,
  NOT_BEATING: ErrorCodes.INVALID_MOVE,
});

/**
 * 斗地主权威房间。
 *
 * 座位约定：房主占 0 号位，随后加入者依次入座；满 3 人自动开局（洗牌发牌进叫分）。
 * 玩家中途离开时房间回到等待状态并清空所有手牌（隐私数据不残留），
 * 重新满员后再次自动开局。
 */
class LandlordRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   */
  constructor(roomId) {
    super(roomId, "landlord");
    this.status = "waiting";
    this.maxPlayers = LANDLORD_PLAYERS;
    /** 启用个性化快照：广播与加入/重连响应都按玩家过滤私有数据。 */
    this.personalizedSnapshots = true;
    /** 座位表：按入座顺序排列的 {playerId, nickname}。 */
    this.seats = [];
    // 1. 权威对局状态（内部字段含全部手牌与底牌，绝不下发；下发走 snapshotFor）。
    this.game = {
      phase: "idle",
      started: false,
      over: false,
      turn: 0,
      biddingTurn: 0,
      landlordIndex: null,
      multiplier: 1,
      /** 内部：三家手牌（含地主收底后的 20 张），只通过个性化快照发给本人。 */
      hands: [[], [], []],
      /** 内部：底牌（地主确定前不下发给任何人）。 */
      bottomCards: [],
      /** 公开：上一手牌（已出的牌，人人可见）。 */
      lastPlay: null,
      lastPlayerIndex: null,
      passes: 0,
      bidHistory: [],
      highestBidder: null,
      /** 结束时记录先出完的座位（公开）。 */
      winnerSeat: null,
      /** 行动计数（叫分/出牌/不出各 +1，测试与客户端同步用）。 */
      moves: 0,
      message: "房间已创建，等待 3 名玩家加入",
    };
  }

  /** 座位是否已满（满员即自动开局）。
   * @returns {boolean} true 表示满员。
   */
  isFull() {
    return this.seats.length === LANDLORD_PLAYERS;
  }

  /**
   * 某玩家的座位下标。
   *
   * @param {string} playerId - 玩家 id。
   * @returns {number|null} 座位下标，不在座返回 null。
   */
  seatIndexOf(playerId) {
    const index = this.seats.findIndex((seat) => seat.playerId === playerId);
    return index === -1 ? null : index;
  }

  /**
   * 新玩家入座（由 RoomManager 调用）。
   *
   * @param {object} player - 已登记的 player 对象。
   * @param {"host"|"guest"} role - host 为建房者，guest 为加入者。
   */
  seatPlayer(player, role) {
    // 1. 满员后不再入座（RoomManager 已按 maxPlayers 拦截，这里兜底）。
    if (this.isFull()) return;
    this.seats.push({ playerId: player.playerId, nickname: player.nickname });
    player.role = role;
    // 2. 满 3 人自动开局：洗牌发牌进入叫分。
    if (this.isFull() && !this.game.started) {
      this._setupGame();
    } else {
      this.game.message = `已加入（${this.seats.length}/${LANDLORD_PLAYERS}），等待满员开局`;
    }
    this.touch();
  }

  /**
   * 玩家被移除后的善后：回收座位、清空隐私数据、回到等待状态并广播。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因（leave / grace-expired）。
   */
  onPlayerRemoved(player, reason) {
    // 1. 回收座位。
    const index = this.seatIndexOf(player.playerId);
    if (index !== null) this.seats.splice(index, 1);
    // 2. 未满员时回到等待状态：清空全部手牌与底牌（隐私数据不残留）。
    if (!this.isFull()) {
      this.status = "waiting";
      this.game.phase = "idle";
      this.game.started = false;
      this.game.over = false;
      this.game.turn = 0;
      this.game.biddingTurn = 0;
      this.game.landlordIndex = null;
      this.game.multiplier = 1;
      this.game.hands = [[], [], []];
      this.game.bottomCards = [];
      this.game.lastPlay = null;
      this.game.lastPlayerIndex = null;
      this.game.passes = 0;
      this.game.bidHistory = [];
      this.game.highestBidder = null;
      this.game.winnerSeat = null;
      this.game.moves = 0;
      this.game.message = `${player.nickname} 已离开，等待玩家补位后重新开局`;
    }
    this.touch();
    // 3. 事件 + 各玩家可见的个性化快照一起广播。
    this.broadcastEventWithSnapshot("room.player_left", {
      playerId: player.playerId,
      nickname: player.nickname,
      reason,
    });
  }

  /**
   * 玩家断线通知：座位保留，广播最新快照让其他人看到"掉线中"。
   *
   * @param {object} player - 断线玩家。
   */
  onPlayerDisconnected(player) {
    this.broadcastEventWithSnapshot("room.player_disconnected", {
      playerId: player.playerId,
      nickname: player.nickname,
      connected: false,
    });
  }

  /**
   * 公共快照：不含任何手牌/未公布底牌（RoomManager 与测试的兜底入口）。
   *
   * @returns {{room: object, game: object}} 可公开的快照。
   */
  snapshot() {
    return { room: this.describe(), game: this._gameSnapshotFor(null) };
  }

  /**
   * 个性化快照：在公共快照上补该玩家自己的手牌与座位号。
   *
   * @param {string} playerId - 玩家 id。
   * @returns {{room: object, game: object}} 该玩家可见的快照。
   */
  snapshotFor(playerId) {
    const seat = this.seatIndexOf(playerId);
    return { room: this.describe(), game: this._gameSnapshotFor(seat) };
  }

  /**
   * 构造对局快照（按座位过滤私有数据）。
   *
   * @param {number|null} seat - 观看者座位（null 表示纯公共视角，不含任何手牌）。
   * @returns {object} 该视角可见的对局状态。
   */
  _gameSnapshotFor(seat) {
    const g = this.game;
    // 1. 底牌只在地主确定后公布（沿用旧口径：playing/over 阶段人人可见）。
    const bottomRevealed = g.phase === "playing" || g.over;
    return {
      phase: g.phase,
      started: g.started,
      over: g.over,
      turn: g.turn,
      biddingTurn: g.biddingTurn,
      landlordIndex: g.landlordIndex,
      multiplier: g.multiplier,
      /** 座位公开信息：昵称、地主标记、剩余张数——绝不含手牌内容。 */
      seats: this.seats.map((s, index) => ({
        name: s.nickname,
        isLandlord: g.landlordIndex === index,
        handCount: g.hands[index]?.length || 0,
      })),
      /** 已出的牌（公开）。 */
      lastPlay: g.lastPlay ? { type: g.lastPlay.type, count: g.lastPlay.count, power: g.lastPlay.power, cards: g.lastPlay.cards.map((card) => ({ ...card })) } : null,
      lastPlayerIndex: g.lastPlayerIndex,
      passes: g.passes,
      bidHistory: g.bidHistory.map((item) => ({ ...item })),
      bottomCards: bottomRevealed ? g.bottomCards.map((card) => ({ ...card })) : [],
      bottomRevealed,
      winnerSeat: g.winnerSeat,
      moves: g.moves,
      message: g.message,
      /** 座位映射：客户端据此判断自己的座位。 */
      seatPlayerIds: this.seats.map((s) => s.playerId),
      /** 私有字段：仅本人视角附带自己的手牌。 */
      mySeatIndex: seat,
      myHand: seat !== null && seat !== undefined ? g.hands[seat].map((card) => ({ ...card })) : [],
    };
  }

  /**
   * 广播当前对局状态（个性化：每人只收自己可见的快照）。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 操作发起者上下文；
   *   发起者收到的副本带 requestId，可当作该次 game.action 的响应。
   */
  broadcastGame(ctx) {
    const requestId = ctx && ctx.requestId ? ctx.requestId : null;
    for (const player of this.players.values()) {
      if (!player.connected || !player.conn) continue;
      const isRequester = Boolean(requestId && ctx && player.playerId === ctx.playerId);
      const snapshot = this.snapshotFor(player.playerId);
      player.conn.send(makeMessage("game.updated", { snapshot }, isRequester ? requestId : null));
    }
  }

  /**
   * 处理游戏操作意图（服务器唯一状态推进入口）。
   *
   * 支持的动作：
   * - `bid`：{call:boolean} 叫/抢地主（叫分阶段，轮到者）；
   * - `play`：{cards:string[]} 出牌（id 列表，必须全部在手且压过上一手）；
   * - `pass`：不出（上一手存在时）；
   * - `restart`：房主重新发牌。
   *
   * 注意：action 里夹带的任何其它字段（hands/multiplier/turn/...）一概不采纳。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {object} action - {action: string, ...params}。
   * @param {string|null} [requestId] - 发起请求的信封 id。
   * @returns {{ok: boolean, code?: string, detail?: string}} 校验/执行结果。
   */
  handleAction(player, action, requestId) {
    // 1. 必须在座。
    const seatIndex = this.seatIndexOf(player.playerId);
    if (seatIndex === null) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "not seated" };
    const ctx = { playerId: player.playerId, requestId: requestId || null };
    // 2. 分发到具体动作处理器。
    switch (action.action) {
      case "bid":
        return this._applyBid(seatIndex, action, ctx);
      case "play":
        return this._applyPlay(seatIndex, action, ctx);
      case "pass":
        return this._applyPass(seatIndex, ctx);
      case "restart":
        return this._applyRestart(player, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 叫/抢地主。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {object} action - {action:'bid', call:boolean}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyBid(seatIndex, action, ctx) {
    const g = this.game;
    // 1. 状态与轮次校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    if (g.phase !== "bidding") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in bidding phase" };
    if (seatIndex !== g.biddingTurn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your bid turn" };
    // 2. 记录叫分（call 之外的伪造字段不采纳）。
    const call = Boolean(action.call);
    g.bidHistory.push({ index: seatIndex, call });
    g.moves += 1;
    const name = this.seats[seatIndex].nickname;
    if (call) {
      g.highestBidder = seatIndex;
      g.multiplier *= 2;
      const callsSoFar = g.bidHistory.filter((item) => item.call).length;
      g.message = `${name}${callsSoFar > 1 ? " 抢" : " 叫"}地主，倍率 x${g.multiplier}`;
    } else {
      g.message = `${name} 不叫`;
    }
    // 3. 三家都叫完：确定地主并进入出牌阶段。
    if (g.bidHistory.length >= LANDLORD_PLAYERS) {
      this._finalizeLandlord(g.highestBidder === null || g.highestBidder === undefined ? 0 : g.highestBidder);
    } else {
      g.biddingTurn = (g.biddingTurn + 1) % LANDLORD_PLAYERS;
    }
    this.touch();
    this.broadcastGame(ctx);
    if (g.phase === "playing") this.broadcastSnapshot({ event: "game_started" });
    return { ok: true };
  }

  /**
   * 确定地主：收底牌、进入出牌阶段。
   *
   * @param {number} index - 地主座位下标。
   */
  _finalizeLandlord(index) {
    const g = this.game;
    g.landlordIndex = index;
    g.hands[index].push(...g.bottomCards);
    rules.sortHand(g.hands[index]);
    g.phase = "playing";
    g.turn = index;
    g.message = `${this.seats[index].nickname} 成为地主，获得 ${rules.BOTTOM_COUNT} 张底牌`;
  }

  /**
   * 出牌。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {object} action - {action:'play', cards:string[]}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyPlay(seatIndex, action, ctx) {
    const g = this.game;
    // 1. 状态与轮次校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    if (g.phase !== "playing") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in playing phase" };
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    // 2. 交给纯规则模块解析（牌在手、牌型、压牌一次性校验）。
    const verdict = rules.resolvePlay({ hand: g.hands[seatIndex], ids: action.cards, lastPlay: g.lastPlay });
    if (!verdict.ok) {
      return {
        ok: false,
        code: REJECTION_TO_ERROR[verdict.reason] || ErrorCodes.INVALID_MOVE,
        detail: verdict.reason,
      };
    }
    // 3. 推进权威状态：炸弹/王炸翻倍、移除手牌、记录上一手。
    if (verdict.play.type === "bomb" || verdict.play.type === "rocket") g.multiplier *= 2;
    g.hands[seatIndex] = rules.removeCards(g.hands[seatIndex], verdict.cards);
    g.moves += 1;
    g.lastPlay = { ...verdict.play, cards: verdict.cards.map((card) => ({ ...card })) };
    g.lastPlayerIndex = seatIndex;
    g.passes = 0;
    const name = this.seats[seatIndex].nickname;
    // 4. 手牌出完即结束。
    if (!g.hands[seatIndex].length) {
      g.over = true;
      g.winnerSeat = seatIndex;
      const isLandlord = g.landlordIndex === seatIndex;
      g.message = `${name}${isLandlord ? "（地主）" : "（农民）"}获胜，倍率 x${g.multiplier}`;
      this.status = "finished";
    } else {
      g.message = `${name} 出了 ${verdict.cards.length} 张牌`;
      g.turn = (g.turn + 1) % LANDLORD_PLAYERS;
    }
    this.touch();
    this.broadcastGame(ctx);
    if (g.over) this.broadcastSnapshot({ event: "game_finished" });
    return { ok: true };
  }

  /**
   * 不出（上一手存在时）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyPass(seatIndex, ctx) {
    const g = this.game;
    // 1. 状态与轮次校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    if (g.phase !== "playing") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in playing phase" };
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    // 2. 领出时不能不出。
    if (!g.lastPlay) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "must lead a play" };
    // 3. 连续两家不出：一轮结束，重新领出。
    g.passes += 1;
    g.moves += 1;
    const name = this.seats[seatIndex].nickname;
    if (g.passes >= LANDLORD_PLAYERS - 1) {
      g.lastPlay = null;
      g.lastPlayerIndex = null;
      g.passes = 0;
      g.message = "一轮结束，可以重新领出";
    } else {
      g.message = `${name} 不出`;
    }
    g.turn = (g.turn + 1) % LANDLORD_PLAYERS;
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 房主重新发牌。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRestart(player, ctx) {
    // 1. 仅房主可重开。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    // 2. 必须满员才有对局可重开。
    if (!this.isFull()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    // 3. 重新洗牌发牌。
    this._setupGame();
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /**
   * 洗牌发牌并进入叫分阶段（服务器 crypto 洗牌）。
   */
  _setupGame() {
    const g = this.game;
    // 1. 洗牌（服务器随机源）。
    const deck = rules.shuffleDeck(rules.buildDeck(), (min, max) => crypto.randomInt(min, max));
    // 2. 发牌：前 51 张按座位轮发，最后 3 张为底牌。
    g.hands = [[], [], []];
    deck.slice(0, rules.HAND_COUNT * LANDLORD_PLAYERS).forEach((card, index) => {
      g.hands[index % LANDLORD_PLAYERS].push(card);
    });
    g.hands.forEach((hand) => rules.sortHand(hand));
    g.bottomCards = deck.slice(rules.HAND_COUNT * LANDLORD_PLAYERS);
    // 3. 进入叫分阶段。
    g.phase = "bidding";
    g.started = true;
    g.over = false;
    g.turn = 0;
    g.biddingTurn = 0;
    g.landlordIndex = null;
    g.multiplier = 1;
    g.lastPlay = null;
    g.lastPlayerIndex = null;
    g.passes = 0;
    g.bidHistory = [];
    g.highestBidder = null;
    g.winnerSeat = null;
    g.moves = 0;
    g.message = `${this.seats[0].nickname} 先叫地主`;
    this.status = "playing";
  }
}

module.exports = { LandlordRoom };
