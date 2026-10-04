/** 拼豆页面控制器：交互、视图缩放平移、会话历史、事务保护的本地存档与下载。 */
"use strict";
/** 启动独立工作台。@returns {Promise<void>} 装配页面；存储错误保留内存并展示恢复入口。 */
(async function startStudio() {
  // 1. 固定页面状态，持久化唯一来源为模型定义的整库。
  const M = window.BeadModel;
  const board = document.getElementById("beadBoard"), ctx = board.getContext("2d"), vp = document.getElementById("boardViewport");
  const cache = document.createElement("canvas");
  const HISTORY_LIMIT = 80, store = window.BeadStore;
  const PITCH_MIN = 4, PITCH_MAX = 72, FIT_PITCH_MAX = 40, FIT_PAD = 24;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(M.STORAGE_KEY) : null;
  let archive, expectedRaw, corruptRaw = null, blocked = "", dirty = false;
  let saveQueue = Promise.resolve(), color = M.PALETTE[3], tool = "paint", pixelPreview = false;
  let undoStack = [], redoStack = [], stroke = null, cursor = { x: 0, y: 0 };
  // 2. 视图状态：pitch 为 CSS 像素格距；autoFit 跟随容器；hover/panning/pinch 服务鼠标与触摸手势。
  let pitch = 0, autoFit = true, hover = null, panning = null, pinch = null, pinchLock = new Set(), crispTimer = 0;
  const touches = new Map();

  /** 取固定页面元素。@param {string} id 元素标识。@returns {HTMLElement} 已存在的元素。 */
  function el(id) { // 1. 按标识查找。
    return document.getElementById(id);
  }
  /** 取活动作品。@returns {object} 当前内存作品引用。 */
  function current() { // 1. 查找活动标识。
    return archive.works.find(isActive);
  }
  /** 判断活动作品。@param {object} work 内存作品。@returns {boolean} 是否被选中。 */
  function isActive(work) { // 1. 比较活动标识。
    return work.id === archive.activeId;
  }
  /** 创建无碰撞标识。@returns {string} 浏览器安全随机 128 位标识。 */
  function newId() { // 1. 使用同源安全随机标识。
    const bytes = new Uint8Array(16); crypto.getRandomValues(bytes);
    let id = ""; for (const byte of bytes) id += byte.toString(16).padStart(2, "0");
    return id;
  }
  /** 制作独立模板。@param {string} kind garden 或 heart。@returns {object} 新 24×24 作品，无既有作品副作用。 */
  function template(kind) {
    // 1. 创建空板，模板总作为新作品。
    const work = M.createWork(newId(), kind === "heart" ? "小小心意" : "像素花园", 24, 24);
    // 2. 用有限格坐标绘制图案。
    if (kind === "heart") {
      const rows = ["01100110", "11111111", "11111111", "11111111", "01111110", "00111100", "00011000"];
      for (let y = 0; y < rows.length; y++) for (let x = 0; x < 8; x++) if (rows[y][x] === "1") work.cells[(y + 8) * work.width + x + 8] = M.PALETTE[6];
    } else {
      const flowers = [[7, 7, M.PALETTE[6]], [16, 10, M.PALETTE[3]], [9, 16, M.PALETTE[12]]];
      for (const [x, y, petal] of flowers) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 3) work.cells[(y + dy) * work.width + x + dx] = petal;
        work.cells[y * work.width + x] = M.PALETTE[14];
        for (let stem = y + 3; stem <= 21; stem++) work.cells[stem * work.width + x] = M.PALETTE[10];
        work.cells[(y + 5) * work.width + x + 1] = M.PALETTE[9]; work.cells[(y + 4) * work.width + x + 2] = M.PALETTE[9];
      }
    }
    return work;
  }
  /** 构造首次整库。@returns {object} 含可编辑模板的存档。 */
  function freshArchive() { // 1. 首次作品与活动标识同步。
    const work = template("garden");
    return { format: M.FORMAT, version: M.VERSION, revision: 0, activeId: work.id, works: [work] };
  }
  /** 展示瞬时业务错误。@param {string} message 空字符串清除通知。@returns {void} 修改提示区域。 */
  function notify(message) { // 1. 只通过文本节点展示外部消息。
    el("notice").textContent = message; el("notice").hidden = !message;
  }
  /** 展示存档状态与恢复动作。@param {string} state saved、pending 或 error。@param {string} message 状态文字。@returns {void} 更新页面，不写存储。 */
  function status(state, message) {
    // 1. 保存状态始终显式可见。
    el("saveStatus").dataset.state = state; el("saveStatus").textContent = message;
    // 2. 异常动作与原因对应，不提供隐式覆盖。
    el("recovery").hidden = !blocked;
    el("rawBtn").hidden = blocked !== "corrupt";
    el("rebuildBtn").hidden = blocked !== "corrupt";
    el("reloadBtn").hidden = blocked !== "conflict";
    el("retryBtn").hidden = blocked !== "storage";
    const messages = { corrupt: "本地存档损坏，原数据已保留。可导出原数据，或确认后重建。", conflict: "其他标签页已更新存档，本页未保存。请先备份本页作品，再重载存档。", storage: "浏览器存储不可用或空间不足，本页未保存。请下载备份，或重试保存。" };
    el("recoveryMessage").textContent = messages[blocked] || "";
  }
  /** 阻止写入并保留内存。@param {string} reason corrupt、conflict 或 storage。@returns {void} 设置未保存状态。 */
  function block(reason) { // 1. 标记不可写，但仍允许编辑和备份。
    blocked = reason; dirty = true; status("error", "未保存");
  }
  /** 原子保存最新整库。@returns {Promise<void>} 事务失败显示未保存，不泄露异常；HTTP IP 无须 Web Locks。 */
  async function persist() {
    // 1. 只结算完整笔画，序列化本轮内存快照。
    if (blocked || !dirty || stroke) return;
    const snapshot = M.serializeArchive(archive);
    const next = { ...archive, revision: archive.revision + 1 }, raw = M.serializeArchive(next);
    // 2. 唯一 IndexedDB readwrite 事务内比较并写入，旧页不能覆盖新存档。
    try {
      // 2.1 初次读取失败意味着基线未知，不是空库。重试只在新旧库都确实为空时建立新基线。
      if (expectedRaw === undefined) {
        const actual = await store.read();
        if (actual !== null || localStorage.getItem(M.STORAGE_KEY) !== null) { block("conflict"); return; }
        expectedRaw = null;
      }
      if (!await store.compareAndSet(expectedRaw, raw)) { block("conflict"); return; }
      archive.revision = next.revision; expectedRaw = raw;
      // 3. 异步事务期间可能有新编辑；不能把后来的变动标为已保存。
      const latest = { ...archive, revision: next.revision - 1 };
      dirty = stroke !== null || M.serializeArchive(latest) !== snapshot;
      if (channel) channel.postMessage(raw);
      status(dirty ? "pending" : "saved", dirty ? "正在保存" : "已保存到此浏览器");
      if (dirty && !stroke) saveQueue = saveQueue.then(persist);
    } catch { block("storage"); }
  }
  /** 将保存串行排队。@returns {void} 标记待保存；实际使用事务保护的最新内存状态。 */
  function queueSave() { // 1. 同页排队与跨页锁共同防止旧快照反写。
    dirty = true;
    status(blocked ? "error" : "pending", blocked ? "未保存" : "正在保存");
    saveQueue = saveQueue.then(persist);
  }
  /** 读取本地存档。@returns {void} 损坏原文不被覆盖；不可用时仅建立内存草稿。 */
  async function load() {
    // 1. 先读唯一事务库；仅库中无数据时读取旧版原文作迁移来源。
    try {
      expectedRaw = await store.read();
      if (expectedRaw === null) {
        const legacy = localStorage.getItem(M.STORAGE_KEY);
        if (legacy !== null) {
          // 1.1 迁移不删旧原文；并发页先完成迁移时读取胜者，损坏原文同样保留给恢复 UI。
          await store.compareAndSet(null, legacy); expectedRaw = await store.read();
        }
      }
    } catch { expectedRaw = undefined; archive = freshArchive(); block("storage"); return; }
    // 2. 首次创建或完整恢复，不把损坏当空库。
    if (expectedRaw === null) { archive = freshArchive(); queueSave(); }
    else {
      try { archive = M.parseArchive(expectedRaw); status("saved", "已保存到此浏览器"); }
      catch { corruptRaw = expectedRaw; archive = freshArchive(); block("corrupt"); }
    }
  }
  /** 绘制一粒实体环豆。@param {CanvasRenderingContext2D} context 绘图上下文。@param {number} x 中心横坐标，像素。@param {number} y 中心纵坐标，像素。@param {number} pitch 格子间距，像素。@param {string} beadColor 六位颜色。@param {boolean} flat 是否像素模式。@returns {void} 修改画布像素。 */
  function drawBead(context, x, y, pitch, beadColor, flat) {
    // 1. 像素预览直接填方块。
    if (flat) { context.fillStyle = beadColor; context.fillRect(x - pitch / 2, y - pitch / 2, pitch, pitch); return; }
    // 2. 环形路径真实镂空，成品透明背景也保留孔洞。
    const radius = pitch * 0.43, hole = pitch * 0.15;
    context.save(); context.beginPath(); context.arc(x, y, radius, 0, Math.PI * 2); context.arc(x, y, hole, 0, Math.PI * 2, true);
    const shine = context.createLinearGradient(x - radius, y - radius, x + radius, y + radius);
    shine.addColorStop(0, "#FFFFFF"); shine.addColorStop(0.22, beadColor); shine.addColorStop(0.8, beadColor); shine.addColorStop(1, "#202A43");
    context.fillStyle = shine; context.shadowColor = "#00000065"; context.shadowBlur = pitch * 0.12; context.shadowOffsetY = pitch * 0.08; context.fill("evenodd");
    // 3. 孔沿与表面高光增加实体质感。
    context.shadowColor = "transparent"; context.strokeStyle = "#FFFFFF50"; context.lineWidth = pitch * 0.04; context.stroke();
    context.beginPath(); context.arc(x, y, radius * 0.83, Math.PI * 1.1, Math.PI * 1.65); context.strokeStyle = "#FFFFFF70"; context.stroke(); context.restore();
  }
  /** 绘制单格底面、销钉与豆子。@param {CanvasRenderingContext2D} context 目标上下文。@param {object} work 合法作品。@param {number} x 零起点列。@param {number} y 零起点行。@param {number} px 横向格距（目标像素）。@param {number} py 纵向格距（目标像素）。@param {number} margin 留边格数。@param {boolean} flat 是否像素模式。@param {boolean} plain 是否缩略图（无销钉与刻度）。@returns {void} 修改位图，不写存储。 */
  function drawCell(context, work, x, y, px, py, margin, flat, plain) {
    // 1. 计算带留边的格中心。
    const cx = (x + margin + 0.5) * px, cy = (y + margin + 0.5) * py, bead = work.cells[y * work.width + x];
    // 2. 画板打孔销钉；缩略图省略。
    if (!plain) {
      context.beginPath(); context.arc(cx, cy + py * 0.025, px * 0.11, 0, Math.PI * 2); context.fillStyle = "#111A2D"; context.fill();
      context.beginPath(); context.arc(cx, cy, px * 0.07, 0, Math.PI * 2); context.fillStyle = "#52627E"; context.fill();
    }
    // 3. 有豆才绘制环豆。
    if (bead) drawBead(context, cx, cy, Math.min(px, py), bead, flat);
  }
  /** 绘制画板或缩略图。@param {HTMLCanvasElement} canvas 目标画布。@param {object} work 合法作品。@param {boolean} thumb 是否仅绘缩略图。@returns {void} 修改画布，不写存储。 */
  function drawWork(canvas, work, thumb = false) {
    // 1. 画板留一格刻度边，缩略图不留边；矩形板长宽分别计算格距。
    const context = canvas.getContext("2d"), margin = thumb ? 0 : 1;
    const px = canvas.width / (work.width + margin * 2), py = canvas.height / (work.height + margin * 2);
    context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#202A43"; context.fillRect(0, 0, canvas.width, canvas.height);
    // 2. 各格打孔并绘制环豆，避免 DOM 格子造成高密度卡顿。
    for (let y = 0; y < work.height; y++) for (let x = 0; x < work.width; x++) drawCell(context, work, x, y, px, py, margin, thumb || pixelPreview, thumb);
    // 3. 画板显示坐标刻度，长宽轴各自标注。
    if (!thumb) {
      context.font = `${Math.max(9, Math.min(px, py) * 0.3)}px Segoe UI`; context.fillStyle = "#B4C1D9"; context.textAlign = "center";
      for (let i = 0; i < work.width; i += 4) context.fillText(String(i + 1), (i + 1.5) * px, py * 0.67);
      for (let i = 0; i < work.height; i += 4) context.fillText(String(i + 1), px * 0.45, (i + 1.6) * py);
    }
  }
  /** 计算适合视口的间距。@returns {number} CSS 像素格距，四周留呼吸边且单格封顶。 */
  function fitPitch() {
    // 1. 长宽分别求可用比例后取小值。
    const work = current();
    const w = Math.max(PITCH_MIN * 2, vp.clientWidth - FIT_PAD), h = Math.max(PITCH_MIN * 2, vp.clientHeight - FIT_PAD);
    return Math.min(FIT_PITCH_MAX, w / (work.width + 2), h / (work.height + 2));
  }
  /** 更新缩放百分比标签。@returns {void} 相对当前适合间距取整显示。 */
  function updateZoomLabel() { // 1. 适应模式恒为 100%。
    el("zoomLabel").textContent = `${Math.round(pitch / fitPitch() * 100)}%`;
  }
  /** 调整视图间距。@param {number} nextPitch 目标 CSS 像素格距。@param {object|null} [anchor] 视口内不动点坐标，可含冻结内容比例 fx/fy（手势用），缺省取视口中心。@param {boolean} [fromFit] 是否进入适应模式。@returns {void} 先拉伸 CSS 尺寸，清晰位图按防抖节奏重建。 */
  function applyView(nextPitch, anchor = null, fromFit = false) {
    // 1. 初始化完成前忽略。
    if (!archive || !pitch) return;
    const work = current();
    autoFit = fromFit;
    const oldW = (work.width + 2) * pitch, oldH = (work.height + 2) * pitch;
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, nextPitch));
    anchor = anchor || { x: vp.clientWidth / 2, y: vp.clientHeight / 2 };
    // 2. 不动点内容比例：手势传冻结比例；普通缩放按当前滚动换算，缩放后保持画面稳定。
    const fx = Number.isFinite(anchor.fx) ? anchor.fx : (anchor.x + vp.scrollLeft) / oldW;
    const fy = Number.isFinite(anchor.fy) ? anchor.fy : (anchor.y + vp.scrollTop) / oldH;
    board.style.width = `${(work.width + 2) * pitch}px`; board.style.height = `${(work.height + 2) * pitch}px`;
    vp.scrollLeft = fx * (work.width + 2) * pitch - anchor.x;
    vp.scrollTop = fy * (work.height + 2) * pitch - anchor.y;
    // 3. CSS 拉伸即时生效，避免连续缩放期间整板重绘。
    updateZoomLabel(); scheduleCrisp();
  }
  /** 回到适合画板。@returns {void} 重新计算间距并保持居中。 */
  function fitView() { // 1. 适应模式以视口中心为不动点。
    applyView(fitPitch(), null, true);
  }
  /** 防抖重建清晰位图。@returns {void} 合并连续缩放或容器变化，停止后重绘一次。 */
  function scheduleCrisp() { // 1. 只保留最后一次计划。
    clearTimeout(crispTimer); crispTimer = setTimeout(renderScene, 90);
  }
  /** 按当前间距重建清晰位图。@returns {void} 后备分辨率封顶 24 像素/格，高倍缩放不生成超大位图。 */
  function renderScene() {
    // 1. 初始化完成前忽略。
    if (!archive) return;
    const work = current();
    const scale = Math.min(window.devicePixelRatio || 1, 24 / pitch);
    const cssW = (work.width + 2) * pitch, cssH = (work.height + 2) * pitch;
    // 2. 先写后备尺寸再整板绘制；改写尺寸会清空位图。
    board.width = Math.max(1, Math.round(cssW * scale)); board.height = Math.max(1, Math.round(cssH * scale));
    cache.width = board.width; cache.height = board.height;
    drawWork(cache, work);
    compose();
  }
  /** 合成缓存与光标层到画板。@returns {void} 一次位图拷贝加高亮框，悬停和键盘移动不整板重绘。 */
  function compose() {
    // 1. 初始化完成前忽略。
    const work = archive && current(); if (!work) return;
    ctx.drawImage(cache, 0, 0, board.width, board.height);
    const px = board.width / (work.width + 2), py = board.height / (work.height + 2);
    const rim = Math.max(1.5, Math.min(px, py) * 0.08);
    // 2. 悬停格高亮与键盘落点分别描框。
    if (hover) { ctx.strokeStyle = "#FFFFFFB4"; ctx.lineWidth = rim; ctx.strokeRect((hover.x + 1) * px + rim / 2, (hover.y + 1) * py + rim / 2, px - rim, py - rim); }
    if (document.activeElement === board) { ctx.strokeStyle = "#F8E6A5"; ctx.lineWidth = rim; ctx.strokeRect((cursor.x + 1) * px + rim / 2, (cursor.y + 1) * py + rim / 2, px - rim, py - rim); }
  }
  /** 重绘缓存中的格子区域。@param {number} x0 起始列（含）。@param {number} y0 起始行（含）。@param {number} x1 结束列（含）。@param {number} y1 结束行（含）。@returns {void} 区域重铺底色后逐格重画，拖动补点不整板重绘。 */
  function repaintRegion(x0, y0, x1, y1) {
    const work = current(), context = cache.getContext("2d");
    const px = cache.width / (work.width + 2), py = cache.height / (work.height + 2);
    // 1. 区域向外扩一圈，保留相邻豆子的投影过渡，先重铺底色清除旧像素。
    const gx = Math.max(0, x0 - 1), gy = Math.max(0, y0 - 1), gw = Math.min(work.width - 1, x1 + 1), gh = Math.min(work.height - 1, y1 + 1);
    context.fillStyle = "#202A43"; context.fillRect((gx + 1) * px, (gy + 1) * py, (gw - gx + 1) * px, (gh - gy + 1) * py);
    // 2. 逐格重画销钉与豆子，与整板绘制保持一致。
    for (let y = gy; y <= gh; y++) for (let x = gx; x <= gw; x++) drawCell(context, work, x, y, px, py, 1, pixelPreview, false);
    compose();
  }
  /** 重绘画板和数量。@returns {void} 更新可见画板及历史按钮。 */
  function renderBoard() {
    // 1. 视图间距：适应模式跟随容器，手动模式保持并夹紧到安全范围。
    const work = current();
    if (autoFit) pitch = fitPitch();
    pitch = Math.max(PITCH_MIN, Math.min(PITCH_MAX, pitch));
    board.style.width = `${(work.width + 2) * pitch}px`; board.style.height = `${(work.height + 2) * pitch}px`;
    renderScene();
    // 2. 绘制当前作品与会话状态。
    el("dimensions").textContent = `${work.width} × ${work.height}`;
    el("undoBtn").disabled = undoStack.length === 0; el("redoBtn").disabled = redoStack.length === 0;
    updateZoomLabel();
    // 3. 颜色统计用安全节点，不插入用户 HTML。
    const counts = M.countColors(work); el("counts").replaceChildren(); let total = 0;
    for (const [bead, count] of Object.entries(counts)) {
      total += count; const row = document.createElement("div"), dot = document.createElement("i"), label = document.createElement("span"), value = document.createElement("strong");
      row.className = "count-row"; dot.style.setProperty("--bead", bead); label.textContent = bead; value.textContent = count; row.append(dot, label, value); el("counts").append(row);
    }
    el("beadTotal").textContent = `${total} 颗豆子 · ${Object.keys(counts).length} 色`;
  }
  /** 重绘作品列表和名称。@returns {void} 作品名仅以文本呈现。 */
  function renderWorks() {
    // 1. 列表创建可聚焦语义按钮，缩略图保持长宽比。
    el("works").replaceChildren(); el("workName").value = current().name; el("workCount").textContent = `${archive.works.length} / ${M.MAX_WORKS}`;
    for (const work of archive.works) {
      const button = document.createElement("button"), thumb = document.createElement("canvas"), name = document.createElement("span"), size = document.createElement("small");
      button.className = "work-item"; button.dataset.work = work.id; button.setAttribute("aria-pressed", String(work.id === archive.activeId));
      const scale = 96 / Math.max(work.width, work.height);
      thumb.width = Math.max(1, Math.round(work.width * scale)); thumb.height = Math.max(1, Math.round(work.height * scale));
      thumb.setAttribute("aria-hidden", "true"); drawWork(thumb, work, true);
      name.textContent = work.name; size.textContent = `${work.width} × ${work.height}`; name.append(size); button.append(thumb, name); el("works").append(button);
    }
    // 2. 保留至少一幅作品，容量满后禁止新增。
    el("deleteBtn").disabled = archive.works.length === 1;
    el("newBtn").disabled = archive.works.length >= M.MAX_WORKS; el("duplicateBtn").disabled = archive.works.length >= M.MAX_WORKS;
  }
  /** 重绘色盘与工具选择。@returns {void} 更新当前选择和可访问状态。 */
  function renderTools() { // 1. 同步按钮与自选颜色。
    el("selectedColor").textContent = color; el("customColor").value = color;
    for (const button of el("palette").children) button.setAttribute("aria-pressed", String(button.dataset.color === color));
    for (const button of el("tools").children) button.setAttribute("aria-pressed", String(button.dataset.tool === tool));
  }
  /** 切换作品并清空会话历史。@param {string} id 存在的作品标识。@returns {void} 结算笔画，换板回到适合视图。 */
  function switchWork(id) {
    // 1. 完成上一作品的笔画，不跨作品共享撤销。
    finishStroke(); archive.activeId = id; undoStack = []; redoStack = []; cursor = { x: 0, y: 0 };
    // 2. 换板复位视图与滚动，更新 UI 与持久化活动选择。
    autoFit = true; hover = null; vp.scrollLeft = vp.scrollTop = 0;
    renderWorks(); renderBoard(); queueSave();
  }
  /** 添加独立作品。@param {object} work 合法新作品。@returns {void} 容量满时不修改存档。 */
  function addWork(work) { // 1. 容量检查后一次合并。
    if (archive.works.length >= M.MAX_WORKS) { notify("最多保存 30 幅作品"); return; }
    finishStroke(); archive.works.push(work); switchWork(work.id);
  }
  /** 结算一次笔画。@returns {void} 一个拖动只记一次撤销，并排队保存。 */
  function finishStroke() {
    // 1. 没有笔画或未改变则不增加历史。
    if (!stroke) return;
    const before = stroke.before; stroke = null;
    if (before.every(sameCell)) return;
    // 2. 历史限定 80 步，新编辑清空重做分支。
    undoStack.push(before); if (undoStack.length > HISTORY_LIMIT) undoStack.shift(); redoStack = [];
    current().updatedAt = Math.max(Date.now(), current().createdAt); renderBoard(); renderWorks(); queueSave();
  }
  /** 比较格子。@param {string|null} cell 笔画前格值。@param {number} index 格索引。@returns {boolean} 是否未变。 */
  function sameCell(cell, index) { // 1. 比较当前作品对应格。
    return cell === current().cells[index];
  }
  /** 撤销或重做。@param {boolean} redo true 重做，false 撤销。@returns {void} 保存恢复后的格子。 */
  function history(redo) {
    // 1. 先结算笔画，再取对应历史。
    finishStroke(); const source = redo ? redoStack : undoStack, target = redo ? undoStack : redoStack;
    if (!source.length) return;
    // 2. 保留逆操作快照并持久化。
    target.push(current().cells.slice()); current().cells = source.pop(); current().updatedAt = Math.max(Date.now(), current().createdAt);
    renderBoard(); renderWorks(); queueSave();
  }
  /** 从指针映射到格子。@param {PointerEvent} event 浏览器指针坐标。@returns {object|null} 板内格坐标或 null；留边不绘制。 */
  function pointAt(event) { // 1. 使用实际缩放后的矩形，长宽各自换算，不受滚动或像素比影响。
    const rect = board.getBoundingClientRect(), work = current();
    const x = Math.floor((event.clientX - rect.left) / (rect.width / (work.width + 2))) - 1;
    const y = Math.floor((event.clientY - rect.top) / (rect.height / (work.height + 2))) - 1;
    return x >= 0 && y >= 0 && x < work.width && y < work.height ? { x, y } : null;
  }
  /** 当前工具作用于格子。@param {object} point 合法格坐标。@returns {void} 画笔补点并增量重绘，取色不改作品。 */
  function applyPoint(point) {
    // 1. 取色是单点操作，不修改作品。
    const work = current();
    if (tool === "pick") { const picked = work.cells[point.y * work.width + point.x]; if (picked) color = picked; renderTools(); cursor = point; hover = point; compose(); return; }
    const from = stroke.last || point;
    // 2. 填充作用于整板；画笔与橡皮按线段补点，从板外重入不连跨板线。
    if (tool === "fill") { if (!stroke.applied) M.floodFill(work, point, color); stroke.applied = true; }
    else M.paintLine(work, from, point, tool === "erase" ? null : color);
    // 3. 只重绘受影响区域：大幅板拖动不整板重画。
    if (tool === "fill") repaintRegion(0, 0, work.width - 1, work.height - 1);
    else repaintRegion(Math.min(from.x, point.x), Math.min(from.y, point.y), Math.max(from.x, point.x), Math.max(from.y, point.y));
    stroke.last = point; cursor = point; hover = point;
  }
  /** 处理双指手势。@returns {void} 双指落下时回滚未完成笔画；捏合比例缩放，双指移动按起点内容比例平移。 */
  function pinchGesture() {
    // 1. 手势开始：回滚未完成笔画，剩余手指在手指全离前不再画豆。
    if (!pinch) {
      if (stroke) { current().cells = stroke.before; stroke = null; hover = null; renderBoard(); }
      const [a, b] = [...touches.values()];
      const rect = vp.getBoundingClientRect(), work = current();
      // 1.1 冻结手势起点：中点对应的内容比例与双指距离，是整个手势的换算基准。
      const midX = (a.x + b.x) / 2 - rect.left, midY = (a.y + b.y) / 2 - rect.top;
      pinch = {
        pitch,
        dist: Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)),
        fx: (midX + vp.scrollLeft) / ((work.width + 2) * pitch),
        fy: (midY + vp.scrollTop) / ((work.height + 2) * pitch)
      };
      pinchLock = new Set(touches.keys());
      for (const id of pinchLock) {
        // 1.2 捕获两指事件，手指滑出画板也继续手势。
        try { board.setPointerCapture(id); } catch { /* 1.3 捕获失败时仍依赖事件冒泡。 */ }
      }
    }
    // 2. 任一指抬起即结束手势；两指全离后恢复画豆资格。
    if (touches.size < 2) { if (touches.size === 0) pinchLock.clear(); pinch = null; return; }
    // 3. 距离比例决定缩放，起点内容比例放回当前中点位置，缩放与平移一次完成。
    const [a, b] = [...touches.values()];
    const rect = vp.getBoundingClientRect();
    applyView(pinch.pitch * (Math.max(8, Math.hypot(a.x - b.x, a.y - b.y)) / pinch.dist), { x: (a.x + b.x) / 2 - rect.left, y: (a.y + b.y) / 2 - rect.top, fx: pinch.fx, fy: pinch.fy });
  }
  /** 处理画板指针。@param {PointerEvent} event 单个指针事件。@returns {void} 平移、双指与笔画互斥接管。 */
  function pointer(event) {
    // 1. 平移手势进行中：中键或右键拖动独占处理。
    if (panning) {
      if (event.pointerId !== panning.pointerId) return;
      if (event.type === "pointermove") {
        // 1.1 以滚动量抵消指针位移，画板内容随手拖动。
        vp.scrollLeft -= event.clientX - panning.x; vp.scrollTop -= event.clientY - panning.y;
        panning.x = event.clientX; panning.y = event.clientY;
      } else if (event.type === "pointerup" || event.type === "pointercancel" || event.type === "lostpointercapture") {
        panning = null; board.classList.remove("panning");
      }
      return;
    }
    // 2. 触摸点登记：双指手势优先于画豆。
    if (event.pointerType === "touch") {
      if (event.type === "pointerdown") touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
      else if (touches.has(event.pointerId)) {
        if (event.type === "pointermove") touches.set(event.pointerId, { x: event.clientX, y: event.clientY });
        else if (event.type === "pointerup" || event.type === "pointercancel") touches.delete(event.pointerId);
      }
      if (pinch || (event.type === "pointerdown" && touches.size >= 2)) { pinchGesture(); return; }
      // 2.1 全部手指离板后解除手势锁，恢复画豆资格。
      if (touches.size === 0) pinchLock.clear();
    }
    // 3. 中键或右键按下进入拖动平移。
    if (event.type === "pointerdown" && (event.button === 1 || event.button === 2) && !pinch) {
      event.preventDefault(); panning = { pointerId: event.pointerId, x: event.clientX, y: event.clientY };
      board.setPointerCapture(event.pointerId); board.classList.add("panning");
      return;
    }
    // 4. 画豆笔画：一次只接受主指针和左键。
    if (event.type === "pointerdown") {
      if (!event.isPrimary || event.button !== 0 || stroke || pinch || pinchLock.has(event.pointerId)) return;
      const point = pointAt(event); if (!point) return;
      event.preventDefault(); board.focus({ preventScroll: true }); board.setPointerCapture(event.pointerId);
      stroke = { pointerId: event.pointerId, before: current().cells.slice(), last: null, applied: false }; applyPoint(point);
    } else if (stroke && event.pointerId === stroke.pointerId) {
      // 5. 采样在画板外则断开插值，否则补齐所有格子。
      if (event.type === "pointermove") { const point = pointAt(event); if (point) applyPoint(point); else stroke.last = null; }
      else finishStroke();
    } else if (event.type === "pointermove" && event.pointerType === "mouse" && event.buttons === 0 && !pinch) {
      // 6. 无按键悬停：仅刷新高亮，不整板重绘。
      hover = pointAt(event); compose();
    }
  }
  /** 滚轮缩放画板。@param {WheelEvent} event 视口滚轮或触控板捏合。@returns {void} 以指针为不动点缩放。 */
  function wheel(event) {
    // 1. 初始化完成前忽略；板区滚轮统一用于缩放。
    if (!archive || !pitch) return;
    event.preventDefault();
    const factor = Math.exp(-event.deltaY * (event.ctrlKey ? 0.01 : 0.0022));
    const rect = vp.getBoundingClientRect();
    applyView(pitch * factor, { x: event.clientX - rect.left, y: event.clientY - rect.top });
  }
  /** 鼠标离开画板清除悬停。@returns {void} 只重绘高亮层。 */
  function leaveBoard() { // 1. 笔画进行中由指针捕获接管，不清除。
    if (stroke || panning) return;
    hover = null; compose();
  }
  /** 屏蔽画板原生右键菜单。@param {Event} event 上下文菜单事件。@returns {void} 右键已用于拖动平移。 */
  function suppressMenu(event) { // 1. 画板区域右键不弹系统菜单。
    event.preventDefault();
  }
  /** 视口尺寸变化。@returns {void} 适应模式重新贴合，手动模式仅刷新标签与清晰度。 */
  function viewportResized() { // 1. 初始化完成前不处理。
    if (!archive || !pitch) return;
    if (autoFit) fitView(); else { updateZoomLabel(); scheduleCrisp(); }
  }
  /** 窗口尺寸或像素比变化。@returns {void} 只重建清晰位图。 */
  function windowResized() { // 1. 不影响布局与滚动位置。
    if (archive && pitch) scheduleCrisp();
  }
  /** 处理键盘编辑与快捷键。@param {KeyboardEvent} event 页面键盘事件。@returns {void} 表单输入不拦截；画板方向键、空格与缩放可用。 */
  function keyboard(event) {
    // 1. 不抢占名称、自选颜色或下拉框输入。
    if (["INPUT", "SELECT", "TEXTAREA"].includes(event.target.tagName)) return;
    const key = event.key.toLowerCase();
    if ((event.ctrlKey || event.metaKey) && (key === "z" || key === "y")) { event.preventDefault(); history(key === "y" || event.shiftKey); return; }
    const shortcuts = { b: "paint", e: "erase", f: "fill", i: "pick" };
    if (shortcuts[key]) { finishStroke(); tool = shortcuts[key]; renderTools(); return; }
    // 2. 键盘焦点必须位于画板，方向移动不修改内容。
    if (event.target !== board) return;
    const directions = { ArrowLeft: [-1, 0], ArrowRight: [1, 0], ArrowUp: [0, -1], ArrowDown: [0, 1] };
    if (directions[event.key]) {
      event.preventDefault(); const [dx, dy] = directions[event.key];
      cursor = { x: Math.max(0, Math.min(current().width - 1, cursor.x + dx)), y: Math.max(0, Math.min(current().height - 1, cursor.y + dy)) }; compose();
    } else if (event.key === "+" || event.key === "=") { event.preventDefault(); applyView(pitch * 1.25); }
    else if (event.key === "-" || event.key === "_") { event.preventDefault(); applyView(pitch * 0.8); }
    else if (event.key === "0") { event.preventDefault(); fitView(); }
    else if (event.key === " " || event.key === "Delete" || event.key === "Backspace") {
      // 3. 一次按键形成一个完整笔画。
      event.preventDefault(); finishStroke(); stroke = { before: current().cells.slice(), last: null, applied: false };
      if (event.key !== " ") M.paintLine(current(), cursor, cursor, null); else applyPoint(cursor);
      finishStroke();
    }
  }
  /** 下载内存对象。@param {Blob} blob 下载数据。@param {string} filename 本地文件名。@returns {void} 创建下载并释放对象 URL。 */
  function download(blob, filename) { // 1. 临时链接只用于下载，不修改用户存档。
    const url = URL.createObjectURL(blob), link = document.createElement("a"); link.href = url; link.download = filename; link.click(); setTimeout(revoke, 1000);
    /** 释放本次下载地址。@returns {void} 清理浏览器资源。 */
    function revoke() { // 1. 下载开始后回收地址。
      URL.revokeObjectURL(url);
    }
  }
  /** 生成安全文件名。@returns {string} 不含路径分隔符的作品名。 */
  function filename() { // 1. 替换系统保留字符。
    return current().name.replace(/[<>:"/\\|?*\x00-\x1F]/g, "_");
  }
  /** 下载 PNG 成品。@returns {void} 绘制透明背景环豆图，不含刻度与焦点。 */
  function exportPNG() {
    // 1. 先结算绘制，再以每格 32 像素输出成品，矩形板按长宽分别设定尺寸。
    finishStroke(); const work = current(), canvas = document.createElement("canvas");
    canvas.width = work.width * 32; canvas.height = work.height * 32;
    const context = canvas.getContext("2d");
    for (let y = 0; y < work.height; y++) for (let x = 0; x < work.width; x++) if (work.cells[y * work.width + x]) drawBead(context, (x + 0.5) * 32, (y + 0.5) * 32, 32, work.cells[y * work.width + x], false);
    // 2. 异步编码，失败明确提示。
    canvas.toBlob(pngReady, "image/png");
    /** 接收编码后的图像。@param {Blob|null} blob PNG 或编码失败。@returns {void} 下载或报告错误。 */
    function pngReady(blob) { // 1. 成功才启动下载。
      if (blob) download(blob, filename() + ".png"); else notify("PNG 导出失败，请重试");
    }
  }
  /** 下载合法备份。@param {boolean} single 是否仅当前作品。@returns {void} 无存储写入，未保存的内存内容也能备份。 */
  function backup(single = false) { // 1. 先结算笔画，然后使用模型序列化。
    finishStroke(); const text = single ? M.exportWork(current()) : M.serializeArchive(archive);
    download(new Blob([text], { type: "application/json" }), single ? filename() + ".json" : "LinkPlay-拼豆存档.json");
  }
  /** 安全导入文件。@returns {Promise<void>} 全部校验后追加，失败不改已有作品。 */
  async function importFile() {
    // 1. 先检查文件大小，避免加载超大文件。
    const file = el("importFile").files[0]; if (!file) return;
    try {
      if (file.size > M.MAX_FILE_BYTES) throw new Error("文件超过 2 MB，导入未执行");
      const text = await file.text();
      // 2. 异步读取期间用户可能新建作品，使用最新容量并在最后一次性合并。
      const works = M.parseImport(text, archive.works.length);
      for (const work of works) work.id = newId();
      finishStroke(); archive.works.push(...works); switchWork(works[0].id); notify("");
    } catch (error) { notify(error.message); }
    finally { el("importFile").value = ""; }
  }
  /** 明确确认后重建损坏存档。@returns {Promise<void>} 只有锁内原文未变才允许覆盖，失败继续保留原文。 */
  async function rebuild() {
    // 1. 不默认覆盖；提示下载原始数据后由用户明确确认。
    if (!confirm("重建将替换损坏存档。请先导出原数据。确定重建？")) return;
    // 2. 同一事务内验证原文，成功才解除损坏保护，旧 localStorage 原文仍保留。
    try {
      const snapshot = M.serializeArchive(archive), next = { ...archive, revision: archive.revision + 1 }, raw = M.serializeArchive(next);
      if (!await store.compareAndSet(corruptRaw, raw)) { block("conflict"); return; }
      archive.revision = next.revision; expectedRaw = raw; corruptRaw = null; blocked = "";
      dirty = M.serializeArchive({ ...archive, revision: next.revision - 1 }) !== snapshot;
      if (channel) channel.postMessage(raw);
      if (dirty) queueSave(); else status("saved", "已保存到此浏览器");
    } catch { block("storage"); }
  }
  /** 页面按钮委托。@param {MouseEvent|PointerEvent} event 用户点击或触摸选择。@returns {void} 按明确按钮执行单一动作。 */
  function click(event) {
    // 1. 委托仅处理语义按钮。
    const button = event.target.closest("button"); if (!button || button.disabled) return;
    notify("");
    if (button.dataset.color) { finishStroke(); color = button.dataset.color; renderTools(); return; }
    if (button.dataset.tool) { finishStroke(); tool = button.dataset.tool; renderTools(); return; }
    if (button.dataset.work) { switchWork(button.dataset.work); return; }
    if (button.dataset.template) { addWork(template(button.dataset.template)); return; }
    if (button.dataset.preset) { el("newWidth").value = button.dataset.preset; el("newHeight").value = button.dataset.preset; return; }
    // 2. 管理与下载动作只作用于当前工作台。
    switch (button.id) {
      case "undoBtn": history(false); break;
      case "redoBtn": history(true); break;
      case "newBtn": {
        const width = Number(el("newWidth").value), height = Number(el("newHeight").value);
        if (!Number.isInteger(width) || !Number.isInteger(height) || width < M.MIN_DIM || width > M.MAX_DIM || height < M.MIN_DIM || height > M.MAX_DIM) { notify(`长宽须为 ${M.MIN_DIM}–${M.MAX_DIM} 的整数`); return; }
        addWork(M.createWork(newId(), "未命名作品", width, height)); break;
      }
      case "duplicateBtn": { const copy = M.validateWork(current()); copy.id = newId(); copy.name = (copy.name + " 副本").slice(0, 60); copy.createdAt = copy.updatedAt = Date.now(); addWork(copy); break; }
      case "deleteBtn": if (confirm(`删除“${current().name}”？`)) { finishStroke(); archive.works = archive.works.filter(notActive); switchWork(archive.works[0].id); } break;
      case "zoomInBtn": applyView(pitch * 1.25); break;
      case "zoomOutBtn": applyView(pitch * 0.8); break;
      case "zoomFitBtn": fitView(); break;
      case "previewBtn": pixelPreview = !pixelPreview; button.setAttribute("aria-pressed", String(pixelPreview)); renderBoard(); break;
      case "pngBtn": exportPNG(); break;
      case "backupBtn": backup(); break;
      case "exportWorkBtn": backup(true); break;
      case "importBtn": el("importFile").click(); break;
      case "rawBtn": download(new Blob([corruptRaw], { type: "text/plain" }), "拼豆-损坏原数据.txt"); break;
      case "rebuildBtn": rebuild(); break;
      case "reloadBtn": if (confirm("请先备份本页未保存的作品。确定重载？")) location.reload(); break;
      case "retryBtn": blocked = ""; queueSave(); break;
    }
  }
  /** 保留非活动作品。@param {object} work 内存作品。@returns {boolean} 是否保留。 */
  function notActive(work) { // 1. 删除只匹配当前标识。
    return work.id !== archive.activeId;
  }
  /** 直接响应触摸工具选择。@param {PointerEvent} event 主触摸指针抬起事件。@returns {void} 色盘和工具为幂等选择，不依赖快速画板拖动后可能被浏览器抑制的兼容 click。 */
  function touchTool(event) {
    // 1. 只处理主触摸指针及静态的颜色/工具按钮，不重复触发下载、新建或删除。
    if (event.pointerType !== "touch" || !event.isPrimary) return;
    const button = event.target.closest("button");
    if (button && (button.dataset.tool || button.dataset.color)) click(event);
    // 2. 后续原生 click 如存在，只会再次设置同一选择，不形成额外作品或历史。
  }
  /** 输入与选择事件。@param {Event} event 表单事件。@returns {void} 名称即时保存，视图与模型互不影响。 */
  function input(event) {
    // 1. 名称完整合法才持久化，空白输入明确报错。
    if (event.target.id === "workName") {
      finishStroke(); const name = event.target.value;
      if (!name.trim() || name.length > 60) { notify("名称须为 1–60 字符"); event.target.setAttribute("aria-invalid", "true"); return; }
      event.target.removeAttribute("aria-invalid"); notify(""); current().name = name; current().updatedAt = Math.max(Date.now(), current().createdAt);
      // 2. 不重绘输入框，避免输入法和光标被打断。
      for (const button of el("works").children) if (button.dataset.work === archive.activeId) button.querySelector("span").firstChild.textContent = name;
      queueSave();
    } else if (event.target.id === "customColor") { finishStroke(); color = event.target.value.toUpperCase(); renderTools(); }
    else if (event.target.id === "importFile" && event.type === "change") importFile();
  }
  /** 接收其他标签页更新。@param {MessageEvent} event 同源事务提交广播。@returns {void} 旧页禁止覆盖，保留内存供备份。 */
  function storageChanged(event) { // 1. 广播只提前提示冲突，真正写入保护始终由存储事务完成。
    if (event.data !== expectedRaw) block("conflict");
  }
  /** 页面隐藏或离开结算笔画。@returns {void} 保存以完整笔画为单位。 */
  function settle() { // 1. 页面生命周期变化时完成未抬起的笔画。
    finishStroke(); if (dirty && !blocked) saveQueue = saveQueue.then(persist);
  }
  /** 输出可读状态快照。@returns {string} JSON，无用户数据写入。 */
  function stateText() { // 1. 提供既有页面健康契约与可验证镜像。
    return JSON.stringify({ game: "beads", archive, tool, color, dirty, blocked, undo: undoStack.length, redo: redoStack.length, cursor, pitch: Math.round(pitch * 10) / 10, autoFit });
  }
  // 3. 创建色盘，读存档，首次绘制。
  for (const bead of M.PALETTE) {
    const button = document.createElement("button"), dot = document.createElement("i"); button.className = "swatch"; button.dataset.color = bead; button.style.setProperty("--bead", bead); button.setAttribute("aria-label", "选色 " + bead); dot.setAttribute("aria-hidden", "true"); button.append(dot); el("palette").append(button);
  }
  await load(); renderTools(); renderWorks(); renderBoard();
  // 4. 装配原生指针、键盘、视图和生命周期事件，不引入联机依赖。
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) board.addEventListener(type, pointer);
  board.addEventListener("focus", renderBoard); board.addEventListener("blur", renderBoard);
  board.addEventListener("pointerleave", leaveBoard);
  board.addEventListener("contextmenu", suppressMenu);
  vp.addEventListener("wheel", wheel, { passive: false });
  new ResizeObserver(viewportResized).observe(vp);
  window.addEventListener("resize", windowResized);
  document.addEventListener("click", click); document.addEventListener("pointerup", touchTool); document.addEventListener("keydown", keyboard); document.addEventListener("input", input); document.addEventListener("change", input);
  document.addEventListener("visibilitychange", settle); window.addEventListener("pagehide", settle); if (channel) channel.addEventListener("message", storageChanged); window.render_game_to_text = stateText;
})();
