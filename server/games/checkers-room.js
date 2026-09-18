/**
 * 跳棋服务器权威房间（2-6 人六角星棋盘）。
 *
 * 权威边界：
 * - 服务器持有棋子位置、轮次、胜负与走子记录；客户端只发操作意图（move / restart）；
 * - 规则判定全部委托给纯规则模块 checkers-rules.js（服务端与浏览器共用同一份）；
 * - 房主创建房间时选定玩家数（playerCount），房间满员即自动开局；
 * - 快照字段与改造前 checkers.js 的客户端状态对齐，渲染层可直接复用。
 */
"use strict";

const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于可落子提示），避免规则实现漂移成两份。
const rules = require("../../checkers-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

/** 走法拒绝原因 -> 协议错误码。 */
const REJECTION_TO_ERROR = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: ErrorCodes.GAME_NOT_STARTED,
  [rules.MoveRejection.FINISHED]: ErrorCodes.GAME_ALREADY_FINISHED,
  [rules.MoveRejection.NOT_YOUR_TURN]: ErrorCodes.NOT_YOUR_TURN,
  [rules.MoveRejection.BAD_FROM]: ErrorCodes.INVALID_MOVE,
  [rules.MoveRejection.NOT_YOUR_PIECE]: ErrorCodes.NOT_YOUR_PIECE,
  [rules.MoveRejection.ILLEGAL_TARGET]: ErrorCodes.ILLEGAL_MOVE_TARGET,
});

/** 拒绝原因的技术说明（前端按错误码映射中文，不直接展示）。 */
const REJECTION_DETAIL = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: "waiting for players",
  [rules.MoveRejection.FINISHED]: "game already over",
  [rules.MoveRejection.NOT_YOUR_TURN]: "not your turn",
  [rules.MoveRejection.BAD_FROM]: "from cell out of range",
  [rules.MoveRejection.NOT_YOUR_PIECE]: "from cell is not your piece",
  [rules.MoveRejection.ILLEGAL_TARGET]: "target is not a legal move",
});

/**
 * 跳棋权威房间。
 *
 * 座位约定：房主占 0 号位（红方），随后加入者依次入座；满 playerCount 人自动开局。
 * 玩家中途离开时房间回到等待状态，重新满员后再次自动开局（清盘重开）。
 */
class CheckersRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {object} [payload] - 建房负载（可含 playerCount，默认 2）。
   */
  constructor(roomId, payload = {}) {
    super(roomId, "checkers");
    this.status = "waiting";
    // 1. 玩家数：建房时由房主选定，之后不再变化（本房间对局的固定座位数）。
    const requested = Number(payload.playerCount);
    this.playerCount = Number.isInteger(requested) && requested >= rules.MIN_PLAYERS && requested <= rules.MAX_PLAYERS ? requested : rules.MIN_PLAYERS;
    this.maxPlayers = this.playerCount;
    /** 座位表：按入座顺序排列的 {playerId, nickname}。 */
    this.seats = [];
    // 2. 权威对局状态（字段与旧客户端状态对齐，渲染层可直接消费）。
    this.game = {
      players: [],
      turn: 0,
      started: false,
      over: false,
      winner: null,
      playerCount: this.playerCount,
      moves: [],
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
    // 2. 满员即自动开局：清盘摆子、红方（0 号位）先走。
    if (this.isFull() && !this.game.started) {
      this._setupGame();
      this.game.message = `${this.game.players.length} 人跳棋开始，红方先行`;
    } else {
      this.game.message = `已加入（${this.seats.length}/${this.playerCount}），等待满员开局`;
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
    this.game.message = `${player.nickname} 已离开房间`;
    // 2. 未满员时回到等待状态：进行中的对局作废，重新满员后自动清盘开局。
    if (!this.isFull()) {
      this.status = "waiting";
      this.game.started = false;
      this.game.over = false;
      this.game.winner = null;
      this.game.players = [];
      this.game.moves = [];
      this.game.turn = 0;
      this.game.message = `${player.nickname} 已离开，等待玩家补位后重新开局`;
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
      players: g.players.map((piece) => ({ ...piece })),
      turn: g.turn,
      started: g.started,
      over: g.over,
      winner: g.winner,
      playerCount: g.playerCount,
      moves: g.moves.map((move) => ({ ...move })),
      /** 座位映射：客户端据此判断自己执哪个颜色（按座位下标对齐）。 */
      seatPlayerIds: this.seats.map((seat) => seat.playerId),
      message: g.message,
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
   * - `move`：{from:{row,index}, to:{row,index}} 走子（起点必须是己方棋子当前位置）；
   * - `restart`：房主重新开局（清盘、轮次归零，战绩概念不适用于本游戏）。
   *
   * 注意：action 里夹带的任何其它字段（players/turn/winner/...）一概不采纳。
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
      case "move":
        return this._applyMove(seatIndex, action, ctx);
      case "restart":
        return this._applyRestart(player, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 走子校验与执行。
   *
   * @param {number} seatIndex - 操作者座位下标。
   * @param {object} action - {action:'move', from:{row,index}, to:{row,index}}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyMove(seatIndex, action, ctx) {
    const g = this.game;
    // 1. 交给纯规则模块判定（状态、轮次、归属、目标一次性校验）。
    const verdict = rules.validateMove({
      pieces: g.players,
      moverIndex: seatIndex,
      turn: g.turn,
      from: action.from,
      to: action.to,
      started: g.started,
      over: g.over,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: REJECTION_TO_ERROR[verdict.reason] || ErrorCodes.INVALID_MOVE,
        detail: REJECTION_DETAIL[verdict.reason] || verdict.reason,
      };
    }
    // 2. 推进权威状态。
    const mover = g.players[seatIndex];
    const applied = rules.applyMove(g.players, seatIndex, verdict.to);
    g.players = applied.pieces;
    g.moves.push({ color: mover.color, from: { ...action.from }, to: { ...verdict.to } });
    if (applied.won) {
      g.over = true;
      g.winner = mover.color;
      g.message = `${rules.COLOR_NAMES[mover.color]}到达目标区域，获胜！`;
      this.status = "finished";
    } else {
      g.turn = applied.nextTurn;
      g.message = `轮到 ${rules.COLOR_NAMES[g.players[g.turn].color]}`;
    }
    this.touch();
    this.broadcastGame(ctx);
    if (applied.won) this.broadcastSnapshot({ event: "game_finished" });
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
    // 1. 仅房主可重开（沿用旧版"房主开始/重置"的操作权限）。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    // 2. 必须满员才有对局可重开。
    if (!this.isFull()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for players" };
    // 3. 清盘重开。
    this._setupGame();
    this.game.message = "已重新开局，红方先行";
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
    g.players = rules.createPieces(this.playerCount).map((piece, index) => ({
      ...piece,
      name: this.seats[index]?.nickname || rules.COLOR_NAMES[piece.color],
    }));
    g.turn = 0;
    g.started = true;
    g.over = false;
    g.winner = null;
    g.moves = [];
    this.status = "playing";
  }
}

module.exports = { CheckersRoom };
