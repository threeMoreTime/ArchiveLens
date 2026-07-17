# 项目全量审阅、分优先级优化与分支开发报告

审阅与集成日期：2026-07-16 至 2026-07-17
项目：ArchiveLens
初始可信基线：955646a67bebdebeeff7ed46ef2bdcea75d839e8
当前本地 main：d60382cae3d2407f958b95119363c592e6bda6ff
最新完整门禁代码候选：721141fa168e33c43ba1d8d984936d9959bdbe4a
当前修复与报告分支：codex/fix/p1-release-gate-electron-bootstrap
审阅范围：产品、核心流程、UI/UX、前端、Electron 主进程、Python OCR 引擎、SQLite 数据层、IPC、安全、性能、测试、构建、打包和发布

## 证据口径

- 已确认事实：来自当前运行行为、当前源码、成功或失败的可复现命令、Git 状态或 CI 结果。
- 基于证据的推断：由多项事实推导，但未在真实用户或生产环境中直接验证。
- 尚未实现的规划：文档或建议存在，但当前代码与运行行为不提供该能力。
- 当前无法确认：缺少所有权、环境、真实数据、发布账号或生产条件，不能安全下结论。
- 需要人工决策：存在产品、数据、安全、许可证、发布或重大兼容性取舍；HR-01 至 HR-04 已按用户明确决定执行，其他项目及正式发布等不可逆动作仍保持人工门禁。

原 B-01 至 B-12 的成果已按用户精确授权以 `--ff-only` 快进到本地 main，并在 `d60382ca` 上完成合并后完整门禁。随后发现的 Electron 首次安装并发缺陷已在 B-13 修复并完成冷状态完整门禁，但尚未获得合入 main 的新授权。

### 2026-07-17 合并与门禁执行补录

| 项目 | 结果 |
| --- | --- |
| 本地 main 合并 | `955646a6` → `d60382ca`，执行 `git merge --ff-only d60382ca...` 成功，无合并提交；工作树干净 |
| 远程差异 | 本地 main 相对 `origin/main` ahead 20、behind 0；未推送 |
| main 合并后门禁 | `d60382ca` 的 29/29 步通过；证据目录 `F:\OCR\.tmp\release-gate\d60382cae3d2407f958b95119363c592e6bda6ff\20260717T070718Z` |
| main 门禁前置失败 | 第一次缺少离线锁定 OCR 模型缓存；第二次由三个 Vitest 进程并发触发 Electron 首次安装而发生 Windows 目录竞争；均保留失败证据且未降低标准 |
| B-13 修复 | 分支 `codex/fix/p1-release-gate-electron-bootstrap`；提交 `721141fa168e33c43ba1d8d984936d9959bdbe4a`；在冻结安装后、并行测试前串行执行 Electron 运行时准备 |
| B-13 冷状态门禁 | 从无 `node_modules`、无 Electron `dist` 的独立 worktree 开始，30/30 步一次通过；证据目录 `F:\.zcf\OCR\release-gate-electron-bootstrap\.tmp\release-gate\721141fa168e33c43ba1d8d984936d9959bdbe4a\20260717T072436Z` |
| B-13 测试规模 | 桌面 Vitest 24 文件、138 项通过；Python 278 项通过、1 项因无 `pwsh` 跳过；Playwright 25/25 通过 |
| B-13 制品验证 | Setup、Portable、`win-unpacked`、打包引擎、manifest、SHA256SUMS、安装/启动/卸载、Portable 清理和同 SHA 链全部通过 |
| 真实文档与人工核查 | `e878ccca` 打包引擎完成 993/993 页、失败 0；简体查询“亏空”在仅简体范围 0 条、仅繁体范围 32 条、简繁范围 32 条；32 条分布于 20 页并由用户逐项人工核查通过 |
| 费用与外部动作 | 金额 0；已执行用户授权的本地 main 快进；未推送、未创建 PR、未签名购买、未部署、未正式发布 |
| 数据安全边界 | 测试使用隔离目录，未读写真实用户数据库；本地 main schema 已为 v7，而远程 `origin/main` 仍为 v6，源码或分支回退不能作为已验证的数据回滚方案 |

组合验证期间记录到三项可复现的前置条件问题：Electron 首次并发加载造成本地二进制安装目录竞争；新 worktree 未准备锁定 OCR 模型；未打包时 `vertical.spec.ts` 找不到 `win-unpacked/ArchiveLens.exe`。锁文件模型准备和完整本地门禁已覆盖后两项；Electron 目录竞争进一步形成 B-13 的永久串行准备修复。所有最终命令均通过，未通过修改断言、跳过测试或降低标准规避失败。

## 1. 执行摘要

- 项目定位：ArchiveLens 是本地优先的 Windows 桌面档案 OCR、检索、校对和导出工具，支持 PDF、DjVu/DJV、TIFF、JPEG、PNG，并以 React/Electron 桌面端、Python OCR 引擎和 SQLite 本地数据组成完整链路。
- 当前开发阶段：0.1.0-alpha.11；核心能力已超过静态原型，真实引擎、数据库、任务恢复、校对和导出均已接通，但仍属于受控 Alpha，而非稳定版。
- 核心业务闭环：导入或扫描 → 配置检索 → OCR 执行 → 查看进度与恢复 → 校对 → JSON/HTML 导出 → 历史管理，主链路已形成；HR-01 已把继续操作收紧到可信恢复状态，组合候选 `e878ccca` 已完成 993 页真实 PDF 全量 OCR、简繁范围检索和人工原图核查。
- 真实用户使用条件：本地 main 已包含本轮 P0/P1、HR 与统一简繁检索成果，适合开发者或受控测试者在已知限制下使用；由于稳定发布门禁仍有人工阻塞，不适合直接声明面向普通用户稳定可用。
- 稳定发布条件：本地零成本候选门禁已通过，但稳定公开发布仍不具备。正式发布未获授权，跨版本升级/回滚未用上一可信安装包验证，公开分发许可证批准仍为显式阻塞。
- 问题总数：27。
- 优先级：P0 1；P1 9；P2 13；P3 4。
- 当前执行分类：可自动实施 13；需要人工审核 13；被其他任务阻塞 0；状态无法确认 1。HR-02 和 HR-04 的技术实施已完成，但正式发布授权和公开许可证批准仍属于人工审核。
- 已创建本地分支：14 个，其中 12 个实现/修复分支、1 个原报告分支、1 个组合集成分支。
- 已完成开发批次：13 个；B-01 至 B-12 已进入本地 main，B-13 已完成冷状态同 SHA 门禁并可审核，但尚未合入 main。
- 最严重三项：
  1. 当前 main 的零成本门禁在全新依赖状态下可能由并行 Vitest 触发 Electron 首次安装目录竞争；B-13 已修复并完成冷状态门禁，但尚未合入 main。
  2. 稳定公开发布仍被正式发布授权、真实跨版本升级/回滚和公开许可证批准三项门禁阻塞，不能把本地门禁通过描述为已可发布。
  3. 本地 main 数据库 schema 已升至 v7，而远程 `origin/main` 仍为 v6；升级测试通过，但从新源码回退到旧源码的数据兼容性没有验证，不能把 Git 回退等同于数据回滚。
- 推荐下一步：人工审阅 B-13 的 3 文件小范围差异并单独决定是否允许本地合并；公开发布前仍须完成跨版本升级/回滚、冻结候选许可证批准和正式发布授权。

## 2. 项目与 Git 基线

| 项目 | 结果 |
| --- | --- |
| 仓库路径 | F:\OCR |
| 初始分支 | main |
| 初始 HEAD | 998334842d7660c07c5339b58c5934a2c3b66747 |
| 初始上游 | origin/main；初始 ahead/behind 为 0/0 |
| 远程默认分支 | origin/main |
| 工作区初始状态 | 不干净，存在 4 个用户未暂存文件；无本轮代理暂存内容 |
| 初始未提交改动 | apps/desktop/e2e/custom-search.spec.ts、apps/desktop/tests/offlinePackaging.spec.ts、docs/native-dependencies.md、scripts/prepare-native-runtime.ps1；78 行新增、15 行删除 |
| 用户改动保护 | 未暂存、未覆盖、未回滚、未清理。审阅期间外部并发流程将同一组改动形成 3 个提交并更新 main；本轮随后将 955646a6 作为新可信基线 |
| 并发提交 | b5e42d29、691d31e9、955646a6 |
| 当前本地基线 | main = d60382cae3d2407f958b95119363c592e6bda6ff；origin/main = 955646a67bebdebeeff7ed46ef2bdcea75d839e8；ahead/behind 20/0；工作区干净 |
| 多 worktree | 已确认存在；审阅与集成阶段共创建 14 个分支 worktree，最新 B-13 位于 F:\.zcf\OCR\release-gate-electron-bootstrap。另有多个历史 prunable 记录，未清理 |
| 技术栈 | 基线 main 为 Electron 31.4；最终候选链为 Electron 43.1.1。其余主要栈为 React 18.3、TypeScript 5.5、Vite 5.4、Fluent UI、Zustand、Zod、Python 3.11、SQLite WAL、RapidOCR/ONNX、Tesseract、PDFium、DjVuLibre |
| 运行环境 | Node 24.3.0、pnpm 11.10.0、Python 3.11.9、Windows PowerShell 5.1；pwsh 未安装 |
| 主要入口 | apps/desktop/src/main、preload、renderer；engine/src/archivelens_engine；packages/ipc-schema |
| 启动命令 | pnpm dev；开发引擎由 AL_ENGINE_DEV 指向 Python 3.11 |
| 测试命令 | pnpm typecheck；pnpm test；Python unittest；Playwright Electron E2E |
| 构建命令 | pnpm build；scripts/build-engine.ps1；electron-builder 打包脚本 |
| 当前启动/运行状态 | Electron 主流程、生命周期、检索、校对、Setup/Portable smoke、打包 OCR 和 993 页真实 PDF OCR 均有成功证据 |
| 当前已知阻塞 | B-13 尚待人工代码审核与本地合并授权；稳定公开发布缺正式授权、跨版本升级/回滚证据和公开许可证批准 |

### 基线验证记录

| 检查 | 结果 | 证据等级 |
| --- | --- | --- |
| pnpm install --frozen-lockfile | 通过 | VERIFIED |
| pnpm typecheck | 通过 | VERIFIED |
| pnpm test | 24 个测试文件、138 项通过 | VERIFIED |
| Python unittest | 278 项通过、1 项因 pwsh 不存在而跳过 | VERIFIED |
| pnpm lint | 命令通过，但实际仅别名到 typecheck，不是 ESLint | VERIFIED |
| pnpm build | 通过；renderer 单一 JS 约 1,226.64 kB，CSS 约 48.55 kB | VERIFIED |
| Playwright 完整套件 | 25/25 通过，含生命周期、自定义检索、校对完整性和打包垂直流程 | VERIFIED |
| npm 生产依赖审计 | 未发现已知漏洞 | VERIFIED |
| 最新基线 CI | GitHub Actions run 29432555154 全部现有 job 成功 | VERIFIED |
| 基线 SHA 发布链验证 | 失败：955646a6 与旧制品 5f6c03f7 不一致 | VERIFIED |
| 组合候选完整零成本门禁 | e878ccca 的 29 个步骤通过；Setup/Portable、manifest、同 SHA 链均通过；公开许可证边界按设计阻塞 | VERIFIED |
| 组合候选真实文档检索 | e878ccca 打包引擎完成 993/993 页、失败 0、OCR 行 33,962；“亏空”仅简体 0 条、仅繁体 32 条、简繁范围 32 条；32 条原图/OCR/上下文/真实词语命中经用户人工核查通过 | VERIFIED（运行与检索）/ HUMAN-VERIFIED（人工核查） |
| 本地 main 合并后完整门禁 | d60382ca 的 29/29 步通过；Setup/Portable、25 项 E2E、安装/卸载和同 SHA 链通过 | VERIFIED |
| B-13 冷状态完整门禁 | 721141fa 从无 node_modules、无 Electron dist 开始 30/30 步通过；首次安装并发缺陷未再复现 | VERIFIED |
| 正式安装、升级和回滚 | 本地 Setup 安装/启动/卸载与 Portable 启动/清理通过；跨版本升级/回滚未验证 | VERIFIED（本地 smoke）/ NOT VERIFIED（跨版本） |

