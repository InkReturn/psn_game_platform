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
 * @param {number} [timeoutMs] - 超时毫秒。
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
    localHidden: document.querySelector("#localBtn")?.hidden ?? null,
    leaveHidden: document.querySelector("#leaveRoomBtn")?.hidden ?? null,
  }));
  // 2. 刷新后凭 localStorage 凭据自动恢复身份与房间。
  await page.reload({ waitUntil: "networkidle" });
  await waitOnlineRoom(page);
  const restoredState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.click("#leaveRoomBtn");
  await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).roomId);
  await page.click("#localBtn");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).mode === "local");

  const box = await page.locator("#boardCanvas").boundingBox();
  const cellPoint = (row, col) => {
    const pad = 42;
    const gap = (760 - pad * 2) / 14;
    return {
      x: box.x + ((pad + col * gap) * box.width) / 760,
      y: box.y + ((pad + row * gap) * box.height) / 760,
    };
  };

  for (const [row, col] of [
    [3, 3],
    [3, 4],
    [4, 3],
  ]) {
    const point = cellPoint(row, col);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(50);
  }
  await page.click("#undoBtn");
  const undoRollbackState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  await page.click("#restartBtn");

  for (const [row, col] of [
    [7, 7],
    [7, 8],
    [8, 7],
    [8, 8],
    [9, 7],
    [9, 8],
    [10, 7],
    [10, 8],
    [11, 7],
  ]) {
    const point = cellPoint(row, col);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(50);
  }

  await page.locator("#resultModal").waitFor({ state: "visible" });
  const wonState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const status = await page.locator("#matchStatus").innerText();
  const modalText = await page.locator("#resultSummary").innerText();
  await page.screenshot({ path: "outputs/gomoku-modal.png", fullPage: true });

  await page.click("#playAgainBtn");
  await page.waitForFunction(() => !JSON.parse(window.render_game_to_text()).modalOpen);
  const replayState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  for (const [row, col] of [
    [6, 6],
    [6, 7],
    [7, 6],
    [7, 7],
    [8, 6],
    [8, 7],
    [9, 6],
    [9, 7],
    [10, 6],
  ]) {
    const point = cellPoint(row, col);
    await page.mouse.click(point.x, point.y);
    await page.waitForTimeout(50);
  }

  await page.locator("#resultModal").waitFor({ state: "visible" });
  const secondWonState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  await page.click("#exitRoomBtn");
  await page.waitForURL(/index\.html$/);
  const lobbyTitle = await page.locator("h1").innerText();

  await page.goto(`${baseUrl}/gomoku.html`, { waitUntil: "networkidle" });
  await page.click("#localBtn");
  await page.waitForFunction(() => JSON.parse(window.render_game_to_text()).mode === "local");
  await page.click("#surrenderBtn");
  await page.locator("#resultModal").waitFor({ state: "visible" });
  const surrenderState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.screenshot({ path: "outputs/gomoku-smoke.png", fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ initialState, restoredState, controlsAfterJoin, undoRollbackState, status, modalText, wonState, replayState, secondWonState, lobbyTitle, surrenderState, errors }, null, 2));

  if (errors.length) process.exit(1);
  // 联机链路口径：房间码来自服务器，传输层为自建 WebSocket，刷新后凭据恢复同一身份。
  if (!initialState.roomId || initialState.mode !== "online") process.exit(1);
  if (initialState.transportKind !== "server-ws" || !initialState.serverConnected) process.exit(1);
  if (restoredState.roomId !== initialState.roomId || restoredState.mode !== "online") process.exit(1);
  if (restoredState.playerId !== initialState.playerId) process.exit(1);
  if (!controlsAfterJoin.hostHidden || !controlsAfterJoin.joinHidden || !controlsAfterJoin.localHidden || controlsAfterJoin.leaveHidden) process.exit(1);
  if (undoRollbackState.moves.length !== 1 || undoRollbackState.moves[0].row !== 3 || undoRollbackState.moves[0].col !== 3) process.exit(1);
  if (undoRollbackState.turn !== "白棋") process.exit(1);
  if (wonState.winner !== "黑棋") process.exit(1);
  if (!wonState.modalOpen) process.exit(1);
  if (wonState.record.total !== 1 || wonState.record.players["本地玩家 A"] !== 1) process.exit(1);
  if (replayState.winner !== null || replayState.moves.length !== 0) process.exit(1);
  if (replayState.record.total !== 1 || replayState.record.players["本地玩家 A"] !== 1) process.exit(1);
  if (replayState.players.black !== "本地玩家 A" || replayState.players.white !== "本地玩家 B") process.exit(1);
  if (wonState.moves[0].point !== "H8") process.exit(1);
  if (secondWonState.record.total !== 2 || secondWonState.record.players["本地玩家 A"] !== 2) process.exit(1);
  if (lobbyTitle !== "LinkPlay") process.exit(1);
  if (!surrenderState.modalOpen) process.exit(1);
  if (surrenderState.record.total !== 1) process.exit(1);
  if (!Object.values(surrenderState.record.players).includes(1)) process.exit(1);
})();
