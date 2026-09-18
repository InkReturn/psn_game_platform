/**
 * 棋类游戏渲染层（浏览器端，服务器权威模式）。
 *
 * 覆盖井字棋 / 黑白棋 / 四子棋三款共用网格棋盘的游戏：它们除尺寸与连线规则外，
 * 交互与展示完全一致，因此共用一个渲染层 + authoritative-room.js 面板，
 * 而不是复制三份只有常量和标题不同的脚本。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"（state.board/turn/winner 等）；
 * - 玩家点击只产生意图（发 move/undo/surrender/... 请求），不修改镜像；
 * - 可落子提示复用 grid-rules.js 的纯函数（与服务端同一份规则代码），
 *   但最终合法性由服务器裁决，客户端提示只用于交互体验。
 */
(function () {
  "use strict";

  const rules = window.GridRules;
  const gameKey = document.body.dataset.gridGame;
  const config = rules?.configOf(gameKey);
  if (!config) return;

  const { EMPTY, BLACK, WHITE } = rules;

  /** 各游戏的标题与文案（渲染与状态文本共用，避免散落在多处）。 */
  const PRESENTATION = {
    tictactoe: { title: "井字棋", transport: "server-ws", prefix: "JZ" },
    reversi: { title: "黑白棋", transport: "server-ws", prefix: "HB" },
    connect4: { title: "四子棋", transport: "server-ws", prefix: "SZ" },
  };
  const presentation = PRESENTATION[gameKey];

  const canvas = document.querySelector("#boardCanvas");
  const ctx = canvas.getContext("2d");
  const localBtn = document.querySelector("#localBtn");
  const startBtn = document.querySelector("#startBtn");
  const restartBtn = document.querySelector("#restartBtn");
  const swapSideBtn = document.querySelector("#swapSideBtn");
  const undoBtn = document.querySelector("#undoBtn");
  const undoModeField = document.querySelector("#undoModeField");
  const undoModeSelect = document.querySelector("#undoModeSelect");
  const roomStatus = document.querySelector("#roomStatus");
  const turnBadge = document.querySelector("#turnBadge");
  const matchStatus = document.querySelector("#matchStatus");
  const blackPlayer = document.querySelector("#blackPlayer");
  const whitePlayer = document.querySelector("#whitePlayer");
  const blackPieceCount = document.querySelector("#blackPieceCount");
  const whitePieceCount = document.querySelector("#whitePieceCount");
  const moveList = document.querySelector("#moveList");
  const recordSession = document.querySelector("#recordSession");
  const totalGames = document.querySelector("#totalGames");
  const blackWins = document.querySelector("#blackWins");
  const whiteWins = document.querySelector("#whiteWins");
  const resultModal = document.querySelector("#resultModal");
  const resultTitle = document.querySelector("#resultTitle");
  const resultSummary = document.querySelector("#resultSummary");
  const modalTotalGames = document.querySelector("#modalTotalGames");
  const modalBlackWins = document.querySelector("#modalBlackWins");
  const modalWhiteWins = document.querySelector("#modalWhiteWins");
  const playAgainBtn = document.querySelector("#playAgainBtn");
  const exitRoomBtn = document.querySelector("#exitRoomBtn");

  /**
   * 客户端状态：在线时是服务器快照的只读镜像，本地模式下是本地权威状态。
   *
   * 两种模式共用同一份渲染路径，因此字段命名与服务器快照完全一致。
   */
  const state = {
    board: rules.createInitialBoard(config),
    moves: [],
    turn: BLACK,
    winner: EMPTY,
    draw: false,
    started: false,
    mode: "idle",
    seatColor: null,
    roomId: "",
    players: { black: "等待", white: "等待" },
    record: { total: 0, players: {}, draw: 0 },
    recordLabel: "新房间",
    gameCounted: false,
    hostColor: BLACK,
    swapAfterGame: false,
    nextBlackColor: EMPTY,
    undoMode: gameKey === "reversi" ? "no-undo" : null,
    timers: gameKey === "reversi" ? { black: 0, white: 0 } : null,
    turnStartedAt: null,
    message: "创建房间、加入房间或本地对战后开始",
    legalMoves: [],
    room: null,
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;
  /** 本地模式下的计时刷新器（仅黑白棋使用）。 */
  let renderTicker = null;

  /** 当前选中的悔棋模式（页面下拉框）。
   * @returns {string} "undo" 或 "no-undo"。
   */
  function selectedUndoMode() {
    return undoModeSelect?.value === "undo" ? "undo" : "no-undo";
  }

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: gameKey,
    prefix: presentation.prefix,
    storageKey: `linkplay-room-${gameKey}-v1`,
    /** 状态栏文案依据：服务器是否已开局。 */
    isGameReady: () => state.started,
    onGameUpdate(snapshot) {
      // 1. 服务器权威快照到达：覆盖本地镜像并重绘。
      applyServerSnapshot(snapshot);
      render();
    },
    onRoomChange(room) {
      state.room = room;
      roomStatus.textContent = room.roomId ? `房间 ${room.roomId}` : "未进入房间";
      if (!room.roomId) {
        // 1. 退出房间后回到未开局状态（本地模式不受影响）。
        if (state.mode !== "local") {
          state.mode = "idle";
          state.seatColor = null;
          state.roomId = "";
          state.players = { black: "等待", white: "等待" };
          state.started = false;
          state.message = "创建房间、加入房间或本地对战后开始";
        }
        render();
        return;
      }
      // 2. 进入房间：模式切到在线，由座位映射推导自己执子颜色。
      state.mode = "online";
      state.roomId = room.roomId;
      syncSeatColor();
      render();
    },
    onError(err) {
      if (err?.message) {
        state.message = err.message;
        render();
      }
    },
  });

  /**
   * 本地玩家执子颜色（以服务器座位映射为准，不依赖 host/guest 角色）。
   *
   * @returns {number|null} BLACK/WHITE；不在座返回 null（只能观战）。
   */
  function localColor() {
    const myId = roomApi?.getPlayerId?.() || "";
    if (state.mode === "local") return state.turn;
    if (!myId || !state.seatPlayerIds) return null;
    if (state.seatPlayerIds.black === myId) return BLACK;
    if (state.seatPlayerIds.white === myId) return WHITE;
    return null;
  }

  /** 把房间角色映射成执子颜色（客户端 UI 用）。 */
  function syncSeatColor() {
    const myId = roomApi?.getPlayerId?.() || "";
    if (!myId) {
      state.seatColor = roomApi?.isHost?.() ? state.hostColor : null;
      return;
    }
    if (state.seatPlayerIds?.black === myId) state.seatColor = BLACK;
    else if (state.seatPlayerIds?.white === myId) state.seatColor = WHITE;
    else state.seatColor = null;
  }

  /**
   * 应用服务器权威快照。
   *
   * @param {object} snapshot - {room, game} 服务器快照。
   */
  function applyServerSnapshot(snapshot) {
    if (!snapshot?.game) return;
    const g = snapshot.game;
    // 1. 覆盖全部权威字段。
    state.board = Array.isArray(g.board) ? g.board : rules.createInitialBoard(config);
    state.moves = Array.isArray(g.moves) ? g.moves : [];
    state.turn = g.turn || BLACK;
    state.winner = g.winner || EMPTY;
    state.draw = Boolean(g.draw);
    state.started = Boolean(g.started);
    state.players = g.players || state.players;
    state.record = g.record || state.record;
    state.recordLabel = g.recordLabel || state.recordLabel;
    state.gameCounted = Boolean(g.gameCounted);
    state.hostColor = g.hostColor || BLACK;
    state.swapAfterGame = Boolean(g.swapAfterGame);
    state.nextBlackColor = g.nextBlackColor || EMPTY;
    state.undoMode = gameKey === "reversi" ? g.undoMode || "no-undo" : null;
    state.timers = g.timers || (gameKey === "reversi" ? { black: 0, white: 0 } : null);
    state.seatPlayerIds = g.seatPlayerIds || { black: null, white: null };
    // 2. 时钟用服务器给出的"本回合开始时刻"对齐，避免客户端自算导致两边读数漂移。
    state.turnStartedAt = gameKey === "reversi" && g.turnStartedAt ? Date.now() : null;
    state.message = g.message || state.message;
    if (undoModeSelect && gameKey === "reversi") undoModeSelect.value = state.undoMode === "undo" ? "undo" : "no-undo";
    syncSeatColor();
    updateLegalMoves();
  }

  /** 重新计算可落子提示（黑白棋）。 */
  function updateLegalMoves() {
    if (gameKey !== "reversi" || !state.started || state.winner || state.draw) {
      state.legalMoves = [];
      return;
    }
    state.legalMoves = rules.legalMoves(config, state.board, state.turn);
  }

  /** 颜色展示名。
   * @param {number} color - BLACK/WHITE。
   * @returns {string} 中文名。
   */
  function colorName(color) {
    return rules.colorLabel(config, color);
  }

  /** 本方当前是否可以先手落子。
   * @returns {boolean} true 表示轮到自己。
   */
  function canPlay() {
    if (!state.started || state.winner || state.draw) return false;
    if (state.mode === "local") return true;
    if (state.mode !== "online") return false;
    return localColor() === state.turn;
  }

  /** 发送一步落子意图（在线）/ 本地直接推进。 */
  function playCell(row, col) {
    if (!canPlay()) {
      state.message = state.started ? "还没轮到你操作" : "请先开始游戏";
      render();
      return;
    }
    if (state.mode === "online") {
      // 1. 在线模式：只发意图，棋盘等服务器快照回推后再改。
      roomApi.sendAction("move", { row, col }).catch(() => render());
      return;
    }
    // 2. 本地模式：用同一份规则模块推进，保证与服务端口径一致。
    const color = state.turn;
    const verdict = rules.validateMove(config, {
      board: state.board,
      color,
      cell: { row, col },
      started: true,
      over: false,
      turn: state.turn,
    });
    if (!verdict.ok) return;
    // 1. 结算本方用时（仅黑白棋）。
    commitLocalClock(color);
    state.board[verdict.row][verdict.col] = color;
    verdict.flips.forEach(([r, c]) => {
      state.board[r][c] = color;
    });
    state.moves.push({ row: verdict.row, col: verdict.col, color, flipCells: verdict.flips.map(([r, c]) => ({ row: r, col: c })), flips: verdict.flips.length });
    const outcome = rules.evaluateGridOutcome(config, state.board, { row: verdict.row, col: verdict.col }, color);
    if (outcome.over) finishLocalGame(outcome.winner, outcome.draw);
    else {
      state.turn = outcome.nextTurn;
      state.message = state.turn === color ? `${colorName(color)}继续落子` : `轮到${colorName(state.turn)}`;
    }
    updateLegalMoves();
    render();
  }

  /**
   * 本地模式结算（战绩与换先口径与服务器实现一致）。
   *
   * @param {number} winner - 获胜颜色；平局传 EMPTY。
   * @param {boolean} isDraw - 是否平局。
   */
  function finishLocalGame(winner, isDraw) {
    state.winner = winner;
    state.draw = isDraw;
    state.message = isDraw ? "双方平局" : `${colorName(winner)}获胜`;
    if (!state.gameCounted) {
      state.record.total += 1;
      if (isDraw) {
        state.record.draw += 1;
      } else {
        const name = state.players[winner === BLACK ? "black" : "white"];
        state.record.players[name] = (state.record.players[name] || 0) + 1;
      }
      state.gameCounted = true;
      state.nextBlackColor = gameKey === "tictactoe" ? WHITE : isDraw ? EMPTY : winner;
      state.swapAfterGame = Boolean(state.nextBlackColor);
    }
  }

  /** 认输：在线发意图，本地直接判负。 */
  function surrenderGame() {
    if (!state.started || state.winner || state.draw || state.mode === "idle") return;
    if (state.mode === "online") {
      roomApi.sendAction("surrender").catch(() => render());
      return;
    }
    const loser = state.mode === "local" ? state.turn : localColor();
    if (!loser) return;
    finishLocalGame(rules.opposite(loser), false);
    render();
  }

  /** 黑白棋悔棋：在线发意图，本地直接回滚镜像。 */
  function undoLastMove() {
    if (gameKey !== "reversi" || state.undoMode !== "undo" || !state.started || state.winner || state.draw) {
      state.message = state.undoMode === "undo" ? "当前没有可撤回的落子" : "当前房间未开启悔棋";
      render();
      return;
    }
    if (state.mode === "online") {
      roomApi.sendAction("undo").catch(() => render());
      return;
    }
    const move = state.moves.at(-1);
    if (!move) return;
    state.moves.pop();
    state.board[move.row][move.col] = EMPTY;
    const reverted = rules.opposite(move.color);
    (move.flipCells || []).forEach(({ row, col }) => {
      state.board[row][col] = reverted;
    });
    state.turn = move.color;
    state.winner = EMPTY;
    state.draw = false;
    state.gameCounted = false;
    state.message = `${colorName(move.color)}已悔一步，轮到${colorName(state.turn)}`;
    updateLegalMoves();
    render();
  }

  /** 开启新一局（本地）。 */
  function startLocal() {
    state.mode = "local";
    state.roomId = "local";
    state.hostColor = BLACK;
    state.swapAfterGame = false;
    state.nextBlackColor = EMPTY;
    if (gameKey === "reversi") state.undoMode = selectedUndoMode();
    state.players = { black: "本地玩家 A", white: "本地玩家 B" };
    state.record = { total: 0, players: {}, draw: 0 };
    state.recordLabel = "本地房间";
    state.gameCounted = false;
    resetBoardLocal();
    render();
  }

  /** 仅本地模式：按换先规则准备下一局棋盘。 */
  function resetBoardLocal() {
    if (state.nextBlackColor === WHITE) {
      const black = state.players.black;
      state.players.black = state.players.white;
      state.players.white = black;
    }
    state.nextBlackColor = EMPTY;
    state.swapAfterGame = false;
    state.board = rules.createInitialBoard(config);
    state.moves = [];
    state.turn = BLACK;
    state.winner = EMPTY;
    state.draw = false;
    state.started = true;
    state.gameCounted = false;
    state.timers = gameKey === "reversi" ? { black: 0, white: 0 } : null;
    // 1. 本地模式没有服务器下发的 turnStartedAt，计时必须由客户端自己启动，
    //    否则本地黑白棋的用时永远显示 00:00（在线模式的计时以服务器为准）。
    state.turnStartedAt = gameKey === "reversi" ? Date.now() : null;
    state.message = "对局开始，先手落子";
    updateLegalMoves();
  }

  /**
   * 本地模式结算本方回合用时并切换计时目标。
   *
   * @param {number} color - 刚刚完成落子的颜色。
   */
  function commitLocalClock(color) {
    if (gameKey !== "reversi" || !state.turnStartedAt) return;
    const elapsed = elapsedTimers();
    state.timers = elapsed;
    state.turnStartedAt = Date.now();
    const key = color === BLACK ? "black" : "white";
    state.timers[key] = Math.max(0, state.timers[key] || 0);
  }

  /** 开始/再开一把：在线发意图，本地重启一局。 */
  function startGame() {
    if (state.mode === "online") {
      // 1. 在线：由服务器决定是否允许开局，并使用 play_again 保留战绩换先。
      roomApi.sendAction(state.started ? "play_again" : "start").catch(() => render());
      return;
    }
    if (state.mode !== "local") {
      state.message = "请先创建房间、加入房间或选择本地对战";
      render();
      return;
    }
    resetBoardLocal();
    render();
  }

  /** 重新开始：清空战绩重开（在线发 restart）。 */
  function restartGame() {
    if (state.mode === "online") {
      roomApi.sendAction("restart").catch(() => render());
      return;
    }
    if (state.mode !== "local") {
      state.message = "请先创建房间、加入房间或选择本地对战";
      render();
      return;
    }
    state.record = { total: 0, players: {}, draw: 0 };
    state.recordLabel = "本地房间";
    state.nextBlackColor = EMPTY;
    state.swapAfterGame = false;
    resetBoardLocal();
    render();
  }

  /** 控制房内按钮可见性。 */
  function updateRoomControls() {
    const inOnlineRoom = state.mode === "online" && Boolean(state.roomId);
    if (localBtn) localBtn.hidden = inOnlineRoom;
    if (undoModeField) undoModeField.hidden = inOnlineRoom || gameKey !== "reversi" || state.started;
  }

  // ── 画布渲染 ───────────────────────────────────────────────────

  /** 棋盘几何（与旧实现一致，保证视觉与点击反解对齐）。 */
  function boardGeometry() {
    const pad = gameKey === "connect4" ? 54 : 46;
    const usable = canvas.width - pad * 2;
    const cell = Math.min(usable / config.cols, usable / config.rows);
    const width = cell * config.cols;
    const height = cell * config.rows;
    return { x: (canvas.width - width) / 2, y: (canvas.height - height) / 2, cell, width, height };
  }

  /** 坐标点文本（黑白棋用字母+数字）。 */
  function cellLabel(row, col) {
    return gameKey === "reversi" ? `${String.fromCharCode(65 + col)}${row + 1}` : `${row + 1}, ${col + 1}`;
  }

  /** 绘制单个棋子。 */
  function drawPiece(cx, cy, radius, color) {
    if (gameKey === "connect4") {
      ctx.fillStyle = color === BLACK ? "#d84242" : "#f2d35e";
      ctx.beginPath();
      ctx.arc(cx, cy, radius, 0, Math.PI * 2);
      ctx.fill();
      ctx.strokeStyle = color === BLACK ? "#8c2020" : "#b48615";
      ctx.lineWidth = 4;
      ctx.stroke();
      return;
    }
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    if (gameKey === "reversi") {
      ctx.fillStyle = color === BLACK ? "#1d1d1d" : "#f7f7f3";
      ctx.fill();
      ctx.strokeStyle = color === BLACK ? "#000" : "#c9c4b5";
      ctx.lineWidth = 2;
      ctx.stroke();
    } else {
      ctx.fillStyle = color === BLACK ? "#d84242" : "#2f6fd0";
      ctx.fill();
    }
  }

  /** 绘制 X/O（井字棋）。 */
  function drawX(cx, cy, size) {
    ctx.strokeStyle = "#c0392b";
    ctx.lineWidth = 12;
    ctx.lineCap = "round";
    ctx.beginPath();
    ctx.moveTo(cx - size, cy - size);
    ctx.lineTo(cx + size, cy + size);
    ctx.moveTo(cx + size, cy - size);
    ctx.lineTo(cx - size, cy + size);
    ctx.stroke();
  }

  function drawO(cx, cy, radius) {
    ctx.strokeStyle = "#2f6fd0";
    ctx.lineWidth = 12;
    ctx.beginPath();
    ctx.arc(cx, cy, radius, 0, Math.PI * 2);
    ctx.stroke();
  }

  /** 绘制棋盘。 */
  function renderBoard() {
    const geom = boardGeometry();
    ctx.clearRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = gameKey === "connect4" ? "#1d5fab" : gameKey === "reversi" ? "#d9ae72" : "#f1c978";
    ctx.fillRect(0, 0, canvas.width, canvas.height);

    // 1. 网格线（四子棋不画格线，画的是棋盘格）。
    if (gameKey !== "connect4") {
      ctx.strokeStyle = gameKey === "reversi" ? "rgba(70,50,25,0.35)" : "rgba(120,80,30,0.35)";
      ctx.lineWidth = 2;
      for (let row = 0; row <= config.rows; row += 1) {
        ctx.beginPath();
        ctx.moveTo(geom.x, geom.y + row * geom.cell);
        ctx.lineTo(geom.x + geom.width, geom.y + row * geom.cell);
        ctx.stroke();
      }
      for (let col = 0; col <= config.cols; col += 1) {
        ctx.beginPath();
        ctx.moveTo(geom.x + col * geom.cell, geom.y);
        ctx.lineTo(geom.x + col * geom.cell, geom.y + geom.height);
        ctx.stroke();
      }
    } else {
      ctx.fillStyle = "rgba(255,255,255,0.14)";
      for (let row = 0; row < config.rows; row += 1) {
        for (let col = 0; col < config.cols; col += 1) {
          if ((row + col) % 2 === 0) continue;
          ctx.fillRect(geom.x + col * geom.cell, geom.y + row * geom.cell, geom.cell, geom.cell);
        }
      }
    }

    // 2. 黑白棋可落子提示点。
    if (gameKey === "reversi") {
      ctx.fillStyle = "rgba(255,255,255,0.55)";
      state.legalMoves.forEach(({ row, col }) => {
        ctx.beginPath();
        ctx.arc(geom.x + col * geom.cell + geom.cell / 2, geom.y + row * geom.cell + geom.cell / 2, geom.cell * 0.08, 0, Math.PI * 2);
        ctx.fill();
      });
    }

    // 3. 棋子。
    const radius = geom.cell * (gameKey === "reversi" ? 0.4 : 0.36);
    for (let row = 0; row < config.rows; row += 1) {
      for (let col = 0; col < config.cols; col += 1) {
        const value = state.board[row]?.[col] ?? EMPTY;
        if (value === EMPTY) continue;
        const cx = geom.x + col * geom.cell + geom.cell / 2;
        const cy = geom.y + row * geom.cell + geom.cell / 2;
        if (gameKey === "tictactoe") {
          if (value === BLACK) drawX(cx, cy, radius * 0.7);
          else drawO(cx, cy, radius * 0.72);
        } else {
          drawPiece(cx, cy, radius, value);
        }
      }
    }

    // 4. 最新一步标记（黑白棋）。
    const last = state.moves.at(-1);
    if (last && gameKey === "reversi") {
      ctx.strokeStyle = "#e8b431";
      ctx.lineWidth = 3;
      ctx.beginPath();
      ctx.arc(geom.x + last.col * geom.cell + geom.cell / 2, geom.y + last.row * geom.cell + geom.cell / 2, radius + 4, 0, Math.PI * 2);
      ctx.stroke();
    }
  }

  /** 当前累计用时（含进行中的回合）。 */
  function elapsedTimers() {
    if (gameKey !== "reversi") return null;
    const timers = { black: state.timers?.black || 0, white: state.timers?.white || 0 };
    if (state.turnStartedAt) {
      const key = state.turn === BLACK ? "black" : "white";
      timers[key] += Math.max(0, Date.now() - state.turnStartedAt);
    }
    return timers;
  }

  /** 用时格式化 mm:ss。 */
  function formatTimer(ms) {
    const totalSeconds = Math.max(0, Math.floor(ms / 1000));
    return `${String(Math.floor(totalSeconds / 60)).padStart(2, "0")}:${String(totalSeconds % 60).padStart(2, "0")}`;
  }

  /** 渲染状态面板与战绩。 */
  function renderStatus() {
    const pieces = rules.countPieces(state.board);
    const timers = elapsedTimers();
    if (undoModeSelect && gameKey === "reversi" && !state.started) undoModeSelect.value = state.undoMode === "undo" ? "undo" : "no-undo";
    const blackTimer = timers ? ` ${formatTimer(timers.black)}` : "";
    const whiteTimer = timers ? ` ${formatTimer(timers.white)}` : "";
    blackPlayer.textContent = `${colorName(BLACK)}：${state.players.black}${blackTimer}`;
    whitePlayer.textContent = `${colorName(WHITE)}：${state.players.white}${whiteTimer}`;
    if (blackPieceCount) blackPieceCount.textContent = pieces.black;
    if (whitePieceCount) whitePieceCount.textContent = pieces.white;
    const running = gameKey === "reversi" && state.started && !state.winner && !state.draw;
    blackPlayer.classList.toggle("active-timer", running && state.turn === BLACK);
    whitePlayer.classList.toggle("active-timer", running && state.turn === WHITE);
    if (undoBtn) {
      undoBtn.hidden = gameKey !== "reversi";
      undoBtn.disabled = !canLocalUndo();
    }
    recordSession.textContent = state.recordLabel;
    totalGames.textContent = state.record.total;
    // 1. 战绩按座位（先手/后手）归属统计，而不是按昵称去 record.players 里查：
    //    两位玩家用默认昵称（例如都叫"玩家7288"）时，按昵称查询会让两边的胜场互相污染，
    //    表现为"只有一方赢过，两边却都显示 2 胜"。服务端的 record.players 仍按昵称聚合，
    //    这里由服务器下发的 winnerColor 累计值还原到座位，两个口径并存且不会互相覆盖。
    const seatWins = seatWinCounts();
    if (blackWins.previousElementSibling) blackWins.previousElementSibling.textContent = `${state.players.black}胜`;
    if (whiteWins.previousElementSibling) whiteWins.previousElementSibling.textContent = `${state.players.white}胜`;
    if (modalBlackWins.previousElementSibling) modalBlackWins.previousElementSibling.textContent = `${state.players.black}胜`;
    if (modalWhiteWins.previousElementSibling) modalWhiteWins.previousElementSibling.textContent = `${state.players.white}胜`;
    blackWins.textContent = seatWins.black;
    whiteWins.textContent = seatWins.white;
    modalTotalGames.textContent = state.record.total;
    modalBlackWins.textContent = seatWins.black;
    modalWhiteWins.textContent = seatWins.white;
    turnBadge.textContent = state.winner ? `${colorName(state.winner)}获胜` : state.draw ? "平局" : state.started ? `${colorName(state.turn)}回合` : "等待开始";
    matchStatus.textContent = state.message;
    updateActionButtons(seatWins);
    updateRoomControls();
    moveList.innerHTML = "";
    state.moves.slice(-18).forEach((move, index) => {
      const item = document.createElement("li");
      const extra = move.flips ? `，翻转 ${move.flips}` : "";
      item.textContent = `${Math.max(0, state.moves.length - 18) + index + 1}. ${colorName(move.color)} (${cellLabel(move.row, move.col)})${extra}`;
      moveList.appendChild(item);
    });
  }

  /** 本地模式下是否可悔棋（在线模式由服务器最终裁决）。 */
  function canLocalUndo() {
    if (gameKey !== "reversi" || state.undoMode !== "undo" || !state.started || state.winner || state.draw) return false;
    const move = state.moves.at(-1);
    if (!move) return false;
    if (state.mode === "local") return true;
    if (state.mode !== "online") return false;
    return localColor() === move.color;
  }

  /**
   * 按座位统计胜场。
   *
   * 服务器快照里的 record.players 以昵称为键（昵称可重复、可改），因此这里优先使用
   * 按颜色累计的 record.winners；旧快照或本地模式下回退到按当前座位昵称查询。
   *
   * @returns {{black:number,white:number}} 先手/后手各自的胜场数。
   */
  function seatWinCounts() {
    const winners = state.record?.winners;
    if (winners && typeof winners === "object") {
      return { black: Number(winners.black) || 0, white: Number(winners.white) || 0 };
    }
    return {
      black: Number(state.record?.players?.[state.players.black]) || 0,
      white: Number(state.record?.players?.[state.players.white]) || 0,
    };
  }

  /** 结算弹窗文案：平局 / 我方获胜 / 对方获胜。 */
  function resultSummaryText() {
    if (state.draw) return "本局平局，要再开一把吗？";
    // 1. 本地模式没有"我方"概念，直接报胜方颜色名。
    const mine = state.mode === "local" ? null : localColor();
    if (mine === null || state.mode === "local") return `${colorName(state.winner)}获胜，要再开一把吗？`;
    // 2. 在线模式按自己执子颜色给出明确的输赢结论，避免只显示"黑棋获胜"还要玩家自己换算。
    const won = mine === state.winner;
    const opponentName = state.players[won ? (mine === BLACK ? "white" : "black") : mine === BLACK ? "black" : "white"];
    if (won) return `你获胜了，要再开一把吗？`;
    return `${opponentName || colorName(state.winner)}获胜，要再开一把吗？`;
  }

  /**
   * 更新对局控制按钮的文案与可用性。
   *
   * 对局进行中只保留"投降 / 重新开始"；未开局或已结束显示"开始 / 再开一把"。
   * 在线模式下交换座位由 `switch_side` 动作推进（服务器权威），因此额外提供换位入口。
   *
   * @param {{black:number,white:number}} seatWins - 当前按座位统计的胜场（暂未使用，保留给后续展示扩展）。
   */
  function updateActionButtons(seatWins) {
    const inRoom = state.mode === "online" && Boolean(state.roomId);
    const playing = state.started && !state.winner && !state.draw;
    // 1. 主按钮：未开局 -> 开始；对局进行中 -> 投降；已结束 -> 再开一把。
    if (startBtn) {
      startBtn.textContent = playing ? "投降" : state.started ? "再开一把" : "开始";
      startBtn.disabled = state.mode === "idle" || (inRoom && !roomApi?.isHost?.() && !playing);
    }
    // 2. 重新开始：任意玩家都可以发起（服务器会校验房间内身份）。
    if (restartBtn) {
      restartBtn.textContent = "重新开始";
      restartBtn.disabled = state.mode === "idle" || (inRoom && !roomApi?.isHost?.());
    }
    // 3. 交换位置：在线房间内所有玩家都可以发起，由服务器换位后广播。
    if (swapSideBtn) {
      swapSideBtn.hidden = !inRoom;
      swapSideBtn.disabled = state.moves.length > 0 && !state.winner && !state.draw;
    }
  }

  /** 交换座位（在线）/ 本地模式下交换先后手。 */
  function switchSide() {
    if (state.mode === "online") {
      roomApi.sendAction("switch_side").catch(() => render());
      return;
    }
    if (state.mode !== "local") {
      state.message = "请先创建房间、加入房间或选择本地对战";
      render();
      return;
    }
    // 1. 本地模式直接交换双方昵称与先后手（对阵未开始时才允许，避免中途换色）。
    if (state.moves.length > 0 && !state.winner && !state.draw) {
      state.message = "对局进行中不能交换位置";
      render();
      return;
    }
    const black = state.players.black;
    state.players.black = state.players.white;
    state.players.white = black;
    state.hostColor = rules.opposite(state.hostColor);
    state.board = rules.createInitialBoard(config);
    state.moves = [];
    state.turn = BLACK;
    state.winner = EMPTY;
    state.draw = false;
    state.message = "已交换先后手";
    updateLegalMoves();
    render();
  }

  /** 结果弹窗。 */
  function showResultModal() {
    resultModal.hidden = false;
    resultTitle.textContent = "本局结束";
    resultSummary.textContent = resultSummaryText();
  }

  function hideResultModal() {
    resultModal.hidden = true;
  }

  /** 统一渲染入口。 */
  function render() {
    renderBoard();
    renderStatus();
    if (state.winner || state.draw) showResultModal();
    else hideResultModal();
  }

  /** 点击画布反解成格子坐标。 */
  function canvasToCell(event) {
    const rect = canvas.getBoundingClientRect();
    const x = ((event.clientX - rect.left) * canvas.width) / rect.width;
    const y = ((event.clientY - rect.top) * canvas.height) / rect.height;
    const geom = boardGeometry();
    const col = Math.floor((x - geom.x) / geom.cell);
    const row = Math.floor((y - geom.y) / geom.cell);
    if (row < 0 || col < 0 || row >= config.rows || col >= config.cols) return null;
    return { row, col };
  }

  canvas.addEventListener("click", (event) => {
    const cell = canvasToCell(event);
    if (!cell) return;
    playCell(cell.row, cell.col);
  });

  localBtn?.addEventListener("click", startLocal);
  undoModeSelect?.addEventListener("change", () => {
    state.undoMode = selectedUndoMode();
    // 1. 在线时把设置同步给服务器（服务器是权威，只有它改了才算数）。
    if (gameKey === "reversi" && state.mode === "online" && !state.started) {
      roomApi.sendAction("set_undo_mode", { undoMode: state.undoMode }).catch(() => render());
    }
    render();
  });
  // 1. 主按钮按局面切换语义：未开局=开始，进行中=投降，已结束=再开一把。
  startBtn.addEventListener("click", () => {
    if (state.started && !state.winner && !state.draw) {
      surrenderGame();
      return;
    }
    startGame();
  });
  restartBtn.addEventListener("click", restartGame);
  swapSideBtn?.addEventListener("click", switchSide);
  playAgainBtn.addEventListener("click", startGame);
  undoBtn?.addEventListener("click", undoLastMove);
  exitRoomBtn.addEventListener("click", () => {
    roomApi?.leaveRoom?.();
    window.location.href = "index.html";
  });
  window.addEventListener("resize", render);

  window.render_game_to_text = () =>
    JSON.stringify({
      game: gameKey,
      gameType: gameKey,
      transportKind: presentation.transport,
      mode: state.mode,
      role: state.mode === "local" ? "both" : localColor() === BLACK ? "black" : localColor() === WHITE ? "white" : "spectator",
      roomId: state.roomId,
      rows: config.rows,
      cols: config.cols,
      board: state.board,
      hostColor: colorName(state.hostColor),
      swapAfterGame: state.swapAfterGame,
      nextBlackColor: state.nextBlackColor ? colorName(state.nextBlackColor) : null,
      undoMode: state.undoMode,
      pieceCounts: gameKey === "reversi" ? rules.countPieces(state.board) : null,
      timers: elapsedTimers(),
      moves: state.moves.map((move) => ({ ...move, point: cellLabel(move.row, move.col) })),
      turn: colorName(state.turn),
      winner: state.winner ? colorName(state.winner) : null,
      draw: state.draw,
      started: state.started,
      players: state.players,
      record: state.record,
      message: state.message,
      legalMoves: state.legalMoves,
      modalOpen: !resultModal.hidden,
      seatPlayerIds: state.seatPlayerIds || { black: null, white: null },
      room: state.room ? { roomId: state.room.roomId, role: state.room.role } : null,
      playerId: roomApi?.getPlayerId?.() || "",
      serverConnected: roomApi?.isOnline?.() || false,
      peerCount: roomApi?.connectionCount?.() || 0,
      memberCount: state.room?.members?.length || 0,
      connectionStatus: document.querySelector("#roomStatus")?.textContent || "",
    });

  window.advanceTime = () => render();

  // 1. 供自动化测试直接发送原始动作（绕过前端本地拦截，用于验证服务端越权校验）。
  window.roomApi = roomApi;

  // 2. 首帧渲染 + 黑白棋计时刷新。
  render();
  if (gameKey === "reversi") {
    renderTicker = window.setInterval(() => {
      if (state.started && !state.winner && !state.draw && state.turnStartedAt) renderStatus();
    }, 250);
    window.addEventListener("beforeunload", () => {
      if (renderTicker) window.clearInterval(renderTicker);
    });
  }
})();
