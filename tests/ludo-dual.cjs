/**
 * 飞行棋双浏览器联机验收（Playwright，两个互不共享 localStorage 的浏览器上下文）。
 *
 * 全部走真实链路：
 *   Browser A → WSS → Node 服务器 → WSS → Browser B
 * 不使用任何 mock，不直接调用前端函数代替点击（越权校验除外——那是故意绕过
 * 前端拦截，用来证明服务器自己会拒绝）。
 *
 * 覆盖：建房（2 人）→ 邀请链接加入 → 满员自动开局 → 越权掷骰被拒 →
 * 真实点击掷骰/移动同步 → 刷新重连 → 服务器骰子驱动完整一局到分出胜负 →
 * 房主重开 → 离开房间。
 *
 * 运行方式：node tests/ludo-dual.cjs
 *   - 未设置 BASE_URL 时自行在 18089 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器。
 */
"use strict";

const { spawn } = require("child_process");
const fs = require("fs");
const path = require("path");
const { chromium } = require("playwright");
const rules = require("../ludo-rules");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18089;
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
 * 在指定页面上执行一次"掷骰 + 选子移动"的真实点击，并等待双端同步。
 *
 * @param {import("playwright").Page} moverPage - 走子方页面。
 * @param {import("playwright").Page} otherPage - 对手页面。
 * @param {number} pieceIndex - 要移动的飞机下标。
 * @param {number} expectedMoves - 走完后双方应看到的手数。
 */
async function playTurn(moverPage, otherPage, pieceIndex, expectedMoves) {
  await moverPage.click("#rollLudoBtn");
  await waitState(moverPage, (s) => s.dice >= 1, null, 10000);
  await moverPage.click(`#ludoPieces .piece-button[data-piece-index="${pieceIndex}"]`);
  await Promise.all([
    waitState(moverPage, (s, expected) => s.moves === expected, expectedMoves, 10000),
    waitState(otherPage, (s, expected) => s.moves === expected, expectedMoves, 10000),
  ]);
}

/**
 * 用服务器骰子驱动一局双人局直到分出胜负（页面真实点击）。
 *
 * 每轮从权威快照读取当前轮到的一方（不假设固定交替起点：前置用例可能已走步），
 * 走子方页面真实点击"掷骰 -> 选子"，双端等待同步。
 * 选子策略与 WS 权威测试一致：6 优先起飞，否则推进最落后的航道飞机。
 * 每轮加固定间隔把发送频率压到服务器限流（40 条 / 5 秒 / 连接）之下。
 *
 * @param {import("playwright").Page} hostPage - 红方（房主）页面。
 * @param {import("playwright").Page} guestPage - 蓝方页面。
 * @param {number} [maxRounds] - 最大回合数。
 * @returns {Promise<object>} 结束时的状态。
 */
