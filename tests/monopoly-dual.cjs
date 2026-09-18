/**
 * 大富翁双浏览器联机验收（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 全部走真实链路：
 *   Browser A → WSS → Node 服务器 → WSS → Browser B
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过
 * 前端拦截，用来证明服务器自己会拒绝）。
 *
 * 覆盖：建房（2 人）→ 邀请链接加入 → 满员自动开局 → 越权掷骰被拒 →
 * 真实点击掷骰/购买/跳过同步 → 刷新重连 → "红方全买 / 蓝方全跳"驱动到破产 →
 * 房主重开 → 离开房间。
 *
 * 运行方式：node tests/monopoly-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18091 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const rules = require("../monopoly-rules");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18091;
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
 * 用真实点击驱动一局双人局到破产终局：红方（房主）能买必买，蓝方全跳。
 *
 * 每轮按权威快照行动：有待购买则由待购买玩家点击买/跳，否则由当前回合方
 * 点击掷骰；双端等待 moves 同步。每轮加固定间隔压到服务器限流之下。
 *
 * @param {import("playwright").Page} hostPage - 红方（房主）页面。
 * @param {import("playwright").Page} guestPage - 蓝方页面。
 * @param {number} [maxRounds] - 最大行动数。
 * @returns {Promise<object>} 结束时的状态。
 */
