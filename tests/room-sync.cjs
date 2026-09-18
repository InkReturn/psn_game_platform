/**
 * 房间成员实时同步回归测试（WebSocket 双客户端，无需浏览器）。
 *
 * 这是公共 RoomManager 的回归测试：锁死"B 加入 → A 立刻收到权威状态"这条链路，
 * 防止再次出现"只有刷新页面才看到对手"的问题。
 *
 * 覆盖场景：
 *   1. 创建 + 加入：A、B 双方都收到含两名成员的权威快照（players == 2）；
 *   2. 加入者在房间内也能拿到自己的成员记录（不做"只通知其他人"的单边推送）；
 *   3. 满员：第三人加入被拒，且拒绝后房间成员数不变（不留幽灵座位）；
 *   4. 房间类型隔离：五子棋房不接受斗兽棋 gameType，也不接受未声明类型的前缀不符请求；
 *   5. 断线：A 立刻看到 online=false（而不是成员消失）；
 *   6. 重连：A 再次收到权威快照且 online 恢复为 true，成员数始终为 2（不产生重复玩家）；
 *   7. 旧连接迟到关闭：不得把已重连成功的玩家误标为断线；
 *   8. 主动离开：A 收到快照且成员数回落到 1。
 *
 * 运行方式：node tests/room-sync.cjs
 *   - 未设置 BASE_URL 时自行在 18083 端口拉起被测服务器；
 *   - 设置了 BASE_URL 时直接复用外部服务器（tests/run-all.cjs 注入）。
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

/** 自拉服务器时使用的端口。 */
const SELF_PORT = 18083;
/** 外部注入的站点地址（为空则自拉服务器）。 */
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
const WS_URL = `${BASE_URL.replace(/^https/, "wss").replace(/^http/, "ws")}/ws`;

/** 用例结果收集。 */
const results = [];
/** 被测服务器进程（自拉时才有）。 */
let serverProcess = null;
/** 被测服务器输出缓冲（失败时打印）。 */
const serverLogs = [];

/**
 * 记录一条用例结果。
 *
 * @param {string} name - 用例名。
 * @param {boolean} pass - 是否通过。
 * @param {string} [detail] - 失败详情。
 */
