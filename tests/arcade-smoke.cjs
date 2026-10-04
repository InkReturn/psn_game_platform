"use strict";
const assert = require("node:assert/strict");
const fs = require("node:fs");
const { chromium } = require("playwright");
const { readLocalJson } = require("../integrations/local-health.cjs");
const { checkGame } = require("../server/arcade.cjs");
const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";
const expectProxy = process.env.EXPECT_ARCADE_PROXY === "1";
const errors = [];
const remoteRequests = [];
const results = [];

/**
 * 查询当前被测平台的有界 JSON 接口，不把远端 BASE_URL 错当成本机端口。
 * @param {string} route 固定以 / 开头的被测接口路径，由测试源码提供。
 * @returns {Promise<Object>} HTTP 状态和 JSON；网络或解码失败拒绝。
 */
async function publicJson(route) {
  // 1. 仅查询本次明确指定的被测服务。
  const response = await fetch(baseUrl + route, { signal: AbortSignal.timeout(5000) });
  return { statusCode: response.status, body: await response.json() };
}

/**
 * 记录浏览器脚本异常，最终验收必须为零。
 * @param {Error} error 浏览器 pageerror 事件。
 */
function recordError(error) {
  // 1. 保留错误消息用于验收报告。
  errors.push(error.message);
}

/**
 * 记录非本机自动网络请求，源码链接不点击。
 * @param {import('playwright').Request} request 实际浏览器请求。
 */
function recordRequest(request) {
  // 1. 公网必须同源；本机开发仅允许明确的回环服务，不放宽为任意外站。
  const url = new URL(request.url());
  const allowed = expectProxy ? url.origin === new URL(baseUrl).origin : ["127.0.0.1", "localhost"].includes(url.hostname);
  if (["http:", "https:"].includes(url.protocol) && !allowed) remoteRequests.push(url.href);
}

/**
 * 记录真实 WebSocket 地址和收发帧数。
 * @param {Object} evidence 当前页面的联机证据容器。
 * @param {import('playwright').WebSocket} socket 浏览器建立的游戏连接。
 */
function recordSocket(evidence, socket) {
  // 1. 记录真实服务器房间 URL，不模拟服务端快照。
  evidence.urls.push(socket.url());
  if (expectProxy) {
    const actual = new URL(socket.url()), expected = new URL(baseUrl);
    assert.equal(actual.host, expected.host, "公网游戏不得连接内部端口");
    assert.ok(actual.pathname.startsWith("/tanks/") || actual.pathname === "/quest/", "公网游戏必须经过固定代理路径");
  }
  socket.on("framesent", countSent.bind(null, evidence));
  socket.on("framereceived", countReceived.bind(null, evidence));
}

/**
 * 累计实际发送帧数。
 * @param {Object} evidence 当前页面的联机证据容器。
 */
function countSent(evidence) {
  // 1. 输入必须产生真实网络帧。
  evidence.sent++;
}

/**
 * 累计实际接收帧数。
 * @param {Object} evidence 当前页面的联机证据容器。
 */
function countReceived(evidence) {
  // 1. 确认客户端持续收到服务端游戏数据。
  evidence.received++;
}

/**
 * 创建隔离玩家页面并登记异常及网络证据。
 * @param {import('playwright').Browser} browser 测试拥有的浏览器。
 * @returns {Promise<Object>} 独立 context、page 与帧证据。
 */
async function playerPage(browser) {
  // 1. 每名玩家有独立的 storage 和浏览器身份。
  const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const page = await context.newPage();
  const evidence = { urls: [], sent: 0, received: 0 };
  page.on("pageerror", recordError);
  page.on("request", recordRequest);
  page.on("websocket", recordSocket.bind(null, evidence));
  // 2. 统一有界等待，失败直接报错，不跳过用例。
  page.setDefaultTimeout(20000);
  return { context, page, evidence };
}

/**
 * 进入平台包装页并等待本地 iframe 挂载。
 * @param {import('playwright').Page} page 当前玩家页面。
 * @param {string} id 静态目录中存在的游戏编号。
 * @returns {Promise<import('playwright').Frame>} 游戏 iframe。
 */
async function enterGame(page, id) {
  // 1. 通过实际平台入口打开，不直接跳过状态检查。
  await page.goto(`${baseUrl}/play.html?game=${encodeURIComponent(id)}`);
  await page.locator("#game-frame").waitFor({ state: "visible" });
  // 2. 获取游戏文档，后续步骤验证实际游戏交互。
  const handle = await page.locator("#game-frame").elementHandle();
  const frame = await handle.contentFrame();
  assert.ok(frame, "游戏 iframe 必须挂载");
  return frame;
}

/**
 * 检查移动端页面没有横向溢出。
 * @returns {boolean} 文档宽度是否在可视区域内。
 */
function noOverflow() {
  // 1. 容许像素取整误差，不隐藏实际溢出。
  return document.documentElement.scrollWidth <= window.innerWidth + 1;
}

