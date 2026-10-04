# 赛博拼豆：本地存档版实施计划

## Goal
实现用户已确认的单人自由拼豆、本地自动存档、多作品命名、撤销重做、PNG 导出和存档导入导出，接入 LinkPlay 大厅。

## Architecture / Tech Stack
沿用原生 HTML/CSS/JavaScript 和现有 Express 静态托管；Canvas 2D 绘制有孔拼豆。纯数据规则由 `beads-model.js` 唯一持有；`beads-app.js` 负责页面交互、会话撤销历史、本地存档与下载。无新依赖，无服务端状态、账号或云存档。

## Baseline / Authority Refs
- 用户已选「做本地存档版」；批准的功能为选色、点击/拖动、擦除、撤销重做、多幅作品命名、本地自动恢复、PNG 与存档导入导出。
- 已读 README.md、package.json、server.js、index.html、styles.css、tests/run-all.cjs、tests/platform-regression.cjs、tests/lobby-smoke.cjs。
- README 的游戏架构说明与现行权威服务并非完全同步，本次不改旧游戏架构，只新增独立单人创作入口。
- 未发现项目 AGENTS.md 或现有拼豆模块。

## Compatibility Boundary
不修改 WebSocket 协议、房间、鉴权、联机规则和生产环境。保留大厅原有 11 个入口，增加第 12 个。沿用 `.back-link` 和 `window.render_game_to_text` 健康检查契约。

## TaskStartSnapshot
- 根：D:/Dev/psn_game_platform
- HEAD：9952ab5a5f337f1ed1de72103467701075ac3646
- 分支：main；upstream：origin/main；分歧：0/0
- 开始时 staged/unstaged/untracked 均为空；唯一 worktree 为当前根。
- 不创建分支，不 stash/reset/clean，不提交或推送（未获得用户提交授权）。

## TDD Route
- Mode: off
- Decision: skipped
- Strict authority: not applicable
- Test posture: post-change regression
- Reason: 用户未要求测试先行；新增核心算法、文件校验与浏览器持久化仍必须有自动回归。
- Verification: Node 单元测试 + Playwright 实际浏览器验收 + 现有全平台入口回归。

## Change Necessity / Owner Fit
现有游戏不提供自由像素创作或长期作品保存，配置和文档无法满足需求。最小充分改动是新增独立拼豆页面、专用样式、纯模型、控制器和测试；大厅只新增入口，共享样式只新增卡片图案。新持久化状态仅由该页面持有，不复用短生命周期房间状态。

## 数据与存档契约
- `STORAGE_KEY = linkplay.beads.v1`；全部作品在一个 localStorage 键中原子保存。
- Archive：`{format:'linkplay-beads', version:1, revision, activeId, works}`。
- Work：`{id, name, size, cells, createdAt, updatedAt}`；cells 为行优先 `size*size` 数组，每格 null 或 #RRGGBB。
- 棋盘尺寸 16/24/32/48/64；最多 30 幅；名称 1–60 字符；导入文件最多 2 MB。
- 导出单幅作品格式为 `{format:'linkplay-beads-work', version:1, work}`。界面的「备份存档」导出整个 Archive。
- 导入接受整库与单幅文件；先完整验证再合并，重新分配 id，不替换既有作品；容量不足拒绝整个导入。
- 画笔拖动用直线插值补齐采样空隙；同一次拖动只计一次撤销。填充四邻接、不跨行。
- 撤销/重做仅属于当前会话，最多 80 步，切换作品清空；作品内容和名称持久化。
- 自动保存以完整笔画为单位，页面隐藏/离开时也结算当前笔画；名称变化即时保存。
- 存档损坏不能静默覆盖：保留原始数据，提供导出原数据/明确确认后的重建。
- 存储不可用/配额满必须显示未保存，并保留内存内容及下载备份入口；不同标签页发生竞争时禁止旧快照覆盖新存档，提供备份后重载。

