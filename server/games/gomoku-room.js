/**
 * 五子棋服务器权威房间。
 *
 * 服务器持有唯一权威对局状态：棋盘、轮次、胜负、悔棋、认输、换先、战绩。
 * 客户端只发送操作意图（落子坐标等），服务器校验后推进状态并广播快照。
 * 快照字段与原浏览器实现的 roomSnapshot() 保持一致，客户端渲染层可零成本复用。
 */
"use strict";

const { RoomBase } = require("../rooms/room-base");
const engine = require("./gomoku-engine");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

const { BOARD_SIZE, EMPTY, BLACK, WHITE, createBoard, colorName } = engine;

/**
 * 五子棋权威房间。
 *
 * 规则约定：
 * - 房主执黑先行，第二位加入者执白；满 2 人后对局开始。
 * - 胜者下一局执黑（保留原有 nextBlackColor 换先玩法）。
 * - 悔棋需对方同意，且每次落子后每方只能发起一次。
 */
class GomokuRoom extends RoomBase {
  /** @param {string} roomId - 8 位房间码。 */
  constructor(roomId) {
    // 1. 初始化成员管理基类。
    super(roomId, "gomoku");
    /** 座位表：color -> playerId|null。 */
    this.seats = { [BLACK]: null, [WHITE]: null };
    this.status = "waiting";
    this.maxPlayers = 2;
    // 2. 权威对局状态（字段与旧客户端 roomSnapshot 对齐）。
    this.game = {
      board: createBoard(),
      moves: [],
      turn: BLACK,
      winner: EMPTY,
      players: { black: "等待", white: "等待" },
      message: "房间已创建，等待好友加入",
      record: { total: 0, players: {} },
      recordLabel: "新房间",
      gameCounted: false,
      undoRequest: null,
      undoLocks: { [BLACK]: false, [WHITE]: false },
      hostColor: BLACK,
      swapAfterGame: false,
      nextBlackColor: EMPTY,
    };
  }

  /** 房间是否两位玩家都在座。
   * @returns {boolean}
   */
  isStarted() {
    return this.seats[BLACK] !== null && this.seats[WHITE] !== null;
  }

  /** 玩家颜色。
   * @param {string} playerId
   * @returns {number|null} BLACK/WHITE，不在座返回 null。
   */
  colorOf(playerId) {
    if (this.seats[BLACK] === playerId) return BLACK;
    if (this.seats[WHITE] === playerId) return WHITE;
    return null;
  }

  /**
   * 新玩家入座（由 RoomManager 调用）。
   *
   * @param {object} player - 已登记的 player 对象。
   * @param {"host"|"guest"} role - host 执黑，guest 执白。
   */
  seatPlayer(player, role) {
    // 1. 找到空座位：host 优先黑，guest 优先白。
    const color = role === "host" && this.seats[BLACK] === null ? BLACK : this.seats[WHITE] === null ? WHITE : null;
    if (color === null) return;
    player.role = color === BLACK ? "host" : "guest";
    this.seats[color] = player.playerId;
    this.game.players[color === BLACK ? "black" : "white"] = player.nickname;
    // 2. 满员即进入对局状态。
    if (this.isStarted()) {
      this.status = "playing";
      this.game.message = "对局开始，黑棋先手";
    } else if (color === BLACK) {
      this.game.message = "房间已创建，等待好友加入";
    } else {
      this.game.message = "已加入房间，等待黑棋落子";
    }
    this.touch();
  }

  /**
   * 玩家被移除后的善后：清空座位并广播。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因（leave / grace-expired）。
   */
  onPlayerRemoved(player, reason) {
    // 1. 回收座位。
    const color = this.colorOf(player.playerId);
    if (color !== null) {
      this.seats[color] = null;
      this.game.players[color === BLACK ? "black" : "white"] = "等待";
      this.game.undoRequest = null;
      this.game.message = `${player.nickname} 已离开房间`;
    }
    // 2. 未满员时回到等待状态。
    if (!this.isStarted()) this.status = "waiting";
    this.touch();
    // 3. 通知剩余玩家（事件 + 最新权威快照）。
    this.broadcastEventWithSnapshot("room.player_left", {
      playerId: player.playerId,
      nickname: player.nickname,
      reason,
    });
  }

  /** 权威快照（room + game 两部分）。 */
  snapshot() {
    return { room: this.describe(), game: this.gameSnapshot() };
  }

  /** 游戏部分快照（与旧客户端 roomSnapshot 字段一致，另加座位映射）。 */
  gameSnapshot() {
    // 1. 深拷贝可变字段，避免外部拿到内部引用。
    const snapshot = JSON.parse(JSON.stringify(this.game));
    // 2. 座位映射：客户端据此判断自己执黑还是执白（换先后依然正确）。
    snapshot.seatPlayerIds = { black: this.seats[BLACK], white: this.seats[WHITE] };
    return snapshot;
  }

