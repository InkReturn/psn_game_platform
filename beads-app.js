/** 拼豆页面控制器：交互、会话历史、事务保护的本地存档与下载。 */
"use strict";
/** 启动独立工作台。@returns {Promise<void>} 装配页面；存储错误保留内存并展示恢复入口。 */
(async function startStudio() {
  // 1. 固定页面状态，持久化唯一来源为模型定义的整库。
  const M = window.BeadModel;
  const board = document.getElementById("beadBoard"), ctx = board.getContext("2d");
  const HISTORY_LIMIT = 80, store = window.BeadStore;
  const channel = typeof BroadcastChannel === "function" ? new BroadcastChannel(M.STORAGE_KEY) : null;
  let archive, expectedRaw = null, corruptRaw = null, blocked = "", dirty = false;
  let saveQueue = Promise.resolve(), color = M.PALETTE[3], tool = "paint", pixelPreview = false;
  let undoStack = [], redoStack = [], stroke = null, cursor = { x: 0, y: 0 };

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
  /** 制作独立模板。@param {string} kind garden 或 heart。@returns {object} 新 24 格作品，无既有作品副作用。 */
  function template(kind) {
    // 1. 创建空板，模板总作为新作品。
    const work = M.createWork(newId(), kind === "heart" ? "小小心意" : "像素花园", 24);
    // 2. 用有限格坐标绘制图案。
    if (kind === "heart") {
      const rows = ["01100110", "11111111", "11111111", "11111111", "01111110", "00111100", "00011000"];
      for (let y = 0; y < rows.length; y++) for (let x = 0; x < 8; x++) if (rows[y][x] === "1") work.cells[(y + 8) * 24 + x + 8] = M.PALETTE[6];
    } else {
      const flowers = [[7, 7, M.PALETTE[6]], [16, 10, M.PALETTE[3]], [9, 16, M.PALETTE[12]]];
      for (const [x, y, petal] of flowers) {
        for (let dy = -2; dy <= 2; dy++) for (let dx = -2; dx <= 2; dx++) if (Math.abs(dx) + Math.abs(dy) <= 3) work.cells[(y + dy) * 24 + x + dx] = petal;
        work.cells[y * 24 + x] = M.PALETTE[14];
        for (let stem = y + 3; stem <= 21; stem++) work.cells[stem * 24 + x] = M.PALETTE[10];
        work.cells[(y + 5) * 24 + x + 1] = M.PALETTE[9]; work.cells[(y + 4) * 24 + x + 2] = M.PALETTE[9];
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
    } catch { archive = freshArchive(); block("storage"); return; }
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
  /** 绘制画板或缩略图。@param {HTMLCanvasElement} canvas 目标画布。@param {object} work 合法作品。@param {boolean} thumb 是否仅绘缩略像素。@returns {void} 修改画布，不写存储。 */
  function drawWork(canvas, work, thumb = false) {
    // 1. 画板留一格刻度边，缩略图不留边。
    const context = canvas.getContext("2d"), margin = thumb ? 0 : 1, pitch = canvas.width / (work.size + margin * 2);
    context.clearRect(0, 0, canvas.width, canvas.height); context.fillStyle = "#202A43"; context.fillRect(0, 0, canvas.width, canvas.height);
    // 2. 各格打孔并绘制环豆，避免 DOM 格子造成高密度卡顿。
    for (let y = 0; y < work.size; y++) for (let x = 0; x < work.size; x++) {
      const cx = (x + margin + 0.5) * pitch, cy = (y + margin + 0.5) * pitch, bead = work.cells[y * work.size + x];
      if (!thumb) {
        context.beginPath(); context.arc(cx, cy + pitch * 0.025, pitch * 0.11, 0, Math.PI * 2); context.fillStyle = "#111A2D"; context.fill();
        context.beginPath(); context.arc(cx, cy, pitch * 0.07, 0, Math.PI * 2); context.fillStyle = "#52627E"; context.fill();
      }
      if (bead) drawBead(context, cx, cy, pitch, bead, thumb || pixelPreview);
    }
    // 3. 画板显示坐标刻度和键盘落点。
    if (!thumb) {
      context.font = `${Math.max(9, pitch * 0.3)}px Segoe UI`; context.fillStyle = "#B4C1D9"; context.textAlign = "center";
      for (let i = 0; i < work.size; i += 4) { context.fillText(String(i + 1), (i + 1.5) * pitch, pitch * 0.67); context.fillText(String(i + 1), pitch * 0.45, (i + 1.6) * pitch); }
      if (document.activeElement === board) { context.strokeStyle = "#F8E6A5"; context.lineWidth = 2; context.strokeRect((cursor.x + 1) * pitch, (cursor.y + 1) * pitch, pitch, pitch); }
    }
  }
  /** 重绘画板和数量。@returns {void} 更新可见画板及历史按钮。 */
  function renderBoard() {
    // 1. 绘制当前作品与会话状态。
    const work = current(); drawWork(board, work); el("dimensions").textContent = `${work.size} × ${work.size}`;
    el("undoBtn").disabled = undoStack.length === 0; el("redoBtn").disabled = redoStack.length === 0;
    // 2. 颜色统计用安全节点，不插入用户 HTML。
    const counts = M.countColors(work); el("counts").replaceChildren(); let total = 0;
    for (const [bead, count] of Object.entries(counts)) {
      total += count; const row = document.createElement("div"), dot = document.createElement("i"), label = document.createElement("span"), value = document.createElement("strong");
      row.className = "count-row"; dot.style.setProperty("--bead", bead); label.textContent = bead; value.textContent = count; row.append(dot, label, value); el("counts").append(row);
    }
    el("beadTotal").textContent = `${total} 颗豆子 · ${Object.keys(counts).length} 色`;
  }
  /** 重绘作品列表和名称。@returns {void} 作品名仅以文本呈现。 */
  function renderWorks() {
    // 1. 列表创建可聚焦语义按钮。
    el("works").replaceChildren(); el("workName").value = current().name; el("workCount").textContent = `${archive.works.length} / ${M.MAX_WORKS}`;
    for (const work of archive.works) {
      const button = document.createElement("button"), thumb = document.createElement("canvas"), name = document.createElement("span"), size = document.createElement("small");
      button.className = "work-item"; button.dataset.work = work.id; button.setAttribute("aria-pressed", String(work.id === archive.activeId));
      thumb.width = 96; thumb.height = 96; thumb.setAttribute("aria-hidden", "true"); drawWork(thumb, work, true);
      name.textContent = work.name; size.textContent = `${work.size} × ${work.size}`; name.append(size); button.append(thumb, name); el("works").append(button);
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
  /** 切换作品并清空会话历史。@param {string} id 存在的作品标识。@returns {void} 结算笔画，保存活动作品。 */
  function switchWork(id) {
    // 1. 完成上一作品的笔画，不跨作品共享撤销。
    finishStroke(); archive.activeId = id; undoStack = []; redoStack = []; cursor = { x: 0, y: 0 };
    // 2. 更新 UI 与持久化活动选择。
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
  function pointAt(event) { // 1. 使用实际缩放后的矩形，不受滚动或像素比影响。
    const rect = board.getBoundingClientRect(), size = current().size, pitch = rect.width / (size + 2);
    const x = Math.floor((event.clientX - rect.left) / pitch) - 1, y = Math.floor((event.clientY - rect.top) / pitch) - 1;
    return x >= 0 && y >= 0 && x < size && y < size ? { x, y } : null;
  }
  /** 当前工具作用于格子。@param {object} point 合法格坐标。@returns {void} 画笔补点，取色不改作品。 */
  function applyPoint(point) {
    // 1. 取色和填充是单点操作。
    if (tool === "pick") { const picked = current().cells[point.y * current().size + point.x]; if (picked) color = picked; renderTools(); return; }
    if (tool === "fill") { if (!stroke.applied) M.floodFill(current(), point, color); stroke.applied = true; }
    // 2. 拖动补点；从板外重入不连跨板线。
    else M.paintLine(current(), stroke.last || point, point, tool === "erase" ? null : color);
    stroke.last = point; cursor = point; renderBoard();
  }
  /** 处理画板指针。@param {PointerEvent} event 单个主指针事件。@returns {void} 捕获拖动，取消或抬起结算。 */
  function pointer(event) {
    // 1. 一次只接受主指针和左键，忽略触摸第二指。
    if (event.type === "pointerdown") {
      if (!event.isPrimary || event.button !== 0 || stroke) return;
      const point = pointAt(event); if (!point) return;
      event.preventDefault(); board.focus({ preventScroll: true }); board.setPointerCapture(event.pointerId);
      stroke = { pointerId: event.pointerId, before: current().cells.slice(), last: null, applied: false }; applyPoint(point);
    } else if (stroke && event.pointerId === stroke.pointerId) {
      // 2. 采样在画板外则断开插值，否则补齐所有格子。
      if (event.type === "pointermove") { const point = pointAt(event); if (point) applyPoint(point); else stroke.last = null; }
      else finishStroke();
    }
  }
  /** 处理键盘编辑与快捷键。@param {KeyboardEvent} event 页面键盘事件。@returns {void} 表单输入不拦截；画板方向键与空格可用。 */
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
      event.preventDefault(); const [dx, dy] = directions[event.key]; cursor = { x: Math.max(0, Math.min(current().size - 1, cursor.x + dx)), y: Math.max(0, Math.min(current().size - 1, cursor.y + dy)) }; renderBoard();
    } else if (event.key === " " || event.key === "Delete" || event.key === "Backspace") {
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
    // 1. 先结算绘制，再以每格 32 像素输出成品。
    finishStroke(); const work = current(), canvas = document.createElement("canvas"); canvas.width = canvas.height = work.size * 32;
    const context = canvas.getContext("2d");
    for (let y = 0; y < work.size; y++) for (let x = 0; x < work.size; x++) if (work.cells[y * work.size + x]) drawBead(context, (x + 0.5) * 32, (y + 0.5) * 32, 32, work.cells[y * work.size + x], false);
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
    // 2. 管理与下载动作只作用于当前工作台。
    switch (button.id) {
      case "undoBtn": history(false); break;
      case "redoBtn": history(true); break;
      case "newBtn": addWork(M.createWork(newId(), "未命名作品", Number(el("newSize").value))); break;
      case "duplicateBtn": { const copy = M.validateWork(current()); copy.id = newId(); copy.name = (copy.name + " 副本").slice(0, 60); copy.createdAt = copy.updatedAt = Date.now(); addWork(copy); break; }
      case "deleteBtn": if (confirm(`删除“${current().name}”？`)) { finishStroke(); archive.works = archive.works.filter(notActive); switchWork(archive.works[0].id); } break;
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
  /** 输入与选择事件。@param {Event} event 表单事件。@returns {void} 名称即时保存，缩放不改变模型。 */
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
    else if (event.target.id === "zoom") { const zoom = Number(event.target.value); board.style.width = `${zoom * 100}%`; }
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
    return JSON.stringify({ game: "beads", archive, tool, color, dirty, blocked, undo: undoStack.length, redo: redoStack.length, cursor });
  }
  // 2. 创建色盘，读存档，首次绘制。
  for (const bead of M.PALETTE) {
    const button = document.createElement("button"), dot = document.createElement("i"); button.className = "swatch"; button.dataset.color = bead; button.style.setProperty("--bead", bead); button.setAttribute("aria-label", "选色 " + bead); dot.setAttribute("aria-hidden", "true"); button.append(dot); el("palette").append(button);
  }
  await load(); renderTools(); renderWorks(); renderBoard();
  // 3. 装配原生指针、键盘和生命周期事件，不引入联机依赖。
  for (const type of ["pointerdown", "pointermove", "pointerup", "pointercancel", "lostpointercapture"]) board.addEventListener(type, pointer);
  board.addEventListener("focus", renderBoard); board.addEventListener("blur", renderBoard);
  document.addEventListener("click", click); document.addEventListener("pointerup", touchTool); document.addEventListener("keydown", keyboard); document.addEventListener("input", input); document.addEventListener("change", input);
  document.addEventListener("visibilitychange", settle); window.addEventListener("pagehide", settle); if (channel) channel.addEventListener("message", storageChanged); window.render_game_to_text = stateText;
})();
