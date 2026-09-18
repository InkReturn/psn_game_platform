/**
 * 全量测试入口。
 *
 * 职责：
 *   1. 在测试端口拉起一份被测服务器（静态资源 + WebSocket），供浏览器类用例复用；
 *   2. 依次执行协议测试与各浏览器冒烟测试，注入 BASE_URL；
 *   3. 汇总每个测试文件的退出码，任一失败则整体退出非零。
 *
 * 运行方式：npm test（等价于 node tests/run-all.cjs）
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");

/** 浏览器类用例共用的站点端口。 */
const APP_PORT = 18080;
/** 站点地址（浏览器类用例通过 BASE_URL 读取）。 */
const BASE_URL = `http://127.0.0.1:${APP_PORT}`;

/** 待执行用例：文件路径 + 说明。 */
const SUITES = [
  { file: "tests/server-protocol.cjs", label: "服务端协议（WS 直连）" },
  { file: "tests/room-sync.cjs", label: "房间成员实时同步回归（双客户端）" },
  { file: "tests/animal-chess-rules.cjs", label: "斗兽棋规则单元测试" },
  { file: "tests/grid-rules.cjs", label: "棋类规则单元测试（井字棋/黑白棋/四子棋/五子棋引擎）" },
  { file: "tests/grid-authority.cjs", label: "棋类权威房间 WS 联机测试（伪造状态被拒）" },
  { file: "tests/checkers-rules.cjs", label: "跳棋规则单元测试" },
  { file: "tests/checkers-authority.cjs", label: "跳棋权威房间 WS 联机测试（多人座位/越权/重连）" },
  { file: "tests/animal-chess-dual.cjs", label: "斗兽棋服务器权威双客户端验收" },
  { file: "tests/lobby-smoke.cjs", label: "大厅 → 五子棋导航" },
  { file: "tests/gomoku-smoke.cjs", label: "五子棋冒烟（联机 + 本地）" },
  { file: "tests/games-smoke.cjs", label: "联机游戏建房（relay 五款 + 斗兽棋/跳棋权威房）" },
  { file: "tests/grid-games-smoke.cjs", label: "棋盘类游戏本地规则" },
  { file: "tests/gomoku-dual.cjs", label: "五子棋双端联机验收" },
  { file: "tests/grid-dual.cjs", label: "棋类游戏双浏览器联机验收（井字棋/四子棋/黑白棋）" },
  { file: "tests/checkers-dual.cjs", label: "跳棋双浏览器联机验收（完整一局/重开/离开）" },
];

/** 被测服务器进程。 */
let appServer = null;

/**
 * 启动被测服务器并等待其就绪。
 *
 * @param {number} [timeoutMs] - 等待就绪的最长毫秒数。
 * @returns {Promise<void>} 就绪后 resolve；提前退出或超时抛错。
 */
async function startAppServer(timeoutMs = 20000) {
  // 1. 拉起服务器进程，输出直接透传便于排查。
  appServer = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
    env: { ...process.env, PORT: String(APP_PORT), BIND_HOST: "127.0.0.1" },
    stdio: ["ignore", "inherit", "inherit"],
  });
  // 2. 轮询 /health 直到可服务（不能用固定 sleep：冷启动耗时不确定）。
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (appServer.exitCode !== null) throw new Error(`app server exited early (code ${appServer.exitCode})`);
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`app server not ready after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 执行一个测试文件。
 *
 * @param {{file: string, label: string}} suite - 用例描述。
 * @returns {Promise<{label: string, file: string, code: number}>} 执行结果（code 为子进程退出码）。
 */
function runSuite(suite) {
  return new Promise((resolve) => {
    console.log(`\n=== ${suite.label} (${suite.file}) ===`);
    // 1. 以当前 Node 执行用例文件，注入 BASE_URL 供浏览器类用例使用。
    const child = spawn(process.execPath, [suite.file], {
      cwd: path.join(__dirname, ".."),
      env: { ...process.env, BASE_URL },
      stdio: "inherit",
    });
    child.on("close", (code) => resolve({ label: suite.label, file: suite.file, code: code === null ? 1 : code }));
  });
}

(async () => {
  // 1. 启动共享被测服务器。
  await startAppServer();

  // 2. 顺序执行全部用例（浏览器类用例串行，避免资源竞争导致的假失败）。
  const outcomes = [];
  for (const suite of SUITES) {
    outcomes.push(await runSuite(suite));
  }

  // 3. 收尾：关闭服务器。
  appServer.kill("SIGTERM");
  await new Promise((resolve) => setTimeout(resolve, 300));

  // 4. 汇总结果。
  const failed = outcomes.filter((o) => o.code !== 0);
  console.log("\n=== 汇总 ===");
  for (const o of outcomes) console.log(`${o.code === 0 ? "OK  " : "FAIL"} ${o.label} (${o.file})`);
  console.log(`\n${outcomes.length - failed.length}/${outcomes.length} 个测试文件通过`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("test runner failed:", err);
  if (appServer) appServer.kill("SIGKILL");
  process.exit(1);
});
