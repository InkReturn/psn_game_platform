/**
 * 通用转发（relay）房间。
 *
 * 服务于已接入 room-common.js 的其他在线小游戏：服务器负责房间成员管理、
 * 断线状态与消息转发；游戏状态本身仍由房主客户端权威（快照广播模型），
 * 与改造前的 Supabase Realtime 行为等价，仅传输层切换到自建 WebSocket。
 */
"use strict";

const { RoomBase } = require("./room-base");
const { makeMessage } = require("../protocol/messages");
const { MAX_NICKNAME_LENGTH } = require("../config");

/** relay 房间成员上限：宽松限制，覆盖 2-6 人小游戏与少量观战。 */
const RELAY_MAX_PLAYERS = 8;

class RelayRoom extends RoomBase {
  /**
   * @param {string} roomId - 8 位房间码。
   * @param {string} gameType - "relay:<gameKey>"。
   */
  constructor(roomId, gameType) {
    super(roomId, gameType);
    this.maxPlayers = RELAY_MAX_PLAYERS;
    this.status = "open";
  }

  /**
   * 玩家入座（relay 房不区分颜色座位，host/guest 仅为角色标签）。
   *
   * @param {object} player - 已登记的 player 对象。
   * @param {"host"|"guest"} role - 第一个进入者为 host。
   */
  seatPlayer(player, role) {
    // 1. 房间创建者标记 host，其余加入者标记 guest（由 RoomManager 保证语义）。
    player.role = role === "host" ? "host" : "guest";
    this.touch();
  }

  /**
   * 转发客户端消息给房内其他玩家。
   *
   * @param {object} player - 发送者。
   * @param {object} payload - {event:string, data:object, targetId?:string}。
   */
  relay(player, payload) {
    // 1. 基本校验：必须有 event 名且长度受限。
    if (typeof payload.event !== "string" || !payload.event || payload.event.length > 64) return;
    // 2. 定向消息只发给 targetId 对应玩家，否则广播给其他所有人。
    const message = makeMessage("relay.message", {
      senderId: player.playerId,
      senderRole: player.role,
      senderName: player.nickname,
      event: payload.event,
      data: payload.data === undefined ? null : payload.data,
    });
    if (payload.targetId) {
      const target = this.players.get(String(payload.targetId));
      if (target && target.connected && target.conn) target.conn.send(message);
      return;
    }
    this.broadcast(message, player.playerId);
  }

  /**
   * 玩家被移除后的善后：通知剩余玩家。
   *
   * @param {object} player - 被移除的玩家。
   * @param {string} reason - 移除原因。
   */
  onPlayerRemoved(player, reason) {
    // 1. 广播离开事件，附带最新成员快照，便于客户端更新成员列表。
    this.broadcast(
      makeMessage("room.player_left", {
        playerId: player.playerId,
        nickname: player.nickname,
        reason,
        snapshot: { room: this.describe() },
      }),
    );
  }

  /**
   * 玩家断线通知。
   *
   * @param {object} player - 断线玩家。
   */
  onPlayerDisconnected(player) {
    this.broadcast(
      makeMessage("room.player_disconnected", { playerId: player.playerId, nickname: player.nickname, snapshot: { room: this.describe() } }),
      player.playerId,
    );
  }
}

module.exports = { RelayRoom };
