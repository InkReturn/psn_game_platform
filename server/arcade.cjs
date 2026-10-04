"use strict";
const fs = require("node:fs");
const path = require("node:path");
const catalog = require("../integrations/catalog.json");
const { readLocalJson } = require("../integrations/local-health.cjs");
const root = path.resolve(__dirname, "..");

/**
 * 核查资源及独立游戏服务；只探测目录中固定的本机端口，无用户可控目标。
 * @param {Object} game 已审阅的静态游戏目录项。
 * @returns {Promise<Object>} 带真实可运行状态的目录项，不提供虚假试玩入口。
 * @throws {Error} 非网络异常向上传播，由 Express 错误处理器接管。
 */
async function checkGame(game) {
  // 1. 待接入项目不生成试玩地址。
  if (game.state !== "imported") return { ...game, ready: false };
  const entryFile = path.join(root, game.entry.endsWith("/") ? `${game.entry}index.html` : game.entry);
  if (!fs.existsSync(entryFile)) return { ...game, ready: false, reason: "本地资源尚未构建" };
  // 2. 纯静态游戏已有资源即可试玩；联机游戏必须有匹配的健康标识。
  if (!game.servicePort) return { ...game, ready: true };
  try {
    const response = await readLocalJson(game.servicePort);
    const status = response.body;
    const ready = response.statusCode === 200 && status.status === "ok" && status.game === game.id;
    return { ...game, ready, reason: ready ? undefined : "游戏服务标识不匹配" };
  } catch (error) {
    // 3. 连接失败和超时明确显示服务未启动，不降级成远程公共服务。
    if (["ECONNREFUSED", "ECONNRESET", "ETIMEDOUT"].includes(error.code) || error instanceof SyntaxError) {
      return { ...game, ready: false, reason: "本机游戏服务未启动：运行 npm run start:arcade" };
    }
    throw error;
  }
}

/**
 * 返回开源试玩目录与服务状态；不修改对局、数据库或用户数据。
 * @param {import('express').Request} _request 无业务参数的状态查询。
 * @param {import('express').Response} response JSON 响应对象。
 * @returns {Promise<void>} 所有候选完成有界探测后返回目录。
 */
async function arcadeCatalog(_request, response) {
  // 1. 并行执行只读健康检查，最多等待单个端口的超时时间。
  const games = await Promise.all(catalog.map(checkGame));
  // 2. 禁止缓存运行状态，避免重启后仍显示过期结果。
  response.setHeader("Cache-Control", "no-store");
  response.json({ games });
}
/**
 * 响应方块试玩的 React 路由刷新，不把资源文件 404 伪装成页面成功。
 * @param {import('express').Request} _request 仅匹配已注册的页面路由。
 * @param {import('express').Response} response 浏览器页面响应。
 */
function tetrisPage(_request, response) {
  // 1. 返回已构建的本地页面；缺文件时由 Express 正常报告错误。
  response.sendFile(path.join(root, "vendor/tetris/index.html"));
}
/**
 * 声明直接访问 Node 的本机开发网络模式；公网 Nginx 在同一路径显式声明代理模式。
 * @param {import('express').Request} _request 无业务参数，不接受用户指定目标地址。
 * @param {import('express').Response} response 经典 JavaScript 响应，供两个原版客户端读取。
 * @returns {void} 不缓存环境声明，不改变游戏状态；不存在声明时客户端默认走同源路径而非内部端口。
 */
function arcadeNetwork(_request, response) {
  // 1. Node 只监听回环；直接启动的本机开发仍使用拥有的独立回环端口。
  response.setHeader("Cache-Control", "no-store");
  response.type("application/javascript").send("window.LINKPLAY_ARCADE_PROXY = false;\n");
}
module.exports = { arcadeCatalog, arcadeNetwork, checkGame, tetrisPage };
