/**
 * 房间成员管理基类。
 *
 * 提供玩家加入/断线/重连/移除的通用机制（含断线宽限计时），
 * 具体游戏逻辑（gomoku 权威对局）或消息转发逻辑（relay 房间）由子类实现。
 */
"use strict";

const crypto = require("crypto");
const { DISCONNECT_GRACE_MS, RECONNECT_TOKEN_BYTES } = require("../config");
const { makeMessage } = require("../protocol/messages");

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
   * @param {{host?: boolean}} [options] - host 为 true 时标记为房主（房间创建者）。
   * @returns {object} player 对象。
   */
  createPlayer(nickname, options = {}) {
    const player = {
      playerId: createPlayerId(),
      nickname,
      reconnectToken: createReconnectToken(),
      conn: null,
      /** 被本次绑定顶替的旧连接（用于忽略迟到的 close 事件）。 */
      previousConn: null,
      connected: false,
      disconnectedAt: null,
      joinedAt: Date.now(),
      /** 房主标记：独立于座位角色，换先后不变。 */
      host: Boolean(options.host),
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
    // 2. 记录被顶替的旧连接：同一玩家在新连接上重连时，旧 socket 的 close 事件
    //    可能晚于本次绑定到达，若不记账会让 onDisconnect 把在线玩家误标为断线。
    player.previousConn = player.conn && player.conn !== conn ? player.conn : null;
    // 3. 绑定连接并更新状态。
    player.conn = conn;
    player.connected = true;
    player.disconnectedAt = null;
    this.touch();
    return true;
  }

  /**
   * 玩家断线回调的凭证校验。
   *
   * 同一玩家可能存在两条 socket（刷新/切网络时旧连接尚未关闭）：只有仍然是
   * "当前绑定连接"的那条才允许把玩家标记为断线，被顶替的旧连接直接忽略。
   *
   * @param {string} playerId - 玩家 id。
   * @param {object} conn - 触发断线的连接封装。
   * @returns {boolean} true 表示该连接确实是当前连接，可以继续断线流程。
   */
  isCurrentConn(playerId, conn) {
    const player = this.players.get(playerId);
    if (!player) return false;
    return player.conn === conn;
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

  /**
   * 向房间内所有在线玩家广播消息。
   *
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
   * 个性化快照（协议下发用）。
   *
   * 有私有状态的房间（如斗地主/21点/德州：他人手牌、暗牌、牌堆不得下发）
   * 覆写本方法，按玩家返回各自可见的快照；默认与 snapshot() 相同。
   * 覆写方必须同时在构造器里设置 this.personalizedSnapshots = true，
   * 这样广播与加入/重连响应都会自动走个性化路径。
   *
   * @param {string} playerId - 玩家 id。
   * @returns {object} 该玩家可见的快照。
   */
  snapshotFor(playerId) {
    void playerId;
    return this.snapshot();
  }

  /**
   * 权威房间状态推送（房间同步的唯一出口）。
   *
   * 任何会影响房间成员/座位的状态变化（加入、离开、断线、重连、对局开始/结束、
   * 重新开局）都必须走本方法：服务端更新完权威状态后，立即把快照
   * `room.snapshot` 发给房间内所有在线连接（含触发者本人）。
   *
   * 为什么不能只依赖 room.player_joined 这类增量事件：
   * - 增量事件要求客户端自己推断"我该不该刷新"，一旦某个分支漏掉，UI 就会停在旧状态；
   * - 全量快照让客户端渲染层只做一件事——用最新快照覆盖本地只读镜像。
   *
   * @param {object} [context] - 事件语义，会放进 payload 并与快照一起下发。
   *   event: "player_joined" | "player_left" | "player_disconnected" | "player_reconnected"
   *          | "game_started" | "game_finished" | "game_restarted" | "room_created"
   *   其余字段原样透传（playerId / nickname / role 等，便于客户端做提示文案）。
   * @returns {object|null} 已广播的信封（个性化快照模式下返回 null，测试改为检查各客户端收到的消息）。
   */
  broadcastSnapshot(context) {
    // 1. 个性化快照：每个玩家只收到自己可见的数据（私有状态房间）。
    if (this.personalizedSnapshots) {
      for (const player of this.players.values()) {
        if (!player.connected || !player.conn) continue;
        player.conn.send(makeMessage("room.snapshot", { ...(context || {}), snapshot: this.snapshotFor(player.playerId) }));
      }
      return null;
    }
    // 2. 公共快照：所有连接收到同一份。
    const envelope = makeMessage("room.snapshot", { ...(context || {}), snapshot: this.snapshot() });
    this.broadcast(envelope);
    return envelope;
  }

  /**
   * 广播"事件 + 权威快照"两条消息。
   *
   * 统一房间同步原则：只要服务端权威 Room State 发生变化，就必须主动向房间内
   * 所有连接发送最新状态。本方法同时下发
   *   1. 具体事件（room.player_left / room.player_disconnected / ...），保留给需要
   *      "事件语义"的客户端分支（例如判断"离开的是不是我自己"）；
   *   2. room.snapshot 全量快照，作为客户端渲染的唯一权威数据源。
   * 两条消息都是幂等的状态覆盖，重复应用不会产生任何副作用。
   * 个性化快照模式下，每个玩家收到的事件与快照都只含自己可见的数据。
   *
   * @param {string} type - 事件消息类型。
   * @param {object} payload - 事件负载（会自动补上最新 snapshot）。
   * @returns {object|null} 实际下发的 room.snapshot 信封（个性化模式下返回 null）。
   */
  broadcastEventWithSnapshot(type, payload) {
    // 1. 个性化快照：逐玩家下发各自可见的事件 + 快照。
    if (this.personalizedSnapshots) {
      for (const player of this.players.values()) {
        if (!player.connected || !player.conn) continue;
        const snapshot = this.snapshotFor(player.playerId);
        player.conn.send(makeMessage(type, { ...(payload || {}), snapshot }));
        player.conn.send(makeMessage("room.snapshot", { ...(payload || {}), snapshot }));
      }
      return null;
    }
    // 2. 公共快照：同一份发给所有人。
    const merged = { ...(payload || {}), snapshot: this.snapshot() };
    this.broadcast(makeMessage(type, merged));
    return this.broadcastSnapshot(payload);
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
      maxPlayers: this.maxPlayers,
      players: [...this.players.values()].map((p) => ({
        playerId: p.playerId,
        nickname: p.nickname,
        role: p.role || "member",
        /** 房主标记独立于座位角色：换先后 role 会互换，host 不会。 */
        host: Boolean(p.host),
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
