/**
 * LinkPlay 大厅应用（浏览器端，无框架）。
 *
 * 实现 QQ 游戏大厅式两级结构：
 * 1. 选择游戏：游戏卡片区（.lobby-game），点击联机游戏进入对应游戏的房间视图；
 * 2. 选择房间：轮询 lobby.listRooms 展示房间列表（房名/房间号/人数/状态），
 *    支持点击房间进入、房间号直加、创建房间（?create=1 由游戏页自动建房）
 *    与快速开始（自动找可加入的等待中房间，找不到就自动建房）。
 *
 * 同时承载账号 UI：顶栏用户徽章、登录/注册/游客昵称弹窗（auth-client.js 供电）。
 * 本页不创建/加入房间——房间生命周期全部由各游戏页的房间面板完成，
 * 大厅只做浏览、跳转与参数传递。
 */
(function () {
  "use strict";

  /** 联机游戏注册表：gameType → 页面/展示名/房间码前缀（与 server/games/game-types.js 对齐）。 */
  const GAMES = {
    gomoku: { page: "gomoku.html", name: "五子棋", prefix: "WZ" },
    tictactoe: { page: "tictactoe.html", name: "井字棋", prefix: "JZ" },
    reversi: { page: "reversi.html", name: "黑白棋", prefix: "HB" },
    connect4: { page: "connect4.html", name: "四子棋", prefix: "SZ" },
    monopoly: { page: "monopoly.html", name: "大富翁", prefix: "DF" },
    ludo: { page: "ludo.html", name: "飞行棋", prefix: "FQ" },
    checkers: { page: "checkers.html", name: "跳棋", prefix: "TQ" },
    "animal-chess": { page: "animal-chess.html", name: "斗兽棋", prefix: "DS" },
    texas: { page: "texas.html", name: "德州扑克", prefix: "TX" },
    blackjack: { page: "blackjack.html", name: "21点", prefix: "BJ" },
    landlord: { page: "landlord.html", name: "斗地主", prefix: "DD" },
    "gold-miner": { page: "gold-miner.html", name: "黄金矿工", prefix: "GM" },
  };

  /** 房间列表轮询周期（毫秒）。 */
  const POLL_INTERVAL_MS = 2500;

  /** 空态文案（首次拉取完成且无房间时展示）。 */
  const ROOMS_EMPTY_TEXT = "现在还没有房间，点「创建房间」等朋友进来，或「快速开始」自动匹配。";
  /** 加载态文案（进入房间视图到第一次列表返回之间展示）。 */
  const ROOMS_LOADING_TEXT = "正在获取房间列表…";

  /** DOM 引用。 */
  const gamesView = document.querySelector("#lobbyGames");
  const roomsView = document.querySelector("#lobbyRooms");
  const roomsTitle = document.querySelector("#roomsTitle");
  const roomsCount = document.querySelector("#roomsCount");
  const roomList = document.querySelector("#roomList");
  const roomsEmpty = document.querySelector("#roomsEmpty");
  const backToGamesBtn = document.querySelector("#backToGamesBtn");
  const quickStartBtn = document.querySelector("#quickStartBtn");
  const createRoomBtn = document.querySelector("#createRoomBtn");
  const newRoomNameInput = document.querySelector("#newRoomNameInput");
  const joinRoomBtn = document.querySelector("#joinRoomBtn");
  const joinRoomIdInput = document.querySelector("#joinRoomIdInput");
  const userBadge = document.querySelector("#userBadge");
  const loginEntryBtn = document.querySelector("#loginEntryBtn");
  const logoutBtn = document.querySelector("#logoutBtn");
  const authModal = document.querySelector("#authModal");
  const authCloseBtn = document.querySelector("#authCloseBtn");
  const authTabs = document.querySelectorAll(".auth-tab");
  const authForms = {
    login: document.querySelector("#authLoginForm"),
    register: document.querySelector("#authRegisterForm"),
    guest: document.querySelector("#authGuestForm"),
  };

  /** 大厅运行时状态。 */
  const state = {
    /** 当前进入房间视图的 gameType（空表示在一级视图）。 */
    currentGame: "",
    /** 最近一次拉到的房间摘要列表（快速开始直接复用）。 */
    rooms: [],
    /** WS 连接（仅房间视图期间持有）。 */
    net: null,
    /** 轮询定时器 id。 */
    pollTimer: null,
    /** 在途轮询标记（防止慢响应堆积请求）。 */
    pollInFlight: false,
  };

  /**
   * 读取共享昵称（各游戏页同源约定）。
   *
   * @returns {string} 当前昵称，未设置时返回 "游客"。
   */
  function currentNickname() {
    return (localStorage.getItem("linkplay-name") || "").trim() || "游客";
  }

  /**
   * 渲染顶栏用户区。
   *
   * @param {{username: string, nickname: string}|null} account - 已登录账号视图；null 表示游客。
   */
  function renderUserArea(account) {
    if (account) {
      // 1. 已登录：徽章展示昵称 + 账号标记，显示退出按钮。
      userBadge.textContent = `${account.nickname}`;
      userBadge.classList.add("logged-in");
      loginEntryBtn.hidden = true;
      logoutBtn.hidden = false;
    } else {
      // 2. 游客：徽章可点开弹窗改名/登录。
      userBadge.textContent = `${currentNickname()}`;
      userBadge.classList.remove("logged-in");
      loginEntryBtn.hidden = false;
      logoutBtn.hidden = true;
    }
  }

  /**
   * 进入房间视图：切换一级/二级视图并启动房间列表轮询。
   *
   * @param {string} gameKey - GAMES 里的 gameType。
   */
  function showRooms(gameKey) {
    const game = GAMES[gameKey];
    if (!game) return;
    // 1. 视图切换 + 标题。
    state.currentGame = gameKey;
    state.rooms = [];
    gamesView.hidden = true;
    roomsView.hidden = false;
    roomsTitle.textContent = `${game.name} · 选择房间`;
    roomsCount.textContent = "";
    roomList.replaceChildren();
    // 1.1 列表区先给加载态反馈，第一次轮询结果到达后替换为空态文案或房间列表。
    roomsEmpty.hidden = false;
    roomsEmpty.textContent = ROOMS_LOADING_TEXT;
    // 2. 清理上一轮操作残留。
    newRoomNameInput.value = "";
    joinRoomIdInput.value = "";
    // 3. 建连并启动轮询。
    if (!state.net) {
      state.net = window.LinkPlayNet.createNet();
    }
    state.net.connect().catch(() => {});
    pollOnce();
    if (state.pollTimer) clearInterval(state.pollTimer);
    state.pollTimer = setInterval(pollOnce, POLL_INTERVAL_MS);
  }

  /** 返回一级视图：停轮询、断连接。 */
  function hideRooms() {
    // 1. 停轮询。
    if (state.pollTimer) {
      clearInterval(state.pollTimer);
      state.pollTimer = null;
    }
    // 2. 断开 WS（下次进入会重连）。
    if (state.net) {
      state.net.close();
    }
    state.currentGame = "";
    state.rooms = [];
    // 3. 切回一级视图。
    roomsView.hidden = true;
    gamesView.hidden = false;
  }

  /** 拉取一次当前游戏的房间列表（慢响应时不叠加请求）。 */
  async function pollOnce() {
    // 1. 未在房间视图（或上一轮未返回）时跳过。
    if (!state.currentGame || state.pollInFlight) return;
    state.pollInFlight = true;
    try {
      await state.net.connect();
      const res = await state.net.request("lobby.listRooms", { gameType: state.currentGame });
      state.rooms = res.payload.rooms || [];
      renderRooms(state.rooms);
    } catch {
      /* 断线由 net-client 自动重连；本轮静默跳过，下一轮继续 */
    } finally {
      state.pollInFlight = false;
    }
  }

  /**
   * 状态徽章中文文案。
   *
   * @param {string} status - waiting/playing/finished。
   * @returns {string} 展示文案。
   */
  function statusText(status) {
    if (status === "playing") return "游戏中";
    if (status === "finished") return "本局结束";
    return "等待中";
  }

  /**
   * 渲染房间列表（全量重建，数据量小且每次都是权威快照）。
   *
   * @param {Array<object>} rooms - RoomBase.summary() 摘要数组。
   */
  function renderRooms(rooms) {
    roomList.replaceChildren();
    roomsCount.textContent = rooms.length ? `${rooms.length} 间房间` : "";
    // 1. 空列表展示空态文案（替换加载态），非空则收起空态。
    roomsEmpty.hidden = rooms.length > 0;
    if (!rooms.length) {
      roomsEmpty.textContent = ROOMS_EMPTY_TEXT;
    }
    for (const room of rooms) {
      const game = GAMES[room.gameType];
      const full = room.players >= room.maxPlayers;
      // 1. 行容器：点击整行进入房间。
      const row = document.createElement("li");
      row.className = "room-row";
      if (full) row.classList.add("full");
      // 2. 房名与房间号。
      const main = document.createElement("div");
      main.className = "room-main";
      const nameEl = document.createElement("strong");
      nameEl.className = "room-name";
      nameEl.textContent = room.roomName;
      const idEl = document.createElement("span");
      idEl.className = "room-id";
      idEl.textContent = room.roomId;
      main.append(nameEl, idEl);
      // 3. 房主。
      const hostEl = document.createElement("span");
      hostEl.className = "room-host";
      hostEl.textContent = `房主 ${room.hostNickname}`;
      // 4. 人数。
      const playersEl = document.createElement("span");
      playersEl.className = "room-players";
      playersEl.textContent = `${room.players}/${room.maxPlayers} 人`;
      // 5. 状态徽章。
      const statusEl = document.createElement("span");
      statusEl.className = `room-status-badge ${room.status}`;
      statusEl.textContent = statusText(room.status);
      // 6. 操作按钮：满员显示"已满"（禁用），否则"进入房间"。
      const actionEl = document.createElement("span");
      actionEl.className = "room-action";
      if (full) {
        actionEl.textContent = "已满员";
      } else {
        const enterBtn = document.createElement("button");
        enterBtn.type = "button";
        enterBtn.textContent = "进入房间";
        enterBtn.addEventListener("click", (event) => {
          event.stopPropagation();
          gotoRoom(room.roomId);
        });
        actionEl.append(enterBtn);
      }
      row.append(main, hostEl, playersEl, statusEl, actionEl);
      row.addEventListener("click", () => {
        if (!full) gotoRoom(room.roomId);
      });
      void game;
      roomList.append(row);
    }
  }

  /**
   * 跳转到某游戏页并自动加入指定房间。
   *
   * @param {string} roomId - 8 位房间码。
   */
  function gotoRoom(roomId) {
    const game = GAMES[state.currentGame];
    if (!game || !roomId) return;
    window.location.href = `${game.page}?room=${encodeURIComponent(roomId)}`;
  }

  /** 快速开始：优先加入等待中的未满房间，否则自动创建新房。 */
  function quickStart() {
    const game = GAMES[state.currentGame];
    if (!game) return;
    // 1. 找未满且非游戏中的房间（等待中/本局结束都可进，结束的可再开一把）。
    const candidate = state.rooms.find((r) => r.players < r.maxPlayers && r.status !== "playing");
    if (candidate) {
      gotoRoom(candidate.roomId);
      return;
    }
    // 2. 没有可进房间：自动建房。
    window.location.href = `${game.page}?create=1`;
  }

  /** 创建房间：带上可选房名跳 ?create=1，由游戏页房间面板自动建房。 */
  function createRoom() {
    const game = GAMES[state.currentGame];
    if (!game) return;
    // 1. 房间名经 localStorage 中转（?create=1 无法直接携带参数）。
    const roomName = newRoomNameInput.value.trim();
    if (roomName) {
      localStorage.setItem("linkplay-pending-room-name", roomName);
    } else {
      localStorage.removeItem("linkplay-pending-room-name");
    }
    // 2. 跳转后由游戏页自动建房，成功与否均由游戏页面板反馈。
    window.location.href = `${game.page}?create=1`;
  }

  /** 按房间号加入：校验前缀与当前游戏一致后跳转。 */
  function joinByRoomId() {
    const game = GAMES[state.currentGame];
    if (!game) return;
    const roomId = joinRoomIdInput.value.trim().toUpperCase();
    if (!roomId) return;
    // 1. 前缀校验：避免拿五子棋房间号进斗兽棋专区。
    if (roomId.slice(0, 2) !== game.prefix) {
      window.alert("房间号与当前游戏不符，请检查房间号或回大厅选择对应游戏");
      return;
    }
    window.location.href = `${game.page}?room=${encodeURIComponent(roomId)}`;
  }

  /* ---------------- 登录弹窗 ---------------- */

  /**
   * 打开登录弹窗并激活指定 tab。
   *
   * @param {string} [tab] - login/register/guest；缺省 login。
   */
  function openAuthModal(tab) {
    switchAuthTab(tab || "login");
    // 1. 打开前清掉上一轮的错误提示。
    authModal.querySelectorAll(".auth-error").forEach((el) => {
      el.hidden = true;
      el.textContent = "";
    });
    authModal.hidden = false;
  }

  /** 关闭登录弹窗。 */
  function closeAuthModal() {
    authModal.hidden = true;
  }

  /**
   * 切换登录弹窗 tab。
   *
   * @param {string} tab - login/register/guest。
   */
  function switchAuthTab(tab) {
    // 1. tab 按钮高亮。
    authTabs.forEach((btn) => btn.classList.toggle("active", btn.dataset.authTab === tab));
    // 2. 对应表单显示，其余隐藏。
    Object.entries(authForms).forEach(([key, form]) => {
      form.hidden = key !== tab;
    });
  }

  /**
   * 在表单内展示 auth 错误。
   *
   * @param {HTMLFormElement} form - 目标表单。
   * @param {string} message - 中文文案。
   */
  function showAuthError(form, message) {
    const el = form.querySelector("[data-auth-error]");
    if (!el) return;
    el.textContent = message;
    el.hidden = false;
  }

  /**
   * 提交处理：按表单来源调用 auth API。
   *
   * @param {string} kind - login/register/guest。
   * @param {FormData} formData - 表单数据。
   */
  async function submitAuth(kind, formData) {
    const values = Object.fromEntries(formData.entries());
    if (kind === "guest") {
      // 1. 游客：只写共享昵称。
      window.LinkPlayAuth.applyNickname(values.nickname);
      renderUserArea(null);
      closeAuthModal();
      return;
    }
    // 2. 账号注册/登录：失败原样展示服务器文案。
    const data =
      kind === "login"
        ? await window.LinkPlayAuth.login({ username: values.username, password: values.password })
        : await window.LinkPlayAuth.register({
            username: values.username,
            password: values.password,
            nickname: values.nickname,
          });
    if (!data.ok) {
      showAuthError(authForms[kind], data.message || "操作失败，请稍后再试");
      return;
    }
    // 3. 成功：刷新顶栏并关闭弹窗。
    renderUserArea(data.account);
    closeAuthModal();
  }

  /* ---------------- 事件绑定 ---------------- */

  // 1. 联机游戏卡：接管点击进入房间视图（中键/新标签仍可直达游戏页）。
  document.querySelectorAll(".lobby-game[data-room-game]").forEach((card) => {
    card.addEventListener("click", (event) => {
      if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) {
        return;
      }
      event.preventDefault();
      showRooms(card.dataset.roomGame);
    });
  });

  backToGamesBtn.addEventListener("click", hideRooms);
  quickStartBtn.addEventListener("click", quickStart);
  createRoomBtn.addEventListener("click", createRoom);
  joinRoomBtn.addEventListener("click", joinByRoomId);
  joinRoomIdInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") joinByRoomId();
  });
  newRoomNameInput.addEventListener("keydown", (event) => {
    if (event.key === "Enter") createRoom();
  });

  // 2. 用户区：徽章（游客）与登录按钮打开弹窗，退出按钮登出。
  userBadge.addEventListener("click", () => openAuthModal("guest"));
  loginEntryBtn.addEventListener("click", () => openAuthModal("login"));
  logoutBtn.addEventListener("click", async () => {
    await window.LinkPlayAuth.logout();
    renderUserArea(null);
  });

  // 3. 弹窗交互：tab 切换、关闭、Esc、点击遮罩关闭。
  authTabs.forEach((btn) => btn.addEventListener("click", () => switchAuthTab(btn.dataset.authTab)));
  authCloseBtn.addEventListener("click", closeAuthModal);
  authModal.addEventListener("click", (event) => {
    if (event.target === authModal) closeAuthModal();
  });
  document.addEventListener("keydown", (event) => {
    if (event.key === "Escape" && !authModal.hidden) closeAuthModal();
  });
  Object.entries(authForms).forEach(([kind, form]) => {
    form.addEventListener("submit", async (event) => {
      event.preventDefault();
      await submitAuth(kind, new FormData(form));
    });
  });

  // 4. 初始化：探测登录态（未登录静默处理，不打扰游客）。
  renderUserArea(null);
  window.LinkPlayAuth.me().then((account) => renderUserArea(account));
})();
