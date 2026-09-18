# 服务器权威在线化：游戏盘点（Checkpoint 1）

基于 HEAD `e14b532` 全仓扫描（大厅 index.html 11 张游戏卡 + 各页面 + server/games + tests）。

## 房间模型现状

- `server/games/game-types.js`：权威房注册表（gomoku/animal-chess/tictactoe/reversi/connect4）+ relay 房（`relay:<gameKey>`，上限 8 人）。
- `server/rooms/room-base.js`：统一座位/断线宽限/重连凭据/快照广播。
- `server/rooms/room-manager.js`：建房/加入/重连/离开/清理唯一入口。
- 权威房复用 `authoritative-room.js`（客户端）+ `room-panel-shared.js`（房面板）。
- relay 游戏仍为「房主权威 + relay.send 全量广播」。

## 真实 Inventory

| 游戏 | 入口 | 玩家人数 | 当前模式 | Room | 服务器权威 | 隐藏信息 | 随机数 | 迁移状态 |
|---|---|---|---|---|---|---|---|---|
| 五子棋 gomoku | gomoku.html | 2 | 权威房 | ✅ | ✅ | 无 | 无 | **完成（只回归）** |
| 斗兽棋 animal-chess | animal-chess.html | 2 | 权威房 | ✅ | ✅ | 无 | 无 | **完成（只回归）** |
| 井字棋 tictactoe | tictactoe.html | 2 | 权威房 GridGameRoom | ✅ | ✅ | 无 | 无 | **完成（已提交 e14b532）** |
| 黑白棋 reversi | reversi.html | 2 | 权威房 GridGameRoom | ✅ | ✅ | 无 | 无 | **完成（已提交 e14b532）** |
| 四子棋 connect4 | connect4.html | 2 | 权威房 GridGameRoom | ✅ | ✅ | 无 | 无 | **完成（已提交 e14b532）** |
| 中国跳棋 checkers | checkers.html | 2–6 | relay（房主权威） | ✅ | ❌ | 无 | 无 | 待迁移（第一批） |
| 飞行棋 ludo | ludo.html | 2–4 | relay | ✅ | ❌ | 无 | 骰子（客户端 Math.random） | 待迁移（第二批） |
| 大富翁 monopoly | monopoly.html | 2–4 | relay | ✅ | ❌ | 无 | 骰子 + 机会事件（客户端） | 待迁移（第二批） |
| 斗地主 landlord | landlord.html | 3（2 人+机器人补位） | relay | ✅ | ❌ | **手牌/底牌（广播泄露）** | 洗牌（客户端） | 待迁移（第三批·重点） |
| 21 点 blackjack | blackjack.html | 1–3 + 机器人 | relay | ✅ | ❌ | 庄家暗牌（broadcast 有脱敏副本，但权威在房主） | 洗牌（客户端） | 待迁移（第三批） |
| 德州扑克 texas | texas.html | 2–N + 机器人 | relay | ✅ | ❌ | 底牌（broadcast 有脱敏副本，但权威在房主） | 洗牌（客户端） | 待迁移（第三批） |

## 各 relay 游戏权威边界规划（迁移前速记）

### checkers（中国跳棋，星形棋盘 2–6 人）✅ 已完成（commit b93657c）
- 客户端：选子（本地 UX）、点目标、动画。
- 服务端：合法落点（邻接+跳跃）、轮次、到达目标区判胜、房主重开。
- 已按原意修复旧版胜负永不触发的 bug（target 存颜色名 vs 比较区域名）。
- 测试：checkers-rules 7 用例 / checkers-authority 13 用例（含完整贪心双人局）/ checkers-dual 10 用例（真实点击完整一局）。

### ludo（飞行棋）
- 客户端：点掷骰按钮、选棋子。
- 服务端：骰子结果（服务器随机）、起飞（=6）、移动、到达、全部到达判胜、轮次（现有规则无额外回合/吃子——保持简化版）。
- 人数 2-4，建房时选定（复用 checkers 的 createPayload playerCount 模式）。

### monopoly（大富翁，简化版）
- 客户端：掷骰按钮、购买/跳过按钮。
- 服务端：骰子、位置、资金、地产归属、租金、机会事件（±120/-80）、破产淘汰、胜负。
- 保持现有简化规则，不实现完整商业版。

### landlord（斗地主，3 人）
- 服务端：洗牌、发牌 17×3+3 底、叫/抢地主、倍率、牌型判断、压牌判断、轮次、胜负。
- 私有快照：本家手牌 + 他人手牌数 + 已出牌 + 公开底牌（地主确定后）。**禁止把他人手牌/未翻底牌发给任何客户端。**
- 机器人补位逻辑迁到服务端（保持现有 hint 复用）。

### blackjack（21 点，多人对庄家）
- 服务端：牌堆、洗牌、发牌、hit/stand/bust、庄家补牌（<16 要牌）、结算。
- 私有快照：庄家暗牌在 settle 前不下发（只发 visible 数量）。保持「多人对庄家」玩法。

### texas（德州扑克，简化）
- 现有实现程度：preflop/flop/turn/river/showdown、固定 20 注、all-in（stack 限制）、fold/check/call/raise、单一/平分底池、机器人。无盲注升级、无边池、无锦标赛。
- 服务端：牌堆、hole cards、community、button/轮次、pot、结算。
- 私有快照：本家 hole cards + 他人 fold 状态与下注 + community；摊牌前不发他人 hole cards、不发 deck。

## 测试基线

`npm test` 15/15 通过（HEAD b93657c，含跳棋三套新测试）。每游戏迁移须新增：
1. 规则单元测试（纯函数）；
2. WS 权威测试（含伪造状态拒绝、随机数来自服务器、隐私负向测试：payload 中不得出现他人手牌/暗牌/牌堆）;
3. 双/多浏览器 Playwright 验收（真实 WSS 链路，无 mock）；
4. run-all.cjs 注册新套件。

## 迁移顺序

1. ~~checkers（完全信息多人，跑顺多人权威房模式：3+ 人座位、ready/start）~~ ✅
2. ludo → monopoly（服务器骰子）
3. landlord → blackjack → texas（洗牌 + 私有状态 + 隐私测试）
4. 全平台回归 + 部署 pangbao-server + demo.game.e-du.cn 线上验收
