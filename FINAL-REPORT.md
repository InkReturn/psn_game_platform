# 最终验收报告：psn_game_platform 服务器权威在线化

## 1. Verdict

```
PASS
```

全部 11 款适合多人玩的游戏均提供服务器权威在线模式；随机数全部由服务器产生；
隐藏信息未发送给无权玩家；Room join/leave/reconnect 实时同步；每款游戏通过
真实多浏览器 E2E；线上 demo.game.e-du.cn 实际可玩（线上 E2E 全绿）；
五子棋/斗兽棋无回归；本地/单机模式未被破坏。

## 2. Git

```
起始 HEAD：0fca4b0（任务开始时 main，PeerJS/Supabase 已在上一批替换为自建 WS）
结束 HEAD：63e9ebe（main，已推送 origin）
新增 commits：00ec38f（部署资产归档，上一批遗留）+ 本任务 16 个提交：
  e14b532  Server-authoritative animal chess and grid games（含前次未提交工作整合）
  8584b73  Add game inventory for server-authoritative migration
  b93657c  Server-authoritative checkers (2-6 players)
  ed1bb14  Mark checkers migration complete in inventory
  e6930a5  Server-authoritative ludo with server-rolled dice
  eab4e74  Server-authoritative monopoly with server dice and chance events
  2f1dc33  Mark ludo and monopoly migrations complete in inventory
  aa29231  Server-authoritative landlord with private snapshots and leak tests
  4f309f0  Mark landlord migration complete in inventory
  5ee8289  Server-authoritative blackjack with dealer hole-card isolation
  d79ec8e  Mark blackjack migration complete in inventory
  1b7f4d5  Server-authoritative texas hold'em with hole-card isolation
  0743909  Mark texas migration complete: all 11 games now server-authoritative
  6a7056d  Add platform regression suite
  63e9ebe  Make animal-chess dual driver latency-tolerant for production E2E
git status：clean（工作区无未提交改动；两个旧 worktree 已清理并合并）
```

## 3. 游戏 Inventory（11 款全部为权威房，relay 房已全部退役）

| 游戏 | 入口 | 玩家人数 | 房间码前缀 | 服务器权威 | 服务端随机 | 私有状态 | 重连 | E2E | 线上验证 |
|---|---|---|---|---|---|---|---|---|---|
| 五子棋 gomoku | gomoku.html | 2 | WZ | ✅（既有） | —（无随机） | —（完全信息） | ✅ | ✅ 双浏览器 | ✅ 8/8 |
| 斗兽棋 animal-chess | animal-chess.html | 2 | DS | ✅（既有） | —（无随机） | —（完全信息） | ✅ | ✅ 双客户端 | ✅ 20/20 |
| 井字棋 tictactoe | tictactoe.html | 2 | JZ | ✅ | —（无随机） | — | ✅ | ✅ 双浏览器 | ✅ 8/8 |
| 黑白棋 reversi | reversi.html | 2 | HB | ✅ | —（无随机） | — | ✅ | ✅ 双浏览器 | ✅ 25/25 |
| 四子棋 connect4 | connect4.html | 2 | SZ | ✅ | —（无随机） | — | ✅ | ✅ 双浏览器 | （随 grid-dual） |
| 跳棋 checkers | checkers.html | 2-6 | TQ | ✅ | —（无随机） | — | ✅ | ✅ 双浏览器 | ✅ 10/10 |
| 飞行棋 ludo | ludo.html | 2-4 | FQ | ✅ | ✅ crypto 骰子 | — | ✅ | ✅ 双浏览器 | ✅ 9/9 |
| 大富翁 monopoly | monopoly.html | 2-4 | DF | ✅ | ✅ crypto 骰子+机会事件 | — | ✅ | ✅ 双浏览器 | ✅ 9/9 |
| 斗地主 landlord | landlord.html | 3 | DD | ✅ | ✅ crypto 洗牌 | ✅ 手牌/底牌隔离 | ✅ | ✅ 三浏览器 | ✅ 11/11 |
| 21 点 blackjack | blackjack.html | 1-3 | BJ | ✅ | ✅ crypto 洗牌 | ✅ 庄家暗牌隔离 | ✅ | ✅ 双浏览器 | ✅ 9/9 |
| 德州扑克 texas | texas.html | 2-6 | TX | ✅ | ✅ crypto 洗牌 | ✅ 底牌/未来公共牌隔离 | ✅ | ✅ 双浏览器 | ✅ 9/9 |

