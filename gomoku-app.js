const BOARD_SIZE = 15;
const EMPTY = 0;
const BLACK = 1;
const WHITE = 2;

const canvas = document.querySelector("#boardCanvas");
const ctx = canvas.getContext("2d");
const roomInput = document.querySelector("#roomInput");
const surrenderBtn = document.querySelector("#surrenderBtn");
const restartBtn = document.querySelector("#restartBtn");
const undoBtn = document.querySelector("#undoBtn");
const approveUndoBtn = document.querySelector("#approveUndoBtn");
const rejectUndoBtn = document.querySelector("#rejectUndoBtn");
const undoRequestPanel = document.querySelector("#undoRequestPanel");
const undoRequestText = document.querySelector("#undoRequestText");
const connectionStatus = document.querySelector("#connectionStatus");
const matchStatus = document.querySelector("#matchStatus");
const turnBadge = document.querySelector("#turnBadge");
const blackPlayer = document.querySelector("#blackPlayer");
const whitePlayer = document.querySelector("#whitePlayer");
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
 * 五子棋客户端状态。
 *
 * board/moves/turn/winner/record 等全部来自服务器权威快照，
 * 本地只做渲染与操作意图发送，不自行推进规则。
 */
const state = {
  board: createBoard(),
  moves: [],
  turn: BLACK,
  winner: EMPTY,
  mode: "idle",
  role: "spectator",
  roomId: "",
  players: { black: "等待", white: "等待" },
  hover: null,
  message: "创建房间或加入房间开始对局",
  record: { total: 0, players: {} },
  recordLabel: "新房间",
  gameCounted: false,
  undoRequest: null,
  undoLocks: { [BLACK]: false, [WHITE]: false },
  hostColor: BLACK,
  swapAfterGame: false,
  nextBlackColor: EMPTY,
  room: null,
  /** 服务器座位映射（color -> playerId），用于判断自己执哪一方。 */
  seatPlayerIds: { black: null, white: null },
};

/**
 * 联机面板 API 句柄。
 *
 * 必须在 initGomokuPanel 之前用 let 声明：面板初始化过程中就会同步回调
 * onRoomChange，该回调会走到 ownColor() 读取 playerId。若此处用 const 声明，
 * 带 ?room=xxx 的邀请链接在页面加载时即抛 "Cannot access 'roomApi' before
 * initialization"，整页脚本中断、无法加入房间。
 */
let roomApi = null;

/**
 * 初始化服务器权威联机面板。
 *
 * - onGameUpdate：服务器推送的权威快照（room + game）到达时刷新本地渲染。
 * - onError：服务器拒绝操作时以中文文案提示。
 */
roomApi = window.initGomokuPanel({
  onRoomChange(room) {
    state.room = room;
    if (!room.roomId) {
      state.mode = "idle";
      state.role = "spectator";
      state.roomId = "";
      state.players = { black: "等待", white: "等待" };
      state.seatPlayerIds = { black: null, white: null };
      state.message = "创建房间或加入房间开始对局";
      state.board = createBoard();
      state.moves = [];
      state.winner = EMPTY;
      state.turn = BLACK;
      hideResultModal();
      render();
      return;
    }
    state.mode = "online";
    state.roomId = room.roomId;
    // 1. 进入房间后立刻按服务器座位映射推导本地执子颜色。
    //    权威快照（含 seatPlayerIds）先于本回调到达，此处必须重新推导，
    //    否则角色停留在 spectator，房主/访客都无法点击棋盘落子。
    syncRoleFromSeat();
    // 2. 状态文案完全由"房间成员 + 连接状态"推导：
    //    绝不能在对手已经进房后还显示"等待加入"。
    const members = Array.isArray(room.members) ? room.members : [];
    const onlineCount = members.filter((m) => m.connected).length;
    if (room.online !== "online") {
      setStatus(room.online === "connecting" ? "连接中" : "连接断开，重连中", false);
    } else if (onlineCount >= 2) {
      setStatus("对局进行中", true);
    } else if (members.length > 1) {
      setStatus("对手掉线中", false);
    } else {
      setStatus(room.role === "host" ? "房间已创建，等待加入" : "已加入", true);
    }
    updateRoomControls();
    render();
  },
  onGameUpdate(snapshot) {
    applyServerSnapshot(snapshot);
    render();
  },
  onError(err) {
    if (err && err.message) {
      state.message = err.message;
      render();
    }
  },
});

