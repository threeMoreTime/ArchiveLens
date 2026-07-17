# 稳定候选加固实施计划（B0）

- 创建日期：2026-07-18
- 工作分支：`codex/feat/stable-candidate-hardening-20260718`
- 冻结前基线 HEAD：`b0d0b58d06c3b0cfddf34b9dacd7cb2c4652592e`（== `origin/main`，ahead/behind = 0/0，工作树干净）
- 工作区：`F:\.zcf\OCR\stable-candidate-hardening-20260718`（隔离 worktree；push 远端为 `disabled://no-push`）
- 文档性质：B0 仅产出本计划与一条 docs 提交，**不包含 B1–B7 的任何代码、schema、IPC、测试或脚本改动**。
- 证据口径：与 `docs/reviews/2026-07-16-comprehensive-audit.md` 的证据等级一致（VERIFIED / 基于证据的推断 / 尚未实现 / 未验证 / 需要人工决策）。下文每条事实标注其来源。

本计划遵守零货币成本硬约束：不购买、不试用、不创建付费资源、不使用付费 API/CI/签名/托管；不引入遥测、远程服务或真实用户数据。所有验证使用隔离临时目录，不提交构建产物、日志、数据库、截图、OCR 文本或模型。

---

## 1. 事实基线与证据等级

### 1.1 Git 与工作区（VERIFIED）

| 检查 | 结果 | 来源 |
| --- | --- | --- |
| 当前分支 | `codex/feat/stable-candidate-hardening-20260718` | `git branch --show-current` |
| HEAD | `b0d0b58d06c3b0cfddf34b9dacd7cb2c4652592e` | `git rev-parse HEAD` |
| `origin/main` | `b0d0b58d...`（与 HEAD 同 SHA） | `git rev-parse --verify origin/main` |
| ahead / behind | `0 / 0` | `git rev-list --left-right --count origin/main...HEAD` |
| 工作树状态 | 干净（提交前） | `git status --porcelain` |
| fetch / push 远端 | `origin` fetch=`https://github.com/threeMoreTime/ArchiveLens.git`；push=`disabled://no-push` | `git remote -v` |
| 隔离 worktree | 本分支 worktree 即 `F:\.zcf\OCR\stable-candidate-hardening-20260718` | `git worktree list` |

说明：本分支 HEAD 与 `origin/main` 完全相同，意味着 B0 起点就是已发布的远端 tip；所有改动只能在本地提交，不得 push。`F:\OCR` 主工作区与真实 `%APPDATA%\ArchiveLens` 不在本批次读写范围。

### 1.2 版本与协议（VERIFIED）

| 项 | 值 | 来源 |
| --- | --- | --- |
| 应用版本 | `0.1.0-alpha.11` | 根 `package.json:4`、`apps/desktop/package.json:3`、`engine/src/archivelens_engine/__init__.py:14` 三处一致 |
| `PROTOCOL_VERSION` | `2`（TS 与 Python 双端一致） | `packages/ipc-schema/src/index.ts:13`、`engine/src/archivelens_engine/__init__.py:17` |
| Electron | `^43.1.1` | `apps/desktop/package.json:42` |
| pnpm / Node / Python | `pnpm@11.10.0` / Node `>=22.13` / Python 3.11；本机实测 Node v24.3.0、pnpm 11.10.0、Python 3.11.9 | 根 `package.json:8-11`；`node --version` 等 |

### 1.3 SQLite 数据层（VERIFIED）

| 项 | 值 | 来源 |
| --- | --- | --- |
| `SCHEMA_VERSION`（`user_version`） | `7` | `engine/src/archivelens_engine/db/store.py:38`；`_init_schema` 拒绝 `current > SCHEMA_VERSION`（:336-337） |
| 并发模型 | `check_same_thread=False` + 进程内 `threading.RLock` 串行化所有 cursor/commit；`PRAGMA journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON` | `db/store.py:319-330` |
| 主要表 | `tasks, occurrences, task_processed_pages, task_checkpoints, task_events, review_records, exports, task_failures, task_sources, ocr_corpus_pages, ocr_lines, ocr_line_indexes, ocr_search_sessions, ocr_search_hits, schema_meta`（`ocr_lines` 设 raw 证据不可变触发器 :290-300） | `db/store.py` `SCHEMA_SQL` |
| `delete_task(task_id)` | 在单事务内级联删除 13 张派生表 + `tasks`，返回 `rowcount == 1`；**对不存在的任务返回 `False`（非幂等）**；不触碰任何来源文件 | `db/store.py:850-871` |
| 备份能力 | **不存在**。无 Online Backup / `sqlite3.backup()` / integrity-check / SHA-256 / 历史保留逻辑 | 全文检索 `db/store.py` 无 backup 方法 |

