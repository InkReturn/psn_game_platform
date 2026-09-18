/**
 * 斗兽棋服务器权威联机面板（浏览器端）。
 *
 * 与 gomoku-net.js 同构：负责房间 UI（昵称/创建/加入/退出/邀请链接/成员列表）、
 * 服务器连接、身份凭据保存与断线恢复。对局操作通过 sendAction 发送意图
 * （from/to 坐标），权威状态经 game.updated / room.snapshot 快照回推，
 * 由 animal-chess.js 渲染。
 *
 * 房间同步约定：任何成员变化都由服务器广播 room.snapshot 全量快照，
 * 本面板只做"用最新快照覆盖本地镜像 + 立刻 render"，不按事件类型分支推断。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "linkplay-room-animal-chess-v1";
  const GAME_TYPE = "animal-chess";
  /** 服务器房间快照消息类型（成员/座位/对局状态变化统一走它）。 */
  const ROOM_SNAPSHOT_TYPE = "room.snapshot";
  /** 兼容保留的增量成员事件。 */
  const MEMBER_EVENT_TYPES = ["room.player_joined", "room.player_reconnected", "room.player_left", "room.player_disconnected"];

  /** 规范化房间码输入。
   * @param {string} value - 用户输入。
   * @returns {string} 大写去空白后的房间码。
   */
  function normalizeRoomId(value) {
    return (value || "").trim().toUpperCase();
  }

  /**
   * 初始化斗兽棋联机面板。
   *
   * @param {object} [handlers]
   * @param {Function} [handlers.onRoomChange] - 房间状态变化（含 members）。
   * @param {Function} [handlers.onGameUpdate] - 服务器权威对局快照到达。
   * @param {Function} [handlers.onError] - 服务器拒绝操作（中文文案）。
   * @returns {object} 面板 API。
   */
  window.initAnimalChessPanel = function initAnimalChessPanel(handlers) {
    const { onRoomChange, onGameUpdate, onError } = handlers || {};
    const roomStatus = document.querySelector("#roomStatus");
    const nicknameInput = document.querySelector("#nicknameInput");
    const roomInput = document.querySelector("#roomInput");
    const shareInput = document.querySelector("#shareInput");
    const hostBtn = document.querySelector("#hostBtn");
    const joinBtn = document.querySelector("#joinBtn");
    const copyBtn = document.querySelector("#copyBtn");
    const leaveBtn = document.querySelector("#leaveRoomBtn");
    const memberList = document.querySelector("#roomMemberList");
    const panelUtils = window.LinkPlayRoomPanel;

    const state = {
      roomId: "",
      role: "none",
      nickname: "",
      online: "idle",
      members: {},
      playerId: "",
      /** 服务器对局是否已开始（决定状态栏文案）。 */
      gameReady: false,
    };

    /** 进行中的身份恢复请求（并发去重用）。 */
    let reconnectInFlight = null;

    const net = window.LinkPlayNet.createNet({
      onEvent: handleServerEvent,
      onStatus(status) {
        // 1. 未进房时忽略连接抖动。
        if (!state.roomId) return;
        if (status === "online") state.online = "online";
        if (status === "connecting") state.online = "connecting";
        if (status === "offline") state.online = "error";
        updateStatus();
        // 2. 断线恢复后重新校验身份。
        if (status === "online") tryReconnect(true);
      },
    });

    /** 房间按钮显隐。
     * @param {boolean} inRoom - 是否在房间内。
     */
    function setButtonsInRoom(inRoom) {
      if (hostBtn) hostBtn.hidden = inRoom;
      if (joinBtn) joinBtn.hidden = inRoom;
      if (leaveBtn) leaveBtn.hidden = !inRoom;
      if (roomInput) roomInput.disabled = inRoom;
      if (nicknameInput) nicknameInput.disabled = inRoom;
    }

    /** 更新邀请链接。 */
    function updateShareLink() {
      if (!shareInput) return;
      if (!state.roomId) {
        shareInput.value = "";
        return;
      }
      const url = new URL(window.location.href);
      url.searchParams.set("room", state.roomId);
      shareInput.value = url.toString();
    }

    /** 状态栏文案（完全由权威快照推导）。 */
    function statusLabel() {
      const members = Object.values(state.members);
      if (!panelUtils) return state.roomId ? "已进入" : "未进入房间";
      return panelUtils.roomStatusText({
        roomId: state.roomId,
        online: state.online,
        playerCount: members.length,
        onlineCount: members.filter((m) => m.connected).length,
        isHost: state.role === "host",
        gameReady: state.gameReady,
      });
    }

    /** 刷新展示并通知游戏层。 */
    function updateStatus() {
      const members = Object.values(state.members);
      if (roomStatus) {
        roomStatus.textContent = statusLabel();
        roomStatus.style.color = state.roomId && state.online === "online" ? "var(--accent)" : "var(--warn)";
      }
      if (roomInput) roomInput.value = state.roomId;
      updateShareLink();
      setButtonsInRoom(Boolean(state.roomId));
      // 1. 成员列表每次状态变化都重绘（数据来自服务器快照，本地只读）。
      if (panelUtils) panelUtils.renderMembers(memberList, members, state.playerId);
      onRoomChange?.({ ...state, members });
    }

    /** 保存身份凭据到 localStorage（仅身份，不含棋盘）。 */
    function saveCredentials(reconnectToken) {
      if (!state.roomId || !state.playerId) {
        localStorage.removeItem(STORAGE_KEY);
        return;
      }
      localStorage.setItem(
        STORAGE_KEY,
        JSON.stringify({
          roomId: state.roomId,
          role: state.role,
          nickname: state.nickname,
          playerId: state.playerId,
          reconnectToken: reconnectToken || "",
        }),
      );
    }

    /**
     * 用服务器权威快照刷新本地镜像（房间同步唯一收敛点）。
     *
     * @param {object} snapshot - {room, game} 服务器快照。
     * @returns {boolean} 是否应用了房间部分。
     */
    function applySnapshot(snapshot) {
      if (!snapshot || !snapshot.room) return false;
      // 1. 成员表：整体替换，不做增量合并。
      if (panelUtils) {
        const members = panelUtils.normalizeMembers(snapshot.room);
        state.members = {};
        members.forEach((m) => {
          state.members[m.id] = m;
        });
      }
      // 2. 对局状态：started/over 由服务器给出，用于状态栏文案。
      if (snapshot.game) state.gameReady = Boolean(snapshot.game.started) || Boolean(snapshot.game.over);
      state.online = "online";
      return true;
    }

    /** 把 URL 换成带房间码的形式（刷新/分享可恢复）。 */
    function putRoomInUrl() {
      const url = new URL(window.location.href);
      url.searchParams.set("room", state.roomId);
      history.replaceState(null, "", url);
    }

    /**
     * 服务器事件统一处理。
     *
     * @param {object} message - 协议信封。
     */
    function handleServerEvent(message) {
      const { type, payload } = message;
      if (payload?.snapshot?.room?.roomId && payload.snapshot.room.roomId !== state.roomId) return;

      // 1. 统一房间快照：成员/座位/对局状态变化一律走这里。
      if (type === ROOM_SNAPSHOT_TYPE) {
        applySnapshot(payload.snapshot);
        if (payload.snapshot?.game) onGameUpdate?.(payload.snapshot);
        updateStatus();
        return;
      }

      // 2. 权威对局快照。
      if (type === "game.updated") {
        applySnapshot(payload.snapshot);
        onGameUpdate?.(payload.snapshot);
        updateStatus();
        return;
      }

      // 3. 兼容增量成员事件（服务端新版本统一发 room.snapshot，这里保留兜底）。
      if (MEMBER_EVENT_TYPES.includes(type)) {
        applySnapshot(payload.snapshot);
        if (payload.snapshot?.game) onGameUpdate?.(payload.snapshot);
        if (type === "room.player_left" && payload.playerId === state.playerId) {
          clearRoomState("你已离开房间");
          return;
        }
        updateStatus();
        return;
      }
    }

    /** 清理本地房间状态。
     * @param {string} [message] - 状态栏提示。
     */
    function clearRoomState(message) {
      state.roomId = "";
      state.role = "none";
      state.playerId = "";
      state.online = "idle";
      state.members = {};
      state.gameReady = false;
      localStorage.removeItem(STORAGE_KEY);
      history.replaceState(null, "", window.location.pathname);
      updateStatus();
      if (message && roomStatus) roomStatus.textContent = message;
    }

    /** 请求失败的通用提示。
     * @param {{code:string, message:string}} err - 错误对象。
     */
    function notifyError(err) {
      onError?.(err);
      if (err?.code === "ROOM_NOT_FOUND" || err?.code === "UNAUTHORIZED_PLAYER") {
        clearRoomState(err.code === "ROOM_NOT_FOUND" ? "房间已过期" : "身份失效，请重新加入");
        return;
      }
      if (roomStatus && err?.message) roomStatus.textContent = err.message;
    }

    /**
     * 断线后恢复身份（并发调用复用同一次请求）。
     *
     * @param {boolean} [silent] - 静默模式（不额外提示用户）。
     * @returns {Promise<void>} 重连流程结束后 resolve。
     */
    function tryReconnect(silent) {
      // 1. 无房间/无身份时无需恢复。
      if (!state.roomId || !state.playerId) return Promise.resolve();
      // 2. 已有重连在途：复用同一个 Promise。
      if (reconnectInFlight) return reconnectInFlight;
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.reconnectToken) return Promise.resolve();
      reconnectInFlight = doReconnect(saved, silent);
      return reconnectInFlight;
    }

    /**
     * 真正执行一次身份恢复请求。
     *
     * @param {object} saved - localStorage 中的凭据。
     * @param {boolean} [silent] - 静默模式。
     * @returns {Promise<void>} 完成后 resolve。
     */
    async function doReconnect(saved, silent) {
      state.online = "reconnecting";
      updateStatus();
      try {
        const res = await net.request("room.reconnect", {
          roomId: state.roomId,
          playerId: state.playerId,
          reconnectToken: saved.reconnectToken,
          gameType: GAME_TYPE,
        });
        state.role = res.payload.role || state.role;
        state.online = "online";
        applySnapshot(res.payload.snapshot);
        if (res.payload.snapshot?.game) onGameUpdate?.(res.payload.snapshot);
        updateStatus();
      } catch (err) {
        if (err?.code === "ROOM_NOT_FOUND" || err?.code === "UNAUTHORIZED_PLAYER") {
          clearRoomState(err.code === "ROOM_NOT_FOUND" ? "房间已过期" : "身份失效，请重新加入");
          return;
        }
        // 1. ALREADY_IN_ROOM 表示旧连接尚未被服务器回收，等下一次自动重连重试即可。
        state.online = err?.code === "ALREADY_IN_ROOM" ? "connecting" : "error";
        if (!silent) notifyError(err);
        updateStatus();
      } finally {
        // 2. 释放在途标记，允许后续（真正的）断线重连再次发起。
        reconnectInFlight = null;
      }
    }

    /** 创建房间（房主执红先行）。 */
    async function createRoom() {
      state.role = "host";
      state.nickname = nicknameInput?.value.trim() || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
      state.online = "connecting";
      updateStatus();
      try {
        await net.connect();
        const res = await net.request("room.create", { gameType: GAME_TYPE, prefix: "DS", nickname: state.nickname });
        state.roomId = res.payload.roomId;
        state.playerId = res.payload.playerId;
        state.role = res.payload.role || "host";
        state.online = "online";
        saveCredentials(res.payload.reconnectToken);
        applySnapshot(res.payload.snapshot);
        if (res.payload.snapshot?.game) onGameUpdate?.(res.payload.snapshot);
        putRoomInUrl();
        updateStatus();
      } catch (err) {
        state.online = "idle";
        updateStatus();
        notifyError(err);
      }
    }

    /** 加入房间。
     * @param {string} roomIdInput - 房间码。
     */
    async function joinRoom(roomIdInput) {
      const roomId = normalizeRoomId(roomIdInput);
      if (!roomId) return;
      state.role = "guest";
      state.nickname = nicknameInput?.value.trim() || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
      state.online = "connecting";
      updateStatus();
      try {
        await net.connect();
        const res = await net.request("room.join", { roomId, nickname: state.nickname, gameType: GAME_TYPE });
        state.roomId = res.payload.roomId;
        state.playerId = res.payload.playerId;
        state.role = res.payload.role || "guest";
        state.online = "online";
        saveCredentials(res.payload.reconnectToken);
        applySnapshot(res.payload.snapshot);
        if (res.payload.snapshot?.game) onGameUpdate?.(res.payload.snapshot);
        putRoomInUrl();
        updateStatus();
      } catch (err) {
        state.online = "idle";
        updateStatus();
        notifyError(err);
      }
    }

    /** 主动退出房间。 */
    async function leaveRoom() {
      if (!state.roomId) return;
      try {
        net.send("room.leave");
      } catch {
        /* 忽略网络错误，本地照常清理 */
      }
      clearRoomState();
    }

    /**
     * 发送对局操作意图（走子 / 重开一局）。
     *
     * 客户端只发送"我想做什么"，不发送棋盘、winner 或 turn：
     * 这些权威结果一律由服务器计算后经快照回推。
     *
     * @param {string} action - 动作名（move / restart / start）。
     * @param {object} [params] - 动作参数（如 from/to）。
     * @returns {Promise<void>} 服务器拒绝时 reject（附中文文案）。
     */
    async function sendAction(action, params) {
      if (!state.roomId) return;
      try {
        await net.request("game.action", { action, ...(params || {}) });
      } catch (err) {
        notifyError(err);
        throw err;
      }
    }

    /**
     * 发送一步走子意图。
     *
     * @param {{row:number,col:number}} from - 起点坐标。
     * @param {{row:number,col:number}} to - 终点坐标。
     * @returns {Promise<void>} 服务器拒绝时 reject。
     */
    async function sendMove(from, to) {
      return sendAction("move", { from: { row: from.row, col: from.col }, to: { row: to.row, col: to.col } });
    }

    hostBtn?.addEventListener("click", () => createRoom());
    joinBtn?.addEventListener("click", () => joinRoom(roomInput?.value));
    leaveBtn?.addEventListener("click", () => leaveRoom());
    copyBtn?.addEventListener("click", async () => {
      if (shareInput?.value) await navigator.clipboard.writeText(shareInput.value);
    });

    nicknameInput.value = localStorage.getItem("linkplay-name") || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
    nicknameInput.addEventListener("change", () => localStorage.setItem("linkplay-name", nicknameInput.value.trim()));

    // 1. 页面加载：URL 带房间码或本地有凭据时自动恢复身份。
    const roomFromUrl = normalizeRoomId(new URLSearchParams(window.location.search).get("room"));
    const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
    if (roomFromUrl) {
      state.roomId = roomFromUrl;
      state.role = saved?.roomId === roomFromUrl ? saved.role : "guest";
      state.nickname = nicknameInput.value.trim();
      state.playerId = saved?.roomId === roomFromUrl ? saved.playerId || "" : "";
      state.online = "connecting";
      updateStatus();
      if (state.playerId && saved?.reconnectToken) {
        net.connect().then(() => tryReconnect(true));
      } else {
        joinRoom(roomFromUrl);
      }
    } else if (saved?.roomId && saved?.reconnectToken) {
      state.roomId = saved.roomId;
      state.role = saved.role || "guest";
      state.nickname = saved.nickname || nicknameInput.value.trim();
      state.playerId = saved.playerId || "";
      state.online = "connecting";
      updateStatus();
      net.connect().then(() => tryReconnect(true));
    } else {
      updateStatus();
    }

    return {
      state,
      leaveRoom,
      sendAction,
      sendMove,
      isHost: () => state.role === "host",
      isGuest: () => state.role === "guest",
      hasRoom: () => Boolean(state.roomId),
      connectionCount: () => Math.max(0, Object.keys(state.members).length - 1),
      onlineMemberCount: () => Object.values(state.members).filter((m) => m.connected).length,
      isOnline: () => state.online === "online",
      getPlayerId: () => state.playerId,
    };
  };
})();