function createBoard() {
  return Array.from({ length: BOARD_SIZE }, () => Array(BOARD_SIZE).fill(EMPTY));
}

function colorName(color) {
  return color === BLACK ? "黑棋" : "白棋";
}

function colorKey(color) {
  return color === BLACK ? "black" : "white";
}

function oppositeColor(color) {
  return color === BLACK ? WHITE : BLACK;
}

/** 计算自己执子的颜色（在线模式以服务器座位映射为准，换先后依然正确）。 */
function ownColor() {
  if (state.mode === "online") {
    // 1. 面板可能仍在初始化（同步回调阶段）：此时还没有 playerId，视为座位未定。
    const myId = roomApi ? roomApi.getPlayerId() : "";
    if (!myId) return EMPTY;
    if (state.seatPlayerIds && state.seatPlayerIds.black === myId) return BLACK;
    if (state.seatPlayerIds && state.seatPlayerIds.white === myId) return WHITE;
    return EMPTY;
  }
  if (state.role === "black") return BLACK;
  if (state.role === "white") return WHITE;
  return EMPTY;
}

/** 根据座位颜色刷新本地角色标记。 */
function syncRoleFromSeat() {
  const color = ownColor();
  if (color === BLACK) state.role = "black";
  if (color === WHITE) state.role = "white";
}

function cellLabel(row, col) {
  return `${String.fromCharCode(65 + col)}${row + 1}`;
}

function setStatus(text, connected = false) {
  connectionStatus.textContent = text;
  connectionStatus.style.color = connected ? "var(--accent)" : "var(--warn)";
}

function normalizeRecord(record = state.record) {
  const normalized = {
    total: Number(record?.total) || 0,
    players: { ...(record?.players || {}) },
  };
  if (!record?.players) {
    if (record?.black) normalized.players[state.players.black] = (normalized.players[state.players.black] || 0) + record.black;
    if (record?.white) normalized.players[state.players.white] = (normalized.players[state.players.white] || 0) + record.white;
  }
  return normalized;
}

function winsForPlayer(name) {
  return normalizeRecord().players[name] || 0;
}

function hideResultModal() {
  resultModal.hidden = true;
}

function showResultModal() {
  resultModal.hidden = false;
  resultTitle.textContent = "本局结束";
  resultSummary.textContent = `${colorName(state.winner)}获胜，要再开一把吗？`;
  modalTotalGames.textContent = state.record.total;
  if (modalBlackWins.previousElementSibling) modalBlackWins.previousElementSibling.textContent = `${state.players.black}胜`;
  if (modalWhiteWins.previousElementSibling) modalWhiteWins.previousElementSibling.textContent = `${state.players.white}胜`;
  modalBlackWins.textContent = winsForPlayer(state.players.black);
  modalWhiteWins.textContent = winsForPlayer(state.players.white);
}

/**
 * 应用服务器权威快照。
 *
 * @param {object} snapshot - {room, game} 服务器快照；game 字段与本地渲染状态一一对应。
 */
