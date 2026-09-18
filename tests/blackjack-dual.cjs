/**
 * 21 点双浏览器联机验收（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 全部走真实链路：
 *   Browser A → WSS → Node 服务器 → WSS → Browser B
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过
 * 前端拦截，用来证明服务器自己会拒绝）。
 *
 * 覆盖：建房 → 访客经邀请链接加入 → 满员自动发牌 → 页面级隐私断言
 * （他人手牌与庄家暗牌不出现在本地状态）→ 越权要牌被拒 → 真实点击
 * 要牌/停牌驱动到自动结算 → 双端胜负/派彩一致 → 刷新恢复 →
 * 房主开新一局（筹码延续）→ 房主重置 → 离开。
 *
 * 运行方式：node tests/blackjack-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18096 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const rules = require("../blackjack-rules");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18096;
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
 * 等待页面进入房间（拿到房间码）。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} [timeoutMs] - 超时毫秒数。
 */
async function waitInRoom(page, timeoutMs = 20000) {
  await page.waitForFunction(() => Boolean(JSON.parse(window.render_game_to_text()).room.roomId), null, { timeout: timeoutMs });
}

/**
 * 等待页面状态满足谓词。
 *
 * 谓词在页面里执行，不能闭包 Node 侧变量：需要的外部值通过 arg 传入，
 * 谓词签名约定为 (state, arg) => boolean。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {Function} predicate - (state, arg) => boolean。
 * @param {*} [arg] - 传给谓词的外部值（可选）。
 * @param {number} [timeoutMs] - 超时毫秒数。
 */
async function waitState(page, predicate, arg, timeoutMs = 10000) {
  await page.waitForFunction(
    ([predSource, argValue]) => eval(`(${predSource})`)(JSON.parse(window.render_game_to_text()), argValue),
    [predicate.toString(), arg === undefined ? null : arg],
    { timeout: timeoutMs },
  );
}

/**
 * 向服务器直接发送一次 game.action（绕过客户端本地拦截）。
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
 * 用真实点击驱动到自动结算：当前玩家点数 <17 点"要牌"，否则点"停牌"。
 *
 * @param {Array<import("playwright").Page>} pages - 两个座位页面（按座位顺序）。
 * @param {number} [maxRounds] - 最大行动数。
 * @returns {Promise<object>} 结算后的状态。
 */
