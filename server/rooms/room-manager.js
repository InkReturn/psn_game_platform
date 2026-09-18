/**
 * 房间管理器：房间生命周期的唯一入口。
 *
 * 职责：创建/加入/重连/离开、房间码生成、断线宽限、空闲房间清理。
 * 同一 Node 进程内单线程顺序处理消息，天然保证同房间操作串行化；
 * 本模块不再引入额外的锁。
 */
"use strict";

const { GomokuRoom } = require("../games/gomoku-room");
const { RelayRoom } = require("./relay-room");
const { ErrorCodes } = require("../protocol/errors");
const { makeMessage } = require("../protocol/messages");
const {
  ROOM_ID_ALPHABET,
  ROOM_ID_PATTERN,
  ROOM_IDLE_TTL_MS,
  CLEANUP_INTERVAL_MS,
  MAX_NICKNAME_LENGTH,
} = require("../config");

/** 日志输出函数（可注入以便测试静音）。 */
function defaultLog(...args) {
  console.log("[rooms]", ...args);
}

class RoomManager {
  /** @param {{log?: Function}} [options] - log 可注入自定义日志器。 */
  constructor(options = {}) {
    /** @type {Map<string, object>} roomId -> Room */
    this.rooms = new Map();
    /** @type {Map<string, object>} conn.playerId -> {room, player}（连接 ↔ 玩家绑定）。 */
    this.bindings = new Map();
    this.log = options.log || defaultLog;
    // 1. 启动周期性清理定时器（unref 使其不阻止进程退出）。
    this._cleanupTimer = setInterval(() => this.sweepIdleRooms(), CLEANUP_INTERVAL_MS);
    if (this._cleanupTimer.unref) this._cleanupTimer.unref();
  }

  /** 生成不重复的 8 位房间码。
   * @param {string} prefix - 2 位游戏前缀（如 WZ）。
   * @returns {string} 房间码。
   */
  generateRoomId(prefix) {
    // 1. 最多尝试 50 次，避免理论上的死循环。
    for (let i = 0; i < 50; i += 1) {
      let code = String(prefix || "RM").toUpperCase().slice(0, 2).padEnd(2, "X");
      for (let j = 0; j < 6; j += 1) code += ROOM_ID_ALPHABET[Math.floor(Math.random() * ROOM_ID_ALPHABET.length)];
      if (!this.rooms.has(code)) return code;
    }
    throw new Error("room id space exhausted");
  }

  /** 校验昵称。
   * @param {string} nickname - 原始昵称。
   * @returns {string|null} 合法昵称（去空白），非法返回 null。
   */
  sanitizeNickname(nickname) {
    if (typeof nickname !== "string") return null;
    const trimmed = nickname.trim();
    if (!trimmed || trimmed.length > MAX_NICKNAME_LENGTH) return null;
    return trimmed;
  }

