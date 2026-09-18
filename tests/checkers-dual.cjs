/**
 * 跳棋双浏览器联机验收（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 全部走真实链路：
 *   Browser A → WSS → Node 服务器 → WSS → Browser B
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过
 * 前端拦截，用来证明服务器自己会拒绝）。
 *
 * 覆盖：建房（选定 2 人）→ 邀请链接加入 → 满员自动开局 → 越权被拒 →
 * 选子/走子真实点击同步 → 刷新重连 → 贪心驱动完整一局到分出胜负 →
 * 房主重开 → 离开房间。
 *
 * 运行方式：node tests/checkers-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18087 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const rules = require("../checkers-rules");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18087;
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
 * 在跳棋棋盘上点击指定格子（真实点击按钮，不调用前端函数）。
 *
 * @param {import("playwright").Page} page - 目标页面。
 * @param {number} row - 行号。
 * @param {number} index - 行内序号。
 */
async function clickCell(page, row, index) {
  await page.click(`#checkersBoard .chinese-hole[data-row="${row}"][data-index="${index}"]`);
  await page.waitForTimeout(60);
}

/**
 * 向服务器直接发送一次 game.action（绕过客户端本地拦截）。
 *
 * 用于验证服务端越权校验，而不是只验证前端按钮禁用。
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
 * 在指定页面上执行一次"选子 + 走子"的真实点击，并等待双端同步。
 *
 * @param {import("playwright").Page} moverPage - 走子方的页面。
 * @param {import("playwright").Page} otherPage - 对手页面。
 * @param {{row: number, index: number}} from - 起点格。
 * @param {{row: number, index: number}} to - 终点格。
 * @param {number} expectedMoves - 走完后双方应看到的手数。
 */
async function playMove(moverPage, otherPage, from, to, expectedMoves) {
  await clickCell(moverPage, from.row, from.index);
  await clickCell(moverPage, to.row, to.index);
  await Promise.all([
    waitState(moverPage, (s, expected) => s.moves === expected, expectedMoves, 10000),
    waitState(otherPage, (s, expected) => s.moves === expected, expectedMoves, 10000),
  ]);
}

/**
 * 贪心驱动一局双人局直到红方（0 号位）获胜（页面真实点击）。
 *
 * 红方每步选择"距目标区域最近"的落点（避开最近走过的位置防振荡）；
 * 蓝方每步选择离自己当前位置最近的落点（原地徘徊）。
 *
 * @param {import("playwright").Page} hostPage - 红方（房主）页面。
 * @param {import("playwright").Page} guestPage - 蓝方页面。
 * @param {number} [maxRounds] - 最大回合数。
 */
