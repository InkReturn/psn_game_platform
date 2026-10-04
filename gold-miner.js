/** 黄金矿工客户端：只读权威快照、绘制矿场与发送开局/放钩意图，不裁决碰撞或分数。 */
(function () {
  "use strict";
  const rules = window.GoldMinerRules;
  const canvas = document.querySelector("#goldCanvas");
  const ctx = canvas.getContext("2d");
  const ui = Object.fromEntries(["goldMode", "goldDuration", "goldStart", "goldDrop", "goldModeLabel", "goldRoundLabel", "goldClockLabel", "goldClock", "goldMyScore", "goldOverlay", "goldMessage", "goldError", "goldAssetError", "goldRankings", "goldRankTitle", "goldModeHint", "goldWinner"].map((id) => [id, document.getElementById(id)]));
  const colors = ["#f2bc45", "#69d6df", "#e98470", "#a8d57b", "#c4a4e7", "#f1a6cb"];
  const images = {};
  let panel;
  let snapshot = null;
  let roomState = { roomId: "", playerId: "", online: "idle", members: [] };
  let receivedAt = 0;
  let actionInFlight = false;
  let lastRanks = "";
  let lastRound = -1;
  canvas.width = rules.WIDTH;
  canvas.height = rules.HEIGHT;
  ui.goldDuration.min = String(rules.MIN_DURATION_SECONDS);
  ui.goldDuration.max = String(rules.MAX_DURATION_SECONDS);
  ui.goldDuration.value = String(rules.DEFAULT_DURATION_SECONDS);

  /** 显示可观察的操作错误，不丢弃服务端拒绝结果。
   * @param {string} message - 面向玩家的中文错误；空串清除旧错误。
   * @returns {void} 更新提示，不修改游戏数据。
   */
  function showError(message) {
    // 1. 只更新独立错误区，不把客户端判断写回服务器快照。
    ui.goldError.textContent = message;
    ui.goldError.hidden = !message;
  }

  /** 接收权威快照并同步只读镜像及配置初值。
   * @param {object} next - 服务端下发的 room/game 数据副本。
   * @returns {void} 记录时钟校正与渲染，游戏结果只来自 next。
   */
  function applySnapshot(next) {
    // 1. 覆盖只读镜像，记录接收时间用于有限绘制外推。
    snapshot = next;
    receivedAt = Date.now();
    const game = next.game;
    // 2. 只有新局才覆盖配置，避免连续快照打断下一局时长输入。
    if (game.round !== lastRound) {
      ui.goldMode.value = game.mode;
      ui.goldDuration.value = String(game.durationSeconds);
      lastRound = game.round;
    }
    updateUi();
  }

  /** 根据最新成员快照读取当前房主，不能信本地缓存的永久角色。
   * @returns {boolean} 本身份是否拥有最新房主权限。
   */
  function isHost() {
    // 1. 只使用服务器成员的 host 标记。
    return Boolean(snapshot?.room.players.some((member) => member.playerId === roomState.playerId && member.host));
  }

  /** 获取仅用于动画/倒计时展示的服务器校正时间。
   * @returns {number} 毫秒时间；不作为操作身份或胜负裁决输入。
   */
  function serverTime() {
    // 1. 服务端时间加本地接收后的经过时间，绝不改变 endsAt。
    return snapshot ? snapshot.game.serverNow + Math.max(0, Date.now() - receivedAt) : Date.now();
  }

  /** 判断本连接当前是否能提交放钩意图。
   * @returns {boolean} 在线、参赛、非退出、非倒计时、空闲钩时为真；服务端仍会重新校验。
   */
  function canDrop() {
    // 1. 检查只读状态与请求锁，避免按键/触屏连发。
    const game = snapshot?.game;
    const miner = game?.miners.find((item) => item.playerId === roomState.playerId);
    return Boolean(!actionInFlight && roomState.online === "online" && game?.phase === "playing" && serverTime() >= game.startedAt && serverTime() < game.endsAt && miner && !miner.departed && miner.hook.phase === "idle");
  }

  /** 更新排行，昵称始终用 textContent，避免不受信昵称注入 HTML。
   * @param {object} game - 最新只读比赛快照，rankings 由服务器计算。
   * @returns {void} 按服务器名次显示金额和退出标记，不重新裁决胜者。
   */
  function renderRankings(game) {
    // 1. 数据未变时保留 DOM，避免每帧重建排行。
    const key = JSON.stringify([game?.rankings, roomState.playerId, game?.phase]);
    if (key === lastRanks) return;
    lastRanks = key;
    ui.goldRankings.replaceChildren();
    // 2. 按快照提供的名次逐条绘制，不在前端计算金额。
    for (const rank of game?.rankings || []) {
      const item = document.createElement("li");
      item.className = `gold-ranking${rank.playerId === roomState.playerId ? " self" : ""}${rank.departed ? " departed" : ""}`;
      item.dataset.playerId = rank.playerId;
      const place = document.createElement("span");
      place.className = "rank";
      place.textContent = rank.departed ? "—" : String(rank.rank);
      const name = document.createElement("span");
      name.className = "name";
      name.textContent = `${rank.nickname}${rank.playerId === roomState.playerId ? "（我）" : ""}${rank.departed ? " · 已退出" : ""}`;
      name.title = name.textContent;
      const value = document.createElement("span");
      value.className = "value";
      value.textContent = `¥${rank.score}`;
      item.append(place, name, value);
      ui.goldRankings.append(item);
    }
    // 3. 空名单和终局冠军均由权威数据推导。
    if (!ui.goldRankings.children.length) {
      const empty = document.createElement("li");
      empty.className = "gold-ranking-empty";
      empty.textContent = "等待矿工入场";
      ui.goldRankings.append(empty);
    }
    const winners = (game?.rankings || []).filter((item) => !item.departed && item.rank === 1);
    ui.goldWinner.hidden = game?.phase !== "finished";
    ui.goldWinner.textContent = winners.length ? `${winners.length > 1 ? "并列第一" : "第一名"}：${winners.map((item) => item.nickname).join("、")} · ¥${winners[0].score}` : "本局矿工均已退出";
  }

  /** 更新配置、操作权限、结算和倒计时展示。
   * @returns {void} UI 是镜像，客户端倒计时归零不自行结算。
   */
  function updateUi() {
    // 1. 读取权威状态与当前身份，房主权限跟随最新快照。
    const game = snapshot?.game;
    const playing = game?.phase === "playing";
    const online = roomState.online === "online";
    const host = isHost();
    ui.goldStart.disabled = !host || !online || playing || actionInFlight || (snapshot?.room.players.filter((member) => member.connected).length || 0) < rules.MIN_PLAYERS;
    ui.goldStart.textContent = game?.phase === "finished" ? "再来一局" : "开始比赛";
    ui.goldMode.disabled = !host || playing;
    ui.goldDuration.disabled = !host || playing;
    ui.goldDrop.disabled = !canDrop();
    const miner = game?.miners.find((item) => item.playerId === roomState.playerId);
    ui.goldDrop.firstChild.textContent = miner?.hook.phase === "retracting" ? "回收中 " : miner?.hook.phase === "extending" ? "抓取中 " : "放钩 ";
    // 2. 显示真实时长和模式，结束以 phase 而非本地时钟裁决。
    const independent = game?.mode === "independent";
    ui.goldModeLabel.textContent = independent ? "独立竞速" : "共享抢矿";
    ui.goldModeHint.textContent = independent ? "相同布局，各挖各的" : "同一矿场，先抓先得";
    ui.goldRoundLabel.textContent = game?.round ? `第 ${game.round} 局${playing && !miner ? " · 等待下一局" : ""}` : "等待开局";
    ui.goldMyScore.textContent = `¥${miner?.score || 0}`;
    ui.goldRankTitle.textContent = game?.phase === "finished" ? "最终价值排行" : "实时排行";
    const now = serverTime();
    const countdown = playing && now < game.startedAt;
    const seconds = playing ? Math.max(0, Math.ceil((game.endsAt - Math.max(now, game.startedAt)) / 1000)) : game?.phase === "finished" ? 0 : game?.durationSeconds || rules.DEFAULT_DURATION_SECONDS;
    ui.goldClockLabel.textContent = game?.phase === "finished" ? "比赛结束" : countdown ? "即将开局" : playing ? "剩余时间" : "比赛时长";
    ui.goldClock.replaceChildren(document.createTextNode(String(seconds)));
    const unit = document.createElement("span");
    unit.textContent = "秒";
    ui.goldClock.append(unit);
    // 3. 统一覆盖层：倒计时、等待、结算；晚加入者仅观察本局。
    ui.goldOverlay.hidden = Boolean(playing && !countdown);
    ui.goldOverlay.classList.toggle("countdown", countdown);
    const title = ui.goldOverlay.querySelector("strong");
    const detail = ui.goldOverlay.querySelector("span");
    title.textContent = countdown ? String(Math.ceil((game.startedAt - now) / 1000)) : game?.phase === "finished" ? "本局结束" : roomState.playerId ? "矿工就位" : "准备下矿";
    detail.textContent = countdown ? "准备放钩" : game?.phase === "finished" ? "总价值已结算" : roomState.playerId ? host ? "选择模式和时长，等待至少两人在线" : "等待房主开局" : "创建房间或加入朋友的邀请";
    const fieldKey = independent ? roomState.playerId : "shared";
    const empty = playing && game.fields[fieldKey]?.minerals.every((item) => item.status === "collected");
    ui.goldMessage.textContent = playing && !miner ? "等待下一局 · 本局仅观看比分" : !online && roomState.playerId ? "连接断开，恢复中" : countdown ? "倒计时后放钩" : empty ? "矿场已空 · 等待比赛截止" : playing ? miner?.hook.phase === "retracting" ? "回收中" : miner?.hook.phase === "extending" ? "抓取中" : "准备放钩" : game?.message || "等待房主开始比赛";
    renderRankings(game);
  }

  /** 发送统一的操作意图，按钮、键盘、触屏共用且处理拒绝 Promise。
   * @param {"start"|"drop"} action - 服务器允许的操作名。
   * @param {object} [params] - 开局模式/秒数；放钩不包含任何结果或瞄准字段。
   * @returns {Promise<void>} 请求完成；错误被展示，不产生未处理拒绝。
   */
  async function sendIntent(action, params) {
    // 1. 单请求锁与放钩前置检查，不替代服务端校验。
    if (actionInFlight || !panel || (action === "drop" && !canDrop())) return;
    actionInFlight = true;
    showError("");
    updateUi();
    try {
      // 2. 仅发送操作和房主配置，结果等权威快照。
      await panel.sendAction(action, params);
    } catch (error) {
      showError(error.message || "操作未通过服务器校验");
    } finally {
      // 3. 请求完成后解除锁，无论成功或拒绝都不改金额。
      actionInFlight = false;
      updateUi();
    }
  }

  /** 校验房主自由时长输入并提交开局意图。
   * @returns {void} 非法输入显示范围错误，不提交或重置本局。
   */
  function startRound() {
    // 1. 空值不转换为零，小数/越界一并拒绝。
    const value = ui.goldDuration.value.trim();
    const seconds = Number(value);
    if (!value || !Number.isInteger(seconds) || seconds < rules.MIN_DURATION_SECONDS || seconds > rules.MAX_DURATION_SECONDS) {
      showError(`比赛时长须为 ${rules.MIN_DURATION_SECONDS}–${rules.MAX_DURATION_SECONDS} 秒整数`);
      return;
    }
    // 2. 不加入身份、客户端时间或布局，只发送模式和秒数。
    void sendIntent("start", { mode: ui.goldMode.value, durationSeconds: seconds });
  }

  /** 绘制本地素材；加载失败时保持可玩的基本几何表现。
   * @param {string} name - 本地素材键名。
   * @param {number} x - 左上角逻辑横坐标，像素。
   * @param {number} y - 左上角逻辑纵坐标，像素。
   * @param {number} width - 绘制宽度，像素。
   * @param {number} height - 绘制高度，像素。
   * @param {string} fallback - 缺图时使用的填充色。
   * @returns {void} 仅绘制画面。
   */
  function drawAsset(name, x, y, width, height, fallback) {
    // 1. 已加载图片使用像素风缩放，否则使用几何块。
    if (images[name]?.complete && images[name].naturalWidth) ctx.drawImage(images[name], x, y, width, height);
    else { ctx.fillStyle = fallback; ctx.fillRect(x, y, width, height); }
  }

  /** 绘制本矿场及权威钩位置，不包含碰撞、计分或目标选择。
   * @returns {void} 每动画帧重绘，所有可变游戏数据来自服务端。
   */
  function drawMine() {
    // 1. 绘制地表、洞壁和本地岩土纹理。
    ctx.imageSmoothingEnabled = false;
    ctx.fillStyle = "#b7d9d2";
    ctx.fillRect(0, 0, canvas.width, canvas.height);
    ctx.fillStyle = "#745039";
    ctx.fillRect(0, 84, canvas.width, canvas.height - 84);
    if (images.dirt?.naturalWidth) {
      const pattern = ctx.createPattern(images.dirt, "repeat");
      ctx.fillStyle = pattern;
      ctx.fillRect(0, 100, canvas.width, canvas.height - 100);
    }
    ctx.fillStyle = "rgba(38,24,13,.77)";
    ctx.fillRect(0, 100, canvas.width, canvas.height - 100);
    for (let x = 0; x < canvas.width; x += 36) drawAsset("ground", x, 72, 36, 36, "#745039");
    ctx.strokeStyle = "#795236";
    ctx.lineWidth = 3;
    for (let y = 180; y < canvas.height; y += 100) { ctx.beginPath(); ctx.moveTo(0, y); ctx.lineTo(canvas.width, y + 20); ctx.stroke(); }
    // 2. 绘制可用矿石；claimed 矿石显示在对应抓钩处。
    const game = snapshot?.game;
    if (!game || !game.round) return;
    const own = game.miners.find((miner) => miner.playerId === roomState.playerId);
    const key = game.mode === "shared" ? "shared" : own?.playerId || game.miners[0]?.playerId;
    const field = game.fields[key];
    const visibleMiners = game.mode === "shared" ? game.miners : game.miners.filter((miner) => miner.playerId === key);
    for (const ore of field?.minerals || []) {
      if (ore.status !== "available") continue;
      drawAsset(ore.kind, ore.x - ore.radius, ore.y - ore.radius, ore.radius * 2, ore.radius * 2, { gold: "#f2bc45", diamond: "#69d6df", rock: "#9f8b71" }[ore.kind]);
      ctx.fillStyle = "#f5e8c7";
      ctx.textAlign = "center";
      ctx.font = `bold ${Math.max(12, 10 * canvas.width / Math.max(1, canvas.clientWidth))}px Microsoft YaHei, sans-serif`;
      ctx.fillText(`¥${ore.value}`, ore.x, ore.y + ore.radius + 17);
    }
    // 3. 仅用共享规则的 hookPose 做有限外推绘制；不写回快照。
    const drawTime = game.phase === "playing" ? Math.min(serverTime(), game.serverNow + 200, game.endsAt) : game.serverNow;
    for (const miner of visibleMiners) {
      const pose = rules.hookPose(miner, game, drawTime);
      const color = colors[miner.seat % colors.length];
      const ore = field?.minerals.find((item) => item.status === "claimed" && item.claimedBy === miner.playerId);
      ctx.globalAlpha = miner.departed ? .4 : 1;
      ctx.strokeStyle = color;
      ctx.lineWidth = 3;
      ctx.beginPath(); ctx.moveTo(pose.origin.x, pose.origin.y); ctx.lineTo(pose.tip.x, pose.tip.y); ctx.stroke();
      ctx.fillStyle = "#d9b979";
      ctx.fillRect(pose.origin.x - 26, pose.origin.y - 14, 52, 20);
      ctx.fillStyle = "#38291f";
      ctx.fillRect(pose.origin.x - 25, pose.origin.y + 6, 13, 6);
      ctx.fillRect(pose.origin.x + 12, pose.origin.y + 6, 13, 6);
      drawAsset("miner", pose.origin.x - 20, pose.origin.y - 54, 40, 40, color);
      ctx.fillStyle = "#38291f";
      ctx.font = `bold ${Math.max(13, 11 * canvas.width / Math.max(1, canvas.clientWidth))}px Microsoft YaHei, sans-serif`;
      ctx.textAlign = "center";
      const label = canvas.clientWidth < 600 ? miner.playerId === roomState.playerId ? "我" : `矿工${miner.seat + 1}` : `${miner.nickname}${miner.playerId === roomState.playerId ? "（我）" : ""}`;
      ctx.fillText(label, pose.origin.x, canvas.clientWidth < 600 ? 30 : 18);
      ctx.save();
      ctx.translate(pose.tip.x, pose.tip.y); ctx.rotate(-pose.angle);
      ctx.strokeStyle = color;
      ctx.lineWidth = 4;
      ctx.beginPath(); ctx.moveTo(-12, 3); ctx.lineTo(-7, 13); ctx.lineTo(0, 8); ctx.lineTo(7, 13); ctx.lineTo(12, 3); ctx.stroke();
      ctx.restore();
      if (ore) drawAsset(ore.kind, pose.tip.x - ore.radius, pose.tip.y, ore.radius * 2, ore.radius * 2, color);
      ctx.globalAlpha = 1;
    }
  }

  /** 动画帧入口，渲染展示时钟和矿场，后台恢复不重置比赛。
   * @returns {void} 安排下一帧，无网络操作。
   */
  function frame() {
    // 1. 渲染只读镜像，并刷新随服务器时钟变化的可操作状态。
    drawMine();
    updateUi();
    requestAnimationFrame(frame);
  }

  /** 处理矿场焦点内的键盘放钩，侧栏/返回链接/表单空格不放钩，按钮默认激活不重复发请求。
   * @param {KeyboardEvent} event - 原生按键事件；只接受非重复的空格。
   * @returns {void} 非编辑区域空格发意图，编辑器保持原行为。
   */
  function onKeyDown(event) {
    // 1. 昵称/秒数/选择器/可编辑内容及按钮交给原生行为。
    if (event.code !== "Space" || event.repeat || !event.target.closest("#goldPlayArea") || event.target.closest("input,select,textarea,button,[contenteditable=true]")) return;
    // 2. 可操作时阻止滚动并走唯一操作入口。
    if (canDrop()) { event.preventDefault(); void sendIntent("drop"); }
  }

  // 1. 本地化图片加载；失败可观察，但不阻断操作。
  for (const name of ["gold", "diamond", "rock", "dirt", "ground", "miner"]) {
    const image = new Image();
    /** 图片加载失败时标记具体缺图，不影响权威状态或其他图片。
     * @returns {void} 页面显示故障并保留几何渲染。
     */
    image.onerror = function onAssetError() {
      // 1. 报告相对本地资源名称，不加载外部替代图片。
      ui.goldAssetError.hidden = false;
      ui.goldAssetError.textContent = `本地素材加载失败：${name}；已使用基础图形`;
    };
    image.src = `assets/gold-miner/${name}.png`;
    images[name] = image;
  }
  // 2. 复用通用权威面板与身份恢复，仅订阅快照。
  panel = window.initAuthoritativeRoomPanel({
    gameType: "gold-miner", prefix: "GM", storageKey: "linkplay-gold-miner-identity",
    onGameUpdate: applySnapshot,
    /** 成员/网络变化仅更新房间镜像，退出时清理旧比赛画面。
     * @param {object} next - 通用面板给出的当前房间身份、网络和成员状态。
     * @returns {void} 更新 UI，不生成游戏状态。
     */
    onRoomChange(next) {
      // 1. 保留服务器镜像；主动退出不显示上个房间比分。
      roomState = next;
      if (!next.roomId) { snapshot = null; lastRound = -1; }
      updateUi();
    },
    onError: (error) => showError(error.message),
    isGameReady: () => snapshot?.game.phase === "playing",
  });
  ui.goldStart.addEventListener("click", startRound);
  ui.goldDrop.addEventListener("click", () => { void sendIntent("drop"); });
  document.addEventListener("keydown", onKeyDown);
  /** 暴露只读测试钩子；不提供改分、瞄准或修改权威矿场的接口。
   * @returns {string} 可序列化身份、房间、完整比赛镜像与 UI 可操作状态。
   */
  window.render_game_to_text = function renderGameToText() {
    // 1. 返回快照副本的 JSON，只用于观测与验收。
    return JSON.stringify({ gameType: "gold-miner", playerId: roomState.playerId, roomId: roomState.roomId, online: roomState.online, displayServerNow: serverTime(), room: snapshot?.room || null, game: snapshot?.game || null, canDrop: canDrop(), assetErrors: ui.goldAssetError.hidden ? "" : ui.goldAssetError.textContent });
  };
  requestAnimationFrame(frame);
})();
