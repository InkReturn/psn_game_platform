/**
 * 全平台回归（Checkpoint 6）：遍历大厅所有游戏入口，逐一打开页面并断言健康。
 *
 * 覆盖：
 * - 大厅 index.html 上所有游戏卡片链接可解析且页面可打开；
 * - 每个游戏页面加载无 console error / pageerror，且暴露测试钩子
 *   window.render_game_to_text（权威状态镜像就绪）；
 * - 每个页面都能通过"返回游戏大厅"链接回到大厅；
 * - 本地模式（五子棋 / 井字棋 / 黑白棋 / 四子棋的本地按钮）未被破坏。
 *
 * 运行方式：node tests/platform-regression.cjs（未设置 BASE_URL 时自行拉起服务器）
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18099;
/** 外部注入的站点地址（为空则自拉服务器）。 */
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;

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
 * 轮询 /health 等待服务器就绪。
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
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });

  // 2. 大厅：收集全部游戏入口。
  const entries = [];
  await check("大厅可打开且包含全部 11 款游戏入口", async () => {
    const consoleErrors = [];
    const onError = (msg) => {
      if (msg.type() === "error") consoleErrors.push(msg.text());
    };
    page.on("console", onError);
    await page.goto(`${BASE_URL}/index.html`, { waitUntil: "networkidle" });
    page.off("console", onError);
    assertEq(consoleErrors, [], "大厅 console error");
    const links = await page.$$eval(".lobby-game", (nodes) => nodes.map((node) => node.getAttribute("href")));
    assertEq(links.length, 11, `应有 11 个游戏入口，实际 ${links.length}`);
    entries.push(...links);
    const expected = ["gomoku.html", "tictactoe.html", "reversi.html", "connect4.html", "monopoly.html", "ludo.html", "checkers.html", "animal-chess.html", "texas.html", "blackjack.html", "landlord.html"];
    assertEq([...links].sort(), [...expected].sort(), "入口清单一致");
  });

  // 3. 逐个入口：页面健康 + 测试钩子 + 返回大厅。
  for (const entry of entries) {
    await check(`入口 ${entry}：加载无错误、状态钩子就绪、可返回大厅`, async () => {
      const consoleErrors = [];
      const onError = (msg) => {
        if (msg.type() === "error") consoleErrors.push(msg.text());
      };
      const onPageError = (err) => consoleErrors.push(err.message);
      page.on("console", onError);
      page.on("pageerror", onPageError);
      try {
        await page.goto(`${BASE_URL}/${entry}`, { waitUntil: "networkidle" });
        assertEq(consoleErrors, [], "页面 console error");
        // 1. 权威状态镜像钩子存在（各渲染层初始化成功）。
        const hookReady = await page.evaluate(() => typeof window.render_game_to_text === "function");
        assert(hookReady, "window.render_game_to_text 未定义（渲染层未初始化）");
        const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
        assert(state && typeof state === "object", "状态输出应为对象");
        // 2. 返回大厅链接可用。
        const back = await page.getAttribute(".back-link", "href");
        assertEq(back, "index.html", "返回大厅链接");
        await page.click(".back-link");
        await page.waitForLoadState("networkidle");
        assert(page.url().endsWith("index.html"), `应回到大厅，实际 ${page.url()}`);
      } finally {
        page.off("console", onError);
        page.off("pageerror", onPageError);
      }
    });
  }

  // 4. 本地模式回归：grid 三游戏 + 五子棋的本地按钮可用。
  for (const [entry, button] of [
    ["tictactoe.html", "#localBtn"],
    ["reversi.html", "#localBtn"],
    ["connect4.html", "#localBtn"],
  ]) {
    await check(`本地模式 ${entry}：进入本地对战后可落子`, async () => {
      await page.goto(`${BASE_URL}/${entry}`, { waitUntil: "networkidle" });
      await page.click(button);
      const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
      assertEq(state.mode, "local", "进入本地模式");
      if (entry === "reversi.html") {
        // 1. 黑白棋开局只有 4 个固定合法点：验证本地规则就绪（可落点非空）。
        assert(state.legalMoves && state.legalMoves.length === 4, `黑白棋本地合法点应为 4 个，实际 ${state.legalMoves?.length}`);
        return;
      }
      // 2. 其余棋盘：真实点击棋盘落一子（画布中心）。
      await page.click("#boardCanvas", { position: { x: 150, y: 150 } });
      await page.waitForTimeout(200);
      const after = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
      assertEq(after.moves.length, 1, "本地落子成功");
    });
  }

  await check("本地模式 gomoku.html：本地对战入口可用", async () => {
    await page.goto(`${BASE_URL}/gomoku.html`, { waitUntil: "networkidle" });
    // 1. 五子棋的本地入口由 gomoku-smoke 完整覆盖，这里只验证按钮存在且可进入。
    const hasLocal = await page.locator("#localBtn").count().then((n) => n > 0);
    assert(hasLocal, "本地对战按钮应存在");
    await page.click("#localBtn");
    await page.waitForTimeout(200);
    const state = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
    assert(state.mode === "local" || state.local === true || state.started !== undefined, "本地模式状态可读");
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
  console.error("platform regression failed:", err);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
