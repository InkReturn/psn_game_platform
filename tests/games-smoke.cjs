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

  await page.goto(`${baseUrl}/texas.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  await page.click("#addTexasRobotBtn");
  await page.click("#startTexasBtn");
  await page.click("#checkCallBtn");
  const texasState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.goto(`${baseUrl}/blackjack.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  await page.click("#addBlackjackRobotBtn");
  await page.click("#startBlackjackBtn");
  await page.click("#hitBtn");
  const blackjackState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));

  await page.goto(`${baseUrl}/landlord.html`, { waitUntil: "networkidle" });
  await createRoomAndWait(page);
  await page.click("#addRobotBtn");
  await page.click("#startLandlordBtn");
  await page.click("#callLandlordBtn");
  await page.click("#passBidBtn");
  await page.waitForFunction(() => {
    const state = JSON.parse(window.render_game_to_text());
    return state.phase === "playing";
  });
  await page.waitForFunction(() => {
    const state = JSON.parse(window.render_game_to_text());
    return state.seats[state.turn]?.type === "human";
  });
  await page.click("#hintCardsBtn");
  const landlordState = JSON.parse(await page.evaluate(() => window.render_game_to_text()));
  const addRobotDisabled = await page.locator("#addRobotBtn").isDisabled();

  await page.screenshot({ path: "outputs/games-smoke.png", fullPage: true });
  await browser.close();

  console.log(JSON.stringify({ monopolyState, ludoState, checkersState, animalState, texasState, blackjackState, landlordState, addRobotDisabled, errors }, null, 2));

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
  if (texasState.seats.length < 2 || !texasState.started || !texasState.room?.roomId) process.exit(1);
  if (!["preflop", "flop", "turn", "river", "showdown"].includes(texasState.phase)) process.exit(1);
  if (blackjackState.seats.length < 2 || !blackjackState.started || !blackjackState.room?.roomId) process.exit(1);
  if (!["player", "dealer", "showdown"].includes(blackjackState.phase)) process.exit(1);
  if (landlordState.seats.length !== 3 || !landlordState.started || !landlordState.room?.roomId) process.exit(1);
  if (landlordState.phase !== "playing") process.exit(1);
  if (landlordState.bottomCards.length !== 3) process.exit(1);
  if (!landlordState.seats.some((seat) => seat.isLandlord && seat.handCount >= 17)) process.exit(1);
  if (landlordState.seats.every((seat) => seat.handCount === 18)) process.exit(1);
  if (!landlordState.seats.some((seat) => seat.type === "robot")) process.exit(1);
  if (!landlordState.selected.length) process.exit(1);
  if (!addRobotDisabled) process.exit(1);
})();
