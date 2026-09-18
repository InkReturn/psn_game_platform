/**
 * 服务端运行配置。
 *
 * 集中存放所有可调常量（端口、宽限期、房间 TTL、限流阈值、消息上限等），
 * 避免魔法数字散落在各模块。第一阶段全部为进程内存实现，无外部依赖。
 */
"use strict";

/** 是否只监听本机回环地址（生产环境由 Nginx 反向代理对外）。 */
const BIND_HOST = process.env.BIND_HOST || "127.0.0.1";

/** HTTP/WebSocket 监听端口。 */
const PORT = Number(process.env.PORT || 8080);

/** WebSocket 路径（Nginx 反代时需匹配该 path）。 */
const WS_PATH = "/ws";

/** 单条 WebSocket 文本消息的最大字节数，超出即断开连接。 */
const MAX_MESSAGE_BYTES = 32 * 1024;

/** 昵称最大长度（字符数）。 */
const MAX_NICKNAME_LENGTH = 16;

/** 房间码格式：2 位游戏前缀 + 6 位大写字母/数字（去掉易混淆字符）。 */
const ROOM_ID_PATTERN = /^[A-Z0-9]{8}$/;

/** 房间码随机部分使用的字母表（无 0/1/I/O）。 */
const ROOM_ID_ALPHABET = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";

/** 玩家断线后座位保留的宽限时间（毫秒）。宽限期内重连可恢复身份。 */
const DISCONNECT_GRACE_MS = 90 * 1000;

/** 房间在全员离线后仍保留的时长（毫秒），超时自动清理。 */
const ROOM_IDLE_TTL_MS = 30 * 60 * 1000;

/** 房间清理扫描周期（毫秒）。 */
const CLEANUP_INTERVAL_MS = 30 * 1000;

/** 单连接消息频率限制：滑动窗口长度（毫秒）。 */
const RATE_WINDOW_MS = 5 * 1000;

/** 单连接消息频率限制：窗口内允许的最大消息条数。 */
const RATE_MAX_MESSAGES = 40;

/** WebSocket 协议层心跳间隔（毫秒），用于探测死连接。 */
const HEARTBEAT_INTERVAL_MS = 30 * 1000;

/** 心跳超时（毫秒）：超过该时长未收到 pong 判定连接死亡。 */
const HEARTBEAT_TIMEOUT_MS = 10 * 1000;

/** 重连令牌长度（字节，随机源字节数，base64url 编码后更长）。 */
const RECONNECT_TOKEN_BYTES = 24;

module.exports = {
  BIND_HOST,
  PORT,
  WS_PATH,
  MAX_MESSAGE_BYTES,
  MAX_NICKNAME_LENGTH,
  ROOM_ID_PATTERN,
  ROOM_ID_ALPHABET,
  DISCONNECT_GRACE_MS,
  ROOM_IDLE_TTL_MS,
  CLEANUP_INTERVAL_MS,
  RATE_WINDOW_MS,
  RATE_MAX_MESSAGES,
  HEARTBEAT_INTERVAL_MS,
  HEARTBEAT_TIMEOUT_MS,
  RECONNECT_TOKEN_BYTES,
};
