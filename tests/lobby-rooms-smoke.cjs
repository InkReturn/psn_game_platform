/**
 * 大厅房间列表协议测试（WS 直连，无需浏览器）。
 *
 * 覆盖 lobby.listRooms 协议与房间摘要：
 * - 建房带 roomName → 列表返回房名/房主/人数/状态；
 * - 建房缺省 roomName → 列表回退"{房主昵称}的房间"；
 * - gameType 过滤：gomoku 列表不含其他游戏的房间；
 * - 第二连接加入后人数变化，离开后房间从列表消失；
 * - 对局开始后 status 从 waiting 变为 playing（用井字棋 start 验证）；
 * - 未知 gameType 的列表查询返回空数组（不报错）。
 *
 * 运行方式：node tests/lobby-rooms-smoke.cjs（未设置 BASE_URL 时自行拉起隔离服务器）。
 */
"use strict";

const { spawn } = require("child_process");
const path = require("path");
const WebSocket = require("ws");

/** 自拉服务器端口与地址。 */
const SELF_PORT = 18202;
const EXTERNAL_BASE = process.env.BASE_URL || "";
const BASE_URL = EXTERNAL_BASE || `http://127.0.0.1:${SELF_PORT}`;
const BASE_WS = EXTERNAL_BASE ? BASE_URL.replace(/^http/, "ws") + "/ws" : `ws://127.0.0.1:${SELF_PORT}/ws`;

/** 测试结果收集。 */
const results = [];
let serverProcess = null;
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
  console.log(`${pass ? "PASS" : "fail"}  ${name}${detail && !pass ? ` — ${detail}` : ""}`);
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
 * 断言为真。
 *
 * @param {*} condition - 断言表达式结果。
 * @param {string} label - 描述。
 */
function assert(condition, label) {
  if (!condition) throw new Error(label);
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
 * 轮询 /health 等待服务器就绪。
 *
 * @param {number} [timeoutMs] - 最长等待毫秒。
 * @returns {Promise<void>} 就绪后 resolve。
 */
async function waitForServer(timeoutMs = 20000) {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    if (serverProcess && serverProcess.exitCode !== null) {
      throw new Error(`server exited early with code ${serverProcess.exitCode}\n${serverLogs.join("")}`);
    }
    try {
      const res = await fetch(`${BASE_URL}/health`);
      const body = await res.json();
      if (body.status === "ok") return;
    } catch {
      /* 尚未监听，继续重试 */
    }
    if (Date.now() > deadline) throw new Error(`server not ready after ${timeoutMs}ms`);
    await new Promise((resolve) => setTimeout(resolve, 150));
  }
}

/**
 * 测试用 WS 客户端封装（requestId 关联请求响应）。
 *
 * @param {string} [label] - 客户端标签。
 * @returns {object} {open, request, close}。
 */
function makeClient(label) {
  const ws = new WebSocket(BASE_WS);
  const pendingReqs = new Map();
  let reqId = 1;

  const openPromise = new Promise((resolve, reject) => {
    ws.on("open", resolve);
    ws.on("error", reject);
  });

  ws.on("message", (data) => {
    const m = JSON.parse(data.toString());
    if (m.requestId && pendingReqs.has(m.requestId)) {
      const fn = pendingReqs.get(m.requestId);
      pendingReqs.delete(m.requestId);
      fn(m);
    }
  });

  /**
   * 发送请求并等待带 requestId 的响应。
   *
   * @param {string} type - 请求类型。
   * @param {object} payload - 负载。
   * @returns {Promise<object>} 响应 payload。
   */
  function request(type, payload) {
    const requestId = `t${reqId++}`;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error(`[${label}] no response for ${type}`)), 4000);
      pendingReqs.set(requestId, (m) => {
        clearTimeout(timer);
        if (m.type === "room.error") reject(Object.assign(new Error(m.payload.code), { code: m.payload.code }));
        else resolve(m.payload);
      });
      ws.send(JSON.stringify({ version: 1, type, requestId, payload: payload || {} }));
    });
  }

  return { open: openPromise, request, close: () => ws.close(), label };
}

/**
 * 从 lobby.listRooms 响应中取指定房间摘要。
 *
 * @param {object} client - WS 客户端。
 * @param {string} gameType - 过滤的游戏类型。
 * @param {string} roomId - 目标房间码。
 * @returns {Promise<object|null>} 房间摘要；不存在返回 null。
 */
async function findRoom(client, gameType, roomId) {
  const res = await client.request("lobby.listRooms", { gameType });
  return (res.rooms || []).find((r) => r.roomId === roomId) || null;
}

/** 测试主流程。
 * @returns {Promise<void>} 全部用例执行完 resolve。
 */
