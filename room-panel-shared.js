/**
 * 房间面板共用工具（浏览器端）。
 *
 * 被 gomoku-net.js（五子棋权威房面板）与 room-common.js（各游戏 relay 房面板）共用，
 * 只做两件事：把服务器下发的权威快照归一化成渲染用的成员表，以及渲染成员列表。
 * 保证"服务端广播 → 客户端状态 → UI"这条链在两个面板里是同一套实现，不再各写一份。
 */
(function () {
  "use strict";

  /**
   * 把服务器快照里的成员列表归一化成 {id, name, role, host, connected} 数组。
   *
   * @param {object} roomInfo - 服务器快照的 room 部分（room.describe()）。
   * @returns {Array<object>} 成员数组；roomInfo 非法时返回空数组。
   */
  function normalizeMembers(roomInfo) {
    if (!roomInfo || !Array.isArray(roomInfo.players)) return [];
    return roomInfo.players.map((p) => ({
      id: p.playerId,
      name: p.nickname,
      role: p.role || "member",
      host: Boolean(p.host),
      connected: Boolean(p.connected),
    }));
  }

  /**
   * 渲染成员列表 DOM。
   *
   * 每个成员一行，显示昵称、角色徽标与连接状态；断线成员保持可见但标注"掉线中"，
   * 这样对手刷新页面时房主看到的是"掉线中"而不是"消失了"，重连后再变回"在线"。
   *
   * @param {HTMLElement|null} container - 列表容器（通常 <ul>）。
   * @param {Array<object>} members - normalizeMembers 的输出。
   * @param {string} selfId - 本地玩家 id（用于标注"我"）。
   */
  function renderMembers(container, members, selfId) {
    if (!container) return;
    // 1. 每次全量重建：成员列表很短，重建比分块 diff 更不容易出错。
    container.innerHTML = "";
    if (!members.length) {
      const empty = document.createElement("li");
      empty.className = "member-empty";
      empty.textContent = "暂无成员";
      container.appendChild(empty);
      return;
    }
    // 2. 逐个成员渲染。
    members.forEach((member) => {
      const item = document.createElement("li");
      item.className = "member-item";
      item.dataset.playerId = member.id;
      item.dataset.connected = String(member.connected);

      const dot = document.createElement("span");
      dot.className = `member-dot ${member.connected ? "online" : "offline"}`;
      dot.setAttribute("aria-hidden", "true");
      item.appendChild(dot);

      const name = document.createElement("span");
      name.className = "member-name";
      name.textContent = member.id === selfId ? `${member.name}（我）` : member.name;
      item.appendChild(name);

      if (member.host) {
        const badge = document.createElement("span");
        badge.className = "member-badge";
        badge.textContent = "房主";
        item.appendChild(badge);
      }

      const state = document.createElement("span");
      state.className = `member-state ${member.connected ? "online" : "offline"}`;
      state.textContent = member.connected ? "在线" : "掉线中";
      item.appendChild(state);

      container.appendChild(item);
    });
  }

  /**
   * 组装房间状态栏文案。
   *
   * @param {object} params - 入参。
   * @param {string} params.roomId - 房间码（空表示未进房）。
   * @param {string} params.online - "idle" | "connecting" | "reconnecting" | "online" | "error"。
   * @param {number} params.playerCount - 房间内成员总数。
   * @param {number} params.onlineCount - 其中在线的成员数。
   * @param {boolean} params.isHost - 本地玩家是否是房主。
   * @param {boolean} [params.gameReady] - 对局是否已开始（决定文案是"等待对手"还是"对局进行中"）。
   * @returns {string} 用户可读的中文状态文案。
   */
  function roomStatusText(params) {
    const { roomId, online, playerCount, onlineCount, isHost, gameReady } = params || {};
    if (!roomId) return "未进入房间";
    if (online === "error") return "连接断开，重试中";
    if (online === "connecting") return "连接中";
    if (online === "reconnecting") return "恢复身份中";
    // 1. 两人（或以上）都在线：绝对不能再说"等待加入"。
    const opponentReady = onlineCount >= 2;
    if (gameReady && opponentReady) return "对局进行中";
    if (opponentReady) return "对手已加入";
    if (playerCount > 1) return "对手掉线中";
    return isHost ? "房间已创建，等待加入" : "已加入，等待对手";
  }

  window.LinkPlayRoomPanel = { normalizeMembers, renderMembers, roomStatusText };
})();
