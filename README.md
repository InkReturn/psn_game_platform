# LinkPlay 小游戏平台（服务端化版）

## 私有服务器发布

HTTP IP 目标：`http://111.229.38.64:8881`。本轮原 11 款、拼豆与四款开源试玩一并发布；部署拓扑、运行 SHA、回滚与实际验收状态见 [私有服务器发布记录](deploy/private-server/README.md)。旧域名配置仅保留历史，不由本轮修改。

拼豆仅存于访问者浏览器；换 IP / 端口 / 协议 / 域名需在旧地址先导出 JSON，再在新地址导入，不能自动跨源搬存档。

## 开源试玩（本机与个人自托管）

新增“开源试玩”入口，保留原有 11 款游戏：坦克与 BrowserQuest 支持各自的在线多人世界；方块目前仅单人；原版地产桌游支持 2–8 人同屏。Lichess 明确标为待接入，不用外部网页冒充本地游戏。

```powershell
npm run arcade:install
npm run start:arcade
# 打开 http://127.0.0.1:8080/arcade.html
npm run test:arcade
```

`npm start` 保持原行为，只启动平台，不自动启动独立游戏服务。直接本机启动仅监听回环；私有服务器个人试玩由 Nginx 8881 同源反代，不开放独立服务端口。许可证、固定来源版本、素材风险和未完成项见 [开源试玩接入记录](integrations/THIRD-PARTY.md)。

一个自建服务器的多人小游戏平台：静态页面 + Node.js 权威房间服务，12 款联机游戏共用同一套
WebSocket 房间层。**不依赖任何第三方实时服务**（无 PeerJS、无 Supabase、无 WebRTC、无数据库）。

## 架构总览

```
浏览器 A ─┐                      ┌─ 静态资源（12 个游戏页面 + 大厅）
          ├─ HTTP(S) ── Nginx ──┤
浏览器 B ─┘                      └─ WS(S) /ws ── Node.js（Express + ws）
                                                    ├─ RoomManager  房间生命周期 / 房间码 / 断线宽限
                                                    ├─ GomokuRoom   五子棋权威对局（服务器唯一状态源）
                                                    └─ 各游戏 Room 权威对局（含 GoldMinerRoom 实时挖矿）
```

- **传输层**：单一 WebSocket 端点 `/ws`，协议信封 `{version:1, type, requestId?, payload}`。
  客户端请求带 `requestId`，服务器用同一 `requestId` 关联响应；推送消息不带。
- **五子棋：服务器权威**。棋盘、轮次、胜负、悔棋、认输、换先、战绩全部由服务器持有与推进；
  客户端只发送操作意图（`game.action`），服务器校验后广播权威快照 `game.updated`。
- **大厅全部 12 款游戏：服务器权威**。实际 `game-types.js` 与 `RoomManager` 注册表均走各游戏权威 Room；
  通用 `authoritative-room.js` 面板负责身份和快照，客户端只发送 `game.action` 意图。
  `RelayRoom` 仅保留通用协议兼容能力，不是大厅游戏的当前实现路径。
- **黄金矿工**：2–6 人，房主选择共享抢矿或独立竞速，自由输入 10–600 秒整数（默认初值 90）。
  服务器安排 3 秒倒计时，自动摆钩、扫掠碰撞、矿石独占、按重量回收，回到矿机且早于截止才计分。
  按钮、空格、触屏放钩；实时总价值、同分并列，晚加入等待下一局，支持刷新恢复、房主交接和再来一局。
- **状态存储：进程内存**。房间与对局状态不落盘，**服务重启即全部丢失**（第一阶段约定）。

## 页面结构

| 页面 | 游戏 | 房间模型 |
|---|---|---|
| `index.html` | 大厅（选择游戏） | — |
| `gomoku.html` | 五子棋 | 服务器权威（2 人） |
| `tictactoe.html` | 井字棋 | 服务器权威 |
| `reversi.html` | 黑白棋 | 服务器权威 |
| `connect4.html` | 四子棋 | 服务器权威 |
| `monopoly.html` | 大富翁 | 服务器权威 |
| `ludo.html` | 飞行棋 | 服务器权威 |
| `checkers.html` | 跳棋 | 服务器权威 |
| `animal-chess.html` | 斗兽棋 | 服务器权威 |
| `texas.html` | 德州扑克 | 服务器权威 |
| `blackjack.html` | 21 点 | 服务器权威 |
| `landlord.html` | 斗地主 | 服务器权威 |
| `gold-miner.html` | 黄金矿工（共享抢矿 / 独立竞速） | 服务器权威（2–6 人，自定义时长） |

