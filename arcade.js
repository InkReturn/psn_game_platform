"use strict";

/**
 * 创建文本节点元素，服务端返回的名称和错误不作为 HTML 解释。
 * @param {string} tag 允许的 HTML 标签名，由本脚本固定提供。
 * @param {string} className 元素展示样式。
 * @param {string} text 可选显示文本，不插入 HTML。
 * @returns {HTMLElement} 尚未插入文档的元素。
 */
function element(tag, className, text = "") {
  // 1. 以纯文本构建界面，避免目录数据产生脚本注入。
  const node = document.createElement(tag);
  node.className = className;
  node.textContent = text;
  return node;
}

/**
 * 渲染单个游戏卡片；不可用或待接入的项目不提供试玩按钮。
 * @param {Object} game 状态接口返回的静态目录项。
 * @returns {HTMLElement} 包含真实状态、来源和可用动作的卡片。
 */
function gameCard(game) {
  // 1. 创建游戏类型、名称及模式，不把外部网站当作本地游戏。
  const card = element("article", "arcade-card");
  card.dataset.game = game.id;
  const art = element("div", `arcade-art ${game.color}`, game.mark);
  art.setAttribute("aria-hidden", "true");
  const body = element("div", "arcade-card-body");
  body.append(element("h2", "", game.name), element("p", "arcade-mode", game.mode));
  // 2. 根据健康检查决定是否生成进入按钮，保留失败原因。
  body.append(element("span", `arcade-badge${game.ready ? "" : " offline"}`, game.ready ? "可试玩" : game.state === "pending" ? "待接入" : "服务未启动"));
  if (!game.ready && game.reason) body.append(element("p", "arcade-reason", game.reason));
  const actions = element("div", "arcade-actions");
  if (game.ready) {
    const play = element("a", "arcade-action", "开始试玩");
    play.href = `play.html?game=${encodeURIComponent(game.id)}`;
    play.setAttribute("aria-label", `开始试玩：${game.name}`);
    actions.append(play);
  }
  // 3. 外部来源链接另开页面并隔离 opener。
  const source = element("a", "arcade-source", "源码 ↗");
  source.href = game.source;
  source.target = "_blank";
  source.rel = "noopener noreferrer";
  actions.append(source);
  body.append(actions);
  card.append(art, body);
  return card;
}

/**
 * 刷新目录和运行状态，错误时移除旧按钮，避免过期状态误导。
 * @returns {Promise<void>} 完成目录渲染或显示明确错误。
 */
async function refreshCatalog() {
  // 1. 锁定刷新按钮并清除旧的运行状态。
  const button = document.getElementById("refresh-catalog");
  const status = document.getElementById("catalog-status");
  const grid = document.getElementById("arcade-catalog");
  button.disabled = true;
  status.textContent = "正在检查游戏…";
  grid.replaceChildren();
  try {
    // 2. 向本机平台请求有界状态检查。
    const response = await fetch("/api/arcade", { signal: AbortSignal.timeout(5000), cache: "no-store" });
    if (!response.ok) throw new Error(`状态接口返回 ${response.status}`);
    const catalog = await response.json();
    for (const game of catalog.games) grid.append(gameCard(game));
    let readyCount = 0;
    for (const game of catalog.games) if (game.ready) readyCount++;
    status.textContent = `${readyCount} 款可试玩 · ${catalog.games.length - readyCount} 款未就绪`;
  } catch (error) {
    // 3. 网络与接口失败可见，不回退为伪成功目录。
    status.textContent = `无法读取试玩目录：${error.message}`;
  } finally {
    button.disabled = false;
  }
}
document.getElementById("refresh-catalog").addEventListener("click", refreshCatalog);
refreshCatalog();
