/**
 * WebSocket 消息协议封装（version 1）。
 *
 * 信封结构：{ version: 1, type: string, requestId?: string, payload?: object }
 * - 客户端请求带 requestId，服务端响应用同一 requestId 关联。
 * - 服务端推送（snapshot / player_joined 等）不带 requestId。
 */
"use strict";

const { ErrorCodes } = require("./errors");

/** 协议版本号。 */
const PROTOCOL_VERSION = 1;

/** 允许客户端发送的消息类型白名单。 */
const CLIENT_MESSAGE_TYPES = new Set([
  "room.create",
  "room.join",
  "room.reconnect",
  "room.leave",
  "game.action",
  "relay.send",
  "ping",
]);

/**
 * 构造服务端出站消息。
 *
 * @param {string} type - 消息类型（如 room.created / game.updated）。
 * @param {object} [payload] - 消息负载，可为空。
 * @param {string} [requestId] - 关联的客户端请求 id；推送消息省略。
 * @returns {object} 完整信封对象（尚未序列化）。
 */
function makeMessage(type, payload = {}, requestId = null) {
  return {
    version: PROTOCOL_VERSION,
    type,
    ...(requestId ? { requestId } : {}),
    payload: payload || {},
  };
}

/**
 * 解析并校验客户端入站消息。
 *
 * @param {string} raw - 客户端发来的原始文本。
 * @returns {{ ok: true, type: string, requestId: string|null, payload: object }} 解析结果。
 * @returns {{ ok: false, code: string, detail: string }} 校验失败时的错误描述。
 */
function parseClientMessage(raw) {
  // 1. JSON 解析失败视为非法消息。
  let data;
  try {
    data = JSON.parse(raw);
  } catch {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: "not valid JSON" };
  }
  // 2. 必须是对象且带合法 type。
  if (!data || typeof data !== "object" || Array.isArray(data)) {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: "message must be an object" };
  }
  if (typeof data.type !== "string" || !data.type) {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: "missing type" };
  }
  // 3. 类型必须在白名单内。
  if (!CLIENT_MESSAGE_TYPES.has(data.type)) {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: `unknown type ${data.type}` };
  }
  // 4. payload 必须是对象（允许缺省）。
  if (data.payload !== undefined && (data.payload === null || typeof data.payload !== "object" || Array.isArray(data.payload))) {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: "payload must be an object" };
  }
  // 5. requestId 可选，但出现时必须是短字符串。
  if (data.requestId !== undefined && data.requestId !== null && (typeof data.requestId !== "string" || data.requestId.length > 64)) {
    return { ok: false, code: ErrorCodes.INVALID_MESSAGE, detail: "invalid requestId" };
  }
  return {
    ok: true,
    type: data.type,
    requestId: typeof data.requestId === "string" ? data.requestId : null,
    payload: data.payload || {},
  };
}

module.exports = { PROTOCOL_VERSION, CLIENT_MESSAGE_TYPES, makeMessage, parseClientMessage };
