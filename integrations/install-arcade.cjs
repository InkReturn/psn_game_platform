"use strict";
const fs = require("node:fs");
const path = require("node:path");
const { spawnSync } = require("node:child_process");
const root = path.resolve(__dirname, "..");

// 1. 只安装试玩所需的隔离依赖，不运行第三方生命周期脚本或访问数据库。
if (!process.env.npm_execpath) throw new Error("请通过 npm run arcade:install 执行");
const questRuntime = path.join(__dirname, "runtime/browserquest");
fs.mkdirSync(questRuntime, { recursive: true });
fs.copyFileSync(path.join(__dirname, "browserquest-package.json"), path.join(questRuntime, "package.json"));
fs.copyFileSync(path.join(__dirname, "browserquest-package-lock.json"), path.join(questRuntime, "package-lock.json"));
// 2. 两套游戏锁文件彼此隔离，避免修改平台现有依赖树。
for (const cwd of [path.join(root, "vendor/tanks-service"), questRuntime]) {
  const result = spawnSync(process.execPath, [process.env.npm_execpath, "ci", "--ignore-scripts", "--no-audit", "--no-fund"], { cwd, stdio: "inherit" });
  if (result.error) throw result.error;
  if (result.status !== 0) process.exit(result.status || 1);
}
console.log("[arcade] dependencies installed; run npm run start:arcade");
