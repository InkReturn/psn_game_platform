/**
 * 五子棋服务器权威联机面板（浏览器端）。
 *
 * 负责五子棋页面的房间 UI（昵称/创建/加入/退出/邀请链接）与服务器连接、
 * 身份凭据保存、断线恢复；对局操作通过 sendAction 发送意图，
 * 权威状态经 game.updated 快照回推，由 gomoku-app.js 渲染。
 */
(function () {
  "use strict";

  const STORAGE_KEY = "linkplay-room-gomoku-v3";
  const GAME_TYPE = "gomoku";

  /** 规范化房间码输入。
   * @param {string} value - 用户输入。
   * @returns {string} 大写去空白后的房间码。
   */
  function normalizeRoomId(value) {
    return (value || "").trim().toUpperCase();
  }

  /**
   * 初始化五子棋联机面板。
   *
   * @param {object} [handlers]
   * @param {Function} [handlers.onRoomChange] - 房间状态变化（含 members）。
   * @param {Function} [handlers.onGameUpdate] - 服务器权威对局快照到达。
   * @param {Function} [handlers.onError] - 服务器拒绝操作（中文文案）。
   * @returns {object} 面板 API。
   */
  window.initGomokuPanel = function initGomokuPanel(handlers) {
    const { onRoomChange, onGameUpdate, onError } = handlers || {};
    const roomStatus = document.querySelector("#connectionStatus");
    const nicknameInput = document.querySelector("#nicknameInput");
    const roomInput = document.querySelector("#roomInput");
    const shareInput = document.querySelector("#shareInput");
    const hostBtn = document.querySelector("#hostBtn");
    const joinBtn = document.querySelector("#joinBtn");
    const copyBtn = document.querySelector("#copyBtn");
    const leaveBtn = document.querySelector("#leaveRoomBtn");

    const state = {
      roomId: "",
      role: "none",
      nickname: "",
      online: "idle",
      members: {},
      playerId: "",
    };

    /** 游戏层注册的错误提示句柄。 */
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

    /** 状态栏文案。 */
    function statusLabel() {
      if (!state.roomId) return "未连接";
      if (state.online === "error") return "连接断开，重连中";
      if (state.online === "connecting") return "连接中";
      if (state.online === "reconnecting") return "恢复身份中";
      return state.role === "host" ? "房间已创建，等待加入" : "已加入";
    }

    /** 刷新展示并通知游戏层。 */
    function updateStatus() {
      if (roomStatus) {
        roomStatus.textContent = statusLabel();
        roomStatus.style.color = state.roomId && state.online === "online" ? "var(--accent)" : "var(--warn)";
      }
      if (roomInput) roomInput.value = state.roomId;
      updateShareLink();
      setButtonsInRoom(Boolean(state.roomId));
      onRoomChange?.({ ...state, members: Object.values(state.members) });
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

    /** 从服务器房间快照刷新成员表。
     * @param {object} roomInfo - room.describe()。
     */
    function syncMembers(roomInfo) {
      if (!roomInfo || !Array.isArray(roomInfo.players)) return;
      state.members = {};
      roomInfo.players.forEach((p) => {
        state.members[p.playerId] = { id: p.playerId, role: p.role, name: p.nickname, connected: p.connected };
      });
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

      // 1. 权威对局快照：交给游戏层渲染。
      if (type === "game.updated") {
        state.online = "online";
        syncMembers(payload.snapshot?.room);
        onGameUpdate?.(payload.snapshot);
        updateStatus();
        return;
      }

      // 2. 成员事件。
      if (type === "room.player_joined" || type === "room.player_reconnected" || type === "room.player_left" || type === "room.player_disconnected") {
        syncMembers(payload.snapshot?.room);
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
     * 注意：页面加载恢复与 onStatus("online") 回调会在同一次连线时各触发一次本函数，
     * 若不去重，第二个 room.reconnect 会因"该连接已在房间"被服务器拒绝，
     * 从而把状态误判成连接错误（表现为刷新后房间一直显示断开）。
     *
     * @param {boolean} silent - 静默模式（页面加载恢复时调用，不额外提示用户）。
     * @returns {Promise<void>} 重连流程结束后 resolve。
     */
    function tryReconnect(silent) {
      // 1. 无房间/无身份时无需恢复。
      if (!state.roomId || !state.playerId) return Promise.resolve();
      // 2. 已有重连在途：复用同一个 Promise，避免并发重复请求。
      if (reconnectInFlight) return reconnectInFlight;
      const saved = JSON.parse(localStorage.getItem(STORAGE_KEY) || "null");
      if (!saved?.reconnectToken) return Promise.resolve();
      reconnectInFlight = doReconnect(saved);
      return reconnectInFlight;
    }

    /**
     * 真正执行一次身份恢复请求。
     *
     * @param {object} saved - localStorage 中的凭据 {reconnectToken, ...}。
     * @returns {Promise<void>} 完成后 resolve；失败时按错误码决定清房或标记错误。
     */
    async function doReconnect(saved) {
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
        syncMembers(res.payload.snapshot?.room);
        if (res.payload.snapshot?.game) onGameUpdate?.(res.payload.snapshot);
        updateStatus();
      } catch (err) {
        if (err?.code === "ROOM_NOT_FOUND" || err?.code === "UNAUTHORIZED_PLAYER") {
          clearRoomState(err.code === "ROOM_NOT_FOUND" ? "房间已过期" : "身份失效，请重新加入");
          return;
        }
        state.online = "error";
        updateStatus();
      } finally {
        // 1. 无论成败都释放在途标记，允许后续（真正的）断线重连再次发起。
        reconnectInFlight = null;
      }
    }

    /** 创建房间（房主执黑先行）。 */
    async function createRoom() {
      state.role = "host";
      state.nickname = nicknameInput?.value.trim() || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
      state.online = "connecting";
      updateStatus();
      try {
        await net.connect();
        const res = await net.request("room.create", { gameType: GAME_TYPE, prefix: "WZ", nickname: state.nickname });
        state.roomId = res.payload.roomId;
        state.playerId = res.payload.playerId;
        state.role = res.payload.role || "host";
        state.online = "online";
        saveCredentials(res.payload.reconnectToken);
        syncMembers(res.payload.snapshot?.room);
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
        syncMembers(res.payload.snapshot?.room);
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
     * 发送对局操作意图（落子/悔棋/认输/重开/再开一把）。
     *
     * @param {string} action - 动作名。
     * @param {object} [params] - 动作参数（如 row/col/approved）。
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
      isHost: () => state.role === "host",
      isGuest: () => state.role === "guest",
      hasRoom: () => Boolean(state.roomId),
      connectionCount: () => Math.max(0, Object.keys(state.members).length - 1),
      isOnline: () => state.online === "online",
      getPlayerId: () => state.playerId,
    };
  };
})();
