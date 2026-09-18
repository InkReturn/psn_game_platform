/**
 * LinkPlay 小游戏平台服务入口。
 *
 * 单进程同时承担：静态资源托管、HTTP 健康检查、WebSocket 游戏服务。
 * - 房间与对局状态保存在进程内存（第一阶段约定，重启即失）。
 * - 生产环境只监听 127.0.0.1，由 Nginx 反向代理提供 HTTPS/WSS。
 */
"use strict";

const express = require("express");
const { createServer } = require("http");
const path = require("path");
const { createHub } = require("./server/ws/hub");
const { RoomManager } = require("./server/rooms/room-manager");
const { BIND_HOST, PORT, DISCONNECT_GRACE_MS, ROOM_IDLE_TTL_MS } = require("./server/config");

const app = express();
const server = createServer(app);
const rootDir = __dirname;

// 1. 房间管理器与 WebSocket 装配。
const manager = new RoomManager();
const hub = createHub(server, manager);

// 2. 轻量健康检查：不含任何隐私数据。
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    uptime: Math.floor(process.uptime()),
    activeRooms: manager.stats().activeRooms,
    connections: hub.stats().connections,
  });
});

// 3. 静态资源（大厅与全部游戏页面）。
app.use(express.static(rootDir, { index: "index.html" }));

// 4. 启动监听。
server.listen(PORT, BIND_HOST, () => {
  console.log(`[app] LinkPlay game server listening on http://${BIND_HOST}:${PORT}`);
  console.log(`[app] WebSocket endpoint ws://${BIND_HOST}:${PORT}/ws`);
  console.log(`[app] disconnect grace ${DISCONNECT_GRACE_MS}ms, room idle ttl ${ROOM_IDLE_TTL_MS}ms (in-memory rooms)`);
});

// 5. 优雅停机：先停接收新连接，再关闭存量连接，交给 systemd 拉起。
function shutdown(signal) {
  console.log(`[app] received ${signal}, shutting down`);
  server.close(() => {
    hub.wss.close(() => {
      console.log("[app] closed");
      process.exit(0);
    });
    // 5.1 给存量 WebSocket 3 秒缓冲后强制退出。
    setTimeout(() => process.exit(0), 3000).unref();
  });
}
process.on("SIGTERM", () => shutdown("SIGTERM"));
process.on("SIGINT", () => shutdown("SIGINT"));

// 6. 兜底异常日志：记录后退出，由 systemd 自动重启。
process.on("uncaughtException", (err) => {
  console.error("[app] uncaught exception:", err && err.stack ? err.stack : err);
  process.exit(1);
});
process.on("unhandledRejection", (reason) => {
  console.error("[app] unhandled rejection:", reason);
});
