/**
 * 棋盘类小游戏服务器权威房间（井字棋 / 黑白棋 / 四子棋共用）。
 *
 * 三款游戏规则同为"两人、完全信息、无随机数、轮流落子"，差异只在棋盘尺寸、
 * 连线长度与是否按列下落，因此共用一个房间实现 + grid-rules.js 的棋型配置，
 * 而不是复制三份几乎相同的房间代码。规则判定全部委托给纯规则模块。
 *
 * 权威边界：
 * - 服务器持有棋盘、轮次、胜负、战绩、黑白棋计时与悔棋模式；
 * - 客户端只发操作意图（move / surrender / undo / start / restart）；
 * - 快照字段与改造前 grid-game.js 的 roomSnapshot() 对齐，客户端渲染层可直接复用。
 */
"use strict";

const { RoomBase } = require("../rooms/room-base");
// 规则模块位于站点根目录：同一份文件既被服务端 require（最终裁决），
// 也被浏览器 <script> 加载（只用于可落子提示），避免规则实现漂移成两份。
const rules = require("../../grid-rules");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");

const { EMPTY, BLACK, WHITE } = rules;

/** 走法拒绝原因 -> 协议错误码。 */
const REJECTION_TO_ERROR = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: ErrorCodes.GAME_NOT_STARTED,
  [rules.MoveRejection.FINISHED]: ErrorCodes.GAME_ALREADY_FINISHED,
  [rules.MoveRejection.NOT_YOUR_TURN]: ErrorCodes.NOT_YOUR_TURN,
  [rules.MoveRejection.BAD_CELL]: ErrorCodes.INVALID_MOVE,
  [rules.MoveRejection.CELL_OCCUPIED]: ErrorCodes.CELL_OCCUPIED,
  // 四子棋列满复用 CELL_OCCUPIED：语义都是"这个位置已经有棋子了"。
  [rules.MoveRejection.COLUMN_FULL]: ErrorCodes.CELL_OCCUPIED,
  [rules.MoveRejection.ILLEGAL_TARGET]: ErrorCodes.ILLEGAL_MOVE_TARGET,
});

/** 拒绝原因的技术说明（前端按错误码映射中文，不直接展示）。 */
const REJECTION_DETAIL = Object.freeze({
  [rules.MoveRejection.NOT_STARTED]: "waiting for opponent",
  [rules.MoveRejection.FINISHED]: "game already over",
  [rules.MoveRejection.NOT_YOUR_TURN]: "not your turn",
  [rules.MoveRejection.BAD_CELL]: "cell out of range",
  [rules.MoveRejection.CELL_OCCUPIED]: "cell occupied",
  [rules.MoveRejection.COLUMN_FULL]: "column full",
  [rules.MoveRejection.ILLEGAL_TARGET]: "no pieces would be flipped",
});

/**
 * 棋盘类权威房间。
 *
 * 座位约定与五子棋一致：房主执黑（先手），第二位加入者执白；满 2 人自动开局。
 * 每局结束后由任意一方发起 play_again，胜者下一局执黑（井字棋固定换先，沿用旧玩法）。
 */
class GridGameRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {string} gameKey - 游戏标识（tictactoe / reversi / connect4）。
   */
  constructor(roomId, gameKey) {
    // 1. 先取棋型配置：未注册的 gameKey 属于装配错误，直接抛出让调用方暴露问题。
    const config = rules.configOf(gameKey);
    if (!config) throw new Error(`unknown grid game ${gameKey}`);
    super(roomId, gameKey);
    this.config = config;
    this.status = "waiting";
    this.maxPlayers = 2;
    /** 座位表：color -> playerId|null。 */
    this.seats = { [BLACK]: null, [WHITE]: null };
    // 2. 权威对局状态（字段与旧客户端 roomSnapshot 对齐）。
    this.game = {
      board: rules.createInitialBoard(config),
      moves: [],
      turn: BLACK,
      winner: EMPTY,
      draw: false,
      started: false,
      players: { black: "等待", white: "等待" },
      // record.players 按昵称聚合（展示用），record.winners 按座位颜色聚合。
      // 两位玩家可能使用相同昵称（默认昵称就是随机四位数），只按昵称统计会让
      // 两边的胜场互相污染，因此颜色维度的计数必须单独维护。
      record: { total: 0, players: {}, draw: 0, winners: { black: 0, white: 0 } },
      recordLabel: "新房间",
      gameCounted: false,
      hostColor: BLACK,
      swapAfterGame: false,
      nextBlackColor: EMPTY,
      /** 黑白棋专属：悔棋模式与双方累计用时。 */
      undoMode: config.key === "reversi" ? "no-undo" : null,
      timers: config.key === "reversi" ? { black: 0, white: 0 } : null,
      turnStartedAt: null,
      message: "房间已创建，等待好友加入",
    };
  }

  /** 两位玩家是否都在座。
   * @returns {boolean} true 表示可以开局。
   */
  isStarted() {
    return this.seats[BLACK] !== null && this.seats[WHITE] !== null;
  }

  /**
   * 玩家颜色。
   *
   * @param {string} playerId - 玩家 id。
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
   * @param {"host"|"guest"} role - host 优先执黑，guest 优先执白。
   */
  seatPlayer(player, role) {
    // 1. 找空座位并登记昵称。
    const preferred = role === "host" ? BLACK : WHITE;
    const color = this.seats[preferred] === null ? preferred : this.seats[preferred === BLACK ? WHITE : BLACK] === null ? (preferred === BLACK ? WHITE : BLACK) : null;
    if (color === null) return;
    player.role = color === BLACK ? "host" : "guest";
    this.seats[color] = player.playerId;
    this.game.players[color === BLACK ? "black" : "white"] = player.nickname;
    // 2. 满员即自动开局（沿用旧客户端"房主开始"之外的最短路径，避免双方到齐后无法对局）。
    if (this.isStarted() && !this.game.started) {
      this._setupBoard();
      this.status = "playing";
      this.game.message = "对局开始，先手落子";
    } else if (!this.isStarted()) {
      this.game.message = color === BLACK ? "房间已创建，等待好友加入" : "已加入房间，等待先手落子";
    }
    this.touch();
  }

  /**
   * 玩家被移除后的善后：清空座位、结束未完成对局并广播。
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
      this.game.message = `${player.nickname} 已离开房间`;
    }
    // 2. 未满员时回到等待状态，并把进行中的对局标记为未开始。
    if (!this.isStarted()) {
      this.status = "waiting";
      this.game.started = false;
      this._stopClock();
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
   * 玩家断线通知：座位保留，广播最新快照让对手看到"掉线中"。
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
    // 1. 深拷贝可变字段，避免外部拿到内部引用。
    const snapshot = {
      board: g.board.map((row) => [...row]),
      moves: g.moves.map((move) => ({ ...move })),
      turn: g.turn,
      winner: g.winner,
      draw: g.draw,
      started: g.started,
      players: { ...g.players },
      record: {
        total: g.record.total,
        players: { ...g.record.players },
        draw: g.record.draw,
        winners: { ...(g.record.winners || { black: 0, white: 0 }) },
      },
      recordLabel: g.recordLabel,
      gameCounted: g.gameCounted,
      hostColor: g.hostColor,
      swapAfterGame: g.swapAfterGame,
      nextBlackColor: g.nextBlackColor,
      undoMode: g.undoMode,
      timers: this._elapsedTimers(),
      turnStartedAt: this._clockRunning() ? Date.now() : null,
      message: g.message,
    };
    // 2. 座位映射：客户端据此判断自己执黑还是执白（换先后依然正确）。
    snapshot.seatPlayerIds = { black: this.seats[BLACK], white: this.seats[WHITE] };
    return snapshot;
  }

  /**
   * 广播当前对局状态。
   *
   * @param {{playerId: string, requestId: string|null}} [ctx] - 操作发起者上下文；
   *   发起者收到的副本带 requestId，可当作该次 game.action 的响应。
   */
  broadcastGame(ctx) {
    // 1. 快照只计算一次，逐玩家发送时各自序列化。
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
   * - `move`：{row,col} 落子（四子棋的 row 由服务器按列推导）；
   * - `start`：房主手动开局（两人在座时通常已自动开局）；
   * - `restart`：重开一局并清空战绩；
   * - `play_again`：保留战绩再开一把（胜者下局执黑）；
   * - `surrender`：认输，对手获胜；
   * - `undo`：黑白棋在"开启悔棋"模式下撤回自己最新一步；
   * - `set_undo_mode`：黑白棋房主在未开局时切换悔棋模式。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {object} action - {action: string, ...params}。
   * @param {string|null} [requestId] - 发起请求的信封 id。
   * @returns {{ok: boolean, code?: string, detail?: string}} 校验/执行结果。
   */
  handleAction(player, action, requestId) {
    // 1. 必须在座。
    const color = this.colorOf(player.playerId);
    if (color === null) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "not seated" };
    const ctx = { playerId: player.playerId, requestId: requestId || null };
    // 2. 分发到具体动作处理器。
    switch (action.action) {
      case "move":
        return this._applyMove(color, action, ctx);
      case "start":
        return this._applyStart(color, ctx);
      case "restart":
        return this._applyRestart(color, ctx);
      case "play_again":
        return this._applyPlayAgain(color, ctx);
      case "switch_side":
        return this._applySwitchSide(ctx);
      case "surrender":
        return this._applySurrender(color, ctx);
      case "undo":
        return this._applyUndo(color, ctx);
      case "set_undo_mode":
        return this._applySetUndoMode(player, action, ctx);
      default:
        return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unknown action ${action.action}` };
    }
  }

  /**
   * 落子校验与执行。
   *
   * @param {number} color - 操作方颜色。
   * @param {object} action - {action:'move', row:number, col:number}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyMove(color, action, ctx) {
    const g = this.game;
    // 1. 交给纯规则模块判定（状态、轮次、坐标、合法性一次性校验）。
    const verdict = rules.validateMove(this.config, {
      board: g.board,
      color,
      cell: { row: action.row, col: action.col },
      started: g.started,
      over: Boolean(g.winner) || g.draw,
      turn: g.turn,
    });
    if (!verdict.ok) {
      return {
        ok: false,
        code: REJECTION_TO_ERROR[verdict.reason] || ErrorCodes.INVALID_MOVE,
        detail: REJECTION_DETAIL[verdict.reason] || verdict.reason,
      };
    }
    // 2. 结算上一位玩家的计时（黑白棋）。
    this._commitClock(color);
    // 3. 推进权威状态：落子 + 翻转。
    const { row, col, flips } = verdict;
    g.board[row][col] = color;
    flips.forEach(([r, c]) => {
      g.board[r][c] = color;
    });
    g.moves.push({ row, col, color, flipCells: flips.map(([r, c]) => ({ row: r, col: c })), flips: flips.length });
    // 4. 结果判定：胜负 / 平局 / 换手（黑白棋含"对手无子可下则继续"）。
    const outcome = rules.evaluateGridOutcome(this.config, g.board, { row, col }, color);
    if (outcome.over) {
      this._finishGame(outcome.winner, outcome.draw);
    } else {
      g.turn = outcome.nextTurn;
      g.message = g.turn === color ? `${rules.colorLabel(this.config, color)}继续落子` : `轮到${rules.colorLabel(this.config, g.turn)}`;
      this._startClock();
    }
    this.touch();
    this.broadcastGame(ctx);
    if (outcome.over) this.broadcastSnapshot({ event: "game_finished" });
    return { ok: true };
  }

  /**
   * 结束对局（战绩与换先标记只结算一次）。
   *
   * @param {number} winner - 获胜颜色；平局传 EMPTY。
   * @param {boolean} isDraw - 是否为平局。
   */
  _finishGame(winner, isDraw) {
    const g = this.game;
    // 1. 记录胜负与文案。
    g.winner = winner;
    g.draw = isDraw;
    this._stopClock();
    g.message = isDraw ? "双方平局" : `${rules.colorLabel(this.config, winner)}获胜`;
    // 2. 战绩只在每局第一次结算时累计。
    if (!g.gameCounted) {
      g.record.total += 1;
      if (isDraw) {
        g.record.draw += 1;
      } else {
        const seatKey = winner === BLACK ? "black" : "white";
        const name = g.players[seatKey];
        // 2.1 昵称维度：展示用的历史统计（同名玩家会合并，这是可接受的展示折衷）。
        g.record.players[name] = (g.record.players[name] || 0) + 1;
        // 2.2 座位维度：UI 归属统计的唯一可靠来源，不受重名影响。
        g.record.winners = g.record.winners || { black: 0, white: 0 };
        g.record.winners[seatKey] += 1;
      }
      g.gameCounted = true;
      // 3. 井字棋固定交换先手（沿用旧玩法）；其余棋类由胜者下局执黑。
      g.nextBlackColor = this.config.key === "tictactoe" ? WHITE : isDraw ? EMPTY : winner;
      g.swapAfterGame = Boolean(g.nextBlackColor) && g.nextBlackColor !== g.hostColor;
    }
    this.status = "finished";
  }

  /**
   * 手动开局。
   *
   * @param {number} color - 操作方颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyStart(color, ctx) {
    // 1. 必须两人都在座。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 复位棋盘并开局。
    this._setupBoard();
    this.status = "playing";
    this.game.message = "对局开始，先手落子";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_started" });
    return { ok: true };
  }

  /**
   * 重开一局并清空战绩。
   *
   * @param {number} color - 操作方颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyRestart(color, ctx) {
    // 1. 两人都在座才能重开。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 清空战绩并复位棋盘。
    const g = this.game;
    g.record = { total: 0, players: {}, draw: 0, winners: { black: 0, white: 0 } };
    g.recordLabel = "当前房间";
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    this._setupBoard();
    this.status = "playing";
    g.message = "已重新开局，战绩已清零";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /**
   * 再开一把：保留战绩，按本游戏换先规则交换座位角色。
   *
   * @param {number} color - 操作方颜色（仅校验在座）。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyPlayAgain(color, ctx) {
    const g = this.game;
    // 1. 换先：需要让 nextBlackColor 对应的玩家下局执黑。
    if (g.nextBlackColor && g.nextBlackColor !== BLACK) {
      this._swapSeats();
    }
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    // 2. 清盘。
    this._setupBoard();
    this.status = "playing";
    g.message = "再开一把，先手落子";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_restarted" });
    return { ok: true };
  }

  /**
   * 交换黑白座位（含 seats / 昵称 / hostColor / 玩家角色标签）。
   */
  _swapSeats() {
    const g = this.game;
    g.hostColor = rules.opposite(g.hostColor);
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

  /**
   * 交换先后手位置（房间内任意玩家都可以发起）。
   *
   * 规则：
   * - 对局进行中且棋盘上已有落子时禁止换位，避免中途改变双方颜色导致棋局语义错乱；
   * - 未开局或一局已结束时允许，换位后清盘并回到"已开局、先手落子"的状态；
   * - 战绩保留（换位不是重开），recordLabel 保持不变。
   *
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySwitchSide(ctx) {
    const g = this.game;
    // 1. 必须先有两位玩家在座才谈得上"交换位置"。
    if (!this.isStarted()) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 对局进行中且已有落子时不允许换位。
    if (g.started && !g.winner && !g.draw && g.moves.length > 0) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "game in progress" };
    }
    // 3. 执行换位并清盘。
    this._swapSeats();
    g.nextBlackColor = EMPTY;
    g.swapAfterGame = false;
    this._setupBoard();
    this.status = "playing";
    g.message = "已交换先后手";
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "side_switched" });
    return { ok: true };
  }

  /**
   * 认输：发起者判负。
   *
   * @param {number} color - 认输者颜色。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySurrender(color, ctx) {
    const g = this.game;
    // 1. 对局进行中才允许认输。
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    if (g.winner || g.draw) return { ok: false, code: ErrorCodes.GAME_ALREADY_FINISHED, detail: "game already over" };
    // 2. 对手获胜。
    const winner = rules.opposite(color);
    this._finishGame(winner, false);
    this.touch();
    this.broadcastGame(ctx);
    this.broadcastSnapshot({ event: "game_finished" });
    return { ok: true };
  }

  /**
   * 黑白棋悔棋：撤回自己最新一步（仅在开启悔棋且该步属于自己时允许）。
   *
   * @param {number} color - 操作方颜色。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applyUndo(color, ctx) {
    const g = this.game;
    // 1. 只有黑白棋且房主开启了悔棋模式才支持。
    if (this.config.key !== "reversi" || g.undoMode !== "undo") {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "undo disabled" };
    }
    if (!g.started) return { ok: false, code: ErrorCodes.GAME_NOT_STARTED, detail: "waiting for opponent" };
    // 2. 只能撤回自己的最新一步。
    const move = g.moves.at(-1);
    if (!move) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no moves" };
    if (move.color !== color) return { ok: false, code: ErrorCodes.NOT_YOUR_PIECE, detail: "last move is not yours" };
    // 3. 回滚：落点清空、被翻的子翻回对方颜色、轮次回到自己、清除结算状态。
    g.moves.pop();
    g.board[move.row][move.col] = EMPTY;
    const reverted = rules.opposite(move.color);
    (move.flipCells || []).forEach(({ row, col }) => {
      g.board[row][col] = reverted;
    });
    g.turn = move.color;
    g.winner = EMPTY;
    g.draw = false;
    g.gameCounted = false;
    this.status = "playing";
    g.message = `${rules.colorLabel(this.config, color)}已悔一步，轮到${rules.colorLabel(this.config, g.turn)}`;
    this._startClock();
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 切换黑白棋悔棋模式（仅房主、仅未开局时允许）。
   *
   * @param {object} player - 发起操作的玩家。
   * @param {object} action - {action:'set_undo_mode', undoMode:string}。
   * @param {{playerId: string, requestId: string|null}} ctx - 发起者上下文。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  _applySetUndoMode(player, action, ctx) {
    const g = this.game;
    // 1. 仅黑白棋有该设置。
    if (this.config.key !== "reversi") return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "no undo mode" };
    // 2. 仅房主可在未开局时修改：对局中改规则会破坏双方预期。
    if (!player.host) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER, detail: "host only" };
    if (g.started && !g.winner && !g.draw) return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "game in progress" };
    g.undoMode = action.undoMode === "undo" ? "undo" : "no-undo";
    g.message = g.undoMode === "undo" ? "已开启悔棋" : "已关闭悔棋";
    this.touch();
    this.broadcastGame(ctx);
    return { ok: true };
  }

  /**
   * 复位单局状态（不动座位、昵称与战绩）。
   */
  _setupBoard() {
    const g = this.game;
    g.board = rules.createInitialBoard(this.config);
    g.moves = [];
    g.turn = BLACK;
    g.winner = EMPTY;
    g.draw = false;
    g.started = true;
    g.gameCounted = false;
    g.timers = this.config.key === "reversi" ? { black: 0, white: 0 } : null;
    g.turnStartedAt = null;
    // 1. 黑白棋首手不计时（先手落子后才开始计时），与旧客户端口径一致。
    this._startClock();
  }

  /** 黑白棋计时是否在走。 */
  _clockRunning() {
    return this.config.key === "reversi" && Boolean(this.game.turnStartedAt);
  }

  /** 开始计时（当前回合方）。 */
  _startClock() {
    if (this.config.key !== "reversi") return;
    this.game.turnStartedAt = Date.now();
  }

  /** 停止计时（结算或离开房间）。 */
  _stopClock() {
    if (this.config.key !== "reversi") return;
    this.game.turnStartedAt = null;
  }

  /**
   * 结算某一方的累计用时并落入 timers。
   *
   * @param {number} color - 刚刚完成落子的颜色。
   */
  _commitClock(color) {
    const g = this.game;
    if (this.config.key !== "reversi" || !g.turnStartedAt) return;
    const elapsed = this._elapsedTimers();
    g.timers = elapsed;
    g.turnStartedAt = null;
    g.timers[color === BLACK ? "black" : "white"] = Math.max(0, g.timers[color === BLACK ? "black" : "white"] || 0);
  }

  /**
   * 计算双方累计用时（含当前回合已进行的部分）。
   *
   * @returns {{black:number,white:number}|null} 非黑白棋返回 null。
   */
  _elapsedTimers() {
    const g = this.game;
    if (this.config.key !== "reversi") return null;
    const timers = { black: g.timers?.black || 0, white: g.timers?.white || 0 };
    if (g.turnStartedAt) {
      const key = g.turn === BLACK ? "black" : "white";
      timers[key] += Math.max(0, Date.now() - g.turnStartedAt);
    }
    return timers;
  }
}

module.exports = { GridGameRoom };
