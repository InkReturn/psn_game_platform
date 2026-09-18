/**
 * 统一错误码定义。
 *
 * 服务端只回错误码 + 技术性 message；客户端负责将错误码映射为中文人话展示，
 * 避免把异常栈直接暴露给用户。
 */
"use strict";

/** 错误码枚举（稳定字符串，客户端据此映射文案）。 */
const ErrorCodes = Object.freeze({
  INVALID_MESSAGE: "INVALID_MESSAGE", // 非法 JSON / 结构不符 / 缺少字段
  MESSAGE_TOO_LARGE: "MESSAGE_TOO_LARGE", // 消息超过大小上限
  RATE_LIMITED: "RATE_LIMITED", // 发送过于频繁
  INVALID_ROOM_ID: "INVALID_ROOM_ID", // 房间码格式非法
  INVALID_NICKNAME: "INVALID_NICKNAME", // 昵称非法（空/超长）
  ROOM_NOT_FOUND: "ROOM_NOT_FOUND", // 房间不存在或已清理
  ROOM_FULL: "ROOM_FULL", // 房间已满员
  ROOM_TYPE_MISMATCH: "ROOM_TYPE_MISMATCH", // 加入的房间类型与请求不符
  NOT_IN_ROOM: "NOT_IN_ROOM", // 尚未创建/加入房间就执行房间操作
  ALREADY_IN_ROOM: "ALREADY_IN_ROOM", // 重复创建/加入
  UNAUTHORIZED_PLAYER: "UNAUTHORIZED_PLAYER", // playerId / reconnectToken 校验失败
  INVALID_ACTION: "INVALID_ACTION", // 未知或参数非法的游戏动作
  GAME_NOT_STARTED: "GAME_NOT_STARTED", // 对局尚未开始（人未满）
  NOT_YOUR_TURN: "NOT_YOUR_TURN", // 当前不是该玩家的回合
  CELL_OCCUPIED: "CELL_OCCUPIED", // 目标交叉点已有棋子
  INVALID_MOVE: "INVALID_MOVE", // 坐标越界或类型错误
  GAME_ALREADY_FINISHED: "GAME_ALREADY_FINISHED", // 对局已结束
  INTERNAL_ERROR: "INTERNAL_ERROR", // 服务端内部错误
});

module.exports = { ErrorCodes };
