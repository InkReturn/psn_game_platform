"use strict";
const http = require("node:http");
const { WebSocketServer, WebSocket } = require("ws");
// 原版 map.js 会覆盖 global.Map，提前保留现代容器构造器。
const NativeMap = global.Map;

/** 将现代 ws 连接适配为 BrowserQuest 原版传输接口，不修改游戏规则。 */
class QuestConnection {
  /**
   * 创建玩家连接并注册数据与关闭事件。
   * @param {number} id 本进程内唯一的数值玩家编号。
   * @param {WebSocket} socket 已完成握手的连接。
   * @param {QuestServer} server 拥有此连接的冒险服务。
   */
  constructor(id, socket, server) {
    // 1. 保存身份及连接；每条消息至多 32KB，由 ws 层约束。
    this.id = id;
    this.socket = socket;
    this.server = server;
    this.windowStart = Date.now();
    this.messageCount = 0;
    // 2. 将事件转交有边界校验的处理方法。
    socket.on("message", this.receive.bind(this));
    socket.on("close", this.handleClose.bind(this));
    socket.on("error", this.handleError.bind(this));
  }
  /**
   * 解码 JSON 数组并交给原版协议检查器；非法或过量消息会关闭连接。
   * @param {Buffer} data 玩家发来的文本帧。
   * @param {boolean} binary 是否为不支持的二进制帧。
   */
  receive(data, binary) {
    // 1. 限制每秒消息数并拒绝二进制载荷。
    if (Date.now() - this.windowStart > 1000) {
      this.windowStart = Date.now();
      this.messageCount = 0;
    }
    if (binary || ++this.messageCount > 120) return this.close("消息频率或格式不合法");
    // 2. 只捕获 JSON 解码错误，游戏规则异常不得被当作输入错误吞掉。
    let message;
    try { message = JSON.parse(data.toString()); }
    catch { return this.close("无法解析消息"); }
    if (!Array.isArray(message)) return this.close("消息必须是数组");
    // 3. 原版规则层继续检查握手、动作与游戏状态。
    if (this.listenCallback) this.listenCallback(message);
  }
  /** 清理连接索引并通知原版玩家规则层；会释放玩家座位。 */
  handleClose() {
    // 1. 先移除网络索引，再通知游戏层。
    this.server.connections.delete(this.id);
    if (this.closeCallback) this.closeCallback();
  }
  /**
   * 报告网络错误，不将错误静默吞掉。
   * @param {Error} error ws 连接错误，不含游戏用户数据。
   */
  handleError(error) {
    // 1. 记录异常并终止失效连接。
    console.error("[browserquest] socket error:", error.message);
    this.socket.terminate();
  }
  /**
   * 登记原版协议处理器。
   * @param {Function} callback 接收已解码消息数组的函数。
   */
  listen(callback) {
    // 1. 保存动作处理器。
    this.listenCallback = callback;
  }
  /**
   * 登记断线处理器。
   * @param {Function} callback 清理玩家游戏状态的函数。
   */
  onClose(callback) {
    // 1. 保存断线处理器。
    this.closeCallback = callback;
  }
  /**
   * 将原版快照序列化并发送；连接已关闭时不再发送。
   * @param {Array} message 单条协议消息或消息批次。
   */
  send(message) {
    // 1. 统一通过文本接口发送 JSON。
    this.sendUTF8(JSON.stringify(message));
  }
  /**
   * 发送原版 go、timeout 或 JSON 文本。
   * @param {string} text 由游戏服务生成的 UTF-8 文本。
   */
  sendUTF8(text) {
    // 1. 只对有效连接写入；慢连接超过 1MB 积压时断开。
    if (this.socket.bufferedAmount > 1024 * 1024) return this.close("连接发送积压");
    if (this.socket.readyState === WebSocket.OPEN) this.socket.send(text);
  }
  /**
   * 主动关闭异常或空闲连接。
   * @param {string} reason 仅服务端日志使用的关闭原因。
   */
  close(reason) {
    // 1. 关闭连接，不把内部原因透传客户端。
    console.warn("[browserquest] connection closed:", reason);
    this.socket.close(1008);
  }
}

/** 仅支持现代 WebSocket 的本机试玩服务，替代废弃协议实现。 */
class QuestServer {
  /**
   * 创建回环 HTTP/WebSocket 服务；监听失败会终止进程。
   * @param {number} port 本地试玩端口，由配置文件提供。
   */
  constructor(port) {
    // 1. 建立独立服务及连接表，避免影响平台原来的 /ws。
    this.connections = new NativeMap();
    this.nextId = 50000;
    this.httpServer = http.createServer(this.handleHttp.bind(this));
    this.wss = new WebSocketServer({ server: this.httpServer, maxPayload: 32768 });
    // 2. 接入原版玩家逻辑并限制试玩世界连接总数。
    this.wss.on("connection", this.accept.bind(this));
    this.httpServer.on("error", this.fail.bind(this));
    this.httpServer.listen(port, "127.0.0.1");
  }
  /**
   * 返回健康状态及原版人数接口。
   * @param {import('node:http').IncomingMessage} request 本地 HTTP 请求。
   * @param {import('node:http').ServerResponse} response HTTP 响应流。
   */
  handleHttp(request, response) {
    // 1. 暴露只读健康及人数，其他路径拒绝。
    response.setHeader("Content-Type", "application/json");
    if (request.url === "/health") response.end(JSON.stringify({ game: "browserquest", status: "ok" }));
    else if (request.url === "/status") response.end(this.statusCallback ? this.statusCallback() : "[]");
    else { response.statusCode = 404; response.end("{}"); }
  }
  /**
   * 接入玩家并向原版服务器报告新连接。
   * @param {WebSocket} socket 新建立的浏览器连接。
   */
  accept(socket) {
    // 1. 拒绝超过单个试玩世界容量的连接。
    if (this.connections.size >= 32) { socket.close(1013); return; }
    // 2. 注册玩家；原版构造器会发送 go 并登记协议处理器。
    const connection = new QuestConnection(this.nextId++, socket, this);
    this.connections.set(connection.id, connection);
    if (this.connectCallback) this.connectCallback(connection);
  }
  /**
   * 输出监听错误并退出，防止假装服务已启动。
   * @param {Error} error HTTP 监听异常。
   */
  fail(error) {
    // 1. 失败即退出，交给启动器汇报。
    console.error("[browserquest] listen failed:", error.message);
    process.exit(1);
  }
  /**
   * 登记新玩家处理器。
   * @param {Function} callback 接收 QuestConnection 的原版回调。
   */
  onConnect(callback) {
    // 1. 保存玩家接入处理器。
    this.connectCallback = callback;
  }
  /**
   * 保留原版错误回调登记接口。
   * @param {Function} callback 原版错误处理器。
   */
  onError(callback) {
    // 1. 保存供接口兼容使用的错误处理器。
    this.errorCallback = callback;
  }
  /**
   * 登记人数查询处理器。
   * @param {Function} callback 返回世界人数 JSON 的函数。
   */
  onRequestStatus(callback) {
    // 1. 保存只读人数接口。
    this.statusCallback = callback;
  }
  /**
   * 查询原版世界广播所需连接。
   * @param {number|string} id 原版世界中的玩家实体编号。
   * @returns {QuestConnection|undefined} 当前连接，已移除时为空。
   */
  getConnection(id) {
    // 1. 原版 outgoingQueues 的键为字符串，统一成数值查询。
    return this.connections.get(Number(id));
  }
}
module.exports = { MultiVersionWebsocketServer: QuestServer };
