/** 黄金矿工真实 WebSocket 与独立浏览器联机验收；只访问隔离回环服务器，不复用身份。 */
"use strict";
const test = require("node:test");
const assert = require("node:assert/strict");
const { spawn } = require("node:child_process");
const { once } = require("node:events");
const net = require("node:net");
const path = require("node:path");
const fs = require("node:fs");
const WebSocket = require("ws");
const { chromium } = require("playwright");
const ROOT = path.resolve(__dirname, "..");

class Probe {
  /** 建立真实协议观察连接。
   * @param {string} base - 非空隔离服务器HTTP回环地址，转换协议后连接其/ws，不携带共享身份。
   * @returns {Probe} 未绑定身份的独立连接；开始真实WS握手并登记消息、关闭监听，请求计时器会在响应或关闭时清理。
   * @throws {Error} URL或原生WS构造无效时传播异常；异步连接故障由连接事件报告。
   */
  constructor(base) {
    // 1. 每个实例拥有自己的socket和请求表，不共用玩家凭据。
    this.socket = new WebSocket(base.replace(/^http/, "ws") + "/ws");
    this.pending = new Map(); this.next = 0; this.last = null;
    this.socket.on("message", this.onMessage.bind(this));
    this.socket.on("close", this.onClose.bind(this));
  }
  /** 分发服务器真实响应及快照。
   * @param {Buffer} bytes - 非空服务端UTF-8 JSON协议信封，requestId用于匹配本连接的待请求。
   * @returns {void} 保存快照、兑现关联请求并清理其超时资源，不发送新意图。
   * @throws {SyntaxError} 信封不是合法JSON时传播解析异常，不将无效消息当成功响应。
   */
  onMessage(bytes) {
    // 1. 保存任何最新快照，再解析关联请求。
    const message = JSON.parse(bytes.toString());
    if (message.payload?.snapshot) this.last = message.payload.snapshot;
    const waiting = this.pending.get(message.requestId);
    if (waiting) { clearTimeout(waiting.timer); this.pending.delete(message.requestId); waiting.resolve(message); }
  }
  /** 关闭时终止所有待请求，防止隐藏测试挂起。
   * @returns {void} 清理计时器、清空待请求表并以socket closed拒绝等待者；无额外同步异常。
   */
  onClose() {
    // 1. 关闭不是成功响应，显式拒绝待请求。
    for (const waiting of this.pending.values()) { clearTimeout(waiting.timer); waiting.reject(new Error("socket closed")); }
    this.pending.clear();
  }
  /** 等待真实连接就绪。
   * @returns {Promise<void>} 已OPEN时直接兑现，否则登记并等待真实open事件；等待中的error事件使其拒绝，不发送房间消息。
   */
  async ready() {
    // 1. 使用open事件而非固定sleep。
    if (this.socket.readyState !== WebSocket.OPEN) await once(this.socket, "open");
  }
  /** 发送原始协议意图，room.error也作为真实响应交给断言检查。
   * @param {string} type - 非空v1协议消息类型，例如room.create或game.action，不在fixture内预判业务权限。
   * @param {object} payload - 协议测试意图，默认空对象；包含非法字段或null等测试输入时原样序列化，由服务端判定。
   * @returns {Promise<object>} 同requestId的原始响应；发送WS消息并登记六秒计时器及待请求，超时、关闭、序列化或同步发送异常时拒绝。
   */
  request(type, payload = {}) {
    // 1. 独立关联ID和超时资源，响应之后清理。
    const requestId = `gm-test-${++this.next}`;
    return new Promise(
      /** 登记一条真实WS请求并发送原始信封。
       * @param {Function} resolve - 收到同requestId的响应时兑现，room.error也原样交给断言。
       * @param {Function} reject - 连接关闭、六秒超时或同步发送异常时使请求失败；均不可为空。
       * @returns {void} 修改待响应表、创建毫秒计时器并发送WS消息；同步异常由Promise转为拒绝。
       */
      (resolve, reject) => {
      // 1. 创建请求超时计时器，使无响应请求明确失败。
      const timer = setTimeout(
        /** 令六秒内无关联响应的请求明确失败。
         * @returns {void} 删除待响应记录并拒绝请求；不发送补偿消息，不抛出额外异常。
         */
        () => {
        // 1. 超时必须失败，不能当作被拒绝已通过。
        this.pending.delete(requestId); reject(new Error(`timeout ${type}`));
      }, 6000);
      // 2. 在发送前登记关联记录，供真实响应或关闭事件清理。
      this.pending.set(requestId, { resolve, reject, timer });
      this.socket.send(JSON.stringify({ version: 1, type, requestId, payload }));
    });
  }
  /** 关闭本fixture拥有的连接。
   * @returns {void} 终止本实例socket，待请求由close监听拒绝；不触碰其他测试或Host连接，无预期同步异常。
   */
  close() {
    // 1. fixture拥有的连接直接终止，pending由close事件清理。
    this.socket.terminate();
  }
}

/** 获取操作系统分配的空闲回环端口。
 * @returns {Promise<number>} 操作系统分配的TCP端口整数，单位为端口号；短暂监听回环后关闭，监听或关闭失败时拒绝，不保证后续占用该端口。
 */
async function freePort() {
  // 1. 只监听回环地址，让操作系统选端口。
  const listener = net.createServer(); listener.listen(0, "127.0.0.1"); await once(listener, "listening");
  const port = listener.address().port; listener.close(); await once(listener, "close"); return port;
}
/** 等待本地被测服务健康，检查进程退出而不固定sleep。
 * @param {string} base - 非空被测HTTP回环地址，只请求其/health健康端点。
 * @param {object|null|undefined} processHandle - 本测试启动的服务进程；配置BASE_URL、不启动服务时可为空，不检查进程退出。
 * @returns {Promise<void>} 二十秒内健康状态为ok时兑现；重复发健康请求并以100毫秒间隔等待，进程退出或超时拒绝，单轮连接/解析错误继续重试。
 */
async function healthy(base, processHandle) {
  // 1. 条件轮询仅等待服务就绪，不替代游戏状态验证。
  const deadline = Date.now() + 20000;
  while (Date.now() < deadline) {
    if (processHandle && processHandle.exitCode !== null) throw new Error(`server exited ${processHandle.exitCode}`);
    try { if ((await (await fetch(base + "/health")).json()).status === "ok") return; } catch { /* 服务尚未监听，下次健康检查继续。 */ }
    await new Promise(
      /** 在健康检查失败后安排下一次回环服务检查。
       * @param {Function} resolve - 无结果兑现本轮等待的回调，不可为空。
       * @returns {void} 创建100毫秒计时器，不发网络请求；计时器到期兑现等待，无预期同步异常。
       */
      (resolve) => {
      // 1. 为下一次健康谓词检查让出事件循环。
      setTimeout(resolve, 100);
    });
  }
  throw new Error("health timeout");
}
/** 读取浏览器只读权威镜像。
 * @param {import('playwright').Page} page - 已初始化观测钩子的独立玩家页面，不可为空或已关闭。
 * @returns {Promise<object>} 页面观测到的最新服务器镜像副本，不修改状态；页面执行、钩子调用或JSON解析失败时拒绝。
 */
async function state(page) {
  // 1. 解析已存在的观测钩子，不调用游戏操作内部函数。
  return page.evaluate(
    /** 从页面观测钩子解析独立的权威镜像副本。
     * @returns {object} JSON快照；钩子缺失或JSON无效时抛错，不修改页面或发送操作。
     */
    () => {
    // 1. 输出镜像JSON的独立副本。
    return JSON.parse(window.render_game_to_text());
  });
}
/** 等待浏览器状态满足序列化谓词。
 * @param {import('playwright').Page} page - 非空被测独立页面，观测钩子须已初始化。
 * @param {Function} predicate - 非空只读(state,arg)判定；toString后在页面eval执行，不能闭包Node变量或改变游戏状态。
 * @param {*} arg - 显式传入的身份、金额、Unix毫秒时刻或JSON配置；默认null表示谓词无需额外业务参数。
 * @param {number} timeout - 正数最大等待毫秒，默认12000，不改变服务器游戏时长。
 * @returns {Promise<void>} 谓词返回真值后兑现；按动画帧读取镜像，无操作副作用，页面执行、解析、谓词异常或超时使等待拒绝，绝不跳过。
 */
