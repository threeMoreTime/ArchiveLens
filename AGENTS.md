# 仓库贡献指南

## 项目结构与模块组织

ArchiveLens 是一款 Windows 桌面应用，由 React/Electron 前端和 Python OCR 引擎组成。

- `apps/desktop/src/{main,preload,renderer}`：Electron 进程边界与界面代码。
- `apps/desktop/tests`、`apps/desktop/e2e`：Vitest 与 Playwright 测试。
- `engine/src/archivelens_engine`、`engine/tests`：OCR 引擎与 Python 测试。
- `packages/ipc-schema`：各进程共用的 Zod IPC 契约。
- `tests/fixtures`：IPC 与 OCR 测试数据；`docs/` 存放架构和用户文档。
- `scripts/`：构建、冒烟测试、诊断和发布脚本。

不要提交 `local-data/`、`dist/`、`build/`、`apps/desktop/out/`、`release/` 或测试报告目录中的本地数据和生成产物。

## 构建、测试与开发命令

- `pnpm install --frozen-lockfile`：安装 pnpm 11 工作区依赖，需要 Node 22.13 或更高版本。
- `pnpm dev`：启动 Electron；需将 `AL_ENGINE_DEV` 指向 Python 3.11 解释器。
- `pnpm typecheck`：检查所有 TypeScript 包的类型。
- `pnpm test`：运行工作区 Vitest 测试。
- `pnpm build`：构建桌面应用。
- `$env:PYTHONPATH="engine/src;engine"; python -m unittest discover -s engine/tests -t engine -v`：在 PowerShell 中运行引擎测试。
- `pnpm --filter @archivelens/desktop exec playwright test`：运行桌面端 E2E 测试。
- `powershell -ExecutionPolicy Bypass -File scripts/build-engine.ps1`：打包 Python 引擎。

## 编码风格与命名约定

TypeScript/TSX 使用 2 空格缩进，Python 使用 4 空格。保持 TypeScript 严格模式。React 组件使用 `PascalCase`，TypeScript 符号使用 `camelCase`，Python 符号使用 `snake_case`。测试文件命名为 `*.spec.ts` 或 `test_*.py`。Renderer 不得直接访问文件系统或进程 API；新增能力应通过 Preload 暴露类型明确的接口，并同步更新 IPC schema、调用方和处理方。

## 测试要求

每项行为变更都应补充回归测试。开发时先运行针对性测试，提交评审前运行 `pnpm test`、`pnpm typecheck`、Python 引擎测试和 `pnpm build`。生命周期、扫描、恢复或导出相关改动还应覆盖对应的 Playwright 场景。仓库未设置覆盖率百分比门槛，但新增分支应覆盖成功、校验失败和可恢复异常路径。

## 提交与 Pull Request 规范

提交信息使用 `类型: 中文说明`，例如 `fix: 修复任务恢复状态`。类型可选 `feat`、`fix`、`test`、`docs`、`refactor`、`build` 或 `chore`，每个提交只聚焦一类改动。Pull Request 必须说明改动内容、验证结果、风险与兼容性影响；有相关 Issue 时应关联。界面改动需附修改前后截图，不得将跳过或失败的检查描述为已通过。

## 安全与配置

ArchiveLens 坚持本地优先：不得引入遥测、远程内容、凭据，也不得将用户文档纳入版本控制。保留 Electron 的 `contextIsolation`、沙箱和禁用 Node 集成等安全默认值。启动子进程时应使用参数数组，并保持 `shell: false`。