### 1.4 IPC 协议与调用链（VERIFIED）

- `MethodNameSchema`（`index.ts:272-301`）含 `tasks.delete` / `export.html` / `export.json` / `export.review` / `exports.list` / `tasks.create` 等 28 个方法名；`parseMethodResult`（:647-661）为已实现方法注册结果 schema。
- `ErrorCodeSchema`（`index.ts:179-202`）为**闭合枚举**，当前 22 个值；**尚无** `OUTPUT_ALREADY_EXISTS`、`PREFLIGHT_STALE`、`CLEANUP_FAILED`、`BACKUP_INCOMPLETE` 等 B1/B2/B3/B6 所需码。与 Python `protocol.ErrorCode`（`protocol.py:27-49`）一一对应。
- `TaskDeleteResultSchema` = `{task_id, deleted:true}`（`index.ts:410-413`），无 tombstone 字段。
- `tasks.create`：folder（`source_dir`）或 files（`source_files`，上限 `MAX_SOURCE_FILES=200`）；`output_dir` 可选（`index.ts:151-174`）。

**tasks.delete 现有调用链与缺口（VERIFIED）：**
1. Renderer `archiveLens.tasks.delete(task_id)` → Preload → Main `ipcMain.handle("tasks.delete")`（`apps/desktop/src/main/ipc/engine.ts:46-53`）：成功后 `unregisterResourceRoot` + `getSettingsStore().removeTaskOverride`（容错）。
2. Main → Sidecar → Python `_h_tasks_delete`（`server.py:1038-1084`）：要求 `status ∈ TERMINAL_TASK_STATUSES`（`{completed,failed,cancelled}`，`task_state.py:30`），否则 `TASK_STATE_CONFLICT`；任务不存在 → `TASK_NOT_FOUND`（**非幂等**）；目录 staging（rename `.deleting-{task_id}-{id}`）→ DB 事务删除 → `shutil.rmtree`，全程在单次请求内**同步**完成。
3. 缺口（对照 B1 合同）：无独立持久化清理作业；不存在任务的重复删除报错而非幂等成功；目录清理失败时 DB 已删（`server.py:1078-1083` 仅报 `DATABASE_ERROR`，未留可重试记录）；任务在删除期间无“清理中”可见状态。原始来源文件确认永不被删除（`_task_workspace_dirs_for_delete` 仅清理 `workspace_root/tasks/{id}`，`server.py:1029-1035`）。

**HTML/JSON export 现有调用链与缺口（VERIFIED）：**
- `_h_export_html`（`server.py:1482-1533`）：目标 = `_export_dir(task_id)/{task_id}-report.html`（引擎自有 workspace）；`HTML_EXPORT_TIMEOUT_MS = 30*60_000`（`engine.ts:13`）；底层 `write_offline_review_report`（`html_export.py:394-454`）**已**用 `tempfile.TemporaryDirectory(dir=output_path.parent)` + `os.replace` 原子移动（**同卷同父目录已满足**）。
- `_h_export_json`（`server.py:1448-1459`）：`out.write_text(...)` **直接写最终路径，非原子**。
- 两者均使用**确定性文件名**、**无 `OUTPUT_ALREADY_EXISTS` 检查、总是覆盖**；HTML 与 JSON 互相独立，无共享 Export Job、无“全局最多一个 running”约束、无任务级取消。
- Main 侧 `ipcMain.handle("export.html"/"export.json"/"export.review"/"exports.list")`（`engine.ts:82-87`）仅转发，无去重/并发约束。

**folder 任务创建 / preflight 现有调用链与缺口（VERIFIED）：**
- `_h_tasks_create`（`server.py:792-898`）：folder 分支校验 `src.exists() && is_dir()`（否则 `PATH_NOT_FOUND`），`rglob("*")` 递归枚举并按扩展名/栅格校验；写探针 `.al-write-probe`（`PERMISSION_DENIED`）。files 分支经 `_validate_file_sources`（:712-789）。
- 缺口（对照 B3 合同）：无网络路径识别/警告/二次确认；folder 递归默认**跟随 junction/symlink**（`rglob` 不区分）；磁盘空间检查未针对 userData 所在卷；任务 `start` 时不重新校验来源（无 `PREFLIGHT_STALE`）。