async function driveToSettle(pages, maxRounds = 60) {
  let state = await readState(pages[0]);
  for (let round = 0; round < maxRounds; round += 1) {
    if (state.over) return state;
    const lastMoves = state.moves;
    const seat = state.turn;
    const page = pages[seat];
    await waitState(page, (s, exp) => s.started && !s.over && s.turn === exp, seat);
    const current = await readState(page);
    const value = rules.handValue(current.myHand);
    await page.click(value < 17 ? "#hitBtn" : "#standBtn");
    await Promise.all(pages.map((p) => waitState(p, (s, exp) => s.over || s.moves === exp, lastMoves + 1, 10000)));
    state = await readState(pages[0]);
    await page.waitForTimeout(150);
  }
  throw new Error(`驱动 ${maxRounds} 轮仍未结算`);
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

  // 2. 网络观测容器：记录所有请求，用于"仅自建 WS"断言。
  const requests = [];
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

  const contextA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const contextB = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  await contextA.addInitScript(() => {
    try {
      localStorage.setItem("linkplay-name", "玩家甲");
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
  const roomId = { value: "" };

  await check("A. 房主创建 2 人房间，访客经邀请链接加入后自动发牌", async () => {
    const host = await contextA.newPage();
    await host.goto(`${BASE_URL}/blackjack.html`, { waitUntil: "networkidle" });
    await host.click("#hostBtn");
    await waitInRoom(host);
    const state = await readState(host);
    roomId.value = state.room.roomId;
    assert(/^BJ[A-Z0-9]{6}$/.test(roomId.value), `房间码应为 BJ+6 位，实际 ${roomId.value}`);
    assertEq(state.started, false, "单人未开局");
    assertEq(state.mySeatIndex, 0, "房主坐 0 号位");
    assert(await host.locator("#blackjackPlayerCount").isDisabled(), "进房后人数选择应锁定");
    // 1. 访客经邀请链接加入 → 满员自动发牌。
    const guest = await contextB.newPage();
    const invite = await host.inputValue("#shareInput");
    await guest.goto(invite, { waitUntil: "networkidle" });
    await waitInRoom(guest);
    await Promise.all([waitState(host, (s) => s.phase === "player"), waitState(guest, (s) => s.phase === "player")]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.mySeatIndex, 1, "访客坐 1 号位");
    assertEq(hostState.myHand.length, 2, "甲的 2 张手牌");
    assertEq(guestState.myHand.length, 2, "乙的 2 张手牌");
    // 2. 庄家：1 明 1 暗（暗牌不在状态里）。
    [hostState, guestState].forEach((state) => {
      assertEq(state.dealer.cards.length, 1, "庄家只发明牌");
      assertEq(state.dealer.handCount, 2, "庄家共 2 张");
      state.seats.forEach((seat) => {
        assertEq(seat.hand, null, "结算前他人手牌不下发");
        assertEq(seat.handCount, 2, "座位张数");
      });
    });
  });

  await check("B. 页面级隐私：他人手牌与庄家暗牌不出现在本地状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const hostState = await readState(host);
    const guestState = await readState(guest);
    // 1. 乙的手牌 id 不得出现在甲的页面状态里（甲自己的手牌与庄家明牌除外）。
    const hostText = JSON.stringify(hostState);
    guestState.myHand.forEach((card) => {
      assert(!hostText.includes(`"${card.id}"`), `甲的页面状态泄漏了乙的手牌 ${card.id}`);
    });
    const guestText = JSON.stringify(guestState);
    hostState.myHand.forEach((card) => {
      assert(!guestText.includes(`"${card.id}"`), `乙的页面状态泄漏了甲的手牌 ${card.id}`);
    });
  });

  await check("C. 越权要牌被服务器拒绝且状态不变", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const state = await readState(host);
    const notTurnPage = state.turn === 0 ? guest : host;
    const denied = await sendActionRaw(notTurnPage, "hit");
    assertEq(denied.ok, false, "越权要牌应被拒");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    assertEq((await readState(host)).moves, state.moves, "状态未变化");
  });

  await check("D. 真实点击要牌/停牌驱动到自动结算，双端一致", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const final = await driveToSettle([host, guest]);
    assertEq(final.over, true, "对局结束");
    assertEq(final.phase, "showdown", "结算阶段");
    // 1. 庄家手牌全部公开，点数 >=17 或爆牌。
    [host, guest].forEach(async (page) => {
      const state = await readState(page);
      assertEq(state.dealer.cards.length, state.dealer.handCount, "庄家暗牌公开");
      const score = rules.handValue(state.dealer.cards);
      assert(score >= 17 || score > 21, `庄家点数应 >=17 或爆牌，实际 ${score}`);
    });
    // 2. 双端胜负与筹码一致；结算后他人手牌公开。
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.winners, hostState.winners, "双端赢家一致");
    assertEq(guestState.seats.map((s) => s.chips), hostState.seats.map((s) => s.chips), "双端筹码一致");
    hostState.seats.forEach((seat) => assert(Array.isArray(seat.hand), "结算后手牌公开"));
    // 3. 赢家派彩正确（底注 10 → +20）。
    hostState.winners.forEach((index) => assertEq(hostState.seats[index].chips, rules.START_CHIPS + rules.BET * 2, `赢家 ${index} 派彩`));
    await host.screenshot({ path: "outputs/blackjack-dual-result.png", fullPage: true });
  });

  await check("E. 乙刷新后凭服务器快照恢复身份与手牌", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const before = await readState(guest);
    await guest.reload({ waitUntil: "networkidle" });
    await waitInRoom(guest);
    await waitState(guest, (s, exp) => s.over && s.moves === exp, before.moves);
    const after = await readState(guest);
    assertEq(after.mySeatIndex, before.mySeatIndex, "座位不变");
    assertEq(JSON.stringify(after.myHand), JSON.stringify(before.myHand), "手牌完整恢复");
    assertEq((await readState(host)).moves, before.moves, "甲侧不受影响");
  });

  await check("F. 房主开新一局：筹码延续、重新发牌、庄家重新隐藏", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const chipsBefore = (await readState(host)).seats.map((seat) => seat.chips);
    await host.click("#startBlackjackBtn");
    await Promise.all([waitState(host, (s) => s.phase === "player" && !s.over && s.moves === 0), waitState(guest, (s) => s.phase === "player" && !s.over && s.moves === 0)]);
    const hostState = await readState(host);
    assertEq(hostState.myHand.length, 2, "重新发 2 张");
    assertEq(hostState.dealer.cards.length, 1, "庄家暗牌重新隐藏");
    assertEq(hostState.dealer.handCount, 2, "庄家 2 张");
    assertEq(hostState.seats.map((seat) => seat.chips), chipsBefore, "筹码延续");
  });

  await check("G. 房主重置：筹码回到起始值，回到等待", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#resetBlackjackBtn");
    await Promise.all([waitState(host, (s) => s.started === false), waitState(guest, (s) => s.started === false)]);
    const hostState = await readState(host);
    assertEq(hostState.phase, "idle", "回到等待");
    assertEq(hostState.myHand, [], "手牌已清空");
    assertEq(hostState.seats.map((seat) => seat.chips), [rules.START_CHIPS, rules.START_CHIPS], "筹码复位");
  });

  await check("H. 乙离开：甲侧回到等待状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await guest.click("#leaveRoomBtn");
    await waitState(host, (s) => s.seats.length === 1, 10000);
    const hostState = await readState(host);
    assertEq(hostState.seats.length, 1, "剩一个座位");
    assertEq(hostState.myHand, [], "手牌已清空");
    await waitState(guest, (s) => s.room.roomId === "");
  });

  await check("I. 全程只使用自建 /ws，无 PeerJS/Supabase/WebRTC 外连", async () => {
    const forbidden = ["peerjs", "supabase", "webrtc", "stun:", "turn:"];
    const offOrigin = requests.filter((url) => /^https?:/i.test(url) && !url.startsWith(BASE_URL));
    assertEq(offOrigin, [], "存在非同源 HTTP 请求");
    const hits = requests.filter((url) => forbidden.some((word) => url.toLowerCase().includes(word)));
    assertEq(hits, [], "存在 PeerJS/Supabase/WebRTC 相关请求");
    assertEq(consoleErrors, [], "页面存在 console error / pageerror");
  });

  await contextA.close();
  await contextB.close();
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