async function waitState(page, predicate, arg = null, timeout = 12000) {
  // 1. 根据真实快照等待，无固定游戏sleep。
  try {
  await page.waitForFunction(
    /** 在页面内对最新镜像运行显式传入的只读判定。
     * @param {Array} input - 两项数组：source为不闭包Node变量的函数字符串，value为场景参数（无参数时为null）；下方解构使用。
     * @returns {*} 谓词结果，真值结束等待；解析或谓词异常向Playwright传播，不改页面状态。
     */
    ([source, value]) => {
    // 1. 在被测页面执行纯观测谓词。
    return eval(`(${source})`)(JSON.parse(window.render_game_to_text()), value);
  }, [predicate.toString(), arg], { timeout, polling: "raf" });
  } catch (error) {
    // 2. 失败时保留当前真实镜像和可见性，避免仅凭Timeout猜测产品还是浏览器调度问题。
    try {
      const diagnostic = await page.evaluate(
        /** 导出不含令牌的页面运行状态用于失败定位。
         * @returns {object} 当前可见性、身份、成员、轮次与矿工运动；只读，不返回localStorage或修改游戏。
         */
        () => {
          // 1. 从现有观测钩子读取实际权威数据。
          const s = JSON.parse(window.render_game_to_text());
          return { visibility: document.visibilityState, playerId: s.playerId, online: s.online, room: s.room, canDrop: s.canDrop, game: { phase: s.game?.phase, round: s.game?.round, serverNow: s.game?.serverNow, startedAt: s.game?.startedAt, endsAt: s.game?.endsAt, miners: s.game?.miners }, assetErrors: s.assetErrors };
        });
      console.error("WAIT_DIAGNOSTIC", JSON.stringify(diagnostic));
    } catch (diagnosticError) { console.error("WAIT_DIAGNOSTIC_UNAVAILABLE", diagnosticError.message); }
    // 3. 诊断不能代替断言，原始错误仍然失败。
    throw error;
  }
}
/** 等待可抓到最近可用矿石的服务器摆角，并使用真实UI操作放钩。
 * @param {import('playwright').Page} page - 非空当前参赛页面，须具备放钩按钮；touch方式要求上下文支持真实触屏。
 * @param {'button'|'space'|'touch'} method - 按钮、空格或触屏的真实交互方式，不发送目标或角度；调用者必须提供。
 * @returns {Promise<object>} 放钩前镜像，供金额及身份断言；滚动、聚焦并执行一次放钩和两次忙碌空格，定位、交互、规则或状态等待失败时拒绝。
 */
async function aimedDrop(page, method) {
  // 1. 先完成滚动和焦点定位；临界摆角时不等待自动滚动/按钮稳定性。
  await page.locator("#goldDrop").scrollIntoViewIfNeeded();
  if (method === "space") await page.locator("#goldPlayArea").focus();
  const box = await page.locator("#goldDrop").boundingBox();
  // 1.1 仅观察公共规则姿态选择时机，不篡改镜像，不指定矿石ID给服务器。
  await page.waitForFunction(
    /** 观察可下钩且能接触350像素内矿石的窄摆角窗口。
     * @returns {boolean} 当前窗口是否可用；规则或镜像缺失时抛错，仅观测，不指定目标或修改摆角。
     */
    () => {
    // 1. 确认可放钩，再定位本身份的权威矿工和矿场。
    const s = JSON.parse(window.render_game_to_text());
    if (!s.canDrop) return false;
    const miner = s.game.miners.find(
      /** 选取当前页面身份对应的参赛矿工。
       * @param {object} item - 权威矿工数组中的非空记录，playerId为本局身份标识。
       * @returns {boolean} 是否属于当前页面；纯比较，无副作用或预期异常。
       */
      (item) => { /* 1. 按页面身份匹配矿工。 */ return item.playerId === s.playerId; });
    const field = s.game.fields[s.game.mode === "shared" ? "shared" : s.playerId];
    // 2. 以显示服务器时刻前移15毫秒观察摆钩，筛选安全接触窗口，不修改姿态。
    const pose = window.GoldMinerRules.hookPose(miner, s.game, s.displayServerNow + 15);
    return field.minerals.some(
      /** 判定该矿石是否处于给真实输入保留角度余量的接触窗口。
       * @param {object} ore - 非空权威矿石记录，x、y、radius均以矿场像素计；只接受available状态。
       * @returns {boolean} 距离小于350像素且缩至45%半径仍能接触时为真；规则异常传播，无状态修改。
       */
      (ore) => {
      // 1. 核对矿石可用、距离及缩小半径后的接触，给真实网络操作保留角度余量。
      const distance = Math.hypot(ore.x - pose.origin.x, ore.y - pose.origin.y);
      return ore.status === "available" && distance < 350 && Number.isFinite(window.GoldMinerRules.contactLength({ origin: pose.origin, angle: pose.angle }, { ...ore, radius: ore.radius * .45 }));
    });
  }, null, { timeout: 7000, polling: "raf" });
  const before = await state(page);
  // 2. 三种实际交互共用页面按钮/键盘入口；触屏由独立hasTouch上下文提供。
  if (method === "space") await page.keyboard.press("Space");
  else if (method === "touch") await page.touchscreen.tap(box.x + box.width / 2, box.y + box.height / 2);
  else await page.mouse.click(box.x + box.width / 2, box.y + box.height / 2);
  await waitState(page, /** 判定真实放钩是否已让当前矿工离开空闲状态。
    * @param {object} s - 页面最新非空权威镜像，须含本身份参赛矿工；无额外参数。
    * @returns {boolean} 钩子非idle为真；矿工缺失时抛错，不发送操作或修改镜像。
    */
   (s) => { /* 1. 读取本身份矿工的钩阶段。 */ return s.game.miners.find(/** 匹配镜像所标识的当前玩家。
     * @param {object} m - 非空权威矿工记录，playerId是服务器身份，不使用客户端伪造字段。
     * @returns {boolean} 身份相同为真；无副作用或预期异常。
     */
    (m) => { /* 1. 比较权威矿工身份与页面身份。 */ return m.playerId === s.playerId; }).hook.phase !== "idle"; });
  // 3. 连按必须在同一玩家仍忙时检查，不能等另一玩家摆角数秒后再误认为仍在回收。
  await page.waitForFunction(
    /** 观察忙碌钩状态对应的真实放钩按钮是否禁用。
     * @returns {boolean} DOM按钮的disabled值；按钮缺失时抛错，无操作副作用。
     */
    () => { /* 1. 等待该权威钩状态对应的按钮禁用。 */ return document.querySelector("#goldDrop").disabled; });
  await page.keyboard.press("Space"); await page.keyboard.press("Space");
  return before;
}
/** 等待本身份真实回收计分。
 * @param {import('playwright').Page} page - 非空参赛者页面，镜像须包含该身份的矿工。
 * @param {number} beforeScore - 放钩前非负整数金额，单位同矿石value，默认0，不可为空。
 * @returns {Promise<void>} 六千五百毫秒内观察到权威金额增加后兑现，空钩不算通过；仅观测，页面、矿工缺失或超时使等待拒绝。
 */
async function scored(page, beforeScore = 0) {
  // 1. 使用服务端镜像金额而非动画或按钮文本断言。
  await waitState(page, /** 观察当前玩家是否通过真实回收增加权威金额。
    * @param {object} s - 非空页面镜像，须含当前参赛矿工。
    * @param {number} before - 放钩前整数金额，单位同矿石value；默认由调用者传0，不可为空。
    * @returns {boolean} 最新分数严格大于基线为真；矿工缺失时抛错，无状态修改。
    */
   (s, before) => { /* 1. 比较回收后的金额与放钩基线。 */ return s.game.miners.find(/** 匹配镜像所标识的当前玩家。
     * @param {object} m - 非空权威矿工记录，playerId是服务器身份，不使用客户端伪造字段。
     * @returns {boolean} 身份相同为真；无副作用或预期异常。
     */
    (m) => { /* 1. 比较权威矿工身份与页面身份。 */ return m.playerId === s.playerId; }).score > before; }, beforeScore, 6500);
}
/** 统一观察每个被测页面的脚本错误和外站请求。
 * @param {import('playwright').Page} page - 独立玩家页面，不为空，须在goto前调用一次。
 * @param {object} f - 共享测试记录，含本站base、errors/external数组和预期离线标志。
 * @returns {void} 登记三个只读监听；除明确离线网络报错外均记录，不拦截请求或改变页面。
 */
