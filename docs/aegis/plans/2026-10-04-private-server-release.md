# LinkPlay 私有服务器 IP 发布

## 当前授权
- 用户要求合并主分支、发版并部署自己的私有服务器，开放端口 8881；项目记录部署事实，完成后封装 Skill。
- 用户进一步明确选择：主目录其他任务也一起发布；HTTP IP，适配浏览器本地事务存档。
- 发布只包含已经审查并通过测试的任务；不把未完成、持续变化或来源未明的 dirty 文件默认发布。
- 原 stash c2c19ac0efac2e1ab654598651fd6fb031925415 不 apply/pop/drop。主目录其他文档、未完成任务及旧部署保持原样。
- 不默认 push Git 远端，不停止原生产服务器，不改变 SSH、公钥或云防火墙。

## 基线与现场
- 默认 cwd 为 D:/Dev/psn_game_platform；开发、依赖安装及测试仍只在 D:/Dev/psn_game_platform_worktrees/cyber-beads。
- 两个分支起始 HEAD 均为 9952ab5a5f337f1ed1de72103467701075ac3646；main 有未提交 arcade、integrations、vendor 等任务，并与拼豆重叠 README/index/package。
- 主目录已读取 README、package、server、arcade 服务/测试、独立游戏启动与安装脚本、目录和来源许可文档。只读差异快照位于 outputs/arcade-main-start.patch，候选文件清单位于 outputs/arcade-main-paths.txt。
- 私有服务器：111.229.38.64，SSH ubuntu，主机 VM-0-11-ubuntu；只监听 22，无 Node/npm/nginx/业务服务；8881 空闲；内存可用约 3.1 GiB，磁盘可用约 60 GiB；ufw inactive。
- SSH 使用已配置密钥，仅以路径引用，禁止私钥内容进入项目或日志。

## 兼容与责任
- HTTP 公网 IP 不是安全上下文；真实隔离浏览器证据：crypto.getRandomValues 有效，crypto.randomUUID/navigator.locks 不存在，IndexedDB 可用。
- 新 beads-store.js 唯一负责 IndexedDB 原文读取和事务 CAS。保留旧 localStorage 作为无损迁移来源，不删除；模型 schema 与 JSON 备份仍不变。
- 控制器不回退到不安全读后写；原子比较与写入由单个 readwrite 事务持有；BroadcastChannel 只提示冲突，不是写入锁。
- 本地测试域名受宿主代理干预（502），非安全源测试由 Playwright 路由仅把资源传输转发到实际本地服务，浏览器 URL 与存储源仍非安全；公网部署后必须追加真实 IP 验证。
- 开源试玩之前只适配本机，坦克 2567 与冒险 8093 必须改为同源代理路径；这些内部端口不得公网开放。不会修改原 11 款房间协议。

## 执行切片与验证
1. 审查并冻结主目录待发布快照，确认第三方许可与服务风险；变更中的输入必须复核，不覆盖。
2. HTTP 拼豆兼容：事务存储、异步保存中的新编辑仍标记 dirty、损坏/配额/并发/迁移及非安全源测试。
3. 在任务 worktree 集成已审查 arcade 快照，同源路由与内部服务，运行拼豆、arcade、全平台和发布所需联机回归。
4. 只提交明确 task-owned/已授权文件；主目录合并前验证快照无漂移。不把其他 dirty 文档广泛暂存，不隐式 stash。
5. 本地构建固定版本包，上传服务器独立 release 目录，安装已批准运行环境；常驻服务只对外开放 8881。验证公网 HTTP、/health、旧游戏 WebSocket、两款独立服务与拼豆自动恢复。
6. 项目记录真实版本/端口/目录/systemd/回滚；只在部署已验证后编写 Skill。Skill 要先做无技能场景基线、再做带技能场景验证与发现索引检查；不自动 push 规则仓库。

## 当前检查点
- 已完成：服务器只读核验；主目录来源与启动边界初读；HTTP 事务 owner；模型 19/19、浏览器 23/23 通过（包括真实非安全源、存储策略解除后重试、旧版无损迁移）。触摸色盘/工具幂等 pointerup 选择修复快速拖动后的兼容 click 抑制，正式验收已删除 500ms 等待。
- 主目录已由其他任务独立提交：034c9550660c1d71179af15a1d47e1e423fe9565（feat: integrate four open-source arcade games for local play），当前只有 docs/ 未跟踪。初始 patch/path 快照为空是因为该提交已落地，不作为代码证据；后续集成以固定提交为准。
- 素材求证：Sketchfab 官方模型 API 返回 Pixel Tank / Firewarden3D 为 CC-BY-4.0，需署名、允许商用；后续必须把出处、许可与修改说明落可访问署名页，不只在内部日志声称已确认。
- Skill 基线只读场景已通过原生前台子 Agent 执行（dispatch 后台因宿主 owner 错误不可用，未盲重试）；给出了通用安全建议，但未知本项目服务名/路径/回滚命令，部署后作为参考检索场景验证。
- 活动：将已验收拼豆提交并集成固定 arcade 提交，处理同源代理和素材署名；不创建新 worktree。
- 未开始：运行环境安装、服务器写入/部署、Skill 写入。
- 不声明已发布；缺少任一目标验证时保持 needs-verification。
