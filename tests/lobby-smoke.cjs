/**
 * 大厅两级结构浏览器冒烟（选择游戏 → 选择房间 → 创建房间）。
 *
 * 覆盖：
 * - 大厅一级视图加载无错误，品牌标题正确；
 * - 点击联机游戏卡不直接跳转，而是进入二级"选择房间"视图；
 * - 二级视图可返回一级；
 * - "创建房间"跳转 gomoku.html?create=1 后由游戏页自动建房（房间码以 WZ 开头）；
 * - 房间列表在有房间时正确渲染（协议数据经浏览器端展示）。
 *
 * 运行方式：node tests/lobby-smoke.cjs（BASE_URL 由 run-all 注入或自行拉起）。
 */
"use strict";

const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";

(async () => {
  // 1. 准备截图目录与错误收集。
  fs.mkdirSync("outputs", { recursive: true });
  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];
  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  // 2. 一级视图：品牌与卡片。
  await page.goto(baseUrl, { waitUntil: "networkidle" });
  const lobbyTitle = await page.locator("h1").innerText();
  if (lobbyTitle !== "LinkPlay") {
    console.error(`lobby title expected LinkPlay, got ${lobbyTitle}`);
    process.exit(1);
  }

  // 3. 点击五子棋卡：进入二级房间视图而不是直接跳转。
  await page.click('a[data-room-game="gomoku"]');
  const roomsVisible = await page.locator("#lobbyRooms").isVisible();
  const gamesHidden = !(await page.locator("#lobbyGames").isVisible());
  const roomsTitle = await page.locator("#roomsTitle").innerText();
  if (!roomsVisible || !gamesHidden) {
    console.error(`two-level switch failed: roomsVisible=${roomsVisible} gamesHidden=${gamesHidden}`);
    process.exit(1);
  }
  if (!roomsTitle.includes("五子棋")) {
    console.error(`rooms title expected 五子棋, got ${roomsTitle}`);
    process.exit(1);
  }
  await page.screenshot({ path: "outputs/lobby-rooms-view.png", fullPage: true });

  // 4. 返回一级视图。
  await page.click("#backToGamesBtn");
  const backToGames = await page.locator("#lobbyGames").isVisible();
  if (!backToGames) {
    console.error("back to games view failed");
    process.exit(1);
  }

  // 5. 二级视图房间列表渲染：先经页面 WS 拉一次空列表（无房间时展示空态），
  //    再点"创建房间"验证 ?create=1 自动建房链路。
  await page.click('a[data-room-game="gomoku"]');
  await page.waitForTimeout(700);
  await page.click("#createRoomBtn");
  await page.waitForURL(/gomoku\.html\?create=1$/);
  // 6. 游戏页自动建房：等房间码出现在房间输入框。
  await page.waitForFunction(() => /^WZ[A-Z0-9]{6}$/.test((document.querySelector("#roomInput")?.value || "").trim()), null, {
    timeout: 15000,
  });
  const roomId = (await page.locator("#roomInput").inputValue()).trim();
  const gameTitle = await page.locator(".stage-header h2").innerText();
  await page.screenshot({ path: "outputs/lobby-create-room.png", fullPage: true });

  // 7. 收尾校验：URL 已替换为 ?room=xx（刷新可恢复），标题正确，无页面错误。
  await page.waitForFunction(
    () => new URL(window.location.href).searchParams.has("room"),
    null,
    { timeout: 5000 },
  );
  const roomInUrl = new URL(page.url()).searchParams.get("room");
  await browser.close();

  console.log(JSON.stringify({ lobbyTitle, roomsTitle, gameTitle, roomId, roomInUrl, errors }, null, 2));
  if (errors.length) process.exit(1);
  if (gameTitle !== "五子棋") process.exit(1);
  if (!roomId || roomInUrl !== roomId) process.exit(1);
})();