function watchPage(page, f) {
  // 1. 脚本异常任何时候都不是可豁免的网络故障。
  page.on("pageerror",
    /** 保存浏览器未捕获脚本异常。
     * @param {Error} error - Playwright提供的非空异常。
     * @returns {void} 追加错误文本，不更改应用状态。
     */
    (error) => { /* 1. 保存真实错误。 */ f.errors.push(error.message); });
  // 2. 离线测试只豁免明确的离线网络错误，不吞其他控制台故障。
  page.on("console",
    /** 分类并记录浏览器控制台错误。
     * @param {import('playwright').ConsoleMessage} message - 原始浏览器事件，非空。
     * @returns {void} 非预期网络故障追加到错误表，不修改连接或消息。
     */
    (message) => { /* 1. 筛选error并按显式离线标志判断豁免。 */ if (message.type() === "error" && !(f.expectOffline && /ERR_INTERNET_DISCONNECTED|WebSocket.*failed/.test(message.text()))) f.errors.push(message.text()); });
  // 3. 所有被测上下文都必须没有第三方HTTP资源。
  page.on("request",
    /** 记录非本站HTTP热链。
     * @param {import('playwright').Request} request - 已发生的浏览器请求，URL非空。
     * @returns {void} 外站地址追加到记录；无效URL抛错，不改写请求。
     */
    (request) => { /* 1. 比较实际请求来源与隔离测试服务。 */ if (/^https?:/.test(request.url()) && new URL(request.url()).origin !== new URL(f.base).origin) f.external.push(request.url()); });
}
/** 取得当前浏览器身份的权威矿工数据。
 * @param {object} s - 非空render_game_to_text输出，须含权威game.miners和本页面playerId。
 * @returns {object|undefined} 本场矿工原记录，不存在时为undefined；只读查找，镜像结构无效时抛错，不修改身份。
 */
function own(s) {
  // 1. 身份取自该独立浏览器，不借用其他玩家令牌。
  return s.game.miners.find(/** 匹配镜像所标识的当前玩家。
     * @param {object} m - 非空权威矿工记录，playerId是服务器身份，不使用客户端伪造字段。
     * @returns {boolean} 身份相同为真；无副作用或预期异常。
     */
    (m) => { /* 1. 比较权威矿工身份与页面身份。 */ return m.playerId === s.playerId; });
}
/** 启动一局并核实统一绝对时钟。
 * @param {object} f - 非空浏览器fixture，a为当前房主页面、b为另一参赛页面，两者均已入同房。
 * @param {string} mode - 实际表单选择的shared或independent，不可为空。
 * @param {number} seconds - 房主输入的10–600整数秒，不可为空，权威截止差按秒乘1000校验。
 * @returns {Promise<void>} 两端镜像同一次权威开局且统一截止断言成立后兑现；填写表单并点击真实开局，UI、状态等待或断言失败时拒绝。
 */
async function start(f, mode, seconds) {
  // 1. 真实表单输入、点击房主开局按钮。
  await f.a.locator("#goldMode").selectOption(mode);
  await f.a.locator("#goldDuration").fill(String(seconds));
  await f.a.locator("#goldStart").click();
  await waitState(f.a, /** 确认该独立页面已镜像指定模式的开局。
    * @param {object} s - 最新非空页面镜像，game为权威游戏记录。
    * @param {string} wanted - 表单实际选择的shared或independent，不可为空。
    * @returns {boolean} 已playing且模式一致为真；游戏缺失时抛错，仅观测。
    */
   (s, wanted) => { /* 1. 同时校验比赛阶段和权威模式。 */ return s.game.phase === "playing" && s.game.mode === wanted; }, mode);
  await waitState(f.b, /** 确认该独立页面已镜像指定模式的开局。
    * @param {object} s - 最新非空页面镜像，game为权威游戏记录。
    * @param {string} wanted - 表单实际选择的shared或independent，不可为空。
    * @returns {boolean} 已playing且模式一致为真；游戏缺失时抛错，仅观测。
    */
   (s, wanted) => { /* 1. 同时校验比赛阶段和权威模式。 */ return s.game.phase === "playing" && s.game.mode === wanted; }, mode);
  // 2. 比赛截止必须来自真正输入，不只是显示框文本一致。
  const a = await state(f.a), b = await state(f.b);
  assert.equal(a.game.startedAt, b.game.startedAt); assert.equal(a.game.endsAt, b.game.endsAt);
  assert.equal(a.game.endsAt - a.game.startedAt, seconds * 1000);
  assert.equal(a.game.miners.length, 2); assert.equal(a.game.phase, "playing");
}
/** 执行真实协议及浏览器用例，场景有明确顺序但每条均有独立断言。
 * @param {string} name - 场景清单中非空完整用例名，必须精确匹配本函数登记分支。
 * @param {object} f - 非空共享fixture，仅含本测试的回环地址、独立浏览器及观察资源；后续场景依赖先前保存的身份与金额基线。
 * @returns {Promise<void>} 当前真实场景及断言完成后兑现，由node:test统计执行数；未知场景、传输、页面或断言失败时拒绝；按场景发真实WS/UI意图、修改fixture并保存截图，临时连接在finally清理。
 */