  /**
   * 广播当前对局状态。
   *
   * 每条消息单独构造：发起操作的玩家收到的副本带上其请求的 requestId，
   * 使客户端能把它当作该次 game.action 的响应；其他玩家收到纯推送（不带 requestId）。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 本次操作的发起者上下文；
   *   缺省时对所有人都是纯推送（例如悔棋超时、重连恢复等非请求驱动的广播）。
   */
  broadcastGame(ctx) {
    // 1. 快照只计算一次，所有接收者共用（send 时各自序列化，不会互相影响）。
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
   * @param {object} player - 发起操作的玩家。
   * @param {object} action - {action: string, ...params}。
   * @param {string|null} [requestId] - 发起请求的信封 id，用于把结果关联回该次请求。
   * @returns {{ok: boolean, code?: string, detail?: string}} 校验/执行结果。
   */
  handleAction(player, action, requestId) {
    // 1. 必须在座。
    const color = this.colorOf(player.playerId);
    if (color === null) {
      return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "not seated" };
    }
    // 2. 组装响应上下文，供各动作广播时区分"请求者"与"旁观者"。
    const ctx = { playerId: player.playerId, requestId: requestId || null };
    // 3. 分发到具体动作处理器。
    switch (action.action) {
      case "move":
        return this._applyMove(color, action, ctx);
      case "undo_request":
        return this._applyUndoRequest(color, ctx);
      case "undo_respond":
        return this._applyUndoRespond(color, action, ctx);
      case "surrender":
        return this._applySurrender(color, ctx);
      case "restart":
        return this._applyRestart(color, ctx);
      case "play_again":
        return this._applyPlayAgain(color, ctx);
      case "switch_side":
        return this._applySwitchSide(color, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 落子校验与执行。
   *
   * @param {number} color - 操作者颜色。
   * @param {object} action - {action:'move', row:number, col:number}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applyMove(color, action, ctx) {
    const g = this.game;
    const row = action.row;
    const col = action.col;
    // 1. 基础校验：对局进行中、轮次正确、坐标合法、格子空闲。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    if (g.winner) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "winner set" };
    if (g.undoRequest) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "undo pending" };
    if (g.turn !== color) return { ok: false, code: ErrorCodes.NOT_YOUR_TURN, detail: `turn=${colorName(g.turn)}` };
    if (!Number.isInteger(row) || !Number.isInteger(col) || row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) {
      return { ok: false, code: ErrorCodes.INVALID_MOVE, detail: "out of range" };
    }
    if (g.board[row][col] !== EMPTY) return { ok: false, code: ErrorCodes.CELL_OCCUPIED, detail: `cell ${row},${col}` };

    // 2. 推进权威状态。
    g.board[row][col] = color;
    g.moves.push({ row, col, color, id: `${Date.now()}-${Math.random().toString(36).slice(2, 8)}` });
    g.undoLocks[color] = false;

    // 3. 胜负判定。
    if (engine.checkWinner(g.board, row, col, color)) {
      this._finishGame(color, `${colorName(color)}获胜`);
    } else {
      g.turn = color === BLACK ? WHITE : BLACK;
      g.message = `轮到${colorName(g.turn)}`;
    }
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 结束对局的统一入口（胜负计数 + 换先标记只做一次）。
   *
   * @param {number} winnerColor - 获胜颜色。
   * @param {string} message - 展示文案。
   */
  _finishGame(winnerColor, message) {
    const g = this.game;
    // 1. 设置胜负与文案。
    g.winner = winnerColor;
    g.message = message;
    // 2. 战绩与换先标记只在每局第一次结算时生效。
    if (!g.gameCounted) {
      const winnerName = g.players[winnerColor === BLACK ? "black" : "white"];
      g.record.total += 1;
      g.record.players[winnerName] = (g.record.players[winnerName] || 0) + 1;
      g.gameCounted = true;
      g.nextBlackColor = winnerColor;
      g.swapAfterGame = true;
    }
    this.status = "finished";
  }

  /**
   * 发起悔棋请求。
   *
   * @param {number} color - 请求者颜色。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applyUndoRequest(color, ctx) {
    const g = this.game;
    // 1. 状态校验：有棋可悔、无待处理请求、未用过本回合悔棋机会。
    if (g.winner) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "winner set" };
    if (g.undoRequest) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "undo pending" };
    if (!g.moves.length) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no moves" };
    if (g.undoLocks[color]) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "undo lock" };
    // 2. 定位请求者最后一手。
    const moveIndex = g.moves.findLastIndex((move) => move.color === color);
    if (moveIndex < 0) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no own move" };
    const move = g.moves[moveIndex];
    // 3. 登记请求并广播。
    g.undoLocks[color] = true;
    g.undoRequest = {
      requesterColor: color,
      moveIndex,
      moveId: move.id || `${move.row}-${move.col}-${move.color}-${moveIndex}`,
      createdAt: Date.now(),
    };
    g.message = `${colorName(color)}请求悔一步，等待对方同意`;
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 响应悔棋请求（只有对方能响应）。
   *
   * @param {number} color - 响应者颜色。
   * @param {object} action - {action:'undo_respond', approved:boolean}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applyUndoRespond(color, action, ctx) {
    const g = this.game;
    const request = g.undoRequest;
    // 1. 必须存在待处理请求，且响应者不是请求者本人。
    if (!request) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no undo request" };
    if (request.requesterColor === color) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "cannot respond own request" };
    // 2. 同意：从被悔的那一手起回滚（棋子、轮次、待处理请求全部复位）。
    if (action.approved) {
      const move = g.moves[request.moveIndex];
      if (move && move.color === request.requesterColor) {
        this._removeMovesFrom(request.moveIndex);
      } else {
        g.undoRequest = null;
        g.message = "悔棋失败，棋局已变化";
      }
    } else {
      // 3. 拒绝：仅清除请求。
      g.message = `${colorName(color)}拒绝悔棋`;
      g.undoRequest = null;
    }
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 从指定下标起撤销后续所有落子。
   *
   * @param {number} moveIndex - 被悔那一手的下标。
   */
  _removeMovesFrom(moveIndex) {
    const g = this.game;
    // 1. 从棋盘移除棋子并截断 moves。
    const removed = g.moves.splice(moveIndex);
    removed.forEach((move) => {
      g.board[move.row][move.col] = EMPTY;
    });
    // 2. 轮次回到被悔方，清空请求与胜负。
    const move = removed[0];
    if (!move) return;
    g.turn = move.color;
    g.winner = EMPTY;
    g.message = `${colorName(move.color)}已悔一步，轮到${colorName(g.turn)}`;
    g.undoRequest = null;
    if (this.isStarted()) this.status = "playing";
  }

  /**
   * 认输：发起者判负。
   *
   * @param {number} color - 认输者颜色。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applySurrender(color, ctx) {
    const g = this.game;
    // 1. 对局进行中才允许认输。
    if (g.winner) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "winner set" };
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 对方获胜。
    const winner = color === BLACK ? WHITE : BLACK;
    this._finishGame(winner, `${colorName(color)}认输，${colorName(winner)}获胜`);
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 重新开始：清空棋盘并清零战绩。
   *
   * @param {number} color - 发起者颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applyRestart(color, ctx) {
    // 1. 在座即可发起（demo 规则：任一玩家可重开并清空战绩）。
    const g = this.game;
    g.record = { total: 0, players: {} };
    g.recordLabel = "当前房间";
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    this._resetBoard();
    g.message = "已重新开局，战绩已清零";
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 再开一把：保留战绩，胜者下一局执黑（沿用旧换先玩法）。
   *
   * @param {number} color - 发起者颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}}
   */
  _applyPlayAgain(color, ctx) {
    const g = this.game;
    // 1. 换先：上局胜者执黑（黑方名与白方名对调）。
    if (g.nextBlackColor === WHITE) {
      g.hostColor = g.hostColor === BLACK ? WHITE : BLACK;
      const blackName = g.players.black;
      g.players.black = g.players.white;
      g.players.white = blackName;
      const tmp = this.seats[BLACK];
      this.seats[BLACK] = this.seats[WHITE];
      this.seats[WHITE] = tmp;
      for (const p of this.players.values()) {
        if (p.role === "host") p.role = "guest";
        else if (p.role === "guest") p.role = "host";
      }
    }
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    // 2. 清盘。
    this._resetBoard();
    g.message = "再开一把，黑棋先手";
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 交换先后手（房间内任意玩家都可以发起）。
   *
   * 对局进行中且已有落子时禁止换位；未开局或一局已结束时允许，换位后清盘，
   * 战绩保留（换位不是重开）。
   *
   * @param {number} color - 发起者颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySwitchSide(color, ctx) {
    const g = this.game;
    // 1. 交换座位：黑白 playerId、昵称、hostColor 与角色标签一起换。
    g.hostColor = g.hostColor === BLACK ? WHITE : BLACK;
    const blackName = g.players.black;
    g.players.black = g.players.white;
    g.players.white = blackName;
    const tmp = this.seats[BLACK];
    this.seats[BLACK] = this.seats[WHITE];
    this.seats[WHITE] = tmp;
    for (const p of this.players.values()) {
      if (p.role === "host") p.role = "guest";
      else if (p.role === "guest") p.role = "host";
    }
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    // 2. 清盘并复位单局状态，战绩保留。
    this._resetBoard();
    g.message = "已交换先后手，黑棋先手";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "side_switched" });
    return { ok: true };
  }

  /** 清空棋盘并复位单局状态（不动战绩与座位）。 */
  _resetBoard() {
    const g = this.game;
    g.board = createBoard();
    g.moves = [];
    g.turn = BLACK;
    g.winner = EMPTY;
    g.gameCounted = false;
    g.undoRequest = null;
    g.undoLocks = { [BLACK]: false, [WHITE]: false };
    this.status = this.isStarted() ? "playing" : "waiting";
  }

  /**
   * 玩家断线通知：广播对端状态（座位保留，等待重连）。
   *
   * 广播给房间内所有连接（含断线者本人）：断线者若还能收到（例如双连接场景），
   * 也能拿到同一份权威状态，避免两端各自推断出不同的成员表。
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
}

module.exports = { GomokuRoom };
