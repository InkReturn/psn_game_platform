/**
 * 房间成员管理基类。
 *
 * 提供玩家加入/断线/重连/移除的通用机制（含断线宽限计时），
 * 具体游戏逻辑（gomoku 权威对局）或消息转发逻辑（relay 房间）由子类实现。
 */
"use strict";

const crypto = require("crypto");
const { DISCONNECT_GRACE_MS, RECONNECT_TOKEN_BYTES } = require("../config");

/** 生成重连令牌。
 * @returns {string} base64url 随机串，用于断线后校验玩家身份。
 */
function createReconnectToken() {
  return crypto.randomBytes(RECONNECT_TOKEN_BYTES).toString("base64url");
}

/** 生成玩家 id。
 * @returns {string} 形如 p_xxxxxxxx 的随机 id。
 */
function createPlayerId() {
  return `p_${crypto.randomBytes(8).toString("hex")}`;
}

class RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {string} gameType - 房间类型（"gomoku" 或 "relay:<gameKey>"）。
   */
  constructor(roomId, gameType) {
    // 1. 房间元信息。
    this.roomId = roomId;
    this.gameType = gameType;
    this.createdAt = Date.now();
    this.updatedAt = Date.now();
    /** @type {Map<string, object>} playerId -> player */
    this.players = new Map();
    /** 房间内允许的最大玩家数（gomoku 2 人；relay 房默认较大以支持多人观战/本地混合）。 */
    this.maxPlayers = 2;
    /** 断线宽限定时器：playerId -> timer。 */
    this._graceTimers = new Map();
  }

  /** 生成并登记一个玩家对象（不绑定连接）。
   * @param {string} nickname - 玩家昵称（已校验长度）。
   * @returns {object} player 对象。
   */
  createPlayer(nickname) {
    const player = {
      playerId: createPlayerId(),
      nickname,
      reconnectToken: createReconnectToken(),
      conn: null,
      connected: false,
      disconnectedAt: null,
      joinedAt: Date.now(),
    };
    this.players.set(player.playerId, player);
    this.touch();
    return player;
  }

  /** 玩家连接绑定（首次加入或断线重连时调用）。
   * @param {string} playerId - 玩家 id。
   * @param {object} conn - WebSocket 连接封装（具备 send 方法）。
   * @returns {boolean} 是否绑定成功。
   */
  attach(playerId, conn) {
    const player = this.players.get(playerId);
    if (!player) return false;
    // 1. 取消未触发的宽限定时器。
    const timer = this._graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(playerId);
    }
    // 2. 绑定连接并更新状态。
    player.conn = conn;
    player.connected = true;
    player.disconnectedAt = null;
    this.touch();
    return true;
  }

  /** 玩家断线：保留座位进入宽限期，超时后移除。
   * @param {string} playerId - 玩家 id。
   * @returns {boolean} 玩家是否仍留在房间（宽限中）。
   */
  detach(playerId) {
    const player = this.players.get(playerId);
    if (!player) return false;
    // 1. 标记断线。
    player.conn = null;
    player.connected = false;
    player.disconnectedAt = Date.now();
    this.touch();
    // 2. 启动宽限定时器：到期仍未重连则真正移除。
    if (!this._graceTimers.has(playerId)) {
      const timer = setTimeout(() => {
        this._graceTimers.delete(playerId);
        this.removePlayer(playerId, "grace-expired");
      }, DISCONNECT_GRACE_MS);
      this._graceTimers.set(playerId, timer);
    }
    return true;
  }

  /** 立即移除玩家（主动离开或宽限期结束）。
   * @param {string} playerId - 玩家 id。
   * @param {string} reason - 移除原因（leave / grace-expired）。
   * @returns {object|null} 被移除的玩家对象，不存在时返回 null。
   */
  removePlayer(playerId, reason) {
    const player = this.players.get(playerId);
    if (!player) return null;
    // 1. 清理宽限定时器。
    const timer = this._graceTimers.get(playerId);
    if (timer) {
      clearTimeout(timer);
      this._graceTimers.delete(playerId);
    }
    // 2. 从成员表删除并通知子类处理座位回收。
    this.players.delete(playerId);
    this.touch();
    this.onPlayerRemoved(player, reason);
    return player;
  }

  /**
   * 校验重连凭据。
   *
   * @param {string} playerId - 玩家 id。
   * @param {string} reconnectToken - 重连令牌。
   * @returns {object|null} 校验通过返回玩家对象，否则 null。
   */
  verifyReconnect(playerId, reconnectToken) {
    if (typeof playerId !== "string" || typeof reconnectToken !== "string") return null;
    const player = this.players.get(playerId);
    if (!player) return null;
    // 1. 常量时间比较，避免时序侧信道。
    const a = Buffer.from(player.reconnectToken);
    const b = Buffer.from(reconnectToken);
    if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return null;
    return player;
  }

  /** 房间是否已无任何玩家（含断线宽限中的玩家）。 */
  isEmpty() {
    return this.players.size === 0;
  }

  /** 房间是否已无在线连接。 */
  hasNoConnectedPlayers() {
    for (const player of this.players.values()) {
      if (player.connected) return false;
    }
    return true;
  }

  /** 刷新房间活跃时间（任何成员/状态变化时调用）。 */
  touch() {
    this.updatedAt = Date.now();
  }

  /** 向房间内所有在线玩家广播消息。
   * @param {object} message - 已封装的信封消息。
   * @param {string} [exceptPlayerId] - 排除的玩家 id。
   */
  broadcast(message, exceptPlayerId) {
    for (const player of this.players.values()) {
      if (!player.connected || !player.conn) continue;
      if (exceptPlayerId && player.playerId === exceptPlayerId) continue;
      player.conn.send(message);
    }
  }

  /**
   * 房间快照（协议下发用，create/join/reconnect 的响应负载）。
   *
   * 默认实现只包含房间成员信息，适用于纯转发房；权威游戏房（如 GomokuRoom）
   * 覆写本方法，在快照里追加自己的对局状态。
   *
   * @returns {{room: object}} 快照对象，room 为 describe() 的结果。
   */
  snapshot() {
    // 1. 转发房没有服务端游戏状态，只回成员信息。
    return { room: this.describe() };
  }

  /** 房间概要信息（成员列表等，随 room.snapshot 下发）。
   * @returns {object} roomId/gameType/status/players 列表。
   */
  describe() {
    return {
      roomId: this.roomId,
      gameType: this.gameType,
      status: this.status,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
      players: [...this.players.values()].map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        role: p.role || "member",
        connected: p.connected,
      })),
    };
  }

  /**
   * 子类钩子：玩家被移除后的善后（回收座位、广播等）。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因。
   */
  onPlayerRemoved(player, reason) {
    /* 默认无操作，子类按需覆盖 */
  }
}

module.exports = { RoomBase, createPlayerId, createReconnectToken };