function applyServerSnapshot(snapshot) {
  if (!snapshot?.game) return;
  const g = snapshot.game;
  // 1. 直接覆盖权威字段（棋盘、轮次、胜负、战绩、悔棋、换先标记）。
  state.board = g.board || createBoard();
  state.moves = g.moves || [];
  state.turn = g.turn || BLACK;
  state.winner = g.winner || EMPTY;
  state.players = g.players || state.players;
  state.message = g.message || state.message;
  state.record = normalizeRecord(g.record || state.record);
  state.recordLabel = g.recordLabel || state.recordLabel;
  state.gameCounted = Boolean(g.gameCounted);
  state.undoRequest = g.undoRequest || null;
  state.undoLocks = g.undoLocks || { [BLACK]: false, [WHITE]: false };
  state.hostColor = g.hostColor || BLACK;
  state.swapAfterGame = Boolean(g.swapAfterGame);
  state.nextBlackColor = g.nextBlackColor || EMPTY;
  state.seatPlayerIds = g.seatPlayerIds || { black: null, white: null };
  // 2. 重新推导本地角色并刷新结算弹窗。
  syncRoleFromSeat();
  if (state.winner) showResultModal();
  else hideResultModal();
}

function updateRoomControls() {
  if (restartBtn) restartBtn.hidden = false;
}

function updateUndoPanel() {
  const request = state.undoRequest;
  const myColor = ownColor();
  const shouldReview = request && state.mode === "online" && request.requesterColor !== myColor;
  undoRequestPanel.hidden = !shouldReview;
  if (shouldReview) {
    undoRequestText.textContent = `${colorName(request.requesterColor)}请求悔一步`;
  }
  const ownPending = request && request.requesterColor === myColor;
  const hasOwnMove = myColor ? state.moves.some((move) => move.color === myColor) : false;
  undoBtn.disabled =
    Boolean(request) ||
    state.winner ||
    !state.moves.length ||
    state.mode !== "online" ||
    !myColor ||
    !hasOwnMove ||
    Boolean(state.undoLocks[myColor]);
  if (ownPending) {
    undoBtn.textContent = "等待对方同意";
  } else {
    undoBtn.textContent = "悔棋";
  }
  if (surrenderBtn) {
    surrenderBtn.disabled = state.mode === "idle" || state.winner || Boolean(state.undoRequest);
  }
}

function updatePlayers() {
  blackPlayer.textContent = `黑棋：${state.players.black}`;
  whitePlayer.textContent = `白棋：${state.players.white}`;
}

function updateRecord() {
  recordSession.textContent = state.recordLabel;
  totalGames.textContent = state.record.total;
  if (blackWins.previousElementSibling) blackWins.previousElementSibling.textContent = `${state.players.black}胜`;
  if (whiteWins.previousElementSibling) whiteWins.previousElementSibling.textContent = `${state.players.white}胜`;
  if (modalBlackWins.previousElementSibling) modalBlackWins.previousElementSibling.textContent = `${state.players.black}胜`;
  if (modalWhiteWins.previousElementSibling) modalWhiteWins.previousElementSibling.textContent = `${state.players.white}胜`;
  blackWins.textContent = winsForPlayer(state.players.black);
  whiteWins.textContent = winsForPlayer(state.players.white);
  modalTotalGames.textContent = state.record.total;
  modalBlackWins.textContent = winsForPlayer(state.players.black);
  modalWhiteWins.textContent = winsForPlayer(state.players.white);
}

function updateMoves() {
  moveList.innerHTML = "";
  state.moves.forEach((move, index) => {
    const item = document.createElement("li");
    item.textContent = `${index + 1}. ${colorName(move.color)} (${cellLabel(move.row, move.col)})`;
    moveList.appendChild(item);
  });
}