### 1.5 测试统计口径（基于源码的 reproducible 统计；非实际执行计数）

| 套件 | 统计口径 | 数值 | 命令 |
| --- | --- | --- | --- |
| Python unittest | `def test` 方法定义数 / 文件数 | **289 / 37** | `rg "^\s*def test" engine/tests` |
| Desktop Vitest | `it(`/`test(` 调用数 / 文件数 | **109 / 24** | `rg "\b(it|test)\(" apps/desktop/tests` |
| Playwright E2E | `test(` 调用数 / 文件数 | **25 / 4** | `rg "\btest\(" apps/desktop/e2e` |

历史实际执行口径（审计 VERIFIED，供对照，非本批重跑）：B-13 合并后门禁为“桌面 138 项 / Python 278 项通过 1 项因无 pwsh 跳过 / Playwright 25/25”。本批统计口径与方法不同（源码静态计数 vs 运行计数），数值不可直接等同；以实际 `python -m unittest discover` / `pnpm test` / `playwright test` 输出为准。

### 1.6 lint 真实行为（VERIFIED）

根 `package.json:18` `lint` = `pnpm -r lint`；desktop `package.json:13` `lint` = `pnpm run typecheck` = `pnpm run /typecheck:/`（运行 `typecheck:node` + `typecheck:web`）。即 **`pnpm lint` 实际等价于全工作区 TypeScript 类型检查，无 ESLint / Biome / 独立静态规则门禁**。与审计 H-QA-01 / HR-06 结论一致。

### 1.7 renderer bundle 口径（未验证 / UNVERIFIED）

本 worktree 当前**无构建产物**：`apps/desktop/out/renderer`、`apps/desktop/release` 均不存在（`ls` 确认）。因此 B0 无法给出本次原始/gzip 口径。历史最近测量（审计 VERIFIED）：B-12 构建后 renderer 单一 JS ≈ 1,226.64 kB、CSS ≈ 48.55 kB；更早约 1,181.83 kB。可复现命令：

```bash
pnpm build
# 原始：apps/desktop/out/renderer/assets/*.js 体积之和
# gzip：node -e "console.log(require('zlib').gzipSync(require('fs').readFileSync('<file>')).length)"
```

bundle 口径将在每批构建步骤与最终零成本门禁中按上式采集；B0 不为测量而单独构建。

### 1.8 零成本发布门禁与 Setup/Portable 证据（VERIFIED 配置 / 无当前制品）

- 门禁脚本：`scripts/run-zero-cost-release-gate.ps1`（单命令 `pnpm gate:release-local`）。步骤（:318-497）：冻结 SHA → `pnpm install --frozen-lockfile` → 串行 Electron 运行时准备 → 源码许可证门禁 → 锁定 OCR 模型 → Python 全量测试 → typecheck → lint → 单元测试 → 源码构建 → 完整原生组件 → 打包引擎 → Setup/Portable → 完整 Playwright E2E → 包内许可证/离线原生/8 组 OCR/推理退出/HTML smoke → Setup 安装·启动·卸载 smoke → Portable 启动·清理 smoke → Authenticode（接受 `Valid`/`NotSigned`）→ manifest/SHA256SUMS → 同 SHA 发布链校验 → 最终工作树干净断言。
- 证据落点：`.tmp/release-gate/<完整SHA>/<UTC时间>/`（gitignored）；`release-gate-summary.json` 始终写 `monetary_cost=0`、`push/pull_request/merge/deployment/signing=NOT_PERFORMED`、`stable_public_release_status=BLOCKED`（:176-207）。
- **当前无门禁证据文件、无 release 制品**：`.tmp/release-gate`、`apps/desktop/release` 在本 worktree 不存在。Setup/Portable“当前证据”= 无；最近一次同 SHA 全通过证据见审计 B-13（`2fa7bebc`，30/30）。
- Setup/Portable 当前均为 `NotSigned`（Alpha 零成本策略；:444-460）。

### 1.9 已确认缺陷：本地门禁 `finally` 未调用清理（VERIFIED）

