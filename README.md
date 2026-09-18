# LinkPlay 小游戏平台（服务端化版）

一个自建服务器的多人小游戏平台：静态页面 + Node.js 权威房间服务，11 款游戏共用同一套
WebSocket 房间层。**不依赖任何第三方实时服务**（无 PeerJS、无 Supabase、无 WebRTC、无数据库）。

## 架构总览

```
浏览器 A ─┐                      ┌─ 静态资源（11 个游戏页面 + 大厅）
          ├─ HTTP(S) ── Nginx ──┤
浏览器 B ─┘                      └─ WS(S) /ws ── Node.js（Express + ws）
                                                    ├─ RoomManager  房间生命周期 / 房间码 / 断线宽限
                                                    ├─ GomokuRoom   五子棋权威对局（服务器唯一状态源）
                                                    └─ RelayRoom    其余 10 款游戏的消息转发房
```

- **传输层**：单一 WebSocket 端点 `/ws`，协议信封 `{version:1, type, requestId?, payload}`。
  客户端请求带 `requestId`，服务器用同一 `requestId` 关联响应；推送消息不带。
- **五子棋：服务器权威**。棋盘、轮次、胜负、悔棋、认输、换先、战绩全部由服务器持有与推进；
  客户端只发送操作意图（`game.action`），服务器校验后广播权威快照 `game.updated`。
- **其余 10 款游戏：服务器转发（relay）**。保留"房主客户端权威 + 快照广播"模型，
  服务器只做成员管理与消息转发（`relay.send` → `relay.message`），把原先的第三方实时通道换成自建 WS。
- **状态存储：进程内存**。房间与对局状态不落盘，**服务重启即全部丢失**（第一阶段约定）。

## 页面结构

| 页面 | 游戏 | 房间模型 |
|---|---|---|
| `index.html` | 大厅（选择游戏） | — |
| `gomoku.html` | 五子棋 | 服务器权威（2 人） |
| `tictactoe.html` | 井字棋 | relay（房主权威） |
| `reversi.html` | 黑白棋 | relay（房主权威） |
| `connect4.html` | 四子棋 | relay（房主权威） |
| `monopoly.html` | 大富翁 | relay（房主权威） |
| `ludo.html` | 飞行棋 | relay（房主权威） |
| `checkers.html` | 跳棋 | relay（房主权威） |
| `animal-chess.html` | 斗兽棋 | relay（房主权威） |
| `texas.html` | 德州扑克 | relay（房主权威） |
| `blackjack.html` | 21 点 | relay（房主权威） |
| `landlord.html` | 斗地主 | relay（房主权威） |

## 快速开始

```bash
npm install          # 安装 express + ws（运行期依赖）与 playwright（测试依赖）
npm start            # 启动服务，默认 http://127.0.0.1:8080
npm test             # 全量测试（协议 + 浏览器冒烟 + 双端联机验收）
```

环境变量：

| 变量 | 默认值 | 说明 |
|---|---|---|
| `PORT` | `8080` | HTTP/WebSocket 监听端口 |
| `BIND_HOST` | `127.0.0.1` | 监听地址；生产环境保持回环，由 Nginx 反代对外 |

健康检查：

```bash
curl http://127.0.0.1:8080/health
# {"status":"ok","uptime":12,"activeRooms":0,"connections":0}
```

## 目录结构

```
server.js                  进程入口：Express 静态托管 + /health + 优雅停机
net-client.js              浏览器共享 WS 客户端（requestId 关联、指数退避重连、错误码→中文）
room-common.js             relay 房间面板（10 款游戏共用，initRoomPanel 接口保持不变）
gomoku-net.js              五子棋联机面板（房间 UI + 凭据保存 + 身份恢复）
gomoku-app.js              五子棋渲染层（服务器权威快照渲染 + 本地模式规则）
server/
  config.js                全部可调常量（端口、宽限期、TTL、限频、心跳）
  protocol/errors.js       错误码枚举
  protocol/messages.js     信封封装 + 客户端消息类型白名单
  rooms/room-base.js       成员管理基类（加入/断线/重连/移除 + 断线宽限计时）
  rooms/relay-room.js      relay 房间（转发）
  rooms/room-manager.js    房间生命周期唯一入口（创建/加入/重连/离开/清理）
  games/gomoku-engine.js   15x15 规则引擎（落子合法性、五连判定）
  games/gomoku-room.js     五子棋权威对局（快照字段与原客户端一致）
  ws/hub.js                WebSocket 装配（心跳、限频、大小限制、路由）
tests/                     协议测试 + 浏览器测试 + 统一 runner
```

## 协议 v1（客户端 → 服务器）

| type | 说明 |
|---|---|
| `room.create` | `{gameType, prefix, nickname}` → `room.created`（含 `roomId/playerId/reconnectToken/snapshot`） |
| `room.join` | `{roomId, nickname, gameType?}` → `room.joined` |
| `room.reconnect` | `{roomId, playerId, reconnectToken}` → `room.reconnected`（断线宽限期内恢复座位） |
| `room.leave` | 主动离开 → `room.left` |
| `game.action` | 五子棋权威动作：`move` / `undo_request` / `undo_respond` / `surrender` / `restart` / `play_again` |
| `relay.send` | `{event, data, targetId?}` → 广播或定向 `relay.message` |
| `ping` | 应用层心跳 → `pong` |

服务器推送：`game.updated`（权威快照）、`room.player_joined` / `room.player_left` /
`room.player_disconnected` / `room.player_reconnected`、`relay.message`、`room.error`。

错误码见 `server/protocol/errors.js`，客户端在 `net-client.js` 里映射为中文文案展示，
不把技术细节透给用户。

