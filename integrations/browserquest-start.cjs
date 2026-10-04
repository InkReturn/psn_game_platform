"use strict";
const path = require("node:path");
const Module = require("node:module");

// 1. 使用独立安装的兼容依赖，禁止连接数据库或 memcached。
const projectRoot = path.resolve(__dirname, "..");
process.env.NODE_PATH = path.join(__dirname, "runtime/browserquest/node_modules");
Module._initPaths();
process.chdir(path.join(projectRoot, "vendor/browserquest"));
// 2. 在独立旧版进程恢复已移除的 Node path.exists 别名，不影响主平台进程。
path.exists = require("node:fs").exists;
// 3. 保持 MPL 原版游戏规则不变，仅替换老旧 WebSocket 传输模块。
const wsPath = require.resolve(path.join(process.cwd(), "server/js/ws.js"));
require.cache[wsPath] = { id: wsPath, filename: wsPath, loaded: true, exports: require("./browserquest-ws.cjs") };
// 3. 使用明确的本地配置，原版 main 会加载地图并建立一个试玩世界。
process.argv[2] = path.join(__dirname, "browserquest-config.json");
require(path.join(process.cwd(), "server/js/main.js"));
