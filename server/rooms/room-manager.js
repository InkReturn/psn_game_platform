/**
 * 房间管理器：房间生命周期的唯一入口。
 *
 * 职责：创建/加入/重连/离开、房间码生成、断线宽限、空闲房间清理。
 * 同一 Node 进程内单线程顺序处理消息，天然保证同房间操作串行化；
 * 本模块不再引入额外的锁。
 */
"use strict";

const { GomokuRoom } = require("../games/gomoku-room");
const { AnimalChessRoom } = require("../games/animal-chess-room");
const { GridGameRoom } = require("../games/grid-room");
const { CheckersRoom } = require("../games/checkers-room");
const { LudoRoom } = require("../games/ludo-room");
const { RoomModel, isSupportedGameType, roomModelOf, roomPrefixOf } = require("../games/game-types");
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

/** 权威房构造表：gameType -> (roomId, payload) => Room（payload 为建房负载，按需取用）。 */
const AUTHORITATIVE_ROOMS = {
  gomoku: (roomId) => new GomokuRoom(roomId),
  "animal-chess": (roomId) => new AnimalChessRoom(roomId),
  tictactoe: (roomId) => new GridGameRoom(roomId, "tictactoe"),
  reversi: (roomId) => new GridGameRoom(roomId, "reversi"),
  connect4: (roomId) => new GridGameRoom(roomId, "connect4"),
  checkers: (roomId, payload) => new CheckersRoom(roomId, payload),
  ludo: (roomId, payload) => new LudoRoom(roomId, payload),
};

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
    // 2. 先校验游戏类型与昵称，任何一步失败都不允许产生副作用（不建房、不入座）。
    const gameType = String(payload.gameType || "");
    if (!isSupportedGameType(gameType)) {
      return { ok: false, code: ErrorCodes.INVALID_ACTION, detail: `unsupported gameType ${gameType}` };
    }
    const nickname = this.sanitizeNickname(payload.nickname);
    if (!nickname) return { ok: false, code: ErrorCodes.INVALID_NICKNAME };
    // 3. 建房：权威房由服务端持有对局状态，其余走转发房。
    const prefix = String(payload.prefix || roomPrefixOf(gameType)).slice(0, 2);
    const roomId = this.generateRoomId(prefix);
    const room = AUTHORITATIVE_ROOMS[gameType] ? AUTHORITATIVE_ROOMS[gameType](roomId, payload) : new RelayRoom(roomId, gameType);
    this.rooms.set(roomId, room);
    // 4. 创建者入座（标记房主）并绑定连接。
    const player = room.createPlayer(nickname, { host: true });
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
    // 1. 前置校验：连接未绑房、房间码格式合法、房间存在。
    if (this.bindings.has(conn.playerKey)) return { ok: false, code: ErrorCodes.ALREADY_IN_ROOM };
    const roomId = String(payload.roomId || "").trim().toUpperCase();
    if (!ROOM_ID_PATTERN.test(roomId)) return { ok: false, code: ErrorCodes.INVALID_ROOM_ID };
    const room = this.rooms.get(roomId);
    if (!room) return { ok: false, code: ErrorCodes.ROOM_NOT_FOUND };
    // 2. 全部校验必须在"入座/绑定"之前完成：任何被拒绝的加入都不能留下幽灵座位。
    //    2.1 房间类型校验：没有显式声明 gameType 时按房间码格式推断，避免五子棋房与
    //        斗兽棋房互相加入（房间码前缀由服务端分配，可反向推断类型）。
    const declaredGameType = payload.gameType === undefined || payload.gameType === null ? "" : String(payload.gameType);
    if (declaredGameType && room.gameType !== declaredGameType) {
      return { ok: false, code: ErrorCodes.ROOM_TYPE_MISMATCH, detail: `room=${room.gameType} request=${declaredGameType}` };
    }
    if (!declaredGameType && !this._roomIdMatchesGameType(roomId, room.gameType)) {
      return { ok: false, code: ErrorCodes.ROOM_TYPE_MISMATCH, detail: `room=${room.gameType} roomId=${roomId}` };
    }
    //    2.2 满员校验。
    if (room.players.size >= room.maxPlayers) return { ok: false, code: ErrorCodes.ROOM_FULL };
    //    2.3 昵称校验。
    const nickname = this.sanitizeNickname(payload.nickname);
    if (!nickname) return { ok: false, code: ErrorCodes.INVALID_NICKNAME };
    // 3. 入座并绑定。
    const player = room.createPlayer(nickname, { host: false });
    room.seatPlayer(player, "guest");
    room.attach(player.playerId, conn);
    this.bindings.set(conn.playerKey, { room, player });
    this.log(`player ${nickname} (${player.playerId}) joined room ${roomId}`);
    // 4. 给加入者回执（含凭据与全量快照）。
    conn.send(
      makeMessage("room.joined", {
        roomId,
        playerId: player.playerId,
        reconnectToken: player.reconnectToken,
        role: player.role,
        snapshot: room.snapshot(),
      }, requestId || null),
    );
    // 5. 成员变化后向房间内所有在线连接（含加入者）推送同一份权威快照。
    //    加入者也要收到：它的 room.joined 与快照可能被"座位分配"等后续状态更新，
    //    统一快照让两端渲染源完全一致。
    room.broadcastEventWithSnapshot("room.player_joined", { playerId: player.playerId, nickname, role: player.role });
    return { ok: true, roomId, player };
  }

  /**
   * 房间码 ↔ 房间类型一致性检查（未声明 gameType 时的兜底校验）。
   *
   * 房间码由服务端按 gameType 分配前缀（WZ=五子棋、DS=斗兽棋、其他=relay 游戏 2 位缩写），
   * 因此前缀可用于拒绝"拿五子棋房号进斗兽棋页面"这类跨游戏加入。
   *
   * @param {string} roomId - 8 位房间码（已大写）。
   * @param {string} gameType - 房间真实类型。
   * @returns {boolean} true 表示前缀与类型一致。
   */
  _roomIdMatchesGameType(roomId, gameType) {
    return roomId.slice(0, 2) === roomPrefixOf(gameType).padEnd(2, "X").slice(0, 2);
  }

  /**
   * 断线重连：凭 playerId + reconnectToken 恢复身份与座位。
   *
   * @param {object} conn - 新连接封装。
   * @param {object} payload - {roomId, playerId, reconnectToken, gameType?}。
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
    const declaredGameType = payload.gameType === undefined || payload.gameType === null ? "" : String(payload.gameType);
    if (declaredGameType && room.gameType !== declaredGameType) {
      return { ok: false, code: ErrorCodes.ROOM_TYPE_MISMATCH, detail: `room=${room.gameType} request=${declaredGameType}` };
    }
    // 2. 校验身份凭据。
    const player = room.verifyReconnect(String(payload.playerId || ""), String(payload.reconnectToken || ""));
    if (!player) return { ok: false, code: ErrorCodes.UNAUTHORIZED_PLAYER };
    // 3. 回收该玩家遗留的旧连接绑定。
    //    刷新页面时新连接可能早于旧 socket 的 close 事件到达，此时 bindings 里仍残留
    //    旧连接 -> 玩家 的映射；不清理会让旧连接被误认为"仍绑定房间"，
    //    并且旧 socket 迟到的 close 会把刚恢复在线的新连接误标成断线。
    this.dropStaleBindings(room, player.playerId);
    // 4. 重新绑定连接并恢复在线状态。
    room.attach(player.playerId, conn);
    this.bindings.set(conn.playerKey, { room, player });
    this.log(`player ${player.nickname} (${player.playerId}) reconnected to room ${roomId}`);
    // 5. 给重连者下发恢复快照。
    conn.send(
      makeMessage("room.reconnected", {
        roomId,
        playerId: player.playerId,
        role: player.role,
        snapshot: room.snapshot(),
      }, requestId || null),
    );
    // 6. 全员广播最新权威快照（重连者本人也需要：连接切换后由同一份状态驱动渲染）。
    room.broadcastEventWithSnapshot("room.player_reconnected", { playerId: player.playerId, nickname: player.nickname, role: player.role });
    return { ok: true };
  }

  /**
   * 清理某玩家在 bindings 中的旧连接记录（重连时调用）。
   *
   * @param {object} room - 目标房间。
   * @param {string} playerId - 玩家 id。
   * @returns {number} 被清理的绑定条数。
   */
  dropStaleBindings(room, playerId) {
    let dropped = 0;
    for (const [key, binding] of this.bindings) {
      if (binding.room === room && binding.player.playerId === playerId) {
        this.bindings.delete(key);
        dropped += 1;
      }
    }
    return dropped;
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
    // 2. 解绑并移除玩家（房间子类在 onPlayerRemoved 里向剩余玩家广播最新权威快照）。
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
    // 1. 迟到的旧连接 close 事件：该玩家已经在更新的连接上重连成功。
    //    此时若继续走断线流程，会把在线玩家误标为断线（A 侧表现为"B 已离开"却再也收不到恢复）。
    if (!room.isCurrentConn(player.playerId, conn)) {
      this.bindings.delete(conn.playerKey);
      this.log(`stale connection closed for ${player.nickname} (${player.playerId}) in room ${room.roomId}, ignored`);
      return;
    }
    // 2. 解除绑定，但保留房间内玩家记录（座位保留）。
    this.bindings.delete(conn.playerKey);
    room.detach(player.playerId);
    this.log(`player ${player.nickname} (${player.playerId}) disconnected from room ${room.roomId} (grace started)`);
    // 3. 通知房内其他玩家。
    room.onPlayerDisconnected(player);
  }

  /**
   * 游戏操作入口（服务器权威动作：五子棋 / 斗兽棋）。
   *
   * @param {object} conn - 连接封装。
   * @param {object} action - 游戏动作（{action, ...params}）。
   * @param {string|null} [requestId] - 原请求的信封 id，用于把结果关联回该次请求。
   * @returns {{ok: boolean, code?: string, detail?: string}} 结果。
   */
  handleGameAction(conn, action, requestId) {
    const binding = this.bindings.get(conn.playerKey);
    if (!binding) return { ok: false, code: ErrorCodes.NOT_IN_ROOM };
    const { room, player } = binding;
    // 1. 只有权威房间接受 game.action；relay 房提示用 relay.send。
    if (roomModelOf(room.gameType) !== RoomModel.AUTHORITATIVE || typeof room.handleAction !== "function") {
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
    // 1. 只有转发房走 relay；权威房走 game.action。
    if (roomModelOf(room.gameType) === RoomModel.AUTHORITATIVE) {
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
