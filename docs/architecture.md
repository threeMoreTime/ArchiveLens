# 架构

## 进程模型

ArchiveLens 桌面端由三个进程层级 + 一个 Python Sidecar 组成：

### 桌面运行时基线

稳定候选使用 Electron 43.1.1（Chromium 150 / Node 24），目标平台保持
Windows 10/11 x64。升级只改变 Electron 运行时，不同时升级 React、Vite、
electron-vite 或 electron-builder，以便把兼容性回归限制在单一变量内。

升级后必须继续保持 `sandbox: true`、`contextIsolation: true`、
`nodeIntegration: false`、生产 CSP、应用内导航白名单和最小化 preload API；
任何需要放宽这些边界的兼容方式都不得采用。

```
┌─────────────────────────────────────────────┐
│ Electron Renderer                           │
│ React + TypeScript + Fluent UI              │
│ 仅通过 window.archiveLens 调用 Preload      │
└──────────────────┬──────────────────────────┘
                   │ contextBridge（最小化、类型化 API）
┌──────────────────▼──────────────────────────┐
│ Electron Preload（sandbox）                  │
│ 不暴露 ipcRenderer / fs / child_process     │
└──────────────────┬──────────────────────────┘
                   │ ipcRenderer.invoke / ipcMain.handle
┌──────────────────▼──────────────────────────┐
│ Electron Main                               │
│ 窗口 / 生命周期 / 对话框 / Sidecar /        │
│ IPC 校验 / 自定义协议 / 日志 / 托盘          │
└──────────────────┬──────────────────────────┘
                   │ child_process.spawn（参数数组，shell:false）
                   │ UTF-8 JSON Lines over stdin/stdout
┌──────────────────▼──────────────────────────┐
│ Python ArchiveLens Engine                   │
│ OCR / PDF·DJVU / checkpoint / Worker /      │
│ SQLite / report / export / diagnostics      │
└──────────────────┬──────────────────────────┘
                   │
            userData 目录（SQLite / pages / crops / logs / checkpoint）
```

## 安全边界（任务 §七）

| 项 | 值 |
| --- | --- |
| `nodeIntegration` | `false` |
| `contextIsolation` | `true` |
| `sandbox` | `true` |
| `webSecurity` | `true` |
| 新窗口 | 全部 deny；`https:` 外链走 `shell.openExternal` |
| 导航 | 仅本地（dev server / `file://`） |
| DevTools | 生产禁用（除非 `AL_DEBUG=1`） |
| CSP | `default-src 'self'`；`img-src` 含 `al-resource:`；`connect-src 'self'` |
| 自定义协议 | `al-resource://<host>/<rel>`，host→真实目录映射 + 路径逃逸拦截 |
| 命令执行 | Sidecar 用参数数组，禁用 `shell:true`，禁止拼接命令字符串 |

## IPC 协议

见 [ipc-protocol.md](ipc-protocol.md)。协议版本 `PROTOCOL_VERSION = 2`，TS（`packages/ipc-schema`，Zod）与 Python（`archivelens_engine.protocol`）双端一致。任务持久化检索词数组与匹配模式：新任务使用单个 `exact_literal` 检索词；旧任务保持 `legacy_fixed_pair` 的“约/約”语义。

## 用户数据目录

```
%APPDATA%\ArchiveLens\
├─ settings.json
├─ logs/        app.log / engine.log
├─ engine/      archivelens.db
└─ tasks/<task-id>/   task.json / worker-state / pages / crops / exports
```

OCR SQLite 由 Python Engine 独占；Renderer 经分页 API 查询。安装目录不存放运行数据。

## 任务与 Worker 生命周期（任务 §十二）

历史缺陷：仅凭 `checkpoint-*.json` 存在判定 Worker 运行 → 残留 checkpoint 被误显示为“运行中”。

修复（`engine/.../runtime/`）：

```
report.json 存在且成功           → completed
worker-state.status == running
  且 pid 存活 且 heartbeat 新鲜  → running
worker-state.status == running
  但 pid 失联 或 heartbeat 过期   → stale
只有 checkpoint，无 worker-state  → stale（绝不 running）
```

Task 状态机 12 态（`draft/queued/starting/running/pausing/paused/stopping/completed/failed/cancelled/recoverable/stale`），非法转换抛 `TASK_STATE_CONFLICT`。

正式恢复以 TaskStore SQLite 中按 `task_id + source_id` 持久化的 processed pages、checkpoint、worker generation 与 task events 为唯一真相源。管线本地 checkpoint 仅为内部缓存，不能覆盖 SQLite。无法从 v1 旧库验证页进度的任务使用 `LEGACY_TASK_REQUIRES_REVIEW`，保留结果但拒绝自动 resume。

## 隐私与本地处理

* 默认不上传文档 / OCR 内容；
* 默认不发送遥测 / 分析；
* 默认不加载远程网页（CSP `connect-src 'self'`）；
* 仅在用户触发“安装依赖/下载组件”时访问网络，且使用 HTTPS + SHA-256 校验（计划项）。

## 日志

* Electron Main → `userData/logs/app.log`；
* Python Sidecar stderr → `userData/logs/engine.log`；
* stdout **只**承载 JSONL 协议流，不混入日志；
* 全部 UTF-8；不记录文档 OCR 全文 / 密钥。