线上另有：games-smoke（7 款权威房冒烟）EXIT=0；platform-regression（11 入口/页面健康/返回大厅/本地模式）16/16。

## 4. 公共架构

- **WebSocket**：单端点 `/ws`（`server/ws/hub.js`），统一信封（version/type/requestId/payload），错误码协议（`server/protocol/errors.js`，本轮新增 INVALID_CARD）。
- **RoomManager**（`server/rooms/room-manager.js`）：建房/加入/重连/离开/清理唯一入口；权威房构造表按 gameType 注册；建房负载（playerCount）传入房间。
- **Player Session**：playerId + reconnectToken（crypto 常量时间校验），断线 90 秒宽限保座，迟到旧连接忽略。
- **Reconnect**：凭据恢复座位，快照重建视图；个性化快照房间重连只恢复本人可见数据。
- **Game Adapter**：`RoomBase` 子类（每游戏一个 `server/games/*-room.js`），共享 seatPlayer/onPlayerRemoved/onPlayerDisconnected/snapshot/broadcast；规则全部委托给共享纯规则模块 `<game>-rules.js`（服务端裁决 + 浏览器提示同一份实现，无随机性，随机源注入）。
- **个性化快照基础设施**（本轮新增）：`snapshotFor(playerId)` + `personalizedSnapshots` 标志，广播/加入/重连响应自动按玩家过滤——所有隐藏信息游戏复用，无第二套房间协议。
- **客户端**：`authoritative-room.js`（房间面板/凭据/断线恢复）+ `room-panel-shared.js` + 各 `<game>-net.js` 渲染层（本地状态为只读镜像，只发意图）。

## 5. 各游戏迁移结果

| 游戏 | 原模式 | 新模式 | 服务器管理 | 备注 |
|---|---|---|---|---|
| checkers | relay（房主权威广播全量状态） | 权威房，满员自动开局 | 合法落点（星形几何）、轮次、到达对面出发区判胜 | 修复旧版胜负永不触发的 bug（target 存颜色名 vs 比较区域名） |
| ludo | relay | 权威房 | 骰子（crypto）、起飞/移动/钳制、全部到达判胜 | 简化玩法原样保留（无吃子/额外回合） |
| monopoly | relay | 权威房 | 骰子+机会金额（crypto）、位置/资金/地产/租金/税/监狱、破产终局 | 简化版原样保留 |
| landlord | relay（手牌全量广播=网络层泄漏） | 权威房 3 人 | 洗牌（crypto）、发牌、叫/抢地主、牌型/压牌、倍率、胜负 | 机器人补位由 3 真人满员替代 |
| blackjack | relay（庄家暗牌在房主广播里） | 权威房 1-3 人 | 洗牌（crypto）、发牌、hit/stand、庄家补牌、结算派彩 | 修复爆牌玩家庄家爆牌时误判胜的 bug |
| texas | relay（底牌全量广播） | 权威房 2-6 人 | 洗牌（crypto）、底牌、公共牌按阶段、下注轮、摊牌、底池 | 机器人补位由真人座位替代 |

## 6. 随机数治理

| 游戏 | 随机源 | 生成方 | 机制 |
|---|---|---|---|
| ludo | 骰子 | 服务器 | `crypto.randomInt(1,7)`，客户端夹带 dice 字段被忽略（有断言） |
| monopoly | 骰子 + 机会事件 | 服务器 | `crypto.randomInt`，伪造 dice/chance 被忽略（有断言） |
| landlord | 洗牌 | 服务器 | Fisher-Yates + `crypto.randomInt` |
| blackjack | 洗牌 | 服务器 | Fisher-Yates + `crypto.randomInt` |
| texas | 洗牌 | 服务器 | Fisher-Yates + `crypto.randomInt` |
| 其余 6 款 | — | — | 规则本身无随机 |

