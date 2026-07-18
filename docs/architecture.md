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

见 [ipc-protocol.md](ipc-protocol.md)。协议版本 `PROTOCOL_VERSION = 3`，TS（`packages/ipc-schema`，Zod）与 Python（`archivelens_engine.protocol`）双端一致。v3 要求文件夹创建前执行预检，并增加 `PREFLIGHT_STALE` 错误合同；新界面与旧 v2 引擎不混用。任务持久化检索词数组与匹配模式：新任务使用单个 `exact_literal` 检索词；旧任务保持 `legacy_fixed_pair` 的“约/約”语义。

## 用户数据目录

```
%APPDATA%\ArchiveLens\
├─ settings.json
├─ logs/        app.log / engine.log
├─ engine/      archivelens.db / backups/
└─ tasks/<task-id>/   task.json / worker-state / pages / crops / exports
```

OCR SQLite 由 Python Engine 独占；Renderer 经分页 API 查询。安装目录不存放运行数据。

历史数据库迁移前由 Engine 使用 SQLite Online Backup 创建数据库外快照，校验源 schema、
`integrity_check`、大小与 SHA-256 后才允许进入迁移事务。失败时关闭连接并从同一已校验
快照原子恢复；恢复无法验证则 fail-closed。备份采用独立 JSON 元数据而不是新增备份表，
避免在建立恢复点之前修改待保护数据库。只保留最近 3 对，目录与文件均拒绝链接或
Windows reparse point。当前代码拒绝 future schema；历史 `alpha.10` 没有该保护，降级
只能恢复与旧版 schema 匹配的升级前备份，不能让旧程序直接打开新库。

任务删除采用 SQLite 中的持久化清理作业：只允许终态任务进入删除，清理失败时任务
记录继续可见并显示错误，用户可重试或打开残留目录。Engine 对工作区根、`tasks`
父目录、任务目录和所有既有祖先执行 containment 与 Windows reparse point 检查；任何
不确定路径均拒绝清理，来源文件从不进入删除集合。

JSON 与 HTML 使用持久化 Export Job。状态从 `queued` 进入准备、图片、组装和写入阶段，
最终为 `completed / cancelled / failed / interrupted`。全局只允许一个写入作业，其余合法
请求按创建顺序排队；取消在安全检查点生效。每个作业使用独立临时目录和独立正式文件，
完成状态与成功历史在同一 SQLite 事务中提交，避免失败或取消覆盖旧导出。重启时实际运行
中的作业转为可重试的 `interrupted`，排队作业继续调度，临时清理失败会持久化诊断并重试。

文件夹任务在创建前通过临时 Preflight Job 安全枚举。Engine 使用 `os.scandir` 且不跟随
junction、reparse point 或符号链接，验证扩展名与实际格式、读取页数，并在 userData
所在卷计算保守空间需求。Renderer 只展示结果和提交确认；`tasks.create` 会重新计算
`scan_token`，不信任 Renderer 返回的摘要。创建成功后，安全清单写入 `task_sources`，
实际扫描直接使用该清单，避免预检与执行采用不同目录遍历规则。预检作业只保存在当前
Engine 进程内，可取消且不创建任务或写入用户数据库。

每个新扫描任务在同一 SQLite 中建立任务本地 OCR 语料。`ocr_lines.raw_text`
永久保存统一模型输出的上下文原文；`resolved_text` 仅保存同一模型孤字候选在严格
置信门槛下形成的字形解析结果，两者都不能被校对覆盖。每行同时保存简体、标准繁体、
台湾和香港 OpenCC 索引形式。页面级语料与 processed pages/checkpoint/事件原子
提交，模型 ID 与 SHA-256 在任务内锁定，防止恢复过程中混用模型。旧任务没有这些
证据时只标记为需要显式重新 OCR，不做推测性回填。详见
[migration.md](migration.md) 与
[script-aware-search.md](script-aware-search.md)。

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
* 正式运行时不提供依赖下载入口；原生组件在构建阶段按锁定 SHA-256 准备并随包分发；
* SQLite、OCR 原文/索引、页面图片、校对备注和导出默认以本地明文保存，不提供应用级透明加密；
* Main 只允许按受信 `userData + task_id/export_id` 推导并打开应用目录，不接受 Renderer 任意绝对路径；
* 数据清单、保留/清理、卸载和威胁模型见 [`privacy-and-local-data.md`](privacy-and-local-data.md)。

## 日志

* Electron Main → `userData/logs/app.log`；
* Python Sidecar stderr → `userData/logs/engine.log`；
* 每个日志主文件上限为 5 MiB，达到上限后保留一个 `.1` 备份，避免长期运行导致磁盘无界增长；
* stdout **只**承载 JSONL 协议流，不混入日志；
* 全部 UTF-8；不记录文档 OCR 全文 / 密钥。

## 工程质量门禁

* `pnpm lint` 使用 ESLint 9 flat config，覆盖 TypeScript、React、Hooks、Promise、未使用变量、
  空异常处理和 Renderer 的 Node/Electron 导入边界；warning 预算为 0，并继续执行双端类型检查；
* `pnpm test:coverage` 用 Vitest/V8 运行桌面测试，并对总量及 Main、IPC、生命周期、路径安全、
  设置和 Sidecar 等风险文件执行回退门槛；当前低全局覆盖率被如实保留，不能解释为充分覆盖；
* `python scripts/run-python-coverage.py` 用 Coverage.py 分支覆盖运行完整 Engine 测试，对总量及
  Store/迁移、迁移备份与恢复、Server 删除与导出、预检和 HTML 导出设置定向回退门槛；
* `pnpm check:bundle` 在源码构建后计算 Renderer JS/CSS、Main 和 Preload 的原始字节与 gzip-9
  字节；warning 与 failure 阈值统一记录在 `scripts/quality-budgets.json`；
* GitHub Actions 与零成本本地候选门禁均调用这些同源脚本，生成摘要只写入 gitignored
  `coverage/` 或 CI artifact，不进入正式应用包。