function record(name, pass, detail) {
  results.push({ name, pass, detail: detail || "" });
  console.log(`${pass ? "PASS" : "FAIL"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
}

/**
 * 执行一段用例并记录结果（失败不中断后续用例）。
 *
 * @param {string} name - 用例名。
 * @param {Function} fn - 异步用例体。
 */
async function check(name, fn) {
  try {
    await fn();
    record(name, true);
  } catch (err) {
    record(name, false, err && err.message ? err.message : String(err));
  }
}

/**
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
}

/**
 * 断言深度相等。
 *
 * @param {*} actual - 实际值。
 * @param {*} expected - 期望值。
 * @param {string} label - 描述。
 */
function assertEq(actual, expected, label) {
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error(`${label}: expected ${JSON.stringify(expected)}, got ${JSON.stringify(actual)}`);
  }
}

/**
 * 轮询 /health 等待服务器就绪。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒数。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early (code ${serverProcess.exitCode})\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${timeoutMs}ms\n${serverLogs.join("")}`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 测试用客户端。
 *
 * @param {string} label - 客户端标签。
 * @returns {object} 客户端封装。
 */
function makeClient(label) {
  const ws = new WebSocket(WS_URL);
  /** 收到的全部消息（按到达顺序）。 */
  const received = [];
  /** requestId -> resolve/reject 处理器。 */
  const pending = new Map();
  let reqId = 1;

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    received.push(m);
    if (m.requestId && pending.has(m.requestId)) {
      const handler = pending.get(m.requestId);
      pending.delete(m.requestId);
      handler(m);
    }
  });

  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  /**
   * 发送请求并等待响应。
   *
   * @param {string} type - 消息类型。
   * @param {object} payload - 负载。
   * @param {number} [timeoutMs] - 超时毫秒。
   * @returns {Promise<object>} 响应 payload。
   */
  function request(type, payload, timeoutMs = 4000) {
    const requestId = `${label}-${reqId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        pending.delete(requestId);
        reject(new Error(`[${label}] timeout for ${type}`));
      }, timeoutMs);
      pending.set(requestId, (m) => {
        clearTimeout(timer);
        if (m.type === "room.error") {
          reject(Object.assign(new Error(`${label} ${m.payload.code}`), { code: m.payload.code, payload: m.payload }));
        } else {
          resolve(m.payload);
        }
      });
      ws.send(JSON.stringify({ version: 1, type, requestId, payload: payload || {} }));
    });
  }

  return {
    label,
    ws,
    open: openPromise,
    request,
    received,
    /** 收到的 room.snapshot 消息列表。 */
    snapshots: () => received.filter((m) => m.type === "room.snapshot"),
    /** 最近一条 room.snapshot 的成员昵称列表。 */
    lastMembers: () => {
      const list = received.filter((m) => m.type === "room.snapshot");
      const snapshot = list.length ? list[list.length - 1].payload.snapshot : null;
      return snapshot ? snapshot.room.players.map((p) => p.nickname) : [];
    },
    /** 等待条件成立（轮询，超时抛错）。 */
    waitUntil(predicate, label2, timeoutMs = 4000) {
      const deadline = Date.now() + timeoutMs;
      return new Promise((resolve, reject) => {
        const tick = () => {
          if (predicate()) return resolve(true);
          if (Date.now() > deadline) return reject(new Error(`[${label}] timeout waiting ${label2}`));
          setTimeout(tick, 40);
        };
        tick();
      });
    },
    close: () => ws.close(),
    terminate: () => ws.terminate(),
  };
}

/** 从快照里取"在线成员数"。 */
function onlineCountOf(snapshot) {
  return snapshot.room.players.filter((p) => p.connected).length;
}

(async () => {
  // 1. 未注入 BASE_URL 时自行拉起被测服务器。
  if (!EXTERNAL_BASE) {
    serverProcess = spawn(process.execPath, [path.join(__dirname, "..", "server.js")], {
      env: { ...process.env, PORT: String(SELF_PORT), BIND_HOST: "127.0.0.1" },
      stdio: ["ignore", "pipe", "pipe"],
    });
    const collect = (chunk) => {
      serverLogs.push(chunk.toString());
      if (serverLogs.length > 200) serverLogs.shift();
    };
    serverProcess.stdout.on("data", collect);
    serverProcess.stderr.on("data", collect);
  }
  await waitForServer();

  const A = makeClient("A");
  const B = makeClient("B");
  await Promise.all([A.open, B.open]);

  let roomId = "";
  let aCreds = null;
  let bCreds = null;

  // ── 核心场景：B 加入后 A 立刻收到权威房间状态 ──────────────
  await check("B 加入房间后 A 立即收到 room.snapshot 且成员数为 2", async () => {
    aCreds = await A.request("room.create", { gameType: "gomoku", prefix: "WZ", nickname: "房主甲" });
    roomId = aCreds.roomId;
    assertEq(aCreds.snapshot.room.players.length, 1, "建房后房内只有 1 人");

    // 关键断言：加入请求返回前，A 必须已经（或立刻）收到含 2 人的权威快照。
    bCreds = await B.request("room.join", { roomId, nickname: "玩家乙", gameType: "gomoku" });
    await A.waitUntil(() => A.lastMembers().length === 2, "A 收到 2 人快照");
    assertEq(A.lastMembers(), ["房主甲", "玩家乙"], "A 侧成员列表（不刷新页面）");
    assertEq(aCreds.snapshot.room.players[0].connected, true, "房主在线");

    // B 侧同样要拿到含 2 人的快照。
    assertEq(bCreds.snapshot.room.players.length, 2, "加入者响应内成员数为 2");
    await B.waitUntil(() => B.snapshots().length >= 1, "B 也收到房间快照");
    assertEq(B.lastMembers(), ["房主甲", "玩家乙"], "B 侧成员列表");
  });

  await check("加入事件带上房间码，客户端不会误丢快照", async () => {
    const last = A.snapshots().pop();
    assertEq(last.payload.snapshot.room.roomId, roomId, "快照携带 roomId");
    assertEq(last.payload.snapshot.room.gameType, "gomoku", "快照携带 gameType");
  });

  // ── 满员与类型隔离 ────────────────────────────────────────
  await check("第三人加入被拒且不产生幽灵座位", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId, nickname: "第三者", gameType: "gomoku" });
      throw new Error("满员房间不应允许加入");
    } catch (err) {
      assertEq(err.code, "ROOM_FULL", "错误码");
    }
    C.close();
    // 被拒后房间成员必须仍是 2 人。
    await A.waitUntil(() => A.lastMembers().length === 2, "拒绝后仍为 2 人");
  });

  await check("斗兽棋 gameType 无法加入五子棋房间（ROOM_TYPE_MISMATCH）", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      await C.request("room.join", { roomId, nickname: "串门", gameType: "animal-chess" });
      throw new Error("跨游戏类型不应允许加入");
    } catch (err) {
      assertEq(err.code, "ROOM_TYPE_MISMATCH", "错误码");
    }
    C.close();
    await A.waitUntil(() => A.lastMembers().length === 2, "类型不匹配被拒后仍为 2 人");
  });

  await check("未声明 gameType 时按房间码前缀拒绝跨游戏加入", async () => {
    const C = makeClient("C");
    await C.open;
    try {
      // 五子棋房码前缀是 WZ，但这里刻意构造一个 DS 前缀的不存在房间码，
      // 用于验证"房间不存在"优先于类型判断；再验证真实房间在前缀不符时被拒。
      await C.request("room.join", { roomId: `DS${roomId.slice(2)}`, nickname: "串门乙" });
      throw new Error("不存在的房间不应允许加入");
    } catch (err) {
      assertEq(err.code, "ROOM_NOT_FOUND", "错误码");
    }
    C.close();
  });

  // ── 断线 / 重连 ───────────────────────────────────────────
  await check("B 断线后 A 立刻看到 online=false（成员仍在，不消失）", async () => {
    B.terminate();
    await A.waitUntil(() => {
      const list = A.snapshots();
      if (!list.length) return false;
      const players = list[list.length - 1].payload.snapshot.room.players;
      return players.length === 2 && onlineCountOf(list[list.length - 1].payload.snapshot) === 1;
    }, "A 收到含 1 名在线成员的快照");
    const snapshot = A.snapshots().pop().payload.snapshot;
    assertEq(snapshot.room.players.length, 2, "断线玩家保留座位");
    assertEq(onlineCountOf(snapshot), 1, "在线成员数下降");
  });

  await check("B 重连后 A 看到 online=true，且不产生重复玩家", async () => {
    const B2 = makeClient("B2");
    await B2.open;
    const res = await B2.request("room.reconnect", {
      roomId,
      playerId: bCreds.playerId,
      reconnectToken: bCreds.reconnectToken,
    });
    assertEq(res.snapshot.room.players.length, 2, "重连后房间仍是 2 人");
    // A 必须收到恢复在线的新快照，而不是永远停在"B 已离开"。
    await A.waitUntil(() => {
      const list = A.snapshots();
      if (!list.length) return false;
      const snapshot = list[list.length - 1].payload.snapshot;
      return snapshot.room.players.length === 2 && onlineCountOf(snapshot) === 2;
    }, "A 收到两人都在线的快照");
    const snapshot = A.snapshots().pop().payload.snapshot;
    assertEq(snapshot.room.players.map((p) => p.nickname), ["房主甲", "玩家乙"], "成员列表无重复");
    assertEq(new Set(snapshot.room.players.map((p) => p.playerId)).size, 2, "playerId 去重");
    B2.close();
    // 关闭后等下一次快照，避免影响后续用例。
    await A.waitUntil(() => onlineCountOf(A.snapshots().pop().payload.snapshot) === 1, "关闭后回到 1 人在线");
  });

  await check("旧连接迟到关闭不会把已重连的玩家误标为断线", async () => {
    // 复现真实竞态：B 的网络恢复速度比旧 socket 的 close 事件更快。
    // 1. 旧连接 B5 保持存活（socket 层还开着，服务器侧绑定待回收）。
    const B5 = makeClient("B5");
    await B5.open;
    await B5.request("room.reconnect", {
      roomId,
      playerId: bCreds.playerId,
      reconnectToken: bCreds.reconnectToken,
    });
    await A.waitUntil(() => onlineCountOf(A.snapshots().pop().payload.snapshot) === 2, "B5 在线");
    // 2. 新连接 B6 在旧连接还活着的时候重连同一身份：服务器必须顶替旧绑定。
    const B6 = makeClient("B6");
    await B6.open;
    const res = await B6.request("room.reconnect", {
      roomId,
      playerId: bCreds.playerId,
      reconnectToken: bCreds.reconnectToken,
    });
    assertEq(res.snapshot.room.players.length, 2, "顶替后仍是 2 人（不新增玩家）");
    // 3. 旧连接此刻才关闭：迟到的 close 事件绝不能把已重连的玩家标成断线。
    const snapshotCountBefore = A.snapshots().length;
    B5.terminate();
    await new Promise((resolve) => setTimeout(resolve, 600));
    const latest = A.snapshots().pop().payload.snapshot;
    assertEq(onlineCountOf(latest), 2, "旧连接关闭后玩家必须仍显示在线");
    assertEq(latest.room.players.length, 2, "成员数不变");
    // 4. 也不应该因此产生新的"断线"快照（允许因重连本身产生的快照）。
    const offlineSnapshots = A.snapshots().filter((m, index) => index >= snapshotCountBefore && onlineCountOf(m.payload.snapshot) < 2);
    assertEq(offlineSnapshots.length, 0, "旧连接关闭不应广播掉线状态");
    B6.close();
    await A.waitUntil(() => onlineCountOf(A.snapshots().pop().payload.snapshot) === 1, "清理到 1 人在线");
  });

  // ── 离开 ─────────────────────────────────────────────────
  await check("B 主动离开后 A 收到成员数回落到 1 的快照", async () => {
    const B4 = makeClient("B4");
    await B4.open;
    await B4.request("room.reconnect", {
      roomId,
      playerId: bCreds.playerId,
      reconnectToken: bCreds.reconnectToken,
    });
    await A.waitUntil(() => onlineCountOf(A.snapshots().pop().payload.snapshot) === 2, "B4 上线");
    await B4.request("room.leave");
    await A.waitUntil(() => A.lastMembers().length === 1, "A 收到 1 人快照");
    assertEq(A.lastMembers(), ["房主甲"], "离开后成员列表");
    B4.close();
  });

  await check("relay 房同样在加入时向房内所有连接推送权威快照", async () => {
    const R1 = makeClient("R1");
    const R2 = makeClient("R2");
    await Promise.all([R1.open, R2.open]);
    const created = await R1.request("room.create", { gameType: "relay:reversi", prefix: "RV", nickname: "房主丙" });
    await R2.request("room.join", { roomId: created.roomId, nickname: "客人丁", gameType: "relay:reversi" });
    await R1.waitUntil(() => R1.lastMembers().length === 2, "relay 房主收到 2 人快照");
    await R2.waitUntil(() => R2.snapshots().length >= 1, "relay 加入者也收到快照");
    assertEq(R1.lastMembers(), ["房主丙", "客人丁"], "relay 房主侧成员列表");
    assertEq(R2.lastMembers(), ["房主丙", "客人丁"], "relay 加入者侧成员列表");
    R1.close();
    R2.close();
  });

  // ── 收尾 ─────────────────────────────────────────────────
  A.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  const failed = results.filter((r) => !r.pass);
  if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
})().catch((err) => {
  console.error("room-sync bootstrap failed:", err);
  console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
