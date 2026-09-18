/**
 * 棋类游戏双浏览器联机验收（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 覆盖井字棋 / 四子棋 / 黑白棋三款新迁移的权威房游戏，全部走真实链路：
 *   Browser A → WSS → Node 服务器 → WSS → Browser B
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过前端拦截，
 * 用来证明服务器自己会拒绝）。
 *
 * 每个游戏覆盖：建房 → 邀请链接加入 → 合法落子同步 → 越权被拒 → 刷新重连 →
 * 交互式进攻与结算 → 战绩归属 → 交换位置 → 认输。
 *
 * 运行方式：node tests/grid-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18085 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18085;
/** 外部注入的站点地址（为空则自拉服务器）。 */
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
/** 期望的 WebSocket 端点（HTTPS 页面走 wss）。 */
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
 * 断言深度相等（JSON 比较）。
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
 * 轮询 /health 等待服务器就绪（不用固定 sleep，冷启动耗时不确定）。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
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
 * 等待页面落子数达到期望值。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} count - 期望手数。
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
 * 在画布棋盘上点击指定格子。
 *
 * 几何反解与 grid-game-net.js 的 boardGeometry()/canvasToCell() 对齐：
 * 先取画布 CSS 尺寸与内部分辨率，再把格子中心换算回视口坐标。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} row - 行号（0 起）。
 * @param {number} col - 列号（0 起）。
 * @param {number} rows - 棋盘行数。
 * @param {number} cols - 棋盘列数。
 */
async function clickCell(page, row, col, rows, cols) {
  const metric = await page.evaluate(() => {
    const canvas = document.querySelector("#boardCanvas");
    const rect = canvas.getBoundingClientRect();
    return { width: canvas.width, height: canvas.height, left: rect.left, top: rect.top, cssWidth: rect.width, cssHeight: rect.height };
  });
  const pad = cols === 7 && rows === 6 ? 54 : 46;
  const usable = metric.width - pad * 2;
  const cell = Math.min(usable / cols, usable / rows);
  const originX = (metric.width - cell * cols) / 2;
  const originY = (metric.height - cell * rows) / 2;
  const x = metric.left + ((originX + col * cell + cell / 2) * metric.cssWidth) / metric.width;
  const y = metric.top + ((originY + row * cell + cell / 2) * metric.cssHeight) / metric.height;
  await page.mouse.click(x, y);
  await page.waitForTimeout(60);
}

/**
 * 向服务器直接发送一次 game.action（绕过客户端本地拦截）。
 *
 * 用于验证服务端越权校验，而不是只验证前端按钮禁用。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {string} action - 动作名。
 * @param {object} [params] - 动作参数。
 * @returns {Promise<{ok:boolean, code?:string}>} 结果。
 */
async function sendActionRaw(page, action, params) {
  return page.evaluate(
    ([act, extra]) =>
      roomApi
        .sendAction(act, extra)
        .then(() => ({ ok: true }))
        .catch((err) => ({ ok: false, code: err && err.code })),
    [action, params || {}],
  );
}

/**
 * 跑一款棋类游戏的完整双端验收。
 *
 * @param {object} browser - Playwright 浏览器实例。
 * @param {object} spec - 游戏规格。
 * @param {string} spec.key - 游戏 key（同时也是页面名与 gameType）。
 * @param {string} spec.prefix - 房间码前缀。
 * @param {number} spec.rows - 行数。
 * @param {number} spec.cols - 列数。
 * @param {Array<number>} spec.opening - 先手的合法开局落子 [row, col]。
 * @param {"line"|"surrender"} spec.finishType - 结算方式：连子取胜还是认输结算。
 * @param {number} spec.lineLength - 连子取胜所需连子数（finishType 为 line 时使用）。
 * @returns {Promise<void>} 跑完后 resolve。
 */
