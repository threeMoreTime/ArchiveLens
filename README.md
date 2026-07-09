# ArchiveLens

> 本地档案 OCR 检索与校对桌面工具 —— 在 PDF / DJVU / DJV 中定位简体“约”与繁体“約”。

**文档内容默认在本机处理，不上传网络。**

---

## 当前状态

本仓库正在 `feat/electron-desktop-v0.1` 分支上推进 **v0.1.0-alpha.10 Desktop Alpha** 的可复现发布闭环。已落地的实质能力：

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| Python Engine 项目化（`engine/`） | ✅ | 正式包 + pyproject + lock |
| JSONL Sidecar IPC（TS↔Python） | ✅ | 139 项 engine 测试 + Zod 契约 |
| Electron Main/Preload/Renderer 安全骨架 | ✅ | typecheck + build + 生命周期 E2E |
| Sidecar 端到端握手 | ✅ | `engine.ready` + `app.info` + 主窗口 |
| Worker/Task 真实状态机（修复残留 checkpoint 误判） | ✅ | checkpoint / sequence / migration 回归 |
| Engine PyInstaller one-folder 打包 | ✅ | 355MB exe 独立 serve 通过 |
| 生命周期关闭/恢复自动化 | ✅ | 14 个 Playwright lifecycle/recovery E2E |
| HTML 离线导出 smoke | ✅ | 本地真实 OCR fixtures 回归 |
| electron-builder 安装包/portable | ⏳ 收尾中 | clean rebuild / Setup / Portable 完整验收待完成 |
| 正式发布证据链 | ⏳ 收尾中 | clean worktree / hash / manifest / smoke 待完成 |

详见 [docs/architecture.md](docs/architecture.md) 与最终阶段报告。

## 快速开始（开发）

需 Python 3.11 与 Node 24（最低 Node 22.13，用于兼容 `pnpm@11.10.0`）。

```bash
# Python Engine（开发期直接用解释器，无需打包）
python -m pip install -r engine/requirements-lock.txt

# 运行 Engine 测试
PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine

# 桌面端
pnpm install
pnpm dev                # 启动 Electron（需设 AL_ENGINE_DEV 指向 python.exe）
```

`AL_ENGINE_DEV` 指向 Python 解释器时，Electron 以 `python -m archivelens_engine serve` 启动 Sidecar，无需 PyInstaller 产物。

## 架构

```
Renderer (React)  ──window.archiveLens──▶  Preload (contextBridge)
                                            │ ipcRenderer.invoke
                                            ▼
                                       Electron Main
                                            │ child_process.spawn（参数数组，shell:false）
                                            ▼
                                Python Engine（JSONL stdin/stdout）
                                            ▼
                                userData（SQLite / pages / crops / logs）
```

安全默认：`nodeIntegration:false` / `contextIsolation:true` / `sandbox:true` / `webSecurity:true`。Renderer 不接触 `fs` / `child_process` / 通用 `ipcRenderer`。详见 [docs/architecture.md](docs/architecture.md)。

## 测试

```bash
# Engine（Python）
PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine   # 139 项

# Desktop（TS）
pnpm --filter @archivelens/desktop exec tsc -p tsconfig.node.json --noEmit
pnpm --filter @archivelens/desktop exec tsc -p tsconfig.web.json --noEmit
```

## 打包

```bash
# Engine → dist/engine/win-x64/archivelens-engine.exe（PyInstaller one-folder）
pwsh scripts/build-engine.ps1

# Desktop（需 Electron 二进制可达；CI 推荐执行）
pnpm --filter @archivelens/desktop dist
```

> ⚠️ 本地 `electron-builder` 可能因 pnpm symlink 导致 app-builder 重新下载 Electron 失败。建议在 CI（`windows-latest`）或 npm 环境执行。详见 [docs/packaging.md](docs/packaging.md)。

## 隐私

默认不上传文档 / OCR 内容 / 遥测；不加载远程网页。CSP `connect-src 'self'` 禁止公网请求。详见 [docs/architecture.md](docs/architecture.md#隐私与本地处理)。

## 许可证

MIT（见 [LICENSE](LICENSE)）。第三方组件清单见 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)。
⚠️ **PyMuPDF (AGPL) 与 DjVuLibre (GPL) 的许可证合规是发布前阻塞**，原生 OCR 依赖本轮未随包分发（见 [docs/native-dependencies.md](docs/native-dependencies.md)）。

## Alpha 限制（必读）

- 版本 `0.1.0-alpha.10`，**非稳定版**，仅供早期试用与反馈；
- 安装包**未签名**，Windows SmartScreen 可能提示「未知发布者」，需手动「仍要运行」；
- 仅支持 Windows 10/11 x64；
- 原生 OCR 依赖（Tesseract / DjVuLibre / 语言包）**当前需宿主已安装**，未随包分发（许可证阻塞）；
- userData 位于 `%APPDATA%\ArchiveLens`（安装版与 portable 共用）；
- 卸载默认保留 userData（任务历史 / 校对 / 数据库）；
- 已知未完成：clean worktree 重建、Setup/Portable 完整 smoke、旧库 migration 正式包验证、远程 CI。
