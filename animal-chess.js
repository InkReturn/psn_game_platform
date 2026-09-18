/**
 * 斗兽棋渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"（animalState 的 pieces/turn/winner 等）；
 * - 玩家点击只产生意图（选中棋子做提示、发 from/to 走子请求），不修改镜像；
 * - 高亮与可走位置提示复用 animal-chess-rules.js 的纯函数（与服务端同一套规则代码），
 *   但最终是否合法由服务器裁决，客户端提示仅用于交互体验。
 */
"use strict";

const animalBoard = document.querySelector("#animalBoard");
const animalTurn = document.querySelector("#animalTurn");
const animalLog = document.querySelector("#animalLog");
const animalRoomBadge = document.querySelector("#animalRoomBadge");
const animalCountBadge = document.querySelector("#animalCountBadge");
const animalSideBadge = document.querySelector("#animalSideBadge");
const animalRestartBtn = document.querySelector("#restartAnimalBtn");

/** 服务端与浏览器共用的纯规则模块。 */
const animalRules = window.AnimalChessRules;

/**
 * 斗兽棋客户端状态。
 *
 * 所有对局字段都来自服务器快照（applyServerSnapshot 覆盖），
 * 唯一由本地维护的是纯交互态的 selectedId / targets。
 */
const animalState = {
  pieces: [],
  turn: "red",
  selectedId: "",
  targets: [],
  started: false,
  over: false,
  winner: "",
  message: "创建或加入房间后，两位玩家到齐即自动开局。",
  moves: [],
  lastMove: null,
  players: { red: "等待", blue: "等待" },
  sidePlayerIds: { red: null, blue: null },
  room: null,
};

/** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故用 let 声明）。 */
let animalRoomApi = null;

animalRoomApi = window.initAnimalChessPanel({
  onRoomChange(room) {
    animalState.room = room;
    // 1. 房间状态变化后立刻重绘（成员列表由面板自己渲染，这里只更新棋盘侧信息）。
    renderAnimal();
  },
  onGameUpdate(snapshot) {
    // 1. 服务器权威快照到达：覆盖本地镜像并重绘。
    applyServerSnapshot(snapshot);
    renderAnimal();
  },
  onError(err) {
    if (err && err.message) {
      animalState.message = err.message;
      renderAnimal();
    }
  },
});

animalRestartBtn?.addEventListener("click", () => {
  if (!animalRoomApi.hasRoom()) {
    animalState.message = "请先创建或加入房间。";
    renderAnimal();
    return;
  }
  // 1. 重开一局同样只是意图：服务器清盘后广播权威快照。
  animalRoomApi.sendAction("restart").catch(() => {});
});

/**
 * 应用服务器权威快照。
 *
 * @param {object} snapshot - {room, game} 服务器快照。
 */
function applyServerSnapshot(snapshot) {
  if (!snapshot?.game) return;
  const g = snapshot.game;
  // 1. 覆盖全部权威字段（棋子、轮次、胜负、走子记录、座位映射）。
  animalState.pieces = Array.isArray(g.pieces) ? g.pieces : [];
  animalState.turn = g.turn || "red";
  animalState.started = Boolean(g.started);
  animalState.over = Boolean(g.over);
  animalState.winner = g.winner || "";
  animalState.message = g.message || animalState.message;
  animalState.moves = Array.isArray(g.moves) ? g.moves : [];
  animalState.lastMove = g.lastMove || null;
  animalState.players = g.players || animalState.players;
  animalState.sidePlayerIds = g.sidePlayerIds || { red: null, blue: null };
  // 2. 快照到来自动清理选中态：服务器棋盘变了，旧的提示高亮已无意义。
  removeSelection();
}

/** 补齐可能缺失的字段（首次渲染与快照到达前使用）。 */
function ensureStateShape() {
  animalState.pieces ||= [];
  animalState.targets ||= [];
  animalState.moves ||= [];
  animalState.message ||= "";
  animalState.turn ||= "red";
  animalState.winner ||= "";
  animalState.lastMove ||= null;
  animalState.selectedId ||= "";
  animalState.room ||= null;
  animalState.players ||= { red: "等待", blue: "等待" };
  animalState.sidePlayerIds ||= { red: null, blue: null };
}

