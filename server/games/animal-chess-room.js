/**
 * 斗兽棋服务器权威房间。
 *
 * 服务器持有唯一权威对局状态：棋子位置、存活状态、轮次、胜负、走子记录。
 * 客户端只发送操作意图（from/to 坐标），服务器用 animal-chess-rules 校验后推进状态，
 * 再把权威快照广播给房间内所有连接；客户端不得提交棋盘、winner 或 currentTurn。
 *
 * 座位与角色约定：
 * - 房主固定执红（红方先手），第二位加入者执蓝；
 * - 两位玩家都在座时自动开局；
 * - colorIds 把阵营映射到 playerId，客户端据此判断自己控制哪一方。
 */
"use strict";

const { RoomBase } = require("../rooms/room-base");
// 斗兽棋规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于可走位置提示），避免规则实现漂移成两份。
const rules = require("../../animal-chess-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

const { SIDES } = rules;

/** 走法拒绝原因 -> 协议错误码。 */
const REJECTION_TO_ERROR = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: ErrorCodes.GAME_NOT_STARTED,
  [rules.MoveRejection.FINISHED]: ErrorCodes.GAME_ALREADY_FINISHED,
  [rules.MoveRejection.NOT_YOUR_TURN]: ErrorCodes.NOT_YOUR_TURN,
  [rules.MoveRejection.BAD_FROM]: ErrorCodes.INVALID_MOVE,
  [rules.MoveRejection.BAD_TO]: ErrorCodes.INVALID_MOVE,
  [rules.MoveRejection.NOT_YOUR_PIECE]: ErrorCodes.NOT_YOUR_PIECE,
  [rules.MoveRejection.ILLEGAL_TARGET]: ErrorCodes.ILLEGAL_MOVE_TARGET,
});

/** 客户端可读的拒绝原因说明（技术细节，前端映射为中文）。 */
const REJECTION_DETAIL = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: "game not started",
  [rules.MoveRejection.FINISHED]: "game already over",
  [rules.MoveRejection.NOT_YOUR_TURN]: "not your turn",
  [rules.MoveRejection.BAD_FROM]: "from out of range",
  [rules.MoveRejection.BAD_TO]: "to out of range",
  [rules.MoveRejection.NOT_YOUR_PIECE]: "from has no own piece",
  [rules.MoveRejection.ILLEGAL_TARGET]: "target not reachable by rules",
});

class AnimalChessRoom extends RoomBase {
  /** @param {string} roomId - 8 位房间码（DS 前缀）。 */
  constructor(roomId) {
    // 1. 成员管理基类。
    super(roomId, "animal-chess");
    this.status = "waiting";
    this.maxPlayers = 2;
    /** 座位表：阵营 -> playerId|null。 */
    this.seats = { red: null, blue: null };
    // 2. 权威对局状态。
    this.game = {
      pieces: rules.createInitialPieces(),
      turn: "red",
      started: false,
      over: false,
      winner: "",
      message: "房间已创建，等待好友加入",
      moves: [],
      lastMove: null,
      /** 走子序号，便于客户端判断"有新一步"。 */
      moveCount: 0,
    };
    // 3. 昵称表（阵营 -> 昵称），随快照下发供 UI 展示。
    this.game.players = { red: "等待", blue: "等待" };
  }

  /** 两位玩家是否都在座。
   * @returns {boolean} true 表示可以开局。
   */
  isStarted() {
    return this.seats.red !== null && this.seats.blue !== null;
  }

  /**
   * 玩家阵营。
   *
   * @param {string} playerId - 玩家 id。
   * @returns {"red"|"blue"|null} 阵营标识，不在座返回 null。
   */
  sideOf(playerId) {
    if (this.seats.red === playerId) return "red";
    if (this.seats.blue === playerId) return "blue";
    return null;
  }

  /**
   * 新玩家入座（由 RoomManager 调用）。
   *
   * @param {object} player - 已登记的 player 对象。
   * @param {"host"|"guest"} role - host 执红，guest 执蓝。
   */
  seatPlayer(player, role) {
    // 1. 找空座位：host 优先红，guest 优先蓝。
    const preferred = role === "host" ? "red" : "blue";
    const side = this.seats[preferred] === null ? preferred : SIDES.find((item) => this.seats[item] === null) || null;
    if (side === null) return;
    player.role = side === "red" ? "host" : "guest";
    this.seats[side] = player.playerId;
    this.game.players[side] = player.nickname;
    // 2. 满员即自动开局（与五子棋一致，不需要房主额外点一次"开始"）。
    if (this.isStarted() && !this.game.started && !this.game.over) {
      this.game.started = true;
      this.status = "playing";
      this.game.message = "对局开始，红方先手";
    } else if (!this.isStarted()) {
      this.game.message = side === "red" ? "房间已创建，等待好友加入" : "已加入房间，等待红方先手";
    }
    this.touch();
  }

