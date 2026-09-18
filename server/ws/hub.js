/**
 * WebSocket 服务端装配。
 *
 * 负责：连接生命周期、心跳探活、消息大小与频率限制、协议解析与路由分发。
 * 游戏与房间语义全部委托给 RoomManager，本层不持有业务状态。
 */
"use strict";

const { WebSocketServer } = require("ws");
const { makeMessage, parseClientMessage } = require("../protocol/messages");
const { ErrorCodes } = require("../protocol/errors");
const {
  WS_PATH,
  MAX_MESSAGE_BYTES,
  RATE_WINDOW_MS,
  RATE_MAX_MESSAGES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
} = require("../config");

/** 日志输出（可注入）。 */
function defaultLog(...args) {
  console.log("[ws]", ...args);
}

/**
 * 滑动窗口限频器。
 *
 */
class RateLimiter {
  /** @param {number} max - 窗口内允许的最大消息条数。 */
  constructor(max) {
    this.max = max;
    /** @type {number[]} 最近消息时间戳。 */
    this.timestamps = [];
  }

  /**
   * 记录一条消息并判断是否超频。
   *
   * @param {number} now - 当前时间戳（毫秒）。
   * @returns {boolean} true 表示放行，false 表示已超频。
   */
  allow(now) {
    // 1. 淘汰窗口外的旧时间戳。
    while (this.timestamps.length && now - this.timestamps[0] > RATE_WINDOW_MS) {
      this.timestamps.shift();
    }
    // 2. 窗口已满则拒绝。
    if (this.timestamps.length >= this.max) return false;
    this.timestamps.push(now);
    return true;
  }
}

/**
 * 在既有 HTTP 服务器上挂载 WebSocket 服务。
 *
 * @param {import("http").Server} httpServer - HTTP 服务器实例。
 * @param {object} manager - RoomManager 实例。
 * @param {{log?: Function}} [options] - 可注入日志器。
 * @returns {object} { wss, stats } stats 提供 connections 计数。
 */