- `scripts/cleanup-test-artifacts.ps1` 存在且安全：按 `RunId` + 临时目录前缀（`archivelens-e2e-userdata-`/`-setup-smoke-`/`-portable-smoke-`/`-migration-test-`/`-ocr-temp-`）**且**目录内含 `.archivelens-test-owned` 标记，或报告根含 `.archivelens-runid` 标记匹配 `RunId` 筛选；`Is-SafeTarget` 拒绝盘根、仓库根、`$HOME` 与 reparse point（:13-40, 60-90）。
- **缺陷**：`run-zero-cost-release-gate.ps1` 的 `finally`（:525-530）**仅还原环境变量并 `Pop-Location`，从不调用 `cleanup-test-artifacts.ps1`**。门禁用 `$env:ARCHIVELENS_TEST_RUN_ID = $runId`（:315）注入 RunId，但运行结束不回收本次 smoke 在 C:`%TEMP%` 的残留。
- **次级缺口（影响清理匹配准确性，B5/B7 需处理）**：
  - Python smoke（`html-smoke.py`、`packaged-ocr-smoke.py`、`shutdown-inference-smoke.py`）写 `.archivelens-test-owned` 标记 ✓。
  - PowerShell smoke（`smoke-installer.ps1`/`smoke-portable.ps1`）创建 `archivelens-{setup,portable}-smoke-{runId}` 目录但**未写** `.archivelens-test-owned` 标记；成功时自清理（`Remove-ReleaseSmokeOwnedRoot`），**失败中断时目录孤立且 cleanup 无法匹配**。
  - Playwright `playwright.config.ts` 无标记写入；`archivelens-e2e-userdata-` 目录归属标记来源未在本批确认。
- 本批只记录，不执行清理。

### 1.10 CI（VERIFIED 配置；不可称远程通过）

`.github/workflows/ci.yml` 作业：`engine-tests`、`desktop-tests`、`ipc-contract`、`lifecycle-e2e`、`package-smoke`，均 `windows-latest`。因 push 远端禁用，本计划只能进行 **CI 配置审查与本地等价模拟**，**不得声称“远程 CI 通过”**。

---

## 2. B1–B7 依赖图

```
                B0(本计划, docs only)
                       │
        ┌──────────────┼──────────────┐
        ▼              ▼              ▼
   B1 任务删除      B2 导出作业     B3 来源预检
  (cleanup job)   (Export Job)   (folder/preflight)
   依赖: store     依赖: store     依赖: server/store
   schema + IPC    新错误码        新错误码
        │              │              │
        │              │      (B3 的 PREFLIGHT_STALE
        │              │       供 B2 导出前复用预检)
        │              │
        ▼              ▼
   共用: ErrorCodeSchema 扩展 + 双端契约测试（汇聚点）
        │
        ├──────────────┐
        ▼              ▼
   B6 备份/回滚    B5/B7 门禁清理修复
  (SQLite backup) (release gate finally)
   依赖: store      依赖: scripts/*
   独立于 B1-B3      独立于 B1-B3, B6
```

- **汇聚点**：B1/B2/B3 都需要扩展闭合的 `ErrorCodeSchema`（TS）+ `protocol.ErrorCode`（Python）并同步双端契约测试。建议把**错误码扩展 + 契约测试**作为首个共用提交（`B0+` 或 B1 前置），避免三批各自重复改同一枚举导致冲突。
- **顺序建议**：错误码/契约前置 → B1 → B2 → B3（B3 的预检可被 B2 复用）→ B6（独立）→ B5/B7（门禁修复，独立，可并行）。各批独立 worktree/分支，互不阻塞，除“错误码扩展”外无跨批代码依赖。
- **B4**：本计划编号为 B1–B7，未定义 B4 单独批次；如需编号连续，可把“错误码/契约前置”记为 B4（占位），但当前合同未要求，列为可选项。

---

## 3. 零成本台账

| 资源类 | 现状 | B1–B7 计划 | 是否产生费用 |
| --- | --- | --- | --- |
| 货币 | 0 | 维持 0，不购买证书/CI 额度/托管/签名/API | 否 |
| 远程动作 | push/PR/merge/release/deploy/sign 全禁用；push 远端已 `disabled` | 维持；GitHub Actions 仅配置审查/本地模拟 | 否 |
| 代码签名 | `NotSigned`（Alpha 接受） | 维持；不调用付费签名服务 | 否 |
| 遥测/远程服务 | 无；CSP `connect-src 'self'` | 不引入 | 否 |
| 真实用户数据 | 不读写真实 `%APPDATA%\ArchiveLens` 与真实任务库 | 所有测试用隔离 `AL_WORKSPACE_ROOT`/临时目录 | 否 |
| 构建产物/模型 | gitignored（`dist/`、`apps/desktop/release`、`.tmp/`） | 不提交；本批仅 docs | 否 |
| 测试残留 | C:`%TEMP%` 残留为 B5/B7 待修缺陷 | B5/B7 修复后门禁 RunId 内残留归零 | 否 |
| 新增运行时依赖 | — | B1–B7 仅用现有栈（SQLite 标准库 `sqlite3.backup()`、Python `tempfile`/`hashlib`、PowerShell）；不引入新付费/远程包 | 否 |

