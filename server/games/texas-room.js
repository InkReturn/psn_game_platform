/**
 * 德州扑克服务器权威房间（2-6 人，隐藏信息）。
 *
 * 权威边界（复用 personalizedSnapshots 私有快照基础设施）：
 * - 服务器持有完整牌堆、各家底牌、公共牌（按阶段逐张公开）、下注与底池；
 * - 客户端只发操作意图（check_call / raise / fold / start / restart）；
 * - 洗牌由服务器 crypto 完成；客户端夹带的任何底牌/底池字段一概不采纳；
 * - 快照按玩家个性化下发：底牌只发给本人；摊牌/弃牌终局前他人底牌
 *   只发张数；未来公共牌与牌堆顺序永不下发；终局后全部公开（沿用旧口径）。
 */
"use strict";

const crypto = require("crypto");
const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于展示），避免规则实现漂移成两份。
const rules = require("../../texas-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

/**
 * 德州扑克权威房间（简化版玩法：前注 10、固定加注 20、无边池）。
 *
 * 座位约定：房主占 0 号位，随后加入者依次入座；满 playerCount 人自动开局。
 * 一手结束后由房主开下一手（庄家位轮转、筹码延续）；房主也可整桌重置。
 * 玩家中途离开时房间回到等待状态并清空底牌（隐私数据不残留）。
 */
class TexasRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {object} [payload] - 建房负载（可含 playerCount，默认 2）。
   */
  constructor(roomId, payload = {}) {
    super(roomId, "texas");
    this.status = "waiting";
    // 1. 玩家数：建房时由房主选定（2..6）。
    const requested = Number(payload.playerCount);
    this.playerCount = Number.isInteger(requested) && requested >= rules.MIN_PLAYERS && requested <= rules.MAX_PLAYERS ? requested : rules.MIN_PLAYERS;
    this.maxPlayers = this.playerCount;
    /** 启用个性化快照：广播与加入/重连响应都按玩家过滤私有数据。 */
    this.personalizedSnapshots = true;
    /** 座位表：按入座顺序排列的 {playerId, nickname}。 */
    this.seats = [];
    // 2. 权威对局状态（内部字段含全部底牌与牌堆，绝不下发；下发走 snapshotFor）。
    this.game = {
      phase: "idle",
      started: false,
      over: false,
      turn: 0,
      dealer: -1,
      pot: 0,
      currentBet: 0,
      winners: [],
      moves: 0,
      /** 内部：各家底牌（只通过个性化快照发给本人；终局后公开）。 */
      hands: [],
      /** 内部：公共牌（按阶段推进，进度内人人可见）。 */
      community: [],
      /** 内部：牌堆（永不下发）。 */
      deck: [],
      /** 内部：各座位下注状态。 */
      seatStates: [],
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
    this.game.seatStates.push({ stack: rules.START_STACK, bet: 0, folded: false, acted: false });
    this.game.hands.push([]);
    // 2. 满员即自动开局：洗牌发牌。
    if (this.isFull() && !this.game.started) {
      this._setupHand();
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
    // 2. 未满员时回到等待状态：清空全部底牌与牌堆（隐私数据不残留）。
    if (!this.isFull()) {
      this.status = "waiting";
      this.game.phase = "idle";
      this.game.started = false;
      this.game.over = false;
      this.game.turn = 0;
      this.game.dealer = -1;
      this.game.pot = 0;
      this.game.currentBet = 0;
      this.game.winners = [];
      this.game.moves = 0;
      this.game.hands = this.game.hands.map(() => []);
      this.game.community = [];
      this.game.deck = [];
      this.game.seatStates = this.game.seatStates.map(() => ({ stack: rules.START_STACK, bet: 0, folded: false, acted: false }));
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
   * 公共快照：不含任何底牌/牌堆（RoomManager 与测试的兜底入口）。
   *
   * @returns {{room: object, game: object}} 可公开的快照。
   */
  snapshot() {
    return { room: this.describe(), game: this._gameSnapshotFor(null) };
  }

  /**
   * 个性化快照：在公共快照上补该玩家自己的底牌与座位号。
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
   * - 底牌只发给本人（终局后全部公开，沿用旧口径）；
   * - 公共牌按当前阶段进度下发（未来公共牌永不下发）；
   * - 牌堆永不下发。
   *
   * @param {number|null} seat - 观看者座位（null 表示纯公共视角）。
   * @returns {object} 该视角可见的对局状态。
   */
  _gameSnapshotFor(seat) {
    const g = this.game;
    const revealed = g.over;
    return {
      phase: g.phase,
      started: g.started,
      over: g.over,
      turn: g.turn,
      dealer: g.dealer,
      pot: g.pot,
      currentBet: g.currentBet,
      winners: [...g.winners],
      moves: g.moves,
      community: g.community.map((card) => ({ ...card })),
      /** 座位公开信息：昵称、筹码、本轮注额、弃牌、张数——底牌按需下发。 */
      seats: this.seats.map((s, index) => ({
        name: s.nickname,
        stack: g.seatStates[index]?.stack ?? rules.START_STACK,
        bet: g.seatStates[index]?.bet ?? 0,
        folded: g.seatStates[index]?.folded ?? false,
        handCount: g.hands[index]?.length || 0,
        /** 终局后公开全部底牌（含弃牌者，沿用旧口径）；终局前不下发他人底牌。 */
        hand: revealed ? g.hands[index].map((card) => ({ ...card })) : null,
      })),
      message: g.message,
      seatPlayerIds: this.seats.map((s) => s.playerId),
      /** 私有字段：仅本人视角附带自己的底牌。 */
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
   * - `check_call`：过牌（无需跟注时）或跟注到当前注额（钳制到剩余筹码）；
   * - `raise`：加注（固定 +20，钳制到剩余筹码；把其他未弃牌者标记为未行动）；
   * - `fold`：弃牌（仅当前注额 > 0 时，沿用旧 UI 口径）；
   * - `start`：房主开下一手（筹码延续、庄家位轮转）；
   * - `restart`：房主整桌重置（筹码回起始值）。
   *
   * 注意：action 里夹带的任何其它字段（hands/pot/turn/...）一概不采纳。
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
      case "check_call":
        return this._applyCheckCall(seatIndex, ctx);
      case "raise":
        return this._applyRaise(seatIndex, ctx);
      case "fold":
        return this._applyFold(seatIndex, ctx);
      case "start":
        return this._applyStart(player, ctx);
      case "restart":
        return this._applyRestart(player, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 校验下注动作的公共前置（状态、轮次）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @returns {{ok: boolean, code?: string, detail?: string}} 校验结果。
   */
  _validateBettingAction(seatIndex) {
    const g = this.game;
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "hand over, start a new one" };
    if (g.phase === "idle" || g.phase === "showdown") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not in a betting phase" };
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    return { ok: true };
  }

  /**
   * 过牌/跟注（钳制到剩余筹码）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyCheckCall(seatIndex, ctx) {
    // 1. 前置校验。
    const verdict = this._validateBettingAction(seatIndex);
    if (!verdict.ok) return verdict;
    const g = this.game;
    // 2. 跟注差额（钳制到剩余筹码，沿用旧口径）。
    const seat = g.seatStates[seatIndex];
    const diff = Math.max(0, g.currentBet - seat.bet);
    const paid = Math.min(diff, seat.stack);
    seat.stack -= paid;
    seat.bet += paid;
    g.pot += paid;
    // 3. 推进轮次。
    this._commitAction(seatIndex, diff ? `跟注 ${paid}` : "过牌");
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 加注（固定 +20，钳制到剩余筹码）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRaise(seatIndex, ctx) {
    // 1. 前置校验。
    const verdict = this._validateBettingAction(seatIndex);
    if (!verdict.ok) return verdict;
    const g = this.game;
    const seat = g.seatStates[seatIndex];
    // 2. 目标注额 = 当前注 + 固定加注额；差额钳制到剩余筹码。
    const target = g.currentBet + rules.RAISE_STEP;
    const diff = Math.max(0, target - seat.bet);
    const paid = Math.min(diff, seat.stack);
    if (paid <= 0) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "not enough stack to raise" };
    // 3. 推进下注并重置其他未弃牌者的行动标记（沿用旧口径）。
    seat.stack -= paid;
    seat.bet += paid;
    g.pot += paid;
    g.currentBet = seat.bet;
    g.seatStates.forEach((other) => {
      if (!other.folded) other.acted = false;
    });
    this._commitAction(seatIndex, `加注到 ${seat.bet}`);
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 弃牌（仅当前注额 > 0 时，沿用旧 UI 口径）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyFold(seatIndex, ctx) {
    // 1. 前置校验。
    const verdict = this._validateBettingAction(seatIndex);
    if (!verdict.ok) return verdict;
    const g = this.game;
    // 2. 无需跟注时不能弃牌（旧 UI 的 fold 按钮在 currentBet=0 时禁用）。
    if (g.currentBet === 0) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "cannot fold when check is free" };
    // 3. 弃牌并推进。
    g.seatStates[seatIndex].folded = true;
    this._commitAction(seatIndex, "弃牌");
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 行动后的轮次推进（沿用旧 commitAction 口径）。
   *
   * @param {number} seatIndex - 行动者座位下标。
   * @param {string} label - 行动描述（消息用）。
   */
  _commitAction(seatIndex, label) {
    const g = this.game;
    g.seatStates[seatIndex].acted = true;
    g.moves += 1;
    g.message = `${this.seats[seatIndex].nickname} ${label}`;
    // 1. 只剩一名未弃牌者：立即结束（弃牌获胜）。
    const active = g.seatStates.filter((seat) => !seat.folded);
    if (active.length === 1) {
      const winnerIndex = g.seatStates.findIndex((seat) => !seat.folded);
      active[0].stack += g.pot;
      g.winners = [winnerIndex];
      g.phase = "showdown";
      g.over = true;
      g.message = `${this.seats[winnerIndex].nickname} 赢得底池 ${g.pot}`;
      this.status = "finished";
      return;
    }
    // 2. 本轮下注完成：推进公共牌阶段或摊牌。
    if (rules.roundComplete(g.seatStates, g.currentBet)) {
      this._advanceStreet();
      return;
    }
    // 3. 否则轮到下一个未弃牌者。
    g.turn = rules.nextActiveIndex(g.seatStates.map((seat) => seat.folded), seatIndex);
  }

  /**
   * 推进公共牌阶段（翻牌/转牌/河牌/摊牌）。
   */
  _advanceStreet() {
    const g = this.game;
    if (g.phase === "preflop") {
      g.community.push(g.deck.pop(), g.deck.pop(), g.deck.pop());
      g.phase = "flop";
      g.message = "翻牌圈开始";
    } else if (g.phase === "flop") {
      g.community.push(g.deck.pop());
      g.phase = "turn";
      g.message = "转牌圈开始";
    } else if (g.phase === "turn") {
      g.community.push(g.deck.pop());
      g.phase = "river";
      g.message = "河牌圈开始";
    } else {
      this._showdown();
      return;
    }
    // 1. 重置本轮下注：注额清零、未弃牌者待行动。
    g.currentBet = 0;
    g.seatStates.forEach((seat) => {
      seat.bet = 0;
      seat.acted = seat.folded;
    });
    g.turn = rules.nextActiveIndex(g.seatStates.map((seat) => seat.folded), g.dealer);
  }

  /**
   * 摊牌结算（委托纯规则模块）。
   */
  _showdown() {
    const g = this.game;
    const result = rules.evaluateShowdown({
      hands: g.hands,
      folded: g.seatStates.map((seat) => seat.folded),
      community: g.community,
      pot: g.pot,
    });
    result.winners.forEach((index) => {
      g.seatStates[index].stack += result.share;
    });
    g.winners = result.winners;
    g.phase = "showdown";
    g.over = true;
    g.message = `${result.winners.map((index) => this.seats[index].nickname).join("、")} 赢得底池 ${g.pot}`;
    this.status = "finished";
  }

  /**
   * 房主开下一手（筹码延续、庄家位轮转）。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyStart(player, ctx) {
    // 1. 仅房主可开下一手。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    // 2. 必须满员且上一手已结束（或从未开始）。
    if (!this.isFull()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (this.game.started && !this.game.over) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "hand in progress" };
    // 3. 发下一手。
    this._setupHand();
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
    this.game.seatStates = this.seats.map(() => ({ stack: rules.START_STACK, bet: 0, folded: false, acted: false }));
    this.game.hands = this.seats.map(() => []);
    this.game.community = [];
    this.game.deck = [];
    this.game.phase = "idle";
    this.game.started = false;
    this.game.over = false;
    this.game.turn = 0;
    this.game.dealer = -1;
    this.game.pot = 0;
    this.game.currentBet = 0;
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
   * 洗牌发牌开一手（服务器 crypto 洗牌；筹码延续、庄家位轮转）。
   */
  _setupHand() {
    const g = this.game;
    // 1. 洗牌（服务器随机源）。
    g.deck = rules.shuffleDeck(rules.buildDeck(), (min, max) => crypto.randomInt(min, max));
    // 2. 发底牌 + 收前注（沿用旧口径：每家 min(前注, 剩余筹码)）。
    g.hands = this.seats.map(() => [g.deck.pop(), g.deck.pop()]);
    g.community = [];
    g.pot = 0;
    g.currentBet = rules.ANTE;
    g.dealer = (g.dealer + 1) % this.seats.length;
    g.seatStates = g.seatStates.map((state) => {
      const bet = Math.min(rules.ANTE, state.stack);
      return { stack: state.stack - bet, bet, folded: false, acted: false };
    });
    g.pot = g.seatStates.reduce((sum, state) => sum + state.bet, 0);
    // 3. 前注后进入翻牌前下注轮。
    g.phase = "preflop";
    g.started = true;
    g.over = false;
    g.winners = [];
    g.moves = 0;
    g.turn = rules.nextActiveIndex(g.seatStates.map((seat) => seat.folded), g.dealer);
    g.message = "翻牌前下注开始";
    this.status = "playing";
  }
}

module.exports = { TexasRoom };
