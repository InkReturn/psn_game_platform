/**
 * 跳棋渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"（players/turn/over 等）；
 * - 玩家点击只产生意图（发 move/restart 请求），不修改镜像；
 * - 可落子提示复用 checkers-rules.js 的纯函数（与服务端同一份规则代码），
 *   但最终合法性由服务器裁决，客户端提示只用于交互体验；
 * - "选中棋子"是纯本地 UX 状态，不属于权威状态，也不会发给服务器。
 */
(function () {
  "use strict";

  const rules = window.CheckersRules;
  if (!rules) return;

  const board = document.querySelector("#checkersBoard");
  const turnLabel = document.querySelector("#checkersTurn");
  const log = document.querySelector("#checkersLog");
  const playerCountSelect = document.querySelector("#checkersPlayerCount");
  const roomBadge = document.querySelector("#checkersRoomBadge");
  const roomStatus = document.querySelector("#roomStatus");
  const restartBtn = document.querySelector("#resetCheckersBtn");

  /**
   * 客户端状态：服务器快照的只读镜像 + 本地选中态。
   */
  const state = {
    players: [],
    turn: 0,
    started: false,
    over: false,
    winner: null,
    playerCount: rules.MIN_PLAYERS,
    moves: [],
    seatPlayerIds: [],
    message: "创建房间并等待玩家满员后自动开局",
    roomId: "",
    /** 本地选中态：当前选中的己方棋子位置（null 表示未选中）。 */
    selected: null,
    /** 本地选中态对应的合法落点（由共享规则计算，仅供高亮）。 */
    targets: [],
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "checkers",
    prefix: "TQ",
    storageKey: "linkplay-room-checkers-v1",
    /** 状态栏文案依据：服务器是否已开局。 */
    isGameReady: () => state.started,
    /** 建房附加负载：房主选定的人数（2-6），建房时生效。 */
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
        state.players = [];
        state.started = false;
        state.over = false;
        state.winner = null;
        state.seatPlayerIds = [];
        state.selected = null;
        state.targets = [];
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
   * 本地玩家的座位下标。
   *
   * @returns {number|null} 座位下标；不在座（未进房/观战）返回 null。
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
    // 1. 覆盖全部权威字段。
    state.players = Array.isArray(g.players) ? g.players : [];
    state.turn = g.turn || 0;
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.winner = g.winner || null;
    state.playerCount = g.playerCount || rules.MIN_PLAYERS;
    state.moves = Array.isArray(g.moves) ? g.moves : [];
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.message = g.message || state.message;
    // 2. 快照变化后本地选中态可能失效（棋子已被移动/轮次已切换），统一清空重算。
    state.selected = null;
    state.targets = [];
  }

  /** 当前是否轮到本地玩家走子。 */
  function canPlay() {
    if (!state.started || state.over) return false;
    const seat = mySeatIndex();
    return seat !== null && seat === state.turn;
  }

  /**
   * 点击棋盘格：选中己方棋子或走子（在线模式只发意图）。
   *
   * @param {number} row - 行号。
   * @param {number} index - 行内序号。
   */
  function clickCell(row, index) {
    if (!canPlay()) {
      state.message = state.started ? "还没轮到你操作" : "等待玩家满员后自动开局";
      render();
      return;
    }
    const seat = mySeatIndex();
    const mine = state.players[seat];
    // 1. 点击自己的棋子：选中并计算合法落点（本地提示，最终由服务器裁决）。
    if (mine && mine.row === row && mine.index === index) {
      state.selected = { row, index };
      const cell = rules.cellAt(row, index);
      state.targets = cell ? rules.moveTargets(state.players, cell) : [];
      render();
      return;
    }
    // 2. 已选中且点击合法落点：发送走子意图，棋盘等服务器快照回推后再改。
    if (state.selected && state.targets.some((t) => t.row === row && t.index === index)) {
      roomApi
        .sendAction("move", { from: { ...state.selected }, to: { row, index } })
        .then(() => {
          state.selected = null;
          state.targets = [];
        })
        .catch(() => render());
      return;
    }
    // 3. 其它点击：取消选中。
    state.selected = null;
    state.targets = [];
    render();
  }

  /** 房主重新开局。 */
  function restartGame() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  restartBtn?.addEventListener("click", restartGame);

  /** 渲染棋盘与侧栏（全部由权威快照推导，本地只读）。 */
  function render() {
    board.innerHTML = "";
    const seat = mySeatIndex();
    const current = state.players[state.turn];
    turnLabel.textContent = !state.started
      ? "等待开始"
      : state.over
        ? "已结束"
        : `${current?.name || rules.COLOR_NAMES[current?.color] || ""}（${rules.COLOR_NAMES[current?.color] || ""}）`;
    if (log) log.textContent = state.message;
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.players.length === state.playerCount);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";

    // 1. 画 121 个格子：可落点高亮、有棋子的格子画棋子。
    rules.STAR_CELLS.forEach((cell) => {
      const hole = document.createElement("button");
      hole.type = "button";
      hole.className = `chinese-hole region-${cell.region}`;
      hole.style.left = `${7 + cell.x * 86}%`;
      hole.style.top = `${5 + cell.y * 90}%`;
      // 1.1 数据属性供测试与辅助定位（不参与任何游戏逻辑）。
      hole.dataset.row = String(cell.row);
      hole.dataset.index = String(cell.index);
      if (state.targets.some((target) => target.row === cell.row && target.index === cell.index)) hole.classList.add("target");
      const piece = state.players.find((item) => item.row === cell.row && item.index === cell.index);
      if (piece) {
        const disk = document.createElement("span");
        disk.className = `checker-piece ${piece.color}`;
        disk.title = piece.name || rules.COLOR_NAMES[piece.color];
        hole.appendChild(disk);
      }
      hole.addEventListener("click", () => clickCell(cell.row, cell.index));
      board.appendChild(hole);
    });
  }

  /** 测试钩子：输出可读的完整状态（不含任何未公开信息，跳棋为完全信息游戏）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      players: state.players,
      turn: state.turn,
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