**记账规则**：每批提交说明与门禁摘要均显式记录 `monetary_cost=0` 与未执行的外部动作；冻结候选 SHA 后，证据写入 gitignored 目录或任务回复，**不得通过报告提交改变同 SHA 工作树**（门禁最终断言 :499-505）。

---

## 4. 风险与范围

### 4.1 范围内（B1–B7 将实施）

- B1：任务删除的独立持久化清理作业 + 幂等删除合同。
- B2：HTML/JSON 共享 Export Job + 全局单 running + 同卷原子写 + `OUTPUT_ALREADY_EXISTS` 不自动覆盖。
- B3：folder/来源预检（网络路径警告二次确认、默认不跟随 junction/symlink、userData 卷磁盘检查、创建时重校验 `PREFLIGHT_STALE`）。
- B5/B7：修复门禁 `finally` 不调用清理的残留缺陷（含 PS smoke / e2e 标记覆盖）。
- B6：SQLite 备份（Online Backup + integrity check + SHA-256 + 最近 3 份保留 + 卸载不自动删 + 旧版本不伪造通过）。
- 共用：`ErrorCodeSchema`/`protocol.ErrorCode` 扩展 + 双端契约测试。

### 4.2 明确不实施范围（out of scope）

- **不做** push / PR / merge / release / deploy / 代码签名购买 / 历史重写 / 删除分支或 worktree / `reset --hard` / `clean -fd` / `checkout --` / `--no-verify`。
- **不修改** `F:\OCR` 主工作区、真实 `%APPDATA%`/`%LOCALAPPDATA%`、真实任务数据。
- **不实施** B1–B7 的任何代码、schema、IPC、脚本、测试改动（B0 只产出本计划）。
- **不声称** 远程 CI 通过、跨版本升级/回滚已验证、公开许可证已批准、稳定版已发布。
- **不引入** 遥测、远程服务、付费 API/CI/签名/托管、真实用户数据。
- **不触碰** `B4` 编号（未定义；如需可在后续单独提出）。
- 暂不实施审计中仍未决的 HR-05/HR-06/HR-09/HR-10/HR-11（最小窗口、ESLint、静态数据加密、模块拆分、批量校对）——除非用户另行授权。

### 4.3 主要风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `ErrorCodeSchema` 是闭合枚举，新增码若不同步双端会破坏 IPC 解析 | R2 | 首个共用提交同步 TS+Python+双端契约测试；考虑是否递增 `PROTOCOL_VERSION`（见 §5） |
| B1 清理作业改变删除可见性与幂等性，影响 UI 与既有删除测试 | R2 | 保留 `{task_id, deleted:true}` 成功形状；幂等仅在“任务确不存在”时返回成功；补回归 |
| B2 不自动覆盖是行为变更（同 kind 二次导出原可覆盖） | R2 | 新增显式 `overwrite` 确认参数；默认 fail-closed；补 UI 与测试 |
| B3 junction/symlink 不跟随可能影响依赖链接的合法库 | R2 | 仅作用于用户来源扫描；保留显式 opt-in；补真实临时 junction 回归 |
| B6 旧版本无法读取新 schema 时若误判会破坏回滚安全 | R2 | 旧版本一律拒绝/标 PARTIAL，绝不改写旧库伪造通过 |
| B5/B7 清理误删非本次目录 | R2 | 严格按 RunId+标记+前缀+安全目标判定；清理错误不掩盖原始错误 |

---

## 5. Schema / IPC 变更预案

### 5.1 错误码扩展（B1/B2/B3/B6 共用前置）

新增到 `ErrorCodeSchema`（`index.ts:179-202`）与 `protocol.ErrorCode`（`protocol.py:27-49`）：

| 新码 | 用途 | 批次 |
| --- | --- | --- |
| `OUTPUT_ALREADY_EXISTS` | 导出目标已存在且未显式确认覆盖（B2） | B2 |
| `EXPORT_IN_PROGRESS` | 全局已有 running Export Job（B2） | B2 |
| `PREFLIGHT_STALE` | 任务创建/启动时来源校验结果已变化（B3） | B3 |
| `CLEANUP_FAILED` / `TASK_CLEANUP_PENDING` | 清理作业失败/进行中语义（B1） | B1 |
| `BACKUP_INCOMPLETE` | 备份未完成或完整性校验未通过（B6） | B6 |