## 3. 项目现状

| 范围 | 当前状态 | 主要结论 |
| --- | --- | --- |
| 产品定位 | 已完成并验证 | 本地优先、Windows 档案 OCR/检索/校对/导出的定位清楚，欢迎页和用户文档一致 |
| 核心功能 | 已完成但未充分验证 | 主链路真实接通；993 页 PDF 全量 OCR 通过；超大任务控制、删除残留和公开发布仍有缺口 |
| 用户流程 | 部分完成 | 正常路径闭环完整；HR-01 恢复合同已收紧，超大导出取消和删除残留治理未完全闭环 |
| UI 与交互 | 已完成但未充分验证 | 视觉体系一致、主操作清楚；本地 main 已修复校对输入快捷键误触和状态文案缺口，最小窗口下校对密度仍高 |
| 工程质量 | 部分完成 | 进程边界和 IPC 契约较清晰，但存在超大模块、无真实 lint、单 bundle 偏大 |
| 数据与安全 | 部分完成 | SQLite 迁移、事务、WAL、路径校验基础较好；本地 main 已修复导航/CSP 与资源联接越界问题；静态数据未加密，v7 → v6 数据回退未验证 |
| 性能与稳定性 | 已完成但未充分验证 | 分页、进度、任务恢复、日志轮转、sidecar 清理已在分支覆盖；993 页连续 OCR 通过，磁盘满和多小时压力仍未验证 |
| 测试体系 | 已完成但未充分验证 | 单元、Python、Electron E2E、CI 和本地完整发布门禁均存在；真实 lint 与覆盖率预算仍不足 |
| 构建与发布 | 部分完成 | 最终候选的 Setup/Portable/manifest 同源验收已通过；跨版本升级/回滚、公开许可证批准和正式发布授权仍缺失 |

## 4. 核心功能完成度

| 模块或功能 | 当前状态 | 已完成内容 | 主要缺口 | 验证依据 |
| --- | --- | --- | --- | --- |
| 欢迎与演示 | 已完成并验证 | 产品价值、三步流程、示例入口 | 无核心缺口 | UI 截图、renderer 测试、E2E |
| 来源选择与任务创建 | 已完成并验证 | 文件夹、单文件、多文件、格式校验、字面量检索 | 文件夹无限规模策略未定 | custom-search E2E、IPC/引擎测试 |
| OCR 执行与生命周期 | 已完成并验证 | 启动、暂停、继续、取消、可信恢复状态、进度；993 页真实 PDF 完成 | 磁盘满和多小时中断恢复未验证 | lifecycle E2E、HR-01 测试、真实文档任务 |
| 任务中心与历史 | 已完成并验证 | 搜索、筛选、继续、删除、状态展示 | 删除后文件清理失败语义未定 | renderer 测试、引擎数据测试、UI 截图 |
| 校对工作台 | 已完成并验证 | 分页、筛选、检索、决策、备注、页图、旋转、证据 | 信息密度高；批量决策能力未定义 | review-completeness、real-OCR E2E |
| JSON 导出 | 已完成并验证 | 完整结果、完整性信息、历史 | 极大任务取消/恢复策略未定义 | Python 导出测试、E2E |
| HTML 导出 | 已完成但未充分验证 | 自包含报告、进度、体积预警 | 原 30 秒 IPC 超时；修复分支改为 30 分钟，但仍无用户取消 | 单元测试、B-03 |
| 设置 | 已完成并验证 | OCR 与校对配置、本地持久化 | 依赖升级后的兼容性待验证 | UI 截图、renderer 测试 |
| 诊断 | 已完成但未充分验证 | 引擎和原生依赖自检、日志入口 | 本轮视觉证据只覆盖加载态 | E2E、单元测试、UI 截图 |
| 数据迁移与恢复 | 已完成并验证 | schema 迁移、未来版本拒绝、事务回滚、WAL | 真实历史大库升级未验证 | Python 单元/集成测试 |
| 安装与发布 | 部分完成 | 最终候选 win-unpacked、Setup、Portable、manifest、哈希、安装/启动/卸载和清理 smoke 通过 | 未验证跨版本升级/回滚；公开许可证批准和正式发布授权缺失；无已发布 GitHub Release | 零成本门禁摘要、verify-release-chain、本地 smoke |

## 5. 核心用户任务

| 用户任务 | 当前流程 | 完成状态 | 使用难度 | 主要问题 |
| --- | --- | --- | --- | --- |
| 理解产品并开始 | 启动 → 欢迎页 → 阅读本地处理与三步说明 → 新建扫描或演示 | 已完成并验证 | 低 | 1280 高度下部分流程卡片需下滚，不阻塞 |
| 导入档案并配置检索 | 新建扫描 → 选来源 → 输入字面量 → 校验 → 创建任务 | 已完成并验证 | 中 | 文件夹规模没有预检/软限制决策 |
| 执行并管理长任务 | 创建 → 运行 → 查看进度 → 暂停/继续/取消 → 异常恢复 | 已完成并验证 | 中 | HR-01 已收紧 failed/stale 合同并进入本地 main；磁盘满/强制崩溃后的 993 页恢复未验证 |
| 搜索并校对结果 | 任务 → 校对 → 检索/筛选 → 查看页证据 → 决策/备注/旋转 | 已完成并验证 | 高 | 快捷键输入误触已修复并进入本地 main；最小窗口信息密集 |
| 导出并核验结果 | 校对/任务 → 导出 → 选 JSON/HTML → 查看进度 → 打开历史 | 已完成但未充分验证 | 中 | 超大 HTML 原 30 秒超时；仍缺用户取消和恢复 |
| 管理历史与排障 | 任务中心 → 搜索/筛选 → 删除；设置 → 诊断 → 日志 | 已完成但未充分验证 | 中 | 删除数据库成功但文件清理失败时的契约未定 |
| 安装、升级与回滚 | 获取 Setup/Portable → 安装/启动 → 升级/回退 | 部分完成 | 高 | 同 SHA 安装/启动/卸载和 Portable 清理已验证；跨版本升级/回滚仍未验证 |

## 6. 全部问题总览

| 编号 | 页面/模块 | 问题 | 类别 | 优先级 | 执行分类 | 是否阻塞稳定版 |
| --- | --- | --- | --- | --- | --- | --- |
| A-SEC-01 | Electron 导航/CSP | 生产模式空 DEV_SERVER_URL 导致 startsWith 空串接受任意 URL；生产 CSP 保留 unsafe-eval 与开发连接源 | 安全 | P0 | 可自动实施 | 是 |
| A-UX-01 | 校对工作台 | 搜索、备注或可编辑控件输入 A/S/D/J/K/N/F 会触发全局快捷键 | 交互/数据正确性 | P1 | 可自动实施 | 是 |
| A-REL-01 | Sidecar 启动 | ready 超时后 waiter 和子进程未可靠清理，重试可形成重复进程 | 稳定性 | P1 | 可自动实施 | 是 |
| A-REL-02 | HTML 导出 | 大型导出复用通用 30 秒 IPC 超时，与 UI 的大文件预警和进度能力冲突 | 稳定性/功能闭环 | P1 | 可自动实施 | 是 |
| A-REL-04 | 零成本发布门禁 | 全新依赖状态下多个 Vitest 进程会并发触发 Electron 首次安装，在 Windows 上竞争创建 dist/resources 目录 | 测试/发布门禁 | P1 | 可自动实施 | 是 |
| A-QA-01 | 校对 E2E/CI | 大量结果用超长 Python -c 参数，在长 Windows 路径触发 spawn EINVAL，且套件未纳入 CI | 测试/发布门禁 | P1 | 可自动实施 | 是 |
| H-REC-01 | 任务恢复 | failed/stale 恢复合同不一致；HR-01 已批准收紧并在 B-08 完成 | 产品/数据语义 | P1 | 可自动实施 | 是 |
| H-REL-01 | 发布链 | HR-02 零成本同 SHA 门禁已完成；正式发布授权、公开许可证批准和跨版本升级/回滚仍缺失 | 发布 | P1 | 需要人工审核 | 是 |
| H-DEP-01 | Electron/依赖 | HR-03 第一阶段已将 Electron 31.4 升至 43.1.1 并通过门禁；后续工具链/前端升级另行分批 | 依赖/安全 | P1 | 可自动实施 | 是 |
| H-LIC-01 | DjVuLibre 分发 | HR-04 技术合规包已完成并默认阻止公开发布；最终公开许可证批准仍需人工作出 | 许可证/发布 | P1 | 需要人工审核 | 是 |
| A-OPS-01 | 应用/引擎日志 | app.log 与 engine.log 无大小上限，可长期增长占满磁盘 | 稳定性/运维 | P2 | 可自动实施 | 否 |
| A-UX-02 | 任务状态 | stopping/stale 文案未本地化、筛选不完整、stopping 可重复取消 | UI/交互 | P2 | 可自动实施 | 否 |
| A-REL-03 | 校对资源 | 校对结果请求可能先于任务资源根注册，存在首屏资源竞态 | 稳定性 | P2 | 可自动实施 | 否 |
| A-SEC-02 | app-resource 协议 | 仅做词法路径检查，Windows junction/symlink 可把合法联接路径解析到根目录外 | 安全 | P2 | 可自动实施 | 否 |
| H-UX-01 | 窗口/校对布局 | BrowserWindow 最小 1080×680；该尺寸下三栏校对可用但拥挤，窄窗口无法进入 | UI/兼容性 | P2 | 需要人工审核 | 否 |
| H-PERF-01 | Renderer 构建 | 单一 JS bundle 约 1,181.83 kB，缺少性能预算和拆包目标 | 性能 | P2 | 需要人工审核 | 否 |
| H-QA-01 | 静态质量 | pnpm lint 实际等于 typecheck，未配置 ESLint 或同等静态规则 | 测试/工程 | P2 | 需要人工审核 | 否 |
| B-QA-01 | vertical E2E | 旧套件依赖固定 release/win-unpacked 产物与路径；B-11 已改为当前候选可复现并纳入完整门禁 | 测试 | P2 | 可自动实施 | 否 |
| H-SCALE-01 | 文件夹扫描 | 显式多选限制 200 个文件，文件夹递归没有规模预检或软限制 | 性能/产品 | P2 | 需要人工审核 | 否 |
| H-DATA-01 | 任务删除 | 数据库删除成功后文件系统清理失败，会形成“记录已删但返回失败/残留目录”的部分完成 | 数据一致性 | P2 | 需要人工审核 | 否 |
| H-PRIV-01 | 本地数据 | 数据库、OCR 结果和导出默认明文保存，威胁模型与保留策略未明确 | 隐私 | P2 | 需要人工审核 | 否 |
| H-EXP-01 | 超大导出 | 即使放宽超时，用户仍不能取消、恢复或明确清理中断临时文件 | 功能/稳定性 | P2 | 需要人工审核 | 否 |
| H-OPS-01 | 发布运维 | CI actions 使用浮动标签；零成本 release gate 已建立，但稳定公开分发的签名策略、升级、回滚和正式授权仍未闭环 | 供应链/发布 | P2 | 需要人工审核 | 是 |
| H-ARCH-01 | Python/Renderer | report_pipeline.py、store.py、server.py、ReviewPage.tsx 等文件过大，职责集中 | 架构/维护性 | P3 | 需要人工审核 | 否 |
| H-QA-02 | 覆盖率 | 有大量测试但无覆盖率门槛、关键风险覆盖地图或趋势门禁 | 测试治理 | P3 | 需要人工审核 | 否 |
| U-GIT-01 | Git worktree | 多个历史 worktree 标记 prunable，但所有权和保留目的无法从仓库确认 | Git/维护 | P3 | 状态无法确认 | 否 |
| H-UX-02 | 高频校对 | 缺少多选批量决策、批量备注或可配置快捷键；是否需要属于产品取舍 | 产品/效率 | P3 | 需要人工审核 | 否 |

