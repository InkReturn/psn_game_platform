const fs = require("fs");
const { chromium } = require("playwright");

const baseUrl = process.env.BASE_URL || "http://127.0.0.1:8080";

/**
 * 点击"创建房间"并等待服务器返回房间码。
 *
 * 房间码由自建服务器分配，创建后 #leaveRoomBtn 才会解除隐藏；
 * 必须等它可见再继续（立即读取会拿到创建前的状态）。
 *
 * @param {import("playwright").Page} page - 目标游戏页面。
 * @returns {Promise<void>} 房间就绪后 resolve。
 */
async function createRoomAndWait(page) {
  // 1. 触发建房（面板内部完成 WS 连接与 room.create 往返）。
  await page.click("#hostBtn");
  // 2. 房内控件出现即代表房间码已下发。
  await page.locator("#leaveRoomBtn").waitFor({ state: "visible", timeout: 20000 });
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

  // 大富翁已改为服务器权威房：单人建房停在"等待满员"，骰子与机会事件由服务器裁定。
  // 完整的双人对局（掷骰/购买/越权/刷新恢复/重开/离开）由 tests/monopoly-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/monopoly.html`, { waitUntil: "networkidle" });
  await page.selectOption("#monopolyPlayerCount", "4");
  await createRoomAndWait(page);
  const monopolyState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 飞行棋已改为服务器权威房：单人建房停在"等待满员"，骰子由服务器投掷。
  // 完整的双人对局（掷骰/越权/刷新恢复/重开/离开）由 tests/ludo-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/ludo.html`, { waitUntil: "networkidle" });
  await page.selectOption("#ludoPlayerCount", "4");
  await createRoomAndWait(page);
  const ludoState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 跳棋已改为服务器权威房：单人建房停在"等待满员"，不再有本地开局按钮。
  // 完整的双人对局（走子/越权/刷新恢复/重开/离开）由 tests/checkers-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/checkers.html`, { waitUntil: "networkidle" });
  await page.selectOption("#checkersPlayerCount", "6");
  await createRoomAndWait(page);
  const checkersState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 斗兽棋已改为服务器权威房：单人建房只会停在"等待对手"，不再有本地开局按钮。
  // 完整的双人对局（走子/吃子/跳河/胜负/刷新恢复）由 tests/animal-chess-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/animal-chess.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  const animalState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 德州扑克已改为服务器权威房：单人建房停在"等待满员"，底牌只发给本人。
  // 完整的双人对局（下注/摊牌/弃牌获胜/刷新恢复/新一手/离开）由 tests/texas-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/texas.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  const texasState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 21 点已改为服务器权威房：单人建房停在"等待满员"，庄家暗牌结算前不下发。
  // 完整的双人对局（要牌/停牌/结算/刷新恢复/新一局/离开）由 tests/blackjack-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/blackjack.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  const blackjackState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  // 斗地主已改为服务器权威房：单人建房停在"等待满员"（3 人满员自动发牌）。
  // 完整的三人对局（叫分/出牌/隐私/刷新恢复/重发/离开）由 tests/landlord-dual.cjs 覆盖。
  await page.goto(`${baseUrl}/landlord.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  const landlordState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.screenshot({ path: "outputs/games-smoke.png", fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ monopolyState, ludoState, checkersState, animalState, texasState, blackjackState, landlordState, errors }, null, 2));

  if (errors.length) process.exit(1);
  // 大富翁权威房：单人建房应配置 4 人局、未开局、已进房，且我方坐 0 号位。
  if (monopolyState.playerCount !== 4 || monopolyState.started || !monopolyState.room?.roomId) process.exit(1);
  if (monopolyState.mySeatIndex !== 0) process.exit(1);
  // 飞行棋权威房：单人建房应配置 4 人局、未开局、已进房，且我方坐 0 号位。
  if (ludoState.playerCount !== 4 || ludoState.started || !ludoState.room?.roomId) process.exit(1);
  if (ludoState.mySeatIndex !== 0) process.exit(1);
  // 跳棋权威房：单人建房应配置 6 人局、未开局、已进房，且我方坐 0 号位。
  if (checkersState.playerCount !== 6 || checkersState.started || !checkersState.room?.roomId) process.exit(1);
  if (checkersState.mySeatIndex !== 0) process.exit(1);
  // 斗兽棋权威房：单人建房应有 16 子、未开局、已进房，且我方执红。
  if (animalState.pieces.length !== 16 || animalState.started || !animalState.room?.roomId) process.exit(1);
  if (animalState.mySide !== "red" || animalState.turn !== "red") process.exit(1);
  // 德州扑克权威房：单人建房应已进房、未开局（等待满员），且我方坐 0 号位、无底牌。
  if (texasState.started || texasState.phase !== "idle" || !texasState.room?.roomId) process.exit(1);
  if (texasState.mySeatIndex !== 0) process.exit(1);
  if (texasState.myHand.length !== 0) process.exit(1);
  // 21 点权威房：单人建房应已进房、未开局（等待满员），且我方坐 0 号位、无手牌。
  if (blackjackState.started || blackjackState.phase !== "idle" || !blackjackState.room?.roomId) process.exit(1);
  if (blackjackState.mySeatIndex !== 0) process.exit(1);
  if (blackjackState.myHand.length !== 0) process.exit(1);
  // 斗地主权威房：单人建房应已进房、未开局（等待满员），且我方坐 0 号位。
  if (landlordState.started || landlordState.phase !== "idle" || !landlordState.room?.roomId) process.exit(1);
  if (landlordState.mySeatIndex !== 0) process.exit(1);
  if (landlordState.myHand.length !== 0) process.exit(1);
})();
