/** 真实拼豆浏览器验收：操作、下载、异常和触摸，finally 清理自己的服务与浏览器。 */
"use strict";
const assert = require("node:assert/strict"), fs = require("node:fs"), path = require("node:path"), net = require("node:net");
const { spawn } = require("node:child_process");
const { chromium } = require("playwright");
const M = require("../beads-model.js");
const ROOT = path.resolve(__dirname, ".."), OUT = path.join(ROOT, "outputs");
let server, browser, base, passed = 0;
const contexts = [], errors = [];

/** 获取回环空闲端口。@returns {Promise<number>} 操作系统分配端口，探针立即关闭；失败抛错。 */
async function freePort() {
  // 1. 仅临时监听回环，避免占用已有服务。
  const probe = net.createServer(); await new Promise(listen);
  const port = probe.address().port; await new Promise(closeProbe); return port;
  /** 开始监听。@param {Function} resolve 就绪回调。@param {Function} reject 错误回调。@returns {void} 装配探针。 */
  function listen(resolve, reject) { // 1. 绑定随机端口。
    probe.once("error", reject); probe.listen(0, "127.0.0.1", resolve);
  }
  /** 关闭探针。@param {Function} resolve 关闭回调。@returns {void} 释放临时监听。 */
  function closeProbe(resolve) { // 1. 仅关闭本用例探针。
    probe.close(resolve);
  }
}
/** 启动或复用测试服务。@returns {Promise<void>} 等到 health 成功；启动失败抛错。 */
async function startServer() {
  // 1. 无 BASE_URL 时启动本 worktree 的实际 Express + WS 服务。
  if (process.env.BASE_URL) { base = process.env.BASE_URL; return; }
  const port = await freePort(); base = `http://127.0.0.1:${port}`;
  server = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env: { ...process.env, PORT: String(port), BIND_HOST: "127.0.0.1" }, stdio: "inherit" });
  // 2. 有界健康轮询，并检查自己的进程没有提前退出。
  const deadline = Date.now() + 15000;
  while (Date.now() < deadline) {
    if (server.exitCode !== null) throw new Error("临时服务提前退出");
    try { const response = await fetch(base + "/health"); if (response.ok && (await response.json()).status === "ok") return; } catch { /* 2.1 启动窗口内允许连接未就绪。 */ }
    await new Promise(nextPoll);
  }
  throw new Error("临时服务未就绪");
  /** 调度下一次健康探针。@param {Function} resolve 延时完成回调。@returns {void} 只为启动探针设定短间隔。 */
  function nextPoll(resolve) { // 1. 重试间隔不是页面验收的固定等待。
    setTimeout(resolve, 100);
  }
}
/** 创建隔离上下文。@param {object} options Playwright 上下文配置，默认为桌面。@returns {Promise<object>} 上下文与页面；自动收集页面错误。 */
async function context(options = {}) { // 1. 记录上下文，finally 统一关闭。
  const ctx = await browser.newContext({ viewport: { width: 1366, height: 900 }, ...options }); contexts.push(ctx);
  const page = await ctx.newPage(); page.on("pageerror", pageError); return { ctx, page };
}
/** 收集浏览器异常。@param {Error} error 未处理页面异常。@returns {void} 记录最终断言。 */
function pageError(error) { // 1. 不静默忽略页面异常。
  errors.push(error.message);
}
/** 读取页面镜像。@param {object} page Playwright 页面。@returns {Promise<object>} 当前快照。 */
async function state(page) { // 1. 仅使用页面公开健康契约。
  return page.evaluate(readState);
}
/** 浏览器侧镜像读取。@returns {object} JSON 状态。 */
function readState() { // 1. 解析页面健康输出。
  return JSON.parse(window.render_game_to_text());
}
/** 等待完整保存。@param {object} page Playwright 页面。@returns {Promise<void>} 保存完成或超时抛错。 */
async function saved(page) { // 1. 以真实状态作为完成条件，不靠固定 sleep。
  await page.waitForFunction(isSaved);
}
/** 浏览器侧保存条件。@returns {boolean} 内存无待保存且无保护状态。 */
function isSaved() { // 1. 检查控制器镜像。
  const s = JSON.parse(window.render_game_to_text()); return !s.dirty && !s.blocked;
}
/** 打开工作台。@param {object} page Playwright 页面。@returns {Promise<void>} 等到初始化完成。 */
async function open(page) { // 1. 只访问测试服务。
  await page.goto(base + "/beads.html"); await page.waitForFunction(hookReady);
}
/** 浏览器侧初始化条件。@returns {boolean} 页面健康钩子就绪。 */
function hookReady() { // 1. 控制器最后一步提供钩子。
  return typeof window.render_game_to_text === "function";
}
/** 当前活动作品提取。@param {object} s 页面状态。@returns {object} 活动作品。 */
function active(s) { // 1. 查找当前标识。
  for (const work of s.archive.works) if (work.id === s.archive.activeId) return work;
}
/** 计算板格的屏幕中心。@param {object} page Playwright 页面。@param {number} x 零起点列。@param {number} y 零起点行。@returns {Promise<object>} 鼠标/触摸屏幕坐标。 */
async function cell(page, x, y) { // 1. 按实际缩放尺寸与留边计算。
  await page.locator("#beadBoard").scrollIntoViewIfNeeded();
  const size = active(await state(page)).size, box = await page.locator("#beadBoard").boundingBox(), pitch = box.width / (size + 2);
  return { x: box.x + (x + 1.5) * pitch, y: box.y + (y + 1.5) * pitch };
}
/** 点击板格。@param {object} page Playwright 页面。@param {number} x 零起点列。@param {number} y 零起点行。@returns {Promise<void>} 完成真实鼠标点击。 */
async function paint(page, x, y) { // 1. 使用实际鼠标事件，不直接修改模型。
  const point = await cell(page, x, y); assert.ok(point.y >= 0 && point.y < page.viewportSize().height, `格坐标超出视口: ${JSON.stringify(point)}, viewport=${JSON.stringify(page.viewportSize())}`); await page.mouse.click(point.x, point.y);
}
/** 执行一项计数验收。@param {string} name 用例名称。@param {Function} run 异步操作与断言。@returns {Promise<void>} 失败抛错，禁止零匹配通过。 */
async function check(name, run) { // 1. 执行成功后计数，失败保留精确用例名。
  try { await run(); passed++; console.log(`PASS ${passed} ${name}`); } catch (error) { throw new Error(`${name}: ${error.message}`, { cause: error }); }
}
/** 下载按钮产物。@param {object} page Playwright 页面。@param {string} selector 下载按钮选择器。@param {string} output ignored outputs 下文件名。@returns {Promise<Buffer>} 实际下载文件内容。 */
async function downloaded(page, selector, output) { // 1. 等下载事件后保存真实产物。
  const promise = page.waitForEvent("download"); await page.click(selector); const download = await promise;
  const target = path.join(OUT, output); await download.saveAs(target); return fs.readFileSync(target);
}
/** 设置浏览器本地损坏数据。@returns {void} 仅操作隔离测试上下文。 */
async function corruptStorage() { // 1. 在唯一事务库中故意植入损坏 fixture。
  const raw = await window.BeadStore.read(); await window.BeadStore.compareAndSet(raw, "{broken-json");
}
/** 浏览器侧读取原文。@returns {string|null} 当前测试存档文本。 */
function rawStorage() { // 1. 不解析用于比对未覆盖。
  return window.BeadStore.read();
}
/** 注入存储不可用 fixture。@returns {void} 测试上下文禁用所有存储读写。 */
function denyStorage() { // 1. 模拟浏览器策略拒绝。
  window.beadTestOpen = IDBFactory.prototype.open; IDBFactory.prototype.open = denied;
  /** 拒绝读写。@returns {never} 抛出策略错误。 */
  function denied() { // 1. 模拟真实安全错误。
    throw new DOMException("测试存储不可用", "SecurityError");
  }
}
/** 恢复测试存储能力。@returns {void} 仅撤销当前 fixture 的方法覆盖。 */
function restoreStorage() { // 1. 用户解除浏览器存储策略后可明确重试。
  IDBFactory.prototype.open = window.beadTestOpen;
}
/** 注入配额失败 fixture。@returns {void} 仅让写存储失败。 */
function quotaStorage() { // 1. 保持可读取，模拟写满。
  IDBObjectStore.prototype.put = full;
  /** 拒绝存储写入。@returns {never} 抛出配额错误。 */
  function full() { // 1. 保留已有存档。
    throw new DOMException("测试配额已满", "QuotaExceededError");
  }
}
/** 检查真实浏览器安全上下文。@returns {boolean} 公网 HTTP 应为 false。 */
function secureContext() { // 1. 不用测试注入伪装安全能力。
  return window.isSecureContext;
}
/** 浏览器侧等待未保存。@param {string} reason 预期保护原因。@returns {boolean} 当前是否符合原因。 */
function blockedBy(reason) { // 1. 精确比对而不是只看提示文字。
  return JSON.parse(window.render_game_to_text()).blocked === reason;
}
/** 浏览器侧检查页面溢出。@returns {boolean} 页面宽度不超过视口。 */
function noOverflow() { // 1. 板内滚动允许，但页面不能横向溢出。
  return document.documentElement.scrollWidth <= window.innerWidth;
}
/** 接受确认框。@param {object} dialog 浏览器原生确认框。@returns {Promise<void>} 明确模拟用户确认。 */
async function accept(dialog) { // 1. 只注册到当前一次测试操作。
  await dialog.accept();
}
/** 拒绝确认框。@param {object} dialog 浏览器原生确认框。@returns {Promise<void>} 模拟用户取消。 */
async function dismiss(dialog) { // 1. 保留原存档。
  await dialog.dismiss();
}
/** 主验收流程。@returns {Promise<void>} 实际执行全部用例，资源始终清理。 */
async function main() {
  // 1. 启动独立服务与真实 Chromium。
  fs.mkdirSync(OUT, { recursive: true });
  try {
    await startServer(); browser = await chromium.launch({ headless: true, args: ["--host-resolver-rules=MAP linkplay.test 127.0.0.1", "--no-proxy-server"] });
    const { ctx, page } = await context(); let blankId, firstId, backupBytes, archiveBefore;
    await check("大厅保留 13 入口并进入拼豆", /** @returns {Promise<void>} 验证导航。 */ async function () { // 1. 点击真实大厅入口。
      await page.goto(base + "/index.html"); assert.equal(await page.locator(".lobby-game").count(), 13); await page.click('a[href="beads.html"]'); await page.waitForFunction(hookReady); await saved(page);
      const s = await state(page); firstId = s.archive.activeId; assert.equal(active(s).name, "像素花园"); assert.ok(active(s).cells.some(Boolean));
    });
    await check("新建与名称即时保存", /** @returns {Promise<void>} 验证空板与名称。 */ async function () { // 1. 真实选择尺寸并编辑名称。
      await page.selectOption("#newSize", "16"); await page.click("#newBtn"); blankId = (await state(page)).archive.activeId;
      await page.fill("#workName", "触摸花园 <作品>"); await saved(page); assert.equal(active(await state(page)).name, "触摸花园 <作品>"); assert.ok(active(await state(page)).cells.every(empty));
    });
    await check("选色、稀疏拖动补点、一次撤销", /** @returns {Promise<void>} 验证连续笔画。 */ async function () { // 1. 一次长跨度移动，检查中间格和历史单位。
      await page.click('[data-color="#F27593"]'); const from = await cell(page, 0, 0), to = await cell(page, 15, 0);
      await page.mouse.move(from.x, from.y); await page.mouse.down(); await page.mouse.move(to.x, to.y); await page.mouse.up(); await saved(page);
      const s = await state(page); assert.deepEqual(active(s).cells.slice(0, 16), Array(16).fill("#F27593")); assert.equal(s.undo, 1);
      await page.click("#undoBtn"); await saved(page); assert.ok(active(await state(page)).cells.every(empty));
      await page.click("#redoBtn"); await saved(page); assert.equal(active(await state(page)).cells[15], "#F27593");
    });
    await check("擦除、撤销重做与分支截断", /** @returns {Promise<void>} 验证擦除和新笔画。 */ async function () { // 1. 橡皮擦修改格子，回退与重做对称。
      await page.click('[data-tool="erase"]'); await paint(page, 3, 0); await saved(page); assert.equal(active(await state(page)).cells[3], null);
      await page.click("#undoBtn"); await page.click("#redoBtn"); await saved(page); assert.equal(active(await state(page)).cells[3], null);
      await page.click("#undoBtn"); await page.click('[data-tool="paint"]'); await paint(page, 0, 2); await saved(page); assert.equal((await state(page)).redo, 0);
    });
    await check("填充与取色", /** @returns {Promise<void>} 验证两种工具。 */ async function () { // 1. 填充色选独立色，撤销后取首行色。
      await page.click('[data-color="#6CBEAF"]'); await page.click('[data-tool="fill"]'); await paint(page, 15, 15); await saved(page); assert.equal(active(await state(page)).cells[255], "#6CBEAF");
      await page.click("#undoBtn"); await page.click('[data-tool="pick"]'); await paint(page, 2, 0); assert.equal((await state(page)).color, "#F27593");
    });
    await check("键盘移动、放豆、擦除、快捷历史", /** @returns {Promise<void>} 验证桌面键盘。 */ async function () { // 1. 焦点在画板才处理编辑键。
      await page.locator("#beadBoard").focus(); await page.keyboard.press("b"); await page.keyboard.press("ArrowDown"); const point = (await state(page)).cursor;
      await page.keyboard.press("Space"); await saved(page); assert.equal(active(await state(page)).cells[point.y * 16 + point.x], "#F27593");
      await page.keyboard.press("Delete"); await saved(page); assert.equal(active(await state(page)).cells[point.y * 16 + point.x], null);
      await page.keyboard.press("Control+z"); await saved(page); assert.equal(active(await state(page)).cells[point.y * 16 + point.x], "#F27593");
      await page.keyboard.press("Control+Shift+z"); await saved(page); assert.equal(active(await state(page)).cells[point.y * 16 + point.x], null);
    });
    await check("多作品切换继续编辑、刷新恢复", /** @returns {Promise<void>} 验证活动选择与内容。 */ async function () { // 1. 切换清空历史，恢复同一作品。
      await page.click(`[data-work="${firstId}"]`); await page.click(`[data-work="${blankId}"]`); assert.equal((await state(page)).undo, 0);
      await paint(page, 5, 5); await saved(page); archiveBefore = (await state(page)).archive;
      await page.reload(); await page.waitForFunction(hookReady); assert.deepEqual((await state(page)).archive, archiveBefore);
      await page.close(); const reopened = await ctx.newPage(); await open(reopened); assert.deepEqual((await state(reopened)).archive, archiveBefore); await reopened.close();
    });
    const p = await ctx.newPage(); p.on("pageerror", pageError); await open(p);
    await check("PNG 下载签名、尺寸与透明孔洞", /** @returns {Promise<void>} 验证实际下载。 */ async function () { // 1. 检查真实 PNG 文件而非按钮存在。
      const bytes = await downloaded(p, "#pngBtn", "beads-finished.png"); assert.equal(bytes.subarray(0, 8).toString("hex"), "89504e470d0a1a0a"); assert.equal(bytes.readUInt32BE(16), 512); assert.equal(bytes.readUInt32BE(20), 512);
      const alpha = await p.evaluate(pngPixels, "data:image/png;base64," + bytes.toString("base64")); assert.equal(alpha.background, 0); assert.ok(alpha.hole < 128); assert.equal(alpha.ring, 255);
    });
    await check("整库备份在新浏览器上下文安全追加恢复", /** @returns {Promise<void>} 验证重新导入。 */ async function () { // 1. 用实际下载文件进行另一上下文的文件上传。
      backupBytes = await downloaded(p, "#backupBtn", "beads-backup.json"); const imported = await context(); await open(imported.page); await saved(imported.page);
      await imported.page.setInputFiles("#importFile", { name: "backup.json", mimeType: "application/json", buffer: backupBytes });
      await imported.page.waitForFunction(workCountIs, 3); await saved(imported.page);
      const original = JSON.parse(backupBytes), restored = (await state(imported.page)).archive;
      assert.deepEqual(restored.works.slice(1).map(workContent), original.works.map(workContent)); assert.notEqual(restored.works[1].id, original.works[0].id); assert.equal(restored.works.length, 3);
    });
    await check("单幅备份也可导入", /** @returns {Promise<void>} 验证单幅契约。 */ async function () { // 1. 下载当前作品后追加副本。
      const single = await downloaded(p, "#exportWorkBtn", "beads-single.json"), before = active(await state(p));
      await p.setInputFiles("#importFile", { name: "single.json", mimeType: "application/json", buffer: single }); await p.waitForFunction(workCountIs, 3); await saved(p);
      assert.deepEqual(workContent(active(await state(p))), workContent(before));
    });
    await check("无效、超大文件不破坏既有作品", /** @returns {Promise<void>} 验证失败导入原子性。 */ async function () { // 1. 记录原库后测试两种拒绝。
      const before = (await state(p)).archive;
      await p.setInputFiles("#importFile", { name: "bad.json", mimeType: "application/json", buffer: Buffer.from("{bad") }); await p.locator("#notice").waitFor({ state: "visible" }); assert.deepEqual((await state(p)).archive, before);
      await p.setInputFiles("#importFile", { name: "huge.json", mimeType: "application/json", buffer: Buffer.alloc(M.MAX_FILE_BYTES + 1, 32) }); await p.waitForFunction(noticeIncludes, "2 MB"); assert.deepEqual((await state(p)).archive, before);
    });
    await check("复制、删除取消与模板不覆盖", /** @returns {Promise<void>} 验证作品管理。 */ async function () { // 1. 所有新内容作为独立作品。
      const before = (await state(p)).archive.works.length; await p.click("#duplicateBtn"); await saved(p); assert.equal((await state(p)).archive.works.length, before + 1);
      p.once("dialog", dismiss); await p.click("#deleteBtn"); assert.equal((await state(p)).archive.works.length, before + 1);
      p.once("dialog", accept); await p.click("#deleteBtn"); await saved(p); assert.equal((await state(p)).archive.works.length, before);
      await p.click('[data-template="heart"]'); await saved(p); assert.equal(active(await state(p)).name, "小小心意"); assert.equal((await state(p)).archive.works.length, before + 1);
    });
    await check("64 格缩放与像素预览", /** @returns {Promise<void>} 验证大板不溢出。 */ async function () { // 1. 放大画板只产生板内滚动。
      await p.selectOption("#newSize", "64"); await p.click("#newBtn"); await p.selectOption("#zoom", "3"); await p.click("#previewBtn"); await saved(p);
      assert.equal(active(await state(p)).size, 64); assert.equal(await p.locator("#previewBtn").getAttribute("aria-pressed"), "true"); assert.ok(await p.evaluate(noOverflow));
      await p.selectOption("#zoom", "1"); await p.click("#previewBtn"); await p.click(`[data-work="${firstId}"]`); await saved(p); await p.screenshot({ path: path.join(OUT, "beads-desktop.png"), fullPage: true });
    });
    await check("损坏存档保留、原文下载与确认重建", /** @returns {Promise<void>} 验证损坏保护。 */ async function () { // 1. 损坏数据打开后即使继续编辑也不可覆盖。
      const broken = await context(); await open(broken.page); await saved(broken.page); await broken.page.evaluate(corruptStorage); await broken.page.reload(); await broken.page.waitForFunction(hookReady);
      assert.equal((await state(broken.page)).blocked, "corrupt"); await paint(broken.page, 0, 0); assert.equal(await broken.page.evaluate(rawStorage), "{broken-json");
      const raw = await downloaded(broken.page, "#rawBtn", "beads-corrupt.txt"); assert.equal(raw.toString(), "{broken-json");
      broken.page.once("dialog", dismiss); await broken.page.click("#rebuildBtn"); assert.equal(await broken.page.evaluate(rawStorage), "{broken-json");
      broken.page.once("dialog", accept); await broken.page.click("#rebuildBtn"); await saved(broken.page); assert.ok(M.parseArchive(await broken.page.evaluate(rawStorage)));
    });
    await check("存储不可用显示未保存且可备份", /** @returns {Promise<void>} 验证策略拒绝。 */ async function () { // 1. 使用启动前注入模拟存储策略。
      const denied = await context(); await denied.ctx.addInitScript(denyStorage); await open(denied.page); assert.equal((await state(denied.page)).blocked, "storage"); await paint(denied.page, 0, 0);
      assert.equal(await denied.page.locator("#saveStatus").innerText(), "未保存"); const bytes = await downloaded(denied.page, "#backupBtn", "beads-unsaved.json"); assert.ok(M.parseArchive(bytes.toString()).works[0].cells[0]);
      await denied.page.evaluate(restoreStorage); await denied.page.click("#retryBtn"); await saved(denied.page); assert.ok(M.parseArchive(await denied.page.evaluate(rawStorage)).works[0].cells[0]);
    });
    await check("配额满不覆盖已有存档", /** @returns {Promise<void>} 验证写失败保留原文。 */ async function () { // 1. 先产生合法存档，再禁止写。
      const full = await context(); await open(full.page); await saved(full.page); const before = await full.page.evaluate(rawStorage); await full.page.evaluate(quotaStorage); await paint(full.page, 0, 0);
      await full.page.waitForFunction(blockedBy, "storage"); assert.equal(await full.page.evaluate(rawStorage), before); assert.equal(await full.page.locator("#saveStatus").innerText(), "未保存");
    });
    await check("HTTP 非安全上下文无 Web Locks 也能事务保存", /** @returns {Promise<void>} 验证公网 HTTP 所需能力。 */ async function () { // 1. 用真实非安全源访问，不把 localhost 的安全例外当成公网证据。
      const insecure = await context();
      // 1.1 当前宿主对测试域名有代理干预；只转发传输到本测试服务，浏览器 URL/存储源仍是真实非安全源。
      await insecure.page.route("http://linkplay.test:*/**", relay);
      /** 转发本地测试资源。@param {object} route Playwright 请求路由。@returns {Promise<void>} 不访问外部测试域名。 */
      async function relay(route) { // 1. 仅更换传输目标，不注入安全上下文能力。
        const response = await route.fetch({ url: route.request().url().replace("linkplay.test", "127.0.0.1") }); await route.fulfill({ response });
      }
      await insecure.page.goto(base.replace("127.0.0.1", "linkplay.test") + "/beads.html"); await insecure.page.waitForFunction(hookReady); await saved(insecure.page);
      assert.equal(await insecure.page.evaluate(secureContext), false); await paint(insecure.page, 0, 0); await saved(insecure.page);
      const before = (await state(insecure.page)).archive; await insecure.page.reload(); await insecure.page.waitForFunction(hookReady); assert.deepEqual((await state(insecure.page)).archive, before);
    });
    await check("多标签页旧快照不能覆盖新存档", /** @returns {Promise<void>} 验证竞争保护。 */ async function () { // 1. 同一上下文两页加载同一基线。
      const tabs = await context(); await open(tabs.page); await saved(tabs.page); const second = await tabs.ctx.newPage(); await open(second);
      await tabs.page.fill("#workName", "标签页 A"); await saved(tabs.page); await second.waitForFunction(blockedBy, "conflict");
      const raw = await tabs.page.evaluate(rawStorage); await second.fill("#workName", "标签页 B 未保存"); await paint(second, 0, 0); assert.equal(await tabs.page.evaluate(rawStorage), raw);
      const bytes = await downloaded(second, "#backupBtn", "beads-conflict.json"); assert.equal(M.parseArchive(bytes.toString()).works[0].name, "标签页 B 未保存");
      second.once("dialog", accept); await second.click("#reloadBtn"); await second.waitForFunction(hookReady); assert.equal(active(await state(second)).name, "标签页 A");
    });
    await check("同时编辑由独占锁决定单一胜者", /** @returns {Promise<void>} 验证锁内比较。 */ async function () { // 1. 两页同轮提交，一方冲突且最终库完整。
      const tabs = await context(); await open(tabs.page); await saved(tabs.page); const second = await tabs.ctx.newPage(); await open(second);
      await Promise.all([tabs.page.fill("#workName", "并发甲"), second.fill("#workName", "并发乙")]);
      await tabs.page.waitForFunction(settled); await second.waitForFunction(settled);
      const states = [await state(tabs.page), await state(second)]; assert.equal(states.filter(conflicted).length, 1);
      const archive = M.parseArchive(await tabs.page.evaluate(rawStorage)); assert.ok(["并发甲", "并发乙"].includes(archive.works[0].name));
    });
    await check("375px 真实触摸连续拖动、无页面横向溢出", /** @returns {Promise<void>} 验证手机指针。 */ async function () { // 1. 模拟真实 Chromium 触摸输入而非直接派发 DOM 事件。
      const mobile = await context({ viewport: { width: 375, height: 812 }, isMobile: true, hasTouch: true, deviceScaleFactor: 2 }); await open(mobile.page); await saved(mobile.page);
      await mobile.page.selectOption("#newSize", "16"); await mobile.page.tap("#newBtn"); await mobile.page.tap('[data-color="#7768D8"]'); await mobile.page.locator("#beadBoard").scrollIntoViewIfNeeded();
      const start = await cell(mobile.page, 0, 0), end = await cell(mobile.page, 15, 0), session = await mobile.ctx.newCDPSession(mobile.page);
      await session.send("Input.dispatchTouchEvent", { type: "touchStart", touchPoints: [start] }); await session.send("Input.dispatchTouchEvent", { type: "touchMove", touchPoints: [end] }); await session.send("Input.dispatchTouchEvent", { type: "touchEnd", touchPoints: [] }); await saved(mobile.page);
      assert.deepEqual(active(await state(mobile.page)).cells.slice(0, 16), Array(16).fill("#7768D8")); assert.ok(await mobile.page.evaluate(noOverflow));
      // 2.1 立即触摸切换工具，检验 pointerup 选择不依赖拖动后可能被抑制的原生 click；不加手势等待补丁。
      await mobile.page.tap('[data-tool="erase"]'); await mobile.page.waitForFunction(selectedTool, "erase"); const erase = await cell(mobile.page, 5, 0); assert.equal((await state(mobile.page)).tool, "erase"); await mobile.page.touchscreen.tap(erase.x, erase.y); await saved(mobile.page); assert.equal(active(await state(mobile.page)).cells[5], null);
      await mobile.page.tap("#undoBtn"); await saved(mobile.page); assert.equal(active(await state(mobile.page)).cells[5], "#7768D8");
      await mobile.page.selectOption("#zoom", "3"); assert.ok(await mobile.page.evaluate(noOverflow)); await mobile.page.selectOption("#zoom", "1"); await mobile.page.click(`[data-work="${(await state(mobile.page)).archive.works[0].id}"]`); await saved(mobile.page);
      await mobile.page.screenshot({ path: path.join(OUT, "beads-mobile.png"), fullPage: true }); await session.detach();
    });
    await check("实际关闭浏览器后持久化恢复", /** @returns {Promise<void>} 验证磁盘浏览器配置。 */ async function () { // 1. 使用本任务 ignored 输出下的独立持久化 profile。
      const profile = path.join(OUT, "beads-profile-" + Date.now()); let persistent;
      try {
        persistent = await chromium.launchPersistentContext(profile, { headless: true }); let page = persistent.pages()[0]; await open(page); await saved(page);
        await page.fill("#workName", "关闭后再见"); await paint(page, 0, 0); await saved(page); const before = (await state(page)).archive; await persistent.close();
        persistent = await chromium.launchPersistentContext(profile, { headless: true }); page = persistent.pages()[0]; await open(page); assert.deepEqual((await state(page)).archive, before);
      } finally { if (persistent) await persistent.close(); }
    });
    await check("旧版 localStorage 迁移且保留原文", /** @returns {Promise<void>} 验证迁移不是数据删除。 */ async function () { // 1. 仅在事务库没有记录时读取旧版存档。
      const legacy = await context(); const original = JSON.parse(backupBytes.toString());
      await legacy.ctx.addInitScript(seedLegacy, JSON.stringify(original)); await open(legacy.page); await saved(legacy.page);
      assert.deepEqual((await state(legacy.page)).archive, original); assert.equal(await legacy.page.evaluate(legacyRaw), JSON.stringify(original));
      await legacy.page.fill("#workName", "迁移后继续编辑"); await saved(legacy.page); await legacy.page.reload(); await legacy.page.waitForFunction(hookReady);
      assert.equal(active(await state(legacy.page)).name, "迁移后继续编辑"); assert.equal(await legacy.page.evaluate(legacyRaw), JSON.stringify(original));
    });
    await check("初次读取失败后重试不遮蔽既有旧版存档", /** @returns {Promise<void>} 验证未知基线不能被当作空库。 */ async function () { // 1. 旧版已有作品，但事务库初次被策略拒绝。
      const unknown = await context(); const raw = backupBytes.toString(); await unknown.ctx.addInitScript(seedLegacy, raw); await unknown.ctx.addInitScript(denyStorage);
      await open(unknown.page); await unknown.page.waitForFunction(blockedBy, "storage"); await paint(unknown.page, 0, 0);
      // 2. 能力恢复后明确重试，应提示重载旧存档，不写入新的空模板遮蔽迁移来源。
      await unknown.page.evaluate(restoreStorage); await unknown.page.click("#retryBtn"); await unknown.page.waitForFunction(blockedBy, "conflict");
      assert.equal(await unknown.page.evaluate(rawStorage), null); assert.equal(await unknown.page.evaluate(legacyRaw), raw); assert.ok(active(await state(unknown.page)).cells[0]);
    });
    await check("全程无未处理页面错误", /** @returns {Promise<void>} 验证异常收集。 */ async function () { // 1. 故障 fixture 也不能产生未处理异常。
      assert.deepEqual(errors, []);
    });
    // 2. 防止意外零用例或数量缩水被当成成功。
    assert.equal(passed, 24); console.log(`\n${passed}/24 browser acceptance cases passed`);
  } finally {
    // 3. 只清理本脚本创建的浏览器与临时服务。
    for (const ctx of contexts) await ctx.close(); if (browser) await browser.close();
    if (server && server.exitCode === null) { server.kill("SIGTERM"); await new Promise(serverClosed); }
  }
}
/** 浏览器侧工具选择条件。@param {string} tool 工具标识。@returns {boolean} 触摸兼容点击是否已完成。 */
function selectedTool(tool) { // 1. 以实际工具状态同步触摸操作。
  return JSON.parse(window.render_game_to_text()).tool === tool;
}
/** 解码 PNG 并采样透明孔与实体环。@param {string} dataURL 实际下载 PNG 的数据地址。@returns {Promise<object>} 背景、孔心与实体环透明度。 */
async function pngPixels(dataURL) {
  // 1. 浏览器解码实际产物，不依赖额外图像库。
  const image = new Image(); image.src = dataURL; await image.decode();
  const canvas = document.createElement("canvas"); canvas.width = image.width; canvas.height = image.height;
  const context = canvas.getContext("2d"); context.drawImage(image, 0, 0);
  // 2. 首格已有豆子，采样角落、孔心和环体。
  return { background: context.getImageData(0, 0, 1, 1).data[3], hole: context.getImageData(16, 16, 1, 1).data[3], ring: context.getImageData(25, 16, 1, 1).data[3] };
}
/** 注入旧版存档。@param {string} text 合法旧版 JSON fixture。@returns {void} 仅写测试上下文旧键。 */
function seedLegacy(text) { // 1. 模拟升级前已有的本地作品。
  localStorage.setItem("linkplay.beads.v1", text);
}
/** 读取保留的旧原文。@returns {string|null} 迁移来源，不是当前保存 owner。 */
function legacyRaw() { // 1. 核对没有删旧原文。
  return localStorage.getItem("linkplay.beads.v1");
}
/** 空格子谓词。@param {*} value 格值。@returns {boolean} 是否为空。 */
function empty(value) { // 1. 只有 null 代表空格。
  return value === null;
}
/** 比较作品可恢复内容。@param {object} work 合法作品。@returns {object} 排除重新分配的标识。 */
function workContent(work) { // 1. 保留名称、画板、格子与时间。
  const { id, ...content } = work; return content;
}
/** 浏览器侧作品数量条件。@param {number} count 预期数量。@returns {boolean} 是否达到。 */
function workCountIs(count) { // 1. 完整导入后数量一次增加。
  return JSON.parse(window.render_game_to_text()).archive.works.length === count;
}
/** 浏览器侧通知条件。@param {string} text 预期片段。@returns {boolean} 是否已显示。 */
function noticeIncludes(text) { // 1. 检查业务错误反馈。
  return document.getElementById("notice").textContent.includes(text);
}
/** 浏览器侧保存结束条件。@returns {boolean} 成功或冲突已收敛。 */
function settled() { // 1. 不以固定时间推断并发结束。
  const s = JSON.parse(window.render_game_to_text()); return s.blocked === "conflict" || !s.dirty;
}
/** 冲突状态谓词。@param {object} s 页面镜像。@returns {boolean} 是否冲突。 */
function conflicted(s) { // 1. 精确比较原因。
  return s.blocked === "conflict";
}
/** 等临时服务退出。@param {Function} resolve 退出完成回调。@returns {void} 仅观察自己创建的进程。 */
function serverClosed(resolve) { // 1. kill 后等 close，不替换或终止既有服务。
  server.once("close", resolve);
}
/** 输出失败并设置非零退出。@param {Error} error 验收失败。@returns {void} 打印执行数量与堆栈。 */
function failed(error) { // 1. 不伪装部分验收为成功。
  console.error(`FAIL after ${passed} browser cases`, error, { pageErrors: errors }); process.exitCode = 1;
}
main().catch(failed);