async function driveToWin(hostPage, guestPage, maxRounds = 400) {
  for (let round = 0; round < maxRounds; round += 1) {
    // 1. 读取当前局面，确定轮到谁（over 则直接返回）。
    const current = await readState(hostPage);
    if (current.over) return current;
    const seat = current.turn;
    const moverPage = seat === 0 ? hostPage : guestPage;
    // 2. 等到走子方页面看到"轮到我且未掷骰"，真实点击掷骰。
    await waitState(moverPage, (s, exp) => s.started && s.turn === exp && s.dice === 0, seat, 10000);
    await moverPage.click("#rollLudoBtn");
    await waitState(moverPage, (s) => s.dice >= 1, null, 10000);
    const rolled = await readState(moverPage);
    // 3. 选子：6 优先起飞；否则推进最落后的航道飞机。
    const pieces = rolled.teams[seat].pieces;
    let pieceIndex = -1;
    if (rolled.dice === rules.LAUNCH_DICE) {
      pieceIndex = pieces.findIndex((pos) => pos < 0);
    }
    if (pieceIndex === -1) {
      let best = Infinity;
      pieces.forEach((pos, index) => {
        if (pos >= 0 && pos < best) {
          best = pos;
          pieceIndex = index;
        }
      });
    }
    if (pieceIndex === -1) pieceIndex = 0;
    // 4. 真实点击移动（用队伍+飞机双下标精确定位，避免命中对方队伍的禁用按钮），
    //    双端等待手数同步。
    await moverPage.click(`#ludoPieces .piece-button[data-team-index="${seat}"][data-piece-index="${pieceIndex}"]`);
    const expected = rolled.moves + 1;
    const otherPage = seat === 0 ? guestPage : hostPage;
    await Promise.all([
      waitState(moverPage, (s, exp) => s.moves === exp, expected, 10000),
      waitState(otherPage, (s, exp) => s.moves === exp, expected, 10000),
    ]);
    // 5. 限速：压到服务器限流阈值之下。
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
    await host.goto(`${BASE_URL}/ludo.html`, { waitUntil: "networkidle" });
    await host.click("#hostBtn");
    await waitInRoom(host);
    const state = await readState(host);
    roomId.value = state.room.roomId;
    assert(/^FQ[A-Z0-9]{6}$/.test(roomId.value), `房间码应为 FQ+6 位，实际 ${roomId.value}`);
    assertEq(state.playerCount, 2, "房间为 2 人局");
    assertEq(state.started, false, "单人未开局");
    assertEq(state.mySeatIndex, 0, "房主坐 0 号位（红方）");
    assert(await host.locator("#leaveRoomBtn").isVisible(), "房内应显示退出按钮");
    assert(await host.inputValue("#shareInput").then((v) => v.includes(`room=${roomId.value}`)), "邀请链接应带房间码");
    assert(await host.locator("#ludoPlayerCount").isDisabled(), "进房后人数选择应锁定");
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
    assertEq(guestState.mySeatIndex, 1, "访客坐 1 号位（蓝方）");
    assertEq(guestState.teams.length, 2, "两支队伍");
    assertEq(guestState.teams.map((t) => t.pieces), [[-1, -1], [-1, -1]], "全部待起飞");
    assertEq(JSON.stringify({ t: guestState.teams, turn: guestState.turn }), JSON.stringify({ t: hostState.teams, turn: hostState.turn }), "双端队伍与轮次一致");
    assertEq(guestState.teams[0].name, "房主甲", "红方昵称");
    assertEq(guestState.teams[1].name, "玩家乙", "蓝方昵称");
  });

  await check("C. 蓝方越权掷骰被服务器拒绝且状态不变", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const denied = await sendActionRaw(guest, "roll");
    assertEq(denied.ok, false, "服务端应拒绝越权掷骰");
    assertEq(denied.code, "NOT_YOUR_TURN", "错误码");
    assertEq((await readState(host)).dice, 0, "越权掷骰不应改动骰子");
  });

  await check("D. 红方真实点击掷骰并移动，双端同步", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#rollLudoBtn");
    await waitState(host, (s) => s.dice >= 1);
    const rolled = await readState(host);
    assert(rolled.dice >= 1 && rolled.dice <= 6, `骰点应 1..6，实际 ${rolled.dice}`);
    // 1. 双端看到同一骰子。
    await waitState(guest, (s, exp) => s.dice === exp, rolled.dice);
    // 2. 点击红方 0 号飞机（掷 6 起飞 / 非 6 轮空，均消耗回合）。
    await host.click('#ludoPieces .piece-button[data-team-index="0"][data-piece-index="0"]');
    await Promise.all([waitState(host, (s) => s.moves === 1), waitState(guest, (s) => s.moves === 1)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(hostState.turn, 1, "换手到蓝方");
    assertEq(hostState.dice, 0, "骰子已消耗");
    assertEq(JSON.stringify(guestState.teams), JSON.stringify(hostState.teams), "双端队伍一致");
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
    assertEq(JSON.stringify(after.teams), JSON.stringify(before.teams), "刷新后队伍一致");
    assertEq((await readState(host)).moves, before.moves, "房主侧棋盘不受影响");
  });

  await check("F. 服务器骰子驱动完整一局：一方集齐获胜，双端胜负一致", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    const final = await driveToWin(host, guest);
    assertEq(final.over, true, "对局结束");
    assert(["red", "blue"].includes(final.winner), `胜者应为红/蓝之一，实际 ${final.winner}`);
    const winnerTeam = final.teams.find((t) => t.color === final.winner);
    assertEq(rules.teamFinished(winnerTeam), true, "获胜队伍全部到达");
    // 1. 双端一致。
    await Promise.all([waitState(host, (s) => s.over), waitState(guest, (s) => s.over)]);
    const hostState = await readState(host);
    const guestState = await readState(guest);
    assertEq(guestState.winner, hostState.winner, "双端胜方一致");
    assertEq(JSON.stringify(guestState.teams), JSON.stringify(hostState.teams), "双端队伍一致");
    // 2. 结束后掷骰被服务器拒绝。
    const denied = await sendActionRaw(host, "roll");
    assertEq(denied.ok, false, "结束后不应再能掷骰");
    assertEq(denied.code, "GAME_ALREADY_FINISHED", "错误码");
    await host.screenshot({ path: "outputs/ludo-dual-result.png", fullPage: true });
  });

  await check("G. 房主重开：清盘归零，双端回到开局状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await host.click("#resetLudoBtn");
    await Promise.all([waitState(host, (s) => s.started && s.moves === 0 && s.over === false), waitState(guest, (s) => s.started && s.moves === 0 && s.over === false)]);
    const hostState = await readState(host);
    assertEq(hostState.teams.map((t) => t.pieces), [[-1, -1], [-1, -1]], "全部回到机场");
    assertEq(hostState.turn, 0, "轮次归零");
    assertEq(hostState.dice, 0, "骰子清空");
    assertEq(hostState.winner, null, "无胜者");
  });

  await check("H. 访客离开：房主侧回到等待状态", async () => {
    const host = contextA.pages()[0];
    const guest = contextB.pages()[0];
    await guest.click("#leaveRoomBtn");
    await waitState(host, (s) => s.started === false, null, 10000);
    const hostState = await readState(host);
    assertEq(hostState.teams.length, 0, "棋盘已清空");
    assertEq(hostState.message.includes("离开"), true, `应提示离开，实际 ${hostState.message}`);
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
