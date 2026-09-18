/**
 * 斗地主三浏览器联机验收（Playwright，三个互不共享 localStorage 的浏览器上下文）。
 *
 * 全部走真实链路：
 *   Browser A/B/C → WSS → Node 服务器 → WSS → Browser A/B/C
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过
 * 前端拦截，用来证明服务器自己会拒绝）。
 *
 * 覆盖：建房 → 两位访客经邀请链接加入 → 满员自动发牌 → 页面级隐私断言
 * （他人手牌内容不出现在本地状态）→ 真实点击叫分 → 真实点击提示/出牌/不出 →
 * 越权被拒 → 刷新恢复 → 提示策略驱动完整一局 → 房主重发 → 离开。
 *
 * 运行方式：node tests/landlord-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18093 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const rules = require("../landlord-rules");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18093;
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
 * 用真实点击驱动一局到有人出完：当前玩家点"提示"，有牌可出则点"出牌"，
 * 否则点"不出"；三端等待 moves 同步。
 *
 * @param {Array<import("playwright").Page>} pages - 三个座位页面（按座位顺序）。
 * @param {number} [maxRounds] - 最大行动数。
 * @returns {Promise<object>} 结束时的状态。
 */
async function driveToFinish(pages, maxRounds = 400) {
  // 1. 先拿到当前局面，之后每轮"按当前状态行动 -> 等待三端同步"。
  let state = await readState(pages[0]);
  for (let round = 0; round < maxRounds; round += 1) {
    if (state.over) return state;
    const lastMoves = state.moves;
    const seat = state.turn;
    const page = pages[seat];
    await waitState(page, (s, exp) => s.phase === "playing" && !s.over && s.turn === exp, seat);
    // 2. 点提示（本地规则计算，不产生服务器请求）。
    await page.click("#hintCardsBtn");
    const hinted = await readState(page);
    if (hinted.selectedCount > 0) {
      await page.click("#playCardsBtn");
    } else {
      await page.click("#passCardsBtn");
    }
    // 3. 三端等待 moves 推进。
    await Promise.all(pages.map((p) => waitState(p, (s, exp) => s.over || s.moves === exp, lastMoves + 1, 10000)));
    state = await readState(pages[0]);
    // 4. 限速：压到服务器限流阈值之下。
    await page.waitForTimeout(150);
  }
  throw new Error(`驱动 ${maxRounds} 轮仍未分出胜负`);
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

  const contexts = [];
  for (let i = 0; i < 3; i += 1) {
    const context = await browser.newContext({ viewport: { width: 1366, height: 900 } });
    await context.addInitScript((index) => {
      try {
        localStorage.setItem("linkplay-name", ["地主甲", "农民乙", "农民丙"][index]);
      } catch {
        /* 隐私模式忽略 */
      }
    }, i);
    contexts.push(context);
  }
  const roomId = { value: "" };

  await check("A. 房主创建房间并拿到服务器房间码", async () => {
    const host = await contexts[0].newPage();
    await host.goto(`${BASE_URL}/landlord.html`, { waitUntil: "networkidle" });
    await host.click("#hostBtn");
    await waitInRoom(host);
    const state = await readState(host);
    roomId.value = state.room.roomId;
    assert(/^DD[A-Z0-9]{6}$/.test(roomId.value), `房间码应为 DD+6 位，实际 ${roomId.value}`);
    assertEq(state.phase, "idle", "未开局");
    assertEq(state.mySeatIndex, 0, "房主坐 0 号位");
    assert(await host.locator("#leaveRoomBtn").isVisible(), "房内应显示退出按钮");
    assert(await host.inputValue("#shareInput").then((v) => v.includes(`room=${roomId.value}`)), "邀请链接应带房间码");
  });

  await check("B. 两位访客经邀请链接加入，满员自动发牌", async () => {
    const host = contexts[0].pages()[0];
    const invite = await host.inputValue("#shareInput");
    const guestB = await contexts[1].newPage();
    await guestB.goto(invite, { waitUntil: "networkidle" });
    await waitInRoom(guestB);
    const guestC = await contexts[2].newPage();
    await guestC.goto(invite, { waitUntil: "networkidle" });
    await waitInRoom(guestC);
    // 1. 三端都看到发牌完成（叫分阶段）。
    await Promise.all([
      waitState(host, (s) => s.phase === "bidding"),
      waitState(guestB, (s) => s.phase === "bidding"),
      waitState(guestC, (s) => s.phase === "bidding"),
    ]);
    const states = await Promise.all([host, guestB, guestC].map((p) => readState(p)));
    states.forEach((state, index) => {
      assertEq(state.mySeatIndex, index, `座位 ${index}`);
      assertEq(state.myHand.length, 17, `${index} 号位 17 张手牌`);
      assertEq(state.bottomRevealed, false, "底牌未公布");
      state.seats.forEach((seat) => {
        assertEq(seat.handCount, 17, "座位剩余张数");
        assert(!("hand" in seat), "座位信息不得包含 hand 字段");
      });
    });
    // 2. 三家手牌互不重叠。
    const all = states.flatMap((state) => state.myHand.map((card) => card.id));
    assertEq(new Set(all).size, 51, "三家手牌无重叠");
  });

  await check("C. 页面级隐私：他人手牌内容不出现在本地状态", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    const states = await Promise.all(pages.map((p) => readState(p)));
    // 1. 每个页面的状态文本中不得出现其他玩家手牌的任何牌 id。
    states.forEach((state, index) => {
      const text = JSON.stringify(state);
      states.forEach((other, otherIndex) => {
        if (otherIndex === index) return;
        other.myHand.forEach((card) => {
          assert(!text.includes(`"${card.id}"`), `页面 ${index} 的状态泄漏了页面 ${otherIndex} 的手牌 ${card.id}`);
        });
      });
    });
  });

  await check("D. 真实点击叫分：甲叫、乙不叫、丙抢，丙成为地主", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    // 1. 乙抢先叫被服务器拒绝（绕过前端拦截验证服务端校验）。
    const denied = await sendActionRaw(pages[1], "bid", { call: true });
    assertEq(denied.ok, false, "越权叫分应被拒");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    // 2. 甲叫地主。
    await pages[0].click("#callLandlordBtn");
    await Promise.all(pages.map((p) => waitState(p, (s, exp) => s.multiplier === exp, 2)));
    // 3. 乙不叫。
    await pages[1].click("#passBidBtn");
    await Promise.all(pages.map((p) => waitState(p, (s, exp) => s.biddingTurn === exp, 2)));
    // 4. 丙抢地主 → 进入出牌阶段。
    await pages[2].click("#callLandlordBtn");
    await Promise.all(pages.map((p) => waitState(p, (s) => s.phase === "playing")));
    const states = await Promise.all(pages.map((p) => readState(p)));
    states.forEach((state) => {
      assertEq(state.landlordIndex, 2, "丙是地主");
      assertEq(state.multiplier, 4, "倍率 x4");
      assertEq(state.turn, 2, "地主先出");
      assertEq(state.bottomRevealed, true, "底牌已公布");
      assertEq(state.bottomCards.length, 3, "底牌公开可见");
    });
    assertEq(states[2].myHand.length, 20, "地主 20 张");
    assertEq(states[0].seats[2].handCount, 20, "甲视角地主 20 张");
  });

  await check("E. 真实点击出牌与不出：三端同步", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    // 1. 丙点提示再点出牌。
    await pages[2].click("#hintCardsBtn");
    const hinted = await readState(pages[2]);
    assert(hinted.selectedCount > 0, "提示应选中一组牌");
    await pages[2].click("#playCardsBtn");
    await Promise.all(pages.map((p) => waitState(p, (s, exp) => s.moves === exp, 4)));
    const states = await Promise.all(pages.map((p) => readState(p)));
    states.forEach((state) => {
      assert(state.lastPlay && state.lastPlay.cards.length > 0, "上一手公开");
      assertEq(state.seats[2].handCount, 19, "地主剩 19 张");
      assertEq(state.turn, 0, "轮到甲");
    });
    // 2. 甲乙不出（清一轮，交回丙领出）。
    await pages[0].click("#passCardsBtn");
    await pages[1].click("#passCardsBtn");
    await Promise.all(pages.map((p) => waitState(p, (s) => s.lastPlay === null)));
    const after = await readState(pages[2]);
    assertEq(after.turn, 2, "轮回地主领出");
  });

  await check("F. 越权出牌被服务器拒绝且状态不变", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    const state = await readState(pages[0]);
    const denied = await sendActionRaw(pages[0], "play", { cards: [state.myHand[0].id] });
    assertEq(denied.ok, false, "越权出牌应被拒");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    const after = await readState(pages[2]);
    assertEq(after.moves, state.moves, "状态未变化");
  });

  await check("G. 乙刷新后凭服务器快照恢复身份与手牌", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    const before = await readState(pages[1]);
    await pages[1].reload({ waitUntil: "networkidle" });
    await waitInRoom(pages[1]);
    await waitState(pages[1], (s, exp) => s.moves === exp, before.moves);
    const after = await readState(pages[1]);
    assertEq(after.mySeatIndex, before.mySeatIndex, "座位不变");
    assertEq(JSON.stringify(after.myHand), JSON.stringify(before.myHand), "手牌完整恢复");
    // 1. 刷新后的页面同样不泄漏他人手牌（已公开的牌豁免：公布的底牌 + 已出的牌）。
    const others = [await readState(pages[0]), await readState(pages[2])];
    const allowed = new Set([...after.bottomCards.map((card) => card.id), ...(after.lastPlay?.cards || []).map((card) => card.id)]);
    const text = JSON.stringify(after);
    others.forEach((other, index) => {
      other.myHand.forEach((card) => {
        if (allowed.has(card.id)) return;
        assert(!text.includes(`"${card.id}"`), `刷新后页面泄漏了页面 ${index === 0 ? 0 : 2} 的手牌 ${card.id}`);
      });
    });
  });

  await check("H. 提示策略驱动完整一局：有人出完，三端一致", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    const final = await driveToFinish(pages);
    assertEq(final.over, true, "对局结束");
    assert(final.winnerSeat !== null, "有胜者座位");
    assertEq(final.seats[final.winnerSeat].handCount, 0, "胜者手牌出完");
    // 1. 三端一致。
    const states = await Promise.all(pages.map((p) => readState(p)));
    states.forEach((state) => {
      assertEq(state.over, true, "各端都看到结束");
      assertEq(state.winnerSeat, final.winnerSeat, "各端胜者一致");
    });
    // 2. 结束后不能再行动。
    const denied = await sendActionRaw(pages[0], "pass");
    assertEq(denied.ok, false, "结束后不应再能行动");
    assertEq(denied.code, "GAME_ALREADY_FINISHED", "错误码");
    await pages[0].screenshot({ path: "outputs/landlord-dual-result.png", fullPage: true });
  });

  await check("I. 房主重新发牌：回到叫分，底牌重新隐藏", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    await pages[0].click("#resetLandlordBtn");
    await Promise.all(pages.map((p) => waitState(p, (s) => s.phase === "bidding" && s.moves === 0)));
    const states = await Promise.all(pages.map((p) => readState(p)));
    states.forEach((state) => {
      assertEq(state.myHand.length, 17, "重新发 17 张");
      assertEq(state.multiplier, 1, "倍率归位");
      assertEq(state.bottomRevealed, false, "底牌重新隐藏");
      assertEq(state.bottomCards, [], "底牌内容不下发");
    });
  });

  await check("J. 丙离开：房间回到等待，隐私数据清空", async () => {
    const pages = contexts.map((context) => context.pages()[0]);
    await pages[2].click("#leaveRoomBtn");
    await Promise.all([waitState(pages[0], (s) => s.started === false), waitState(pages[1], (s) => s.started === false)]);
    const state = await readState(pages[0]);
    assertEq(state.phase, "idle", "回到等待");
    assertEq(state.myHand, [], "手牌已清空");
    await waitState(pages[2], (s) => s.room.roomId === "");
  });

  await check("K. 全程只使用自建 /ws，无 PeerJS/Supabase/WebRTC 外连", async () => {
    const forbidden = ["peerjs", "supabase", "webrtc", "stun:", "turn:"];
    const offOrigin = requests.filter((url) => /^https?:/i.test(url) && !url.startsWith(BASE_URL));
    assertEq(offOrigin, [], "存在非同源 HTTP 请求");
    const hits = requests.filter((url) => forbidden.some((word) => url.toLowerCase().includes(word)));
    assertEq(hits, [], "存在 PeerJS/Supabase/WebRTC 相关请求");
    assertEq(consoleErrors, [], "页面存在 console error / pageerror");
  });

  for (const context of contexts) await context.close();
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
