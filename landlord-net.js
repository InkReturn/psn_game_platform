/**
 * 斗地主渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"：自己的手牌（myHand）、他人剩余张数
 *   （handCount，无手牌内容）、已出的牌、已公布的底牌；
 * - 叫分/出牌/不出只产生意图（发 bid/play/pass/restart 请求）：洗牌与发牌
 *   永远来自服务器，客户端绝不自产随机数；
 * - "提示"复用 landlord-rules.js 的纯函数（与服务端同一份规则代码）；
 * - "选中手牌"是纯本地 UX 状态，不属于权威状态，也不会发给服务器
 *   （出牌时只发选中牌的 id 列表）。
 */
(function () {
  "use strict";

  const rules = window.LandlordRules;
  if (!rules) return;

  const phaseLabel = document.querySelector("#landlordPhase");
  const turnLabel = document.querySelector("#landlordTurn");
  const playersPanel = document.querySelector("#landlordPlayers");
  const log = document.querySelector("#landlordLog");
  const roomLog = document.querySelector("#landlordRoomLog");
  const roomBadge = document.querySelector("#landlordRoomBadge");
  const multiplierLabel = document.querySelector("#landlordMultiplier");
  const bottomPanel = document.querySelector("#landlordBottom");
  const lastPlayPanel = document.querySelector("#lastPlay");
  const lastPlayTitle = document.querySelector("#lastPlayTitle");
  const callBidBtn = document.querySelector("#callLandlordBtn");
  const passBidBtn = document.querySelector("#passBidBtn");
  const hintBtn = document.querySelector("#hintCardsBtn");
  const playBtn = document.querySelector("#playCardsBtn");
  const passBtn = document.querySelector("#passCardsBtn");
  const bidActions = document.querySelector("#bidActions");
  const playActions = document.querySelector("#playActions");
  const roomStatus = document.querySelector("#roomStatus");
  const restartBtn = document.querySelector("#resetLandlordBtn");

  /**
   * 客户端状态：服务器个性化快照的只读镜像 + 本地选中态。
   */
  const state = {
    phase: "idle",
    started: false,
    over: false,
    turn: 0,
    biddingTurn: 0,
    landlordIndex: null,
    multiplier: 1,
    seats: [],
    lastPlay: null,
    lastPlayerIndex: null,
    passes: 0,
    bidHistory: [],
    bottomCards: [],
    bottomRevealed: false,
    winnerSeat: null,
    moves: 0,
    message: "",
    seatPlayerIds: [],
    mySeatIndex: null,
    myHand: [],
    roomId: "",
    /** 本地选中态：选中的手牌下标（仅 UX，出牌时只发 id）。 */
    selected: [],
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "landlord",
    prefix: "DD",
    storageKey: "linkplay-room-landlord-v1",
    /** 状态栏文案依据：服务器是否已开局。 */
    isGameReady: () => state.started,
    onGameUpdate(snapshot) {
      applyServerSnapshot(snapshot);
      render();
    },
    onRoomChange(room) {
      state.roomId = room.roomId || "";
      roomBadge.textContent = room.roomId ? `房间：${room.roomId}` : "房间：未进入";
      if (!room.roomId) {
        // 1. 退出房间后回到未开局状态（本地不保留任何手牌）。
        state.phase = "idle";
        state.started = false;
        state.over = false;
        state.seats = [];
        state.myHand = [];
        state.mySeatIndex = null;
        state.seatPlayerIds = [];
        state.selected = [];
        state.message = "";
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
   * 应用服务器个性化快照。
   *
   * @param {object} snapshot - {room, game} 服务器快照（只含本人可见数据）。
   */
  function applyServerSnapshot(snapshot) {
    if (!snapshot?.game) return;
    const g = snapshot.game;
    // 1. 覆盖全部权威字段（他人手牌内容从不在快照里，只有 handCount）。
    state.phase = g.phase || "idle";
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.turn = g.turn || 0;
    state.biddingTurn = g.biddingTurn || 0;
    state.landlordIndex = g.landlordIndex === null || g.landlordIndex === undefined ? null : g.landlordIndex;
    state.multiplier = g.multiplier || 1;
    state.seats = Array.isArray(g.seats) ? g.seats : [];
    state.lastPlay = g.lastPlay || null;
    state.lastPlayerIndex = g.lastPlayerIndex === null || g.lastPlayerIndex === undefined ? null : g.lastPlayerIndex;
    state.passes = g.passes || 0;
    state.bidHistory = Array.isArray(g.bidHistory) ? g.bidHistory : [];
    state.bottomCards = Array.isArray(g.bottomCards) ? g.bottomCards : [];
    state.bottomRevealed = Boolean(g.bottomRevealed);
    state.winnerSeat = g.winnerSeat === null || g.winnerSeat === undefined ? null : g.winnerSeat;
    state.moves = g.moves || 0;
    state.message = g.message || state.message;
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.mySeatIndex = g.mySeatIndex === null || g.mySeatIndex === undefined ? null : g.mySeatIndex;
    state.myHand = Array.isArray(g.myHand) ? g.myHand : [];
    // 2. 快照变化后本地选中态可能失效（手牌已变），统一清空。
    state.selected = [];
  }

  /** 是否轮到本地玩家叫分。 */
  function canBid() {
    return state.phase === "bidding" && !state.over && state.mySeatIndex === state.biddingTurn;
  }

  /** 是否轮到本地玩家出牌。 */
  function canPlay() {
    return state.phase === "playing" && !state.over && state.mySeatIndex === state.turn;
  }

  /**
   * 叫/不叫地主意图。
   *
   * @param {boolean} call - true 叫 / false 不叫。
   */
  function bidLandlord(call) {
    if (!canBid()) {
      render();
      return;
    }
    roomApi.sendAction("bid", { call }).catch(() => render());
  }

  /** 提示：本地用共享规则找一手能出的牌并选中（不产生服务器请求）。 */
  function hintCards() {
    if (!canPlay()) {
      render();
      return;
    }
    const hint = rules.findHint(state.myHand, state.lastPlay);
    state.selected = hint
      .map((id) => state.myHand.findIndex((card) => card.id === id))
      .filter((index) => index >= 0);
    state.message = state.selected.length ? "已为你选中一组可出的牌。" : "没有可出的牌，请选择不出。";
    render();
  }

  /** 出牌意图：只发选中牌的 id 列表。 */
  function playSelectedCards() {
    if (!canPlay()) {
      render();
      return;
    }
    const ids = state.selected.map((index) => state.myHand[index]?.id).filter(Boolean);
    if (!ids.length) {
      state.message = "请先选择要出的牌。";
      render();
      return;
    }
    roomApi
      .sendAction("play", { cards: ids })
      .then(() => {
        state.selected = [];
      })
      .catch(() => render());
  }

  /** 不出意图。 */
  function passCards() {
    if (!canPlay() || !state.lastPlay) {
      render();
      return;
    }
    roomApi.sendAction("pass").catch(() => render());
  }

  /** 房主重新发牌。 */
  function restartGame() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  callBidBtn?.addEventListener("click", () => bidLandlord(true));
  passBidBtn?.addEventListener("click", () => bidLandlord(false));
  hintBtn?.addEventListener("click", hintCards);
  playBtn?.addEventListener("click", playSelectedCards);
  passBtn?.addEventListener("click", passCards);
  restartBtn?.addEventListener("click", restartGame);

  /**
   * 花色符号（展示层，从旧实现移植）。
   *
   * @param {string} suit - 花色代码。
   * @returns {string} 符号。
   */
  function suitLabel(suit) {
    return { S: "♠", H: "♥", C: "♣", D: "♦" }[suit] || suit;
  }

  /**
   * 牌面文本（展示层，从旧实现移植）。
   *
   * @param {object} card - 牌。
   * @returns {string} 文本。
   */
  function cardText(card) {
    if (!card.suit) return "Joker";
    return `${card.rank}${suitLabel(card.suit)}`;
  }

  /**
   * 构造一张牌面按钮（展示层，从旧实现移植；附 data-card-id 供测试定位）。
   *
   * @param {object} card - 牌。
   * @param {boolean} enabled - 是否可点。
   * @returns {HTMLButtonElement} 按钮。
   */
  function cardButton(card, enabled) {
    const btn = document.createElement("button");
    btn.type = "button";
    const color = card.suit ? (card.suit === "H" || card.suit === "D" ? "red" : "black") : card.rank === "大王" ? "red" : "black";
    btn.className = `playing-card ${color} ${card.suit ? "" : "joker-card"}`;
    btn.disabled = !enabled;
    const rank = card.suit ? card.rank : "Joker";
    const suit = card.suit ? suitLabel(card.suit) : "Joker";
    btn.setAttribute("aria-label", cardText(card));
    btn.dataset.cardId = card.id;
    btn.innerHTML = `
      <span class="card-corner top"><b>${rank}</b><i>${suit}</i></span>
      <span class="card-pip">${suit}</span>
      <span class="card-corner bottom"><b>${rank}</b><i>${suit}</i></span>
    `;
    return btn;
  }

  /**
   * 构造一张牌背（展示层，从旧实现移植）。
   *
   * @param {string} [extraClass] - 附加类名。
   * @returns {HTMLDivElement} 牌背节点。
   */
  function cardBack(extraClass = "") {
    const card = document.createElement("div");
    card.className = `playing-card card-back ${extraClass}`.trim();
    card.setAttribute("aria-hidden", "true");
    card.innerHTML = "<span></span>";
    return card;
  }

  /** 渲染牌桌（全部由权威快照推导，本地只读）。 */
  function render() {
    const mySeat = state.mySeatIndex;
    const bidSeat = state.seats[state.biddingTurn];
    const activeSeat = state.seats[state.turn];

    // 1. 按钮显隐与可用性。
    if (callBidBtn) callBidBtn.disabled = !canBid();
    if (passBidBtn) passBidBtn.disabled = !canBid();
    if (hintBtn) hintBtn.disabled = !canPlay();
    if (playBtn) playBtn.disabled = !canPlay();
    if (passBtn) passBtn.disabled = !(canPlay() && state.lastPlay);
    if (bidActions) bidActions.hidden = state.phase !== "bidding";
    if (playActions) playActions.hidden = state.phase !== "playing";
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.seats.length === 3);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";
    if (roomLog) roomLog.textContent = state.roomId ? "斗地主需要 3 名玩家，满员自动发牌。" : "创建房间并邀请两位好友，满 3 人自动发牌。";

    // 2. 状态栏。
    phaseLabel.textContent =
      state.phase === "idle" ? "等待发牌" : state.phase === "bidding" ? `${bidSeat?.name || "玩家"} 叫地主` : state.landlordIndex === null ? "等待确认地主" : `${state.seats[state.landlordIndex]?.name || ""} 是地主`;
    turnLabel.textContent = !state.started ? "等待开始" : state.over ? "已结束" : state.phase === "bidding" ? bidSeat?.name || "" : activeSeat?.name || "";
    multiplierLabel.textContent = `倍率：x${state.multiplier}`;
    if (log) log.textContent = state.message || "支持叫地主、底牌、提示、炸弹/王炸翻倍与手牌隐藏视角。";

    // 3. 底牌：公布前显示牌背，公布后显示牌面。
    bottomPanel.innerHTML = "";
    for (let i = 0; i < rules.BOTTOM_COUNT; i += 1) {
      const card = state.bottomCards[i];
      bottomPanel.appendChild(card ? cardButton(card, false) : cardBack());
    }

    // 4. 上一手牌（公开）。
    lastPlayPanel.innerHTML = "";
    const lastOwner = state.lastPlayerIndex === null ? null : state.seats[state.lastPlayerIndex];
    lastPlayTitle.textContent = state.lastPlay ? `${lastOwner?.name || "上一手"} 出牌` : "桌面";
    (state.lastPlay?.cards || []).forEach((card) => lastPlayPanel.appendChild(cardButton(card, false)));

    // 5. 三个座位：自己显示手牌（可选中），他人只显示张数与牌背。
    playersPanel.innerHTML = "";
    state.seats.forEach((seat, seatIndex) => {
      const isSelf = seatIndex === mySeat;
      const section = document.createElement("section");
      section.className = `hand-card player-strip landlord-seat ${isSelf ? "self" : "opponent"} seat-${seatIndex}`;
      section.innerHTML = `
        <header>
          <h3>${seat.name}${seat.isLandlord ? "（地主）" : ""}</h3>
          <span>${seat.handCount} 张</span>
        </header>
      `;

      const played = document.createElement("div");
      played.className = "card-hand seat-played";
      if (state.lastPlay && state.lastPlayerIndex === seatIndex) {
        state.lastPlay.cards.forEach((card) => played.appendChild(cardButton(card, false)));
      }
      section.appendChild(played);

      const hand = document.createElement("div");
      hand.className = "card-hand";
      if (isSelf) {
        // 1. 自己的手牌：可点击选中（本地 UX），出牌时只发 id。
        state.myHand.forEach((card, cardIndex) => {
          const enabled = canPlay();
          const node = cardButton(card, enabled);
          node.dataset.handIndex = String(cardIndex);
          if (enabled && state.selected.includes(cardIndex)) node.classList.add("selected");
          node.addEventListener("click", () => {
            if (!canPlay()) return;
            state.selected = state.selected.includes(cardIndex)
              ? state.selected.filter((index) => index !== cardIndex)
              : [...state.selected, cardIndex];
            render();
          });
          hand.appendChild(node);
        });
      } else {
        // 2. 他人座位：只按剩余张数画牌背，内容永远不可见。
        for (let i = 0; i < seat.handCount; i += 1) hand.appendChild(cardBack("side"));
      }
      section.appendChild(hand);
      playersPanel.appendChild(section);
    });
  }

  /** 测试钩子：输出可读状态（他人手牌内容不在其中，只有张数）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      phase: state.phase,
      started: state.started,
      over: state.over,
      turn: state.turn,
      biddingTurn: state.biddingTurn,
      landlordIndex: state.landlordIndex,
      multiplier: state.multiplier,
      seats: state.seats,
      lastPlay: state.lastPlay,
      lastPlayerIndex: state.lastPlayerIndex,
      bidHistory: state.bidHistory,
      bottomCards: state.bottomCards,
      bottomRevealed: state.bottomRevealed,
      winnerSeat: state.winnerSeat,
      moves: state.moves,
      mySeatIndex: state.mySeatIndex,
      myHand: state.myHand,
      selectedCount: state.selected.length,
      message: state.message,
      room: { roomId: state.roomId },
    });

  /** 测试钩子：联机面板 API（越权校验需绕过前端拦截直接发意图）。 */
  window.roomApi = roomApi;

  render();
})();