/**
 * 本地玩家控制的阵营（以服务器座位映射为准，不依赖 host/guest 角色）。
 *
 * @returns {"red"|"blue"|""} 阵营标识；不在座返回空串（只能观战）。
 */
function localSide() {
  const myId = animalRoomApi ? animalRoomApi.getPlayerId() : "";
  if (!myId) return "";
  if (animalState.sidePlayerIds.red === myId) return "red";
  if (animalState.sidePlayerIds.blue === myId) return "blue";
  return "";
}

/**
 * 阵营中文名。
 *
 * @param {string} side - 阵营标识。
 * @returns {string} "红方" / "蓝方"。
 */
function sideLabel(side) {
  return animalRules.sideLabel(side);
}

/**
 * 该棋子现在是否允许本地下手（自己的棋子 + 自己的回合 + 对局进行中）。
 *
 * @param {object} piece - 棋子。
 * @returns {boolean} true 表示可以选中。
 */
function canControl(piece) {
  const side = localSide();
  return Boolean(side) && piece.owner === side && animalState.turn === piece.owner && animalState.started && !animalState.over;
}

/** 查找某格棋子。
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {object|null} 棋子或 null。
 */
function pieceAt(row, col) {
  return animalRules.pieceAt(animalState.pieces, row, col);
}

/** 当前选中的棋子。
 * @returns {object|null} 棋子或 null。
 */
function selectedPiece() {
  return animalRules.pieceById(animalState.pieces, animalState.selectedId);
}

/** 清空选中态与提示高亮。 */
function removeSelection() {
  animalState.selectedId = "";
  animalState.targets = [];
}

/**
 * 棋盘格子点击：只产生意图，不修改权威状态。
 *
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 */
function handleCellClick(row, col) {
  // 1. 未开局/已结束/不在座：不产生任何操作。
  if (!animalState.started || animalState.over) return;
  const piece = pieceAt(row, col);
  const current = selectedPiece();

  // 2. 点自己的棋子：本地做可走位置提示。
  if (piece && canControl(piece)) {
    animalState.selectedId = piece.id;
    animalState.targets = animalRules.legalTargets(animalState.pieces, piece);
    animalState.message = `${sideLabel(piece.owner)} 选中 ${piece.name}。`;
    renderAnimal();
    return;
  }

  // 3. 没有选中或选中的不是自己能动的棋子：忽略。
  if (!current || !canControl(current)) return;
  // 4. 点击非高亮格：清掉选中，避免"点了没反应"的困惑。
  const target = animalState.targets.find((item) => item.row === row && item.col === col);
  if (!target) {
    removeSelection();
    renderAnimal();
    return;
  }
  // 5. 发送走子意图：服务器校验通过后回推新快照，本地的棋盘由快照覆盖。
  const from = { row: current.row, col: current.col };
  animalState.message = `正在请求 ${sideLabel(current.owner)} 的 ${current.name} 走子…`;
  renderAnimal();
  animalRoomApi.sendMove(from, target).catch(() => {
    // 服务器拒绝时会经 onError 写入 message，这里只需重绘。
    renderAnimal();
  });
}

/** 统计某阵营存活棋子数。
 * @param {string} side - 阵营标识。
 * @returns {number} 存活数量。
 */
function aliveCount(side) {
  return animalRules.aliveCount(animalState.pieces, side);
}

/**
 * 地形对应的 CSS 类名。
 *
 * @param {number} row - 行号。
 * @param {number} col - 列号。
 * @returns {string} CSS 类名（无特殊地形时为空串）。
 */
function terrainClass(row, col) {
  const terrain = animalRules.terrainAt(row, col);
  if (terrain === "blue-den") return "den-blue";
  if (terrain === "red-den") return "den-red";
  if (terrain === "river") return "river";
  if (terrain.includes("trap")) return "trap";
  return "";
}

