/**
 * 账号 HTTP API 路由（Express）。
 *
 * 挂载在 /api/auth 前缀下，共四个端点：
 * - POST /register  {username, password, nickname?} → 注册并登录；
 * - POST /login     {username, password}            → 登录；
 * - POST /logout    {token} 或 Authorization: Bearer → 吊销会话；
 * - GET  /me        ?token= 或 Authorization: Bearer → 查询当前账号。
 *
 * 响应统一 JSON：成功 {ok:true, ...}，失败 {ok:false, code, message}（code 供
 * 前端与测试断言，message 为可直接展示的中文文案）。
 */
"use strict";

const express = require("express");
const { AuthErrorCodes } = require("./account-store");

/** auth 端错误码 → HTTP 状态码映射。 */
const CODE_TO_STATUS = Object.freeze({
  [AuthErrorCodes.AUTH_USERNAME_INVALID]: 400,
  [AuthErrorCodes.AUTH_PASSWORD_INVALID]: 400,
  [AuthErrorCodes.AUTH_NICKNAME_INVALID]: 400,
  [AuthErrorCodes.AUTH_USERNAME_TAKEN]: 409,
  [AuthErrorCodes.AUTH_INVALID_CREDENTIALS]: 401,
  [AuthErrorCodes.AUTH_INVALID_TOKEN]: 401,
  [AuthErrorCodes.AUTH_STORE_ERROR]: 500,
});

/**
 * 从请求中提取会话令牌：优先 Authorization: Bearer，其次 body/query 的 token 字段。
 *
 * @param {import("express").Request} req - 请求对象。
 * @returns {string} 会话令牌（可能为空串）。
 */
function extractToken(req) {
  // 1. 标准头优先。
  const header = req.headers.authorization || "";
  if (header.startsWith("Bearer ")) return header.slice(7).trim();
  // 2. 兼容 body / query 传 token（GET /me 场景）。
  const fromBody = req.body && typeof req.body.token === "string" ? req.body.token : "";
  const fromQuery = typeof req.query.token === "string" ? req.query.token : "";
  return (fromBody || fromQuery).trim();
}

/**
 * 构造 auth 路由。
 *
 * @param {object} options
 * @param {object} options.store - createAccountStore 返回的存储实例。
 * @param {Function} [options.log] - 日志函数（可注入静音）。
 * @returns {import("express").Router} 已装配的 Express 路由。
 */
function createAuthRouter(options) {
  const store = options.store;
  const router = express.Router();

  /**
   * 发送 auth 失败响应（带对应 HTTP 状态码）。
   *
   * @param {import("express").Response} res - 响应对象。
   * @param {string} code - AuthErrorCodes 错误码。
   * @param {string} message - 中文文案。
   */
  function sendFail(res, code, message) {
    res.status(CODE_TO_STATUS[code] || 400).json({ ok: false, code, message });
  }

  // 1. 注册：校验通过即建档并视为已登录。
  router.post("/register", async (req, res) => {
    const result = await store.register(req.body || {});
    if (!result.ok) {
      sendFail(res, result.code, result.message);
      return;
    }
    res.json({ ok: true, account: result.account, token: result.token });
  });

  // 2. 登录：用户名或密码不正确统一返回同一文案。
  router.post("/login", async (req, res) => {
    const result = await store.login(req.body || {});
    if (!result.ok) {
      sendFail(res, result.code, result.message);
      return;
    }
    res.json({ ok: true, account: result.account, token: result.token });
  });

  // 3. 登出：吊销会话令牌（幂等：无效 token 也返回成功）。
  router.post("/logout", (req, res) => {
    const token = extractToken(req);
    if (token) store.revokeToken(token);
    res.json({ ok: true });
  });

  // 4. 查询当前账号：token 有效返回账号视图。
  router.get("/me", (req, res) => {
    const account = store.verifyToken(extractToken(req));
    if (!account) {
      sendFail(res, AuthErrorCodes.AUTH_INVALID_TOKEN, "登录状态已失效，请重新登录");
      return;
    }
    res.json({ ok: true, account });
  });

  return router;
}

module.exports = { createAuthRouter };