**契约要求（依 CLAUDE.md §IPC 契约）：**
1. 两端**同时**改，保持一一对应；
2. 更新双端契约测试：`apps/desktop/tests/contract.spec.ts`（`pnpm test:contract`）+ `engine/tests/test_ipc_contract.py`；
3. 新增方法名（如导出/预检/备份相关）加入 `MethodNameSchema` 并在 `parseMethodResult` 注册结果解析；
4. **`PROTOCOL_VERSION` 是否递增**：新增枚举成员属附加式（additive）。决策原则——若调用方对未知错误码已有 `UNKNOWN_ERROR` 兜底（TS 端错误模型 `UserFacingError` 与 Python `safe_parse` 均容错），则**不必**递增；若新增方法名/结果形状改变解析兼容性，则**必须**递增（双端同步）。本计划建议：错误码扩展不递增 `PROTOCOL_VERSION`（保持 2），但在双端契约测试中固化“未知码 → 可降级为 UNKNOWN_ERROR”的兜底用例；任何新方法名或结果形状变更再单独评估递增。该决策在首个共用提交的契约测试中显式断言。

### 5.2 方法/结果形状变更（各批预案，B0 不实现）

- **B1**：`tasks.delete` 结果保持 `{task_id, deleted:true}`；可选新增 `tasks.cleanupStatus`（只读）或事件 `task.cleanup.*` 用于“清理中”可见性。幂等：任务不存在时返回 `{task_id, deleted:true}`（视为已删除）而非 `TASK_NOT_FOUND`。新增持久化清理作业表（如 `task_cleanup_jobs`，schema 升级到 v8）。
- **B2**：`export.html`/`export.json` 参数新增 `overwrite?: boolean`；结果含 `export_id`/`path`；全局 Export Job 状态可经 `exports.list` 或新 `exports.active` 查询。临时输出沿用 `tempfile(dir=final.parent)` + `os.replace`（HTML 已具备，JSON 需对齐）。
- **B3**：`tasks.create`/`tasks.start` 返回/事件携带预检摘要；网络路径、junction 计数、磁盘可用空间进入 `details`；变化时抛 `PREFLIGHT_STALE`。
- **B6**：新增 `backup.create`/`backup.list`/`backup.restore`（或同等）方法与结果 schema；备份元数据含 SHA-256、integrity-check 结果、schema 版本。

### 5.3 SQLite schema 变更（各批预案）

- B1 清理作业表、B6 备份注册表均需 `SCHEMA_VERSION` 递增（v7 → v8 / v9），走 `_migrate_schema(current)` 增量路径（`db/store.py:382-528`），保持“`current > SCHEMA_VERSION` 拒绝”（:336-337）与未来版本拒绝语义。

---

## 6. 数据兼容与回滚合同

### 6.1 已批准合同（强制遵循）

- **B1**：使用独立持久化清理作业；清理完成前任务保持可见；成功后事务性永久删除任务及派生记录；不存在任务的重复删除视为幂等成功；不长期保留用户可见 tombstone；原始来源永不删除。
- **B6**：使用 SQLite Online Backup API（`sqlite3.Connection.backup()`）或同等一致性机制，备份后 `PRAGMA integrity_check` 与 SHA-256；默认保留最近 3 份；卸载不自动删除；历史旧版本若不能拒绝未来 schema，不得修改旧版本伪造通过，总体最多 PARTIAL。

### 6.2 兼容与回滚规则

| 场景 | 规则 |
| --- | --- |
| 新 schema（v8+）打开旧库（v7） | 走增量迁移；失败回滚事务，不损坏旧库 |
| 旧版本（v7 代码）打开新库（v8+） | 必须**拒绝写入或只读**，标 `PARTIAL`/明确错误，**绝不**改写库伪造通过（B6 合同） |
| 备份恢复 | 恢复前校验 integrity_check + SHA-256；不匹配则不覆盖现库；保留恢复前快照 |
| Git 回退 ≠ 数据回滚 | 审计明确（§2、§10）：schema v7→v6 数据回退未验证；代码回退不能等同于用户数据回滚。B1–B7 不改变此边界 |
| 删除回滚 | B1 清理失败时任务仍可见（可重试），不进入“DB 已删但文件残留”的不可见状态 |
| 门禁冻结后证据 | 冻结候选 SHA 后，所有证据写入 gitignored 目录或任务回复；**不得**通过提交改变同 SHA 工作树（否则破坏门禁 :499-505 的“最终工作树干净”断言） |

