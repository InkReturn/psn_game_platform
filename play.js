"use strict";

/**
 * 核查游戏目录后打开本地资源，不接受用户任意 URL 或端口。
 * @returns {Promise<void>} 游戏就绪后挂载 iframe；失败则只显示原因。
 */
async function openGame() {
  // 1. 查询白名单目录，地址栏只允许选择目录中的游戏编号。
  const id = new URLSearchParams(location.search).get("game");
  const status = document.getElementById("play-status");
  try {
    const response = await fetch("/api/arcade", { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) throw new Error(`状态接口返回 ${response.status}`);
    const catalog = await response.json();
    let game;
    for (const candidate of catalog.games) if (candidate.id === id) game = candidate;
    if (!game) throw new Error("游戏不存在");
    document.getElementById("game-title").textContent = game.name;
    document.title = `${game.name} · LinkPlay`;
    if (!game.ready) throw new Error(game.reason || "游戏尚未接入");
    // 2. 仅挂载本平台 vendor 资源；网络拓扑由同源部署声明负责，不在包装页重复覆盖内部端口。
    if (!game.entry.startsWith("/vendor/")) throw new Error("试玩入口不在本地资源目录");
    const entry = new URL(game.entry, location.origin);
    const frame = document.getElementById("game-frame");
    frame.src = entry.href;
    frame.title = game.name;
    frame.hidden = false;
    // 3. 显示操作提示和来源；不声称 iframe 加载代表完成游戏验收。
    status.textContent = `${game.mode} · ${game.controls}`;
    const source = document.getElementById("game-source");
    source.href = game.source;
    source.hidden = false;
    document.getElementById("fullscreen-game").disabled = false;
  } catch (error) {
    status.textContent = `无法开始试玩：${error.message}`;
  }
}

/**
 * 通过用户点击进入游戏全屏；浏览器拒绝时保留原页面并显示原因。
 * @returns {Promise<void>} 全屏请求完成或报告失败。
 */
async function fullscreenGame() {
  // 1. 全屏必须由用户操作触发，不自动劫持浏览器画面。
  try {
    await document.getElementById("game-frame").requestFullscreen();
  } catch (error) {
    // 2. 全屏限制可见，不影响继续在窗口中试玩。
    document.getElementById("play-status").textContent = `无法进入全屏：${error.message}`;
  }
}
document.getElementById("fullscreen-game").addEventListener("click", fullscreenGame);
openGame();