async function driveToWin(hostPage, guestPage, maxRounds = 200) {
  const redTrail = [];
  // 1. 以进入驱动时的已有手数为基数（前面的用例可能已经走过几步）。
  const base = (await readState(hostPage)).moves;
  for (let round = 0; round < maxRounds; round += 1) {
    const expectedTurn = round % 2;
    const moverPage = expectedTurn === 0 ? hostPage : guestPage;
    if (process.env.CHECKERS_DEBUG) console.log(`    [drive] round=${round} waiting turn=${expectedTurn}`);
    await waitState(moverPage, (s, expected) => s.over || (s.started && s.turn === expected), expectedTurn);
    const state = await readState(moverPage);
    if (state.over) return state;
    const piece = state.players[state.turn];
    const cell = rules.cellAt(piece.row, piece.index);
    const targets = rules.moveTargets(state.players, cell);
    if (!targets.length) throw new Error(`座位 ${state.turn} 无棋可走（不应该发生在星形棋盘上）`);
    let chosen;
    if (state.turn === 0) {
      // 1. 红方：按到目标区域的距离排序，优先选最近走过的位置之外的落点。
      const ranked = targets
        .map((t) => ({ t, d: Math.min(...rules.cellsByRegion(piece.target).map((g) => Math.hypot(g.x - t.x, (g.y - t.y) * 0.88))) }))
        .sort((a, b) => a.d - b.d);
      chosen = ranked.find((item) => !redTrail.some((p) => p.row === item.t.row && p.index === item.t.index)) || ranked[0];
      redTrail.push({ ...chosen.t });
      if (redTrail.length > 8) redTrail.shift();
    } else {
      // 2. 蓝方：选离当前位置最近的落点（小步徘徊）。
      const ranked = targets
        .map((t) => ({ t, d: Math.hypot(t.x - cell.x, (t.y - cell.y) * 0.88) }))
        .sort((a, b) => a.d - b.d);
      chosen = ranked[0];
    }
    const otherPage = expectedTurn === 0 ? guestPage : hostPage;
    if (process.env.CHECKERS_DEBUG) console.log(`    [drive] round=${round} seat=${state.turn} move ${JSON.stringify(piece.row + "," + piece.index)} -> ${JSON.stringify(chosen.t.row + "," + chosen.t.index)}`);
    await playMove(moverPage, otherPage, { row: piece.row, index: piece.index }, chosen.t, base + round + 1);
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

  // 2. 网络观测容器：记录所有请求与 WebSocket，用于"仅自建 WS"断言。
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
    await host.goto(`${BASE_URL}/checkers.html`, { waitUntil: "networkidle" });
    // 1. 人数保持默认 2 人（select 默认值）。
    await host.click("#hostBtn");
    await waitInRoom(host);
    const state = await readState(host);
    roomId.value = state.room.roomId;
    assert(/^TQ[A-Z0-9]{6}$/.test(roomId.value), `房间码应为 TQ+6 位，实际 ${roomId.value}`);
    assertEq(state.playerCount, 2, "房间为 2 人局");
    assertEq(state.started, false, "单人未开局");
    assertEq(state.mySeatIndex, 0, "房主坐 0 号位（红方）");
    assertEq(state.players.length, 0, "未开局无棋子");
    assert(await host.locator("#leaveRoomBtn").isVisible(), "房内应显示退出按钮");
    assert(await host.inputValue("#shareInput").then((v) => v.includes(`room=${roomId.value}`)), "邀请链接应带房间码");
    // 2. 进房后人数选择应锁定。
    assert(await host.locator("#checkersPlayerCount").isDisabled(), "进房后人数选择应锁定");
  });

  await check("B. 访客经邀请链接加入，满员自动开局，双端状态一致", async () => {
    const host = contextA.pages()[0];
    const guest = await contextB.newPage();
    const invite = await host.inputValue("#shareInput");
    await guest.goto(invite, { waitUntil: "networkidle" });
    await waitInRoom(guest);
    // 1. 双端都应看到开局（房主侧经广播，不能靠刷新补洞）。
    await Promise.all([waitState(host, (s) => s.started, 10000), waitState(guest, (s) => s.started, 10000)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.room.roomId, roomId.value, "访客应进入同一房间");
    assertEq(guestState.mySeatIndex, 1, "访客坐 1 号位（蓝方）");
    assertEq(guestState.playerCount, 2, "访客看到 2 人局");
    assertEq(guestState.players.length, 2, "两颗棋子");
    assertEq(JSON.stringify({ p: guestState.players, t: guestState.turn }), JSON.stringify({ p: hostState.players, t: hostState.turn }), "双端棋子与轮次一致");
    assertEq(guestState.players.map((p) => p.color), ["red", "blue"], "座位颜色");
    assertEq(guestState.players[0].name, "房主甲", "红方昵称");
    assertEq(guestState.players[1].name, "玩家乙", "蓝方昵称");
  });

  await check("C. 蓝方越权走子被服务器拒绝且棋盘不变", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const state = await readState(guest);
    const piece = state.players[1];
    const denied = await sendActionRaw(guest, "move", { from: { row: piece.row, index: piece.index }, to: { row: 0, index: 0 } });
    assertEq(denied.ok, false, "服务端应拒绝越权走子");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    assertEq((await readState(host)).moves, 0, "越权走子不应改动房主棋盘");
  });

  await check("D. 红方选子走子同步到对手，两端状态一致", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const state = await readState(host);
    const piece = state.players[0];
    const to = rules.moveTargets(state.players, rules.cellAt(piece.row, piece.index))[0];
    // 1. 选子后应出现高亮目标格（本地提示）。
    await clickCell(host, piece.row, piece.index);
    const highlighted = await host.locator("#checkersBoard .chinese-hole.target").count();
    assert(highlighted >= 1, "选子后应有高亮落点");
    // 2. 点击目标格走子，双端同步。
    await clickCell(host, to.row, to.index);
    await Promise.all([waitState(host, (s) => s.moves === 1), waitState(guest, (s) => s.moves === 1)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.turn, 1, "轮到蓝方");
    assertEq(JSON.stringify({ p: guestState.players, t: guestState.turn }), JSON.stringify({ p: hostState.players, t: hostState.turn }), "双端一致");
  });

  await check("E. 蓝方真实点击走子，房主侧同步", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const state = await readState(guest);
    const piece = state.players[1];
    const to = rules.moveTargets(state.players, rules.cellAt(piece.row, piece.index))[0];
    await playMove(guest, host, { row: piece.row, index: piece.index }, to, 2);
    const hostState = await readState(host);
    assertEq(hostState.turn, 0, "轮回红方");
    assertEq(hostState.players[1].row === to.row && hostState.players[1].index === to.index, true, "蓝棋已同步移动");
  });

  await check("F. 访客刷新后凭服务器快照恢复身份与棋盘", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const before = await readState(guest);
    await guest.reload({ waitUntil: "networkidle" });
    await waitInRoom(guest);
    await waitState(guest, (s, expected) => s.moves === expected, before.moves);
    const after = await readState(guest);
    assertEq(after.mySeatIndex, before.mySeatIndex, "刷新后座位不变");
    assertEq(after.moves, before.moves, "刷新后手数一致");
    assertEq(JSON.stringify(after.players), JSON.stringify(before.players), "刷新后棋子一致");
    // 房主侧不受影响。
    assertEq((await readState(host)).moves, before.moves, "房主侧棋盘不受影响");
  });

  await check("G. 贪心驱动完整一局：红方到达目标区获胜，双端胜负一致", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const final = await driveToWin(host, guest);
    assertEq(final.over, true, "对局结束");
    assertEq(final.winner, "red", "红方获胜");
    assert(final.moves > 4, `应有多步走子，实际 ${final.moves}`);
    // 1. 双端一致。
    await Promise.all([waitState(host, (s) => s.over), waitState(guest, (s) => s.over)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.winner, hostState.winner, "双端胜方一致");
    assertEq(JSON.stringify(guestState.players), JSON.stringify(hostState.players), "双端棋子一致");
    // 2. 结束后走子被服务器拒绝。
    const piece = hostState.players[0];
    const denied = await sendActionRaw(host, "move", { from: { row: piece.row, index: piece.index }, to: { row: 0, index: 0 } });
    assertEq(denied.ok, false, "结束后不应再能走子");
    assertEq(denied.code, "GAME_ALREADY_FINISHED", "错误码");
    await host.screenshot({ path: "outputs/checkers-dual-result.png", fullPage: true });
  });

  await check("H. 房主重开：清盘归零，双端回到开局状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#resetCheckersBtn");
    await Promise.all([waitState(host, (s) => s.started && s.moves === 0 && s.over === false), waitState(guest, (s) => s.started && s.moves === 0 && s.over === false)]);
    const hostState = await readState(host);
    const initial = rules.createPieces(2);
    assertEq(
      hostState.players.map((p) => `${p.row}-${p.index}`),
      initial.map((p) => `${p.row}-${p.index}`),
      "棋子回到出发格",
    );
    assertEq(hostState.turn, 0, "轮次归零");
    assertEq(hostState.winner, null, "无胜者");
  });

  await check("I. 访客离开：房主侧回到等待状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await guest.click("#leaveRoomBtn");
    await waitState(host, (s) => s.started === false, 10000);
    const hostState = await readState(host);
    assertEq(hostState.players.length, 0, "棋盘已清空");
    assertEq(hostState.message.includes("离开"), true, `应提示离开，实际 ${hostState.message}`);
    // 访客侧回到未进房状态。
    await waitState(guest, (s) => s.room.roomId === "");
  });

  await check("J. 全程只使用自建 /ws，无 PeerJS/Supabase/WebRTC 外连", async () => {
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