## 7. 自动实施批次总览

原 B-01 至 B-08 均可从 955646a6 独立审阅；B-09 基于 B-01，B-10 基于 B-09，B-11 基于 B-10。B-12 汇合全部有效成果并已快进到本地 main。B-13 基于合并后 main，仅修复完整门禁中的 Electron 首次安装并发问题，尚未合入 main。

| 批次 | 分支 | 优先级 | 问题范围 | 状态 | 提交 | 验证结果 |
| --- | --- | --- | --- | --- | --- | --- |
| B-01 | codex/fix/p0-renderer-security-boundary | P0 | A-SEC-01 | 已完成 | 925c6c9b7e8ff448cb751180077ad34b15329e87 | targeted、typecheck、全量桌面测试、build、生产 E2E 通过 |
| B-02 | codex/fix/p1-review-shortcut-safety | P1 | A-UX-01 | 已完成 | 93f020b56a49178904868b93660c4f291b59013c | targeted、typecheck、全量桌面测试、build、校对 E2E 通过 |
| B-03 | codex/fix/p1-sidecar-timeout-recovery | P1 | A-REL-01、A-REL-02 | 已完成 | 377d87e00ffb68e7c3e26097aa517e04777f9a90 | targeted、typecheck、全量桌面测试、build、崩溃恢复 E2E 通过 |
| B-04 | codex/test/p1-review-e2e-gate | P1 | A-QA-01 | 已完成 | 37ae11fc6d23fa73e022d8850154305f0a48d83d | 长路径先复现失败，修复后 3/3；typecheck、build、脚本/YAML 检查通过 |
| B-05 | codex/fix/p2-bounded-log-retention | P2 | A-OPS-01 | 已完成 | 43761b5de26fd7a6ce8e9e53b2d2a4e46a4fc440 | targeted、typecheck、全量桌面测试、build 通过 |
| B-06 | codex/fix/p2-renderer-state-consistency | P2 | A-UX-02、A-REL-03 | 已完成 | e989db49300d9d1f9a740871cdb3ed89ef899924 | targeted、typecheck、全量桌面测试、build、自定义检索 E2E 通过 |
| B-07 | codex/fix/p2-resource-protocol-containment | P2 | A-SEC-02 | 已完成 | 5e6143167ca93216f926b7d37ac84173a6f06f68 | targeted、typecheck、全量桌面测试、build、真实 OCR E2E 通过 |
| B-08 | codex/fix/p1-task-resume-contract | P1 | H-REC-01 / HR-01 | 已完成 | befadf5666a5d4cf3228a8390f1cd9fe195ed4a5 | targeted、全量 Python、桌面测试、typecheck、build、生命周期 E2E 通过 |
| B-09 | codex/build/p1-electron-supported-upgrade | P1 | H-DEP-01 / HR-03 第一阶段 | 已完成 | cb537ff2c788fae3ab9b3e8c0ba62cee53f6d2e1 | frozen install、桌面测试、typecheck、build、21 项源码 E2E、同 SHA 打包验证通过 |
| B-10 | codex/docs/p1-djvulibre-compliance-gate | P1 | H-LIC-01 / HR-04 技术范围 | 已完成 | 97c74d1c2feceebf94b8760d8220c9e325615813 | 源码/打包技术合规门禁通过；公开批准门禁按设计阻塞；同 SHA 打包验证通过 |
| B-11 | codex/build/p1-zero-cost-release-gate | P1/P2 | H-REL-01、B-QA-01、HR-02 技术范围 | 已完成 | 01f843e4、f60ca5c3、32f00651 | 28 步零成本门禁通过；Setup/Portable 实装 smoke、25 项 E2E、同 SHA 发布链通过 |
| B-12 | codex/integration/stable-candidate-20260717 | P0/P1/P2 | B-01 至 B-11、统一简繁 OCR/索引/搜索及六个独立修复的组合 | 已完成并快进到本地 main | 9fcc6ce3、1a3ac92c、25743e2c、6e73b92c、244c7b6f、0fb8f848、e878ccca、202b198b、d60382ca | 39 项针对性测试、138 项桌面单测、278 项 Python、25 项 E2E、构建、打包、安装/卸载、29 步同 SHA 门禁及 993 页简繁检索人工核查通过；d60382ca 合并后门禁 29/29 通过 |
| B-13 | codex/fix/p1-release-gate-electron-bootstrap | P1 | A-REL-04 | 已完成；待人工审核/本地合并授权 | 721141fa | 从无依赖和无 Electron dist 的冷状态开始，30/30 步、138 项桌面单测、278 项 Python、25 项 E2E、Setup/Portable 与同 SHA 链通过 |

### 分支依赖和组合注意

- 功能依赖：B-12 已继承 B-01、B-09、B-10、B-11、HR-01 及统一简繁 OCR 分支链并进入本地 main；不得再重复合入这些祖先分支。B-13 直接基于当前本地 main，可在新授权后快进。
- 提交映射：B-08 的原提交 `befadf56` 在候选链中以补丁等价提交 `34056a9f` 存在；六个独立源提交在 B-12 中对应 `1a3ac92c`、`25743e2c`、`6e73b92c`、`244c7b6f`、`0fb8f848`、`e878ccca`。
- 文本冲突结果：`review-completeness.spec.ts`、`ReviewPage.tsx`、`TaskPage.tsx`、IPC、CI 和架构文档均由 Git 自动合并，无冲突标记；语义正确性由组合测试而非自动合并结果证明。
- 安全与稳定性：资源协议、导航/CSP、Sidecar、恢复合同、校对快捷键、日志轮转和状态一致性已在同一候选通过完整门禁。
- 人工审核入口：B-12 已完成合并；当前只需审核 B-13 的 3 个文件、16 行新增和 1 行删除。原分支保留为证据和提交来源，不应分别重复合入。

## 8. 每个开发批次详细报告

### 批次：B-01

- 分支名称：codex/fix/p0-renderer-security-boundary
- 风险级别：R2，安全边界变更；不改变业务 API 或用户数据。
- 目标：生产模式只允许应用自身导航，并将开发 CSP 能力限制在 dev 构建。
- 对应问题：A-SEC-01。
- 修改范围：主窗口导航策略、renderer CSP、Electron Vite dev 变换、窗口安全单测和生命周期 E2E。
- 未修改范围：认证、权限模型、业务流程、远程服务和数据模型。
- 前置依赖：无。
- 风险：过严 CSP 可能阻止应用启动或样式；导航白名单错误可能阻止合法页。
- 验收标准：生产应用可启动；内联脚本不能执行；data: 导航被阻止；开发 HMR 仍有显式 dev 配置。
- 测试计划：策略单测、typecheck、全量桌面测试、生产构建、生产 Electron E2E。
- 主要实现：新增结构化 URL 导航判断；生产只接受精确 file URL，开发只接受同源 URL；生产静态 CSP 去除 unsafe-eval/localhost/ws，开发由构建插件注入 HMR 所需策略。
- 新增文件：apps/desktop/src/main/security/navigation.ts；apps/desktop/tests/windowSecurity.spec.ts。
- 修改文件：apps/desktop/e2e/lifecycle.spec.ts；apps/desktop/electron.vite.config.ts；apps/desktop/src/main/windows/main.ts；apps/desktop/src/renderer/index.html。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build；Playwright 生产生命周期安全用例。
- 测试结果：相关 3 项通过；全量 17 个文件、97 项通过。
- 构建结果：通过。
- 交互或运行验证：生产 Electron E2E 1/1 通过；内联脚本未执行，data: 导航未离开应用。
- 本地提交 SHA：925c6c9b7e8ff448cb751180077ad34b15329e87。
- 遗留问题：尚未与其他分支组合验证；Electron 大版本升级另需人工决定。
- 是否可进入人工代码审核：是。

### 批次：B-02

- 分支名称：codex/fix/p1-review-shortcut-safety
- 风险级别：R1，局部交互修复。
- 目标：编辑搜索、备注、下拉框或 contenteditable 时不触发全局校对动作。
- 对应问题：A-UX-01。
- 修改范围：校对快捷键判定、ReviewPage 键盘处理、单测和 E2E。
- 未修改范围：快捷键业务含义、校对状态模型和后端。
- 前置依赖：无；与 B-04 有同测试文件的低风险整合点。
- 风险：过滤过宽可能让非输入区域快捷键失效。
- 验收标准：输入区域键入字符不改变 reviewed_count；非输入区域原快捷键继续工作；修饰键、重复键、IME 不误触。
- 测试计划：快捷键单测、typecheck、全量桌面测试、build、1000 条结果校对 E2E。
- 主要实现：抽出可测试的事件目标与按键守卫；已处理快捷键调用 preventDefault；E2E 在检索框输入 asdjknf 并校验状态不变。
- 新增文件：apps/desktop/src/renderer/src/utils/reviewShortcuts.ts；apps/desktop/tests/reviewShortcuts.spec.ts。
- 修改文件：apps/desktop/src/renderer/src/pages/ReviewPage.tsx；apps/desktop/e2e/review-completeness.spec.ts。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build；review-completeness Playwright。
- 测试结果：相关 14 项通过；全量 17 个文件、107 项通过；E2E 3/3 通过。
- 构建结果：通过。
- 交互或运行验证：1000 条结果场景输入字符后 reviewed_count 保持 0。
- 本地提交 SHA：93f020b56a49178904868b93660c4f291b59013c。
- 遗留问题：批量操作与可配置快捷键属于 H-UX-02。
- 是否可进入人工代码审核：是。

### 批次：B-03

- 分支名称：codex/fix/p1-sidecar-timeout-recovery
- 风险级别：R2，子进程生命周期与 IPC 超时变更。
- 目标：sidecar 启动失败后不遗留 waiter/子进程；大型 HTML 导出不再被通用短超时中断。
- 对应问题：A-REL-01、A-REL-02。
- 修改范围：sidecar manager、engine IPC handler、启动超时和导出超时测试。
- 未修改范围：Python 导出格式、任务状态语义、用户取消契约。
- 前置依赖：无。
- 风险：强制清理需避免误杀新进程；30 分钟上限会延长异常等待。
- 验收标准：15 秒未 ready 时移除 waiter、保留可诊断错误、终止该进程树，并在退出前阻止重复启动；HTML 导出使用显式 30 分钟上限。
- 测试计划：fake child 生命周期单测、handler 超时单测、typecheck、全量桌面测试、build、sidecar crash recovery E2E。
- 主要实现：超时路径清理 waiter 并请求进程树终止；重复启动受现有 process 引用保护；导出 handler 使用独立长任务时限。
- 新增文件：apps/desktop/tests/engineHandlers.spec.ts；apps/desktop/tests/sidecarStartupTimeout.spec.ts。
- 修改文件：apps/desktop/src/main/sidecar/manager.ts；apps/desktop/src/main/ipc/engine.ts。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build；sidecar crash recovery Playwright。
- 测试结果：相关 11 项通过；全量 18 个文件、95 项通过；恢复 E2E 1/1 通过。
- 构建结果：通过。
- 交互或运行验证：崩溃恢复场景通过。
- 本地提交 SHA：377d87e00ffb68e7c3e26097aa517e04777f9a90。
- 遗留问题：超大导出取消/恢复仍是 H-EXP-01。
- 是否可进入人工代码审核：是。

### 批次：B-04

