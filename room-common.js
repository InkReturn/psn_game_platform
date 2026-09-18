/**
 * LinkPlay 共用联机房间面板（relay 模式，走自建 WebSocket 服务器）。
 *
 * 面向已接入的各小游戏页面：负责创建/加入房间、昵称、邀请链接、成员状态展示，
 * 以及"房主权威快照广播"模型的转发（游戏状态由房主客户端计算，服务器只做
 * 成员管理与消息转发）。对上层暴露的 initRoomPanel 接口与历史版本保持兼容，
 * 因此各游戏 JS 无需修改即可切换传输层。
 */
(function () {
  "use strict";

  const ROOM_VERSION = 3;
  const ROOM_IDLE_TIMEOUT_MS = 15 * 60 * 1000;
  /** 本地保存的房间凭据（playerId + reconnectToken），刷新后用于恢复身份。 */
  const STORAGE_PREFIX = "linkplay-room-";

  /** 生成随机房间码前缀段（服务器才是最终分配者，这里仅备选输入）。
   * @param {string} prefix - 游戏 2 字母前缀。
   * @returns {string} 候选房间码。
   */
  function makeRoomId(prefix) {
    const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
    let code = prefix.toUpperCase().slice(0, 2);
    for (let i = 0; i < 6; i += 1) code += alphabet[Math.floor(Math.random() * alphabet.length)];
    return code;
  }

  /** localStorage 键名。
   * @param {string} gameKey - 游戏标识。
   * @returns {string} 存储键。
   */
  function storageKey(gameKey) {
    return `${STORAGE_PREFIX}${gameKey}-v${ROOM_VERSION}`;
  }

  /** 当前页面查询参数。 */
  function currentParams() {
    return new URLSearchParams(window.location.search);
  }

  /** 深拷贝负载（阻断对象引用共享）。
   * @param {*} value - 任意可 JSON 化的值。
   */
  function safeJson(value) {
    return JSON.parse(JSON.stringify(value));
  }

  /** 规范化房间码输入。
   * @param {string} value - 用户输入。
   * @returns {string} 大写去空白后的房间码。
   */
  function normalizeRoomId(value) {
    return (value || "").trim().toUpperCase();
  }

  window.initRoomPanel = function initRoomPanel({ gameKey, prefix, onRoomChange, onRemoteState, getSnapshot }) {
    const roomStatus = document.querySelector("#roomStatus");
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

    /** 服务器成员快照 → state.members（id/role/name/connected）。 */
    let idleTimer = null;
    /** 进行中的身份恢复请求（并发去重用，避免重复 room.reconnect 被拒后误判连接错误）。 */
    let reconnectInFlight = null;

    const net = window.LinkPlayNet.createNet({
      onEvent: handleServerEvent,
      onStatus(status) {
        // 1. 连接状态直接映射房间在线状态（未进房时忽略）。
        if (!state.roomId) return;
        if (status === "online" && state.online !== "reconnecting") state.online = "online";
        if (status === "connecting") state.online = "connecting";
        if (status === "offline") state.online = "error";
        updateStatus();
        // 2. 断线后恢复的连接需要重新校验身份。
        if (status === "online") tryReconnect();
      },
    });

    /** 清理房间空闲计时器。 */
    function clearIdleTimer() {
      if (idleTimer) {
        clearTimeout(idleTimer);
        idleTimer = null;
      }
    }

    /** 重置 15 分钟空闲自动退出计时。 */
    function touchRoomActivity() {
      clearIdleTimer();
      if (!state.roomId) return;
      idleTimer = setTimeout(async () => {
        if (!state.roomId) return;
        await sendRelay({ event: "idle-leave" });
        net.send("room.leave");
        clearRoomState("房间长时间无操作，已自动退出");
      }, ROOM_IDLE_TIMEOUT_MS);
    }

    /** 保存/清除本地房间凭据（仅身份信息，不含棋盘等游戏状态）。 */
    function save() {
      if (!state.roomId || !state.playerId) {
        localStorage.removeItem(storageKey(gameKey));
        return;
      }
      const creds = JSON.parse(localStorage.getItem(storageKey(gameKey)) || "null");
      localStorage.setItem(
        storageKey(gameKey),
        JSON.stringify({
          roomId: state.roomId,
          role: state.role,
          nickname: state.nickname,
          playerId: state.playerId,
          reconnectToken: creds?.reconnectToken || "",
        }),
      );
    }

    /** 保存服务器下发的凭据（创建/加入/重连成功时调用）。
     * @param {object} payload - 响应负载。
     */
    function storeCredentials(payload) {
      state.playerId = payload.playerId || "";
      const current = JSON.parse(localStorage.getItem(storageKey(gameKey)) || "null");
      localStorage.setItem(
        storageKey(gameKey),
        JSON.stringify({
          roomId: state.roomId,
          role: state.role,
          nickname: state.nickname,
          playerId: payload.playerId || "",
          reconnectToken: payload.reconnectToken || current?.reconnectToken || "",
        }),
      );
    }

    /** 房内按钮显隐控制。
     * @param {boolean} inRoom - 是否在房间内。
     */
    function setButtonsInRoom(inRoom) {
      if (hostBtn) hostBtn.hidden = inRoom;
      if (joinBtn) joinBtn.hidden = inRoom;
      if (leaveBtn) leaveBtn.hidden = !inRoom;
      if (roomInput) roomInput.disabled = inRoom;
      if (nicknameInput) nicknameInput.disabled = inRoom;
    }

    /** 更新邀请链接输入框内容。 */
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

    /** 房间状态文案。 */
    function roomLabel() {
      if (!state.roomId) return "未进入房间";
      if (state.online === "error") return "连接断开，重试中";
      if (state.online === "connecting") return "连接中";
      if (state.online === "reconnecting") return "恢复身份中";
      if (state.online === "online") {
        return state.role === "host" ? `房主 ${connectionCount()} 人` : "已加入";
      }
      return "已进入";
    }

    /** 刷新房间状态展示并通知游戏层。 */
    function updateStatus() {
      if (roomStatus) {
        roomStatus.textContent = roomLabel();
        roomStatus.style.color = state.roomId && state.online === "online" ? "var(--accent)" : "var(--warn)";
      }
      if (roomInput) roomInput.value = state.roomId;
      updateShareLink();
      setButtonsInRoom(Boolean(state.roomId));
      onRoomChange?.({
        ...state,
        members: Object.values(state.members),
      });
      window.dispatchEvent(
        new CustomEvent("linkplay-room-change", {
          detail: { ...state, members: Object.values(state.members) },
        }),
      );
    }

    /**
     * 通过服务器向房内其他玩家转发消息。
     *
     * @param {object} payload - {event, data, targetId?}。
     */
    async function sendRelay(payload) {
      if (!state.roomId || !net.isConnected()) return;
      touchRoomActivity();
      net.send("relay.send", payload);
    }

    /** 房主把自己的最新快照广播出去（供新加入者同步）。 */
    async function publishSnapshot() {
      const snapshot = getSnapshot?.();
      if (!snapshot) return;
      await sendRelay({ event: "state", data: safeJson(snapshot) });
    }

    /** 从服务器房间快照刷新成员表。
     * @param {object} roomInfo - room.describe() 结果。
     */
    function syncMembers(roomInfo) {
      if (!roomInfo || !Array.isArray(roomInfo.players)) return;
      state.members = {};
      roomInfo.players.forEach((p) => {
        state.members[p.playerId] = {
          id: p.playerId,
          role: p.role,
          name: p.nickname,
          connected: p.connected,
        };
      });
    }

    /**
     * 服务器事件统一处理。
     *
     * @param {object} message - 协议信封。
     */
    function handleServerEvent(message) {
      const { type, payload } = message;
      if (state.roomId && payload?.snapshot?.room?.roomId && payload.snapshot.room.roomId !== state.roomId) return;

      // 1. 成员变化事件：刷新成员表并通知游戏层。
      if (type === "room.player_joined" || type === "room.player_reconnected" || type === "room.player_left" || type === "room.player_disconnected") {
        syncMembers(payload.snapshot?.room);
        if (type === "room.player_joined" && state.role === "host") {
          // 1.1 房主向新成员补发快照。
          publishSnapshot();
        }
        if (type === "room.player_left" && payload.playerId === state.playerId) {
          clearRoomState("你已离开房间");
          return;
        }
        updateStatus();
        return;
      }

      // 2. relay 业务消息。
      if (type === "relay.message") {
        if (!payload || payload.senderId === state.playerId) return;
        touchRoomActivity();
        if (payload.event === "state") {
          state.online = "online";
          onRemoteState?.(payload.data);
          updateStatus();
          return;
        }
        if (payload.event === "request-sync") {
          if (state.role === "host") publishSnapshot();
          return;
        }
        if (payload.event === "idle-leave") {
          delete state.members[payload.senderId];
          updateStatus();
        }
        return;
      }
    }

    /**
     * 处理服务端请求级错误（请求 Promise reject 时调用）。
     *
     * @param {{code: string, message: string}} err - 错误对象。
     * @param {string} [fallback] - 兜底文案。
     */
    function handleError(err, fallback) {
      const text = err?.message || fallback || "操作失败";
      state.online = state.roomId ? "error" : "idle";
      updateStatus();
      if (roomStatus) roomStatus.textContent = text;
    }

    /** 清空房间状态（离开/失效时）。
     * @param {string} [message] - 状态栏提示。
     */
    function clearRoomState(message) {
      clearIdleTimer();
      state.roomId = "";
      state.role = "none";
      state.playerId = "";
      state.online = "idle";
      state.members = {};
      localStorage.removeItem(storageKey(gameKey));
      history.replaceState(null, "", window.location.pathname);
      save();
      updateStatus();
      if (message && roomStatus) roomStatus.textContent = message;
    }

    /**
     * 断线恢复：凭本地凭据重新校验身份。
     *
     * 注意：页面加载恢复与 onStatus("online") 回调会在同一次连线时各触发一次本函数，
     * 若不去重，第二个 room.reconnect 会因"该连接已在房间"被服务器拒绝，
     * 从而把状态误判成连接错误（表现为刷新后房间一直显示断开）。
     *
     * @returns {Promise<void>} 恢复流程结束后 resolve。
     */
    function tryReconnect() {
      // 1. 无房间/无身份时无需恢复。
      if (!state.roomId || !state.playerId) return Promise.resolve();
      // 2. 已有恢复在途：复用同一个 Promise。
      if (reconnectInFlight) return reconnectInFlight;
      const saved = JSON.parse(localStorage.getItem(storageKey(gameKey)) || "null");
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
          gameType: `relay:${gameKey}`,
        });
        state.role = res.payload.role || state.role;
        state.online = "online";
        syncMembers(res.payload.snapshot?.room);
        updateStatus();
        await sendRelay({ event: "request-sync" });
      } catch (err) {
        // 1. 房间消失或身份失效：清掉本地凭据回到大厅状态。
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

    /**
     * 创建房间（成为房主）。
     */
    async function createRoom() {
      state.role = "host";
      state.nickname = nicknameInput?.value.trim() || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
      state.online = "connecting";
      updateStatus();
      try {
        await net.connect();
        const res = await net.request("room.create", {
          gameType: `relay:${gameKey}`,
          prefix: makeRoomId(prefix).slice(0, 2),
          nickname: state.nickname,
        });
        state.roomId = res.payload.roomId;
        state.playerId = res.payload.playerId;
        state.role = res.payload.role || "host";
        state.online = "online";
        storeCredentials(res.payload);
        syncMembers(res.payload.snapshot?.room);
        const url = new URL(window.location.href);
        url.searchParams.set("room", state.roomId);
        history.replaceState(null, "", url);
        touchRoomActivity();
        updateStatus();
      } catch (err) {
        handleError(err, "创建房间失败");
      }
    }

    /**
     * 加入房间。
     *
     * @param {string} roomIdInput - 房间码输入。
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
        const res = await net.request("room.join", {
          roomId,
          nickname: state.nickname,
          gameType: `relay:${gameKey}`,
        });
        state.roomId = res.payload.roomId;
        state.playerId = res.payload.playerId;
        state.role = res.payload.role || "guest";
        state.online = "online";
        storeCredentials(res.payload);
        syncMembers(res.payload.snapshot?.room);
        const url = new URL(window.location.href);
        url.searchParams.set("room", state.roomId);
        history.replaceState(null, "", url);
        touchRoomActivity();
        updateStatus();
        await sendRelay({ event: "request-sync" });
      } catch (err) {
        handleError(err, "加入房间失败");
      }
    }

    /**
     * 主动退出房间。
     */
    async function leaveRoom() {
      if (!state.roomId) return;
      try {
        net.send("room.leave");
      } catch {
        /* 离开失败也继续清理本地 */
      }
      clearRoomState();
    }

    /**
     * 游戏层广播接口：把房主计算的快照发给房内其他人。
     *
     * @param {object} payload - 游戏快照。
     */
    function broadcast(payload) {
      if (!state.roomId || state.online !== "online") return;
      sendRelay({ event: "state", data: safeJson(payload) });
    }

    /** 房内其他成员数量。 */
    function connectionCount() {
      return Math.max(0, Object.keys(state.members).length - 1);
    }

    hostBtn?.addEventListener("click", () => createRoom());
    joinBtn?.addEventListener("click", () => joinRoom(roomInput?.value));
    leaveBtn?.addEventListener("click", () => leaveRoom());
    copyBtn?.addEventListener("click", async () => {
      if (shareInput?.value) await navigator.clipboard.writeText(shareInput.value);
    });

    nicknameInput.value = localStorage.getItem("linkplay-name") || `玩家${Math.floor(1000 + Math.random() * 9000)}`;
    nicknameInput.addEventListener("change", () => localStorage.setItem("linkplay-name", nicknameInput.value.trim()));

    // 1. 页面加载：URL 房间码优先，其次本地凭据。
    const roomFromUrl = normalizeRoomId(currentParams().get("room"));
    const saved = JSON.parse(localStorage.getItem(storageKey(gameKey)) || "null");
    if (roomFromUrl) {
      state.roomId = roomFromUrl;
      state.role = saved?.roomId === roomFromUrl ? saved.role : "guest";
      state.nickname = nicknameInput.value.trim();
      state.playerId = saved?.roomId === roomFromUrl ? saved.playerId || "" : "";
      state.online = "connecting";
      updateStatus();
      if (state.playerId && saved?.reconnectToken) {
        net.connect().then(() => tryReconnect());
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
      net.connect().then(() => tryReconnect());
    } else {
      updateStatus();
    }

    return {
      state,
      broadcast,
      leaveRoom,
      isHost: () => state.role === "host",
      isGuest: () => state.role === "guest",
      connectionCount,
      hasRoom: () => Boolean(state.roomId),
      localSeatIndex: () => (state.role === "guest" ? 1 : 0),
      requireHost: () => {
        if (!state.roomId) return "请先创建或加入房间。";
        if (state.role !== "host") return "只有房主可以开始游戏。";
        return "";
      },
    };
  };
})();