async function scenario(name, f) {
  // 1. 按已登记的场景读取真实传输和页面，不调用房间内部模拟终局。
  switch (name) {
    case "A02 真实WS六人上限与第七人无幽灵成员": {
      const probes = Array.from({ length: 7 }, /** 为七人容量检查创建一个不共享身份的真实连接。
        * @returns {Probe} 未绑定身份的观察连接；创建WS可能抛错并立即启动回环握手。
        */
       () => { /* 1. 为本数组位置建立独立WS。 */ return new Probe(f.base); });
      try {
        await Promise.all(probes.map(/** 等待容量测试中的一个独立观察连接完成握手。
          * @param {Probe} p - 七个本fixture连接之一，不可为空且尚未绑定身份。
          * @returns {Promise<void>} open后兑现，连接错误时拒绝；只登记等待，不发送房间意图。
          */
         (p) => { /* 1. 等待该连接的真实open事件。 */ return p.ready(); }));
        const created = await probes[0].request("room.create", { gameType: "gold-miner", nickname: "WS房主", mode: "fake", durationSeconds: "bad" });
        assert.equal(created.type, "room.created"); const roomId = created.payload.roomId;
        for (let i = 1; i < 6; i++) assert.equal((await probes[i].request("room.join", { gameType: "gold-miner", roomId, nickname: `WS${i}` })).type, "room.joined");
        const rejected = await probes[6].request("room.join", { gameType: "gold-miner", roomId, nickname: "第七人" });
        assert.equal(rejected.payload.code, "ROOM_FULL"); assert.equal(probes[0].last.room.players.length, 6);
        const started = await probes[0].request("game.action", { action: "start", durationSeconds: 10 });
        assert.equal(started.payload.snapshot.game.miners.length, 6);
        for (const p of probes.slice(0, 6)) await p.request("room.leave");
      } finally { for (const p of probes) p.close(); }
      break;
    }
    case "A03 A05 A06 A12 真实WS权限非法配置与全字段伪造": {
      const a = new Probe(f.base), b = new Probe(f.base), c = new Probe(f.base);
      try {
        await Promise.all([a.ready(), b.ready(), c.ready()]);
        const created = await a.request("room.create", { gameType: "gold-miner", nickname: "权限房主" }); const id = created.payload.roomId;
        assert.equal((await a.request("game.action", { action: "start" })).type, "room.error");
        const joined = await b.request("room.join", { gameType: "gold-miner", roomId: id, nickname: "权限客人" });
        assert.equal((await b.request("game.action", { action: "start" })).payload.code, "INVALID_ACTION");
        for (const durationSeconds of ["", "65", "bad", null, -1, 9, 601, 10.5]) assert.equal((await a.request("game.action", { action: "start", durationSeconds })).type, "room.error");
        assert.equal((await a.request("game.action", { action: "start", mode: "solo" })).type, "room.error");
        const begin = await a.request("game.action", { action: "start", durationSeconds: 10 }); const g = begin.payload.snapshot.game;
        assert.equal(g.round, 1); assert.equal(g.mode, "shared");
        assert.equal((await a.request("game.action", { action: "drop", time: g.startedAt + 100 })).payload.code, "GAME_NOT_STARTED");
        await c.request("room.join", { gameType: "gold-miner", roomId: id, nickname: "晚加入" });
        assert.equal((await c.request("game.action", { action: "drop", playerId: created.payload.playerId })).payload.code, "INVALID_ACTION");
        // 1.1 等待真实服务器允许下钩；客户端自报时间不能绕过倒计时。
        while (Date.now() < g.startedAt) await new Promise(/** 为下次统一开始时刻检查让出事件循环。
          * @param {Function} resolve - 无结果兑现本轮等待的回调，不可为空。
          * @returns {void} 创建30毫秒计时器；不修改比赛时钟或发送下钩请求，无预期同步异常。
          */
         (resolve) => { /* 1. 安排30毫秒后的下一次统一开始时刻检查。 */ setTimeout(resolve, 30); });
        const response = await a.request("game.action", { action: "drop", score: 999999, angle: 99, playerId: joined.payload.playerId, targetId: "m1", minerals: [], winner: "me", time: 0, endsAt: 1 });
        assert.equal(response.type, "game.updated"); const next = response.payload.snapshot.game;
        assert.equal(next.miners[0].score, 0); assert.equal(next.miners[1].hook.phase, "idle"); assert.notEqual(next.miners[0].hook.angle, 99); assert.equal(next.endsAt, g.endsAt); assert.equal(next.fields.shared.minerals.length, 10);
        assert.equal((await a.request("game.action", { action: "drop" })).type, "room.error");
        for (const p of [a, b, c]) await p.request("room.leave");
      } finally { a.close(); b.close(); c.close(); }
      break;
    }
    case "A08 真实WS两人争同一钻石且只能计一次": {
      const a = new Probe(f.base), b = new Probe(f.base);
      try {
        await Promise.all([a.ready(), b.ready()]);
        const created = await a.request("room.create", { gameType: "gold-miner", nickname: "抢矿甲" });
        await b.request("room.join", { gameType: "gold-miner", roomId: created.payload.roomId, nickname: "抢矿乙" });
        const response = await a.request("game.action", { action: "start", mode: "shared", durationSeconds: 10 });
        const g = response.payload.snapshot.game, r = require("../gold-miner-rules");
        const target = g.fields.shared.minerals.find(/** 从共享权威矿场选取本场抢矿射线共同指向的钻石。
          * @param {object} m - 非空矿石记录，id为模板矿石标识。
          * @returns {boolean} id为m3时为真；无副作用或预期异常。
          */
         (m) => { /* 1. 按固定模板标识定位钻石。 */ return m.id === "m3"; });
        const times = g.miners.map(
          /** 计算该玩家真实摆钩朝向同一钻石的绝对操作时刻。
           * @param {object} miner - 非空权威矿工，hook.origin为像素坐标；不改变其钩状态。
           * @returns {number} Unix毫秒时刻；最近接触矿石不是目标时断言抛错，规则异常传播；不发送操作。
           */
          (miner) => {
          // 1. 从钻石和矿工原点计算射线角度，不将目标ID或角度传给服务器。
          const angle = Math.atan2(target.x - miner.hook.origin.x, target.y - miner.hook.origin.y);
          const intendedHook = { origin: miner.hook.origin, angle };
          // 2. 排序接触距离，先断言两条射线最先碰到的均是同一钻石。
          const first = g.fields.shared.minerals.slice().sort(/** 将射线上较早接触的矿石排到前面，核实钻石并未被其他矿石遮挡。
            * @param {object} left - 非空左侧矿石，位置和半径均为像素。
            * @param {object} right - 非空右侧矿石，位置和半径均为像素。
            * @returns {number} 接触长度差，未接触时遵循规则的Infinity语义（两者均未接触可为NaN）；只排序矿石数组副本，规则异常传播。
            */
           (left, right) => { /* 1. 按预期射线的像素接触长度比较。 */ return r.contactLength(intendedHook, left) - r.contactLength(intendedHook, right); })[0];
          assert.equal(first.id, target.id, "两条射线最先接触同一枚钻石");
          // 3. 用公共摆钩周期求对应的Unix毫秒操作时刻，仅用于等待真实时间。
          return g.startedAt + (Math.PI - Math.asin(angle / r.MAX_ANGLE)) * r.SWING_PERIOD_MS / (2 * Math.PI);
        });
        await Promise.all([a, b].map(
          /** 在各玩家摆角命中钻石的真实时刻仅发送drop意图。
           * @param {Probe} probe - 甲或乙已参赛的非空独立WS观察连接。
           * @param {number} index - 0为甲、1为乙，用于读取同序计算的Unix毫秒时刻。
           * @returns {Promise<void>} drop获game.updated后兑现；超时、传输或断言异常拒绝；发送一次真实下钩。
           */
          async (probe, index) => {
          // 1. 各自等待公共摆钩计算得到的真实操作时刻，不推进服务器时间。
          while (Date.now() < times[index]) await new Promise(/** 安排下次钻石摆角绝对时刻检查。
            * @param {Function} resolve - 无结果兑现本轮等待的回调，不可为空。
            * @returns {void} 创建4毫秒计时器；不调整摆角、目标或服务器时钟，无预期同步异常。
            */
           (resolve) => { /* 1. 安排4毫秒后再次比较实际时间和目标时刻。 */ setTimeout(resolve, 4); });
          // 2. 只发送drop并核对真实响应，不附带目标、角度或自报时间。
          assert.equal((await probe.request("game.action", { action: "drop" })).type, "game.updated");
        }));
        const timeout = Date.now() + 13000;
        while (a.last.game.phase !== "finished" && !a.last.game.miners.every(/** 检查争钻石的参赛矿工是否已结束回收。
          * @param {object} m - 非空权威矿工快照，hook.phase为服务端钩阶段。
          * @returns {boolean} idle为真；纯观测，钩记录缺失时抛错。
          */
         (m) => { /* 1. 查看该矿工权威钩阶段。 */ return m.hook.phase === "idle"; })) {
          if (Date.now() > timeout) throw new Error("共享抢钻石未完成回收");
          await new Promise(/** 为服务端下一份回收快照让出事件循环。
            * @param {Function} resolve - 无结果兑现本轮等待的回调，不可为空。
            * @returns {void} 创建25毫秒计时器；不模拟回收或计分，无预期同步异常。
            */
           (resolve) => { /* 1. 安排25毫秒后再观测真实服务端回收快照。 */ setTimeout(resolve, 25); });
        }
        const collected = a.last.game.fields.shared.minerals.find(
          /** 在回收后的账本定位本次争抢的钻石。
           * @param {object} m - 非空权威矿石记录，id与开局模板标识相对应。
           * @returns {boolean} 标识与目标一致为真；只读比较，无副作用或预期异常。
           */
          (m) => { /* 1. 按开局选定的钻石标识匹配。 */ return m.id === target.id; });
        assert.equal(collected.status, "collected"); assert.equal(collected.claimedBy, created.payload.playerId);
        assert.equal(a.last.game.miners[0].score, target.value);
        // 1.5 乙可能继续抓到沿线石头；逐玩家检查已收集矿石账本，不把空钩作为规则要求。
        for (const miner of a.last.game.miners) {
          const earned = a.last.game.fields.shared.minerals.filter(/** 选出实际归属当前矿工的已收集矿石，允许乙继续抓到沿线石头。
            * @param {object} m - 非空共享矿石账本记录，claimedBy为空时不计入该玩家。
            * @returns {boolean} 已collected且归属该矿工为真；不改账本，无预期异常。
            */
           (m) => { /* 1. 同时核对收集状态和权威归属。 */ return m.status === "collected" && m.claimedBy === miner.playerId; });
          assert.equal(miner.score, earned.reduce(/** 从已收集矿石账本汇总真实金额，核对服务端计分。
            * @param {number} sum - 从0开始累计的整数金额，单位与矿石value一致，不可为空。
            * @param {object} m - 非空已收集矿石，value为权威整数金额。
            * @returns {number} 加上本矿石后的金额；纯聚合，无副作用或预期异常。
            */
           (sum, m) => { /* 1. 累加这一枚矿石的权威价值。 */ return sum + m.value; }, 0)); assert.equal(miner.collectedCount, earned.length);
        }
        assert.equal(a.last.game.fields.shared.minerals.filter(/** 统计目标钻石在共享账本中已收集的记录数。
          * @param {object} m - 非空权威矿石记录，id是开局固定标识，status为最新收集状态。
          * @returns {boolean} 同一目标且已collected为真；只读筛选，无副作用或预期异常。
          */
         (m) => { /* 1. 同时限定目标标识与已收集状态。 */ return m.id === target.id && m.status === "collected"; }).length, 1);
        assert.deepEqual(a.last.game.fields, b.last.game.fields);
        await a.request("room.leave"); await b.request("room.leave");
      } finally { a.close(); b.close(); }
      break;
    }
    case "A04 真实WS自定义10、65、120、600秒": {
      for (const durationSeconds of [10, 65, 120, 600]) {
        const a = new Probe(f.base), b = new Probe(f.base);
        try {
          await Promise.all([a.ready(), b.ready()]);
          const created = await a.request("room.create", { gameType: "gold-miner", nickname: "时长房主" });
          await b.request("room.join", { gameType: "gold-miner", roomId: created.payload.roomId, nickname: "时长客人" });
          const res = await a.request("game.action", { action: "start", durationSeconds }); const game = res.payload.snapshot.game;
          assert.equal(game.durationSeconds, durationSeconds); assert.equal(game.endsAt - game.startedAt, durationSeconds * 1000);
          await a.request("room.leave"); await b.request("room.leave");
        } finally { a.close(); b.close(); }
      }
      break;
    }
    case "A01 大厅第十二入口及页面初始90秒": {
      await f.a.goto(f.base + "/index.html"); assert.equal(await f.a.locator(".lobby-game").count(), 13);
      await f.a.locator('.lobby-game[href="gold-miner.html"]').click();
      await f.a.waitForFunction(/** 确认从大厅跳转后游戏页面观测钩子已安装。
        * @returns {boolean} 钩子为函数时为真；仅检查全局类型，不调用钩子，无副作用或预期异常。
        */
       () => { /* 1. 等待渲染钩子确实初始化。 */ return typeof window.render_game_to_text === "function"; });
      assert.equal(await f.a.locator("#goldDuration").inputValue(), "90"); assert.equal(await f.a.locator(".back-link").getAttribute("href"), "index.html");
      break;
    }
    case "A02 两个真正独立上下文邀请加入与身份隔离": {
      await f.a.locator("#nicknameInput").fill("矿工甲"); await f.a.locator("#hostBtn").click();
      await waitState(f.a, /** 等待独立页面获得服务器分配的玩家身份。
        * @param {object} s - 非空最新镜像；尚未加入时playerId可为空。
        * @returns {boolean} playerId非空为真；仅观测，无副作用或预期异常。
        */
       (s) => { /* 1. 判断权威玩家身份是否已产生。 */ return Boolean(s.playerId); });
      f.invite = await f.a.locator("#shareInput").inputValue();
      await f.b.goto(f.invite); await waitState(f.b, /** 等待独立页面获得服务器分配的玩家身份。
        * @param {object} s - 非空最新镜像；尚未加入时playerId可为空。
        * @returns {boolean} playerId非空为真；仅观测，无副作用或预期异常。
        */
       (s) => { /* 1. 判断权威玩家身份是否已产生。 */ return Boolean(s.playerId); });
      await waitState(f.a, /** 等待房主页面收到两人房间的权威成员列表。
        * @param {object} s - 已入房的非空页面镜像，room.players为实际成员数组。
        * @returns {boolean} 成员数恰为2时为真；房间缺失时抛错，不添加成员。
        */
       (s) => { /* 1. 核对真实邀请加入后的成员数量。 */ return s.room.players.length === 2; });
      const a = await state(f.a), b = await state(f.b);
      assert.notEqual(a.playerId, b.playerId); assert.equal(a.roomId, b.roomId);
      f.idA = a.playerId; f.idB = b.playerId;
      const tokens = await Promise.all([f.a, f.b].map(/** 读取该独立浏览器自己的重连标识供隔离断言，不共享或输出凭据。
        * @param {import('playwright').Page} page - 已入房的甲或乙独立页面，不可为空。
        * @returns {Promise<string>} 本上下文重连标识；页面执行或存储解析失败时拒绝，只读存储。
        */
       (page) => { /* 1. 在该页面自身上下文读取身份记录。 */ return page.evaluate(
         /** 取得本上下文已保存的重连标识，不访问其他玩家存储。
          * @returns {string} reconnectToken；记录缺失或JSON无效时抛错，无存储写入或网络操作。
          */
         () => { /* 1. 只读本页面存储的重连标识供身份隔离断言。 */ return JSON.parse(localStorage.getItem("linkplay-gold-miner-identity")).reconnectToken; }); }));
      assert.notEqual(tokens[0], tokens[1]); assert.equal(a.game.phase, "waiting");
      break;
    }
    case "A07 房主共享10秒统一开局与倒计时禁用": {
      await start(f, "shared", 10);
      const a = await state(f.a); assert.equal(a.canDrop, false); assert.equal(await f.a.locator("#goldDrop").isDisabled(), true);
      assert.equal(await f.b.locator("#goldStart").isDisabled(), true);
      f.sharedEndsAt = a.game.endsAt;
      break;
    }
    case "A08 A10 A11 按钮与空格真实抢矿回收计分": {
      const drops = await Promise.all([aimedDrop(f.a, "button"), aimedDrop(f.b, "space")]);
      await Promise.all([scored(f.a, own(drops[0]).score), scored(f.b, own(drops[1]).score)]);
      const a = await state(f.a); const field = a.game.fields.shared;
      const collected = field.minerals.filter(/** 检查矿石是否已被服务端确认收集。
        * @param {object} m - 非空权威矿石记录，status为当前生命周期状态。
        * @returns {boolean} collected时为真；纯筛选，无副作用或预期异常。
        */
       (m) => { /* 1. 只认可权威已收集状态。 */ return m.status === "collected"; });
      assert.equal(collected.reduce(/** 从已收集矿石账本汇总真实金额，核对服务端计分。
            * @param {number} sum - 从0开始累计的整数金额，单位与矿石value一致，不可为空。
            * @param {object} m - 非空已收集矿石，value为权威整数金额。
            * @returns {number} 加上本矿石后的金额；纯聚合，无副作用或预期异常。
            */
           (sum, m) => { /* 1. 累加这一枚矿石的权威价值。 */ return sum + m.value; }, 0), a.game.miners.reduce(/** 汇总所有参赛矿工的真实得分，与矿石金额总账核对。
        * @param {number} sum - 从0开始累计的整数金额，单位与score一致，不可为空。
        * @param {object} m - 非空权威矿工记录，score为已入账整数金额。
        * @returns {number} 加上本矿工得分后的金额；纯聚合，无副作用或预期异常。
        */
       (sum, m) => { /* 1. 累计每位矿工的权威得分。 */ return sum + m.score; }, 0));
      assert(collected.every(/** 核对已收集矿石都有可追溯的权威归属。
        * @param {object} m - 非空已收集矿石记录，claimedBy应为非空玩家标识。
        * @returns {string|null|undefined} 原始归属字段，every按真值检查；不修改账本，无预期异常。
        */
       (m) => { /* 1. 读取服务端登记的收集者身份。 */ return m.claimedBy; }));
      await waitState(f.b, /** 等待乙页面完整共享矿场与甲的观测结果一致。
        * @param {object} s - 乙最新非空权威镜像，须含shared矿场。
        * @param {string} expected - 甲共享矿场的JSON字符串，不可为空，包含矿石状态及归属。
        * @returns {boolean} JSON完整相等为真；结构异常传播，只读镜像。
        */
       (s, expected) => { /* 1. 对比两端共享矿场序列化内容。 */ return JSON.stringify(s.game.fields.shared) === expected; }, JSON.stringify(field));
      await f.a.screenshot({ path: path.join(ROOT, "outputs/gold-miner-shared-desktop.png"), fullPage: true });
      f.sharedScores = a.game.miners.map(/** 提取权威得分，保存或对比截止结算前后的逐玩家金额。
        * @param {object} m - 非空权威矿工记录，score为已入账整数金额。
        * @returns {number} 原始分数，单位同矿石value；纯投影，无副作用或预期异常。
        */
       (m) => { /* 1. 按原矿工数组顺序读取金额。 */ return m.score; });
      break;
    }
    case "A16 刷新恢复身份分数矿场及原截止": {
      const before = await state(f.a); await f.a.reload();
      await waitState(f.a, /** 确认刷新后恢复原身份并重新连上同一轮比赛。
        * @param {object} s - 刷新后的非空镜像，game尚未恢复时可为空。
        * @param {string} id - 刷新前甲的非空服务器身份标识，不是客户端授权输入。
        * @returns {boolean} 身份、在线状态及第1轮都恢复为真；纯观测，无副作用或预期异常。
        */
       (s, id) => { /* 1. 同时核对身份恢复、在线及原轮次。 */ return s.playerId === id && s.online === "online" && s.game?.round === 1; }, f.idA);
      const after = await state(f.a);
      assert.equal(after.game.endsAt, before.game.endsAt); assert.equal(own(after).score, own(before).score); assert.deepEqual(after.game.fields, before.game.fields);
      break;
    }
    case "A13 A14 真实服务器截止结算与金额稳定": {
      await waitState(f.a, /** 等待服务器按原截止时刻完成真实结算。
        * @param {object} s - 已参赛页面的非空最新镜像，game为权威比赛记录；无附加参数。
        * @returns {boolean} finished为真；game缺失时抛错，不推进时钟或模拟终局。
        */
       (s) => { /* 1. 只读取权威结算阶段。 */ return s.game.phase === "finished"; }); await waitState(f.b, /** 等待服务器按原截止时刻完成真实结算。
        * @param {object} s - 已参赛页面的非空最新镜像，game为权威比赛记录；无附加参数。
        * @returns {boolean} finished为真；game缺失时抛错，不推进时钟或模拟终局。
        */
       (s) => { /* 1. 只读取权威结算阶段。 */ return s.game.phase === "finished"; });
      const a = await state(f.a), b = await state(f.b);
      assert.equal(a.game.endsAt, f.sharedEndsAt); assert.equal(a.game.endsAt - a.game.startedAt, 10000);
      assert.deepEqual(a.game.rankings, b.game.rankings); assert.deepEqual(a.game.miners.map(/** 提取权威得分，保存或对比截止结算前后的逐玩家金额。
        * @param {object} m - 非空权威矿工记录，score为已入账整数金额。
        * @returns {number} 原始分数，单位同矿石value；纯投影，无副作用或预期异常。
        */
       (m) => { /* 1. 按原矿工数组顺序读取金额。 */ return m.score; }), f.sharedScores);
      assert.equal(a.canDrop, false); assert.equal(await f.a.locator("#goldWinner").isVisible(), true);
      f.oldField = a.game.fields.shared;
      break;
    }
    case "A09 A15 再开独立竞速相同模板新局清分": {
      await start(f, "independent", 20);
      const a = await state(f.a); assert.equal(a.game.round, 2); assert(own(a).score === 0);
      assert.deepEqual(a.game.fields[f.idA], a.game.fields[f.idB]); assert.notDeepEqual(a.game.fields[f.idA], f.oldField);
      f.initialIndependent = JSON.parse(JSON.stringify(a.game.fields[f.idB]));
      break;
    }
    case "A09 独立矿场甲回收不改变乙矿场": {
      const before = await aimedDrop(f.a, "button"); await scored(f.a, own(before).score);
      const a = await state(f.a), b = await state(f.b);
      assert(a.game.fields[f.idA].minerals.some(/** 检查矿石是否已被服务端确认收集。
        * @param {object} m - 非空权威矿石记录，status为当前生命周期状态。
        * @returns {boolean} collected时为真；纯筛选，无副作用或预期异常。
        */
       (m) => { /* 1. 只认可权威已收集状态。 */ return m.status === "collected"; }));
      assert.deepEqual(b.game.fields[f.idB], f.initialIndependent); assert.equal(own(b).score, 0);
      break;
    }
    case "A10 A16 触屏放钩断线继续回收与自动恢复": {
      const before = await aimedDrop(f.b, "touch");
      const deadline = before.game.endsAt;
      f.expectOffline = true;
      try {
        await f.contextB.setOffline(true);
        await f.b.evaluate(/** 关闭乙页面实际创建的WS并阻止重连，制造真实断线而非伪造快照。
          * @returns {void} 标记离线状态并关闭观察到的socket；不发新的游戏操作。
          */
         () => {
           // 1. 设置标记阻止回环重连，确保测试可观察到断线状态。
           window.__gmBlockReconnect = true;
           for (const socket of window.__gmSockets || []) socket.close();
         });
        await waitState(f.a, /** 等待甲从权威成员列表观察到乙真实离线。
          * @param {object} s - 甲最新非空入房镜像，room.players为权威成员列表。
          * @param {string} id - 乙已分配的非空玩家标识，仅用来定位观察对象。
          * @returns {boolean} 乙仍在房间但未连接为真；房间缺失时抛错，不修改成员。
          */
         (s, id) => { /* 1. 检查指定成员的权威连接状态。 */ return s.room.players.some(
           /** 识别指定仍在房内的离线成员。
            * @param {object} p - 非空房间成员记录，connected为权威连接状态。
            * @returns {boolean} 身份匹配且未连接为真；纯观测，无副作用或预期异常。
            */
           (p) => { /* 1. 同时匹配身份与离线状态。 */ return p.playerId === id && !p.connected; }); }, f.idB);
        await waitState(f.a, /** 等待甲观察到离线乙的钩仍由服务器完成回收计分。
          * @param {object} s - 甲非空权威镜像，须含乙的本局矿工记录。
          * @param {string} id - 乙非空服务器玩家标识，只作观测定位。
          * @returns {boolean} 乙金额大于0为真；矿工缺失时抛错，不替乙发送操作。
          */
         (s, id) => { /* 1. 读取离线身份的真实回收金额。 */ return s.game.miners.find(/** 定位显式指定身份的参赛矿工以读取离线回收得分。
            * @param {object} m - 非空权威矿工记录，playerId为服务端参赛身份。
            * @returns {boolean} 与外层显式身份相同为真；只读比较，无副作用或预期异常。
            */
           (m) => { /* 1. 按显式玩家标识匹配矿工。 */ return m.playerId === id; }).score > 0; }, f.idB);
        await f.b.evaluate(/** 解除乙页面重连阻止，允许自动恢复连接。
          * @returns {void} 清除离线标记；无额外操作。
          */
         () => { window.__gmBlockReconnect = false; });
        await f.contextB.setOffline(false);
        await waitState(f.b, /** 等待乙以原身份恢复连接，并从自己的镜像确认离线回收得分。
          * @param {object} s - 恢复中的乙非空镜像，须含房间及参赛矿工记录。
          * @param {string} id - 断线前乙的非空服务器身份，不用于伪造输入。
          * @returns {boolean} 在线、身份、成员连接和得分全满足时为真；记录缺失时抛错，纯观测。
          */
         (s, id) => { /* 1. 同时核对原身份、真实重连和离线所得金额。 */ return s.online === "online" && s.playerId === id && s.room.players.some(
           /** 确认原身份成员的服务端连接状态已恢复。
            * @param {object} p - 非空房间成员，connected为权威连接布尔值。
            * @returns {boolean} 身份匹配且连接为真；只读比较，无副作用或预期异常。
            */
           (p) => { /* 1. 同时核对成员身份和在线连接。 */ return p.playerId === id && p.connected; }) && s.game.miners.find(/** 定位显式指定身份的参赛矿工以读取离线回收得分。
            * @param {object} m - 非空权威矿工记录，playerId为服务端参赛身份。
            * @returns {boolean} 与外层显式身份相同为真；只读比较，无副作用或预期异常。
            */
           (m) => { /* 1. 按显式玩家标识匹配矿工。 */ return m.playerId === id; }).score > 0; }, f.idB);
        const after = await state(f.b); assert.equal(after.game.endsAt, deadline); assert.equal(after.playerId, f.idB); assert(own(after).score > 0);
      } finally {
        // 1.3 断言失败也必须恢复网络，不能让后续用例被fixture离线状态污染。
        try { await f.b.evaluate(() => { window.__gmBlockReconnect = false; }); } catch {}
        await f.contextB.setOffline(false); f.expectOffline = false;
      }
      await f.b.screenshot({ path: path.join(ROOT, "outputs/gold-miner-independent-mobile.png"), fullPage: true });
      break;
    }
    case "A17 真浏览器晚加入等待下一局": {
      f.contextC = await f.browser.newContext({ viewport: { width: 1280, height: 900 } }); f.c = await f.contextC.newPage(); watchPage(f.c, f);
      await f.c.goto(f.invite); await waitState(f.c, /** 等待晚加入的丙获得独立身份并看到当前第2轮。
        * @param {object} s - 丙非空最新镜像；入房前playerId和game可为空。
        * @returns {boolean} 身份非空且round为2时为真；纯观测，无副作用或预期异常。
        */
       (s) => { /* 1. 同时核对新身份与当前比赛轮次。 */ return Boolean(s.playerId) && s.game?.round === 2; });
      const c = await state(f.c); assert.equal(c.game.miners.length, 2); assert(!c.game.miners.some(/** 检查晚加入的丙是否被错误纳入当前参赛名单。
        * @param {object} m - 非空第2轮权威矿工记录，playerId为本轮参赛身份。
        * @returns {boolean} 与丙页面身份相同为真；纯比较，无副作用或预期异常。
        */
       (m) => { /* 1. 用晚加入身份查当前轮参赛名单。 */ return m.playerId === c.playerId; })); assert.equal(c.canDrop, false); assert.equal(await f.c.locator("#goldDrop").isDisabled(), true);
      break;
    }
    case "A18 房主退出保留别人分数并实时交接权限": {
      const before = await state(f.b); await f.a.locator("#leaveRoomBtn").click();
      await waitState(f.b, /** 等待甲离房后乙获得服务器交接的房主权限。
        * @param {object} s - 乙非空入房镜像，room.players为最新成员列表。
        * @param {string} id - 乙的非空玩家标识，仅定位新房主。
        * @returns {boolean} 乙存在且host为true时为真；成员未找到时为假，房间缺失时抛错，不更改权限。
        */
       (s, id) => { /* 1. 读取指定成员真实房主标志。 */ return s.room.players.find(
         /** 从权威成员列表定位房主交接的接收者。
          * @param {object} p - 非空当前成员记录，playerId为服务端身份标识。
          * @returns {boolean} 与乙身份相同为真；纯比较，无副作用或预期异常。
          */
         (p) => { /* 1. 按交接接收者身份匹配。 */ return p.playerId === id; })?.host === true; }, f.idB);
      const b = await state(f.b); assert.equal(own(b).score, own(before).score); assert.equal(b.game.miners.find(/** 定位已退出的甲以核对退赛状态或无获胜资格。
        * @param {object} m - 非空矿工或排名记录，playerId为该轮服务端身份。
        * @returns {boolean} 与fixture保存的甲身份相同为真；纯比较，无副作用或预期异常。
        */
       (m) => { /* 1. 用原甲身份匹配保留的权威记录。 */ return m.playerId === f.idA; }).departed, true);
      break;
    }
    case "A14 A15 退出无获胜资格新房主可再开65秒": {
      await waitState(f.b, /** 等待服务器按原截止时刻完成真实结算。
        * @param {object} s - 已参赛页面的非空最新镜像，game为权威比赛记录；无附加参数。
        * @returns {boolean} finished为真；game缺失时抛错，不推进时钟或模拟终局。
        */
       (s) => { /* 1. 只读取权威结算阶段。 */ return s.game.phase === "finished"; }, null, 30000);
      const finished = await state(f.b); assert.equal(finished.game.rankings.find(/** 定位已退出的甲以核对退赛状态或无获胜资格。
        * @param {object} m - 非空矿工或排名记录，playerId为该轮服务端身份。
        * @returns {boolean} 与fixture保存的甲身份相同为真；纯比较，无副作用或预期异常。
        */
       (m) => { /* 1. 用原甲身份匹配保留的权威记录。 */ return m.playerId === f.idA; }).rank, null);
      await f.b.locator("#goldMode").selectOption("shared"); await f.b.locator("#goldDuration").fill("65"); await f.b.locator("#goldStart").click();
      await waitState(f.b, /** 等待新房主真实开出的第3轮进入playing。
        * @param {object} s - 乙最新非空镜像，game为服务器比赛记录。
        * @returns {boolean} 第3轮且playing为真；game缺失时抛错，仅观察，不替房主开局。
        */
       (s) => { /* 1. 同时确认新轮次与比赛阶段。 */ return s.game.round === 3 && s.game.phase === "playing"; }); await waitState(f.c, /** 等待晚加入的丙页面同步到下一局第3轮。
        * @param {object} s - 丙最新非空入房镜像，game为权威比赛记录。
        * @returns {boolean} round为3时为真；game缺失时抛错，只读观测。
        */
       (s) => { /* 1. 核对晚加入页面同步的新轮次。 */ return s.game.round === 3; });
      const b = await state(f.b); assert.equal(b.game.durationSeconds, 65); assert.equal(b.game.endsAt - b.game.startedAt, 65000); assert(b.game.miners.every(/** 核对第3轮所有参赛者的旧局金额已清零。
        * @param {object} m - 非空新局权威矿工记录，score为已入账整数金额，单位同矿石value。
        * @returns {boolean} 分数严格为0时为真；纯观测，无副作用或预期异常。
        */
       (m) => { /* 1. 检查该参赛者新局初始金额为零。 */ return m.score === 0; }));
      assert.equal(b.game.miners.length, 2); assert(b.game.miners.some(/** 确认保留成员中的另一位玩家已进入新局参赛名单。
        * @param {object} m - 非空第3轮权威矿工记录，playerId为服务端参赛身份。
        * @returns {boolean} 与结算时非房主成员身份相同为真；成员缺失时抛错，不改变参赛资格。
        */
       (m) => { /* 1. 将新局参赛身份与保留成员列表匹配。 */ return m.playerId === (finished.room.players.find(/** 从结算时成员列表选出新房主之外仍在房间的玩家。
        * @param {object} p - 非空权威成员记录；fixture中乙为已确定的新房主。
        * @returns {boolean} 身份不同于乙为真；纯比较，无副作用或预期异常。
        */
       (p) => { /* 1. 排除新房主乙，定位另一名下局参赛者。 */ return p.playerId !== f.idB; }).playerId); }));
      break;
    }
    case "A20 桌面手机布局健康和输入空格不误放钩": {
      await waitState(f.b, /** 等待页面权威镜像允许真实放钩，以测试输入框空格不会误操作。
        * @param {object} s - 最新非空页面镜像，canDrop来自当前身份及权威钩状态。
        * @returns {boolean} 原始可放钩标志；仅观测，无副作用或预期异常。
        */
       (s) => { /* 1. 检查本页面放钩权限已真实开放。 */ return s.canDrop; }); await waitState(f.c, /** 等待页面权威镜像允许真实放钩，以测试输入框空格不会误操作。
        * @param {object} s - 最新非空页面镜像，canDrop来自当前身份及权威钩状态。
        * @returns {boolean} 原始可放钩标志；仅观测，无副作用或预期异常。
        */
       (s) => { /* 1. 检查本页面放钩权限已真实开放。 */ return s.canDrop; });
      for (const page of [f.b, f.c]) {
        const metrics = await page.evaluate(/** 读取真实桌面或手机页面宽度和放钩触控目标尺寸。
          * @returns {object} CSS像素的视口/滚动宽、放钩高及所有可见控件高度；缺少放钩按钮会抛错，不改变布局。
          */
         () => {
           // 1. 读取每个实际可见控件，包含表单和返回链接，不只检查主按钮。
           const controls = [];
           for (const element of document.querySelectorAll("button,input,select,.back-link")) {
             const height = element.getBoundingClientRect().height;
             if (height > 0) controls.push({ name: element.id || element.className, height });
           }
           // 2. 输出真实布局尺寸，交由测试端断言。
           return { width: innerWidth, scroll: document.documentElement.scrollWidth, touch: document.querySelector("#goldDrop").getBoundingClientRect().height, controls };
         });
        assert(metrics.scroll <= metrics.width, JSON.stringify(metrics)); assert(metrics.touch >= 44);
        for (const control of metrics.controls) assert(control.height >= 44, JSON.stringify(control));
      }
      // 1.1 邀请输入仍可聚焦；禁用昵称框的focus不构成编辑区域验证。
      await f.c.locator("#shareInput").focus();
      const before = await state(f.c); await f.c.keyboard.press("Space");
      await waitState(f.c, /** 等待按空格后至少100毫秒的服务器时间更新，再检查未误放钩。
        * @param {object} s - 丙最新非空游戏镜像，serverNow为Unix毫秒。
        * @param {number} time - 按空格前权威serverNow，Unix毫秒数，不可为空。
        * @returns {boolean} 服务器时刻严格超过基线100毫秒为真；game缺失时抛错，不推进时钟。
        */
       (s, time) => { /* 1. 比较服务器快照时刻与输入前基线。 */ return s.game.serverNow > time + 100; }, before.game.serverNow);
      assert.equal(own(await state(f.c)).hook.phase, "idle");
      // 1.2 焦点在返回链接时也不能放钩或截断浏览器默认空格行为。
      await f.c.locator(".back-link").focus(); const outside = await state(f.c); await f.c.keyboard.press("Space");
      await waitState(f.c,
        /** 确认区域外空格之后已经收到新的服务器帧。
         * @param {object} s - 当前浏览器权威镜像。
         * @param {number} time - 空格前Unix毫秒时间，非空。
         * @returns {boolean} 新帧超过100毫秒时为真，只观察，不改时间。
         */
        (s, time) => { /* 1. 等待服务器帧更新再断言未放钩。 */ return s.game.serverNow > time + 100; }, outside.game.serverNow);
      assert.equal(own(await state(f.c)).hook.phase, "idle");
      await f.c.screenshot({ path: path.join(ROOT, "outputs/gold-miner-final-desktop.png"), fullPage: true });
      await f.b.screenshot({ path: path.join(ROOT, "outputs/gold-miner-final-mobile.png"), fullPage: true });
      assert.deepEqual(f.errors, []);
      break;
    }
    case "A21 本地六张素材可解码且无第三方请求": {
      for (const name of ["gold", "diamond", "rock", "dirt", "ground", "miner"]) assert.equal((await fetch(`${f.base}/assets/gold-miner/${name}.png`)).status, 200);
      const dimensions = await f.b.evaluate(
        /** 在手机页面真实加载并解码六张本站矿工素材。
         * @returns {Promise<Array<Array<number>>>} 模板顺序下各图片天然宽高，单位为图像像素；加载或解码失败时拒绝，发出本站素材请求但不插入DOM。
         */
        async () => {
        // 1. 逐张请求并真实解码本站素材，不把HTTP200误当可用图像。
        const results = [];
        for (const name of ["gold", "diamond", "rock", "dirt", "ground", "miner"]) {
          const image = new Image(); image.src = `assets/gold-miner/${name}.png`; await image.decode(); results.push([image.naturalWidth, image.naturalHeight]);
        }
        // 2. 保留模板顺序，返回解码后的天然像素尺寸供逐张断言。
        return results;
      });
      assert.deepEqual(dimensions, [[18,18],[18,18],[18,18],[18,18],[18,18],[24,24]]); assert.equal((await state(f.b)).assetErrors, ""); assert.deepEqual(f.external, []);
      break;
    }
    case "A21 六图解码失败可见告警且仍能真实回收计分": {
      const host = new Probe(f.base); const context = await f.browser.newContext({ viewport: { width: 1280, height: 900 } }); const failedNames = new Set();
      try {
        // 1. 只在隔离上下文返回损坏图片；服务器规则、快照和计时均不改写。
        await context.route("**/assets/gold-miner/*.png",
          /** 以HTTP200损坏图片验证真实浏览器解码失败路径。
           * @param {import('playwright').Route} route - 本隔离页面的一张本站PNG请求，非空。
           * @returns {Promise<void>} 完成本请求，不写磁盘素材、不拦截WS，异常传播。
           */
          async (route) => { /* 1. 登记每个实际被破坏的图片请求，避免把单张失败冒充六张。 */ failedNames.add(new URL(route.request().url()).pathname.split("/").pop()); /* 2. 所有素材都失败，不能靠其他成功图隐藏几何兜底缺口。 */ await route.fulfill({ status: 200, contentType: "image/png", body: "not-a-png" }); });
        await host.ready(); const created = await host.request("room.create", { gameType: "gold-miner", nickname: "降级房主" });
        const page = await context.newPage(); watchPage(page, f);
        const invite = new URL(f.invite); invite.searchParams.set("room", created.payload.roomId);
        await page.goto(invite.toString());
        await waitState(page,
          /** 确认独立页面入房且实际显示图像解码失败告警。
           * @param {object} s - 最新页面镜像，身份与错误提示均来自实际运行。
           * @returns {boolean} 身份和失败告警同时存在时为真；六个实际请求另由路由记录断言，不模拟游戏。
           */
          (s) => { /* 1. assetErrors契约是可见告警文本，不是逗号分隔的文件清单。 */ return Boolean(s.playerId) && s.assetErrors.includes("素材加载失败"); });
        assert.deepEqual([...failedNames].sort(), ["diamond.png","dirt.png","gold.png","ground.png","miner.png","rock.png"].sort());
        // 2. 两个真实身份在新房间开局，失败图片页面依然通过真实按钮取得服务器分数。
        assert.equal((await host.request("game.action", { action: "start", mode: "independent", durationSeconds: 20 })).type, "game.updated");
        const before = await aimedDrop(page, "button"); await scored(page, own(before).score);
        assert((await page.locator("#goldAssetError").textContent()).includes("素材加载失败"));
        assert.equal(await page.locator("#goldCanvas").isVisible(), true);
        await page.screenshot({ path: path.join(ROOT, "outputs/gold-miner-asset-fallback.png"), fullPage: true });
        assert.deepEqual(f.errors, []); assert.deepEqual(f.external, []);
        // 3. 显式离房以清理推进和宽限资源，再关闭拥有的浏览器上下文与WS。
        await page.locator("#leaveRoomBtn").click(); await host.request("room.leave");
      } finally { await context.close(); host.close(); }
      break;
    }
    default: throw new Error(`unknown case ${name}`);
  }
}
/** 运行整个隔离测试并保证资源收尾。
 * @returns {Promise<void>} 顺序登记全部场景并在finally关闭本测试浏览器和自建服务；会创建outputs目录及独立上下文，初始化、回环校验或清理失败时拒绝，由外层catch设置退出码1，node:test记录各用例结果。
 */
