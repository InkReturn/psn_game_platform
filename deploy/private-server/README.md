# 私有服务器 HTTP IP 发布

## 目标与授权

当前目标：`http://111.229.38.64:8881`，Ubuntu 26.04，个人非商用试玩。用户确认包含原 11 款、拼豆与四款开源试玩，并授权安装 Node/npm/Nginx、独立常驻服务与发布目录。旧域名服务器、SSH、云防火墙不在本轮修改范围。

**2026-10-04 已完成公网部署与真实验收**，实际运行记录见下文。

## 部署拓扑

| 组件 | 地址 | 所有者 |
|---|---|---|
| 公网入口 | `:8881` HTTP / WS | Nginx |
| 原平台、静态资源、`/ws` | `127.0.0.1:8080` | `linkplay.service` |
| 坦克 HTTP 匹配及 WS | `127.0.0.1:2567`，公网前缀 `/tanks/` | 同一 service 的独立子进程 |
| 冒险世界 | `127.0.0.1:8093`，公网前缀 `/quest/` | 同一 service 的独立子进程 |

网络模式由 `/api/arcade-network.js` 显式声明：直接访问回环 Node 时为开发直连，公网 Nginx 为同源代理。客户端不按 hostname 猜测，声明缺失时只能尝试同源路径，不能自动退回内部端口。包装页不得再次注入 `:2567` 覆盖。

## 实际运行版本（2026-10-05 第三版发布：拼豆自定义画板 + 账号系统 + 大厅两级）

- 运行提交：`e45db13653c4351a2836c20e5f7127ff1f6552c5`（main 分支；本版上线拼豆自定义长宽矩形板与滚轮缩放/拖动平移/双指手势、`/api/auth` 账号系统、大厅"选游戏 → 选房间"两级结构）
- 发布包 SHA-256：`36b470e11d5a7159e9c0d22366c47e72b11cc579b1213a762cc41f885e382294`
- 运行目录：`/opt/linkplay/releases/e45db13653c4351a2836c20e5f7127ff1f6552c5`，`current` 指向该目录；上一版 `0a4b181` 目录完整保留供回滚
- systemd unit：`/etc/systemd/system/linkplay.service`，SHA-256 `8f23638e5cde22c6a07c3506316aaa53c07f7df24d2924e2ce0c30a777cd7f5f`；本版新增 `StateDirectory=linkplay` 与 `LINKPLAY_AUTH_FILE=/var/lib/linkplay/accounts.json`，账号数据首次拥有跨版本持久化位置（0640 ubuntu:ubuntu），旧 unit 备份于 `/opt/linkplay/backups/linkplay.service.pre-e45db13.bak`
- Nginx 配置：本版未改动，SHA-256 仍为 `57775f5f562549c5522aec1b4a2b4f99dc84a08ddedb4d4c8d8a9b14d7c26280`；`/api/auth/*` 经既有 `location /` 代理到 127.0.0.1:8080
- 公网监听面：**仅 8881（nginx）与 22（sshd）**；内部服务全部只在 127.0.0.1
- unit 状态：`linkplay` active 且 enabled；内存平稳，子进程正常管理

## 公网验收记录（2026-10-05）

发布前本地门禁：`npm test` 全量 **37/37 测试文件通过**（账号 7/7、大厅房间协议 7/7、拼豆模型 22 + 浏览器 25、黄金矿工 35+24+19、平台回归 15/15 等）。

从开发机走真实公网 `http://111.229.38.64:8881` 执行：

