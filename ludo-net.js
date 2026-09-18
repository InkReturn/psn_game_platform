/**
 * 飞行棋渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"（teams/turn/dice 等）；
 * - 掷骰与移动只产生意图（发 roll/move/restart 请求）：骰子点数永远来自服务器，
 *   客户端绝不自产随机数；
 * - 棋盘渲染（机场/航道/终点/飞机）从旧 ludo.js 原样移植，纯展示逻辑。
 */
(function () {
  "use strict";

  const rules = window.LudoRules;
  if (!rules) return;

  /** 航道坐标（纯展示用：把航道下标映射到棋盘格子；与旧 ludoTrack 一致）。 */
  const ludoTrack = [
    [8, 1], [8, 2], [8, 3], [8, 4], [8, 5], [8, 6], [7, 7], [6, 8], [5, 8], [4, 8], [3, 8], [2, 8],
    [1, 8], [7, 9], [8, 10], [8, 11], [8, 12], [8, 13], [8, 14], [8, 15], [9, 9], [10, 8], [11, 8], [12, 8],
  ];
  /** 收尾直道（纯展示用）。 */
  const ludoHomeRuns = {
    red: [[8, 2], [8, 3], [8, 4], [8, 5], [8, 6], [8, 7]],
    blue: [[2, 8], [3, 8], [4, 8], [5, 8], [6, 8], [7, 8]],
    green: [[8, 14], [8, 13], [8, 12], [8, 11], [8, 10], [8, 9]],
    gold: [[14, 8], [13, 8], [12, 8], [11, 8], [10, 8], [9, 8]],
  };
  /** 机场位置（纯展示用）。 */
  const ludoHomes = {
    red: { row: 2, col: 2, label: "红方机场" },
    blue: { row: 2, col: 10, label: "蓝方机场" },
    green: { row: 10, col: 10, label: "绿方机场" },
    gold: { row: 10, col: 2, label: "黄方机场" },
  };
  /** 航道可视格（纯展示用；与旧 ludoVisualCells 一致）。 */
  const ludoVisualCells = [
    ...range(1, 6).flatMap((col) => [[7, col], [8, col], [9, col]]),
    ...range(10, 15).flatMap((col) => [[7, col], [8, col], [9, col]]),
    ...range(1, 6).flatMap((row) => [[row, 7], [row, 8], [row, 9]]),
    ...range(10, 15).flatMap((row) => [[row, 7], [row, 8], [row, 9]]),
  ];
  /** 队伍颜色表（展示用，顺序与规则模块一致）。 */
  const teamColors = rules.TEAM_COLORS;

  const board = document.querySelector("#ludoBoard");
  const turnLabel = document.querySelector("#ludoTurn");
  const piecesPanel = document.querySelector("#ludoPieces");
  const log = document.querySelector("#ludoLog");
  const playerCountSelect = document.querySelector("#ludoPlayerCount");
  const roomBadge = document.querySelector("#ludoRoomBadge");
  const roomStatus = document.querySelector("#roomStatus");
  const rollBtn = document.querySelector("#rollLudoBtn");
  const restartBtn = document.querySelector("#resetLudoBtn");

  /**
   * 客户端状态：服务器快照的只读镜像。
   */
  const state = {
    teams: [],
    turn: 0,
    dice: 0,
    started: false,
    over: false,
    winner: null,
    playerCount: rules.MIN_PLAYERS,
    moves: [],
    seatPlayerIds: [],
    message: "创建房间并等待玩家满员后自动开局",
    roomId: "",
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "ludo",
    prefix: "FQ",
    storageKey: "linkplay-room-ludo-v1",
    /** 状态栏文案依据：服务器是否已开局。 */
    isGameReady: () => state.started,
    /** 建房附加负载：房主选定的人数（2-4），建房时生效。 */
    createPayload: () => ({ playerCount: Number(playerCountSelect?.value) || rules.MIN_PLAYERS }),
    onGameUpdate(snapshot) {
      applyServerSnapshot(snapshot);
      render();
    },
    onRoomChange(room) {
      state.roomId = room.roomId || "";
      roomBadge.textContent = room.roomId ? `房间：${room.roomId}` : "房间：未进入";
      if (playerCountSelect) playerCountSelect.disabled = Boolean(room.roomId);
      if (!room.roomId) {
        // 1. 退出房间后回到未开局状态。
        state.teams = [];
        state.started = false;
        state.over = false;
        state.winner = null;
        state.dice = 0;
        state.seatPlayerIds = [];
        state.message = "创建房间并等待玩家满员后自动开局";
      }
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
   * 区间整数列表（展示布局用）。
   *
   * @param {number} start - 起始值（含）。
   * @param {number} end - 结束值（含）。
   * @returns {number[]} 区间列表。
   */
  function range(start, end) {
    return Array.from({ length: end - start + 1 }, (_, index) => start + index);
  }

  /**
   * 本地玩家的座位下标。
   *
   * @returns {number|null} 座位下标；不在座返回 null。
   */
  function mySeatIndex() {
    const myId = roomApi?.getPlayerId?.() || "";
    if (!myId || !state.seatPlayerIds) return null;
    return state.seatPlayerIds.indexOf(myId);
  }

  /**
   * 应用服务器权威快照。
   *
   * @param {object} snapshot - {room, game} 服务器快照。
   */
  function applyServerSnapshot(snapshot) {
    if (!snapshot?.game) return;
    const g = snapshot.game;
    // 1. 覆盖全部权威字段（骰子永远来自服务器）。
    state.teams = Array.isArray(g.teams) ? g.teams : [];
    state.turn = g.turn || 0;
    state.dice = g.dice || 0;
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.winner = g.winner || null;
    state.playerCount = g.playerCount || rules.MIN_PLAYERS;
    state.moves = Array.isArray(g.moves) ? g.moves : [];
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.message = g.message || state.message;
  }

  /** 当前是否轮到本地玩家掷骰。 */
  function canRoll() {
    if (!state.started || state.over) return false;
    const seat = mySeatIndex();
    return seat !== null && seat === state.turn && state.dice === 0;
  }

  /** 当前是否轮到本地玩家移动飞机。 */
  function canMove() {
    if (!state.started || state.over || state.dice === 0) return false;
    const seat = mySeatIndex();
    return seat !== null && seat === state.turn;
  }

  /** 掷骰意图（点数由服务器产生）。 */
  function rollDice() {
    if (!canRoll()) {
      state.message = state.started ? "还没轮到你或已掷过骰" : "等待玩家满员后自动开局";
      render();
      return;
    }
    roomApi.sendAction("roll").catch(() => render());
  }

  /**
   * 移动飞机意图。
   *
   * @param {number} pieceIndex - 飞机下标（0..PIECES_PER_TEAM-1）。
   */
  function movePiece(pieceIndex) {
    if (!canMove()) {
      render();
      return;
    }
    roomApi.sendAction("move", { pieceIndex }).catch(() => render());
  }

  /** 房主重新开局。 */
  function restartGame() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  rollBtn?.addEventListener("click", rollDice);
  restartBtn?.addEventListener("click", restartGame);

  /** 渲染棋盘、机队面板与侧栏（全部由权威快照推导，本地只读）。 */
  function render() {
    board.innerHTML = "";
    renderLudoHomes();
    renderLudoRoutes();
    renderLudoCenter();
    renderLudoPlanes();
    renderTeamPanel();

    const current = state.teams[state.turn];
    turnLabel.textContent = !state.started ? "等待开始" : state.over ? "已结束" : `${current?.name || ""}${state.dice ? `（骰点 ${state.dice}）` : ""}`;
    if (log) log.textContent = state.message;
    if (rollBtn) rollBtn.disabled = !canRoll();
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.teams.length === state.playerCount);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";
  }

  /** 渲染四个机场（展示层，从旧实现移植）。 */
  function renderLudoHomes() {
    Object.entries(ludoHomes).forEach(([color, home]) => {
      const pad = document.createElement("div");
      pad.className = `ludo-home ${color}`;
      pad.style.gridRow = `${home.row} / span 4`;
      pad.style.gridColumn = `${home.col} / span 4`;
      pad.innerHTML = `
        <strong>${home.label}</strong>
        <span></span><span></span><span></span><span></span>
      `;
      board.appendChild(pad);
    });
  }

  /** 渲染航道与收尾直道（展示层，从旧实现移植）。 */
  function renderLudoRoutes() {
    const homeRunKeys = new Set(Object.values(ludoHomeRuns).flat().map(([row, col]) => `${row}-${col}`));
    ludoVisualCells.forEach(([row, col], index) => {
      const key = `${row}-${col}`;
      if (row >= 7 && row <= 9 && col >= 7 && col <= 9) return;
      const cell = document.createElement("div");
      cell.className = `ludo-cell ${homeRunKeys.has(key) ? "muted" : teamColors[index % 4]}`;
      cell.style.gridRow = row;
      cell.style.gridColumn = col;
      board.appendChild(cell);
    });

    Object.entries(ludoHomeRuns).forEach(([color, cells]) => {
      cells.forEach(([row, col], index) => {
        const cell = document.createElement("div");
        cell.className = `ludo-cell home-run ${color}`;
        cell.style.gridRow = row;
        cell.style.gridColumn = col;
        cell.textContent = index === cells.length - 1 ? "终" : "";
        board.appendChild(cell);
      });
    });

    [
      [8, 1, "red"],
      [1, 8, "blue"],
      [8, 15, "green"],
      [15, 8, "gold"],
    ].forEach(([row, col, color]) => {
      const cell = document.createElement("div");
      cell.className = `ludo-cell start ${color}`;
      cell.style.gridRow = row;
      cell.style.gridColumn = col;
      cell.textContent = "起";
      board.appendChild(cell);
    });
  }

  /** 渲染中央终点（展示层，从旧实现移植）。 */
  function renderLudoCenter() {
    const center = document.createElement("div");
    center.className = "ludo-center";
    center.style.gridRow = "7 / span 3";
    center.style.gridColumn = "7 / span 3";
    center.innerHTML = "<span>✈</span><strong>终点</strong>";
    board.appendChild(center);
  }

  /** 渲染飞机（展示层，从旧实现移植；数据来自权威快照）。 */
  function renderLudoPlanes() {
    state.teams.forEach((team) => {
      team.pieces.forEach((pos, pieceIndex) => {
        const plane = document.createElement("span");
        plane.className = `ludo-plane ${team.color}`;
        plane.textContent = "✈";
        plane.dataset.label = pieceIndex + 1;
        if (pos < 0) {
          const home = ludoHomes[team.color];
          plane.style.gridRow = home.row + 1 + Math.floor(pieceIndex / 2);
          plane.style.gridColumn = home.col + 1 + (pieceIndex % 2);
        } else {
          const [row, col] = ludoTrack[Math.min(pos, ludoTrack.length - 1)];
          plane.style.gridRow = row;
          plane.style.gridColumn = col;
        }
        board.appendChild(plane);
      });
    });
  }

  /** 渲染机队面板（含可点击的移动按钮，真实意图入口）。 */
  function renderTeamPanel() {
    piecesPanel.innerHTML = "";
    state.teams.forEach((team, teamIndex) => {
      const card = document.createElement("section");
      card.className = `ludo-team-card ${team.color}`;
      card.innerHTML = `<strong>${team.name}</strong>`;
      team.pieces.forEach((pos, index) => {
        const piece = document.createElement("button");
        piece.className = "piece-button";
        piece.type = "button";
        // 1. 数据属性供测试定位（不参与游戏逻辑）。
        piece.dataset.teamIndex = String(teamIndex);
        piece.dataset.pieceIndex = String(index);
        piece.textContent = `${index + 1}号 ${pos < 0 ? "待起飞" : pos >= rules.TRACK_LENGTH - 1 ? "到达" : `航道 ${pos}`}`;
        piece.disabled = teamIndex !== state.turn || state.dice === 0 || state.over;
        piece.addEventListener("click", () => movePiece(index));
        card.appendChild(piece);
      });
      piecesPanel.appendChild(card);
    });
  }

  /** 测试钩子：输出可读的完整状态（飞行棋为完全信息游戏，无隐私字段）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      teams: state.teams,
      turn: state.turn,
      dice: state.dice,
      started: state.started,
      over: state.over,
      winner: state.winner,
      playerCount: state.playerCount,
      moves: state.moves.length,
      mySeatIndex: mySeatIndex(),
      message: state.message,
      room: { roomId: state.roomId },
    });

  /** 测试钩子：联机面板 API（越权校验需绕过前端拦截直接发意图）。 */
  window.roomApi = roomApi;

  render();
})();