## 运行约定（重要）

- **内存房间**：重启进程后所有房间码立即失效，浏览器端凭据会在下次请求时收到
  `ROOM_NOT_FOUND` 并自动清理本地凭据，回到大厅状态。
- **断线宽限**：网络闪断后座位保留 90 秒，期间用 `playerId + reconnectToken` 可恢复身份与棋盘；
  超时后座位释放。前端在 `onStatus("online")` 时自动触发一次身份恢复。
- **空闲回收**：全员离线且 30 分钟无活动的房间由清理任务回收。
- **限频**：单连接 5 秒内最多 40 条消息，超出返回 `RATE_LIMITED`。
- **消息上限**：单条文本消息 32KB，超出直接断开（`ws` 层与应用层双保险）。
- **心跳**：服务端每 30 秒 ping 一次，未回 pong 的连接被 terminate。

## 测试

```bash
npm test                 # tests/run-all.cjs：拉起被测服务器后顺序执行全部用例
npm run test:protocol    # 仅协议测试（自行在 18081 端口拉起服务器）
npm run test:dual        # 仅五子棋双端验收（自行在 18082 端口拉起服务器）
```

| 用例 | 覆盖内容 |
|---|---|
| `tests/run-all.cjs` | 统一 runner：在 18080 拉起被测服务器，注入 `BASE_URL`，汇总各文件退出码 |
| `tests/server-protocol.cjs` | 25 项：房间创建/加入/满员/不存在、轮次与占位校验、五连胜负、再来一局换先、悔棋、认输、重开、断线重连、伪造令牌、非法消息、relay 转发、健康检查 |
| `tests/gomoku-dual.cjs` | 8 项：两个独立浏览器上下文完成建房→邀请链接加入→轮流落子同步→越权被拒→重复落子→刷新恢复→五连胜负，并断言全程只访问本源域名 |
| `tests/lobby-smoke.cjs` | 大厅跳转到五子棋 |
| `tests/gomoku-smoke.cjs` | 五子棋联机建房/刷新恢复 + 本地模式完整对局、悔棋、结算、再来一局、认输 |
| `tests/games-smoke.cjs` | 7 款 relay 游戏建房与开局交互 |
| `tests/grid-games-smoke.cjs` | 井字棋/黑白棋/四子棋本地规则与计时 |

测试截图输出到 `outputs/`（已在 `.gitignore` 中忽略）。

## 部署（Nginx + HTTPS/WSS）

服务器上以 systemd 常驻 Node 进程，只监听回环地址，由既有 Nginx 反代并终结 TLS。

1. 拉取代码并安装运行期依赖：

```bash
git clone <repo> /opt/psn-game-platform
cd /opt/psn-game-platform && npm install --omit=dev
```

2. `/etc/systemd/system/psn-game-platform.service`：

```ini
[Unit]
Description=LinkPlay game platform (Node.js + WebSocket)
After=network.target

[Service]
Type=simple
WorkingDirectory=/opt/psn-game-platform
Environment=PORT=48230
Environment=BIND_HOST=127.0.0.1
ExecStart=/opt/node-v24.17.0-linux-x64/bin/node server.js
Restart=always
RestartSec=3

[Install]
WantedBy=multi-user.target
```

```bash
systemctl daemon-reload && systemctl enable --now psn-game-platform
systemctl status psn-game-platform --no-pager
```

3. Nginx 站点（`/xp/panel/vhost/nginx/demo.game.e-du.cn.conf`）：80 段保留
   `/.well-known/` 的 acme webroot 校验并 301 到 HTTPS；443 段终结 TLS，`location /ws`
   升级为 WebSocket 反代，其余路径反代到同一上游。

```nginx
location /ws {
    proxy_pass http://127.0.0.1:48230;
    proxy_http_version 1.1;
    proxy_set_header Upgrade $http_upgrade;
    proxy_set_header Connection "upgrade";
    proxy_set_header Host $host;
    proxy_read_timeout 3600s;
}
location / {
    proxy_pass http://127.0.0.1:48230;
    proxy_set_header Host $host;
    proxy_set_header X-Real-IP $remote_addr;
}
```

4. 证书：acme.sh 单域名 ec-256 webroot 模式签发并安装到 vhost 的 ssl 目录，
   由 acme 自动续期任务负责续签后 reload。

```bash
mkdir -p /xp/www/demo.game.e-du.cn
/root/.acme.sh/acme.sh --issue -d demo.game.e-du.cn -w /xp/www/demo.game.e-du.cn --keylength ec-256
/root/.acme.sh/acme.sh --install-cert -d demo.game.e-du.cn --ecc \
  --key-file       /xp/panel/vhost/ssl/demo.game.e-du.cn/privkey.pem \
  --fullchain-file /xp/panel/vhost/ssl/demo.game.e-du.cn/fullchain.pem \
  --reloadcmd      "/xp/server/nginx/sbin/nginx -s reload"
```

要点：

- 客户端按页面同源推导 WS 地址：HTTPS 页面自动使用 `wss://<host>/ws`，无需额外配置。
- `location /ws` 必须带 `Upgrade` / `Connection` 头与足够长的 `proxy_read_timeout`，否则长连接会被断开。
- 81/443 之外不要暴露 Node 端口；`BIND_HOST=127.0.0.1` 保证只有 Nginx 能访问。

## 历史沿革

早期版本是纯静态站点，联机先后用过 PeerJS 公共信令 + WebRTC 直连、Supabase Realtime 广播。
这两种方案都依赖第三方服务且无法在自建环境稳定工作，现已全部移除，改为本仓库自带的
Node.js WebSocket 房间服务。历史记录见 `progress.md`。
