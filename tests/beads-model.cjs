"use strict";
const { test } = require("node:test");
const assert = require("node:assert/strict");
const M = require("../beads-model.js");
/** 构造隔离存档。@returns {object} 单幅空白存档。 */
function archive() { // 1. 使用固定时间避免时序依赖。
  return { format: M.FORMAT, version: 1, revision: 0, activeId: "a", works: [M.createWork("a", "花园", 16, 16, 10)] };
}
/** 检查非法修改被拒绝。@param {Function} mutate 修改测试副本的函数。@returns {void} 不拒绝则断言失败。 */
function rejected(mutate) { // 1. 修改独立副本并断言整库校验拒绝。
  const value = archive(); mutate(value); assert.throws(/** 触发拒绝路径。@returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.validateArchive(value));
}
/** 构造旧版方板作品。@param {number} size 旧版边长。@returns {object} 仅含 size 字段的旧契约作品。 */
function legacyWork(size) { // 1. 模拟历史存档中的作品结构。
  return { id: "b", name: "旧版方板", size, cells: Array(size * size).fill(null), createdAt: 1, updatedAt: 1 };
}
const cases = [
  ["整库往返与单幅往返", /** @returns {void} 执行往返断言。 */ function () { // 1. 检查两种备份契约。
    const a = archive(); assert.deepEqual(M.parseArchive(M.serializeArchive(a)), a); assert.deepEqual(M.parseImport(M.exportWork(a.works[0])), a.works);
  }],
  ["校验返回隔离副本", /** @returns {void} 执行引用隔离断言。 */ function () { // 1. 外部修改不污染原数据。
    const a = archive(), copy = M.validateArchive(a); copy.works[0].cells[0] = "#FFFFFF"; assert.equal(a.works[0].cells[0], null);
  }],
  ["合法尺寸与矩形长宽全部可用", /** @returns {void} 检查预设与自定义尺寸。 */ function () { // 1. 每种尺寸都有对应格数。
    for (const size of M.SIZES) { const work = M.createWork("a", "测试", size); assert.equal(work.width, size); assert.equal(work.height, size); assert.equal(work.cells.length, size * size); }
    const rect = M.createWork("a", "测试", 48, 20); assert.equal(rect.cells.length, 960); assert.equal(M.createWork("a", "测试", M.MIN_DIM, M.MAX_DIM).cells.length, M.MIN_DIM * M.MAX_DIM);
  }],
  ["拒绝非法长宽", /** @returns {void} 执行非法尺寸断言。 */ function () { // 1. 拒绝越界、非整数与错误类型。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].width = 15; });
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].height = M.MAX_DIM + 1; });
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].width = 15.5; });
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].width = "24"; });
  }],
  ["旧版方板 size 兼容归一且非法值拒绝", /** @returns {void} 执行旧契约断言。 */ function () { // 1. 旧存档只含 size 也能读入。
    const work = M.validateWork(legacyWork(24)); assert.equal(work.width, 24); assert.equal(work.height, 24); assert.equal(work.cells.length, 576);
    assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 旧字段越界同样拒绝。 */ M.validateWork(legacyWork(M.MIN_DIM - 1)));
    const short = legacyWork(24); short.cells.pop(); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 格数必须匹配。 */ M.validateWork(short));
    const parsed = M.parseArchive(JSON.stringify({ format: M.FORMAT, version: 1, revision: 0, activeId: "b", works: [legacyWork(16)] }));
    assert.equal(parsed.works[0].width, 16); assert.equal(parsed.works[0].height, 16);
  }],
  ["拒绝颜色注入及短色码", /** @returns {void} 执行颜色安全断言。 */ function () { // 1. 格子不能承载 CSS 表达式。
    for (const color of ["red", "#fff", "url(x)", 0, undefined]) rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].cells[0] = color; });
  }],
  ["拒绝格数和稀疏数组", /** @returns {void} 执行数组完整性断言。 */ function () { // 1. 数量和每个索引都必须合法。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].cells.pop(); }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ delete a.works[0].cells[0]; });
  }],
  ["拒绝未知版本与格式", /** @returns {void} 执行版本断言。 */ function () { // 1. 不猜测未来版本。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.version = 2; }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.format = "other"; });
  }],
  ["拒绝非法修订", /** @returns {void} 执行修订边界断言。 */ function () { // 1. 修订必须可安全递增。
    for (const value of [-1, 0.5, Number.MAX_SAFE_INTEGER]) rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.revision = value; });
  }],
  ["拒绝重复及缺失标识", /** @returns {void} 执行标识断言。 */ function () { // 1. 标识唯一且活动作品存在。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works.push(a.works[0]); }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.activeId = "missing"; }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].id = ""; });
  }],
  ["拒绝空白及超长名称", /** @returns {void} 执行名称断言。 */ function () { // 1. 保护名称长度与非空性。
    for (const name of [" ", "x".repeat(61), null]) rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].name = name; });
  }],
  ["拒绝日期及时间倒退", /** @returns {void} 执行日期断言。 */ function () { // 1. 不接受非毫秒整数与倒序时间。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].createdAt = -1; }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].updatedAt = 9; }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works[0].updatedAt = "today"; });
  }],
  ["拒绝空库与超容量", /** @returns {void} 执行容量断言。 */ function () { // 1. 整库至少有一幅且不超过上限。
    rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works = []; }); rejected(/** 设置非法字段。 @param {object} a 隔离测试存档。@returns {void} 修改测试副本。 */ a => { /* 1. 注入当前用例的非法值。 */ a.works = Array(31).fill(a.works[0]); });
  }],
  ["无效导入与容量不足不修改原库", /** @returns {void} 执行导入原子性断言。 */ function () { // 1. 校验整份文件，不合并部分合法作品。
    const a = archive(), before = JSON.stringify(a), bad = archive(); bad.works.push({}); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.parseImport(JSON.stringify(bad), 1)); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.parseImport(JSON.stringify(a), 30)); assert.equal(JSON.stringify(a), before);
  }],
  ["损坏与超大 JSON 拒绝", /** @returns {void} 执行文件边界断言。 */ function () { // 1. 同时保护语法、字符与 UTF-8 字节上限。
    assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.parseArchive("{")); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.parseImport(" ".repeat(M.MAX_FILE_BYTES + 1))); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.parseImport("花".repeat(800000)));
  }],
  ["水平与斜线补点连续且幂等", /** @returns {void} 执行插值断言。 */ function () { // 1. 长跨度一次插值覆盖中间格。
    const w = archive().works[0]; assert.equal(M.paintLine(w, { x: 0, y: 0 }, { x: 15, y: 0 }, "#FFFFFF"), 16); assert.equal(M.paintLine(w, { x: 0, y: 0 }, { x: 15, y: 0 }, "#FFFFFF"), 0);
    assert.equal(M.paintLine(w, { x: 0, y: 1 }, { x: 14, y: 15 }, "#7768D8"), 15); for (let i = 0; i < 15; i++) assert.equal(w.cells[(i + 1) * 16 + i], "#7768D8");
  }],
  ["反向插值与擦除", /** @returns {void} 执行擦除断言。 */ function () { // 1. 两种方向都包含端点。
    const w = archive().works[0]; M.paintLine(w, { x: 15, y: 15 }, { x: 0, y: 0 }, "#FFFFFF"); assert.equal(M.paintLine(w, { x: 0, y: 0 }, { x: 15, y: 15 }, null), 16);
  }],
  ["矩形板插值不跨行串列", /** @returns {void} 执行行界断言。 */ function () { // 1. 行尾与下一行首不是连续点。
    const w = M.createWork("a", "矩形", 8, 4);
    assert.equal(M.paintLine(w, { x: 0, y: 1 }, { x: 7, y: 1 }, "#FFFFFF"), 8);
    for (let i = 8; i < 16; i++) assert.equal(w.cells[i], "#FFFFFF");
    assert.equal(w.cells[16], null); assert.equal(w.cells[7], null);
    assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 越界终点先校验后修改。 */ M.paintLine(w, { x: 0, y: 1 }, { x: 8, y: 1 }, "#FFFFFF"));
  }],
  ["非法坐标不会先修改格子", /** @returns {void} 执行修改前校验断言。 */ function () { // 1. 参数失败保留作品。
    const w = archive().works[0], before = w.cells.slice(); assert.throws(/** 触发拒绝路径。 @returns {*} 未抛错时返回模型结果。 */ () => /* 1. 调用当前非法输入。 */ M.paintLine(w, { x: 0, y: 0 }, { x: 16, y: 0 }, "#FFFFFF")); assert.deepEqual(w.cells, before);
  }],
  ["四邻接不跨行且相同色不循环", /** @returns {void} 执行填充边界断言。 */ function () { // 1. 行尾和下一行首并非邻居。
    const w = archive().works[0]; w.cells.fill("#202A43"); w.cells[15] = null; w.cells[16] = null;
    assert.equal(M.floodFill(w, { x: 15, y: 0 }, "#FFFFFF"), 1); assert.equal(w.cells[16], null); assert.equal(M.floodFill(w, { x: 15, y: 0 }, "#FFFFFF"), 0);
  }],
  ["矩形板填充以宽为行界", /** @returns {void} 执行矩形填充断言。 */ function () { // 1. 行界按宽度而不是高度。
    const w = M.createWork("a", "矩形", 8, 4); w.cells.fill("#202A43"); w.cells[7] = null; w.cells[8] = null;
    assert.equal(M.floodFill(w, { x: 7, y: 0 }, "#FFFFFF"), 1); assert.equal(w.cells[8], null);
    const whole = M.createWork("a", "矩形", 8, 4); assert.equal(M.floodFill(whole, { x: 0, y: 0 }, "#6CBEAF"), 32); assert.deepEqual(M.countColors(whole), { "#6CBEAF": 32 });
  }],
  ["整板填充和颜色统计", /** @returns {void} 执行计数断言。 */ function () { // 1. 每格只访问一次。
    const w = archive().works[0]; assert.equal(M.floodFill(w, { x: 0, y: 0 }, "#6CBEAF"), 256); assert.deepEqual(M.countColors(w), { "#6CBEAF": 256 });
  }],
];
for (const [name, body] of cases) test(name, body);