## 赛博拼豆（单人本地创作）

大厅保留 12 款联机游戏，另有第 13 个入口 `beads.html`。支持环状豆子画板、拖动、擦除、填充、取色、撤销重做、多作品命名、模板、PNG 成品与 JSON 备份。

- 作品自动保存在同一浏览器、同一站点的 IndexedDB 本地事务库，HTTP IP 下也能刷新或重新打开恢复；清除站点数据会删除作品。没有账号、云同步或服务端数据库。旧版 localStorage 自动无损迁移且保留原文。
- 存档支持 16/24/32/48/64 格画板，最多 30 幅，名称 1–60 字符；导入上限 2 MB，先校验整份文件再追加新标识作品，不替换现有作品。
- 损坏存档保留原文，可下载原数据，确认后才重建。保存失败显示“未保存”，可备份内存作品并明确重试。多标签页使用同一 IndexedDB 事务内的原文比较与写入，旧页不得覆盖新存档；请先备份再重载。保存不依赖仅安全上下文可用的 Web Locks。
- 方向键移动画板光标，空格使用当前工具，Delete 擦除；B/E/F/I 切换画笔/擦除/填充/取色，Ctrl/⌘+Z 撤销，Ctrl/⌘+Shift+Z 或 Ctrl/⌘+Y 重做。会话历史最多 80 步，切换作品清空。
- `npm run test:beads` 执行模型与真实 Playwright 验收；浏览器测试自行启动随机空闲回环端口的临时服务并清理。截图输出到 ignored `outputs/`。

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
authoritative-room.js      大厅游戏通用权威房间面板（身份/邀请/恢复/只读快照）
room-common.js             旧 relay 兼容面板，不用于黄金矿工
gold-miner-rules.js         黄金矿工唯一规则/物理/计时/计分，CommonJS及浏览器共用
gold-miner.js               黄金矿工只读Canvas渲染及start/drop操作意图
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
| `game.action` | 各游戏权威意图；黄金矿工仅 `start`（mode/durationSeconds）及 `drop`（无金额/角度/目标） |
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
| `tests/games-smoke.cjs` | 10 款既有权威游戏建房冒烟，完整对局另由各游戏 dual 套件覆盖 |
| `tests/grid-games-smoke.cjs` | 井字棋/黑白棋/四子棋本地规则与计时 |

### 黄金矿工局部验收

```powershell
node --check gold-miner-rules.js
node --check gold-miner.js
node --check server/games/gold-miner-room.js
node tests/gold-miner-rules.cjs
node tests/gold-miner-authority.cjs
node tests/gold-miner-dual.cjs
node tests/platform-regression.cjs
npm test
```

- rules 为纯物理/截止/抢占单元测试；authority 使用注入时钟和定时器的真实房间 fixtures，**不冒充 WebSocket 测试**。
- dual 自行启动隔离回环服务器（或复用回环 `BASE_URL`），先真 WS 验权限/时长/六人上限，再用独立桌面和触屏浏览器身份完成双模式、真实截止、刷新/断线恢复和交接。
- 金额只由服务端在矿石完成回收时入账。退出者保留结果但失去获胜资格；结束后的下一局才清分。服务重启不保留比赛。
- 本地素材来自 Kenney Pixel Platformer 1.2（CC0）；实际六张图片及原包映射见 `assets/gold-miner/SOURCES.md`，原包许可见 `assets/gold-miner/LICENSE.txt`。未使用 img2.5。
- 完整需求、22项验收与最新执行证据持续回写 `docs/gold-miner-plan.md`。

测试截图输出到 `outputs/`（已在 `.gitignore` 中忽略）。

## 部署（Nginx + HTTPS/WSS）

服务器上以 systemd 常驻 Node 进程，只监听回环地址，由既有 Nginx 反代并终结 TLS。

> 实际使用的 unit 与 vhost 文件留档在仓库 `deploy/` 目录，并附带一致性核对与回滚说明，
> 见 `deploy/README.md`。下面步骤与其等价，任选其一照做即可。

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
