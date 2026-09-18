/**
 * 大富翁渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"（players/cells/turn/dice 等）；
 * - 掷骰与购买决定只产生意图（发 roll/purchase/restart 请求）：骰子与机会
 *   金额永远来自服务器，客户端绝不自产随机数；
 * - 棋盘渲染（40 格地图/资产卡/骰子）从旧 monopoly.js 原样移植，纯展示逻辑。
 */
(function () {
  "use strict";

  const rules = window.MonopolyRules;
  if (!rules) return;

  const board = document.querySelector("#monopolyBoard");
  const turnLabel = document.querySelector("#monopolyTurn");
  const stats = document.querySelector("#monopolyStats");
  const log = document.querySelector("#monopolyLog");
  const centerTitle = document.querySelector("#monopolyCenterTitle");
  const centerText = document.querySelector("#monopolyCenterText");
  const diceLabel = document.querySelector("#monopolyDice");
  const playerCountSelect = document.querySelector("#monopolyPlayerCount");
  const roomBadge = document.querySelector("#monopolyRoomBadge");
  const roomStatus = document.querySelector("#roomStatus");
  const buyActions = document.querySelector("#monopolyBuyActions");
  const buyBtn = document.querySelector("#buyPropertyBtn");
  const skipBtn = document.querySelector("#skipPropertyBtn");
  const rollBtn = document.querySelector("#rollMonopolyBtn");
  const restartBtn = document.querySelector("#resetMonopolyBtn");

  /**
   * 客户端状态：服务器快照的只读镜像。
   */
  const state = {
    players: [],
    cells: [],
    turn: 0,
    dice: 0,
    started: false,
    over: false,
    pendingPurchase: null,
    playerCount: rules.MIN_PLAYERS,
    moves: 0,
    seatPlayerIds: [],
    status: "",
    roomId: "",
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "monopoly",
    prefix: "DF",
    storageKey: "linkplay-room-monopoly-v1",
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
        state.players = [];
        state.cells = [];
        state.started = false;
        state.over = false;
        state.pendingPurchase = null;
        state.seatPlayerIds = [];
        state.status = "";
      }
      render();
    },
    onError(err) {
      if (err?.message) {
        state.status = err.message;
        render();
      }
    },
  });

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
    // 1. 覆盖全部权威字段（骰子与机会金额永远来自服务器）。
    state.players = Array.isArray(g.players) ? g.players : [];
    state.cells = Array.isArray(g.cells) ? g.cells : [];
    state.turn = g.turn || 0;
    state.dice = g.dice || 0;
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.pendingPurchase = g.pendingPurchase || null;
    state.playerCount = g.playerCount || rules.MIN_PLAYERS;
    state.moves = g.moves || 0;
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.status = g.status || "";
  }

  /** 当前是否轮到本地玩家掷骰。 */
  function canRoll() {
    if (!state.started || state.over || state.pendingPurchase) return false;
    const seat = mySeatIndex();
    return seat !== null && seat === state.turn;
  }

  /** 掷骰意图（骰子与机会金额由服务器产生）。 */
  function rollDice() {
    if (!canRoll()) {
      if (state.pendingPurchase) state.status = "请先决定是否购买当前地块。";
      render();
      return;
    }
    roomApi.sendAction("roll").catch(() => render());
  }

  /**
   * 购买决定意图。
   *
   * @param {boolean} buy - true 买入 / false 跳过。
   */
  function resolvePurchase(buy) {
    const seat = mySeatIndex();
    if (!state.pendingPurchase || seat === null || state.pendingPurchase.playerIndex !== seat) {
      render();
      return;
    }
    roomApi.sendAction("purchase", { buy }).catch(() => render());
  }

  /** 房主重新开局。 */
  function restartGame() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  rollBtn?.addEventListener("click", rollDice);
  restartBtn?.addEventListener("click", restartGame);
  buyBtn?.addEventListener("click", () => resolvePurchase(true));
  skipBtn?.addEventListener("click", () => resolvePurchase(false));

  /**
   * 地图格的棋盘坐标（展示层，从旧实现移植）。
   *
   * @param {number} index - 格子下标。
   * @returns {{row: number, col: number}} 网格坐标。
   */
  function cellPosition(index) {
    if (index <= 10) return { row: 11, col: 11 - index };
    if (index <= 20) return { row: 21 - index, col: 1 };
    if (index <= 30) return { row: 1, col: index - 19 };
    return { row: index - 29, col: 11 };
  }

  /**
   * 国旗/符号标记（展示层，从旧实现移植）。
   *
   * @param {object} cell - 格子配置。
   * @returns {string} HTML 片段。
   */
  function countryFlagHtml(cell) {
    if (cell.code) {
      return `<span class="country-flag flag-${cell.code.toLowerCase()}" aria-label="${cell.name}国旗"><i>${cell.code}</i></span>`;
    }
    return `<span class="country-symbol">${cell.flag || ""}</span>`;
  }

  /** 渲染棋盘、资产卡与侧栏（全部由权威快照推导，本地只读）。 */
  function render() {
    board.querySelectorAll(".monopoly-cell").forEach((node) => node.remove());

    // 1. 画 40 格地图（含归属标记、房标记与玩家棋子）。
    rules.CELLS.forEach((cell, index) => {
      const pos = cellPosition(index);
      const cellState = state.cells[index] || { owner: null, houses: 0 };
      const div = document.createElement("button");
      div.type = "button";
      div.className = `monopoly-cell ${cell.type} ${cell.group || ""}`;
      div.style.gridRow = pos.row;
      div.style.gridColumn = pos.col;
      div.dataset.cellIndex = String(index);
      div.innerHTML = `
        <span class="cell-index">${String(index).padStart(2, "0")}</span>
        ${countryFlagHtml(cell)}
        <strong>${cell.name}</strong>
        <small>${cell.price ? `$${cell.price}` : cell.fee ? `-$${cell.fee}` : cell.flag || cell.type}</small>
      `;

      if (cellState.owner !== null && state.players[cellState.owner]) {
        const owner = document.createElement("span");
        owner.className = `owner-mark ${state.players[cellState.owner].color || ""}`;
        owner.textContent = "⌂";
        div.appendChild(owner);

        const houses = document.createElement("div");
        houses.className = "house-row";
        for (let i = 0; i < Math.max(1, cellState.houses || 1); i += 1) {
          const house = document.createElement("span");
          house.className = `house-mark ${state.players[cellState.owner].color || ""}`;
          house.textContent = "⌂";
          houses.appendChild(house);
        }
        div.appendChild(houses);
      }

      const row = document.createElement("div");
      row.className = "piece-row";
      state.players.forEach((player) => {
        if (player.pos === index) {
          const piece = document.createElement("span");
          piece.className = `piece-dot player-token ${player.color}`;
          piece.textContent = player.name.slice(-1);
          row.appendChild(piece);
        }
      });
      div.appendChild(row);
      board.appendChild(div);
    });

    // 2. 侧栏状态。
    const current = state.players[state.turn];
    turnLabel.textContent = !state.started ? "等待开始" : state.over ? "已结束" : current?.name || "";
    diceLabel.textContent = state.dice || "-";
    if (buyActions) {
      const seat = mySeatIndex();
      buyActions.hidden = !(state.pendingPurchase && seat !== null && state.pendingPurchase.playerIndex === seat);
    }
    if (state.status) centerText.textContent = state.status;
    if (log) log.textContent = state.status || "全球国家地产版地图，掷骰前进，落到空地可购买，落到他人地块支付租金。";
    if (rollBtn) rollBtn.disabled = !canRoll();
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.players.length === state.playerCount);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";

    // 3. 资产卡。
    stats.innerHTML = "";
    state.players.forEach((player) => {
      const stat = document.createElement("div");
      stat.className = "asset-card";
      stat.innerHTML = `
        <span class="piece-dot player-token ${player.color}">${player.name.slice(-1)}</span>
        <strong>${player.name}</strong>
        <span>$${player.money}</span>
        <small>${player.properties.length} 块地产</small>
      `;
      const properties = document.createElement("div");
      properties.className = "chip-list monopoly-property-list";
      (player.properties.length ? player.properties : ["暂无房产"]).forEach((name) => {
        const chip = document.createElement("span");
        chip.className = `property-chip ${player.color}`;
        chip.textContent = name;
        properties.appendChild(chip);
      });
      stat.appendChild(properties);
      stats.appendChild(stat);
    });
  }

  /** 测试钩子：输出可读的完整状态（大富翁为完全信息游戏，无隐私字段）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      players: state.players,
      cells: state.cells,
      turn: state.turn,
      dice: state.dice,
      started: state.started,
      over: state.over,
      pendingPurchase: state.pendingPurchase,
      playerCount: state.playerCount,
      moves: state.moves,
      mySeatIndex: mySeatIndex(),
      status: state.status,
      room: { roomId: state.roomId },
    });

  /** 测试钩子：联机面板 API（越权校验需绕过前端拦截直接发意图）。 */
  window.roomApi = roomApi;

  render();
})();