/** 渲染棋盘与状态。 */
function renderAnimal() {
  ensureStateShape();
  const redCount = aliveCount("red");
  const blueCount = aliveCount("blue");
  const mySide = localSide();

  // 1. 顶部状态文案。
  animalTurn.textContent = animalState.over
    ? `${sideLabel(animalState.winner)} 胜利`
    : animalState.started
      ? `${sideLabel(animalState.turn)} 回合`
      : "等待开局";
  animalSideBadge.textContent = animalState.over
    ? "对局结束"
    : mySide
      ? `你执${sideLabel(mySide)} · 轮到${sideLabel(animalState.turn)}`
      : `轮到${sideLabel(animalState.turn)}`;
  animalCountBadge.textContent = `子力：红 ${redCount} / 蓝 ${blueCount}`;
  animalLog.textContent = animalState.message;
  if (animalState.room?.roomId) {
    animalRoomBadge.textContent = `房间：${animalState.room.roomId} · ${animalState.room.members?.length || 0} 人`;
  } else {
    animalRoomBadge.textContent = "房间：未进入";
  }

  // 2. 棋盘逐格重建（9x7=63 格，重建成本可忽略且不会出现脏状态）。
  animalBoard.innerHTML = "";
  for (let row = 0; row < animalRules.ROWS; row += 1) {
    for (let col = 0; col < animalRules.COLS; col += 1) {
      const cell = document.createElement("button");
      cell.type = "button";
      cell.className = `animal-cell ${terrainClass(row, col)}`.trim();
      cell.dataset.row = String(row);
      cell.dataset.col = String(col);
      const terrain = animalRules.terrainAt(row, col);
      if (terrain !== "land") {
        const label = document.createElement("span");
        label.className = "cell-label";
        label.textContent = terrain === "river" ? "河" : terrain.includes("den") ? "穴" : "阱";
        cell.appendChild(label);
      }
      if (animalState.targets.some((item) => item.row === row && item.col === col)) cell.classList.add("target");
      const piece = pieceAt(row, col);
      if (piece) {
        const selected = piece.id === animalState.selectedId;
        if (selected) cell.classList.add("selected");
        if (animalState.lastMove?.id === piece.id) cell.classList.add("last-move");
        const token = document.createElement("span");
        token.className = `animal-piece ${piece.owner}`;
        token.textContent = piece.name;
        token.title = `${sideLabel(piece.owner)} ${piece.name}`;
        cell.appendChild(token);
      }
      cell.addEventListener("click", () => handleCellClick(row, col));
      animalBoard.appendChild(cell);
    }
  }
}

/**
 * 导出给自动化测试读取的权威状态文本。
 *
 * @returns {string} JSON 字符串。
 */
function renderStateText() {
  return JSON.stringify({
    origin: "top-left",
    board: { rows: animalRules.ROWS, cols: animalRules.COLS },
    gameType: "animal-chess",
    transportKind: "server-ws",
    started: animalState.started,
    turn: animalState.turn,
    selectedId: animalState.selectedId,
    targets: animalState.targets,
    over: animalState.over,
    winner: animalState.winner,
    message: animalState.message,
    counts: {
      red: aliveCount("red"),
      blue: aliveCount("blue"),
    },
    lastMove: animalState.lastMove,
    pieces: animalState.pieces
      .filter((item) => item.alive)
      .map((item) => ({
        id: item.id,
        owner: item.owner,
        name: item.name,
        row: item.row,
        col: item.col,
      })),
    mySide: localSide(),
    sidePlayerIds: animalState.sidePlayerIds,
    players: animalState.players,
    members: animalState.room?.members || [],
    room: animalState.room ? { roomId: animalState.room.roomId, role: animalState.room.role } : null,
    playerId: animalRoomApi?.getPlayerId?.() || "",
    serverConnected: animalRoomApi?.isOnline?.() || false,
    peerCount: animalRoomApi?.connectionCount?.() || 0,
    memberCount: animalState.room?.members?.length || 0,
    connectionStatus: document.querySelector("#roomStatus")?.textContent || "",
    moves: animalState.moves,
  });
}

window.render_game_to_text = renderStateText;
window.advanceTime = () => renderAnimal();

renderAnimal();