### 6.3 schema 迁移测试要求

每批引入 schema 变更时，必须补：旧版本→新版本迁移用例、新版本拒绝更高 `user_version` 用例、迁移失败回滚用例、（B6）旧二进制遇到新库拒绝/降级用例。参照既有 `test_store*.py`、`test_search_term_migration.py` 风格。

---

## 7. 测试矩阵

| 批次 | Python 单测 | Desktop Vitest | 契约(双端) | Playwright E2E | 门禁/脚本 |
| --- | --- | --- | --- | --- | --- |
| 错误码/契约前置 | `test_ipc_contract`、`test_protocol` 新码 | `contract.spec.ts` 新码 + 未知码兜底 | ✓✓ | — | — |
| B1 | `test_store`（cleanup job/幂等）、`test_handlers`/`test_recovery_*`（delete 幂等、清理失败可见） | `taskStore.spec.ts`、`engineHandlers.spec.ts`（delete 形状不变） | ✓ | lifecycle（删除后状态） | — |
| B2 | `test_html_export`/`test_report_pipeline_html`（同卷原子、`OUTPUT_ALREADY_EXISTS`）、`test_handlers`（单 running） | `ExportPage` 相关、`engineHandlers`（超时/并发） | ✓ | 导出 E2E（覆盖确认） | — |
| B3 | `test_handlers`/`test_document_backends`（junction 不跟随、网络警告、磁盘检查、`PREFLIGHT_STALE`） | `NewScan`/`taskStore` 预检 | ✓ | custom-search（folder 预检） | — |
| B5/B7 | `test_release_gate`（finally 调用 cleanup、清理错误不掩盖原错误、RunId 内残留=0） | — | — | — | PS 5.1/7 语法解析；本地门禁 dry-run |
| B6 | `test_store`（backup/integrity/SHA256/保留 3/旧版本拒绝） | 备份 UI/设置（若涉及） | ✓ | — | — |

**批次验收统一门禁**（每批代码改完先跑相关单测，再跑全量）：`pnpm typecheck` + `pnpm test` + `PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine -v` + `pnpm build` + 相关 Playwright；行为/生命周期变更补 Playwright 覆盖；最终以 `scripts/run-zero-cost-release-gate.ps1` 同 SHA 门禁收口（冻结候选后）。

---

## 8. 每批验收标准（B1–B7；B0 不含代码验收）

### B0（本批）
- 仅新增 `docs/plans/stable-candidate-hardening.md`；无代码/schema/IPC/脚本/测试改动。
- `git status` 仅显示该新文件；提交后工作树干净。
- 单条提交 `docs: 记录稳定候选加固实施计划`。
- 不声称 B1–B7 已完成。

### B1（任务删除清理作业）
- 存在独立持久化清理作业记录（新表/字段），任务在清理完成前仍可见。
- 清理成功 → 单事务永久删除任务及 13 张派生表记录 + 工作目录；成功形状仍为 `{task_id, deleted:true}`。
- 重复删除“任务确不存在”→ 幂等成功（不再 `TASK_NOT_FOUND`）；非终态任务仍 `TASK_STATE_CONFLICT`。
- 清理失败 → 任务保持可见且可重试，不进入“DB 已删·残留”不可见态；原始来源文件永不删除（回归断言）。

### B2（Export Job）
- HTML 与 JSON 共用 Export Job；全局最多一个 running（并发请求被拒，错误码 `EXPORT_IN_PROGRESS`）。
- 临时输出在最终目标同卷同父目录（HTML 已具备，JSON 对齐），原子 `os.replace` 落盘。
- 目标已存在且未显式 `overwrite` → `OUTPUT_ALREADY_EXISTS`，**绝不自动覆盖**。

### B3（来源预检）
- 网络路径允许但必须警告并二次确认；默认不跟随 junction/symlink（可显式 opt-in）。
- 磁盘检查针对 userData 所在卷；任务创建时重新验证来源，变化 → `PREFLIGHT_STALE`。

### B5/B7（门禁清理修复）
- `finally` 按 `run_id`、已知前缀与 `.archivelens-test-owned`/`.archivelens-runid` 标记调用 `cleanup-test-artifacts.ps1`（`-Confirm`）。
- 清理错误**不掩盖**原始错误（先保留原始失败状态，再记录清理结果）。
- 确认并补齐 PS smoke / Playwright e2e 目录的归属标记覆盖；结束后**本次 RunId 残留为 0**（dry-run 可审计）。

