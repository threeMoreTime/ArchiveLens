# ArchiveLens

> 本地档案 OCR 检索与校对桌面工具 —— 在 PDF / DJVU / DJV 中定位简体“约”与繁体“約”。

**文档内容默认在本机处理，不上传网络。**

---

## 当前状态

本仓库正在 `feat/electron-desktop-v0.1` 分支上进行 **v0.1.0 Desktop Preview** 改造。已落地的实质能力：

| 能力 | 状态 | 证据 |
| --- | --- | --- |
| Python Engine 项目化（`engine/`） | ✅ | 正式包 + pyproject + lock |
| JSONL Sidecar IPC（TS↔Python） | ✅ | 80 项 engine 测试 + Zod 契约 |
| Electron Main/Preload/Renderer 安全骨架 | ✅ | typecheck + build + 端到端 smoke |
| Sidecar 端到端握手 | ✅ | `engine.ready` + `app.info` + 主窗口 |
| Worker/Task 真实状态机（修复残留 checkpoint 误判） | ✅ | 80 项测试含三态回归 |
| Engine PyInstaller one-folder 打包 | ✅ | 355MB exe 独立 serve 通过 |
| 完整桌面 UI（首页/扫描/校对/历史/设置/诊断） | ⏳ 进行中 | 骨架验证，完整页面待续 |
| 校对工作台 React 化（report-viewer 共享包） | ⏳ 进行中 | 旧 B2 工作台仍可用 |
| electron-builder 安装包/portable | ⚠️ 受阻 | 配置就绪，本地受 app-builder 下载阻塞，CI 可完成 |
| Playwright E2E / 打包 smoke | ⏳ 待续 | — |

详见 [docs/architecture.md](docs/architecture.md) 与最终阶段报告。

## 快速开始（开发）

需 Python 3.11 与 Node 20+。

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
PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine   # 80 项

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

MIT（见 [LICENSE](LICENSE)，第三方组件清单待补 [THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md)）。
