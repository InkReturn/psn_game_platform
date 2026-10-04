# 开源试玩：来源、授权与接入边界

本轮只做 **HTTP 本机试玩**，不部署生产、不连接真实数据库、不替换现有 11 款游戏。进入大厅的“开源试玩”后，状态接口会检查资源和独立服务；未就绪项目没有试玩按钮。源码链接不是游戏接入。

## 引入清单

| 游戏 | 上游及固定版本 | 本轮接入 | 授权 |
|---|---|---|---|
| 坦克大战 | https://github.com/colyseus/realtime-tanks-demo ，`6339493130b4b1d4d28f0f52d17b2fba738c7d47` | 原版 Three.js 客户端 + Colyseus 权威服务；多人进入同一个自动匹配战场 | MIT，原作者 Endel Dreyer、Maksims Mihejevs |
| 像素冒险 | https://github.com/mozilla/BrowserQuest ，`af32d247cac3495ca430d0effbb88dd5f3250b2c` | 原版地图、客户端和游戏规则；现代 ws 传输适配；一个 32 人世界 | 代码 MPL-2.0，素材 CC-BY-SA-3.0；Little Workshop 的 Franck Lecollinet、Guillaume Lecollinet |
| 方块街机 | https://github.com/NatsuDrag9/tetris-multiplayer ，`b654542140d0db37fb700bc2ff5a23822ac26145` | **仅单人试玩**；移除不可用多人入口，保留原版单人规则 | MIT，Rohit Imandi |
| 地产桌游原版 | https://github.com/intrepidcoder/monopoly ，`3537fc393930f1712e8b4d6fbe2e80b25419ceed` | 原版 2–8 人同屏玩法和实验性 AI；jQuery 改成本地资源；**没有新增在线多人** | MIT，Daniel Moyer |
| Lichess | https://github.com/lichess-org/lila ，调研 HEAD `d524da63696e0e76fdc061ea62c407bb78340d35` | **未接入**；保留待接入目录项，不冒充可玩 | AGPL-3.0-or-later |

boardgame.io（https://github.com/boardgameio/boardgame.io ）是 MIT 授权的回合制框架，不是游戏成品，本轮只保留参考链接，没有额外安装。

## 素材和第三方依赖

- 坦克客户端的 Pixel Tank 模型来自 Firewarden3D： https://sketchfab.com/3d-models/pixel-tank-d04bf57ee1ae4504856032549bcfd810 。上游 README 明确列出作者。本轮没有独立确认模型页面的完整素材许可；**项目 MIT 不能自动覆盖模型**，正式分发或商用前必须单独确认。
- BrowserQuest 原版内容为 CC-BY-SA-3.0： https://creativecommons.org/licenses/by-sa/3.0/ 。保留原版制作团队信息及上层 LICENSE。修改的客户端配置源文件仍保留在仓库，适配器位于 integrations 目录。MPL 正文： https://www.mozilla.org/MPL/2.0/ 。
- 方块背景来自 Unsplash / Clemen Vrankar；自定义字体 Press Start 2P（codeman38）、Emulogic（Freaky Fonts）及图标来源见上游 Readme。上游依赖还包含 Fontsource 的 Poppins、Roboto。本轮不将这些资源统称 MIT；正式分发前分别核查。
- 地产桌游代码 MIT 不代表 Monopoly 品牌、棋盘名称或图片拥有商用授权；仅供私有本地试玩评估。
- jQuery 1.11.1 来自 https://ajax.googleapis.com/ajax/libs/jquery/1.11.1/jquery.min.js ，保留其原始头部和许可链接，运行时不再请求 Google CDN。
- 原版及兼容依赖包含旧版本，本轮不宣称已通过安全审计。不得直接以生产服务开放这些试玩端口。

## 实际修改

1. 坦克：单独的回环启动入口；显式使用原版 experimentalDecorators 配置；删除试玩入口的管理面板装配，增加健康标识。原版 BattleRoom 及规则未改。客户端移除 Colyseus 调试面板导入，差异留在 `integrations/tanks-client-local.patch`。
2. BrowserQuest：独立进程内用现代 ws 替代废弃 WebSocket 草案实现；保留原版动作协议和世界规则；恢复 Node 已移除的 path.exists 别名；避免原版 global.Map 覆盖现代连接表容器。客户端配置固定本机试玩服务，源码原地保留。
3. 方块：应用路由只挂载 SinglePlayer；React Router 使用 `/vendor/tetris` 前缀。差异留在 `integrations/tetris-local.patch`。上游常规 `npm run build` 存在未使用变量和旧测试类型错误，本轮使用 Vite 资源构建成功，**不声称上游 TypeScript 全量检查通过**。
4. 地产桌游：只修改 HTML 中 jQuery 地址；原版游戏规则未改。

## 启动

```powershell
npm install
npm run arcade:install
npm run start:arcade
```

试玩地址： http://127.0.0.1:8080/arcade.html 。平台端口可通过 PORT 调整；坦克服务固定 2567，冒险服务固定 8093。三个服务都只监听回环。启动器检查端口占用，不复用或杀掉未知服务；停止启动器会清理自己创建的子进程。

原来的 `npm start` 保持不变，只启动平台。此时两款纯静态游戏仍可玩，坦克与冒险会明确显示“服务未启动”。

## 验证结果

- `npm run test:arcade`：7 个验收场景全部通过，包含坦克双客户端同房间、BrowserQuest 双角色共享世界、方块开局/键盘/暂停、地产桌游掷骰、非法入口与失效服务边界。
- 浏览器脚本异常 0；自动远程 HTTP 请求 0。试玩运行不依赖公共 CDN 或远程游戏服务。
- 原有大厅冒烟通过；`tests/platform-regression.cjs` 的 13 项检查通过，11 款原有游戏入口、页面健康和返回大厅均保持正常。
- 未执行原有全量对局测试，也未宣称素材商用授权、安全审计、长期运行、完整游戏胜负或生产发布已验收。
- 完整新游戏验收结果与截图在 `outputs/arcade-verification.json` 及 `outputs/arcade-*.png`，由 `npm run test:arcade` 生成。

## 尚未完成

- 方块原版多人后端明确依赖 MongoDB（dbApp、mongoose、MONGO_URI）。本机未安装 mongod；未连接任何来源不明的 MongoDB，也未把失败的多人入口留给用户。
- 地产桌游本地玩法尚未改造成在线多人。现有平台的轻量大富翁不受影响，仍是独立游戏。
- Lichess 是 Scala、MongoDB、Redis 和独立 WebSocket 组件组成的完整站点。本机缺少 sbt 和 mongod，不适合当作普通静态游戏直接拷贝；需要另立部署与 AGPL 边界方案。
- 本轮没有统一登录、邀请、房间码、战绩、断线恢复或线上 WSS。坦克和冒险使用各自原版世界/匹配，不接入平台既有 /ws 房间协议。

## 重建资源

核心渲染库、React 与 Fontsource 字体的原始许可证保留在 `vendor/licenses`；这不是所有依赖的商用许可审计结论。

客户端资源已随 vendor 目录保留，无需启动 Vite 开发服务器。独立运行依赖使用锁文件安装。重建上游客户端时，按以上固定提交重新获取源码：坦克在 web-threejs 执行 `npm ci --ignore-scripts` 和 `npm run build`；方块先应用 tetris-local.patch，再安装其依赖并执行 `node node_modules/vite/bin/vite.js build --base=/vendor/tetris/`。不要用新 HEAD 静默替换固定版本。
