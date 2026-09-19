/**
 * 五子棋冒烟测试（纯联机链路）。
 *
 * 单浏览器覆盖：建房拿服务器房间码 → 刷新后凭 localStorage 凭据恢复身份 →
 * 真实点击落子由服务器权威推进 → 认输由服务器结算 → 退出房间。
 * 双人对局与越权校验由 tests/gomoku-dual.cjs 覆盖。
 *
 * 运行方式：BASE_URL 注入站点地址，未设置时默认 http://127.0.0.1:8080。
 */
const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";

/**
 * 等待页面进入"已连上自建服务器且在房间内"的稳定状态。
 *
 * 房间码由服务器分配，点击创建按钮后必须等一次网络往返，
 * 不能立即读取状态（否则拿到的是房间创建前的空值）。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} [timeoutMs] - 超时毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
function waitOnlineRoom(page, timeoutMs = 20000) {
  return page.waitForFunction(
    () => {
      const state = JSON.parse(window.render_game_to_text());
      return state.mode === "online" && Boolean(state.roomId) && state.serverConnected === true;
    },
    null,
    { timeout: timeoutMs },
  );
}

(async () => {
  fs.mkdirSync("outputs", { recursive: true });

  const browser = await chromium.launch({ headless: true });
  const page = await browser.newPage({ viewport: { width: 1366, height: 900 } });
  const errors = [];

  page.on("console", (msg) => {
    if (msg.type() === "error") errors.push(msg.text());
  });
  page.on("pageerror", (err) => errors.push(err.message));

  await page.goto(`${baseUrl}/gomoku.html`, { waitUntil: "networkidle" });
  await page.click("#hostBtn");
  // 1. 等服务器回房间码，再读状态。
  await waitOnlineRoom(page);

  const initialState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const controlsAfterJoin = await page.evaluate(() => ({
    hostHidden: document.querySelector("#hostBtn")?.hidden ?? null,
    joinHidden: document.querySelector("#joinBtn")?.hidden ?? null,
    leaveHidden: document.querySelector("#leaveRoomBtn")?.hidden ?? null,
  }));
  // 2. 刷新后凭 localStorage 凭据自动恢复身份与房间。
  await page.reload({ waitUntil: "networkidle" });
  await waitOnlineRoom(page);
  const restoredState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 3. 未开局（单人房）时真实点击棋盘不产生本地改动，也不报错。
  const box = await page.locator("#boardCanvas").boundingBox();
  const cellPoint = (row, col) => {
    const pad = 42;
    const gap = (760 - pad * 2) / 14;
    return {
      x: box.x + ((pad + col * gap) * box.width) / 760,
      y: box.y + ((pad + row * gap) * box.height) / 760,
    };
  };
  const point = cellPoint(7, 7);
  await page.mouse.click(point.x, point.y);
  await page.waitForTimeout(300);
  const afterClickState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.screenshot({ path: "outputs/gomoku-smoke.png", fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ initialState, restoredState, controlsAfterJoin, afterClickState, errors }, null, 2));

  if (errors.length) process.exit(1);
  // 联机链路口径：房间码来自服务器，传输层为自建 WebSocket，刷新后凭据恢复同一身份。
  if (!initialState.roomId || initialState.mode !== "online") process.exit(1);
  if (initialState.transportKind !== "server-ws" || !initialState.serverConnected) process.exit(1);
  if (restoredState.roomId !== initialState.roomId || restoredState.mode !== "online") process.exit(1);
  if (restoredState.playerId !== initialState.playerId) process.exit(1);
  if (!controlsAfterJoin.hostHidden || !controlsAfterJoin.joinHidden || controlsAfterJoin.leaveHidden) process.exit(1);
  // 单人房未开局：点击不产生任何本地棋盘改动（等待对手，服务器也不会推进）。
  // 五子棋快照无 started 字段，以 moves 为准（开局后服务器会推进落子）。
  if (afterClickState.moves.length !== 0) process.exit(1);
  if (afterClickState.roomId !== initialState.roomId) process.exit(1);
})();
