# CLAUDE.md

This file provides guidance to Claude Code (claude.ai/code) when working with code in this repository.

## 项目概述

ArchiveLens —— **仅 Windows 10/11 x64** 的本地档案 OCR 检索与校对桌面工具。在 PDF / DJVU / DJV / TIFF / JPEG / PNG 中定位用户指定的文字或词语，产出可校对的离线 HTML 报告。**本地优先**：不上传文档/OCR内容/遥测，不加载远程网页（CSP `connect-src 'self'`）。

`pnpm@11.10.0` monorepo（Node ≥ 22.13），三大组件跨两种语言：

| 路径 | 语言 | 职责 |
| --- | --- | --- |
| `apps/desktop` | TS/React | Electron 应用（main / preload / renderer） |
| `engine` | Python 3.11 | OCR Sidecar + CLI（`archivelens_engine` 包） |
| `packages/ipc-schema` | TS | 跨进程 IPC 的 Zod 契约（与 Python `protocol.py` 一一对应） |

`AGENTS.md`、`README.md`、`docs/`（`architecture.md`、`ipc-protocol.md`、`packaging.md`、`migration.md`、`native-dependencies.md`）是权威细节来源；本文件只补充跨文件才能看清的“大图”。

## 常用命令

所有 `pnpm` 命令在仓库根执行；Python 命令的 `PYTHONPATH` 用 Windows 风格 `;` 分隔（Git Bash 内同样有效，因为引号内赋值不触发 shell 分词）。

```bash
pnpm install --frozen-lockfile          # 安装工作区

pnpm dev                                 # 启动 Electron（须先设 AL_ENGINE_DEV 指向 python.exe）
pnpm typecheck                           # 全工作区 TypeScript 类型检查（= lint，无独立 ESLint）
pnpm test                                # 桌面端 Vitest
pnpm build                               # electron-vite 构建 desktop

# Engine（Python unittest，无需安装，用 PYTHONPATH）
PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine -v

# Engine 打包 → dist/engine/win-x64/archivelens-engine.exe（PyInstaller one-folder）
powershell -ExecutionPolicy Bypass -File scripts/build-engine.ps1

# 准备并校验完整离线原生组件（构建机联网；可加 -Offline 只用缓存）
pnpm prepare:native

# Desktop 完整离线安装包（准备原生组件 → Engine → Setup / Portable）
pnpm build:installer
```

**运行单个测试：**

```bash
# 单个 Vitest 文件（桌面端）
pnpm --filter @archivelens/desktop exec vitest run tests/taskStore.spec.ts

# IPC 契约测试（改协议后必跑，TS 端）
pnpm test:contract

# 单个 Python 测试
PYTHONPATH="engine/src;engine" python -m unittest engine.tests.test_protocol -v

# Desktop E2E（Playwright；lifecycle/custom-search 变更需补覆盖）
pnpm --filter @archivelens/desktop exec playwright test e2e/lifecycle.spec.ts
```

桌面端 `typecheck` 拆为 `typecheck:node`（`tsconfig.node.json`）与 `typecheck:web`（`tsconfig.web.json`），分别覆盖 main/preload 与 renderer。`tsconfig.base.json` 启用 `strict` + `noUncheckedIndexedAccess`。

`AL_ENGINE_DEV` 指向 Python 解释器时，Electron 以 `python -m archivelens_engine serve` 启动 Sidecar，**开发期无需 PyInstaller 产物**。

## 架构大图：四层进程 + JSONL Sidecar

```
Renderer (React)  ──window.archiveLens──▶  Preload (sandbox)
                                              │ ipcRenderer.invoke
                                              ▼
                                         Electron Main
                                              │ child_process.spawn（参数数组，shell:false）
                                              ▼
                                    Python Engine（JSONL stdin/stdout）
                                              ▼
                                    userData（SQLite / pages / crops / logs / checkpoint）
```

**进程边界是不可逾越的安全线**（`docs/architecture.md` §安全边界）：

- Renderer 仅通过 `window.archiveLens` 调用 Preload（`contextBridge` 暴露的最小化、类型化 API）。**Renderer 代码永远不接触** `fs` / `child_process` / 通用 `ipcRenderer`。
- Preload 不转发 `ipcRenderer`；Main 侧 `ipcMain.handle` 在 `apps/desktop/src/main/ipc/index.ts` 集中注册（`app` / `engine` / `settings` / `e2e` 四组 handler）。
- Sidecar 用**参数数组 + `shell:false`** spawn，禁止拼接命令字符串。`SidecarManager`（`main/sidecar/manager.ts`）是全局单例。
- **Python stdout 只承载 JSONL 协议流**（`engine.ready` / 响应 / 事件），日志走 stderr → `userData/logs/engine.log`。混入日志会破坏协议解析。