- 切换前冒烟：新 release 在 127.0.0.1:18081 独立启动，`/health`、注册、`me`、账号文件落盘全部通过后清理，未触碰运行中的旧版本。
- 公网 auth 探针：注册 `deploy_probe` → `me` → 登出吊销令牌 → 大小写不敏感重登，全部通过；数据写入 `/var/lib/linkplay/accounts.json`。
- `npm run test:arcade`（`BASE_URL` + `EXPECT_ARCADE_PROXY=1`）：**8/8 通过**——同源双世界、目录与边界。
- `node tests/beads-browser.cjs`（`BASE_URL`）：**25/25 通过**——含自定义长宽矩形板、滚轮缩放、右/中键拖动平移、双指捏合与平移，以及 HTTP 非安全源事务存档。
- `node tests/platform-regression.cjs`（`BASE_URL`）：**15/15 通过**——13 个入口全部健康。
- 暴露面核查：`ss -tlnp` 公网监听仅 8881 + 22；8080/2567/8093 仍只在回环。

## 已完成的环境准备

- 安装前确认机器无 Node/npm/Nginx、无本项目目录／unit、8881 空闲，公网监听仅 SSH。
- Windows 向 Bash 传脚本先 `tr -d "\r"`；配置文件 LF、无 BOM（服务器上实测 0 个 CR）。

## 发布步骤与回滚边界

1. 在隔离任务分支完成测试和审查，只提交任务所属路径；固定其他任务为 `034c955`，不打包浮动工作区或无关未跟踪文件。
2. 将批准计划的主分支保存提交合入任务分支，处理计划冲突但保留两份历史；再把已验证任务分支合入 `main`。没有 push/tag 授权。
3. 从固定提交 `git archive` 生成包，核对完整 SHA、包 SHA-256 和清单；不包含 `.git`、忽略的依赖／输出／凭据。保留该原始包作为公开 `source.tar.gz`，满足修改源文件与许可证获取。
4. 上传到独立发布目录；根依赖 `npm ci --omit=dev --ignore-scripts --no-audit --no-fund`，独立试玩依赖用 `npm run arcade:install`。后者固定 lockfile、忽略第三方安装脚本，并保留运行所需 tsx。
5. 备份本项目已有配置及上一版 current 指向。首次发布仅移除本次新安装产生的默认 Nginx 站点链接；确认目标绝对路径和归属，不影响未知站点。
6. 写入独立 unit 与 Nginx 配置，运行 `systemd-analyze verify`、`nginx -t`，通过后启用服务；先回环健康检查，再真实公网 HTTP 与 WS 验收。
7. 核对 `/health`、四款目录就绪、真实浏览器两个独立玩家、`/ws`、`/tanks/`、`/quest/` 的 101/帧及动作；核对全部内部 TCP 监听仍为回环，运维路径 404、署名页可访问。

后续更新失败：停用本项目 unit，恢复已记录的上一版 symlink 与本项目配置，校验后重启；保留失败产物用于诊断。首次发布无上一版：只停止新建 `linkplay.service`、Nginx，恢复部署前业务监听状态（仅 SSH）；保留包和安装的软件，不擅自卸载系统依赖，不启动默认 80 站点。

## 数据与未验证边界

- 拼豆仅存于访问者浏览器 IndexedDB，JSON 版本仍为 1；旧 localStorage 原文保留且只作首次迁移来源。初次读取失败时基线未知，重试不能用空模板遮蔽既有数据。
- **换 IP、端口、协议或域名就是换 origin**，浏览器不能自动跨源搬作品；先在旧地址下载 JSON，再在新地址导入。
- 所有联机对局均为内存状态，重启会丢失；本次不连接数据库。
- HTTP 没有传输加密：2026-10-05 起上线账号系统，密码以明文 HTTP 过网，服务端仅做 scrypt 哈希落盘、令牌单设备语义；属个人非商用试玩范围，正式对外使用前应加 TLS。不宣称正式商用授权、旧依赖完整安全审计或真实手机全机型验收完成。
- 坦克只新增非法输入边界，合法规则保持原版；方块只单人，地产桌游原版只同屏，Lichess 未接入。
- 模型官方 API 已核实 Firewarden3D / CC-BY-4.0。公开署名在 `third-party.html`；其他素材商业授权与旧依赖审计仍未完成，用户已确认个人非商用试玩范围。