function renderBoard() {
  ctx.clearRect(0, 0, canvas.width, canvas.height);
  ctx.fillStyle = "#d8b577";
  ctx.fillRect(0, 0, canvas.width, canvas.height);

  const pad = 42;
  const gap = (canvas.width - pad * 2) / (BOARD_SIZE - 1);

  ctx.strokeStyle = "rgba(36, 25, 9, 0.55)";
  ctx.lineWidth = 2;
  for (let i = 0; i < BOARD_SIZE; i += 1) {
    const pos = pad + gap * i;
    ctx.beginPath();
    ctx.moveTo(pad, pos);
    ctx.lineTo(canvas.width - pad, pos);
    ctx.stroke();

    ctx.beginPath();
    ctx.moveTo(pos, pad);
    ctx.lineTo(pos, canvas.height - pad);
    ctx.stroke();
  }

  drawCoordinateLabels(pad, gap);

  [[3, 3], [3, 11], [7, 7], [11, 3], [11, 11]].forEach(([row, col]) => {
    ctx.beginPath();
    ctx.fillStyle = "#2a1b08";
    ctx.arc(pad + col * gap, pad + row * gap, 5, 0, Math.PI * 2);
    ctx.fill();
  });

  if (state.hover && !state.winner && state.board[state.hover.row][state.hover.col] === EMPTY && canPlay()) {
    const { row, col } = state.hover;
    ctx.beginPath();
    ctx.fillStyle = state.turn === BLACK ? "rgba(35, 35, 35, 0.25)" : "rgba(245, 245, 245, 0.75)";
    ctx.arc(pad + col * gap, pad + row * gap, 18, 0, Math.PI * 2);
    ctx.fill();
  }

  state.moves.forEach((move, index) => {
    const x = pad + move.col * gap;
    const y = pad + move.row * gap;
    ctx.beginPath();
    ctx.fillStyle = move.color === BLACK ? "#1f1f1f" : "#f5f2eb";
    ctx.strokeStyle = move.color === BLACK ? "#111" : "#bbb";
    ctx.lineWidth = 1.5;
    ctx.arc(x, y, 18, 0, Math.PI * 2);
    ctx.fill();
    ctx.stroke();

    if (index === state.moves.length - 1) {
      ctx.beginPath();
      ctx.strokeStyle = move.color === BLACK ? "#f7df73" : "#5d4037";
      ctx.lineWidth = 3;
      ctx.arc(x, y, 6, 0, Math.PI * 2);
      ctx.stroke();
    }
  });
}

function drawCoordinateLabels(pad, gap) {
  ctx.fillStyle = "rgba(42, 28, 10, 0.78)";
  ctx.font = "700 16px Inter, Segoe UI, sans-serif";
  ctx.textAlign = "center";
  ctx.textBaseline = "middle";
  for (let col = 0; col < BOARD_SIZE; col += 1) {
    const x = pad + col * gap;
    const label = String.fromCharCode(65 + col);
    ctx.fillText(label, x, pad - 22);
    ctx.fillText(label, x, canvas.height - pad + 22);
  }
  for (let row = 0; row < BOARD_SIZE; row += 1) {
    const y = pad + row * gap;
    const label = String(row + 1);
    ctx.fillText(label, pad - 24, y);
    ctx.fillText(label, canvas.width - pad + 24, y);
  }
}

function renderStatus() {
  updatePlayers();
  updateRecord();
  updateMoves();
  updateUndoPanel();
  turnBadge.textContent = state.winner ? `${colorName(state.winner)}获胜` : `${colorName(state.turn)}回合`;
  matchStatus.textContent = state.message;
  updateRoomControls();
}

function render() {
  renderBoard();
  renderStatus();
}

function cellGeometry() {
  const rect = canvas.getBoundingClientRect();
  const scale = canvas.width / rect.width;
  const pad = 42;
  const gap = (canvas.width - pad * 2) / (BOARD_SIZE - 1);
  return { rect, scale, pad, gap };
}

function canvasPoint(event) {
  const { rect, scale } = cellGeometry();
  return {
    x: (event.clientX - rect.left) * scale,
    y: (event.clientY - rect.top) * scale,
  };
}

function pointToCell(point) {
  const { pad, gap } = cellGeometry();
  const col = Math.round((point.x - pad) / gap);
  const row = Math.round((point.y - pad) / gap);
  if (row < 0 || row >= BOARD_SIZE || col < 0 || col >= BOARD_SIZE) return null;
  const x = pad + col * gap;
  const y = pad + row * gap;
  if (Math.hypot(point.x - x, point.y - y) > gap * 0.45) return null;
  return { row, col };
}

/** 是否允许触发落子交互（在线模式要求当前轮到自己）。 */
function canPlay() {
  if (state.winner || state.undoRequest) return false;
  if (state.mode !== "online") return false;
  return (state.role === "black" && state.turn === BLACK) || (state.role === "white" && state.turn === WHITE);
}

