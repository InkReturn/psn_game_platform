/**
 * 账号 HTTP API 冒烟测试（无需浏览器）。
 *
 * 覆盖 /api/auth 四个端点的正常与异常路径：
 * 注册（重复用户名/非法用户名/短密码）、登录（大小写不敏感/错密码）、
 * me（有效/无效/被顶替令牌）、logout（吊销后令牌失效、再次登录换新令牌）。
 *
 * 运行方式：node tests/auth-smoke.cjs（未设置 BASE_URL 时自行拉起隔离服务器）。
 * 复用 run-all 的共享服务器时通过随机用户名避免撞库。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");

/** 自拉服务器端口与地址。 */
const SELF_PORT = 18201;
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
/** 自拉时的独立账号文件（不污染开发库）。 */
const TMP_AUTH_FILE = path.join(__dirname, `.tmp-auth-self-${SELF_PORT}.json`);

/** 测试结果收集。 */
const results = [];
let serverProcess = null;
const serverLogs = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  console.log(`${pass ? "PASS" : "fail"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
}

/**
 * 断言辅助。
 *
 * @param {*} actual - 实际值。
 * @param {*} expected - 期望值。
 * @param {string} label - 描述。
 */
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 执行一段用例并记录结果（失败不中断后续用例）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 异步用例体。
 */
async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

/**
 * 调用 auth API 并返回 {status, body}。
 *
 * @param {string} apiPath - 端点路径（如 /api/auth/login）。
 * @param {object} [body] - JSON 请求体；GET 时省略。
 * @param {{method?: string, token?: string}} [options] - 请求方法与令牌。
 * @returns {Promise<{status: number, body: object}>} 响应状态与解析后的 JSON。
 */
async function callAuth(apiPath, body, options = {}) {
  const headers = { "Content-Type": "application/json" };
  if (options.token) headers.Authorization = `Bearer ${options.token}`;
  const res = await fetch(`${BASE_URL}${apiPath}`, {
    method: options.method || "POST",
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  let parsed = null;
  try {
    parsed = await res.json();
  } catch {
    parsed = null;
  }
  return { status: res.status, body: parsed };
}

/**
 * 轮询 /health 等待服务器就绪。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early with code ${serverProcess.exitCode}\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/** 测试主流程。
 * @returns {Promise<void>} 全部用例执行完 resolve。
 */
async function main() {
  // 1. 未注入 BASE_URL 时自行拉起隔离服务器（独立账号文件）。
  if (!EXTERNAL_BASE) {
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(SELF_PORT), BIND_HOST: "127.0.0.1", LINKPLAY_AUTH_FILE: TMP_AUTH_FILE },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => {
      serverLogs.push(chunk.toString());
      if (serverLogs.length > 200) serverLogs.shift();
    };
    serverProcess.stdout.on("data", collect);
    serverProcess.stderr.on("data", collect);
  }
  await waitForServer();

  // 2. 每次运行使用随机用户名，避免共享服务器上撞已有账号（总长控制在 16 字符内）。
  const stamp = `${Date.now().toString(36).slice(-4)}${Math.random().toString(36).slice(2, 6)}`;
  const username = `t${stamp}`;
  const password = "secret123";
  let registerToken = "";
  let loginToken = "";

  // 2.1 注册成功。
  await check("注册成功并返回账号视图与令牌", async () => {
    const { status, body } = await callAuth("/api/auth/register", {
      username,
      password,
      nickname: "测试玩家",
    });
    assertEq(status, 200, "注册 HTTP 状态");
    assert(body.ok === true, "注册应返回 ok:true");
    assertEq(body.account.username, username, "注册返回用户名");
    assertEq(body.account.nickname, "测试玩家", "注册返回昵称");
    assert(!body.account.passwordHash, "注册视图不得包含密码哈希");
    assert(!body.account.token, "注册视图不得包含令牌");
    assert(typeof body.token === "string" && body.token.length >= 32, "注册应签发令牌");
    registerToken = body.token;
  });

  // 2.2 重复用户名被拒（409）。
  await check("重复用户名注册返回 409 与 AUTH_USERNAME_TAKEN", async () => {
    const { status, body } = await callAuth("/api/auth/register", { username, password: "another456" });
    assertEq(status, 409, "重复注册 HTTP 状态");
    assertEq(body.code, "AUTH_USERNAME_TAKEN", "重复注册错误码");
    assert(typeof body.message === "string" && body.message.length > 0, "错误文案非空");
  });

  // 2.3 非法用户名 / 短密码。
  await check("非法用户名与短密码返回 400", async () => {
    const badName = await callAuth("/api/auth/register", { username: "a", password });
    assertEq(badName.status, 400, "非法用户名 HTTP 状态");
    assertEq(badName.body.code, "AUTH_USERNAME_INVALID", "非法用户名错误码");
    const badPwd = await callAuth("/api/auth/register", { username: `u${stamp}`, password: "123" });
    assertEq(badPwd.status, 400, "短密码 HTTP 状态");
    assertEq(badPwd.body.code, "AUTH_PASSWORD_INVALID", "短密码错误码");
  });

  // 2.4 登录成功：用户名大小写不敏感，签发新令牌并顶替注册令牌。
  await check("登录成功（用户名大小写不敏感）并顶替旧令牌", async () => {
    const { status, body } = await callAuth("/api/auth/login", {
      username: username.toUpperCase(),
      password,
    });
    assertEq(status, 200, "登录 HTTP 状态");
    assert(body.ok === true, "登录应返回 ok:true");
    assertEq(body.account.nickname, "测试玩家", "登录返回昵称");
    assert(body.token && body.token !== registerToken, "登录应签发新令牌");
    loginToken = body.token;
  });

  // 2.5 错密码被拒（401，与用户名不存在同文案）。
  await check("错误密码登录返回 401 与 AUTH_INVALID_CREDENTIALS", async () => {
    const { status, body } = await callAuth("/api/auth/login", { username, password: "wrong999" });
    assertEq(status, 401, "错密码 HTTP 状态");
    assertEq(body.code, "AUTH_INVALID_CREDENTIALS", "错密码错误码");
  });

  // 2.6 me：新令牌有效、被顶替的注册令牌失效、坏令牌失效、无令牌 401。
  await check("me 端点：有效/被顶替/伪造/缺失令牌四种行为", async () => {
    const okMe = await callAuth("/api/auth/me", undefined, { method: "GET", token: loginToken });
    assertEq(okMe.status, 200, "有效令牌 me 状态");
    assertEq(okMe.body.account.username, username, "me 返回用户名");
    const replaced = await callAuth("/api/auth/me", undefined, { method: "GET", token: registerToken });
    assertEq(replaced.status, 401, "被顶替令牌 me 状态");
    const forged = await callAuth("/api/auth/me", undefined, { method: "GET", token: "f".repeat(64) });
    assertEq(forged.status, 401, "伪造令牌 me 状态");
    const queryMe = await fetch(`${BASE_URL}/api/auth/me?token=${loginToken}`);
    assertEq(queryMe.status, 200, "query 令牌 me 状态");
    const none = await fetch(`${BASE_URL}/api/auth/me`);
    assertEq(none.status, 401, "无令牌 me 状态");
  });

  // 2.7 logout：吊销当前令牌后 me 401；再次登录换新令牌。
  await check("logout 吊销令牌后可再次登录", async () => {
    const out = await callAuth("/api/auth/logout", {}, { token: loginToken });
    assertEq(out.status, 200, "logout HTTP 状态");
    assertEq(out.body.ok, true, "logout 返回 ok");
    const after = await callAuth("/api/auth/me", undefined, { method: "GET", token: loginToken });
    assertEq(after.status, 401, "吊销后 me 状态");
    const relogin = await callAuth("/api/auth/login", { username, password });
    assertEq(relogin.status, 200, "再次登录状态");
    assert(relogin.body.token && relogin.body.token !== loginToken, "再次登录签发新令牌");
    const reMe = await callAuth("/api/auth/me", undefined, { method: "GET", token: relogin.body.token });
    assertEq(reMe.status, 200, "新令牌 me 状态");
  });

  // 3. 收尾：释放自拉服务器与临时账号文件。
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }
  for (const file of [TMP_AUTH_FILE, `${TMP_AUTH_FILE}.tmp-*`]) {
    try {
      fs.rmSync(path.join(__dirname, path.basename(file)), { force: true });
    } catch {
      /* 清理失败不影响结果 */
    }
  }

  // 4. 汇总退出码。
  const failed = results.filter((r) => !r.pass);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("auth smoke failed:", err);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
