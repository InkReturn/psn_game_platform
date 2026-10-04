"use strict";
const fs = require("node:fs");
const path = require("node:path");
const net = require("node:net");
const { spawn } = require("node:child_process");
const { setTimeout: delay } = require("node:timers/promises");
const { readLocalJson } = require("./local-health.cjs");
const root = path.resolve(__dirname, "..");
const platformPort = Number(process.env.PORT || 8080);
const children = [];
let stopping = false;

/**
 * 确认端口由本启动器创建，不复用或终止未知的现有服务。
 * @param {number} port 即将占用的回环端口。
 * @returns {Promise<void>} 空闲时完成；冲突时拒绝启动。
 */
function checkPort(port) {
  // 1. 用短暂监听验证端口空闲，结束后立即释放。
  return new Promise(checkPortExecutor.bind(null, port));
}

/**
 * 执行端口预检；不会终止任何现有进程。
 * @param {number} port 待检查端口。
 * @param {Function} resolve Promise 成功回调。
 * @param {Function} reject Promise 失败回调。
 */
function checkPortExecutor(port, resolve, reject) {
  // 1. 监听失败直接拒绝，成功后关闭预检监听。
  const probe = net.createServer();
  probe.once("error", reject);
  probe.listen(port, "127.0.0.1", portAvailable.bind(null, probe, resolve));
}

/**
 * 释放预检端口后报告成功。
 * @param {import('node:net').Server} probe 临时预检监听。
 * @param {Function} resolve 端口预检 Promise 成功回调。
 */
function portAvailable(probe, resolve) {
  // 1. 关闭临时监听，不留下后台服务。
  probe.close(resolve);
}

/**
 * 启动独立游戏进程，继承日志但不继承对外绑定配置。
 * @param {string} name 用于错误定位的服务名称。
 * @param {string[]} args Node 的脚本路径和参数。
 * @param {Object} environment 仅用于此子进程的环境变量覆盖。
 */
function launch(name, args, environment = {}) {
  // 1. 使用当前 Node 与明确的项目根路径启动，禁止 shell 拼接。
  const child = spawn(process.execPath, args, {
    cwd: root, stdio: "inherit", env: { ...process.env, BIND_HOST: "127.0.0.1", ...environment },
  });
  children.push(child);
  // 2. 一个进程失败时清理本启动器的其余进程，不留下半启动状态。
  child.once("error", startupFailed);
  child.once("exit", childExited.bind(null, name));
}

/**
 * 响应子进程退出并清理其它受管进程。
 * @param {string} name 退出服务的名称。
 * @param {number|null} code 子进程退出码。
 * @param {string|null} signal 子进程终止信号。
 */
function childExited(name, code, signal) {
  // 1. 用户主动停止期间不重复报告故障。
  if (stopping) return;
  console.error(`[arcade] ${name} exited (${code ?? signal})`);
  stop(1);
}

/**
 * 关闭仅由当前启动器创建的进程，退出平台试玩。
 * @param {number} code 启动器退出码，0 表示用户主动停止。
 */
function stop(code = 0) {
  // 1. 避免重复关闭，并只终止拥有的子进程对象。
  if (stopping) return;
  stopping = true;
  for (const child of children) child.kill("SIGTERM");
  // 2. 给子进程清理时间，随后终止残留的受管进程并退出。
  setTimeout(finishStop.bind(null, code), 3500);
}

/**
 * 完成受管进程清理并退出启动器。
 * @param {number} code 最终进程退出码。
 */
function finishStop(code) {
  // 1. 只清理本启动器持有的进程，不按端口猜测 PID。
  for (const child of children) if (child.exitCode === null) child.kill("SIGKILL");
  process.exit(code);
}

/**
 * 输出启动故障并清理已启动服务。
 * @param {Error} error 端口、依赖或子进程启动异常。
 */
function startupFailed(error) {
  // 1. 错误必须可见，不把失败的游戏标为可玩。
  console.error("[arcade] startup failed:", error.message);
  stop(1);
}

/** 用户主动停止试玩，释放所有本启动器创建的子进程。 */
function requestedStop() {
  // 1. 统一清理所有受管服务。
  stop(0);
}

/**
 * 有界等待三个服务就绪，并给出可访问的试玩地址。
 * @returns {Promise<void>} 服务全部就绪后完成；失败时拒绝。
 */
async function start() {
  // 1. 预检依赖与固定回环端口；缺失依赖时提示安装命令。
  const tsx = path.join(root, "vendor/tanks-service/node_modules/tsx/dist/cli.mjs");
  if (!fs.existsSync(tsx) || !fs.existsSync(path.join(__dirname, "runtime/browserquest/node_modules/underscore"))) {
    throw new Error("请先运行 npm run arcade:install 安装独立游戏依赖");
  }
  if (!Number.isInteger(platformPort) || platformPort < 1024 || platformPort > 65535) throw new Error("PORT 必须是 1024–65535 的整数");
  const ports = [platformPort, 2567, 8093];
  if (new Set(ports).size !== ports.length) throw new Error("PORT 与独立游戏端口冲突");
  await Promise.all(ports.map(checkPort));
  // 2. 启动原有平台、坦克服务与冒险服务；不连接真实数据库。
  launch("platform", [path.join(root, "server.js")], { PORT: String(platformPort) });
  launch("tanks", [tsx, "--tsconfig", path.join(root, "vendor/tanks-service/tsconfig.json"), path.join(root, "vendor/tanks-service/src/index.ts")]);
  launch("browserquest", [path.join(__dirname, "browserquest-start.cjs")]);
  // 3. 在启动窗口内检查健康标识，而不是只看进程存在。
  const deadline = Date.now() + 30000;
  let lastStatus = "等待平台响应";
  while (!stopping && Date.now() < deadline) {
    try {
      const response = await readLocalJson(platformPort, "/api/arcade");
      const status = response.body;
      lastStatus = JSON.stringify(status.games);
      if (status.games.filter(isImported).every(isReady)) {
        console.log(`[arcade] READY http://127.0.0.1:${platformPort}/arcade.html`);
        return;
      }
    } catch (error) {
      lastStatus = error.message;
      if (!["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code) && !(error instanceof SyntaxError)) throw error;
    }
    await delay(300);
  }
  if (!stopping) throw new Error(`游戏服务未在 30 秒内全部就绪：${lastStatus}`);
}

/**
 * 筛选已引入而非待接入的游戏。
 * @param {Object} game 状态接口目录项。
 * @returns {boolean} 是否已有本地资源。
 */
function isImported(game) {
  // 1. 未接入的象棋平台不参与已引入游戏启动检查。
  return game.state === "imported";
}

/**
 * 检查目录项是否已经过健康验证。
 * @param {Object} game 状态接口目录项。
 * @returns {boolean} 是否可开始试玩。
 */
function isReady(game) {
  // 1. 只有资源及后端均就绪才算启动成功。
  return game.ready === true;
}
process.on("SIGINT", requestedStop);
process.on("SIGTERM", requestedStop);
start().catch(startupFailed);