  /**
   * 玩家被移除后的善后：清空座位并广播权威快照。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因（leave / grace-expired）。
   */
  onPlayerRemoved(player, reason) {
    // 1. 回收座位。
    const side = this.sideOf(player.playerId);
    if (side !== null) {
      this.seats[side] = null;
      this.game.players[side] = "等待";
      this.game.message = `${player.nickname} 已离开房间`;
    }
    // 2. 未满员时回到等待状态，并结束未完成的对局。
    if (!this.isStarted()) {
      this.status = "waiting";
      this.game.started = false;
    }
    this.touch();
    // 3. 通知剩余玩家（事件 + 最新权威快照）。
    this.broadcastEventWithSnapshot("room.player_left", {
      playerId: player.playerId,
      nickname: player.nickname,
      reason,
    });
  }

  /**
   * 玩家断线通知：座位保留，广播最新快照让对手看到"连接中断"。
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
   * 对局快照：深拷贝可变字段，避免调用方拿到内部引用。
   *
   * @returns {object} 与客户端渲染字段一一对应的权威状态。
   */
  gameSnapshot() {
    const snapshot = JSON.parse(JSON.stringify(this.game));
    // 1. 阵营 -> playerId 映射：客户端据此判断自己控制哪一方（不依赖 role）。
    snapshot.sidePlayerIds = { red: this.seats.red, blue: this.seats.blue };
    return snapshot;
  }