- 分支名称：codex/test/p1-review-e2e-gate
- 风险级别：R2，CI 门禁和 E2E fixture 调整；不改变产品运行时。
- 目标：消除 Windows 长路径下的 spawn EINVAL，并把校对完整性套件纳入 CI。
- 对应问题：A-QA-01。
- 修改范围：review-completeness fixture、独立 Python seed helper、CI lifecycle job。
- 未修改范围：业务代码、测试断言强度、发布流程。
- 前置依赖：无。
- 风险：CI 时间增加；Python 解释器解析在本机和 Actions 间需兼容。
- 验收标准：长 worktree 下 1000 条结果套件可运行；CI 明确执行该套件；不使用超长 -c 参数。
- 测试计划：先在长路径复现；修复后同环境重跑；typecheck、build、Python 编译、YAML 解析。
- 主要实现：把大型 seed 逻辑移入版本化 Python helper；CI lifecycle 命令加入 review-completeness.spec.ts。
- 新增文件：apps/desktop/e2e/helpers/seed-review-task.py。
- 修改文件：apps/desktop/e2e/review-completeness.spec.ts；.github/workflows/ci.yml。
- 删除文件：无。
- 测试命令：长路径 Playwright；pnpm typecheck；pnpm build；Python py_compile；YAML parse。
- 测试结果：修复前 3/3 因 spawn EINVAL 失败；修复后长路径 3/3 通过。一次人为指定 .bat shim 导致的瞬态失败在移除无效覆盖后消失。
- 构建结果：通过。
- 交互或运行验证：1000 条结果校对流程在长 worktree 路径通过。
- 本地提交 SHA：37ae11fc6d23fa73e022d8850154305f0a48d83d。
- 遗留问题：需在真正 GitHub Actions 上观察合入后的新增 job 时间和稳定性。
- 是否可进入人工代码审核：是。

### 批次：B-05

- 分支名称：codex/fix/p2-bounded-log-retention
- 风险级别：R1，日志保留策略局部调整。
- 目标：限制应用与引擎日志磁盘占用，同时保留最近历史。
- 对应问题：A-OPS-01。
- 修改范围：logger、轮转测试、架构文档。
- 未修改范围：日志内容、敏感信息策略、诊断 UI。
- 前置依赖：无。
- 风险：过小上限可能减少故障上下文；轮转失败不能阻止主流程。
- 验收标准：app.log 和 engine.log 各最多 5 MiB，并保留一个 .1 备份；错误可容忍。
- 测试计划：轮转单测、typecheck、全量桌面测试、build。
- 主要实现：写入前检查大小，原 .1 被替换，当前文件原子式改名为 .1，日志继续写新文件。
- 新增文件：apps/desktop/tests/loggerRotation.spec.ts。
- 修改文件：apps/desktop/src/main/logging/logger.ts；docs/architecture.md。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build。
- 测试结果：相关 3 项通过；全量 17 个文件、96 项通过。
- 构建结果：通过。
- 交互或运行验证：单元级文件轮转验证；未进行长时间运行压力测试。
- 本地提交 SHA：43761b5de26fd7a6ce8e9e53b2d2a4e46a4fc440。
- 遗留问题：5 MiB 保留值是低风险默认，长期现场诊断充分性需后续观察。
- 是否可进入人工代码审核：是。

### 批次：B-06

- 分支名称：codex/fix/p2-renderer-state-consistency
- 风险级别：R1，UI 状态展示和加载顺序调整。
- 目标：完整展示任务状态，阻止 stopping 重复取消，并先注册资源根再请求校对结果。
- 对应问题：A-UX-02、A-REL-03。
- 修改范围：TaskCenter、TaskPage、ReviewPage、状态展示工具和测试。
- 未修改范围：引擎状态机、任务数据模型、恢复语义。
- 前置依赖：无。
- 风险：加载门控错误可能造成结果不请求；状态筛选必须覆盖所有 schema 值。
- 验收标准：stopping/stale 有中文展示；所有状态可筛选；stopping 不可重复取消；任务 get 完成并注册资源根后才加载校对结果。
- 测试计划：展示和顺序单测、typecheck、全量桌面测试、build、自定义检索 E2E。
- 主要实现：统一状态 presentation；增加筛选项和禁用条件；ReviewPage 以 readyTaskId 门控结果加载。
- 新增文件：apps/desktop/tests/presentation.spec.ts；apps/desktop/tests/rendererStateConsistency.spec.ts。
- 修改文件：apps/desktop/src/renderer/src/pages/ReviewPage.tsx；apps/desktop/src/renderer/src/pages/TaskCenter.tsx；apps/desktop/src/renderer/src/pages/TaskPage.tsx；apps/desktop/src/renderer/src/utils/presentation.ts。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build；custom-search Playwright。
- 测试结果：相关 22 项通过；全量 18 个文件、110 项通过；E2E 3/3 通过。
- 构建结果：通过。
- 交互或运行验证：自定义检索流程通过。
- 本地提交 SHA：e989db49300d9d1f9a740871cdb3ed89ef899924。
- 遗留问题：failed/stale 是否可操作仍由 H-REC-01 决定。
- 是否可进入人工代码审核：是。

### 批次：B-07

- 分支名称：codex/fix/p2-resource-protocol-containment
- 风险级别：R2，本地文件协议安全边界；不改变公开 IPC。
- 目标：词法路径合法但 realpath 越出任务根时拒绝读取。
- 对应问题：A-SEC-02。
- 修改范围：资源路径解析、协议 handler、junction/symlink 回归测试。
- 未修改范围：任务目录结构、用户文件写入、网络访问。
- 前置依赖：无。
- 风险：不存在文件和联接路径的错误码需保持调用方可接受。
- 验收标准：根内真实文件可读；缺失文件返回 404；junction/symlink 指向根外时拒绝。
- 测试计划：真实临时目录联接测试、typecheck、全量桌面测试、build、真实 OCR evidence E2E。
- 主要实现：保留词法 containment，再对存在目标执行 realpath 并以真实根二次 containment；协议层将缺失映射到 404。
- 新增文件：apps/desktop/tests/resourcePathSecurity.spec.ts。
- 修改文件：apps/desktop/src/main/security/paths.ts；apps/desktop/src/main/security/protocol.ts。
- 删除文件：无。
- 测试命令：相关 Vitest；pnpm typecheck；pnpm test；pnpm build；real-OCR evidence Playwright。
- 测试结果：相关 3 项通过；全量 17 个文件、96 项通过；真实 OCR E2E 1/1 通过。
- 构建结果：通过。
- 交互或运行验证：真实页图证据加载通过。
- 本地提交 SHA：5e6143167ca93216f926b7d37ac84173a6f06f68。
- 遗留问题：需在受限 Windows 用户和不同文件系统上做兼容性回归。
- 是否可进入人工代码审核：是。

### 批次：B-08

- 分支名称：codex/fix/p1-task-resume-contract
- 风险级别：R2，任务状态和恢复合同调整；不迁移或删除用户数据。
- 目标：执行已批准 HR-01 推荐方案，仅允许 paused/recoverable 进入继续流程，failed/stale 保持不可直接恢复并返回可理解错误。
- 对应问题：H-REC-01。
- 修改范围：Electron 生命周期控制器、Python 任务状态集合、恢复 handler 和回归测试。
- 未修改范围：检查点格式、数据库 schema、failed/stale 多步恢复功能和 UI 主流程。
- 前置依赖：无，直接基于 955646a6。
- 风险：旧调用方若错误依赖 failed/stale 可恢复声明，将收到明确状态冲突；该变化与当前 UI 行为一致。
- 验收标准：schema、状态机、handler 与 UI 继续操作范围一致；paused/recoverable 可恢复；failed/stale 被拒绝且不会改变任务数据。
- 测试计划：恢复相关 Python 测试、全量 Python、桌面测试、typecheck、build、生命周期 E2E。
- 主要实现：收紧可恢复状态常量；handler 对旧任务和不可恢复状态返回明确冲突；主进程只对可信恢复状态发起继续；补充不改变失败任务状态的测试。
- 新增文件：无。
- 修改文件：apps/desktop/src/main/lifecycle/controller.ts；apps/desktop/tests/lifecycleController.spec.ts；engine/src/archivelens_engine/runtime/task_state.py；engine/src/archivelens_engine/server.py；engine/tests/test_recovery_handlers.py；engine/tests/test_task_state.py。
- 删除文件：无。
- 测试命令：恢复相关 Python unittest；全量 Python unittest；pnpm test；pnpm typecheck；pnpm build；Playwright lifecycle。
- 测试结果：相关 Python 22 项通过；全量 Python 238 项通过、1 项因 pwsh 不存在跳过；桌面 93 项通过；生命周期 E2E 15/15 通过。
- 构建结果：typecheck 和 build 通过。
- 交互或运行验证：隔离生命周期套件验证暂停、继续、取消、崩溃和恢复合同，15/15 通过。
- 本地提交 SHA：befadf5666a5d4cf3228a8390f1cd9fe195ed4a5。
- 遗留问题：failed/stale 的高级恢复能力没有实现；若未来成为核心需求，仍需独立 RFC、数据兼容和中断恢复设计。
- 是否可进入人工代码审核：是。

### 批次：B-09

- 分支名称：codex/build/p1-electron-supported-upgrade
- 风险级别：R2，Electron 大版本和锁文件变更，影响安全、打包、E2E 与平台兼容。
- 目标：执行已批准 HR-03 分阶段方案的第一阶段，把 Electron 31.4 升至当时受支持稳定版本 43.1.1，不同时升级 React、Vite 等其他大版本。
- 对应问题：H-DEP-01。
- 修改范围：desktop Electron 版本、pnpm 锁文件和架构升级说明。
- 未修改范围：React/Vite/Vitest/electron-builder 大版本、renderer 拆包、产品流程和数据契约。
- 前置依赖：继承 B-01 的生产导航/CSP 安全修复，避免在新版 Electron 上继续验证旧安全边界。
- 风险：Chromium/Node 行为变化、Windows 兼容、打包输出和 E2E 选择器漂移。
- 验收标准：冻结安装可复现；typecheck、测试、build、源码 E2E 和同 SHA 打包通过；不放宽 Electron 安全默认值。
- 测试计划：pnpm install --frozen-lockfile；桌面测试；typecheck；build；源码 Playwright；打包和同 SHA 元数据验证。
- 主要实现：只升级 Electron 到 43.1.1；更新锁文件；记录支持窗口、回滚点和后续工具链分批原则。
- 新增文件：无。
- 修改文件：apps/desktop/package.json；pnpm-lock.yaml；docs/architecture.md。
- 删除文件：无。
- 测试命令：冻结安装；pnpm test；pnpm typecheck；pnpm build；Playwright 源码套件；候选打包验证。
- 测试结果：冻结安装、桌面测试、typecheck、build 和 21 项源码 E2E 通过；旧 vertical 固定制品选择器被判定为过期证据并在 B-11 重写。
- 构建结果：通过；打包 app.info 记录 Electron 43.1.1 和候选 SHA。
- 交互或运行验证：新版 Electron 下主流程和生命周期源码 E2E 通过。
- 本地提交 SHA：cb537ff2c788fae3ab9b3e8c0ba62cee53f6d2e1。
- 遗留问题：前端工具链、UI 依赖和 renderer bundle 优化尚未开始；应保持独立批次。
- 是否可进入人工代码审核：是。

### 批次：B-10

