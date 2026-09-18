/**
 * LinkPlay 共享 WebSocket 协议客户端（浏览器端）。
 *
 * 职责：与同源游戏服务器建立 WebSocket 连接、按 v1 协议封装消息、
 * 通过 requestId 关联请求响应、断线自动重连、按 type 分发事件。
 * 被 room-common.js（relay 房间面板）与 gomoku-app.js（权威五子棋）共用。
 */
(function () {
  "use strict";

  /** 错误码 → 中文人话映射（客户端展示用，不暴露技术细节）。 */
  const ERROR_MESSAGES = {
    INVALID_MESSAGE: "消息格式不正确",
    MESSAGE_TOO_LARGE: "发送的内容过大",
    RATE_LIMITED: "操作太频繁了，请稍等一下",
    INVALID_ROOM_ID: "房间码格式不正确",
    INVALID_NICKNAME: "请输入有效的昵称（1-16 个字符）",
    ROOM_NOT_FOUND: "房间不存在或已过期",
    ROOM_FULL: "房间已满员",
    ROOM_TYPE_MISMATCH: "房间类型不匹配，请确认打开的是同一游戏",
    NOT_IN_ROOM: "还没有进入房间",
    ALREADY_IN_ROOM: "已经在房间里了",
    UNAUTHORIZED_PLAYER: "身份校验失败，请重新加入房间",
    INVALID_ACTION: "当前操作不可用",
    GAME_NOT_STARTED: "还没开始对局，等待对手加入",
    NOT_YOUR_TURN: "还没有轮到你落子",
    CELL_OCCUPIED: "这个位置已经有棋子了",
    INVALID_MOVE: "落子位置不合法",
    GAME_ALREADY_FINISHED: "这一局已经结束了",
    INTERNAL_ERROR: "服务器开小差了，请稍后再试",
  };

  /** 错误码转中文文案；未知名回退通用提示。
   * @param {string} code - 服务端错误码。
   * @returns {string} 中文文案。
   */
  function errorText(code) {
    return ERROR_MESSAGES[code] || "操作未通过服务器校验";
  }

  /**
   * 单条 WebSocket 连接封装。
   *
   * @param {object} [options]
   * @param {string} [options.url] - WebSocket 地址；默认按当前页面同源推导 /ws。
   * @param {Function} [options.onEvent] - 事件回调 (message) => void。
   * @param {Function} [options.onStatus] - 连接状态回调 ("connecting"|"online"|"offline")。
   */
  function createNet(options) {
    const opts = options || {};
    /** 推导同源 ws/wss 地址：HTTPS 页面必须走 wss。 */
    const defaultUrl = function () {
      const proto = window.location.protocol === "https:" ? "wss:" : "ws:";
      return `${proto}//${window.location.host}/ws`;
    };
    const targetUrl = opts.url || defaultUrl();

    let ws = null;
    let nextRequestId = 1;
    /** requestId → {resolve, reject, timer} 待响应请求表。 */
    const pending = new Map();
    /** requestId 前缀（会话内唯一）。 */
    const sessionTag = Math.random().toString(36).slice(2, 8);
    let manuallyClosed = false;
    let reconnectDelay = 500;
    let reconnectTimer = null;
    let everConnected = false;

    /** 通知连接状态变化。 */
    function setStatus(status) {
      if (opts.onStatus) opts.onStatus(status);
    }

    /**
     * 分发服务端消息：先匹配 pending 请求，再广播给 onEvent。
     *
     * @param {MessageEvent} event - 原生消息事件。
     */
    function handleMessage(event) {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      if (!message || typeof message.type !== "string") return;
      // 1. 带 requestId 的响应：命中 pending 则 resolve（room.error 走 reject）。
      if (message.requestId && pending.has(message.requestId)) {
        const entry = pending.get(message.requestId);
        pending.delete(message.requestId);
        clearTimeout(entry.timer);
        if (message.type === "room.error") {
          entry.reject({ code: message.payload.code, message: errorText(message.payload.code) });
        } else {
          entry.resolve(message);
        }
      }
      // 2. 所有消息继续广播给业务层。
      if (opts.onEvent) opts.onEvent(message);
    }

    /**
     * 建立连接（幂等：已连接时直接返回）。
     *
     * @returns {Promise<void>} 连接成功 resolve；彻底关闭后 reject。
     */
    function connect() {
      if (ws && (ws.readyState === WebSocket.OPEN || ws.readyState === WebSocket.CONNECTING)) {
        return Promise.resolve();
      }
      manuallyClosed = false;
      setStatus("connecting");
      return new Promise((resolve, reject) => {
        try {
          ws = new WebSocket(targetUrl);
        } catch (err) {
          reject(err);
          return;
        }
        ws.onopen = function () {
          everConnected = true;
          reconnectDelay = 500;
          setStatus("online");
          resolve();
        };
        ws.onmessage = handleMessage;
        ws.onerror = function () {
          /* 由 onclose 统一处理重连 */
        };
        ws.onclose = function () {
          // 1. 清理 pending 请求，避免业务层悬挂。
          for (const [, entry] of pending) {
            clearTimeout(entry.timer);
            entry.reject({ code: "CONNECTION_CLOSED", message: "连接已断开" });
          }
          pending.clear();
          setStatus("offline");
          // 2. 非主动关闭时指数退避重连（上限 10 秒）。
          if (!manuallyClosed) {
            reconnectTimer = setTimeout(connect, reconnectDelay);
            reconnectDelay = Math.min(reconnectDelay * 2, 10000);
          }
        };
      });
    }

    /**
     * 发送一条消息（无需响应）。
     *
     * @param {string} type - 消息类型。
     * @param {object} payload - 消息负载。
     * @param {string} [requestId] - 信封级请求 id（request 场景使用）。
     * @returns {boolean} 是否已发送（连接未 open 时为 false）。
     */
    function send(type, payload, requestId) {
      if (!ws || ws.readyState !== WebSocket.OPEN) return false;
      ws.send(JSON.stringify({ version: 1, type, ...(requestId ? { requestId } : {}), payload: payload || {} }));
      return true;
    }

    /**
     * 发送请求并等待响应（10 秒超时）。
     *
     * @param {string} type - 请求类型（room.create 等）。
     * @param {object} payload - 请求负载。
     * @returns {Promise<object>} 响应消息（含 type/payload）。
     */
    function request(type, payload) {
      const requestId = `${sessionTag}-${nextRequestId++}`;
      return new Promise((resolve, reject) => {
        const timer = setTimeout(() => {
          pending.delete(requestId);
          reject({ code: "TIMEOUT", message: "服务器响应超时，请重试" });
        }, 10000);
        pending.set(requestId, { resolve, reject, timer });
        if (!send(type, payload, requestId)) {
          pending.delete(requestId);
          clearTimeout(timer);
          reject({ code: "NOT_CONNECTED", message: "尚未连接服务器" });
        }
      });
    }

    /** 主动关闭连接（不再重连）。 */
    function close() {
      manuallyClosed = true;
      if (reconnectTimer) clearTimeout(reconnectTimer);
      if (ws) ws.close();
    }

    return {
      connect,
      send,
      request,
      close,
      errorText,
      isConnected: () => ws && ws.readyState === WebSocket.OPEN,
      hasEverConnected: () => everConnected,
    };
  }

  window.LinkPlayNet = { createNet, errorText, ERROR_MESSAGES };
})();
