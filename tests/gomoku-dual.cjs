/**
 * 五子棋双端联机验收测试（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 场景覆盖：
 *   A. 房主创建房间（服务器分配房间码并执黑）
 *   B. 访客打开邀请链接加入（执白）
 *   C. 双方轮流落子，两个浏览器看到完全一致的状态
 *   D. 非轮次玩家越权落子被服务器拒绝，棋盘不变
 *   E. 重复点击已占位置不产生重复棋子
 *   F. 访客刷新页面后凭本地凭据恢复身份与棋盘
 *   G. 下到五连，双方得到相同的胜负与战绩
 *
 * 同时断言：整场对局中两个页面只访问本源域名的资源，无 PeerJS / Supabase / WebRTC 外连。
 *
 * 运行方式：node tests/gomoku-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18082 端口拉起被测服务器；
 *   - 设置了 BASE_URL（例如 tests/run-all.cjs 注入）时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18082;
/** 外部注入的站点地址（为空则自拉服务器）。 */
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
/** 期望的 WebSocket 端点（自建服务器固定 /ws；HTTPS 页面走 wss）。 */
const WS_SCHEME = BASE_URL.startsWith("https") ? "wss" : "ws";
const EXPECTED_WS = `${WS_SCHEME}://${BASE_URL.replace(/^https?:\/\//, "")}/ws`;

/** 用例结果收集。 */
const results = [];
/** 被测服务器进程（自拉时才有）。 */
let serverProcess = null;
/** 被测服务器输出缓冲（失败时打印）。 */
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
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
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
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 断言深度相等（JSON 比较，够用且报错可读）。
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
 * 轮询 /health 等待服务器就绪（不能用固定 sleep，冷启动耗时不确定）。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early (code ${serverProcess.exitCode})\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${timeoutMs}ms\n${serverLogs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 读取页面导出的权威状态。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @returns {Promise<object>} render_game_to_text() 解析后的对象。
 */
async function readState(page) {
  return JSON.parse(await page.evaluate(() => window.render_game_to_text()));
}

/**
 * 等待页面进入"已连接服务器且在房间内"状态。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} [timeoutMs] - 超时毫秒。
 */
async function waitOnline(page, timeoutMs = 20000) {
  await page.waitForFunction(
    () => {
      const s = JSON.parse(window.render_game_to_text());
      return s.mode === "online" && Boolean(s.roomId) && s.serverConnected === true;
    },
    null,
    { timeout: timeoutMs },
  );
}

/**
 * 等待页面棋子数达到期望值。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} count - 期望的落子总数。
 * @param {number} [timeoutMs] - 超时毫秒。
 */
async function waitMoves(page, count, timeoutMs = 10000) {
  await page.waitForFunction(
    (expected) => JSON.parse(window.render_game_to_text()).moves.length === expected,
    count,
    { timeout: timeoutMs },
  );
}

/**
 * 在棋盘上点击指定交叉点。
 *
 * 几何反解与 gomoku-app.js 的 canvasPoint/pointToCell 对齐：先取画布 CSS 尺寸与内部分辨率，
 * 再把"内部分辨率下的交叉点坐标"换算回视口坐标。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} row - 行号（0 起，从上往下）。
 * @param {number} col - 列号（0 起，从左往右）。
 */
async function clickCell(page, row, col) {
  const metric = await page.evaluate(() => {
    const canvas = document.querySelector("#boardCanvas");
    const rect = canvas.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, left: rect.left, top: rect.top, cssWidth: rect.width, cssHeight: rect.height };
  });
  const pad = 42;
  const gap = (metric.width - pad * 2) / 14;
  const x = metric.left + ((pad + col * gap) * metric.cssWidth) / metric.width;
  const y = metric.top + ((pad + row * gap) * metric.cssHeight) / metric.height;
  await page.mouse.click(x, y);
  await page.waitForTimeout(80);
}

/**
 * 向服务器直接发送一次 game.action（绕过客户端 canPlay 本地拦截）。
 *
 * 用于验证服务端的越权校验，而不是仅验证前端按钮禁用。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {string} action - 动作名（move/undo_request/...）。
 * @param {object} [params] - 动作参数。
 * @returns {Promise<{ok: boolean, code?: string, message?: string}>} 结果；被拒时带服务端错误码。
 */
