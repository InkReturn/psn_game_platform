/**
 * 21 点服务器权威房间（1-3 人对庄家，隐藏信息）。
 *
 * 权威边界（复用 personalizedSnapshots 私有快照基础设施）：
 * - 服务器持有完整牌堆、各家手牌、庄家手牌（含暗牌）、轮次与结算；
 * - 客户端只发操作意图（hit / stand / start / restart）；
 * - 洗牌由服务器 crypto 完成；客户端夹带的任何手牌/轮次字段一概不采纳；
 * - 快照按玩家个性化下发：庄家暗牌结算前不下发（只发明牌），
 *   其他玩家手牌结算前不下发（只发张数），牌堆顺序永不下发；
 *   结算后全部公开（便于核对胜负与派彩）。
 */
"use strict";

const crypto = require("crypto");
const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于点数显示），避免规则实现漂移成两份。
const rules = require("../../blackjack-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

/**
 * 21 点权威房间。
 *
 * 座位约定：房主占 0 号位，随后加入者依次入座；满 playerCount 人自动发牌开局。
 * 一局结束后由房主发起新一局（保留筹码）；房主也可整桌重置（筹码回到起始值）。
 * 玩家中途离开时房间回到等待状态并清空所有手牌（隐私数据不残留）。
 */
class BlackjackRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {object} [payload] - 建房负载（可含 playerCount，默认 2）。
   */
  constructor(roomId, payload = {}) {
    super(roomId, "blackjack");
    this.status = "waiting";
    // 1. 玩家数：建房时由房主选定（1..3，对庄家）。
    const requested = Number(payload.playerCount);
    this.playerCount = Number.isInteger(requested) && requested >= rules.MIN_PLAYERS && requested <= rules.MAX_PLAYERS ? requested : 2;
    this.maxPlayers = this.playerCount;
    /** 启用个性化快照：广播与加入/重连响应都按玩家过滤私有数据。 */
    this.personalizedSnapshots = true;
    /** 座位表：按入座顺序排列的 {playerId, nickname}。 */
    this.seats = [];
    // 2. 权威对局状态（内部字段含全部手牌与牌堆，绝不下发；下发走 snapshotFor）。
    this.game = {
      phase: "idle",
      started: false,
      over: false,
      turn: 0,
      winners: [],
      moves: 0,
      /** 内部：玩家手牌（只通过个性化快照发给本人；结算后公开）。 */
      hands: [],
      /** 内部：玩家状态（停牌/爆牌/底注/筹码）。 */
      seatStates: [],
      /** 内部：庄家手牌（暗牌结算前不下发）。 */
      dealerHand: [],
      /** 内部：牌堆（永不下发）。 */
      deck: [],
      message: "房间已创建，等待玩家加入",
    };
  }

  /** 座位是否已满（满员即自动开局）。
   * @returns {boolean} true 表示满员。
   */
  isFull() {
    return this.seats.length === this.playerCount;
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
    // 2. 初始化座位状态（筹码）。
    this.game.seatStates.push({ stood: false, busted: false, bet: rules.BET, chips: rules.START_CHIPS });
    this.game.hands.push([]);
    // 3. 满员即自动开局：洗牌发牌。
    if (this.isFull() && !this.game.started) {
      this._setupRound();
    } else {
      this.game.message = `已加入（${this.seats.length}/${this.playerCount}），等待满员开局`;
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
    // 1. 回收座位与对应状态。
    const index = this.seatIndexOf(player.playerId);
    if (index !== null) {
      this.seats.splice(index, 1);
      this.game.seatStates.splice(index, 1);
      this.game.hands.splice(index, 1);
    }
    // 2. 未满员时回到等待状态：清空全部手牌与牌堆（隐私数据不残留）。
    if (!this.isFull()) {
      this.status = "waiting";
      this.game.phase = "idle";
      this.game.started = false;
      this.game.over = false;
      this.game.turn = 0;
      this.game.winners = [];
      this.game.moves = 0;
      this.game.hands = this.game.hands.map(() => []);
      this.game.dealerHand = [];
      this.game.deck = [];
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
   * 公共快照：不含任何手牌/暗牌/牌堆（RoomManager 与测试的兜底入口）。
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
   * 隐私规则：
   * - 庄家暗牌（第 2 张起）结算前不下发，只发明牌与总张数；
   * - 其他玩家手牌结算前不下发，只发张数；结算后全部公开；
   * - 牌堆永不下发。
   *
   * @param {number|null} seat - 观看者座位（null 表示纯公共视角）。
   * @returns {object} 该视角可见的对局状态。
   */
  _gameSnapshotFor(seat) {
    const g = this.game;
    const revealed = g.over;
    // 1. 庄家：结算前只发明牌（第 1 张），结算后发全部。
    const dealerVisible = revealed ? g.dealerHand.map((card) => ({ ...card })) : g.dealerHand.slice(0, 1).map((card) => ({ ...card }));
    return {
      phase: g.phase,
      started: g.started,
      over: g.over,
      turn: g.turn,
      winners: [...g.winners],
      moves: g.moves,
      /** 座位公开信息：昵称、停牌/爆牌、底注、筹码、张数——手牌内容按需下发。 */
      seats: this.seats.map((s, index) => ({
        name: s.nickname,
        stood: g.seatStates[index]?.stood || false,
        busted: g.seatStates[index]?.busted || false,
        bet: g.seatStates[index]?.bet || rules.BET,
        chips: g.seatStates[index]?.chips || rules.START_CHIPS,
        handCount: g.hands[index]?.length || 0,
        /** 结算后公开全部手牌（核对胜负）；结算前不下发他人手牌。 */
        hand: revealed ? g.hands[index].map((card) => ({ ...card })) : null,
      })),
      /** 庄家：明牌 + 总张数（暗牌张数 = handCount - cards.length）。 */
      dealer: {
        cards: dealerVisible,
        handCount: g.dealerHand.length,
        hidden: !revealed,
        score: revealed ? rules.handValue(g.dealerHand) : null,
      },
      message: g.message,
      seatPlayerIds: this.seats.map((s) => s.playerId),
      /** 私有字段：仅本人视角附带自己的手牌（结算前也始终可见）。 */
      mySeatIndex: seat,
      myHand: seat !== null && seat !== undefined ? g.hands[seat].map((card) => ({ ...card })) : [],
    };
  }

  /**
   * 广播当前对局状态（个性化：每人只收自己可见的快照）。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 操作发起者上下文。
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
   * - `hit`：当前回合方要牌（服务器从自己的牌堆发牌）；
   * - `stand`：当前回合方停牌；
   * - `start`：房主开新一局（一局结束后保留筹码再发一轮）；
   * - `restart`：房主整桌重置（筹码回起始值，回到等待）。
   *
   * 注意：action 里夹带的任何其它字段（hands/dealer/turn/...）一概不采纳。
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
      case "hit":
        return this._applyHit(seatIndex, ctx);
      case "stand":
        return this._applyStand(seatIndex, ctx);
      case "start":
        return this._applyStart(player, ctx);
      case "restart":
        return this._applyRestart(player, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 要牌（服务器从自己的牌堆发牌）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyHit(seatIndex, ctx) {
    const g = this.game;
    // 1. 状态与轮次校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "round over, start a new one" };
    if (g.phase !== "player") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in player phase" };
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    // 2. 发牌并推进（服务器牌堆，客户端夹带的牌不采纳）。
    const hand = g.hands[seatIndex];
    const state = g.seatStates[seatIndex];
    hand.push(g.deck.pop());
    g.moves += 1;
    if (rules.handValue(hand) > 21) {
      state.busted = true;
      state.stood = true;
      g.message = `${this.seats[seatIndex].nickname} 爆牌`;
    } else {
      g.message = `${this.seats[seatIndex].nickname} 要牌`;
    }
    // 3. 全部停牌/爆牌则结算，否则轮到下一个可操作座位。
    this._advanceOrSettle();
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 停牌。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyStand(seatIndex, ctx) {
    const g = this.game;
    // 1. 状态与轮次校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "round over, start a new one" };
    if (g.phase !== "player") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in player phase" };
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    // 2. 停牌并推进。
    g.seatStates[seatIndex].stood = true;
    g.moves += 1;
    g.message = `${this.seats[seatIndex].nickname} 停牌`;
    this._advanceOrSettle();
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 推进轮次或结算（全部停牌/爆牌时）。
   */
  _advanceOrSettle() {
    const g = this.game;
    if (rules.allSettled(g.seatStates)) {
      this._settle();
      return;
    }
    g.turn = rules.nextPlayable(g.seatStates, (g.turn + 1) % g.seatStates.length);
    g.message = `${this.seats[g.turn].nickname} 操作`;
  }

  /**
   * 结算：庄家补牌、判定赢家、派彩（委托纯规则模块）。
   */
  _settle() {
    const g = this.game;
    g.phase = "dealer";
    const result = rules.settle({ seats: g.seatStates, hands: g.hands, dealerHand: g.dealerHand, deck: g.deck });
    g.seatStates = result.seats;
    g.dealerHand = result.dealerHand;
    g.winners = result.winners;
    g.over = true;
    g.phase = "showdown";
    g.message = result.winners.length ? `${result.winners.map((index) => this.seats[index].nickname).join("、")} 赢了` : "庄家赢了";
    this.status = "finished";
  }

  /**
   * 房主开新一局（保留筹码）。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyStart(player, ctx) {
    // 1. 仅房主可开新一局。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    // 2. 必须满员且上一局已结束（或从未开始）。
    if (!this.isFull()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (this.game.started && !this.game.over) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "round in progress" };
    // 3. 发新一局（保留筹码）。
    this._setupRound();
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_started" });
    return { ok: true };
  }

  /**
   * 房主整桌重置（筹码回起始值，回到等待）。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRestart(player, ctx) {
    // 1. 仅房主可重置。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    // 2. 筹码回起始值并回到等待状态。
    this.game.seatStates = this.seats.map(() => ({ stood: false, busted: false, bet: rules.BET, chips: rules.START_CHIPS }));
    this.game.hands = this.seats.map(() => []);
    this.game.dealerHand = [];
    this.game.deck = [];
    this.game.phase = "idle";
    this.game.started = false;
    this.game.over = false;
    this.game.turn = 0;
    this.game.winners = [];
    this.game.moves = 0;
    this.game.message = "牌桌已重置，等待开局";
    this.status = "waiting";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /**
   * 洗牌发牌开一局（服务器 crypto 洗牌；保留筹码）。
   */
  _setupRound() {
    const g = this.game;
    // 1. 洗牌（服务器随机源）。
    g.deck = rules.shuffleDeck(rules.buildDeck(), (min, max) => crypto.randomInt(min, max));
    // 2. 发牌：庄家 2 张（第 2 张为暗牌），每家 2 张。
    g.dealerHand = [g.deck.pop(), g.deck.pop()];
    g.hands = this.seats.map(() => [g.deck.pop(), g.deck.pop()]);
    g.seatStates = g.seatStates.map((state) => ({ ...state, stood: false, busted: false }));
    // 3. 进入玩家操作阶段。
    g.phase = "player";
    g.started = true;
    g.over = false;
    g.winners = [];
    g.moves = 0;
    g.turn = rules.nextPlayable(g.seatStates, 0);
    g.message = `${this.seats[g.turn].nickname} 操作`;
    this.status = "playing";
  }
}

module.exports = { BlackjackRoom };