function createHub(httpServer, manager, options = {}) {
  const log = options.log || defaultLog;
  let connections = 0;

  const wss = new WebSocketServer({
    server: httpServer,
    path: WS_PATH,
    // 1. ws 库自带 payload 上限：超限直接协议层关闭，双保险。
    maxPayload: MAX_MESSAGE_BYTES,
  });

  /**
   * 构造单连接封装（统一 send/close 接口，供房间层使用）。
   *
   * @param {import("ws").WebSocket} ws - 原生 WebSocket。
   * @returns {object} conn 封装。
   */
  function wrapConnection(ws) {
    return {
      /** 连接唯一键（用于与玩家绑定）。 */
      playerKey: `c_${Math.random().toString(36).slice(2)}_${Date.now()}`,
      /** 发送消息（自动序列化，失败静默由 close 兜底）。 */
      send(message) {
        if (ws.readyState === ws.OPEN) {
          ws.send(JSON.stringify(message));
        }
      },
      /** 主动关闭连接。 */
      close(code = 1008) {
        ws.close(code, "policy violation");
      },
    };
  }

  wss.on("connection", (ws, req) => {
    connections += 1;
    const conn = wrapConnection(ws);
    const limiter = new RateLimiter(RATE_MAX_MESSAGES);
    log(`connection open from ${req.socket.remoteAddress} (${connections} online)`);

    // 1. 协议层心跳：收到 pong 即标记存活。
    ws.on("pong", () => {
      ws._connAlive = true;
    });

    ws.on("message", (data, isBinary) => {
      // 1.1 只处理文本消息。
      if (isBinary) {
        conn.send(makeMessage("room.error", { code: ErrorCodes.INVALID_MESSAGE, message: "仅接受文本消息" }, null));
        return;
      }
      // 1.2 大小限制（maxPayload 之外的应用层双保险）。
      const raw = data.toString("utf8");
      if (Buffer.byteLength(raw, "utf8") > MAX_MESSAGE_BYTES) {
        conn.send(makeMessage("room.error", { code: ErrorCodes.MESSAGE_TOO_LARGE, message: "消息过大" }, null));
        conn.close(1009);
        return;
      }
      // 1.3 频率限制。
      if (!limiter.allow(Date.now())) {
        conn.send(makeMessage("room.error", { code: ErrorCodes.RATE_LIMITED, message: "发送过于频繁，请稍后再试" }, null));
        return;
      }
      // 1.4 协议解析。
      const parsed = parseClientMessage(raw);
      if (!parsed.ok) {
        conn.send(makeMessage("room.error", { code: parsed.code, message: "消息格式非法" }, null));
        return;
      }
      try {
        routeMessage(conn, parsed);
      } catch (err) {
        // 1.5 路由过程中的意外异常：记录技术细节，只回通用错误码。
        log(`error handling ${parsed.type}:`, err.message);
        conn.send(makeMessage("room.error", { code: ErrorCodes.INTERNAL_ERROR, message: "服务器内部错误" }, parsed.requestId));
      }
    });

    ws.on("close", () => {
      connections -= 1;
      manager.onDisconnect(conn);
      log(`connection closed (${connections} online)`);
    });

    ws.on("error", (err) => {
      log(`connection error: ${err.message}`);
    });
  });

  /**
   * 消息路由：按 type 分发到房间管理器。
   *
   * @param {object} conn - 连接封装。
   * @param {{type: string, requestId: string|null, payload: object}} parsed - 解析后的消息。
   */
  function routeMessage(conn, parsed) {
    // 1. 心跳直答。
    if (parsed.type === "ping") {
      conn.send(makeMessage("pong", { t: Date.now() }, parsed.requestId));
      return;
    }
    // 2. 房间生命周期。
    if (parsed.type === "room.create") {
      const result = manager.createRoom(conn, parsed.payload, parsed.requestId);
      if (!result.ok) sendError(conn, parsed, result);
      return;
    }
    if (parsed.type === "room.join") {
      const result = manager.joinRoom(conn, parsed.payload, parsed.requestId);
      if (!result.ok) sendError(conn, parsed, result);
      return;
    }
    if (parsed.type === "room.reconnect") {
      const result = manager.reconnect(conn, parsed.payload, parsed.requestId);
      if (!result.ok) sendError(conn, parsed, result);
      return;
    }
    if (parsed.type === "room.leave") {
      manager.leave(conn);
      conn.send(makeMessage("room.left", {}, parsed.requestId));
      return;
    }
    // 3. 游戏动作与 relay 转发。
    if (parsed.type === "game.action") {
      const action = parsed.payload && parsed.payload.action ? parsed.payload : null;
      if (!action) {
        sendError(conn, parsed, { code: ErrorCodes.INVALID_ACTION });
        return;
      }
      const result = manager.handleGameAction(conn, action, parsed.requestId);
      if (!result.ok) sendError(conn, parsed, result);
      return;
    }
    if (parsed.type === "relay.send") {
      const result = manager.handleRelay(conn, parsed.payload);
      if (!result.ok) sendError(conn, parsed, result);
      return;
    }
  }

  /**
   * 统一错误响应。
   *
   * @param {object} conn - 连接封装。
   * @param {{requestId: string|null}} parsed - 原消息。
   * @param {{code: string, detail?: string}} result - 错误结果。
   */
  function sendError(conn, parsed, result) {
    conn.send(
      makeMessage(
        "room.error",
        {
          code: result.code || ErrorCodes.INTERNAL_ERROR,
          message: "请求未通过服务器校验",
          detail: result.detail || "",
        },
        parsed.requestId,
      ),
    );
  }

  // 2. 心跳循环：每次 ping 前检查上次标记；连续一个周期未 pong 即 terminate。
  const heartbeat = setInterval(() => {
    for (const ws of wss.clients) {
      if (ws.readyState !== ws.OPEN) continue;
      if (ws._connAlive === false) {
        ws.terminate();
        continue;
      }
      ws._connAlive = false;
      ws.ping();
    }
  }, HEARTBEAT_INTERVAL_MS);
  if (heartbeat.unref) heartbeat.unref();

  return {
    wss,
    stats: () => ({ connections }),
  };
}

module.exports = { createHub };