async function sendActionRaw(page, action, params) {
  return page.evaluate(
    ([act, extra]) =>
      roomApi
        .sendAction(act, extra)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, code: err && err.code, message: err && err.message })),
    [action, params || {}],
  );
}

/**
 * 比较两个页面在同一时刻的权威对局状态是否一致。
 *
 * @param {object} a - 房主状态。
 * @param {object} b - 访客状态。
 * @returns {{equal: boolean, diff: string}} 比较结果与差异描述。
 */
function gameStateDiff(a, b) {
  const pick = (s) => ({
    moves: s.moves.map((m) => `${m.row},${m.col},${m.color}`),
    turn: s.turn,
    winner: s.winner,
    record: s.record,
    players: s.players,
    modalOpen: s.modalOpen,
  });
  const left = JSON.stringify(pick(a));
  const right = JSON.stringify(pick(b));
  return { equal: left === right, diff: left === right ? "" : `host=${left} guest=${right}` };
}

(async () => {
  fs.mkdirSync("outputs", { recursive: true });

  // 1. 未注入 BASE_URL 时自行拉起被测服务器。
  if (!EXTERNAL_BASE) {
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(SELF_PORT), BIND_HOST: "127.0.0.1" },
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

  // 2. 两个独立上下文：localStorage 完全隔离，等价于两台设备/两个浏览器。
  const browser = await chromium.launch({ headless: true });
  const contextA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const contextB = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await contextA.addInitScript(() => {
    try {
      localStorage.setItem("linkplay-name", "房主甲");
    } catch {
      /* 隐私模式下忽略 */
    }
  });
  await contextB.addInitScript(() => {
    try {
      localStorage.setItem("linkplay-name", "玩家乙");
    } catch {
      /* 隐私模式下忽略 */
    }
  });

  const hostPage = await contextA.newPage();
  const guestPage = await contextB.newPage();

  // 3. 网络观测：记录两个页面的全部请求与 WebSocket，供"仅本源域名"断言使用。
  const requests = [];
  const sockets = [];
  const consoleErrors = [];
  for (const [label, page] of [["host", hostPage], ["guest", guestPage]]) {
    page.on("request", (req) => requests.push({ page: label, url: req.url() }));
    page.on("websocket", (ws) => sockets.push({ page: label, url: ws.url() }));
    page.on("console", (msg) => {
      if (msg.type() === "error") consoleErrors.push(`[${label}] ${msg.text()}`);
    });
    page.on("pageerror", (err) => consoleErrors.push(`[${label}] ${err.message}`));
  }

  // ── 场景 A：房主创建房间 ─────────────────────────────────────
  let hostState = null;
  let roomId = "";
  let inviteUrl = "";
  await check("A. 房主点击创建房间并拿到服务器房间码", async () => {
    await hostPage.goto(`${BASE_URL}/gomoku.html`, { waitUntil: "networkidle" });
    await hostPage.click("#hostBtn");
    await waitOnline(hostPage);
    hostState = await readState(hostPage);
    roomId = hostState.roomId;
    assert(/^WZ[A-Z0-9]{6}$/.test(roomId), `房间码格式应为 WZ+6 位，实际 ${roomId}`);
    assertEq(hostState.role, "black", "房主应执黑");
    assertEq(hostState.players.black, "房主甲", "黑方昵称");
    assertEq(hostState.players.white, "等待", "白方尚未加入");
    assertEq(hostState.transportKind, "server-ws", "传输层应为自建 WebSocket");
    inviteUrl = await hostPage.inputValue("#shareInput");
    assert(inviteUrl.includes(`room=${roomId}`), `邀请链接应带房间码，实际 ${inviteUrl}`);
    // 房间创建后房主控件切换为"房内"状态。
    assert(await hostPage.locator("#leaveRoomBtn").isVisible(), "进入房间后应显示退出按钮");
  });

  // ── 场景 B：访客打开邀请链接加入 ─────────────────────────────
  let guestState = null;
  await check("B. 访客打开邀请链接加入并执白", async () => {
    await guestPage.goto(inviteUrl, { waitUntil: "networkidle" });
    await waitOnline(guestPage);
    guestState = await readState(guestPage);
    assertEq(guestState.roomId, roomId, "访客应进入同一房间");
    assertEq(guestState.role, "white", "访客应执白");
    assertEq(guestState.players.white, "玩家乙", "白方昵称");
    assertEq(guestState.players.black, "房主甲", "访客应看到房主昵称");
    // 房主侧应收到加入事件并把白方名字刷新出来。
    await hostPage.waitForFunction(
      () => JSON.parse(window.render_game_to_text()).players.white === "玩家乙",
      null,
      { timeout: 10000 },
    );
    const diff = gameStateDiff(await readState(hostPage), guestState);
    assert(diff.equal, `加入后双方初始状态应一致：${diff.diff}`);
  });

  // ── 场景 D（前置）：访客越权落子 ─────────────────────────────
  await check("D. 非轮次玩家（白）越权落子被服务器拒绝，棋盘不变", async () => {
    // D1. 协议层：绕过前端拦截，直接发 move，服务端必须拒绝。
    const denied = await sendActionRaw(guestPage, "move", { row: 0, col: 0 });
    assertEq(denied.ok, false, "服务端应拒绝越权落子");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    // D2. UI 层：点击棋盘也不应产生任何棋子。
    await clickCell(guestPage, 0, 0);
    await guestPage.waitForTimeout(300);
    guestState = await readState(guestPage);
    assertEq(guestState.moves.length, 0, "越权点击后访客棋盘应仍为空");
    assertEq((await readState(hostPage)).moves.length, 0, "越权点击不应影响房主棋盘");
  });

  // ── 场景 C：双方轮流落子并保持一致 ───────────────────────────
  await check("C. 双方轮流落子，两个浏览器状态一致", async () => {
    // C1. 房主（黑）落 (7,7)。
    await clickCell(hostPage, 7, 7);
    await Promise.all([waitMoves(hostPage, 1), waitMoves(guestPage, 1)]);
    let diff = gameStateDiff(await readState(hostPage), await readState(guestPage));
    assert(diff.equal, `第 1 手后双方状态应一致：${diff.diff}`);
    assertEq((await readState(hostPage)).turn, "白棋", "第 1 手后轮到白棋");

    // C2. 访客（白）落 (8,8)。
    await clickCell(guestPage, 8, 8);
    await Promise.all([waitMoves(hostPage, 2), waitMoves(guestPage, 2)]);
    diff = gameStateDiff(await readState(hostPage), await readState(guestPage));
    assert(diff.equal, `第 2 手后双方状态应一致：${diff.diff}`);
    const both = await readState(hostPage);
    assertEq(both.turn, "黑棋", "第 2 手后轮到黑棋");
    assertEq(both.moves[0].point, "H8", "第 1 手坐标");
    assertEq(both.moves[1].point, "I9", "第 2 手坐标");
  });

  // ── 场景 E：重复点击已占位置 ─────────────────────────────────
  await check("E. 重复点击已占位置不产生重复棋子", async () => {
    // E1. 协议层：轮到黑棋时，黑棋再下自己的 (7,7)。
    const denied = await sendActionRaw(hostPage, "move", { row: 7, col: 7 });
    assertEq(denied.ok, false, "服务端应拒绝重复落子");
    assertEq(denied.code, "CELL_OCCUPIED", "错误码");
    // E2. UI 层：点击同一交叉点。
    await clickCell(hostPage, 7, 7);
    await hostPage.waitForTimeout(300);
    const after = await readState(hostPage);
    assertEq(after.moves.length, 2, "重复点击后落子数应保持 2");
    assertEq(after.moves.filter((m) => m.point === "H8").length, 1, "H8 只应有一颗棋子");
    assertEq((await readState(guestPage)).moves.length, 2, "访客侧同样保持 2 手");
  });

  // ── 场景 F：访客刷新后恢复身份与棋盘 ─────────────────────────
  await check("F. 访客刷新页面后凭据恢复身份与棋盘", async () => {
    const before = await readState(guestPage);
    await guestPage.reload({ waitUntil: "networkidle" });
    await waitOnline(guestPage);
    await waitMoves(guestPage, 2);
    const after = await readState(guestPage);
    assertEq(after.roomId, before.roomId, "刷新后房间码不变");
    assertEq(after.playerId, before.playerId, "刷新后 playerId 不变（凭据恢复身份）");
    assertEq(after.role, "white", "刷新后仍执白");
    assertEq(after.moves.map((m) => `${m.row},${m.col}`), before.moves.map((m) => `${m.row},${m.col}`), "刷新后棋盘一致");
    const diff = gameStateDiff(after, await readState(hostPage));
    assert(diff.equal, `刷新后与房主状态应一致：${diff.diff}`);
  });

  // ── 场景 G：下到五连，双方胜负与战绩一致 ─────────────────────
  await check("G. 黑棋五连，双方得到相同胜负与战绩", async () => {
    // G1. 黑（7,7）已有，补 (7,3)(7,4)(7,5)(7,6)；白在 8 行错开补子避免自己先连五。
    const sequence = [
      ["host", 7, 3],
      ["guest", 8, 9],
      ["host", 7, 4],
      ["guest", 8, 10],
      ["host", 7, 5],
      ["guest", 8, 11],
      ["host", 7, 6],
    ];
    let expected = 2;
    for (const [who, row, col] of sequence) {
      await clickCell(who === "host" ? hostPage : guestPage, row, col);
      expected += 1;
      await Promise.all([waitMoves(hostPage, expected), waitMoves(guestPage, expected)]);
    }
    await hostPage.locator("#resultModal").waitFor({ state: "visible", timeout: 10000 });
    await guestPage.locator("#resultModal").waitFor({ state: "visible", timeout: 10000 });

    const host = await readState(hostPage);
    const guest = await readState(guestPage);
    // G2. 胜负一致。
    assertEq(host.winner, "黑棋", "房主侧胜方");
    assertEq(guest.winner, "黑棋", "访客侧胜方");
    assertEq(host.modalOpen, true, "房主侧结算弹窗");
    assertEq(guest.modalOpen, true, "访客侧结算弹窗");
    // G3. 战绩一致（都记到黑方昵称名下）。
    assertEq(host.record.total, 1, "房主侧总局数");
    assertEq(guest.record.total, 1, "访客侧总局数");
    assertEq(host.record.players["房主甲"], 1, "房主侧胜场");
    assertEq(guest.record.players["房主甲"], 1, "访客侧胜场");
    // G4. 落子列表逐手一致。
    const diff = gameStateDiff(host, guest);
    assert(diff.equal, `终局双方状态应一致：${diff.diff}`);
    assertEq(host.moves.length, 9, "终局总手数");

    await hostPage.screenshot({ path: "outputs/gomoku-dual-host.png", fullPage: true });
    await guestPage.screenshot({ path: "outputs/gomoku-dual-guest.png", fullPage: true });
  });

  // ── 网络外连断言 ─────────────────────────────────────────────
  await check("H. 全程只访问本源域名，无 PeerJS/Supabase/WebRTC 外连", async () => {
    const forbidden = ["peerjs.com", "supabase.co", "webrtc", "stun:", "turn:", "0.peerjs"];
    const httpRequests = requests.filter((r) => /^https?:/i.test(r.url));
    // 1. 所有 HTTP 请求必须同源。
    const offOrigin = httpRequests.filter((r) => !r.url.startsWith(BASE_URL));
    assertEq(offOrigin.map((r) => r.url), [], "存在非同源 HTTP 请求");
    // 2. 任何请求地址都不得命中禁用关键字。
    const hits = requests.filter((r) => forbidden.some((word) => r.url.toLowerCase().includes(word)));
    assertEq(hits.map((r) => r.url), [], "存在 PeerJS/Supabase/WebRTC 相关请求");
    // 3. WebSocket 只连自建 /ws 端点。
    assert(sockets.length >= 2, `应至少观测到两个 WebSocket 连接，实际 ${sockets.length}`);
    const badSockets = sockets.filter((s) => !s.url.startsWith(EXPECTED_WS));
    assertEq(badSockets.map((s) => s.url), [], "存在非自建 WebSocket 连接");
    // 4. 页面无脚本错误。
    assertEq(consoleErrors, [], "页面存在 console error / pageerror");
  });

  // ── 收尾 ─────────────────────────────────────────────────────
  await browser.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  console.log(
    JSON.stringify(
      {
        baseUrl: BASE_URL,
        roomId,
        requests: requests.map((r) => r.url),
        sockets: sockets.map((s) => s.url),
        consoleErrors,
      },
      null,
      2,
    ),
  );
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("dual-client bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