/**
 * 认输：发送意图由服务器结算。
 */
function surrenderGame() {
  if (state.winner || state.mode !== "online") return;
  roomApi.sendAction("surrender").catch(() => {});
}

/**
 * 悔棋：向服务器发请求，由双方确认后服务器回滚。
 */
function requestUndo() {
  if (state.mode !== "online" || !state.moves.length || state.winner || state.undoRequest) return;
  roomApi.sendAction("undo_request").catch(() => {});
}

/**
 * 响应悔棋：把结论交给服务器（仅对手可响应）。
 *
 * @param {boolean} approved - 是否同意。
 */
function resolveUndoRequest(approved) {
  const request = state.undoRequest;
  if (!request || state.mode !== "online") return;
  if (request.requesterColor === ownColor()) return;
  roomApi.sendAction("undo_respond", { approved }).catch(() => {});
}

/**
 * 再开一把：由服务器清盘并按规则换先。
 */
function playAgain() {
  if (state.mode !== "online") return;
  roomApi.sendAction("play_again").catch(() => {});
}

function exitToLobby() {
  roomApi?.leaveRoom?.();
  window.location.href = "index.html";
}

canvas.addEventListener("mousemove", (event) => {
  state.hover = pointToCell(canvasPoint(event));
  render();
});

canvas.addEventListener("mouseleave", () => {
  state.hover = null;
  render();
});

canvas.addEventListener("click", (event) => {
  const cell = pointToCell(canvasPoint(event));
  if (!cell) return;
  if (!canPlay()) {
    state.message = state.undoRequest ? "悔棋申请处理中，暂不能落子" : state.winner ? `${colorName(state.winner)}已获胜` : "还没轮到你落子";
    render();
    return;
  }
  // 1. 只发意图，等待服务器权威快照回推。
  if (state.board[cell.row][cell.col] !== EMPTY) {
    state.message = "这个位置已经有棋子了";
    render();
    return;
  }
  roomApi.sendAction("move", cell).catch(() => {});
});

surrenderBtn?.addEventListener("click", surrenderGame);
restartBtn.addEventListener("click", () => {
  if (state.mode !== "online") return;
  roomApi.sendAction("restart").catch(() => {});
});
undoBtn.addEventListener("click", requestUndo);
approveUndoBtn.addEventListener("click", () => resolveUndoRequest(true));
rejectUndoBtn.addEventListener("click", () => resolveUndoRequest(false));
playAgainBtn.addEventListener("click", playAgain);
exitRoomBtn.addEventListener("click", exitToLobby);

window.addEventListener("resize", render);

window.render_game_to_text = () =>
  JSON.stringify({
    coordinateSystem: "15x15 board, rows and columns are zero-based from top-left",
    mode: state.mode,
    role: state.role,
    roomId: state.roomId,
    turn: colorName(state.turn),
    winner: state.winner ? colorName(state.winner) : null,
    players: state.players,
    record: state.record,
    recordLabel: state.recordLabel,
    modalOpen: !resultModal.hidden,
    undoRequest: state.undoRequest,
    undoLocks: state.undoLocks,
    hostColor: colorName(state.hostColor),
    swapAfterGame: state.swapAfterGame,
    nextBlackColor: state.nextBlackColor ? colorName(state.nextBlackColor) : null,
    moves: state.moves.map((move) => ({ row: move.row, col: move.col, point: cellLabel(move.row, move.col), color: colorName(move.color), id: move.id || null })),
    message: state.message,
    connectionStatus: connectionStatus.textContent,
    playerId: roomApi?.getPlayerId?.() || "",
    serverConnected: roomApi?.isOnline?.() || false,
    peerCount: roomApi?.connectionCount?.() || 0,
    transportKind: "server-ws",
  });

window.advanceTime = () => render();

if (roomInput.value.trim()) {
  state.message = "正在通过房间链接加入";
}

render();