  /**
   * 广播当前对局状态。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 操作发起者上下文；
   *   发起者收到的副本带 requestId，可当作该次 game.action 的响应，其余玩家收到纯推送。
   */
  broadcastGame(ctx) {
    // 1. 快照只计算一次，所有接收者共用（序列化时各自独立）。
    const snapshot = this.snapshot();
    const requestId = ctx && ctx.requestId ? ctx.requestId : null;
    // 2. 逐个玩家发送，仅发起者带 requestId。
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
   * - `move`：{from:{row,col}, to:{row,col}} 走子；
   * - `start`：房主手动开局（两人在座时通常已自动开局，保留以便重开一局）；
   * - `restart`：重开一局（清盘、红方先手、保留座位）。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {object} action - {action: string, ...params}。
   * @param {string|null} [requestId] - 发起请求的信封 id。
   * @returns {{ok: boolean, code?: string, detail?: string}} 校验/执行结果。
   */
  handleAction(player, action, requestId) {
    // 1. 必须在座。
    const side = this.sideOf(player.playerId);
    if (side === null) {
      return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "not seated" };
    }
    const ctx = { playerId: player.playerId, requestId: requestId || null };
    // 2. 分发到具体动作处理器。
    switch (action.action) {
      case "move":
        return this._applyMove(side, action, ctx);
      case "start":
        return this._applyStart(side, ctx);
      case "restart":
        return this._applyRestart(side, ctx);
      case "surrender":
        return this._applySurrender(side, ctx);
      case "switch_side":
        return this._applySwitchSide(side, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 走子校验与执行（服务端最终裁决，非法操作不改动任何状态）。
   *
   * @param {"red"|"blue"} side - 操作方阵营。
   * @param {object} action - {action:'move', from:{row,col}, to:{row,col}}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyMove(side, action, ctx) {
    const g = this.game;
    // 1. 交给纯规则模块判定（状态、轮次、坐标、归属、走法一次性校验）。
    const verdict = rules.validateMove(g.pieces, {
      side,
      from: action.from,
      to: action.to,
      started: g.started,
      over: g.over,
      turn: g.turn,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: REJECTION_TO_ERROR[verdict.reason] || ErrorCodes.INVALID_MOVE,
        detail: REJECTION_DETAIL[verdict.reason] || verdict.reason,
      };
    }
    // 2. 推进权威状态：吃子、移动、记录。
    const { piece, target, captured } = verdict;
    const from = { row: piece.row, col: piece.col };
    if (captured) captured.alive = false;
    piece.row = target.row;
    piece.col = target.col;
    g.moveCount += 1;
    g.lastMove = { id: piece.id, owner: piece.owner, from, to: { row: target.row, col: target.col } };
    g.moves = [...g.moves.slice(-11), {
      owner: piece.owner,
      name: piece.name,
      from,
      to: { row: target.row, col: target.col },
      capture: captured ? captured.name : "",
    }];
    // 3. 胜负判定：进敌方兽穴 / 吃光对手。
    const outcome = rules.evaluateOutcome(g.pieces, side, target);
    if (outcome.over) {
      g.over = true;
      g.winner = outcome.winner;
      this.status = "finished";
      g.message = outcome.reason === "den"
        ? `${rules.sideLabel(side)} 进入兽穴，直接获胜。`
        : `${rules.sideLabel(side)} 吃光了对手全部棋子。`;
    } else {
      g.turn = side === "red" ? "blue" : "red";
      g.message = `${rules.sideLabel(piece.owner)} 的 ${piece.name} ${rules.coordText(from.row, from.col)} -> ${rules.coordText(target.row, target.col)}${captured ? `，吃掉 ${captured.name}` : ""}。`;
    }
    this.touch();
    // 4. 广播权威快照（含发起者，带 requestId 作为响应）。
    this.broadcastGame(ctx);
    // 5. 对局结束时额外广播一次房间级快照：房间 status 从 playing 变为 finished，
    //    属于"房间状态变化"，客户端据此刷新房间状态栏。
    if (g.over) this.broadcastSnapshot({ event: "game_finished", winner: g.winner });
    return { ok: true };
  }

  /**
   * 手动开局：两位玩家都在座时把对局置为进行中并复位棋盘。
   *
   * 正常流程下第二人入座即自动开局；本动作用于"两位都在座但上一局已结束"的场景。
   *
   * @param {"red"|"blue"} side - 操作方阵营（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyStart(side, ctx) {
    // 1. 必须两人都在座。
    if (!this.isStarted()) {
      return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    }
    // 2. 复位棋盘并开局。
    this._resetGame();
    this.game.started = true;
    this.status = "playing";
    this.game.message = "对局开始，红方先手";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_started" });
    return { ok: true };
  }

  /**
   * 重开一局：清盘、红方先手、保留座位与双方昵称。
   *
   * @param {"red"|"blue"} side - 操作方阵营（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRestart(side, ctx) {
    // 1. 必须两人都在座才能重开。
    if (!this.isStarted()) {
      return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    }
    // 2. 清盘并直接进入新的一局。
    this._resetGame();
    this.game.started = true;
    this.status = "playing";
    this.game.message = "已重新开局，红方先手";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /** 复位单局状态（不动座位与双方昵称）。 */
  _resetGame() {
    const g = this.game;
    g.pieces = rules.createInitialPieces();
    g.turn = "red";
    g.started = false;
    g.over = false;
    g.winner = "";
    g.moves = [];
    g.lastMove = null;
    g.moveCount = 0;
    this.status = this.isStarted() ? "playing" : "waiting";
  }

  /**
   * 认输：发起方判负，对手获胜。
   *
   * @param {"red"|"blue"} side - 认输方阵营。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySurrender(side, ctx) {
    const g = this.game;
    // 1. 必须两人在座且对局尚未结束。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    if (g.over) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    // 2. 对手获胜。
    const winner = side === "red" ? "blue" : "red";
    g.over = true;
    g.winner = winner;
    this.status = "finished";
    g.message = `${rules.sideLabel(side)}认输，${rules.sideLabel(winner)}获胜。`;
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_finished", winner });
    return { ok: true };
  }

  /**
   * 交换先后手（房间内任意玩家都可以发起）。
   *
   * 对局进行中且已有走子时禁止换位；未开局或一局已结束时允许，换位后重新摆子。
   *
   * @param {"red"|"blue"} side - 发起方阵营（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySwitchSide(side, ctx) {
    const g = this.game;
    // 1. 必须两人在座。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 对局进行中且已有走子时不允许换位。
    if (g.started && !g.over && g.moveCount > 0) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "game in progress" };
    }
    // 3. 交换红蓝座位、昵称与玩家角色标签。
    const tmp = this.seats.red;
    this.seats.red = this.seats.blue;
    this.seats.blue = tmp;
    const redName = g.players.red;
    g.players.red = g.players.blue;
    g.players.blue = redName;
    for (const p of this.players.values()) {
      if (p.role === "host") p.role = "guest";
      else if (p.role === "guest") p.role = "host";
    }
    // 4. 重新摆子并开局。
    this._resetGame();
    g.started = true;
    this.status = "playing";
    g.message = "已交换先后手，红方先手";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "side_switched" });
    return { ok: true };
  }
}

module.exports = { AnimalChessRoom };
