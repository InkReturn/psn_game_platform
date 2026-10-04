/** 赛博拼豆纯模型：校验、插值与文件契约，不访问浏览器存储。 */
"use strict";
/** 构造跨浏览器与 Node 的纯规则 API。@returns {object} 唯一数据契约与无存储副作用的模型函数。 */
const BeadModel = (function createModel() {
  // 1. 定义唯一存档契约与业务上限，组装下方纯函数。
  const FORMAT = "linkplay-beads", VERSION = 1, STORAGE_KEY = "linkplay.beads.v1";
  const SIZES = Object.freeze([16, 24, 32, 48, 64]);
  const MAX_WORKS = 30, MAX_FILE_BYTES = 2 * 1024 * 1024;
  const PALETTE = Object.freeze(["#202A43", "#FFFFFF", "#B7C1D4", "#7768D8", "#A79AEA", "#D9CFF5", "#F27593", "#C4496B", "#F9B4C6", "#6CBEAF", "#348E81", "#B8E3D7", "#F2C85B", "#D99E3D", "#F8E6A5", "#6DA9DC", "#3674B1", "#B9D9EF", "#ED9568", "#BA623D", "#F7C7A5", "#7FA268", "#4B704B", "#C5D7A7"]);

  /** 检查业务条件，失败抛出可展示的错误。@param {boolean} valid 条件结果。@param {string} message 错误内容。@returns {void} */
  function requireValid(valid, message) {
    // 1. 在边界处拒绝非法数据。
    if (!valid) throw new Error(message);
  }
  /** 校验颜色。@param {*} color null 或六位十六进制颜色。@returns {void} 非法时抛错。 */
  function validateColor(color) {
    // 1. 不接受 CSS 表达式或缩写。
    requireValid(color === null || (typeof color === "string" && /^#[0-9A-Fa-f]{6}$/.test(color)), "颜色格式无效");
  }
  /** 创建独立空白作品。@param {string} id 唯一标识，1–100 字符。@param {string} name 名称，1–60 字符。@param {number} size 合法方板边长。@param {number} now 创建时间的非负整数毫秒。@returns {object} 新作品；非法参数抛错。 */
  function createWork(id, name = "未命名作品", size = 24, now = Date.now()) {
    // 1. 分配内存前拒绝非契约尺寸，再构造独立格子与时间信息。
    requireValid(SIZES.includes(size), "画板尺寸无效");
    const work = { id, name, size, cells: Array(size * size).fill(null), createdAt: now, updatedAt: now };
    // 2. 复用完整校验保证所有入口遵守同一契约。
    return validateWork(work);
  }
  /** 校验并复制作品，只返回受支持字段。@param {*} work 外部作品对象。@returns {object} 隔离副本；格式错误抛错，无输入副作用。 */
  function validateWork(work) {
    // 1. 校验结构、标识、名称与尺寸。
    requireValid(work && typeof work === "object" && !Array.isArray(work), "作品格式无效");
    requireValid(typeof work.id === "string" && work.id.length > 0 && work.id.length <= 100, "作品标识无效");
    requireValid(typeof work.name === "string" && work.name.trim().length > 0 && work.name.length <= 60, "名称须为 1–60 字符");
    requireValid(SIZES.includes(work.size), "画板尺寸无效");
    requireValid(Array.isArray(work.cells) && work.cells.length === work.size * work.size, "格子数量无效");
    // 2. 校验每格颜色与时间，拒绝稀疏数组。
    for (let i = 0; i < work.cells.length; i++) validateColor(work.cells[i]);
    requireValid(Number.isSafeInteger(work.createdAt) && work.createdAt >= 0 && Number.isSafeInteger(work.updatedAt) && work.updatedAt >= work.createdAt, "作品日期无效");
    // 3. 丢弃未知字段，阻止外部引用修改内存。
    return { id: work.id, name: work.name, size: work.size, cells: work.cells.slice(), createdAt: work.createdAt, updatedAt: work.updatedAt };
  }
  /** 校验整库存档。@param {*} archive 外部存档。@returns {object} 校验后的隔离副本；非法版本、重复标识等抛错。 */
  function validateArchive(archive) {
    // 1. 校验版本、修订与容量。
    requireValid(archive && archive.format === FORMAT && archive.version === VERSION, "存档格式或版本不支持");
    requireValid(Number.isSafeInteger(archive.revision) && archive.revision >= 0 && archive.revision < Number.MAX_SAFE_INTEGER, "存档修订无效");
    requireValid(Array.isArray(archive.works) && archive.works.length >= 1 && archive.works.length <= MAX_WORKS, "作品数量须为 1–30 幅");
    // 2. 独立校验作品和唯一性，活动作品必须存在。
    const works = archive.works.map(validateWork);
    const ids = new Set(works.map(workId));
    requireValid(ids.size === works.length, "作品标识重复");
    requireValid(ids.has(archive.activeId), "当前作品不存在");
    // 3. 输出受支持字段。
    return { format: FORMAT, version: VERSION, revision: archive.revision, activeId: archive.activeId, works };
  }
  /** 提取标识。@param {object} work 合法作品。@returns {string} 作品标识。 */
  function workId(work) { // 1. 返回唯一标识。
    return work.id;
  }
  /** 解析有界 JSON。@param {string} text UTF-8 文件文本。@returns {*} JSON 值；超限或解析失败抛错。 */
  function parseJSON(text) {
    // 1. 同时限制字符量与实际 UTF-8 字节数。
    requireValid(typeof text === "string" && text.length <= MAX_FILE_BYTES && new TextEncoder().encode(text).length <= MAX_FILE_BYTES, "文件超过 2 MB");
    // 2. 将语法错误转为稳定业务消息。
    try { return JSON.parse(text); } catch { throw new Error("JSON 存档已损坏"); }
  }
  /** 读取本地整库。@param {string} text 存档文本。@returns {object} 合法隔离存档；损坏抛错。 */
  function parseArchive(text) { // 1. 解析后完整校验。
    return validateArchive(parseJSON(text));
  }
  /** 序列化整库。@param {object} archive 内存存档。@returns {string} JSON；非法数据抛错。 */
  function serializeArchive(archive) { // 1. 校验后序列化。
    return JSON.stringify(validateArchive(archive));
  }
  /** 导出单幅。@param {object} work 合法作品。@returns {string} 可导入的 JSON；非法作品抛错。 */
  function exportWork(work) { // 1. 按单幅契约包装。
    return JSON.stringify({ format: "linkplay-beads-work", version: VERSION, work: validateWork(work) });
  }
  /** 解析导入，不写入现有作品。@param {string} text 有界文件文本。@param {number} existingCount 现有作品数量，0–30。@returns {object[]} 全部合法作品副本；容量或格式错误整体拒绝。 */
  function parseImport(text, existingCount = 0) {
    // 1. 验证整个文件，不允许部分成功。
    const value = parseJSON(text);
    const works = value && value.format === "linkplay-beads-work" && value.version === VERSION ? [validateWork(value.work)] : validateArchive(value).works;
    // 2. 在合并前检查总容量；标识重新分配由控制器完成。
    requireValid(Number.isInteger(existingCount) && existingCount >= 0 && existingCount + works.length <= MAX_WORKS, "最多保存 30 幅作品，导入未执行");
    return works;
  }
  /** 校验格坐标。@param {object} work 合法作品。@param {object} point 格坐标 {x,y}，零起点。@returns {void} 越界或非整数抛错。 */
  function validatePoint(work, point) { // 1. 拒绝板外与非整数坐标。
    requireValid(point && Number.isInteger(point.x) && Number.isInteger(point.y) && point.x >= 0 && point.y >= 0 && point.x < work.size && point.y < work.size, "格子坐标越界");
  }
  /** 直线补点放豆。@param {object} work 将原地修改 cells 的作品。@param {object} from 起始格。@param {object} to 终止格。@param {string|null} color 六位颜色，null 擦除。@returns {number} 改变的格数；非法参数抛错。 */
  function paintLine(work, from, to, color) {
    // 1. 修改前验证全部参数。
    validatePoint(work, from); validatePoint(work, to); validateColor(color);
    // 2. Bresenham 插值，稀疏指针事件也不会断线。
    let x = from.x, y = from.y, changed = 0;
    const dx = Math.abs(to.x - x), dy = -Math.abs(to.y - y), sx = x < to.x ? 1 : -1, sy = y < to.y ? 1 : -1;
    let error = dx + dy;
    for (;;) {
      const index = y * work.size + x;
      if (work.cells[index] !== color) { work.cells[index] = color; changed++; }
      if (x === to.x && y === to.y) break;
      const twice = 2 * error;
      if (twice >= dy) { error += dy; x += sx; }
      if (twice <= dx) { error += dx; y += sy; }
    }
    return changed;
  }
  /** 四邻接填充。@param {object} work 将原地修改的作品。@param {object} point 起始格。@param {string|null} color 目标颜色。@returns {number} 改变格数；非法参数抛错，无跨行填充。 */
  function floodFill(work, point, color) {
    // 1. 校验参数，相同颜色立即结束。
    validatePoint(work, point); validateColor(color);
    const start = point.y * work.size + point.x, original = work.cells[start];
    if (original === color) return 0;
    // 2. 入栈时标记，避免重复遍历；显式保护左右行界。
    const stack = [start]; work.cells[start] = color; let changed = 0;
    while (stack.length) {
      const index = stack.pop(), x = index % work.size, y = Math.floor(index / work.size);
      changed++;
      const neighbors = [];
      if (x > 0) neighbors.push(index - 1);
      if (x < work.size - 1) neighbors.push(index + 1);
      if (y > 0) neighbors.push(index - work.size);
      if (y < work.size - 1) neighbors.push(index + work.size);
      for (const next of neighbors) if (work.cells[next] === original) { work.cells[next] = color; stack.push(next); }
    }
    return changed;
  }
  /** 统计各色豆数。@param {object} work 合法作品。@returns {object} 颜色到数量的映射，无输入副作用。 */
  function countColors(work) { // 1. 忽略空格，累计颜色。
    const counts = {};
    for (const color of work.cells) if (color !== null) counts[color] = (counts[color] || 0) + 1;
    return counts;
  }
  return { FORMAT, VERSION, STORAGE_KEY, SIZES, PALETTE, MAX_WORKS, MAX_FILE_BYTES, createWork, validateWork, validateArchive, parseArchive, serializeArchive, exportWork, parseImport, paintLine, floodFill, countColors };
})();
if (typeof module !== "undefined" && module.exports) module.exports = BeadModel;
if (typeof window !== "undefined") window.BeadModel = BeadModel;