async function main() {
  // 1. 未注入 BASE_URL 时自行拉起隔离服务器。
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

  // 2. 观察者：一个专门查列表的连接。
  const observer = makeClient("observer");
  await observer.open;

  // 2.1 建房带房名 → 摘要字段齐全。
  const host = makeClient("host");
  await host.open;
  const created = await host.request("room.create", {
    gameType: "gomoku",
    prefix: "WZ",
    nickname: "房主小明",
    roomName: "周末棋局",
  });
  let summary = null;
  await check("建房带房名后列表返回完整摘要", async () => {
    summary = await findRoom(observer, "gomoku", created.roomId);
    assert(summary, "gomoku 列表应包含新房间");
    assertEq(summary.roomName, "周末棋局", "房间名");
    assertEq(summary.roomId, created.roomId, "房间码");
    assertEq(summary.gameType, "gomoku", "游戏类型");
    assertEq(summary.players, 1, "建房后人数");
    assertEq(summary.onlinePlayers, 1, "建房后在线人数");
    assertEq(summary.maxPlayers, 2, "五子棋最大人数");
    assertEq(summary.status, "waiting", "建房后状态");
    assertEq(summary.hostNickname, "房主小明", "房主昵称");
    assert(typeof summary.createdAt === "number", "创建时间应为数字");
  });

  // 2.2 建房缺省房名 → 回退"{房主昵称}的房间"。
  const host2 = makeClient("host2");
  await host2.open;
  const created2 = await host2.request("room.create", {
    gameType: "gomoku",
    prefix: "WZ",
    nickname: "小红",
  });
  await check("建房缺省房名回退为房主昵称房间", async () => {
    const s2 = await findRoom(observer, "gomoku", created2.roomId);
    assert(s2, "缺省房名房间应出现在列表");
    assertEq(s2.roomName, "小红的房间", "缺省房间名");
  });

  // 2.3 gameType 过滤：gomoku 列表不含井字棋房；井字棋列表只含井字棋房。
  const tttHost = makeClient("tttHost");
  await tttHost.open;
  const tttCreated = await tttHost.request("room.create", {
    gameType: "tictactoe",
    prefix: "JZ",
    nickname: "井字房东",
  });
  await check("gameType 过滤：列表互不串台", async () => {
    const gomokuRooms = (await observer.request("lobby.listRooms", { gameType: "gomoku" })).rooms;
    assert(!gomokuRooms.some((r) => r.roomId === tttCreated.roomId), "gomoku 列表不应包含井字棋房");
    assert(gomokuRooms.some((r) => r.roomId === created.roomId), "gomoku 列表应包含五子棋房");
    const tttRooms = (await observer.request("lobby.listRooms", { gameType: "tictactoe" })).rooms;
    assertEq(tttRooms.length, 1, "井字棋列表房间数");
    assertEq(tttRooms[0].roomId, tttCreated.roomId, "井字棋列表房间码");
  });

  // 2.4 第二人加入 → 人数 2；离开 → 人数回落（五子棋两人到齐即自动开局，状态转 playing）。
  await check("加入后人数与状态变化、离开后人数回落", async () => {
    const guest = makeClient("guest");
    await guest.open;
    await guest.request("room.join", { roomId: created.roomId, nickname: "访客小刚", gameType: "gomoku" });
    const joined = await findRoom(observer, "gomoku", created.roomId);
    assertEq(joined.players, 2, "加入后人数");
    assertEq(joined.onlinePlayers, 2, "加入后在线人数");
    assertEq(joined.status, "playing", "五子棋两人到齐自动开局，状态应为 playing");
    await guest.request("room.leave", {});
    const afterLeave = await findRoom(observer, "gomoku", created.roomId);
    assertEq(afterLeave.players, 1, "离开后人数");
    guest.close();
  });

  // 2.5 对局开始后状态变 playing（井字棋 start 动作）。
  await check("开局后状态变为 playing", async () => {
    const guest = makeClient("tttGuest");
    await guest.open;
    await guest.request("room.join", { roomId: tttCreated.roomId, nickname: "井字房客", gameType: "tictactoe" });
    await tttHost.request("game.action", { action: "start" });
    const playing = await findRoom(observer, "tictactoe", tttCreated.roomId);
    assertEq(playing.status, "playing", "开局后状态");
    guest.close();
  });

  // 2.6 未知 gameType 列表为空数组（不报错）；空 gameType 返回全部房间。
  await check("未知类型空列表、空类型返回全部", async () => {
    const empty = await observer.request("lobby.listRooms", { gameType: "no-such-game" });
    assertEq(empty.rooms, [], "未知类型应返回空数组");
    const all = await observer.request("lobby.listRooms", {});
    assert(all.rooms.length >= 3, `全量列表应至少包含 3 间房，实际 ${all.rooms.length}`);
    const roomIds = new Set(all.rooms.map((r) => r.roomId));
    assert(roomIds.has(created.roomId) && roomIds.has(created2.roomId) && roomIds.has(tttCreated.roomId), "全量列表应包含全部测试房");
  });

  // 2.7 房名超长被截断到 20 字符。
  await check("超长房名截断到 20 字符", async () => {
    const longHost = makeClient("longHost");
    await longHost.open;
    const longName = "超".repeat(30);
    const longCreated = await longHost.request("room.create", {
      gameType: "gomoku",
      prefix: "WZ",
      nickname: " 房名超长 ",
      roomName: longName,
    });
    const s = await findRoom(observer, "gomoku", longCreated.roomId);
    assertEq(s.roomName.length, 20, "房名应截断为 20 字符");
    longHost.close();
  });

  // 3. 收尾。
  observer.close();
  host.close();
  host2.close();
  tttHost.close();
  if (serverProcess) {
    serverProcess.kill("SIGTERM");
    await new Promise((resolve) => setTimeout(resolve, 300));
  }

  // 4. 汇总退出码。
  const failed = results.filter((r) => !r.pass);
  if (failed.length) console.error(`\n--- server output ---\n${serverLogs.join("")}`);
  console.log(`\n${results.length - failed.length}/${results.length} passed`);
  process.exit(failed.length ? 1 : 0);
}

main().catch((err) => {
  console.error("lobby rooms smoke failed:", err);
  if (serverProcess) serverProcess.kill("SIGKILL");
  process.exit(1);
});