### B6（备份）
- 使用 `sqlite3` Online Backup API；备份后 `integrity_check` 通过且记录 SHA-256。
- 默认保留最近 3 份；卸载不自动删除。
- 旧版本不能拒绝未来 schema 时，**不得修改旧版本伪造通过**，总体最多 `PARTIAL`。

---

## 9. 跟踪文档与冻结候选 SHA 的纪律

- 所有跟踪文档（含本计划及各批实施记录）**必须在冻结候选 SHA 之前**完成并提交。
- 冻结候选 SHA 之后产生的证据（门禁日志、smoke 证据、测试输出）写入 gitignored 目录（`.tmp/...`）或任务回复，**不得**通过新增/修改跟踪文档提交来改变同 SHA 工作树——否则破坏门禁“最终工作树干净”断言（`run-zero-cost-release-gate.ps1:499-505`）。
- 因 push 被禁用，GitHub Actions 只能进行**配置审查与本地等价模拟**；任何文档不得写“远程 CI 通过”。
- 各批独立分支/worktree；除“错误码/契约前置”外无跨批代码依赖；不得重复合并已进入 main 的祖先分支（审计 §7 警告）。

---

## 10. 未验证项（B0 诚实披露）

1. **renderer bundle 原始/gzip 口径**：本 worktree 无构建产物，B0 未测量；给历史值与可复现命令（§1.7），待各批构建步骤采集。
2. **实际测试执行通过数**：§1.5 为源码静态计数（reproducible 统计口径），非实际运行结果；以 `python -m unittest discover` / `pnpm test` / `playwright test` 实际输出为准。
3. **`PROTOCOL_VERSION` 是否递增**：§5.1 给出决策原则与建议（错误码扩展不递增），最终以首个共用提交的契约测试断言为准，B0 不实施。
4. **Playwright `archivelens-e2e-userdata-` 目录归属标记来源**：`playwright.config.ts` 未写标记，实际写入点本批未确认（§1.9），B5/B7 需核实并补齐。
5. **远程 CI**：push 禁用，仅配置审查/本地模拟，不可称远程通过。
6. **跨版本升级/回滚、公开许可证批准、正式发布授权**：均未验证/未授权（审计 H-REL-01/H-LIC-01），本计划不触及。

---

## 附：B1 具体输入（实施时使用，B0 不执行）

B1 实施所需的最小输入集合（供后续批次直接取用）：

- **目标文件**：
  - `engine/src/archivelens_engine/db/store.py`（`delete_task` :850-871 改为幂等 + 新增清理作业表/方法，`SCHEMA_VERSION` 递增）
  - `engine/src/archivelens_engine/server.py`（`_h_tasks_delete` :1038-1084 改为：写清理作业 → 任务保持可见 → 清理成功后事务删除；任务不存在幂等成功）
  - `packages/ipc-schema/src/index.ts` + `engine/src/archivelens_engine/protocol.py`（新增 `CLEANUP_FAILED`/`TASK_CLEANUP_PENDING` 错误码）
  - `apps/desktop/src/main/ipc/engine.ts`（`tasks.delete` handler :46-53 保持成功后 `unregisterResourceRoot`/`removeTaskOverride`）
- **合同输入**（逐条可测）：
  1. 删除终态任务 → 写入持久化清理作业，任务状态可见为“清理中/待清理”。
  2. 清理作业成功 → 单事务删除 `tasks` + 13 张派生表 + 工作目录；返回 `{task_id, deleted:true}`。
  3. 对**已不存在**的任务再次 `tasks.delete` → 返回 `{task_id, deleted:true}`（幂等），不抛 `TASK_NOT_FOUND`。
  4. 非终态任务删除 → `TASK_STATE_CONFLICT`（行为不变）。
  5. 清理失败 → 任务保持可见，记录可重试作业；不进入不可见残留态。
  6. 断言：`source_dir` 指向的原始来源文件在删除前后均未被删除/移动。
- **测试输入**：扩展 `engine/tests/test_store.py`、`test_handlers.py`/`test_recovery_handlers.py` 覆盖以上 6 条；`apps/desktop/tests/taskStore.spec.ts`、`engineHandlers.spec.ts` 覆盖成功形状与 Main 侧清理；双端契约测试覆盖新错误码与未知码兜底。
- **前置依赖**：错误码/契约共用提交（§2 汇聚点）先行。