/**
 * 验证方块键盘移动改变了棋盘，而非只改变开局按钮。
 * @param {string} before 键盘操作前的棋盘 HTML。
 * @returns {boolean} 棋盘是否实际发生变化。
 */
function stageChanged(before) {
  // 1. 使用真实渲染结果判断动作生效。
  return document.querySelector(".game-area__game").innerHTML !== before;
}

/**
 * 执行开源试玩端到端验收，启动器须预先运行。
 * @returns {Promise<void>} 全部场景及异常检查成功后完成。
 * @throws {Error} 任一场景失败，不把跳过或零用例视为通过。
 */
async function main() {
  // 1. 核查四款实际资源、两个独立服务和一个明确待接入项目。
  fs.mkdirSync("outputs", { recursive: true });
  const catalogResponse = await publicJson("/api/arcade");
  assert.equal(catalogResponse.statusCode, 200);
  const games = catalogResponse.body.games;
  let ready = 0;
  for (const game of games) if (game.ready) ready++;
  assert.equal(ready, 4);
  const pending = games.find(isLichess);
  assert.equal(pending.ready, false);
  const offline = await checkGame({ ...games[0], servicePort: 65534 });
  assert.equal(offline.ready, false);
  assert.match(offline.reason, /未启动/);
  results.push("目录：4 款可玩、Lichess 待接入、失效服务不会冒充可玩");
  const browser = await chromium.launch({ headless: true, args: ["--no-proxy-server", "--use-angle=swiftshader", "--enable-unsafe-swiftshader"] });
  try {
    // 2. 验证大厅入口、未接入项目无试玩按钮及移动端布局。
    const lobby = await playerPage(browser);
    await lobby.page.goto(baseUrl);
    assert.equal(await lobby.page.locator(".lobby-grid > a").count(), 12);
    await lobby.page.getByRole("link", { name: "开源试玩 →" }).click();
    await lobby.page.locator('.arcade-card[data-game="tanks"] .arcade-action').waitFor();
    assert.equal(await lobby.page.locator(".arcade-action").count(), 4);
    assert.equal(await lobby.page.locator('[data-game="lichess"] .arcade-action').count(), 0);
    await lobby.page.screenshot({ path: "outputs/arcade-lobby.png", fullPage: true });
    await lobby.page.setViewportSize({ width: 375, height: 812 });
    assert.equal(await lobby.page.evaluate(noOverflow), true);
    await lobby.page.screenshot({ path: "outputs/arcade-mobile.png", fullPage: true });
    await lobby.context.close();
    results.push("大厅：原有 11 款保留，4 个新入口，375px 无横向溢出");

    // 3. 方块真实开局、键盘移动、暂停和继续；没有不可用多人按钮。
    const blocks = await playerPage(browser);
    const blockFrame = await enterGame(blocks.page, "tetris");
    await blockFrame.getByTestId("singleplayer-start-game").click();
    await blockFrame.getByTestId("singleplayer-pause-game").waitFor();
    const before = await blockFrame.locator(".game-area__game").innerHTML();
    await blockFrame.getByTestId("singleplayer-container").press("ArrowRight");
    await blockFrame.waitForFunction(stageChanged, before);
    await blockFrame.getByTestId("singleplayer-pause-game").click();
    await blockFrame.getByTestId("singleplayer-resume-game").waitFor();
    await blockFrame.getByTestId("singleplayer-resume-game").click();
    await blockFrame.getByTestId("singleplayer-pause-game").waitFor();
    await blocks.page.screenshot({ path: "outputs/arcade-tetris.png", fullPage: true });
    await blocks.context.close();
    results.push("方块：真实开局、键盘移动、暂停、继续通过（仅单人）");

    // 4. 原版地产桌游设置双人，开局并真实掷骰。
    const estate = await playerPage(browser);
    const estateFrame = await enterGame(estate.page, "monopoly-classic");
    await estateFrame.locator("#playernumber").selectOption("2");
    await estateFrame.getByRole("button", { name: "Start Game", exact: true }).click();
    await estateFrame.getByRole("button", { name: "Roll Dice", exact: true }).click();
    await estateFrame.locator("#alert").getByText(/rolled \d+/).first().waitFor();
    await estate.page.screenshot({ path: "outputs/arcade-monopoly.png", fullPage: true });
    await estate.context.close();
    results.push("地产桌游：2 人同屏开局、掷骰通过（未改在线）");

    // 5. 两个独立坦克客户端实际握手并进入同一个服务器房间。
    const tankA = await playerPage(browser);
    const tankB = await playerPage(browser);
    const tankFrameA = await enterGame(tankA.page, "tanks");
    const tankFrameB = await enterGame(tankB.page, "tanks");
    await tankFrameA.locator("body > canvas").first().waitFor();
    await tankFrameB.locator("body > canvas").first().waitFor();
    await tankFrameA.locator("#connect-status").waitFor({ state: "hidden" });
    await tankFrameB.locator("#connect-status").waitFor({ state: "hidden" });
    assert.ok(tankA.evidence.urls.length && tankB.evidence.urls.length);
    assert.equal(new URL(tankA.evidence.urls[0]).pathname, new URL(tankB.evidence.urls[0]).pathname);
    assert.ok(tankA.evidence.received > 0 && tankB.evidence.received > 0);
    const sentBefore = tankA.evidence.sent;
    await tankFrameA.locator("body > canvas").first().click({ position: { x: 250, y: 250 } });
    await tankA.page.keyboard.press("w");
    assert.ok(tankA.evidence.sent > sentBefore, "移动/射击必须发送真实游戏输入");
    await tankA.page.screenshot({ path: "outputs/arcade-tanks.png", fullPage: true });
    await tankA.context.close();
    await tankB.context.close();
    results.push("坦克：双端进入同一权威房间，收帧及输入发送通过");

    // 6. 两个独立冒险角色完成握手并进入原版共享世界；公网首载素材较慢，给足有界等待。
    const questStart = expectProxy ? 90000 : 20000;
    const questA = await playerPage(browser);
    const questB = await playerPage(browser);
    const questFrameA = await enterGame(questA.page, "browserquest");
    const questFrameB = await enterGame(questB.page, "browserquest");
    await questFrameA.locator("#nameinput").fill("QuestOne");
    await questFrameA.locator("#createcharacter .play:not(.disabled)").click();
    await questFrameA.locator("body.started").waitFor({ state: "attached", timeout: questStart });
    await questFrameB.locator("#nameinput").fill("QuestTwo");
    await questFrameB.locator("#createcharacter .play:not(.disabled)").click();
    await questFrameB.locator("body.started").waitFor({ state: "attached", timeout: questStart });
    const population = expectProxy ? await publicJson("/quest/status") : await readLocalJson(8093, "/status");
    assert.ok(population.body[0] >= 2);
    assert.ok(questA.evidence.received > 0 && questB.evidence.received > 0);
    await questA.page.screenshot({ path: "outputs/arcade-quest.png", fullPage: true });
    await questA.context.close();
    await questB.context.close();
    results.push("像素冒险：双角色完成握手，世界人数至少 2，实际收到游戏帧");

    // 7. 拒绝任意地址和未接入项目，不挂载伪试玩 iframe。
    const invalid = await playerPage(browser);
    await invalid.page.goto(`${baseUrl}/play.html?game=https://example.com`);
    await invalid.page.getByText("无法开始试玩：游戏不存在").waitFor();
    assert.equal(await invalid.page.locator("#game-frame").isVisible(), false);
    await invalid.page.goto(`${baseUrl}/play.html?game=lichess`);
    await invalid.page.getByText(/无法开始试玩：本机缺少/).waitFor();
    assert.equal(await invalid.page.locator("#game-frame").isVisible(), false);
    await invalid.context.close();
    results.push("边界：非法编号和未接入项目均不生成游戏 iframe");
    if (expectProxy) {
      // 7.1 验证真实公网代理拓扑、内部运维路径不可读和公开署名。
      const declaration = await fetch(`${baseUrl}/api/arcade-network.js`, { signal: AbortSignal.timeout(5000) });
      assert.match(await declaration.text(), /LINKPLAY_ARCADE_PROXY = true/);
      for (const route of ["/server.js", "/package.json", "/deploy/private-server/linkplay.service", "/node_modules/express/package.json"]) assert.equal((await fetch(baseUrl + route)).status, 404);
      const credits = await fetch(`${baseUrl}/third-party.html`); assert.equal(credits.status, 200); assert.match(await credits.text(), /Firewarden3D/);
      results.push("公网：8881 同源双世界、部署声明与内部路径保护、可访问署名通过");
    }
    assert.deepEqual(errors, [], "浏览器不能存在脚本异常");
    assert.deepEqual(remoteRequests, [], "试玩运行不能依赖外部 CDN 或公共服务器");
  } finally {
    await browser.close();
  }
  // 8. 输出执行数量及可重放证据，不把零用例或跳过当通过。
  assert.equal(results.length, expectProxy ? 8 : 7, "验收数量不得为零或因跳过而缩水");
  const report = { passed: results.length, proxy: expectProxy, baseUrl, results, errors, remoteRequests };
  fs.writeFileSync("outputs/arcade-verification.json", JSON.stringify(report, null, 2));
  console.log(JSON.stringify(report, null, 2));
}

/**
 * 定位明确待接入的象棋目录项。
 * @param {Object} game 状态接口返回的目录项。
 * @returns {boolean} 是否为 Lichess。
 */
function isLichess(game) {
  // 1. 使用稳定编号，不依赖界面名称。
  return game.id === "lichess";
}

/**
 * 报告失败并以非零状态退出。
 * @param {Error} error 验收断言或浏览器运行异常。
 */
function failed(error) {
  // 1. 保留完整断言证据，不吞异常或标为跳过。
  console.error(error);
  console.error(JSON.stringify({ completed: results, errors, remoteRequests }, null, 2));
  process.exitCode = 1;
}
main().catch(failed);