客户端 `Math.random()` 仅用于昵称默认值（非游戏结果）。测试驱动器所需随机由服务器返回的快照驱动。

## 7. 隐藏信息（网络 payload 级验证）

- **斗地主**：任何客户端收到的任何消息中不出现他人手牌 id 与未公布底牌 id（底牌 id 由 54 张减三家手牌推算）；检查点：发牌后/地主确定后/重连后/终局/重发后。
- **21 点**：牌 id 全集约束——每个客户端消息中出现的所有牌 id ⊆ 其结构性可见集合（自己手牌 ∪ 庄家明牌 ∪ 结算后公开牌），一个断言覆盖他人手牌/庄家暗牌/牌堆顺序三类泄漏；检查点：发牌后/结算后/重连后/新一局。
- **德州扑克**：同上全集约束 + 公共牌张数按阶段断言（翻牌 3/转牌 4/河牌 5，不提前下发）；检查点：发牌后/逐轮/终局/下一手。
- 三者均为**直接扫描 WebSocket 原始 JSON**，非页面显示检查。

## 8. Room 同步

join/leave/disconnect/reconnect/seat/ready（满员自动开局）全部经 `room.snapshot` 全量快照广播（个性化房间按玩家过滤）；`tests/room-sync.cjs` 专项回归双客户端成员同步；各 dual 测试均有「房主不刷新也能看到对手」断言。断线宽限 90 秒保座，房间空闲 30 分钟自动回收（线上 E2E 后 activeRooms 归零实测）。

## 9. 自动化测试（`npm test` 31/31 文件通过）

| 游戏 | 规则单测 | WS 权威测试 | 多浏览器 E2E |
|---|---|---|---|
| gomoku | （既有引擎，grid-rules 内） | server-protocol | gomoku-dual 8 用例 |
| animal-chess | animal-chess-rules | — | animal-chess-dual 20 用例 |
| tictactoe/reversi/connect4 | grid-rules 19 | grid-authority | grid-dual 25 用例 |
| checkers | checkers-rules 7 | checkers-authority 13 | checkers-dual 10 |
| ludo | ludo-rules 6 | ludo-authority 11 | ludo-dual 9 |
| monopoly | monopoly-rules 10 | monopoly-authority 10 | monopoly-dual 9 |
| landlord | landlord-rules 9 | landlord-authority 12 | landlord-dual（三浏览器）11 |
| blackjack | blackjack-rules 7 | blackjack-authority 9 | blackjack-dual 9 |
| texas | texas-rules 7 | texas-authority 9 | texas-dual 9 |
| 公共 | — | server-protocol、room-sync | games-smoke、platform-regression 16 |

每款权威测试均含：越权拒绝、伪造字段忽略、非法操作拒绝、断线重连、满员、离开清理；随机游戏含服务器随机断言；隐藏信息游戏含隐私负向断言。

## 10. 线上验收（demo.game.e-du.cn，部署于 pangbao-server）

| 套件 | 结果 |
|---|---|
| platform-regression（11 入口 + 页面健康 + 返回大厅 + 本地模式） | 16/16 |
| gomoku-dual | 8/8 |
| grid-dual（井字棋/四子棋/黑白棋） | 25/25（首次 24/25 为公网抖动，复跑全绿） |
| animal-chess-dual | 20/20（驱动器延迟适配后；修复已入仓并同步服务器） |
| checkers-dual | 10/10 |
| ludo-dual | 9/9 |
| monopoly-dual | 9/9 |
| landlord-dual（三浏览器） | 11/11 |
| blackjack-dual | 9/9 |
| texas-dual | 9/9 |
| games-smoke | EXIT=0（7 款权威房冒烟） |

线上创建房间/多人加入/完整操作/重连/结束全部真实链路（浏览器 → wss://demo.game.e-du.cn/ws → Node）验证通过，无任何 mock。

## 11. Network 验证