async function main() {
  // 1. 只允许回环BASE_URL，生产/共享外部站点不可成为被测目标。
  const base = process.env.BASE_URL || `http://127.0.0.1:${await freePort()}`;
  assert(["127.0.0.1", "localhost", "[::1]"].includes(new URL(base).hostname), "only loopback BASE_URL is allowed");
  const f = { base, errors: [], external: [], expectOffline: false };
  let app;
  try {
    if (!process.env.BASE_URL) app = spawn(process.execPath, [path.join(ROOT, "server.js")], { cwd: ROOT, env: { ...process.env, PORT: new URL(base).port, BIND_HOST: "127.0.0.1" }, stdio: "inherit" });
    await healthy(base, app); fs.mkdirSync(path.join(ROOT, "outputs"), { recursive: true });
    f.browser = await chromium.launch({ headless: true });
    f.contextA = await f.browser.newContext({ viewport: { width: 1366, height: 940 } });
    f.contextB = await f.browser.newContext({ viewport: { width: 390, height: 844 }, isMobile: true, hasTouch: true });
    // 2. 观察真实WS以测试断线；不共享凭据、不替换应用网络行为。
    await f.contextB.addInitScript(
      /** 在乙页面启动前安装真实WS引用观察器，仅供后续断线场景关闭自身连接。
       * @returns {void} 初始化本页面socket数组并以原生子类替换构造入口；保留原生握手与协议，原生构造异常仍传播。
       */
      () => {
      // 1. 保存原生构造器并初始化本页面自己的socket观察数组。
      const Native = window.WebSocket; window.__gmSockets = []; window.__gmBlockReconnect = false;
      // 2. 以原生子类登记构造成功的真实连接，保持原生网络和协议行为。
      window.WebSocket = class ObservedSocket extends Native {
        /** 登记测试观察用真实连接。
         * @param {...*} args - 原生WebSocket所需的非空URL和可选子协议字符串或数组；参数数量、空值及协议有效性由原生构造器校验，原样传递。
         * @returns {ObservedSocket} 本页面真实WS子类实例，额外登记到本页面观察数组，不改变发送行为。
         * @throws {Error} 原生构造参数无效或浏览器限制时传播原生异常，不登记未构造完成的实例。
         */
        constructor(...args) {
          /* 1. 模拟断网期间阻止WS重连成功，避免回环下setOffline被绕过导致未能观察到离线态。 */
          if (window.__gmBlockReconnect) {
            super(...args);
            setTimeout(() => { try { this.close(); } catch {} }, 0);
            return;
          }
          /* 2. 调用原生网络并登记引用。 */
          super(...args); window.__gmSockets.push(this);
        }
      };
    });
    f.a = await f.contextA.newPage(); f.b = await f.contextB.newPage();
    for (const page of [f.a, f.b]) watchPage(page, f);
    // 3. 顺序执行场景，所有网络与终局均真实，不模拟推进时间。
    const names = ["A02 真实WS六人上限与第七人无幽灵成员", "A03 A05 A06 A12 真实WS权限非法配置与全字段伪造", "A08 真实WS两人争同一钻石且只能计一次", "A04 真实WS自定义10、65、120、600秒", "A01 大厅第十二入口及页面初始90秒", "A02 两个真正独立上下文邀请加入与身份隔离", "A07 房主共享10秒统一开局与倒计时禁用", "A08 A10 A11 按钮与空格真实抢矿回收计分", "A16 刷新恢复身份分数矿场及原截止", "A13 A14 真实服务器截止结算与金额稳定", "A09 A15 再开独立竞速相同模板新局清分", "A09 独立矿场甲回收不改变乙矿场", "A10 A16 触屏放钩断线继续回收与自动恢复", "A17 真浏览器晚加入等待下一局", "A18 房主退出保留别人分数并实时交接权限", "A14 A15 退出无获胜资格新房主可再开65秒", "A20 桌面手机布局健康和输入空格不误放钩", "A21 本地六张素材可解码且无第三方请求", "A21 六图解码失败可见告警且仍能真实回收计分"];
    let executed = 0;
    for (const name of names) {
      await test(name,
        /** 执行当前场景，失败后阻止依赖污染形成多条伪失败。
         * @returns {Promise<void>} 成功兑现；失败保留原异常并标记终止后续场景，不把未执行当通过。
         */
        async () => {
          // 1. 一个场景必须完成自己的真实断言；失败仍由node:test报告。
          try { await scenario(name, f); } catch (error) { f.failed = true; throw error; }
        });
      executed += 1;
      if (f.failed) break;
    }
    console.log(`EXECUTED_CASES ${executed}/${names.length}`);
  } finally {
    // 4. 无论断言成功与否，释放本测试拥有的浏览器和服务，不留下后台进程。
    if (f.browser) await f.browser.close();
    if (app && app.exitCode === null) { const closed = once(app, "exit"); app.kill(); await closed; }
  }
}
main().catch(
  /** 将初始化或资源清理失败显式报告为进程失败，避免零用例误报。
   * @param {*} error - main拒绝的实际异常，通常为Error；原样交给console.error，包括非Error拒绝值。
   * @returns {void} 输出错误并设置退出码1，不提前终止尚在进行的清理，不再次抛错。
   */
  (error) => {
  // 1. 初始化/资源错误显式失败，不能用零用例误报通过。
  console.error(error); process.exitCode = 1;
});