新增能力时，三层要同步改：Preload 暴露的方法签名（`preload/api.ts` + `index.ts`）↔ Main 的 ipc handler ↔ 共享 Zod schema，并更新调用方。

## IPC 契约：TS↔Python 必须双端一致

`packages/ipc-schema/src/index.ts`（Zod）与 `engine/src/archivelens_engine/protocol.py` 是**同一份协议的两个语言投影**，`PROTOCOL_VERSION = 4`。

改协议的硬性要求：
1. **两端同时改**，保持 schema 一一对应；
2. 更新双端契约测试：`apps/desktop/tests/contract.spec.ts`（`pnpm test:contract`）+ `engine/tests/test_ipc_contract.py`；
3. **不兼容**变更必须递增 `PROTOCOL_VERSION`（两端一起）；
4. 新增 IPC 方法名要加入 `MethodNameSchema` 枚举，并视需要在 `parseMethodResult()` 注册结果解析。

错误码（`ErrorCodeSchema`）同样双端对齐，`EngineError` 的 `code` 取自该枚举。CI 的 `ipc-contract` job 专门守护这一点。

## 检索语义与任务状态机

- 新任务用 `exact_literal`（单个检索词）；旧任务保留 `legacy_fixed_pair`（“约/約”）语义。规范化逻辑：仅移除首尾 ASCII SPACE（U+0020）→ NFC → 区分大小写精确行内匹配，支持重叠匹配，**不支持**正则/通配符/跨行。1–32 个 Unicode code point。TS 端 `normalizeSearchText` 与 Engine 端各自实现并互为校验源。
- Task 状态机 12 态（`draft/queued/starting/running/pausing/paused/stopping/completed/failed/cancelled/recoverable/stale`），非法转换抛 `TASK_STATE_CONFLICT`。
- **唯一真相源是 TaskStore SQLite（按 `task_id + source_id` 持久化）**，不是管线本地 checkpoint。历史上“仅凭 checkpoint 存在判定 running”造成过残留误判；判定规则见 `docs/architecture.md` §任务生命周期与 `engine/.../runtime/`。无法验证页进度的旧任务标 `LEGACY_TASK_REQUIRES_REVIEW`，禁止自动 resume。

## 编码约定（摘自 `AGENTS.md`）

- TS/TSX 2 空格缩进，Python 4 空格；TS 严格类型。React 组件 `PascalCase`，TS 符号 `camelCase`，Python `snake_case`。测试文件 `*.spec.ts` / `test_*.py`。
- 代码注释统一用**中文**（与现有代码库一致）。
- 生产包**不含 PyMuPDF/fitz**：PDF 走 pypdfium2/PDFium。`engine/tests/test_no_pymupdf.py` 守护此约束，不要引入 fitz。
- 完整安装包内置锁定版本的 Tesseract、DjVuLibre `ddjvu`/`djvused` 和四个简繁中文 `tessdata_fast` 模型，生产模式强制使用 `process.resourcesPath` 下的组件，不回退到宿主 PATH。开发模式仍可通过 `AL_TESSERACT_CMD`、`AL_DJVU_BIN_DIR`、`AL_TESSDATA_DIR` 显式覆盖。
- userData 位于 `%APPDATA%\ArchiveLens`；卸载默认保留。Renderer 经分页 API 查询 SQLite（OCR DB 由 Python 独占）。

## 构建/路径别名

- `electron.vite.config.ts`：main / preload 编译为 **CJS**，renderer 编译为 **ESM**。
- 路径别名：`@shared` → `packages/ipc-schema/src`（main + renderer）；`@renderer` → `apps/desktop/src/renderer/src`。
- `pnpm build` 会额外运行 `scripts/write-build-metadata.mjs` 生成 `app.info.json`（版本/commit/协议版本），发布链校验依赖它。

## 提交与测试纪律

- 提交信息格式 `type: 中文说明`（`feat`/`fix`/`test`/`docs`/`refactor`/`build`/`chore`）。**未经用户明确要求，不要执行 git 提交或分支操作。**
- 行为变更要补回归覆盖；生命周期/扫描/恢复/导出相关变更需补 Playwright 覆盖。改完先跑相关单测，再跑 `pnpm test` + `pnpm typecheck` + engine 套件 + `pnpm build`。
- **绝不把跳过或失败的检查报为通过。**