## 视觉与交互
- 色板：雾蓝 #EEF1F6、纸白 #FFFFFF、墨蓝 #202A43、紫罗兰 #7768D8、草莓 #F27593、薄荷 #6CBEAF。
- 中文采用微软雅黑/苹方，数字与操作标签采用 Segoe UI；不加载外网字体或图片。
- 布局：顶部作品名与保存状态；左侧色盘/工具，中间深墨色打孔板，右侧作品列表/模板。窄屏顺序为色盘、画板、作品。
- 特征集中在环状实体豆子和有刻度的打孔板，不采用泛用赛博霓虹卡片堆砌。页面保持直接动词，不加入导游式副标题。
- 首次打开提供一幅可编辑「像素花园」；可新建空白作品，模板使用新作品而非覆盖。
- 支持触摸、键盘方向移动与空格放豆、Delete 擦除、快捷撤销；所有非画板交互用语义按钮与可见焦点。

## Files / Tasks
1. **纯模型与规则测试**（独立范围：beads-model.js、tests/beads-model.cjs）
   - 暴露浏览器 `BeadModel` 与 CommonJS；提供 PALETTE/SIZES/FORMAT/VERSION/STORAGE_KEY/MAX_WORKS/MAX_FILE_BYTES。
   - 提供 createWork、validateWork、validateArchive、parseArchive、serializeArchive、exportWork、parseImport、paintLine、floodFill、countColors。
   - 验证合法往返、尺寸与颜色安全、版本/长度/id/日期/活动作品拒绝、导入原子性、斜线补点与填充边界。
   - 命令：`node --test tests/beads-model.cjs`，应执行非零数量且全部通过。
2. **拼豆视图与控制器**（beads.html、beads.css、beads-app.js）
   - 创建画板、24 色盘与自定义颜色、画笔/擦除/填充/取色、撤销重做、缩放、豆子/像素预览、颜色数量统计。
   - 创建命名作品、新建/复制/删除确认、模板库；实现自动存档、恢复、错误状态和并发保护。
   - 实现 PNG 下载、整库存档下载、安全导入；不把用户名称放进 innerHTML。
   - 命令：`node --check beads-app.js` 与浏览器验收。
3. **大厅、文档与测试入口接入**（index.html、styles.css、README.md、package.json、tests/run-all.cjs、tests/platform-regression.cjs）
   - 新增第 12 个拼豆入口；专属卡片图案；其余游戏功能不变。
   - platform-regression 明确期望 12 个入口，追加 beads.html；保持原有页面健康、返回大厅与在线游戏检查。
   - 添加 `test:beads`，全量 runner 注册模型与浏览器测试。
   - README 增加单人拼豆、本地存档与备份限制说明，不重写历史架构。
4. **浏览器验收与收尾**（tests/beads-browser.cjs）
   - 使用现有 Playwright；未注入 BASE_URL 时自行启动临时本地服务并 finally 关闭，不触达外部环境。
   - 验证大厅进入、鼠标点击/连续拖动/擦除/填充/撤销重做/键盘、命名、多作品切换、刷新与上下文恢复。
   - 下载 PNG 并核对签名/尺寸；备份后在新浏览器导入并核对内容；无效/超大导入不破坏现有作品。
   - 验证存储异常、损坏不覆盖、多标签页并发保护、375px 触摸和无横向溢出、64 格缩放。
   - 命令：`npm run test:beads`；`node tests/platform-regression.cjs`；`git diff --check`。
   - 截图输出到 ignored outputs/；审查桌面和移动截图。

## Execution Readiness / Review
意图锁为已批准的本地单人版；范围围栏为上述文件；基线锁为起始 HEAD 和现有静态页面模式。模型子任务有确定契约、独立文件范围，其余工作由主线程完成。主线程先做规格复核，再做质量/错误边界复核；任何并发改动不覆盖。最终以运行证据而非子任务报告判定完成。

## Risks / Rollback / Retirement
- 本地存档限定同一浏览器与源；清除浏览器数据会删除，下载备份用于恢复和人工迁移。
- 不自动清理用户作品，不自动迁移未知版本，不承诺云同步。
- 回滚代码只撤销本次独立页面及接入；不删除浏览器的用户存档。
- 无旧拼豆 owner 或兼容路径需退役；不新增服务端适配层。

## Checkpoint
当前：方案已获用户批准，基线已读，模型与视图进入实现。验证尚未执行。结束时在本记录追加测试结果与未完成项。
