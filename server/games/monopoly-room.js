/**
 * 大富翁服务器权威房间（2-4 人，环球地产简化版）。
 *
 * 权威边界：
 * - 服务器持有玩家资金/位置/房产、地块归属、轮次、骰子、待购买状态与终局；
 * - 客户端只发操作意图（roll / purchase / restart）；
 * - 骰子与机会事件金额必须由服务器产生（crypto）：客户端在 action 里夹带的
 *   dice/chance 字段一概不采纳；
 * - 规则推进委托给纯规则模块 monopoly-rules.js（服务端与浏览器共用同一份）；
 * - 房主创建房间时选定玩家数（playerCount），满员即自动开局。
 */
"use strict";

const crypto = require("crypto");
const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于展示），避免规则实现漂移成两份。
const rules = require("../../monopoly-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

/**
 * 大富翁权威房间。
 *
 * 座位约定：房主占 0 号位（红方），随后加入者依次入座；满 playerCount 人自动开局。
 * 玩家中途离开时房间回到等待状态，重新满员后再次自动开局（清盘重开）。
 */
class MonopolyRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {object} [payload] - 建房负载（可含 playerCount，默认 2）。
   */
  constructor(roomId, payload = {}) {
    super(roomId, "monopoly");
    this.status = "waiting";
    // 1. 玩家数：建房时由房主选定，之后不再变化。
    const requested = Number(payload.playerCount);
    this.playerCount = Number.isInteger(requested) && requested >= rules.MIN_PLAYERS && requested <= rules.MAX_PLAYERS ? requested : rules.MIN_PLAYERS;
    this.maxPlayers = this.playerCount;
    /** 座位表：按入座顺序排列的 {playerId, nickname}。 */
    this.seats = [];
    // 2. 权威对局状态（字段与旧客户端状态对齐，渲染层可直接消费）。
    this.game = {
      players: [],
      cells: [],
      turn: 0,
      dice: 0,
      started: false,
      over: false,
      pendingPurchase: null,
      playerCount: this.playerCount,
      moves: 0,
      status: "房间已创建，等待玩家加入",
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
    // 2. 满员即自动开局：清盘摆子、红方（0 号位）先走。
    if (this.isFull() && !this.game.started) {
      this._setupGame();
      this.game.status = `${this.game.players.length} 人大富翁开始`;
    } else {
      this.game.status = `已加入（${this.seats.length}/${this.playerCount}），等待满员开局`;
    }
    this.touch();
  }

  /**
   * 玩家被移除后的善后：回收座位、回到等待状态并广播。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因（leave / grace-expired）。
   */
  onPlayerRemoved(player, reason) {
    // 1. 回收座位。
    const index = this.seatIndexOf(player.playerId);
    if (index !== null) this.seats.splice(index, 1);
    // 2. 未满员时回到等待状态：进行中的对局作废，重新满员后自动清盘开局。
    if (!this.isFull()) {
      this.status = "waiting";
      this.game.started = false;
      this.game.over = false;
      this.game.players = [];
      this.game.cells = [];
      this.game.turn = 0;
      this.game.dice = 0;
      this.game.pendingPurchase = null;
      this.game.moves = 0;
      this.game.status = `${player.nickname} 已离开，等待玩家补位后重新开局`;
    }
    this.touch();
    // 3. 事件 + 最新权威快照一起广播，客户端直接覆盖视图。
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
   * 权威快照（room + game 两部分）。
   *
   * @returns {{room: object, game: object}} 可直接序列化的快照。
   */
  snapshot() {
    return { room: this.describe(), game: this.gameSnapshot() };
  }

  /**
   * 对局快照。
   *
   * @returns {object} 与客户端渲染字段一一对应的权威状态。
   */
  gameSnapshot() {
    const g = this.game;
    return {
      players: g.players.map((p) => ({ ...p, properties: [...p.properties] })),
      cells: g.cells.map((c) => ({ ...c })),
      turn: g.turn,
      dice: g.dice,
      started: g.started,
      over: g.over,
      pendingPurchase: g.pendingPurchase ? { ...g.pendingPurchase } : null,
      playerCount: g.playerCount,
      moves: g.moves,
      /** 座位映射：客户端据此判断自己控制哪个玩家。 */
      seatPlayerIds: this.seats.map((seat) => seat.playerId),
      status: g.status,
    };
  }

  /**
   * 广播当前对局状态。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 操作发起者上下文；
   *   发起者收到的副本带 requestId，可当作该次 game.action 的响应。
   */
  broadcastGame(ctx) {
    const snapshot = this.snapshot();
    const requestId = ctx && ctx.requestId ? ctx.requestId : null;
    for (const player of this.players.values()) {
      if (!player.connected || !player.conn) continue;
      const isRequester = Boolean(requestId && ctx && player.playerId === ctx.playerId);
      player.conn.send(makeMessage("game.updated", { snapshot }, isRequester ? requestId : null));
    }
  }

  /**
   * 处理游戏操作意图（服务器唯一状态推进入口）。
   *
   * 支持的动作：
   * - `roll`：当前回合方掷骰（骰子与机会金额由服务器 crypto 生成）；
   * - `purchase`：{buy:boolean} 决定是否购买当前待购买地块（仅待购买玩家）；
   * - `restart`：房主重新开局（清盘、轮次归零）。
   *
   * 注意：action 里夹带的任何其它字段（players/cells/dice/...）一概不采纳。
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
      case "roll":
        return this._applyRoll(seatIndex, ctx);
      case "purchase":
        return this._applyPurchase(seatIndex, action, ctx);
      case "restart":
        return this._applyRestart(player, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 掷骰（骰子与机会金额由服务器生成）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRoll(seatIndex, ctx) {
    const g = this.game;
    // 1. 状态校验。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    // 2. 轮次校验。
    if (seatIndex !== g.turn) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your turn" };
    // 3. 待购买未决时不能掷骰。
    if (g.pendingPurchase) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "purchase pending" };
    // 4. 服务器权威随机：骰子 1..6 + 机会金额（+$120 / -$80）。
    const dice = crypto.randomInt(1, 7);
    const chanceBonus = crypto.randomInt(0, 2) === 0 ? rules.CHANCE_BONUS : rules.CHANCE_PENALTY;
    // 5. 交给纯规则模块推进。
    const applied = rules.applyRoll({ players: g.players, cells: g.cells, turn: g.turn, dice, chanceBonus });
    g.players = applied.players;
    g.cells = applied.cells;
    g.turn = applied.turn;
    g.dice = dice;
    g.pendingPurchase = applied.pendingPurchase;
    g.moves += 1;
    g.status = applied.status;
    if (applied.over) {
      g.over = true;
      this.status = "finished";
    }
    this.touch();
    this.broadcastGame(ctx);
    if (applied.over) this.broadcastSnapshot({ event: "game_finished" });
    return { ok: true };
  }

  /**
   * 处理购买决定（仅待购买玩家本人）。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {object} action - {action:'purchase', buy:boolean}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyPurchase(seatIndex, action, ctx) {
    const g = this.game;
    // 1. 必须有待购买地块。
    if (!g.pendingPurchase) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no purchase pending" };
    // 2. 只有待购买玩家本人能决定。
    if (g.pendingPurchase.playerIndex !== seatIndex) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: "not your purchase" };
    // 3. 交给纯规则模块推进（buy 参数之外的伪造字段不采纳）。
    const applied = rules.applyPurchase({ players: g.players, cells: g.cells, pendingPurchase: g.pendingPurchase, buy: Boolean(action.buy) });
    g.players = applied.players;
    g.cells = applied.cells;
    g.turn = applied.turn;
    g.pendingPurchase = null;
    g.moves += 1;
    g.status = applied.status;
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 房主重新开局（清盘、轮次归零）。
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
    // 3. 清盘重开。
    this._setupGame();
    this.game.status = "已重新开局";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /**
   * 复位对局状态（不动座位与昵称）。
   */
  _setupGame() {
    const g = this.game;
    // 1. 按规则模块的开局配置摆子，并补上各座位的昵称。
    g.players = rules.createPlayers(this.playerCount).map((p, index) => ({
      ...p,
      name: this.seats[index]?.nickname || p.name,
    }));
    g.cells = rules.createCellStates();
    g.turn = 0;
    g.dice = 0;
    g.started = true;
    g.over = false;
    g.pendingPurchase = null;
    g.moves = 0;
    this.status = "playing";
  }
}

module.exports = { MonopolyRoom };
