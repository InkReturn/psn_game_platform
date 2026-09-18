/**
 * 德州扑克渲染层（浏览器端，服务器权威模式）。
 *
 * 职责边界：
 * - 本地状态只是"服务器权威快照的只读镜像"：自己的底牌（myHand）、
 *   公共牌（community，按阶段进度）、他人的筹码/注额/弃牌状态与张数；
 * - 跟注/加注/弃牌只产生意图（发 check_call/raise/fold/start/restart 请求）：
 *   洗牌与发牌永远来自服务器，客户端绝不自产随机数；
 * - 底牌内容结算前只对自己可见；终局后服务器公开全部底牌（沿用旧口径）。
 */
(function () {
  "use strict";

  const rules = window.TexasRules;
  if (!rules) return;

  const phaseNames = { idle: "等待开局", preflop: "翻牌前", flop: "翻牌圈", turn: "转牌圈", river: "河牌圈", showdown: "摊牌" };

  const seatsPanel = document.querySelector("#texasSeats");
  const communityPanel = document.querySelector("#communityCards");
  const turnLabel = document.querySelector("#texasTurn");
  const log = document.querySelector("#texasLog");
  const roomLog = document.querySelector("#texasRoomLog");
  const roomBadge = document.querySelector("#texasRoomBadge");
  const potBadge = document.querySelector("#texasPotBadge");
  const phaseBadge = document.querySelector("#texasPhaseBadge");
  const playerCountSelect = document.querySelector("#texasPlayerCount");
  const checkCallBtn = document.querySelector("#checkCallBtn");
  const raiseBtn = document.querySelector("#raiseBtn");
  const foldBtn = document.querySelector("#foldBtn");
  const startBtn = document.querySelector("#startTexasBtn");
  const restartBtn = document.querySelector("#resetTexasBtn");
  const roomStatus = document.querySelector("#roomStatus");

  /**
   * 客户端状态：服务器个性化快照的只读镜像。
   */
  const state = {
    phase: "idle",
    started: false,
    over: false,
    turn: 0,
    dealer: -1,
    pot: 0,
    currentBet: 0,
    winners: [],
    moves: 0,
    community: [],
    seats: [],
    seatPlayerIds: [],
    mySeatIndex: null,
    myHand: [],
    message: "",
    roomId: "",
  };

  /** 联机面板 API（onRoomChange 会在初始化过程中同步回调，故先声明再赋值）。 */
  let roomApi = null;

  roomApi = window.initAuthoritativeRoomPanel({
    gameType: "texas",
    prefix: "TX",
    storageKey: "linkplay-room-texas-v1",
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
        // 1. 退出房间后回到未开局状态（本地不保留任何底牌）。
        state.phase = "idle";
        state.started = false;
        state.over = false;
        state.seats = [];
        state.community = [];
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
    // 1. 覆盖全部权威字段（他人底牌与未来公共牌从不在快照里）。
    state.phase = g.phase || "idle";
    state.started = Boolean(g.started);
    state.over = Boolean(g.over);
    state.turn = g.turn || 0;
    state.dealer = g.dealer ?? -1;
    state.pot = g.pot || 0;
    state.currentBet = g.currentBet || 0;
    state.winners = Array.isArray(g.winners) ? g.winners : [];
    state.moves = g.moves || 0;
    state.community = Array.isArray(g.community) ? g.community : [];
    state.seats = Array.isArray(g.seats) ? g.seats : [];
    state.seatPlayerIds = Array.isArray(g.seatPlayerIds) ? g.seatPlayerIds : [];
    state.mySeatIndex = g.mySeatIndex === null || g.mySeatIndex === undefined ? null : g.mySeatIndex;
    state.myHand = Array.isArray(g.myHand) ? g.myHand : [];
    state.message = g.message || state.message;
  }

  /** 是否轮到本地玩家行动。 */
  function canAct() {
    return state.started && !state.over && state.phase !== "idle" && state.phase !== "showdown" && state.mySeatIndex === state.turn;
  }

  /** 过牌/跟注意图。 */
  function callOrCheck() {
    if (!canAct()) {
      render();
      return;
    }
    roomApi.sendAction("check_call").catch(() => render());
  }

  /** 加注意图（固定 +20，由服务器结算）。 */
  function raiseBet() {
    if (!canAct()) {
      render();
      return;
    }
    roomApi.sendAction("raise").catch(() => render());
  }

  /** 弃牌意图。 */
  function foldSeat() {
    if (!canAct() || state.currentBet === 0) {
      render();
      return;
    }
    roomApi.sendAction("fold").catch(() => render());
  }

  /** 房主开下一手。 */
  function startHand() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("start").catch(() => render());
  }

  /** 房主整桌重置。 */
  function restartTable() {
    if (!roomApi?.isHost?.() || !state.roomId) return;
    roomApi.sendAction("restart").catch(() => render());
  }

  checkCallBtn?.addEventListener("click", callOrCheck);
  raiseBtn?.addEventListener("click", raiseBet);
  foldBtn?.addEventListener("click", foldSeat);
  startBtn?.addEventListener("click", startHand);
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
    node.setAttribute("aria-label", `${card.rank}${suit}`);
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
    roomBadge.textContent = state.roomId ? `房间：${state.roomId}` : "房间：未进入";
    potBadge.textContent = `底池：${state.pot}`;
    phaseBadge.textContent = phaseNames[state.phase] || state.phase;
    turnLabel.textContent = state.over ? "本局结束" : state.started ? `${state.seats[state.turn]?.name || ""} 操作` : "等待开局";
    if (log) log.textContent = state.message || "翻牌前后按当前注额跟注、加注或弃牌，河牌后自动比牌。";
    if (roomLog) roomLog.textContent = state.roomId ? "满员自动开局；一手结束后由房主开下一手。" : "创建房间并邀请好友（2-6 人），满员自动开局。";
    if (checkCallBtn) checkCallBtn.disabled = !canAct();
    if (raiseBtn) raiseBtn.disabled = !canAct();
    if (foldBtn) foldBtn.disabled = !(canAct() && state.currentBet > 0);
    if (startBtn) startBtn.disabled = !(roomApi?.isHost?.() && state.roomId && state.seats.length >= 2 && (!state.started || state.over));
    if (restartBtn) restartBtn.disabled = !(roomApi?.isHost?.() && state.roomId);
    if (roomStatus && !state.roomId) roomStatus.textContent = "未进房";

    // 1. 公共牌：按进度显示，未发的画牌背（未来公共牌不在状态里）。
    communityPanel.innerHTML = "";
    state.community.forEach((card) => communityPanel.appendChild(cardNode(card)));
    for (let i = state.community.length; i < 5; i += 1) communityPanel.appendChild(cardBack());

    // 2. 玩家座位：自己显示底牌，他人按张数画牌背（终局后公开）。
    seatsPanel.innerHTML = "";
    state.seats.forEach((seat, index) => {
      const isSelf = index === state.mySeatIndex;
      const section = document.createElement("section");
      section.className = `surface-card poker-seat ${index === state.turn && state.started && !state.over ? "active" : ""} ${state.winners.includes(index) ? "winner" : ""}`;
      section.innerHTML = `<header><h3>${seat.name}${index === state.dealer && state.started ? "（庄）" : ""}</h3><span>${seat.folded ? "已弃牌" : `筹码 ${seat.stack}`}</span></header><p class="mini-note">本轮下注：${seat.bet}</p>`;
      const hand = document.createElement("div");
      hand.className = "card-hand";
      if (isSelf) {
        // 1. 自己的底牌：始终可见。
        state.myHand.forEach((card) => hand.appendChild(cardNode(card)));
      } else if (seat.hand) {
        // 2. 终局后：他人底牌公开。
        seat.hand.forEach((card) => hand.appendChild(cardNode(card)));
      } else {
        // 3. 终局前：他人底牌只显示张数（牌背）。
        for (let i = 0; i < seat.handCount; i += 1) hand.appendChild(cardBack());
      }
      section.appendChild(hand);
      seatsPanel.appendChild(section);
    });
  }

  /** 测试钩子：输出可读状态（他人底牌内容不在其中，只有张数）。 */
  window.render_game_to_text = () =>
    JSON.stringify({
      phase: state.phase,
      started: state.started,
      over: state.over,
      turn: state.turn,
      dealer: state.dealer,
      pot: state.pot,
      currentBet: state.currentBet,
      winners: state.winners,
      moves: state.moves,
      community: state.community,
      seats: state.seats,
      mySeatIndex: state.mySeatIndex,
      myHand: state.myHand,
      message: state.message,
      room: { roomId: state.roomId },
    });

  /** 测试钩子：联机面板 API（越权校验需绕过前端拦截直接发意图）。 */
  window.roomApi = roomApi;

  render();
})();