- 分支名称：codex/docs/p1-djvulibre-compliance-gate
- 风险级别：R2，许可证、打包内容和公开发布门禁；不提供法律意见，不执行公开发布。
- 目标：执行已批准 HR-04 方案，继续内置 DjVuLibre，同时建立零成本、技术可验证、默认拒绝公开发布的许可证合规包。
- 对应问题：H-LIC-01 的技术实施范围。
- 修改范围：项目许可证与第三方通知、DjVuLibre/RapidOCR 技术证据、打包许可证文件、批准模板、验证脚本、测试和 CI。
- 未修改范围：DjVuLibre 功能实现、法律结论、正式发布、付费服务和外部上传。
- 前置依赖：继承 B-09 Electron 候选链。
- 风险：技术证据不能替代权利人或法律专业人员对公开分发义务的最终确认。
- 验收标准：源码树和打包资源均包含声明、许可证、来源、版本和哈希；公开批准缺失时门禁必须失败；技术门禁不得联网或收费。
- 测试计划：源码技术合规门禁、打包技术合规门禁、严格公开批准边界、Python 回归、同 SHA 打包。
- 主要实现：增加根 MIT 许可证与第三方通知；记录 bundled DjVuLibre 对应源码和哈希；将许可证资料打入应用；新增默认 denied 的批准文件和可复现验证脚本；CI 执行技术门禁。
- 新增文件：LICENSE；docs/compliance/public-release-license-approval.json；docs/compliance/public-release-license-gate.md；engine/tests/test_license_compliance.py；scripts/verify-license-compliance.py。
- 修改文件：.github/workflows/ci.yml；THIRD_PARTY_NOTICES.md；apps/desktop/electron-builder.yml；docs/adr/0001-document-rendering-and-license-strategy.md；docs/adr/0002-bundled-native-runtime.md；docs/native-dependencies.md；docs/packaging.md；licenses/manifest.json；package.json。
- 删除文件：无。
- 测试命令：源码/打包 verify-license-compliance；严格 public gate；Python 测试；候选打包验证。
- 测试结果：源码和打包技术门禁通过；严格公开批准门禁以 BLOCKED_EXPECTED 正确阻塞；同 SHA 打包验证通过。
- 构建结果：通过；许可证和第三方材料已进入候选资源。
- 交互或运行验证：DjVuLibre 离线 smoke 在后续 B-11 完整门禁中通过。
- 本地提交 SHA：97c74d1c2feceebf94b8760d8220c9e325615813。
- 遗留问题：公开分发前必须针对冻结候选作出独立许可证批准；本报告和技术门禁不构成法律保证。
- 是否可进入人工代码审核：是。

### 批次：B-11

- 分支名称：codex/build/p1-zero-cost-release-gate
- 风险级别：R2，构建、打包、安装、清理、CI 和发布证据链；明确不执行 R3 正式发布。
- 目标：执行已批准 HR-02 范围，以零资金建立完整、同 SHA、可复验的本地发布门禁，但不推送、不签名购买、不上传、不创建 Release。
- 对应问题：H-REL-01 的技术范围、B-QA-01。
- 修改范围：发布门禁编排、Setup/Portable smoke、release chain、vertical E2E、回归测试、CI 和发布文档。
- 未修改范围：正式 release、远程分支、PR、默认分支、付费签名、生产 secrets 和跨版本真实用户数据迁移。
- 前置依赖：继承 B-01 → B-09 → B-10。
- 风险：安装/便携版 smoke 会产生本机进程、快捷方式、注册表项和临时解压目录；脚本只清理本批次可证明归属的目标，并在结束后核验无残留。
- 验收标准：冻结候选 SHA；完整源码测试和 E2E 通过；引擎、Setup、Portable、原生依赖和清单同 SHA；实际安装/启动/卸载和便携启动/清理通过；公开许可证边界仍阻塞；金额为 0。
- 测试计划：运行 scripts/run-zero-cost-release-gate.ps1 的完整 28 步，失败即停止并保留证据。
- 主要实现：新增单命令零成本门禁和结构化摘要；将 Setup/Portable smoke 改为真实安装/启动/sidecar/清理验证；加固 PowerShell 5.1 错误流、注册表缺失属性、进程竞态和 electron-builder 临时解压目录的安全清理；重写 vertical E2E 为当前候选可复现输入；release chain 要求完整候选和 smoke 证据。
- 新增文件：docs/release-gate.md；engine/tests/test_release_gate.py；scripts/release-smoke-evidence.ps1；scripts/run-zero-cost-release-gate.ps1。
- 修改文件：.github/workflows/ci.yml；apps/desktop/e2e/vertical.spec.ts；docs/packaging.md；engine/tests/test_ci_encoding.py；package.json；scripts/smoke-installer.ps1；scripts/smoke-portable.ps1；scripts/verify-release-chain.ps1。
- 删除文件：无。
- 测试命令：powershell -ExecutionPolicy Bypass -File scripts/run-zero-cost-release-gate.ps1。
- 测试结果：28 个门禁步骤全部达到预期；Python 245 项通过、1 项因 pwsh 不存在跳过；桌面 17 个文件、96 项通过；完整 Playwright 25/25 通过；8 个打包 OCR 场景、离线原生、推理关闭和 HTML 导出 smoke 通过。
- 构建结果：引擎、Setup、Portable、完整 manifest 和 SHA256SUMS 构建通过；候选 SHA 为 32f006518b3b86653e20942221eb9716d40c0144。
- 交互或运行验证：Setup 实际安装、启动、sidecar、清理和卸载通过；Portable 实际启动、资源、进程和临时解压清理通过；结束后无相关进程、快捷方式或卸载注册表残留。
- 本地提交 SHA：01f843e48197c82253220a67af14e2681931b0f1；f60ca5c3d2620456b0ee305bb1091198c62d2e75；32f006518b3b86653e20942221eb9716d40c0144。
- 遗留问题：稳定公开发布仍被正式发布授权、上一可信安装包上的跨版本升级/回滚和冻结候选许可证批准阻塞；Setup/Portable 均为 NotSigned，符合当前 Alpha 零成本策略。
- 是否可进入人工代码审核：是。

### 批次：B-12

- 分支名称：codex/integration/stable-candidate-20260717。
- 风险级别：R2，组合安全、恢复、数据 schema、统一 OCR、CI、打包与安装链；明确不执行 R3 远程合并或正式发布。
- 目标：把已批准且补丁不重复的全部功能与修复汇合为单一人工审核候选，并在同一冻结 SHA 上完成组合回归。
- 对应问题：B-01 至 B-11；统一简繁 OCR、不可变语料、双向索引、任务内检索 UI；六个独立分支中的 A-SEC-02、A-REL-01、A-REL-02、A-QA-01、A-UX-01、A-UX-02、A-REL-03、A-OPS-01。
- 修改范围：以 `9fcc6ce3` 为起点，按资源安全 → Sidecar/导出 → E2E 门禁 → 快捷键 → 渲染状态 → 日志轮转顺序纳入六个提交；更新本报告。
- 未修改范围：导入新功能、产品语义、真实用户数据库、远程分支、PR、main、生产环境、付费签名、公开发布和旧 worktree 清理。
- 前置依赖：`9fcc6ce3` 已继承 B-01、B-09、B-10、B-11、HR-01 及统一简繁 OCR/索引/搜索链；B-08 以补丁等价提交 `34056a9f` 存在，未重复合入 `befadf56`。
- 风险：重叠文件无文本冲突不代表语义无冲突；集成时的候选 schema v7 与当时 main v6 的数据回退不兼容；构建/安装会产生大型忽略产物和隔离进程。
- 验收标准：工作树干净；六个提交完整且不重复；重叠模块通过针对性测试；TypeScript、桌面单测、Python、构建、完整 E2E 和零成本同 SHA 门禁通过；真实用户数据不受影响；金额和外部发布动作均为 0。
- 测试计划：39 项针对性 Vitest；`pnpm typecheck`；`pnpm test`；Python unittest；`pnpm build`；完整 Playwright；`scripts/run-zero-cost-release-gate.ps1 -CandidateSha e878ccca...`。
- 主要实现：修复资源协议 realpath 联接越界；清理 Sidecar 启动超时并放宽大型 HTML 导出时限；修复校对长 worktree E2E 并纳入 CI；阻止输入控件触发全局校对快捷键；完善任务状态与校对资源加载顺序；限制 Electron/Python 日志增长。
- 新增文件：`seed-review-task.py`、`reviewShortcuts.ts` 及 7 个针对性桌面测试文件；组合候选同时继承统一 OCR、索引、搜索和发布门禁新增文件。
- 修改文件：CI、主进程 IPC/Sidecar/日志/资源安全、ReviewPage、TaskPage、TaskCenter、展示工具、校对 E2E 和架构文档等 21 个文件。
- 删除文件：无。
- 测试命令：`pnpm --filter @archivelens/desktop exec vitest run ...`；`pnpm typecheck`；`pnpm test`；Python unittest；`pnpm build`；Playwright；零成本门禁。
- 测试结果：针对性 7 文件、39 项通过；桌面 24 文件、138 项通过；Python 278 项通过、1 项因无 `pwsh` 跳过；Playwright 25/25 通过；29 个门禁步骤全部通过。
- 前置失败记录：第一次针对性测试因两个并发用例争抢首次 Electron 二进制目录而 38 项通过、1 个 suite 收集失败，串行准备后原组合 39/39 通过；第一次 Python 因模型未准备产生 79 个共同根因错误，锁文件模型准备后 278 项通过；第一次完整 E2E 因未生成 `win-unpacked` 为 21 通过、1 失败、3 未运行，完整打包后 25/25 通过。
- 构建结果：`win-unpacked`、Setup 294,811,511 bytes、Portable 294,431,441 bytes、manifest 和 SHA256SUMS 均通过；Setup SHA-256 `62262da7af550ae8d119e35e3927dc51ed57ca9dd6a9d50ca9cf32ae37b56dd8`，Portable SHA-256 `7a89640164d496be52728e3158a6896c0f58f8e76363ecf1f8f2c24dc77f0105`。
- 交互或运行验证：自定义搜索、跨目录多文件、PNG/TIFF、托盘/关闭、暂停/恢复、Sidecar 崩溃、201/1000 条校对、打包欢迎/示例/持久化/导出、Setup 安装/启动/卸载和 Portable 启动/清理均通过。
- 本地提交 SHA：`1a3ac92c8f3de5705bc557ed4ab5a2ad0cb41777`、`25743e2c6193a234c6faa90655f66e94873ee837`、`6e73b92c0f416ae0fcfdcc2f06b51ae4b0dcfb45`、`244c7b6fd82b70e69c7f9f3f2099b4bac283b9b4`、`0fb8f848f34b733b51367f4a741f97c62006cf29`、`e878ccca7ee394006ef28798497433103630ebcc`；报告另形成 docs 提交。
- 遗留问题：B-12 已获授权并进入本地 main；跨版本升级/回滚、冻结候选公开许可证批准、正式发布授权、真实 lint 及其他人工审核项仍未完成；`e878ccca` 上的 993 页大文档重跑和本次命中人工核查已完成。
- 是否可进入人工代码审核：已完成用户人工结果核查并获本地合并授权；未推送、未创建 PR。

### 批次：B-13

- 分支名称：codex/fix/p1-release-gate-electron-bootstrap。
- 风险级别：R2，修改共享发布门禁执行顺序；不改变依赖版本、应用业务行为、用户数据、制品格式或发布授权。
- 目标：确保全新依赖状态下 Electron 运行时只安装一次，避免并行 Vitest 进程在 Windows 上竞争创建 `dist/resources`。
- 对应问题：A-REL-04。
- 修改范围：在冻结依赖安装后、源码门禁与并行单元测试前串行执行桌面包的 `install-electron`；补顺序回归断言和门禁文档；同步本综合报告的合并后真实状态。
- 未修改范围：应用功能、OCR、数据库、依赖版本、CI 触发条件、Setup/Portable 逻辑、真实用户数据、远程仓库、正式发布和付费服务。
- 前置依赖：直接基于本地 main `d60382cae3d2407f958b95119363c592e6bda6ff`；不依赖未合并的旧功能分支。
- 风险：增加一次串行 Electron 安装检查；若 pnpm 缓存和网络均不可用且本机无 Electron 包，门禁会按既有原则明确失败，不会静默降级。
- 验收标准：PowerShell 可解析；顺序测试通过；从无 `node_modules`、无 Electron `dist` 的冷 worktree 开始，桌面单元测试不出现首次安装竞争；完整零成本门禁、构建、E2E、安装和同 SHA 链全部通过。
- 测试计划：Windows PowerShell 语法解析；`test_gate_policy_is_complete_zero_cost_and_non_releasing`；冷状态执行 `scripts/run-zero-cost-release-gate.ps1 -CandidateSha 721141fa... -OfflineNative`。
- 主要实现：新增独立的 `serial Electron runtime preparation` 门禁步骤；测试固定“冻结安装 → Electron 串行准备 → 工作区单测”的执行顺序；文档说明并发风险和零成本边界。
- 新增文件：无。
- 修改文件：`scripts/run-zero-cost-release-gate.ps1`、`engine/tests/test_release_gate.py`、`docs/release-gate.md`；本报告作为验证后的状态同步另行修改。
- 删除文件：无。
- 测试命令：Windows PowerShell parser；`python -m unittest engine.tests.test_release_gate.ReleaseGateTests.test_gate_policy_is_complete_zero_cost_and_non_releasing -v`；完整零成本门禁命令。
- 测试结果：针对性测试通过；冷状态门禁 30/30 步通过；桌面 24 文件、138 项通过；Python 278 项通过、1 项因无 `pwsh` 跳过；Playwright 25/25 通过。
- 构建结果：引擎、Setup、Portable、manifest 与 SHA256SUMS 通过；Setup 294,806,312 bytes，SHA-256 `68cf75c9534d96a9e262c0322bcfd26e39eaa605a17c6aca3c3826a2231a8cc3`；Portable 294,426,242 bytes，SHA-256 `f6ca8da49d74fea657f3240fc0996ed4f111492d6d12238efeede5bf3acd0373`。
- 交互或运行验证：25 项 Electron E2E、Setup 安装/启动/卸载、Portable 启动/清理、打包 OCR、HTML 导出和推理关闭均通过；结束后相关残留进程为 0。
- 本地提交 SHA：实现提交 `721141fa168e33c43ba1d8d984936d9959bdbe4a`；报告同步提交见本分支后续 Git 记录。
- 遗留问题：B-13 尚未获合入本地 main 的精确授权；公开发布仍被许可证批准、跨版本升级/回滚和正式发布授权阻塞。
- 是否可进入人工代码审核：是；实现差异仅 3 个文件、16 行新增、1 行删除。