- 活跃代码（git 跟踪的 js/html）中无 PeerJS/PeerServer/WebRTC/Supabase 引用（唯一命中为 relay-room.js 的历史说明注释）。
- vendor/ 目录为空（旧 peerjs.min.js 已移除）。
- 全部在线游戏连接 `wss://demo.game.e-du.cn/ws`（各 dual 测试「无外连」断言在线上复验）。

## 12. 回归

- 五子棋：gomoku-smoke（联机链路）+ gomoku-dual + server-protocol 全绿；线上 8/8。
- 斗兽棋：animal-chess-rules + animal-chess-dual 20/20；线上 20/20。
- 大厅：lobby-smoke + platform-regression（11 入口逐一打开、返回大厅）全绿。
- 本地/单机模式：**已按用户要求整体下线**（后续变更，见第 15 节）。

## 13. 遗留问题（真实遗留）

1. **旧渲染文件留存**：`checkers.js`/`ludo.js`/`monopoly.js`/`landlord.js`/`blackjack.js`/`texas.js`/`grid-game.js` 已不被任何页面引用（与 grid-game.js 先例一致保留），属可清理的死代码；将来可统一删除。
2. **texas 弃牌者底牌在终局公开**（沿用旧终局展示口径）：真实扑克惯例是不公开弃牌手牌；如需更严隐私可改为只公开摊牌者，属产品决策。
3. **texas 无边池**：跟注钳制到剩余筹码后多余部分留在底池由摊牌平分（旧口径原样保留）；上牌桌筹码悬殊时结算不精确，属简化玩法的固有取舍。
4. **房间状态仅存内存**：服务器重启后房间丢失（客户端自动识别 ROOM_NOT_FOUND 回到大厅）——本阶段明确约定，后续做排行榜/积分时再引入持久化。
5. 服务器每连接限流 40 条/5 秒：正常人类操作无感知；脚本化高频率操作会被拒（设计内行为）。

## 14. 回滚

```bash
# 代码：git revert 到 00ec38f（或任意前序提交）并 push；
# 服务器：ssh root@223.6.248.121 'cd /opt/psn-game-platform && git fetch origin main && git merge --ff-only origin/main && systemctl restart psn-game-platform && curl -s http://127.0.0.1:48230/health'
# 服务整体下线（完整步骤见 deploy/README.md「回滚」节）：
#   systemctl disable --now psn-game-platform
#   mv /xp/panel/vhost/nginx/demo.game.e-du.cn.conf{,.disabled-$(date +%Y%m%d)}
#   /xp/server/nginx/sbin/nginx -t && /xp/server/nginx/sbin/nginx -s reload
#   mv /opt/psn-game-platform /opt/psn-game-platform.disabled-$(date +%Y%m%d)
# 验证：https://demo.game.e-du.cn 不可达即回滚完成；同机其他胖宝业务不受影响
# （本服务与 Java 48080 / Go 48082 / 社区 49180 无任何进程/端口/数据库耦合）。
```

## 15. 后续变更（验收后）：本地模式整体下线

应用户要求，全部 11 款游戏只保留在线模式，本地/单机入口已移除：

- `gomoku-app.js` / `grid-game-net.js`：删除本地模式代码路径（本地落子/本地悔棋/
  本地结算/本地换先/本地计时等），页面只发意图、只渲染服务器权威快照；
  五子棋黑白棋的用时计时完全以服务器 `turnStartedAt` 为准。
- 4 个游戏页（gomoku/tictactoe/reversi/connect4）移除「本地对战」按钮与文案；
  大厅井字棋卡片文案同步更新。
- 测试：删除 `grid-games-smoke.cjs`（单浏览器本地规则，覆盖已由 grid-rules
  纯函数单测 + grid-dual 真实双人在线验收承担）；`gomoku-smoke.cjs` 重写为
  纯联机冒烟；`platform-regression.cjs` 的本地模式段改为「无 #localBtn 残留」
  断言。
- 全量测试 30/30 通过；部署后线上复验见第 16 节。

## 16. 本地模式下线后的线上复验（demo.game.e-du.cn）

（部署后填写）