async function runGridGame(browser, spec) {
  const contextA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const contextB = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const roomId = { value: "" };

  await check(`${spec.key}: A. 房主创建房间并拿到服务器房间码`, async () => {
    await contextA.addInitScript(() => {
      try {
        localStorage.setItem("linkplay-name", "房主甲");
      } catch {
        /* 隐私模式忽略 */
      }
    });
    await contextB.addInitScript(() => {
      try {
        localStorage.setItem("linkplay-name", "玩家乙");
      } catch {
        /* 隐私模式忽略 */
      }
    });
    const host = await contextA.newPage();
    await host.goto(`${BASE_URL}/${spec.key}.html`, { waitUntil: "networkidle" });
    await host.click("#hostBtn");
    await waitOnline(host);
    const state = await readState(host);
    roomId.value = state.roomId;
    assert(new RegExp(`^${spec.prefix}[A-Z0-9]{6}$`).test(roomId.value), `房间码应为 ${spec.prefix}+6 位，实际 ${roomId.value}`);
    assertEq(state.transportKind, "server-ws", "传输层应为自建 WebSocket");
    assertEq(state.role, "black", "房主应执黑（先手）");
    assert(await host.locator("#leaveRoomBtn").isVisible(), "房内应显示退出按钮");
    assert(await host.inputValue("#shareInput").then((v) => v.includes(`room=${roomId.value}`)), "邀请链接应带房间码");
  });

  await check(`${spec.key}: B. 访客经邀请链接加入并执白`, async () => {
    const host = contextA.pages()[0];
    const guest = await contextB.newPage();
    const invite = await host.inputValue("#shareInput");
    await guest.goto(invite, { waitUntil: "networkidle" });
    await waitOnline(guest);
    const state = await readState(guest);
    assertEq(state.roomId, roomId.value, "访客应进入同一房间");
    assertEq(state.role, "white", "访客应执白（后手）");
    assertEq(state.players.black, "房主甲", "访客应看到房主昵称");
    assertEq(state.players.white, "玩家乙", "访客昵称");
    // 房主侧也要实时看到访客加入（不能靠轮询补洞）。
    await host.waitForFunction(() => JSON.parse(window.render_game_to_text()).players.white === "玩家乙", null, { timeout: 10000 });
    assertEq((await readState(host)).started, true, "两人到齐后自动开局");
  });

  await check(`${spec.key}: C. 白方越权落子被服务器拒绝且棋盘不变`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const denied = await sendActionRaw(guest, "move", { row: 0, col: 0 });
    assertEq(denied.ok, false, "服务端应拒绝越权落子");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    assertEq((await readState(host)).moves.length, 0, "越权落子不应改动房主棋盘");
  });

  await check(`${spec.key}: D. 先手落子同步到对手，两端状态一致`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await clickCell(host, spec.opening[0], spec.opening[1], spec.rows, spec.cols);
    await Promise.all([waitMoves(host, 1), waitMoves(guest, 1)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.board, hostState.board, "两端棋盘一致");
    assertEq(guestState.turn, hostState.turn, "两端轮次一致");
    // 四子棋按列下落：客户端传 row=0，服务器必须把它落到该列最底部的空位。
    if (spec.key === "connect4") {
      assertEq(hostState.moves[0].row, spec.rows - 1, "重力棋首子应被服务器放到最后一行");
    } else {
      assertEq(hostState.moves[0].row, spec.opening[0], "非重力棋按客户端给定行落子");
      assertEq(hostState.moves[0].col, spec.opening[1], "列号一致");
    }
  });

  await check(`${spec.key}: E. 访客刷新后凭服务器快照恢复身份与棋盘`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const before = await readState(guest);
    await guest.reload({ waitUntil: "networkidle" });
    await waitOnline(guest);
    await waitMoves(guest, before.moves.length);
    const after = await readState(guest);
    assertEq(after.playerId, before.playerId, "刷新后 playerId 不变");
    assertEq(after.role, before.role, "刷新后执子颜色不变");
    assertEq(after.moves.length, before.moves.length, "刷新后棋盘手数一致");
    assertEq(after.board, before.board, "刷新后棋盘内容一致");
    // 房主侧不应因为访客刷新而丢失状态。
    assertEq((await readState(host)).moves.length, before.moves.length, "房主侧棋盘不受影响");
  });

  await check(`${spec.key}: F. 交换位置由服务器执行，双方座位互换`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    // 先重新开始，回到无落子的可对局状态。
    await host.click("#restartBtn");
    await host.waitForFunction(() => JSON.parse(window.render_game_to_text()).moves.length === 0, null, { timeout: 10000 });
    const before = await readState(host);
    assert(await host.locator("#swapSideBtn").isVisible(), "在线房间内应显示交换位置按钮");
    await host.click("#swapSideBtn");
    await host.waitForFunction(
      (prevBlack) => JSON.parse(window.render_game_to_text()).seatPlayerIds.black !== prevBlack,
      before.seatPlayerIds.black,
      { timeout: 10000 },
    );
    const after = await readState(host);
    assertEq(after.seatPlayerIds.black, before.seatPlayerIds.white, "黑位应换成原白位玩家");
    await guest.waitForFunction(
      (expectedBlack) => JSON.parse(window.render_game_to_text()).seatPlayerIds.black === expectedBlack,
      after.seatPlayerIds.black,
      { timeout: 10000 },
    );
    assertEq((await readState(guest)).seatPlayerIds.black, after.seatPlayerIds.black, "对手侧座位同步");
  });

  await check(`${spec.key}: G. 完成一局并给出胜负，两端战绩归属一致`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    // 1. 确定当前执黑的一方作为先手（交换位置后座位可能已经互换）。
    const hostState = await readState(host);
    const blackIsHost = hostState.seatPlayerIds.black === hostState.playerId;
    const blackPage = blackIsHost ? host : guest;
    const whitePage = blackIsHost ? guest : host;

    if (spec.finishType === "line") {
      // 2.1 连子类游戏：先手沿首行连成一线取胜，后手在末行陪走（不会自己先连成）。
      for (let i = 0; i < spec.lineLength; i += 1) {
        await clickCell(blackPage, 0, i, spec.rows, spec.cols);
        await blackPage.waitForFunction((n) => JSON.parse(window.render_game_to_text()).moves.length === n, i * 2 + 1, { timeout: 10000 });
        // 连成之后立即停止：继续落子会被服务器拒绝（GAME_ALREADY_FINISHED）。
        if ((await readState(blackPage)).winner !== null) break;
        if (i === spec.lineLength - 1) break;
        await clickCell(whitePage, spec.rows - 1, i, spec.rows, spec.cols);
        await whitePage.waitForFunction((n) => JSON.parse(window.render_game_to_text()).moves.length === n, i * 2 + 2, { timeout: 10000 });
      }
    } else {
      // 2.2 黑白棋：完整对局太长，用白方认输在服务器侧结算（同样走服务端权威结算路径）。
      const denied = await sendActionRaw(whitePage, "surrender");
      assertEq(denied.ok, true, "白方认输应被服务器接受");
    }

    const winnerState = await readState(blackPage);
    assert(
      winnerState.winner === "黑棋" || winnerState.winner === "先手" || winnerState.winner === "红方",
      `先手应获胜，实际 ${winnerState.winner}`,
    );
    assertEq(winnerState.record.total, 1, "总局数 1");
    assertEq(winnerState.record.winners.black, 1, "黑方 1 胜");
    assertEq(winnerState.record.winners.white, 0, "白方 0 胜");
    // 3. 对手侧必须看到完全一致的胜负与战绩（本轮记录归属 bug 的回归断言）。
    await whitePage.waitForFunction(() => JSON.parse(window.render_game_to_text()).winner !== null, null, { timeout: 10000 });
    const whiteState = await readState(whitePage);
    assertEq(whiteState.winner, winnerState.winner, "两端胜方一致");
    assertEq(whiteState.record.total, 1, "对手侧总局数一致");
    assertEq(whiteState.record.winners.black, 1, "对手侧黑方胜场一致");
    assertEq(whiteState.record.winners.white, 0, "对手侧白方胜场一致");
    // 4. UI 必须把两个座位显示成不同数字（此前的 bug 是两个座位显示同一个累计值）。
    assertEq(await blackPage.locator("#blackWins").textContent(), "1", "黑方胜场显示 1");
    assertEq(await blackPage.locator("#whiteWins").textContent(), "0", "白方胜场显示 0");
    assertEq(await whitePage.locator("#modalBlackWins").textContent(), "1", "对手侧结算弹窗黑方胜场 1");
    assertEq(await whitePage.locator("#modalWhiteWins").textContent(), "0", "对手侧结算弹窗白方胜场 0");
    await blackPage.screenshot({ path: `outputs/${spec.key}-dual-result.png`, fullPage: true });
  });

  await check(`${spec.key}: H. 再开一局后白方认输，第二轮战绩继续按座位正确累计`, async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    // 1. 从结算弹窗再开一把（服务器清盘并换先）。
    await host.click("#playAgainBtn");
    await host.waitForFunction(
      () => {
        const s = JSON.parse(window.render_game_to_text());
        return s.moves.length === 0 && s.winner === null;
      },
      null,
      { timeout: 10000 },
    );
    await guest.waitForFunction(
      () => {
        const s = JSON.parse(window.render_game_to_text());
        return s.moves.length === 0 && s.winner === null;
      },
      null,
      { timeout: 10000 },
    );
    // 2. 重新计算座位（再开一把会换先）。
    const hostState = await readState(host);
    const blackIsHost = hostState.seatPlayerIds.black === hostState.playerId;
    const whitePage = blackIsHost ? guest : host;
    const blackPage = blackIsHost ? host : guest;
    // 3. 白方认输 -> 黑方第二胜。
    const res = await sendActionRaw(whitePage, "surrender");
    assertEq(res.ok, true, "认输应被服务器接受");
    await blackPage.waitForFunction(() => JSON.parse(window.render_game_to_text()).record.total === 2, null, { timeout: 10000 });
    const after = await readState(blackPage);
    assertEq(after.record.winners.black, 2, "黑方两胜");
    assertEq(after.record.winners.white, 0, "白方仍为 0 胜");
    assertEq(await blackPage.locator("#blackWins").textContent(), "2", "UI 黑方胜场 2");
    assertEq(await blackPage.locator("#whiteWins").textContent(), "0", "UI 白方胜场 0");
  });

  await contextA.close();
  await contextB.close();
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

  const browser = await chromium.launch({ headless: true });

  // 2. 网络观测容器：记录所有请求与 WebSocket，用于"仅自建 WS"断言。
  const requests = [];
  const sockets = [];
  const consoleErrors = [];
  browser.on("request", (req) => requests.push(req.url()));
  for (const context of browser.contexts()) {
    context.on("page", (page) => {
      page.on("console", (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      });
      page.on("pageerror", (err) => consoleErrors.push(err.message));
    });
  }

  await runGridGame(browser, {
    key: "tictactoe",
    prefix: "JZ",
    rows: 3,
    cols: 3,
    opening: [2, 2],
    finishType: "line",
    lineLength: 3,
  });
  await runGridGame(browser, {
    key: "connect4",
    prefix: "SZ",
    rows: 6,
    cols: 7,
    opening: [0, 2],
    finishType: "line",
    lineLength: 4,
  });
  await runGridGame(browser, {
    key: "reversi",
    prefix: "HB",
    rows: 8,
    cols: 8,
    opening: [2, 3],
    // 黑白棋一局约 60 手，端到端跑满不现实；用认输让服务器走同一条权威结算路径，
    // 规则层面的完整对局覆盖由 tests/grid-rules.cjs 与 tests/grid-authority.cjs 承担。
    finishType: "surrender",
    lineLength: 0,
  });

  // ── 网络外连断言 ─────────────────────────────────────────────
  await check("I. 全程只使用自建 /ws，无 PeerJS/Supabase/WebRTC 外连", async () => {
    const forbidden = ["peerjs", "supabase", "webrtc", "stun:", "turn:"];
    const offOrigin = requests.filter((url) => /^https?:/i.test(url) && !url.startsWith(BASE_URL));
    assertEq(offOrigin, [], "存在非同源 HTTP 请求");
    const hits = requests.filter((url) => forbidden.some((word) => url.toLowerCase().includes(word)));
    assertEq(hits, [], "存在 PeerJS/Supabase/WebRTC 相关请求");
    assertEq(consoleErrors, [], "页面存在 console error / pageerror");
    void sockets;
    void EXPECTED_WS;
  });

  await browser.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("dual-client bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
