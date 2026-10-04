"use strict";
const http = require("node:http");

/**
 * 读取固定回环服务的 JSON，使用原生 HTTP 避免环境代理劫持本机健康检查。
 * @param {number} port 已知本地服务端口，不接受用户输入。
 * @param {string} pathname 固定只读接口路径，默认 /health。
 * @returns {Promise<Object>} 包含 statusCode 和 JSON body 的健康响应。
 * @throws {Error} 连接、超时、过大响应或 JSON 格式异常。
 */
function readLocalJson(port, pathname = "/health") {
  // 1. Promise 只负责一个回环连接，不经过 HTTP_PROXY 或 ALL_PROXY。
  return new Promise(executeRequest.bind(null, port, pathname));
}

/**
 * 建立有界回环请求。
 * @param {number} port 本机服务端口。
 * @param {string} pathname 只读接口路径。
 * @param {Function} resolve 成功回调。
 * @param {Function} reject 失败回调。
 */
function executeRequest(port, pathname, resolve, reject) {
  // 1. 限制连接超时及响应大小，不读取无限日志或 HTML 页面。
  const state = { resolve, reject, text: "", size: 0 };
  const request = http.get({ hostname: "127.0.0.1", port, path: pathname, agent: false },  readResponse.bind(null, state));
  state.request = request;
  request.setTimeout(1500, timedOut.bind(null, request));
  request.on("error", reject);
}

/**
 * 将 HTTP 超时转成可定位的连接错误。
 * @param {import('node:http').ClientRequest} request 超时的请求。
 */
function timedOut(request) {
  // 1. 终止超时请求，释放 socket。
  const error = new Error("本机服务健康检查超时");
  error.code = "ETIMEDOUT";
  request.destroy(error);
}

/**
 * 登记响应读取和完成事件。
 * @param {Object} state 当前请求的有界响应缓冲与回调。
 * @param {import('node:http').IncomingMessage} response HTTP 响应流。
 */
function readResponse(state, response) {
  // 1. 只收集小型 JSON 响应，关闭错误完整传播。
  state.statusCode = response.statusCode;
  response.setEncoding("utf8");
  response.on("data", collect.bind(null, state));
  response.on("end", complete.bind(null, state));
  response.on("error", state.reject);
}

/**
 * 收集至多 16KB 响应，超限直接关闭请求。
 * @param {Object} state 当前请求缓冲。
 * @param {string} chunk 解码后的响应片段。
 */
function collect(state, chunk) {
  // 1. 限制累计大小，避免状态检查被错误服务拖垮。
  state.size += Buffer.byteLength(chunk);
  if (state.size > 16384) return state.request.destroy(new Error("本机健康响应超过 16KB"));
  state.text += chunk;
}

/**
 * 解析服务返回的 JSON，并保留 HTTP 状态码。
 * @param {Object} state 完整响应和 Promise 回调。
 */
function complete(state) {
  // 1. 非 JSON 响应不冒充服务成功，交给调用方明确处理。
  try { state.resolve({ statusCode: state.statusCode, body: JSON.parse(state.text) }); }
  catch (error) { state.reject(error); }
}
module.exports = { readLocalJson };