async function driveToBankrupt(hostPage, guestPage, maxRounds = 600) {
  // 1. 先拿到当前局面，之后每轮"按当前状态行动 -> 等待双端同步"。
  let state = await readState(hostPage);
  for (let round = 0; round < maxRounds; round += 1) {
    if (state.over) return state;
    const lastMoves = state.moves;
    const moverPage = state.pendingPurchase ? (state.pendingPurchase.playerIndex === 0 ? hostPage : guestPage) : state.turn === 0 ? hostPage : guestPage;
    const otherPage = moverPage === hostPage ? guestPage : hostPage;
    // 2. 行动：待购买 -> 点击买/跳（红买蓝跳）；否则点击掷骰。
    if (state.pendingPurchase) {
      const buy = state.pendingPurchase.playerIndex === 0;
      await moverPage.click(buy ? "#buyPropertyBtn" : "#skipPropertyBtn");
    } else {
      await moverPage.click("#rollMonopolyBtn");
    }
    // 3. 双端等待 moves 推进。
    await Promise.all([
      waitState(moverPage, (s, exp) => s.moves === exp, lastMoves + 1, 10000),
      waitState(otherPage, (s, exp) => s.moves === exp, lastMoves + 1, 10000),
    ]);
    state = await readState(hostPage);
    // 4. 限速：压到服务器限流阈值之下。
    await moverPage.waitForTimeout(180);
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

  const contextA = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const contextB = await browser.newContext({ viewport: { width: 1366, height: 900 } });
  const roomId = { value: "" };

  await check("A. 房主选定 2 人创建房间并拿到服务器房间码", async () => {
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
    await host.goto(`${BASE_URL}/monopoly.html`, { waitUntil: "networkidle" });
    await host.click("#hostBtn");
    await waitInRoom(host);
    const state = await readState(host);
    roomId.value = state.room.roomId;
    assert(/^DF[A-Z0-9]{6}$/.test(roomId.value), `房间码应为 DF+6 位，实际 ${roomId.value}`);
    assertEq(state.playerCount, 2, "房间为 2 人局");
    assertEq(state.started, false, "单人未开局");
    assertEq(state.mySeatIndex, 0, "房主坐 0 号位");
    assert(await host.locator("#leaveRoomBtn").isVisible(), "房内应显示退出按钮");
    assert(await host.inputValue("#shareInput").then((v) => v.includes(`room=${roomId.value}`)), "邀请链接应带房间码");
    assert(await host.locator("#monopolyPlayerCount").isDisabled(), "进房后人数选择应锁定");
  });

  await check("B. 访客经邀请链接加入，满员自动开局，双端状态一致", async () => {
    const host = contextA.pages()[0];
    const guest = await contextB.newPage();
    const invite = await host.inputValue("#shareInput");
    await guest.goto(invite, { waitUntil: "networkidle" });
    await waitInRoom(guest);
    await Promise.all([waitState(host, (s) => s.started), waitState(guest, (s) => s.started)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.room.roomId, roomId.value, "访客应进入同一房间");
    assertEq(guestState.mySeatIndex, 1, "访客坐 1 号位");
    assertEq(guestState.players.length, 2, "两名玩家");
    assertEq(guestState.players.map((p) => p.money), [rules.START_MONEY, rules.START_MONEY], "起始资金");
    assertEq(JSON.stringify({ p: guestState.players, c: guestState.cells }), JSON.stringify({ p: hostState.players, c: hostState.cells }), "双端一致");
    assertEq(guestState.players[0].name, "房主甲", "红方昵称");
    assertEq(guestState.players[1].name, "玩家乙", "蓝方昵称");
  });

  await check("C. 蓝方越权掷骰被服务器拒绝且状态不变", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const denied = await sendActionRaw(guest, "roll");
    assertEq(denied.ok, false, "服务端应拒绝越权掷骰");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    assertEq((await readState(host)).moves, 0, "越权掷骰不应改动状态");
  });

  await check("D. 红方真实点击掷骰，双端同步", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#rollMonopolyBtn");
    await Promise.all([waitState(host, (s) => s.moves === 1), waitState(guest, (s) => s.moves === 1)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assert(hostState.dice >= 1 && hostState.dice <= 6, `骰点应 1..6，实际 ${hostState.dice}`);
    assertEq(guestState.dice, hostState.dice, "双端骰子一致");
    assertEq(JSON.stringify(guestState.players), JSON.stringify(hostState.players), "双端玩家一致");
  });

  await check("E. 访客刷新后凭服务器快照恢复身份与棋盘", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const before = await readState(guest);
    await guest.reload({ waitUntil: "networkidle" });
    await waitInRoom(guest);
    await waitState(guest, (s, exp) => s.moves === exp, before.moves);
    const after = await readState(guest);
    assertEq(after.mySeatIndex, before.mySeatIndex, "刷新后座位不变");
    assertEq(JSON.stringify({ p: after.players, c: after.cells }), JSON.stringify({ p: before.players, c: before.cells }), "刷新后棋盘一致");
    assertEq((await readState(host)).moves, before.moves, "房主侧棋盘不受影响");
  });

  await check("F. 真实点击驱动完整一局：一方破产终局，双端一致", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const final = await driveToBankrupt(host, guest);
    assertEq(final.over, true, "对局结束");
    const bankrupt = final.players.find((p) => p.money < 0);
    assert(bankrupt, "应有破产玩家");
    assert(final.status.includes("破产"), `状态应含破产，实际 ${final.status}`);
    assert(final.moves > 4, `应有多步行动，实际 ${final.moves}`);
    // 1. 双端一致。
    await Promise.all([waitState(host, (s) => s.over), waitState(guest, (s) => s.over)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(JSON.stringify({ p: guestState.players, c: guestState.cells }), JSON.stringify({ p: hostState.players, c: hostState.cells }), "双端一致");
    // 2. 结束后掷骰被服务器拒绝。
    const denied = await sendActionRaw(host, "roll");
    assertEq(denied.ok, false, "结束后不应再能掷骰");
    assertEq(denied.code, "GAME_ALREADY_FINISHED", "错误码");
    await host.screenshot({ path: "outputs/monopoly-dual-result.png", fullPage: true });
  });

  await check("G. 房主重开：清盘归零，双端回到开局状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#resetMonopolyBtn");
    await Promise.all([waitState(host, (s) => s.started && s.moves === 0 && s.over === false), waitState(guest, (s) => s.started && s.moves === 0 && s.over === false)]);
    const hostState = await readState(host);
    assertEq(hostState.players.map((p) => p.money), [rules.START_MONEY, rules.START_MONEY], "资金复位");
    assertEq(hostState.players.map((p) => p.pos), [0, 0], "回到起点");
    assert(hostState.cells.every((c) => c.owner === null), "地块全部无主");
    assertEq(hostState.pendingPurchase, null, "无待购买");
  });

  await check("H. 访客离开：房主侧回到等待状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await guest.click("#leaveRoomBtn");
    await waitState(host, (s) => s.started === false, null, 10000);
    const hostState = await readState(host);
    assertEq(hostState.players.length, 0, "棋盘已清空");
    assertEq(hostState.status.includes("离开"), true, `应提示离开，实际 ${hostState.status}`);
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