### 真实文档测试：T-01

- 测试目标：使用 B-11 候选打包引擎，在工作区文件 `F:\OCR\乾隆朝上谕档 第1册(乾隆01年至09年).pdf` 中精确检索简体关键词“亏空”；后续 B-12 重跑见 T-02。
- 数据边界：只读原 PDF；生成数据位于忽略目录；未复制到 Git、未调用上传或外部网络接口；未执行系统级网络抓包。
- 输入证据：24,227,173 bytes；SHA-256 `8aec24499c0f224578d940486a6d7ef00ad95dab5906824b946dec6423096fe9`。
- 引擎证据：`dist/engine/win-x64/archivelens-engine.exe`；SHA-256 `e4a4d482ac15cc2cd9013a6848893bd14929570d1a2684a41bea099a5b113d06`；app.info 候选 SHA 与 `32f006518b3b86653e20942221eb9716d40c0144` 一致。
- IPC 合同：`source_type=files`；`search_text=亏空`；`search_mode=exact_literal`。
- 运行结果：任务 `task_f88ddf684ea343fc89c31db2fb88ae61` 正常 completed；993/993 页；失败页 0；耗时 1,854.406 秒。
- 检索结果：简体精确字面命中 0；命中页为空；results.query 与 export.json 数量一致。
- 导出证据：JSON 完整性为 scan_complete=true、export_complete=true、fully_verified=true；导出 SHA-256 `3acbf6fbf5a17bc0d2443f094d60f9928f448478d3cd0c6e97817bc3227ed122`。
- 结论边界：该结果只证明当前 OCR 输出中没有简体“亏空”的精确字面命中，不能证明原书中不存在繁体“虧空”、异体字、版面识别漏检或需要人工校勘的相关内容。
- 证据目录：`F:\OCR\.tmp\real-document-search\evidence\32f006518b3b86653e20942221eb9716d40c0144\20260716T093941Z`。
- 测试状态：PASS。

### 真实文档简繁检索与人工核查：T-02

- 测试目标：使用组合代码候选 `e878ccca` 的最终打包引擎重新处理同一 PDF，并用简体查询“亏空”分别验证仅简体、仅繁体、简繁都命中三种范围。
- 数据边界：原 PDF 只读；运行、SQLite、导出和 UI 审核副本均位于候选 worktree 的忽略目录；未触碰真实用户数据库、未上传、未联网、未产生费用。
- 输入证据：24,227,173 bytes；SHA-256 `8aec24499c0f224578d940486a6d7ef00ad95dab5906824b946dec6423096fe9`。
- 引擎证据：`apps/desktop/release/win-unpacked/resources/engine/win-x64/archivelens-engine.exe`；SHA-256 `654a951ef801e36aeb59cbb9072a414b9eb8ea7db831b81ee235dea29bcca31b`；打包元数据 `git_commit=e878ccca7ee394006ef28798497433103630ebcc`。
- OCR 运行结果：任务 `task_e9d87bac594b4bf1bf7529f43bfb4085` 正常 completed；993/993 页；失败页 0；耗时 1,861.766 秒；语料状态 ready、版本 1、索引页 993、OCR 行 33,962。
- 检索结果：仅简体会话 `search_d85464c36d7c41a680674d91ff7c342a` 为 0 条；仅繁体会话 `search_9f0e5f28b2f342859a3f3dd52d0e5b62` 为 32 条；简繁会话 `search_7491e575602042ee98e484ce2fb63400` 为 32 条。
- 命中组成：32 条均为 `variant_graph`，`source_script=traditional`、`verification_status=variant_related`；说明简体查询通过双向字形索引命中了不可变 OCR 原文中的繁体“虧空”，而不是把 OCR 原文转换覆盖为简体。
- 命中页：共 20 页，页码为 102、161、193、262、263、301、343、350、409、411、417、487、488、560、595、607、641、723、803、900。
- UI 运行验证：最新打包版以隔离 `ARCHIVELENS_USER_DATA_DIR` 启动，成功显示三次历史会话、32 条分层结果、原始扫描页、不可变 OCR 原文、上下文识别文本及字形关联说明。
- 人工核查结论：2026-07-17 用户明确确认 32 条结果均满足四项验收——原图确实出现“虧空”；OCR 原文忠实于原图；上下文不存在影响命中的明显错字或断行；属于真实词语命中而非版面或 OCR 误识别。
- 结论边界：本项验证覆盖当前模型、当前 PDF 和当前返回的 32 条候选；不等同于证明整本档案召回率为 100%，也不替代代码审核、跨版本升级/回滚、许可证批准或正式发布授权。
- 证据目录：`F:\.zcf\OCR\stable-candidate-20260717\.tmp\manual-review-search\e878ccca7ee394006ef28798497433103630ebcc\20260717T054052Z`；UI 审核副本位于 `.tmp\manual-review-ui\e878ccca\user-data`。
- 测试状态：PASS；自动运行与检索为 VERIFIED，四项人工核查为 HUMAN-VERIFIED。

## 9. UI 与交互专项结论

本轮使用项目 Playwright 驱动真实 Electron 页面，并在 1280×820 和最小窗口 1080×680 下检查欢迎、新建扫描、任务中心、设置、诊断、校对和导出。截图保存在忽略目录 F:\OCR\output\playwright，不属于提交或发布产物。

- 页面布局：暖色桌面视觉体系一致，侧栏、标题、卡片、间距、圆角和阴影具有统一规则；校对三栏在 1280 宽度清楚，在 1080×680 较密集但仍可滚动使用。
- 信息层级：欢迎页价值、隐私承诺和第一步清楚；新建扫描的来源、检索、创建动作层级明确；导出页对全量范围、格式和完整性说明良好。
- 导航：左侧主导航可发现性高，当前页状态明确。窗口最小宽度阻止更窄响应式路径，是否支持小窗需人工决定。
- 表单：来源选择和字面量检索有禁用、校验与空状态；设置页选项较多，需要纵向滚动但没有明显遮挡。
- 列表与表格：任务中心空状态、搜索、状态筛选和主按钮清楚；原状态全集与文案不完整，B-06 已修复。表格在较窄区域使用水平滚动。
- 状态反馈：任务进度、加载、空、错误、禁用状态总体存在；诊断视觉只直接捕获到加载态，完成态以测试和源码为证。
- 错误处理：引擎错误能返回可操作信息；sidecar 启动超时原先会遗留运行态，B-03 已修复。
- 耗时任务：OCR 有实时进度、暂停/继续/取消和恢复；导出有进度和体积警告，但大导出仍缺用户取消/恢复。
- 响应式：CSS 存在 1280、1040、720 与低高度断点；实际 BrowserWindow minWidth=1080，因此 1040/720 分支在正常窗口中不可达。
- 可访问性：主要表单具备标签、按钮状态和键盘入口；全局快捷键原先侵入输入控件，B-02 已修复。未执行屏幕阅读器和完整 WCAG 审计。
- 文案：总体使用简体中文且解释本地处理；原 stopping/stale 英文漏出，B-06 已修复。HR-01 已批准并由 B-08 收紧失败/陈旧恢复合同，合入时需保证 UI 文案与该分支一致。

## 10. 工程与架构专项结论

- 前端：React 页面真实连接 preload API，并非 Mock。状态拆分基本清楚，但 ReviewPage.tsx 约 809 行，校对交互、加载和布局职责集中。
- Electron 主进程：contextIsolation、sandbox、禁用 Node integration、webSecurity 等默认值正确；preload 暴露面采用明确 API。原导航白名单和生产 CSP 存在 P0，B-01 已修复；B-09 在保留安全默认值的前提下升级至 Electron 43.1.1。
- 后端/引擎：Python server、任务调度、OCR、报告、导出和 SQLite 实现完整；report_pipeline.py 约 2599 行、store.py 约 1435 行、server.py 约 1230 行，是维护风险。
- API/IPC：packages/ipc-schema 使用 Zod 统一约束，renderer 不直接访问文件系统。长任务共享超时不合理，B-03 为 HTML 导出设置显式时限。
- 状态管理：正常任务状态和 UI 大体一致；HR-01 已明确选择收紧合同，B-08 让 failed/stale 不再直接恢复，paused/recoverable 保持可恢复。
- 数据：SQLite WAL、foreign key、版本迁移、未来 schema 拒绝、事务回滚和恢复测试较强；删除记录与目录清理不是原子操作。
- 安全：生产依赖审计未发现已知漏洞，未发现被 Git 跟踪的常见密钥扩展名文件；不等于完成全面 secret scan。资源 realpath 和导航/CSP 修复分别在 B-07、B-01。
- 隐私：本地优先、无遥测和远程内容是明确约束；静态数据默认明文，需结合威胁模型决定是否采用 OS 级或应用级加密。
- 性能：结果分页与任务进度已实现；组合候选 `e878ccca` 的 993 页 PDF 在 1,861.766 秒内完成、失败 0，提供了真实长文档吞吐证据。单 bundle 约 1.18 MB、超大文件夹预检和多任务并发预算仍缺失。
- 稳定性：生命周期 E2E 较强；B-03 修复启动超时清理，B-05 限制日志；e878ccca 连续处理 993 页、失败 0、正常退出；本地 main 完成 29 步门禁，B-13 冷状态完成 30 步门禁。磁盘满、强制崩溃后大任务恢复和多任务压力仍未验证。
- 测试：TypeScript 单元、Python 单元/集成、Electron E2E、CI 和本地完整发布门禁齐全；B-04/B-11 已补校对和 vertical 可复现路径，但 lint 仍名不副实，覆盖率门槛未定。
- CI/CD：B-11 的本地门禁覆盖 28 个步骤，含源码、打包、Setup/Portable、同 SHA 清单和公开许可证阻塞边界；未执行任何发布 job 或远程 mutation。
- 构建与发布：本地 main `d60382ca` 与 B-13 实现提交 `721141fa` 的引擎、Setup、Portable、manifest 和哈希同源通过，签名状态为 NotSigned；不能据此宣布稳定 release，跨版本升级/回滚、许可证批准和正式发布授权仍缺失。

## 11. 人工审核清单

HR-01 至 HR-04 已获得用户明确决定；本节保留其决策记录和剩余边界，避免把“技术实施完成”误写为“已获合并、法律批准或正式发布授权”。HR-05 至 HR-11 仍未决。

