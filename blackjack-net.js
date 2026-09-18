/**
 * 21 点渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"：自己的手牌（myHand）、
 *   庄家明牌（dealer.cards，暗牌只以张数体现）、他人张数（结算后公开）；
 * - 要牌/停牌只产生意图（发 hit/stand/start/restart 请求）：发牌永远来自
 *   服务器，客户端绝不自产随机数；
 * - 点数显示复用 blackjack-rules.js 的纯函数（与服务端同一份规则代码）。
 */
(function () {
  "use strict";

  const rules = window.BlackjackRules;
  if (!rules) return;

  const seatsPanel = document.querySelector("#blackjackSeats");
  const dealerCardsPanel = document.querySelector("#dealerCards");
  const dealerScoreLabel = document.querySelector("#dealerScore");
  const turnLabel = document.querySelector("#blackjackTurn");
  const log = document.querySelector("#blackjackLog");
  const roomLog = document.querySelector("#blackjackRoomLog");
  const roomBadge = document.querySelector("#blackjackRoomBadge");
  const phaseBadge = document.querySelector("#blackjackPhaseBadge");
  const playerCountSelect = document.querySelector("#blackjackPlayerCount");
  const hitBtn = document.querySelector("#hitBtn");
  const standBtn = document.querySelector("#standBtn");
  const startBtn = document.querySelector("#startBlackjackBtn");
  const restartBtn = document.querySelector("#resetBlackjackBtn");
  const roomStatus = document.querySelector("#roomStatus");

  /**
   * 客户端状态：服务器个性化快照的只读镜像。
   */
  const state = {
    phase: "idle",
    started: false,
    over: false,
    turn: 0,
    winners: [],
    moves: 0,
    seats: [],
    dealer: { cards: [], handCount: 0, hidden: true, score: null },
    seatPlayerIds: [],
    mySeatIndex: null,
    myHand: [],
    message: "",
    roomId: "",
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "blackjack",
    prefix: "BJ",
    storageKey: "linkplay-room-blackjack-v1",
    /** 状态栏文案依据：服务器是否已开局。 */
    isGameReady: () => state.started,
    /** 建房附加负载：房主选定的人数（1-3），建房时生效。 */
    createPayload: () => ({ playerCount: Number(playerCountSelect?.value) || 2 }),
    onGameUpdate(snapshot) {
      applyServerSnapshot(snapshot);
      render();
    },
    onRoomChange(room) {
      state.roomId = room.roomId || "";
      roomBadge.textContent = room.roomId ? `房间：${room.roomId}` : "房间：未进入";
      if (playerCountSelect) playerCountSelect.disabled = Boolean(room.roomId);
      if (!room.roomId) {
        // 1. 退出房间后回到未开局状态（本地不保留任何手牌）。
        state.phase = "idle";
        state.started = false;
        state.over = false;
        state.seats = [];
        state.dealer = { cards: [], handCount: 0, hidden: true, score: null };
        state.myHand = [];
        state.mySeatIndex = null;
        state.seatPlayerIds = [];
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
    // 1. 覆盖全部权威字段（庄家暗牌与他人手牌从不在结算前的快照里）。
    state.phase = g.phase || "idle";
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.turn = g.turn || 0;
    state.winners = Array.isArray(g.winners) ? g.winners : [];
    state.moves = g.moves || 0;
    state.seats = Array.isArray(g.seats) ? g.seats : [];
    state.dealer = g.dealer || { cards: [], handCount: 0, hidden: true, score: null };
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.mySeatIndex = g.mySeatIndex === null || g.mySeatIndex === undefined ? null : g.mySeatIndex;
    state.myHand = Array.isArray(g.myHand) ? g.myHand : [];
    state.message = g.message || state.message;
  }

  /** 是否轮到本地玩家操作。 */
  function canAct() {
    return state.started && !state.over && state.phase === "player" && state.mySeatIndex === state.turn;
  }

  /** 要牌意图（服务器从自己的牌堆发牌）。 */
  function hit() {
    if (!canAct()) {
      render();
      return;
    }
    roomApi.sendAction("hit").catch(() => render());
  }

  /** 停牌意图。 */
  function stand() {
    if (!canAct()) {
      render();
      return;
    }
    roomApi.sendAction("stand").catch(() => render());
  }

  /** 房主开新一局（保留筹码）。 */
  function startRound() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("start").catch(() => render());
  }

  /** 房主整桌重置。 */
  function restartTable() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  hitBtn?.addEventListener("click", hit);
  standBtn?.addEventListener("click", stand);
  startBtn?.addEventListener("click", startRound);
  restartBtn?.addEventListener("click", restartTable);

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
   * 构造一张牌面节点（展示层，从旧实现移植；附 data-card-id 供测试定位）。
   *
   * @param {object} card - 牌。
   * @returns {HTMLDivElement} 节点。
   */
  function cardNode(card) {
    const node = document.createElement("div");
    const color = card.suit === "H" || card.suit === "D" ? "red" : "black";
    const suit = suitLabel(card.suit);
    node.className = `playing-card ${color}`;
    node.dataset.cardId = card.id;
    node.innerHTML = `<span class="card-corner top"><b>${card.rank}</b><i>${suit}</i></span><span class="card-pip">${suit}</span><span class="card-corner bottom"><b>${card.rank}</b><i>${suit}</i></span>`;
    return node;
  }

  /** 构造一张牌背（展示层，从旧实现移植）。 */
  function cardBack() {
    const back = document.createElement("div");
    back.className = "playing-card card-back";
    back.innerHTML = "<span></span>";
    return back;
  }

  /** 渲染牌桌（全部由权威快照推导，本地只读）。 */
  function render() {
    phaseBadge.textContent = state.phase === "idle" ? "等待开局" : state.phase === "showdown" ? "结算" : state.phase;
    turnLabel.textContent = state.over ? "本局结束" : state.started ? `${state.seats[state.turn]?.name || ""} 操作` : "等待开局";
    if (log) log.textContent = state.message || "点数尽量接近 21，超过 21 爆牌。";
    if (roomLog) roomLog.textContent = state.roomId ? "满员自动开局；一局结束后由房主开新一局。" : "创建房间并邀请好友（1-3 人对庄家），满员自动开局。";
    if (hitBtn) hitBtn.disabled = !canAct();
    if (standBtn) standBtn.disabled = !canAct();
    if (startBtn) startBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.seats.length > 0 && (!state.started || state.over));
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";

    // 1. 庄家：明牌 + 暗牌以牌背渲染（张数来自服务器）。
    dealerCardsPanel.innerHTML = "";
    state.dealer.cards.forEach((card) => dealerCardsPanel.appendChild(cardNode(card)));
    for (let i = state.dealer.cards.length; i < state.dealer.handCount; i += 1) dealerCardsPanel.appendChild(cardBack());
    dealerScoreLabel.textContent = `点数：${state.dealer.hidden ? "?" : state.dealer.score ?? "?"}`;

    // 2. 玩家座位：自己显示手牌，他人按张数画牌背（结算后公开）。
    seatsPanel.innerHTML = "";
    state.seats.forEach((seat, index) => {
      const isSelf = index === state.mySeatIndex;
      const section = document.createElement("section");
      section.className = `surface-card poker-seat ${index === state.turn && state.started && !state.over ? "active" : ""} ${state.winners.includes(index) ? "winner" : ""}`;
      const score = isSelf ? rules.handValue(state.myHand) : seat.hand ? rules.handValue(seat.hand) : null;
      section.innerHTML = `<header><h3>${seat.name}</h3><span>${seat.busted ? "爆牌" : seat.stood ? "停牌" : `筹码 ${seat.chips}`}</span></header><p class="mini-note">点数：${score ?? "?"}</p>`;
      const hand = document.createElement("div");
      hand.className = "card-hand";
      if (isSelf) {
        // 1. 自己的手牌：始终可见。
        state.myHand.forEach((card) => hand.appendChild(cardNode(card)));
      } else if (seat.hand) {
        // 2. 结算后：他人手牌公开。
        seat.hand.forEach((card) => hand.appendChild(cardNode(card)));
      } else {
        // 3. 结算前：他人手牌只显示张数（牌背）。
        for (let i = 0; i < seat.handCount; i += 1) hand.appendChild(cardBack());
      }
      section.appendChild(hand);
      seatsPanel.appendChild(section);
    });
  }

  /** 测试钩子：输出可读状态（他人手牌内容与庄家暗牌不在其中）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      phase: state.phase,
      started: state.started,
      over: state.over,
      turn: state.turn,
      winners: state.winners,
      moves: state.moves,
      seats: state.seats,
      dealer: state.dealer,
      mySeatIndex: state.mySeatIndex,
      myHand: state.myHand,
      message: state.message,
      room: { roomId: state.roomId },
    });

  /** 测试钩子：联机面板 API（越权校验需绕过前端拦截直接发意图）。 */
  window.roomApi = roomApi;

  render();
})();