  /**
   * 创建房间。
   *
   * @param {object} conn - 发起连接封装。
   * @param {object} payload - {gameType, nickname, prefix}。
   * @param {string|null} [requestId] - 原请求的信封 id，用于关联响应。
   * @returns {{ok: boolean, code?: string}} 结果；成功时已通过 conn 下发 room.created。
   */
  createRoom(conn, payload, requestId) {
    // 1. 一个连接同时只能在一个房间。
    if (this.bindings.has(conn.playerKey)) {
      return { ok: false, code: ErrorCodes.ALREADY_IN_ROOM };
    }
    // 2. 校验昵称与游戏类型。
    const nickname = this.sanitizeNickname(payload.nickname);
    if (!nickname) return { ok: false, code: ErrorCodes.INVALID_NICKNAME };
    const gameType = String(payload.gameType || "");
    if (gameType !== "gomoku" && !gameType.startsWith("relay:")) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `bad gameType ${gameType}` };
    }
    // 3. 建房：gomoku 用权威房，其余用转发房。
    const prefix = String(payload.prefix || gameType.replace("relay:", "").slice(0, 2) || "RM").slice(0, 2);
    const roomId = this.generateRoomId(prefix);
    const room = gameType === "gomoku" ? new GomokuRoom(roomId) : new RelayRoom(roomId, gameType);
    this.rooms.set(roomId, room);
    // 4. 创建者入座并绑定连接。
    const player = room.createPlayer(nickname);
    room.seatPlayer(player, "host");
    room.attach(player.playerId, conn);
    this.bindings.set(conn.playerKey, { room, player });
    this.log(`room ${roomId} created (${gameType}) by ${nickname} (${player.playerId})`);
    // 5. 下发创建结果（含重连凭据与初始快照）。
    conn.send(
      makeMessage("room.created", {
        roomId,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        role: player.role,
        snapshot: room.snapshot(),
      }, requestId || null),
    );
    return { ok: true, roomId, player };
  }

  /**
   * 加入房间。
   *
   * @param {object} conn - 连接封装。
   * @param {object} payload - {roomId, nickname, gameType?}。
   * @param {string|null} [requestId] - 原请求的信封 id，用于关联响应。
   * @returns {{ok: boolean, code?: string}} 结果。
   */
  joinRoom(conn, payload, requestId) {
    // 1. 前置校验：连接未绑房、房间码格式合法。
    if (this.bindings.has(conn.playerKey)) return { ok: false, code: ErrorCodes.ALREADY_IN_ROOM };
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    if (!ROOM_ID_PATTERN.test(roomId)) return { ok: false, code: ErrorCodes.INVALID_ROOM_ID };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, code: ErrorCodes.ROOM_NOT_FOUND };
    // 2. 满员/类型检查与昵称校验。
    if (room.players.size >= room.maxPlayers) return { ok: false, code: ErrorCodes.ROOM_FULL };
    const nickname = this.sanitizeNickname(payload.nickname);
    if (!nickname) return { ok: false, code: ErrorCodes.INVALID_NICKNAME };
    if (payload.gameType && room.gameType !== String(payload.gameType)) {
      return { ok: false, code: ErrorCodes.ROOM_TYPE_MISMATCH };
    }
    // 3. 入座并绑定。
    const player = room.createPlayer(nickname);
    room.seatPlayer(player, "guest");
    room.attach(player.playerId, conn);
    this.bindings.set(conn.playerKey, { room, player });
    this.log(`player ${nickname} (${player.playerId}) joined room ${roomId}`);
    // 4. 给加入者回执（含凭据与全量快照），并通知房内其他人。
    conn.send(
      makeMessage("room.joined", {
        roomId,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        role: player.role,
        snapshot: room.snapshot(),
      }, requestId || null),
    );
    room.broadcast(makeMessage("room.player_joined", { playerId: player.playerId, nickname, role: player.role, snapshot: room.snapshot() }), player.playerId);
    return { ok: true, roomId, player };
  }

  /**
   * 断线重连：凭 playerId + reconnectToken 恢复身份与座位。
   *
   * @param {object} conn - 新连接封装。
   * @param {object} payload - {roomId, playerId, reconnectToken}。
   * @param {string|null} [requestId] - 原请求的信封 id，用于关联响应。
   * @returns {{ok: boolean, code?: string}} 结果。
   */
  reconnect(conn, payload, requestId) {
    // 1. 连接必须未绑定房间。
    if (this.bindings.has(conn.playerKey)) return { ok: false, code: ErrorCodes.ALREADY_IN_ROOM };
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    if (!ROOM_ID_PATTERN.test(roomId)) return { ok: false, code: ErrorCodes.INVALID_ROOM_ID };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, code: ErrorCodes.ROOM_NOT_FOUND };
    // 2. 校验身份凭据。
    const player = room.verifyReconnect(String(payload.playerId || ""), String(payload.reconnectToken || ""));
    if (!player) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER };
    // 3. 重新绑定连接并恢复在线状态。
    room.attach(player.playerId, conn);
    this.bindings.set(conn.playerKey, { room, player });
    this.log(`player ${player.nickname} (${player.playerId}) reconnected to room ${roomId}`);
    // 4. 给重连者下发恢复快照，并通知其他人。
    conn.send(
      makeMessage("room.reconnected", {
        roomId,
        playerId: player.playerId,
        role: player.role,
        snapshot: room.snapshot(),
      }, requestId || null),
    );
    room.broadcast(
      makeMessage("room.player_reconnected", { playerId: player.playerId, nickname: player.nickname, snapshot: room.snapshot() }),
      player.playerId,
    );
    return { ok: true };
  }

  /**
   * 主动离开房间。
   *
   * @param {object} conn - 连接封装。
   * @returns {{ok: boolean}} 结果（未绑定时为 ok，幂等）。
   */
  leave(conn) {
    // 1. 未绑定视为成功（幂等）。
    const binding = this.bindings.get(conn.playerKey);
    if (!binding) return { ok: true };
    const { room, player } = binding;
    // 2. 解绑并移除玩家。
    this.bindings.delete(conn.playerKey);
    room.removePlayer(player.playerId, "leave");
    this.log(`player ${player.nickname} (${player.playerId}) left room ${room.roomId}`);
    // 3. 房间清空后立即回收，避免等待 sweep。
    if (room.isEmpty()) this.rooms.delete(room.roomId);
    return { ok: true };
  }

  /**
   * 连接断开回调：进入宽限期而非立刻移除。
   *
   * @param {object} conn - 断开的连接封装。
   */
  onDisconnect(conn) {
    const binding = this.bindings.get(conn.playerKey);
    if (!binding) return;
    const { room, player } = binding;
    // 1. 解除绑定，但保留房间内玩家记录（座位保留）。
    this.bindings.delete(conn.playerKey);
    room.detach(player.playerId);
    this.log(`player ${player.nickname} (${player.playerId}) disconnected from room ${room.roomId} (grace started)`);
    // 2. 通知房内其他玩家。
    room.onPlayerDisconnected(player);
  }

  /**
   * 游戏操作入口（gomoku 权威动作）。
   *
   * @param {object} conn - 连接封装。
   * @param {object} action - 游戏动作。
   * @param {string|null} [requestId] - 原请求的信封 id，用于把结果关联回该次请求。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  handleGameAction(conn, action, requestId) {
    const binding = this.bindings.get(conn.playerKey);
    if (!binding) return { ok: false, code: ErrorCodes.NOT_IN_ROOM };
    const { room, player } = binding;
    // 1. 只有权威房间接受 game.action；relay 房提示用 relay.send。
    if (!(room instanceof GomokuRoom)) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "room is relay type" };
    }
    return room.handleAction(player, action, requestId);
  }

  /**
   * relay 消息转发入口。
   *
   * @param {object} conn - 连接封装。
   * @param {object} payload - {event, data, targetId?}。
   * @returns {{ok: boolean, code?: string}} 结果。
   */
  handleRelay(conn, payload) {
    const binding = this.bindings.get(conn.playerKey);
    if (!binding) return { ok: false, code: ErrorCodes.NOT_IN_ROOM };
    const { room, player } = binding;
    // 1. 只有转发房走 relay；gomoku 房走 game.action。
    if (room instanceof GomokuRoom) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: "room is authoritative" };
    }
    room.relay(player, payload);
    return { ok: true };
  }

  /**
   * 周期清理：移除空闲超时的房间。
   *
   * 空闲定义：房间无任何在线连接，且超过 ROOM_IDLE_TTL_MS 未活跃。
   */
  sweepIdleRooms() {
    const now = Date.now();
    for (const [roomId, room] of this.rooms) {
      // 1. 无人（含宽限中玩家已全部移除）直接回收。
      if (room.isEmpty()) {
        this.rooms.delete(roomId);
        this.log(`room ${roomId} cleaned (empty)`);
        continue;
      }
      // 2. 全员离线且超过空闲 TTL 回收。
      if (room.hasNoConnectedPlayers() && now - room.updatedAt > ROOM_IDLE_TTL_MS) {
        for (const player of [...room.players.values()]) {
          room.removePlayer(player.playerId, "room-idle");
        }
        this.rooms.delete(roomId);
        this.log(`room ${roomId} cleaned (idle ttl)`);
      }
    }
  }

  /** 统计信息（供 /health 使用，不含隐私数据）。 */
  stats() {
    return { activeRooms: this.rooms.size };
  }
}

module.exports = { RoomManager };