| 编号 | 决策事项 | 原因 | 可选方案 | 推荐方案 | 优先级 | 后续分支建议 |
| --- | --- | --- | --- | --- | --- | --- |
| HR-01 | failed/stale 恢复语义 | 已批准推荐收紧合同并由 B-08 完成；当前只需代码审核/集成，不再等待产品决定 | 已选 A；未来若需要可另立 B | 维持已批准 A，不扩张 failed/stale 高级恢复 | P1 | codex/fix/p1-task-resume-contract |
| HR-02 | 正式发布门禁、稳定版签名、升级和回滚 | 零成本完整门禁已批准并由 B-11 完成；正式发布仍未授权，升级/回滚仍缺真实前版证据 | A 继续本地候选；B 清除阻塞后另行授权正式发布 | 当前选 A；保持 NotSigned 和零成本，不正式发布 | P1 | codex/build/p1-zero-cost-release-gate；后续 test/p1-upgrade-rollback |
| HR-03 | Electron/前端依赖升级与拆包 | 已批准分阶段方案；Electron 第一阶段由 B-09 完成，其他大版本仍须独立批次 | 已选 B；后续分开工具链、UI 依赖和拆包 | 维持分阶段，不一次升级全部 | P1 | codex/build/p1-electron-supported-upgrade；后续独立分支 |
| HR-04 | DjVuLibre GPL 分发义务 | 已批准继续 bundled 并由 B-10 建立零成本技术门禁；公开许可证批准仍必须由人作出 | 已选 A；公开前批准或继续阻塞 | 保持默认 denied，冻结候选后再作公开批准 | P1 | codex/docs/p1-djvulibre-compliance-gate |
| HR-05 | 最小窗口与校对布局 | 需要目标设备和真实用户偏好 | A 保持 1080×680；B 小窗折叠侧栏；C 校对改分步 | 稳定版先 A 并文档化，后续用 B 做验证 | P2 | ui/p2-compact-review-layout |
| HR-06 | lint、覆盖率和质量预算 | 规则和阈值会影响全仓 CI 与既有债务 | A ESLint+渐进规则；B Biome；C 只保留 typecheck | A，先零告警基线再逐步提高 | P2 | test/p2-static-quality-gate |
| HR-07 | 大文件夹预检与超大导出取消 | 影响任务合同、资源占用和恢复体验 | A 硬上限；B 软预检/确认；C 不限制只记录 | B；导出另加任务级取消和临时文件清理 | P2 | feat/p2-large-job-control |
| HR-08 | 删除的一致性和残留清理 | 改变数据删除与恢复语义 | A DB-first+警告；B FS-first；C tombstone/清理队列 | C，保留审计和可重试清理 | P2 | refactor/p2-task-deletion-journal |
| HR-09 | 静态数据保护与保留策略 | 需明确威胁模型、性能和密钥恢复 | A 依赖 OS/BitLocker；B 数据库/文件加密；C 可选加密库 | 稳定版先 A 并清楚说明；有合规需求再评估 C | P2 | docs/p2-local-data-threat-model |
| HR-10 | 超大模块拆分 | 会跨越 Python API、事务和测试边界 | A 暂不拆；B 按职责渐进拆；C 大重写 | B，从 server handler 和报告阶段接口开始 | P3 | refactor/p3-engine-module-boundaries |
| HR-11 | 批量校对和快捷键配置 | 新核心效率功能需用户研究 | A 多选批量决策；B 可配置快捷键；C 两者都做 | 先验证 A 的真实需求，再决定 B | P3 | feat/p3-bulk-review-actions |

### HR-01：failed/stale 恢复语义

- 页面/模块：引擎任务 handler、状态机、TaskCenter/TaskPage。
- 问题：RESUMABLE_STATUSES 包含 paused、recoverable、stale、failed，但 handler 对 stale/failed 直接转 running 与合法转换冲突，UI 只对 paused/recoverable 提供继续，并提示 failed 重新创建。
- 为什么需要人工决定：恢复失败任务可能复用部分 OCR 结果、覆盖错误状态、改变 finished_at 和幂等性，属于业务和数据语义。
- 方案 A：把契约收紧到 paused/recoverable。优点是最小风险、与当前 UI 一致；缺点是用户不能直接恢复 failed/stale。
- 方案 B：定义 stale/failed → recoverable/queued → running 的多步恢复和检查点规则。优点是恢复能力强；缺点是需要迁移、异常路径和数据兼容测试。
- 影响：涉及功能、UI、状态数据、历史任务兼容和恢复测试。
- 用户决定：已批准 A，即“推荐恢复合同”；不把 failed/stale 自动升级为可恢复任务。
- 执行结果：B-08 已完成并提交，相关 Python 22 项、全量 Python 238 项、桌面 93 项、typecheck、build 和生命周期 E2E 15/15 通过。
- 剩余人工动作：代码审核和集成；未来若要引入 failed/stale 高级恢复，必须重新提出产品与数据语义决策。
- 分支：codex/fix/p1-task-resume-contract。

### HR-02：正式发布门禁、稳定版签名、升级和回滚

- 页面/模块：scripts、electron-builder、CI、release 操作。
- 当前证据：verify-release-chain 对 955646a6 返回 RELEASE_COMMIT_MISMATCH；现有 app.info/engine metadata 指向 5f6c03f7；GitHub Release 列表为空。既有人工决定是当前 Alpha 保持 NotSigned 并接受“未知发布者”，除非分发要求变化，不应反复重开该决定。
- 方案 A：延续当前 Alpha 的人工同 SHA 构建、Setup/Portable 安装、清单校验和 NotSigned 策略。优点是改动小；缺点是易漂移、不可重复，不足以自动证明稳定公开分发。
- 方案 B：建立受保护 release workflow，先构建和验收，正式发布动作仍需人工授权。优点是可追溯；缺点是 CI 时间、签名证书与 secrets 管理成本。
- 方案 C：仅提供 Portable/内部包。优点是最简单；缺点是产品分发能力下降。
- 影响：构建、制品、证书、外部发布、升级兼容和回滚。
- 用户决定：已批准“零成本完整发布门禁但不批准正式发布”；金额预算为 0，继续接受 Alpha NotSigned。
- 执行结果：B-11 已完成 28 步本地门禁，Setup/Portable 构建和真实 smoke、25 项 E2E、同 SHA manifest/哈希链均通过；金额 0；未 push、PR、merge、deploy 或 release。
- 剩余人工决定：只有在跨版本升级/回滚和 HR-04 许可证批准完成后，才能另行给出目标、版本和渠道明确的正式发布授权。
- 不决策影响：项目可继续生成本地受控候选，但不能成为稳定公开 release。
- 分支：codex/build/p1-zero-cost-release-gate。

### HR-03：Electron/依赖升级与拆包

- 当前证据：Electron 31.4，而 registry 当前主版本为 43.1.1；React、Vite、Vitest、electron-builder 等也有大版本更新；renderer 单 bundle 约 1.18 MB。
- 方案 A：冻结版本并记录风险。优点是短期稳定；缺点是安全维护和生态兼容风险继续扩大。
- 方案 B：分阶段升级 Electron，再分别升级工具链和 UI 依赖，并建立兼容矩阵。优点是可控、可回滚；缺点是周期较长。
- 方案 C：一次性升级全部。优点是快；缺点是回归和定位风险最高。
- 影响：原生依赖、Electron 安全策略、打包、E2E、Windows 版本、bundle 切分。
- 用户决定：已批准 B，即分阶段 Electron 升级。
- 执行结果：B-09 只把 Electron 升到 43.1.1，未混入 React/Vite 等其他大版本；冻结安装、测试、build、21 项源码 E2E 和后续同 SHA 打包门禁通过。
- 剩余范围：工具链、UI 依赖和 renderer 拆包仍应分别建分支；支持 Windows 范围和性能预算应在各阶段验收中记录。
- 分支：codex/build/p1-electron-supported-upgrade；后续 perf/p2-renderer-chunking 等独立分支。

### HR-04：DjVuLibre GPL 分发义务

- 当前证据：项目 bundled 原生运行时包含 GPL-2.0-only DjVuLibre；文档、COPYING 和对应源码 URL 已存在。
- 方案 A：维持 bundled 方案并由法务确认源码提供和通知流程；B：改为用户自行安装；C：采用许可证兼容的替代实现。
- 优缺点：A 体验最好但有持续合规义务；B 合规边界更简单但安装体验差；C 长期可控但技术和质量成本最高。
- 影响：安装包、用户文档、许可证、离线能力和 OCR 兼容。
- 用户决定：已批准 A，即继续内置 DjVuLibre，并把零成本技术合规包设为公开发布前门禁。
- 执行结果：B-10 已建立源码/打包技术门禁、第三方通知、对应源码与哈希证据、默认 denied 的批准文件和 CI 检查；技术门禁通过，公开批准边界按设计阻塞。
- 剩余人工决定：冻结具体公开候选后，由有权人员在充分审阅许可证义务后作出明确批准；未批准时不得公开发布。
- 边界：本报告、自动化脚本和技术证据不构成法律意见或合规保证。
- 分支：codex/docs/p1-djvulibre-compliance-gate。

### HR-05：最小窗口与校对布局

- 当前证据：1280×820 下结构清楚；1080×680 下三栏可用但备注和画布空间紧；BrowserWindow 阻止小于 1080 宽度。
- 方案 A：保持桌面最低尺寸并文档化；B：折叠侧栏/工具区；C：把校对拆成多步。
- 优缺点：A 风险低但小屏受限；B 保持流程且工作量中等；C 空间最充足但改变核心流程。
- 影响：UI、键盘导航、截图基线和用户习惯；不影响数据。
- 推荐：稳定版先 A，收集真实设备反馈后验证 B。
- 不决策影响：小屏用户无法缩小窗口，但不阻塞当前定义的桌面范围。
- 审核后批次：ui/p2-compact-review-layout。

### HR-06：lint、覆盖率和质量预算

- 当前证据：pnpm lint 仅执行 typecheck；无覆盖率百分比和 bundle 预算。
- 方案 A：ESLint flat config + 渐进规则 + 关键目录覆盖率；B：Biome；C：维持现状。
- 优缺点：A 生态成熟但新增依赖/规则债；B 速度快但迁移规则有差异；C 零成本但门禁缺失。
- 影响：开发流程、CI 时长、历史告警和依赖供应链。
- 推荐：A，首批只启用可以零告警通过的 correctness/security 规则，阈值按现状基线递增。
- 不决策影响：类型系统之外的错误与回归趋势不受门禁保护。
- 审核后批次：test/p2-static-quality-gate。

### HR-07：大文件夹预检与超大导出取消

- 当前证据：多文件选择上限 200，文件夹递归无规模提示；HTML 页面会提示 300 MB 以上风险，但执行没有用户取消合同。
- 方案 A：硬上限；B：预扫描统计、软确认、任务级取消；C：保持无限制。
- 优缺点：A 最稳定但可能拒绝合法档案；B 体验和可控性平衡但需新状态/IPC；C 最兼容但资源风险高。
- 影响：核心流程、进度 UI、临时文件、幂等性和恢复。
- 推荐：B，先只读预检和明确确认，再设计可取消导出。
- 不决策影响：超大任务可能长时间占用 CPU、内存和磁盘，用户无法及时回收。
- 审核后批次：feat/p2-large-job-control。

### HR-08：删除一致性

- 当前证据：目录 staging、数据库删除和目录移除不是同一事务；最终文件删除失败时数据库可能已无记录。
- 方案 A：DB-first 并把清理失败降级为警告；B：FS-first 并尝试回滚；C：写 tombstone/cleanup journal，后台可重试。
- 优缺点：A 简单但会残留；B 可见行为直观但文件移动也可能失败；C 最可靠但需 schema/恢复逻辑。
- 影响：数据、磁盘、错误文案、迁移和回滚。
- 推荐：C；属于 R2 schema/运维变化，需人工代码和数据恢复审核。
- 不决策影响：低概率故障会留下不可由 UI 管理的残留数据。
- 审核后批次：refactor/p2-task-deletion-journal。

### HR-09：静态数据保护

- 当前证据：本地优先且无遥测；SQLite、OCR 结果、页图和导出默认明文。
- 方案 A：明确依赖 Windows 账户权限和 BitLocker；B：应用级全量加密；C：可选加密库/项目。
- 优缺点：A 性能和恢复最好但不防磁盘离线读取；B 保护最强但密钥丢失和迁移风险高；C 平衡但增加配置复杂度。
- 影响：隐私、性能、备份、恢复、升级和用户支持。
- 推荐：稳定版先完成威胁模型与保留/删除文档；只有合规需求明确时再选择 C。
- 不决策影响：用户可能误解“本地处理”等于“静态加密”。
- 审核后批次：docs/p2-local-data-threat-model。

### HR-10：超大模块拆分

- 当前证据：report_pipeline.py 2599 行、store.py 1435 行、server.py 1230 行、ReviewPage.tsx 809 行。
- 方案 A：只补测试；B：按 handler、repository、pipeline stage 和 UI hook 渐进拆分；C：重写。
- 优缺点：A 近期风险最低但债务持续；B 可审阅且逐步降低耦合；C 理论整洁但回归风险最高。
- 影响：架构、测试、导入路径和故障定位；不应改变业务契约。
- 推荐：B，等 P0/P1 与发布链稳定后再做。
- 不决策影响：新增功能继续提高变更耦合和审阅成本。
- 审核后批次：refactor/p3-engine-module-boundaries。

### HR-11：批量校对和快捷键配置

- 当前证据：已有单条决策和固定快捷键，没有多选批量决策或用户自定义键位。
- 方案 A：先做多选批量决策；B：先做快捷键配置；C：同时做。
- 优缺点：A 对大结果集价值直观但需撤销/误操作保护；B 个性化强但设置复杂；C 范围最大。
- 影响：UI、状态更新、审计、撤销和 E2E。
- 推荐：先做用户研究和 A 的可逆原型，不在稳定版前扩张。
- 不决策影响：只影响高级用户效率，不阻塞主闭环。
- 审核后批次：feat/p3-bulk-review-actions。

## 12. 未实施问题

- 被依赖阻塞：无。原 B-QA-01 已在 B-11 重写并通过；A-REL-04 已在 B-13 修复，当前只待人工代码审核和本地合并授权。
- 环境无法验证：上一可信安装版本到当前本地 main 的真实升级/回滚；pwsh 专用 Python 测试在本机跳过；未进行屏幕阅读器、磁盘满、受限 Windows 用户和多小时/多任务压力测试。
- 证据不足：历史 prunable worktree 的所有权和保留意图；真实用户对小窗、批量校对和加密的需求。
- 需要人工审核：HR-02 的正式发布授权；HR-04 的冻结候选公开许可证批准；HR-05 至 HR-11。HR-01 和 HR-03 已作出决定并完成当前批准阶段。
- 风险过高：正式发布、付费签名、生产 secrets、不可逆迁移、删除历史 worktree；本轮均未执行。
- 不属于当前自动范围：应用级加密、重大模块重构、新批量业务能力和任何需要真实用户偏好或法律判断的事项。
- 跨分支集成：B-12 已进入本地 main；B-13 为唯一新增未合并修复。是否推送、创建 PR 或正式发布仍需另行授权。
- 真实文档结果：组合候选的原始任务精确简体命中为 0；新增双向索引在仅繁体和简繁范围均返回 32 条“虧空”，分布于 20 页，并已完成原图、OCR、上下文和真实词语四项人工核查。该结论不扩展为整本档案 100% 召回保证。

## 13. 分阶段路线图

| 阶段 | 核心目标 | 主要任务 | 可自动实施 | 需人工审核 | 完成标志 |
| --- | --- | --- | --- | --- | --- |
| 1. 可信基线和 P0 | 消除立即安全风险 | B-01 已随 B-12 进入本地 main | 已完成 | 后续 PR/发布代码审核 | main 安全 E2E、全量测试和 build 已通过 |
| 2. 核心业务闭环 | 稳定校对、sidecar、导出与恢复 | B-02、B-03、B-04、B-08 已随 B-12 进入本地 main | 已完成 | 后续 PR 代码审核 | 正常/失败/中断/可信恢复合同和 E2E 已通过 |
| 3. 用户体验与效率 | 完整状态、可靠资源和可理解反馈 | B-06、B-07 已进入本地 main；评估小窗和大任务 | 已完成明确修复 | HR-05、HR-07、HR-11 | 目标视口与大任务验收标准明确 |
| 4. 工程质量与稳定性 | 控制磁盘增长并补门禁 | B-05 已进入本地 main；B-13 已修复冷状态门禁；后续建立真实 lint/覆盖率预算 | B-13 待合并 | HR-06、HR-08、HR-10 | 冷状态门禁无并发竞争，长期/删除异常可恢复 |
| 5. 构建发布与稳定版 | 建立同 SHA 可复验制品链 | B-09 至 B-12 已进入本地 main；B-13 完成；补跨版本升级/回滚 | 零成本门禁已完成 | HR-02 正式发布、HR-04 公开批准、HR-09 | main 与 B-13 同 SHA 制品、安装均通过；升级、回滚和授权仍待完成 |
| 6. 长期演进 | 降低维护成本和提高高级效率 | 渐进拆模块、依赖升级、批量能力 | 已批准的小批次 | 产品与架构路线 | 版本化路线图、性能与质量趋势可量化 |

## 14. 稳定版本最低范围

### 必须完成的功能

- 导入、OCR、暂停/继续/取消、恢复、校对、JSON/HTML 导出和历史管理形成一致合同。
- 采用已批准 HR-01 合同，让 schema、状态机、handler、UI、文档和测试在集成候选中一致。
- 超大导出至少不能因通用 30 秒超时失败，并具备明确的失败清理和用户反馈。

### 必须修复的 P0/P1

- A-SEC-01、A-UX-01、A-REL-01、A-REL-02、A-QA-01。
- H-REC-01 和 H-DEP-01 已有批准决策并进入本地 main；A-REL-04 已在 B-13 修复并待合并。
- H-REL-01 和 H-LIC-01 的技术范围已完成；正式发布授权、跨版本升级/回滚和冻结候选许可证批准仍必须完成。

### 必须通过的测试

- pnpm typecheck、真实 lint 门禁、pnpm test、Python unittest、IPC contract。
- lifecycle、custom-search、review-completeness、real-OCR evidence、sidecar recovery E2E。
- 全部 B-01 至 B-12 的完整零成本门禁；干净同 SHA win-unpacked、Setup、Portable smoke。本地 main `d60382ca` 已满足 29/29，B-13 `721141fa` 已从冷状态满足 30/30。
- HR-01 合同对应的成功、校验失败、中断、重复调用和恢复回归。
- 至少保留一项真实大文档检索回归；本轮 `e878ccca` 的 993 页 OCR、三范围简繁检索和 32 条人工核查可作为性能、稳定性与检索语义基线。

### 必须具备的数据安全和恢复能力

- 任务数据库迁移/回滚、future schema 拒绝、WAL 恢复保持通过。
- 当前本地 main schema v7 到远程旧基线 schema v6 的源码降级不是已验证回滚；需要上一可信安装包和备份副本完成真实跨版本升级/回滚演练。
- 任务删除的部分失败必须可诊断并可重试清理。
- 清楚说明本地明文、备份、删除和 OS 级保护边界；不把“本地”表述为“已加密”。

### 必须具备的构建、安装、升级和回滚能力

- 所有候选制品包含同一候选 SHA、版本和可复验哈希。
- Setup 和 Portable 在隔离 Windows 环境启动并执行关键 smoke；本地 main 与 B-13 冷状态候选均已通过，正式冻结公开候选时仍须按最终 SHA 重建。
- 明确支持的 Windows 版本、升级路径、失败回滚方法和日志位置。
- 正式发布、签名和外部上传必须由人工明确授权。

### 必须完成人工决策

- HR-01、HR-03 已完成决策；无需重复确认当前批准范围。
- HR-02 仍需正式发布授权，且只能在跨版本升级/回滚通过后提出。
- HR-04 仍需对冻结公开候选作出许可证批准；默认 denied。
- HR-08、HR-09 至少完成稳定版边界和用户文档决策。

### 可延后的 P2/P3

- 小窗折叠、bundle 深度优化、批量校对、超大模块拆分、覆盖率趋势门禁可分阶段推进。
- 日志轮转、状态一致性和资源协议 containment 虽为 P2，但收益高、风险低，已随 B-12 进入本地 main。

## 15. Git 操作记录

| 操作 | 结果 |
| --- | --- |
| 创建本地实现分支 | 原 11 个实现分支、1 个 `codex/integration/stable-candidate-20260717` 组合分支、新增 1 个 `codex/fix/p1-release-gate-electron-bootstrap` 修复分支 |
| 创建本地报告分支 | 原 `codex/docs/comprehensive-audit-20260716` 保留；本报告随 B-12 和 B-13 同步真实执行状态 |
| 创建本地提交 | B-12 组合与报告提交已进入本地 main；B-13 实现提交为 `721141fa`，另有本报告同步提交 |
| 基线 main 变更 | 已按用户精确授权将本地 main 从 955646a6 快进到 d60382ca；当前相对 origin/main ahead 20、behind 0，工作树干净 |
| 暂存用户原有改动 | 未执行 |
| 推送远程 | 未执行 |
| 创建 Pull Request | 未执行 |
| 合并默认分支 | 已执行一次本地 `--ff-only` 快进到 d60382ca；B-13 未合并；未执行远程合并 |
| 删除分支/worktree | 未执行 |
| 强制推送或历史重写 | 未执行 |

## 16. 最终结论

1. 当前项目真实状态：ArchiveLens 是具有真实 OCR、持久化、任务生命周期、校对和导出能力的 Alpha 产品，不是 Mock；B-12 已进入本地 main，main `d60382ca` 的 29/29 门禁、993 页真实 PDF、三范围简繁检索和 32 条人工核查均有证据。B-13 `721141fa` 的冷状态门禁 30/30 通过但尚未合并。
2. 是否适合继续增加新功能：不建议立即扩张核心功能。应先人工审阅并决定 B-13 本地合并，再处理稳定版剩余门禁；P3 新功能可后置。
3. 已自动修复：原 9 项明确缺陷，以及 HR-01 恢复合同、HR-03 Electron 第一阶段、统一简繁 OCR/索引/搜索、旧 vertical E2E 可复现问题均已进入本地 main；A-REL-04 已在 B-13 修复。HR-02/HR-04 的批准技术范围已实现，但其人工发布边界仍保留。
4. 已建立分支：12 个实现/修复分支、1 个原报告分支和 1 个 B-12 组合分支；B-12 及其祖先不得重复合入，当前唯一新增合并候选是 B-13。
5. 已完成可审核批次：B-01 至 B-13；B-12 已合入本地 main，B-13 的单元、引擎、E2E、打包、安装和发布链均已实际验证。
6. 仍需人工决定：HR-02 的正式发布授权、HR-04 的冻结候选许可证批准，以及 HR-05 至 HR-11。HR-01 和 HR-03 当前阶段已决定并执行。
7. 当前最优先人工审核：审阅 B-13 的串行 Electron 准备、顺序测试与文档，并明确是否允许快进到本地 main；稳定版前再完成跨版本升级/回滚、HR-04 许可证批准和 HR-02 正式发布授权。
8. 距离稳定版缺少：B-13 合并决策、跨版本升级/回滚、冻结候选许可证批准、正式发布授权、HR-08 删除一致性和 HR-09 隐私边界确认；不再缺全部功能分支组合回归。
9. 是否推送或创建 PR：否；已执行获授权的本地 main 快进，但未远程合并、发布、签名或部署。
10. 未提交或未验证内容：忽略的模型、构建、安装、真实文档和门禁证据不属于 Git 改动。跨版本升级/回滚、屏幕阅读器、磁盘满、多任务压力和更广泛真实用户验收仍未验证。

结论证据等级：代码、本地门禁、安装 smoke 和真实 PDF 任务结果为 VERIFIED；对受控 Alpha 可用性的判断为 INFERRED；稳定公开发布能力为 NOT VERIFIED，并被三项显式门禁阻塞。
