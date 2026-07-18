# 稳定候选加固实施计划（B0，修订版）

- 创建/修订日期：2026-07-18（本修订为第二个本地提交，不 amend/reset/rebase 已提交的 `7d18a23c`）
- 集成分支（单一）：`codex/feat/stable-candidate-hardening-20260718`
- 隔离 worktree：`F:\.zcf\OCR\stable-candidate-hardening-20260718`
- 起点 HEAD：`b0d0b58d06c3b0cfddf34b9dacd7cb2c4652592e`（B0 开始时与 `origin/main` 同 SHA）
- 文档性质：B0 仅产出本计划并补齐真实基线验证，**不包含 B1–B7 的任何代码、schema、IPC、脚本或测试改动**。
- 证据口径：**VERIFIED**（本轮命令/源码已确认）/ **OBSERVED**（本轮裸命令原始输出）/ **NOT VERIFIED**（本轮未能确认）/ 引用历史审计时单独标注（来源 `docs/reviews/2026-07-16-comprehensive-audit.md`，非本轮重跑）。

## 本轮合同（强制）

1. **单一隔离集成分支**：B0–B7 是在同一个 worktree/分支 `codex/feat/stable-candidate-hardening-20260718` 上**分批顺序提交并集成**的批次，**不是每批一个独立分支/worktree**。各批之间是顺序提交关系，不是并行分支。
2. **禁止正式发布**：本轮不执行 push / PR / merge / release / deploy / 代码签名购买 / 历史重写 / 删除分支或 worktree；不使用 `reset --hard`、`clean -fd`、`checkout --`、`--no-verify`。
3. **远程 CI 不可验证**：本轮 push 受控不执行，GitHub Actions 只能做**配置审查与本地等价模拟**，任何文档**不得**写“远程 CI 通过”。
4. **候选冻结后报告纪律**：冻结候选 SHA 后产生的证据（门禁日志、smoke、测试输出）写入 gitignored 目录或任务回复；**不得**通过新增/修改跟踪文档提交来改变同 SHA 工作树（否则破坏门禁“最终工作树干净”断言，`scripts/run-zero-cost-release-gate.ps1:499-505`）。
5. **零货币成本**：不购买/试用/创建付费资源、付费 API/CI/签名/托管；不引入遥测、远程服务或真实用户数据；所有验证用隔离临时目录，不提交构建产物、日志、数据库、截图、OCR 文本或模型。
6. **主工作区隔离**：`F:\OCR` 主工作区在 B0 开始时已有用户的未暂存改动（见 §1.1），本轮**不触碰、不吸收**。

---

## 1. 事实基线与证据等级（本轮真实重测）

### 1.1 Git 与工作区

| 检查 | 结果 | 等级 | 来源 |
| --- | --- | --- | --- |
| 当前分支 | `codex/feat/stable-candidate-hardening-20260718` | VERIFIED | `git branch --show-current` |
| 起点 HEAD | `b0d0b58d06c3b0cfddf34b9dacd7cb2c4652592e` | VERIFIED | `git rev-parse HEAD` |
| `origin/main` | `b0d0b58d...`（与起点 HEAD 同 SHA） | VERIFIED | `git rev-parse --verify origin/main` |
| 本 worktree 起点状态 | 干净 | VERIFIED | `git status --porcelain`（B0 开始时为空） |
| 真实 `remote.origin.url`（push 实际目标） | `https://github.com/threeMoreTime/ArchiveLens.git` | VERIFIED | `git config --get remote.origin.url` |
| `remote.origin.pushurl` 当前显示 | `disabled://no-push` | OBSERVED | `git config --get remote.origin.pushurl` |
| 主工作区 `F:\OCR` 状态 | 有未暂存改动 ` M docs/reviews/2026-07-16-comprehensive-audit.md`；HEAD 同为 `b0d0b58d` | VERIFIED | `git -C F:/OCR status --porcelain`（只读，未触碰） |

**关于 push 远端（重要更正）**：真实 `origin` 的 push 目标仍是 GitHub（`remote.origin.url`）。`disabled://no-push` 是当前受控 Claude 进程通过环境注入的**命令级安全覆盖**，**不是仓库 remote 的永久配置事实**；不得把它写成 git remote 的固有属性。本轮无论 pushurl 显示如何，都不执行 push。

**关于主工作区**：`F:\OCR` 在 B0 开始时已存在用户对审计文档的未暂存改动；隔离 worktree 起点干净。本轮所有操作仅限隔离 worktree，不读写、不吸收主工作区改动。

### 1.2 版本与协议

| 项 | 值 | 等级 | 来源 |
| --- | --- | --- | --- |
| 应用版本 | `0.1.0-alpha.11` | VERIFIED | 根 `package.json:4`、`apps/desktop/package.json:3`、`engine/src/archivelens_engine/__init__.py:14` 三处一致 |
| `PROTOCOL_VERSION` | `2`（TS/Python 双端） | VERIFIED | `packages/ipc-schema/src/index.ts:13`、`engine/.../__init__.py:17`、本轮构建 `app.info.json.protocol_version=2` |
| Electron（package.json 声明） | `^43.1.1` | VERIFIED | `apps/desktop/package.json:42` |
| Electron（实际安装） | `43.1.1` | VERIFIED | 本轮 `pnpm build` 产出的 `app.info.json.electron_version="43.1.1"` |
| 工具链（本机实测） | Node v24.3.0、pnpm 11.10.0、Python 3.11.9 | OBSERVED | `node --version` 等 |

### 1.3 SQLite 数据层

| 项 | 值 | 等级 | 来源 |
| --- | --- | --- | --- |
| `SCHEMA_VERSION`（`user_version`） | `7` | VERIFIED | `engine/src/archivelens_engine/db/store.py:38`；`_init_schema` 在 `current > SCHEMA_VERSION` 时抛错（:336-337） |
| 并发模型 | `check_same_thread=False` + 进程内 `RLock` 串行化；`journal_mode=WAL`、`busy_timeout=5000`、`foreign_keys=ON` | VERIFIED | `db/store.py:319-330` |
| `delete_task(task_id)` | 单事务内级联删除 13 张派生表 + `tasks`，返回 `rowcount==1`；**对不存在任务返回 `False`（非幂等）**；不触碰来源文件 | VERIFIED | `db/store.py:850-871` |
| 备份能力 | **不存在**（无 Online Backup / integrity-check / SHA-256 / 历史保留） | VERIFIED | 全文检索 `db/store.py` 无 backup 方法 |
| 旧版本遇 future schema 行为 | 本轮**未实测**历史二进制；仅确认当前 `_init_schema` 在 `current > SCHEMA_VERSION` 抛错（拒绝更高版本） | NOT VERIFIED（历史二进制）/ VERIFIED（当前代码拒绝更高版本） | `db/store.py:336-337` |

### 1.4 IPC 协议与关键调用链

- `MethodNameSchema`（`index.ts:272-301`）28 个方法名；`ErrorCodeSchema`（`index.ts:179-202`）为**闭合枚举**，当前 22 个值，与 Python `protocol.ErrorCode`（`protocol.py:27-49`）一一对应。
- `TaskDeleteResultSchema` = `{task_id, deleted:true}`（`index.ts:410-413`），无 tombstone。
- **当前尚无** B1/B2/B3/B6 所需错误码（如 `OUTPUT_ALREADY_EXISTS`、`PREFLIGHT_STALE`、`CLEANUP_FAILED`/`TASK_CLEANUP_PENDING`、`BACKUP_INCOMPLETE`）。

**tasks.delete 现有链与缺口（VERIFIED）**：Renderer → Preload → Main `ipcMain.handle("tasks.delete")`（`engine.ts:46-53`，成功后 `unregisterResourceRoot`+`removeTaskOverride`）→ Sidecar → `_h_tasks_delete`（`server.py:1038-1084`）。现状：要求终态、任务不存在抛 `TASK_NOT_FOUND`（非幂等）、目录 staging→DB 删除→`rmtree` 全程**同步单请求**、清理失败仅报 `DATABASE_ERROR`（DB 已删、无可重试记录）、无“清理中”可见状态。原始来源文件确认永不被删（`_task_workspace_dirs_for_delete` 仅清 `workspace_root/tasks/{id}`，`server.py:1029-1035`）。

**HTML/JSON export 现有链与缺口（VERIFIED）**：
- `_h_export_html`（`server.py:1482-1533`）：目标=`_export_dir/{task_id}-report.html`；底层 `write_offline_review_report`（`html_export.py:394-454`）**已**用 `tempfile.TemporaryDirectory(dir=output_path.parent)`+`os.replace`（同卷同父目录原子写已满足）。
- `_h_export_json`（`server.py:1448-1459`）：`out.write_text(...)` **直接写、非原子**。
- 两者均用确定性文件名、无存在性检查、**总是覆盖**；HTML/JSON 互相独立，无共享 Export Job、无全局单 running、无队列。Main 仅转发（`engine.ts:82-87`）。

**folder 创建/preflight 现有链与缺口（VERIFIED 源码）**：`_h_tasks_create`（`server.py:792-898`）folder 分支用 `src.rglob("*")` 递归枚举。**junction/symlink 跟随行为**：源码中 `rglob` 调用**无任何显式安全策略**（无 reparse point 检测、无 opt-in）；但 pathlib `rglob` 在 Windows 上是否实际跟随 junction/symlink **本轮未实测**，标记为 NOT VERIFIED，B3 须用隔离临时 junction/symlink 实测后再下结论（见 §8 B3）。其余缺口：无网络路径识别/警告/二次确认；磁盘检查未针对 userData 卷；`tasks.start` 不重校验来源（无 `PREFLIGHT_STALE`）。

### 1.5 本轮真实测试基线（OBSERVED，实际命令与退出码）

| 命令 | 退出码 | 真实结果 |
| --- | --- | --- |
| `pnpm install --frozen-lockfile` | **0** | resolved 431，29.6s |
| `pnpm typecheck` | **0** | `packages/ipc-schema` + desktop `typecheck:node`/`typecheck:web` 全通过 |
| `pnpm lint` | **0** | 实测 = `pnpm -r lint` → desktop `pnpm run typecheck`，**即 typecheck 别名，非 ESLint**（与审计 H-QA-01 一致） |
| `pnpm test`（裸，未串行准备 Electron） | **1** | 24 文件中 **22 通过 / 2 加载失败**；**134 项通过**；失败 suite：`loggerRotation.spec.ts`、`sidecarStartupTimeout.spec.ts`（各 0 test），错误 `Electron failed to install correctly` / `os error 80 文件存在`（并发首次安装损坏，审计 A-REL-04/B-13 同一根因） |
| `pnpm --filter @archivelens/desktop exec install-electron`（串行） | **0** | 修复 Electron dist |
| `pnpm test`（串行准备后重跑） | **0** | **24 文件 / 138 项通过**（与审计 B-13 基线一致） |
| `PYTHONPATH="engine/src;engine" python -m unittest discover -s engine/tests -t engine -v`（未准备 OCR 模型） | **1** | **Ran 277，errors=79，skipped=1** → 197 ok / 79 error / 1 skip。79 个 error **全部为同一根因** `FileNotFoundError: 缺少统一 OCR 模型 PP-OCRv6_rec_small.onnx`（门禁先 `prepare-native-runtime.ps1 -OcrOnly` 准备锁定模型；审计 B-13 基线为 278 通过——**本轮未重跑该准备步骤**，故如实记为失败） |
| `pnpm --filter @archivelens/desktop exec playwright test --list`（仅收集不运行） | **0** | **Total: 25 tests in 4 files** |

**统计口径说明**：源码静态计数（B0 首版曾用）= Python 289 个 `def test` / Vitest 109 处 `it|test(` / Playwright 25；本轮**实际运行**口径 = Vitest 138 项、Python 197 ok+79 err+1 skip（Ran 277）、Playwright 收集 25。两者不同：静态计数含未运行/加载失败的用例，以实际运行输出为准。

### 1.6 renderer bundle 口径（本轮构建，VERIFIED）

`pnpm build`（exit 0，14.78s）产物 `apps/desktop/out/renderer/assets/`（gitignored）：

| 文件 | 原始字节 | gzip 字节 |
| --- | --- | --- |
| `index-DURcFMJ4.js` | 1,239,376（≈1,226.64 kB） | 258,064（≈252.0 kB） |
| `index-Cn9Cmj3O.css` | 48,721（≈48.55 kB） | 8,995（≈8.79 kB） |
| `icon-64-Dp_op-QE.png` | 9,942 | 9,965（已压缩，gzip 反增大） |
| **JS 合计** | **1,239,376** | **258,064** |
| **CSS 合计** | **48,721** | **8,995** |
| **全部合计** | **1,298,039** | **277,024** |

构建元数据 `app.info.json`（gitignored）：`version=0.1.0-alpha.11`、`git_commit=7d18a23c`（当前 B0 HEAD）、`electron_version=43.1.1`、`protocol_version=2`。

### 1.7 运行后工作树洁净度（VERIFIED）

基线命令全部跑完后：`git status --porcelain` = **空**（无跟踪文件改动）；`git ls-files --others --exclude-standard` = **空**（无未忽略未跟踪文件）。产生的 `apps/desktop/out/`、`apps/desktop/app.info.json`、`engine/**/__pycache__/` 均被 `.gitignore` 忽略。本轮**未使用** `git clean`/`reset`/`checkout` 清理。

### 1.8 零成本发布门禁与 Setup/Portable（VERIFIED 配置 / 无当前制品）

- 门禁脚本 `scripts/run-zero-cost-release-gate.ps1`（`pnpm gate:release-local`），步骤见 :318-497；证据落 `.tmp/release-gate/<SHA>/<UTC>/`（gitignored）；`release-gate-summary.json` 始终 `monetary_cost=0`、`push/PR/merge/deploy/signing=NOT_PERFORMED`、`stable_public_release_status=BLOCKED`（:176-207）。
- **Setup/Portable 当前制品**：本 worktree **不存在** `apps/desktop/release` 与 `.tmp/release-gate`（本轮未跑门禁）。因此当前**没有可引用的 Setup/Portable 制品或签名事实**，只能记为“不存在当前制品 / 签名未验证”。
- **NotSigned 是已批准的 Alpha 策略**（门禁 :444-460 接受 `Valid`/`NotSigned`），**不是**对某个当前文件签名状态的实测结论——不得冒充当前制品签名事实。最近一次同 SHA 全通过证据见历史审计 B-13（`2fa7bebc`，30/30；历史，非本轮）。

### 1.9 已确认缺陷：本地门禁 `finally` 未调用清理（VERIFIED）

- `scripts/cleanup-test-artifacts.ps1` 存在且安全：按 `RunId` + 临时前缀（`archivelens-e2e-userdata-`/`-setup-smoke-`/`-portable-smoke-`/`-migration-test-`/`-ocr-temp-`）**且**目录内含 `.archivelens-test-owned` 标记，或报告根含 `.archivelens-runid` 标记匹配 `RunId` 筛选；`Is-SafeTarget` 拒绝盘根/仓库根/`$HOME`/reparse point（:13-40, 60-90）。
- **缺陷**：`run-zero-cost-release-gate.ps1` 的 `finally`（:525-530）**仅还原环境变量并 `Pop-Location`，从不调用 `cleanup-test-artifacts.ps1`**。门禁注入 `$env:ARCHIVELENS_TEST_RUN_ID`（:315）但运行结束不回收本次 smoke 在 C:`%TEMP%` 的残留。
- **标记覆盖现状（VERIFIED，更正首版）**：
  - Playwright **已写**标记：`lifecycle.spec.ts`（:17-26，写 `.archivelens-test-owned` 与 `.archivelens-runid`）、`custom-search.spec.ts`（:67-69）、`review-completeness.spec.ts`（:27-28）。`vertical.spec.ts` **未写**标记（本轮 grep 确认）。
  - Python smoke（`html-smoke.py`/`packaged-ocr-smoke.py`/`shutdown-inference-smoke.py`）**已写** `.archivelens-test-owned`。
  - PowerShell smoke（`smoke-installer.ps1`/`smoke-portable.ps1`）创建 `archivelens-{setup,portable}-smoke-{runId}` 目录但**未写** `.archivelens-test-owned`；成功时自清理（`Remove-ReleaseSmokeOwnedRoot`），**失败中断时目录孤立且 cleanup 无法匹配**——这是真实缺口。
- **B7 待办**：核对**所有**产生已知前缀目录的路径是否 100% 写标记，重点补 PS smoke 失败路径与 `vertical.spec.ts`；并在门禁 `finally` 按 RunId+前缀+标记调用清理。本轮只记录，不清理。

### 1.10 CI（VERIFIED 配置；远程不可验证）

`.github/workflows/ci.yml` 作业：`engine-tests`、`desktop-tests`、`ipc-contract`、`lifecycle-e2e`、`package-smoke`（均 `windows-latest`）。本轮 push 不执行，只能做配置审查与本地等价模拟，**不得称远程 CI 通过**。

---

## 2. 批次定义与依赖图（更正：单一集成分支顺序提交）

**本轮为单一隔离集成分支** `codex/feat/stable-candidate-hardening-20260718`；B0–B7 在该分支上**顺序提交、顺序集成**，不是每批独立分支/worktree。各批在前一批提交之上继续，互不并行。

| 批次 | 主题 | 对应审计项 |
| --- | --- | --- |
| **B0** | 本计划 + 真实基线（docs only） | — |
| **B1** | 任务删除：独立持久化清理作业 + 幂等删除合同 | H-DATA-01 / HR-08 |
| **B2** | HTML/JSON 持久化 Export Job + 全局单 running（队列）+ 同卷原子写 + 目标存在一律 `OUTPUT_ALREADY_EXISTS` | H-EXP-01 / A-REL-02 |
| **B3** | folder/来源预检：网络路径警告二次确认、junction/symlink 默认不跟随（待实测）、userData 卷磁盘检查、创建时重校验 `PREFLIGHT_STALE` | H-SCALE-01 / HR-07 |
| **B4** | 本地数据与隐私边界：威胁模型、静态数据（DB/OCR/导出明文）保留与处置策略、备份隐私 | H-PRIV-01 / HR-09 |
| **B5** | 真实 ESLint/覆盖率/bundle/CI：引入真实静态规则门禁、覆盖率预算、bundle 预算/拆包、CI 加固 | H-QA-01、H-QA-02、H-PERF-01、HR-06（**已纳入范围，不再列为未授权**） |
| **B6** | SQLite 备份/回滚：Online Backup + integrity check + SHA-256 + 最近 3 份 + 卸载不删 + 旧版本拒绝 future schema | H-DATA-01（备份侧）/ HR-08 |
| **B7** | 文档收口 + 完整门禁 + 最终验收：冻结前完成所有跟踪文档、修复门禁 `finally` 清理残留、对冻结候选跑完整零成本门禁、最终验收摘要 | H-REL-01 技术范围 / A-REL-04 残留侧 |

**依赖图（顺序集成）：**

```
B0(docs) ──▶ [共用前置: ErrorCodeSchema/protocol.ErrorCode 扩展 + 双端契约测试]
                   │
        ┌──────────┼──────────┐
        ▼          ▼          ▼
       B1         B2         B3   (B3 预检可被 B2 导出前复用)
        │          │          │
        └──────────┴──────────┘
                   │
        ┌──────────┴──────────┐
        ▼                     ▼
       B4(数据/隐私)        B6(备份/回滚)   (B6 依赖 B4 隐私边界决策)
        │                     │
        └──────────┬──────────┘
                   ▼
       B5(ESLint/coverage/bundle/CI)   (横切质量，依赖前面行为稳定)
                   │
                   ▼
       B7(文档收口 + 门禁 finally 清理修复 + 完整门禁 + 最终验收)
```

- **共用前置**（建议作为 B1 之前的首个提交）：B1/B2/B3/B6 都需扩展闭合的 `ErrorCodeSchema`+`protocol.ErrorCode` 并同步双端契约测试，集中一次以避免重复改同一枚举。
- **B6 依赖 B4**：备份保留/处置与隐私边界（HR-09）相关，B4 先定边界，B6 再实现备份。
- **B5 横切**：lint/coverage/bundle/CI 跨整个代码库，放在行为批次之后更稳。
- **B7 收尾**：含门禁 `finally` 清理残留修复（原合同“B5/B7 修复门禁残留”中的清理部分，按本版编号归入 B7“完整门禁”），并对冻结候选跑完整门禁、产出最终验收。

---

## 3. 零成本台账

| 资源类 | 现状/计划 | 费用 |
| --- | --- | --- |
| 货币 | 0；不购买证书/CI 额度/托管/签名/API | 0 |
| 远程动作 | push/PR/merge/release/deploy/sign 全禁用；push 远端真实仍为 GitHub，但本轮不推送 | 0 |
| 代码签名 | NotSigned（已批准 Alpha 策略；非当前文件签名事实） | 0 |
| 遥测/远程服务 | 无；CSP `connect-src 'self'`；不引入 | 0 |
| 真实用户数据 | 不读写真实 `%APPDATA%\ArchiveLens`/任务库；测试用隔离 `AL_WORKSPACE_ROOT`/临时目录 | 0 |
| 构建产物/模型 | gitignored（`dist/`、`out/`、`release/`、`.tmp/`）；不提交 | 0 |
| 新增运行时依赖 | B1–B7 仅用现有栈（`sqlite3.backup()`、`tempfile`/`hashlib`、PowerShell）；B5 ESLint/Biome 属开发依赖，不进生产包 | 0 |

每批提交说明与门禁摘要显式记录 `monetary_cost=0` 与未执行的外部动作。

---

## 4. schema / IPC 变更预案

### 4.1 错误码扩展（B1/B2/B3/B6 共用前置）

新增到 `ErrorCodeSchema`（`index.ts:179-202`）与 `protocol.ErrorCode`（`protocol.py:27-49`）：

| 新码 | 用途 | 批次 |
| --- | --- | --- |
| `OUTPUT_ALREADY_EXISTS` | 导出目标已存在（本轮一律不覆盖） | B2 |
| `PREFLIGHT_STALE` | 创建/启动时来源校验结果已变化 | B3 |
| `CLEANUP_FAILED` / `TASK_CLEANUP_PENDING` | 清理作业失败/进行中 | B1 |
| `BACKUP_INCOMPLETE` | 备份未完成或完整性校验未通过 | B6 |

契约要求（依 CLAUDE.md §IPC 契约）：两端同时改；更新 `apps/desktop/tests/contract.spec.ts`（`pnpm test:contract`）+ `engine/tests/test_ipc_contract.py`；新方法名加入 `MethodNameSchema` 并在 `parseMethodResult` 注册结果解析。

### 4.2 PROTOCOL_VERSION 决策（B3 已验证）

`ErrorCodeSchema` 是闭合枚举，未知错误码会被严格拒绝；更关键的是，B3 新界面创建文件夹任务前必须调用 `tasks.preflight*`，旧 v2 引擎没有该方法。新界面与旧引擎握手若仍报告 v2，会先错误地判定兼容、随后在核心创建流程失败。因此 B3 将 TS/Python `PROTOCOL_VERSION` **同步递增为 3**，并更新共享 fixture、诊断/冒烟脚本、构建清单、握手测试和协议文档。v3 引擎与 v3 桌面端必须同 SHA 打包；v2 明确在握手阶段拒绝，不做运行期隐式降级。

### 4.3 各批方法/结果/schema 预案（B0 不实现）

- **B1**：`tasks.delete` 结果保持 `{task_id, deleted:true}`；幂等（任务不存在视为已删除）。新增持久化清理作业表（`SCHEMA_VERSION` v7→v8）；可选 `tasks.cleanupStatus` 只读查询与 `task.cleanup.*` 事件。
- **B2**：HTML 与 JSON **共用持久化 Export Job**（需 schema：`export_jobs` 表，含 status/path/kind/sha 等）；全局最多一个 running，**其余合法请求 queued（不拒绝）**；**本轮不提供 `overwrite` 参数**，目标存在一律 `OUTPUT_ALREADY_EXISTS`，用户选新路径后重试；临时输出沿用 `tempfile(dir=final.parent)`+`os.replace`（HTML 已具备，JSON 对齐）。
- **B3**：`tasks.create`/`tasks.start` 返回/事件携带预检摘要（网络路径、junction 计数、磁盘可用空间）；变化抛 `PREFLIGHT_STALE`。
- **B4**：定义静态数据保留/处置与隐私边界（可能引入设置项或策略字段，依 HR-09 决策）。
- **B5**：引入 ESLint flat config（或 Biome）+ 覆盖率阈值 + bundle 预算；CI 增 job。属开发依赖与配置，不改 IPC。
- **B6**：新增 `backup.create`/`backup.list`/`backup.restore`（或同等）方法与结果 schema；备份注册表（schema 升级）；元数据含 SHA-256、integrity-check、schema 版本。
- **B7**：门禁 `finally` 调用清理；文档收口；完整门禁与最终验收。

### 4.4 SQLite 迁移

B1 清理作业表、B6 备份注册表均走 `_migrate_schema(current)` 增量路径（`db/store.py:382-528`），保持 `current > SCHEMA_VERSION` 拒绝（:336-337）。每批补：旧→新迁移、拒绝更高版本、迁移失败回滚用例。

---

## 5. 数据兼容与回滚合同

### 5.1 已批准合同（强制）

- **B1**：使用独立持久化清理作业；清理完成前任务保持可见；成功后永久删除任务及派生记录；不存在任务的重复删除视为幂等成功；不长期保留用户可见 tombstone；原始来源永不删除。
- **B2**：HTML 和 JSON 共用持久化 Export Job；全局最多一个 running，其余合法请求 queued；临时输出位于最终目标同卷同父目录；目标存在时一律 `OUTPUT_ALREADY_EXISTS`，绝不自动覆盖（本轮无 overwrite 参数）。
- **B3**：网络路径允许但必须警告并二次确认；默认不跟随 junction/symlink；磁盘检查针对 userData 所在卷；任务创建时重新验证，变化则 `PREFLIGHT_STALE`。
- **B6**：使用 SQLite Online Backup API 或同等一致性机制，备份后 integrity check 与 SHA-256；默认保留最近 3 份；卸载不自动删除；历史旧版本若不能拒绝未来 schema，不得修改旧版本伪造通过，总体最多 PARTIAL。

### 5.2 B1 删除顺序（准确语义，更正）

**不得**描述为“文件系统与数据库在同一事务”。准确顺序：

1. 写入**持久化清理作业**（任务保持可见，状态可表示“待清理/清理中”）；
2. 清理该任务的**派生目录**（staging rename → rmtree）；
3. **随后**以数据库事务**硬删除**任务记录、派生记录与清理作业；
4. 崩溃重试时：若派生目录已不存在，视为可安全完成（继续 DB 硬删除）；若 DB 已无该任务，视为幂等成功。

### 5.3 旧版本与 future schema（更正）

- 旧版本遇到 **future schema 必须明确拒绝打开**（不是“拒绝或只读”）。
- 若**真实历史版本**缺少该保护（无法拒绝 future schema），则**如实标 PARTIAL**，并记录“不能修改旧版本伪造通过”。
- 本轮**未实测历史二进制**（§1.3 NOT VERIFIED）；B6 须用真实旧版本验证其是否拒绝 future schema，再据实判定。

### 5.4 其他兼容规则

- Git 回退 ≠ 数据回滚（审计 §2/§10：v7→v6 数据回退未验证；代码回退不等同用户数据回滚）。B1–B7 不改变此边界。
- 备份恢复前校验 integrity_check + SHA-256；不匹配不覆盖现库；保留恢复前快照。
- 候选冻结后证据不得通过跟踪文档提交改变同 SHA 工作树。

---

## 6. 测试矩阵

| 批次 | Python 单测 | Desktop Vitest | 契约(双端) | Playwright E2E | 门禁/脚本 |
| --- | --- | --- | --- | --- | --- |
| 共用前置 | `test_ipc_contract`/`test_protocol` 新码 + 未知码解析实测 | `contract.spec.ts` 新码 | ✓✓ | — | — |
| B1 | `test_store`（清理作业/幂等）、`test_handlers`/`test_recovery_*`（删除顺序、崩溃重试目录不存在、清理失败可见） | `taskStore.spec.ts`、`engineHandlers.spec.ts` | ✓ | lifecycle（删除后状态） | — |
| B2 | `test_html_export`/`test_report_pipeline_html`（同卷原子、`OUTPUT_ALREADY_EXISTS`）、`test_handlers`（单 running + 队列） | `ExportPage`、`engineHandlers` | ✓ | 导出 E2E（目标存在提示新路径） | — |
| B3 | `test_handlers`/`test_document_backends`（**真实临时 junction/symlink 实测**、网络警告、磁盘检查、`PREFLIGHT_STALE`） | `NewScan`/`taskStore` 预检 | ✓ | custom-search（folder 预检） | — |
| B4 | 数据保留/处置策略单测 | 设置/隐私 UI | — | — | — |
| B5 | — | 规则零告警基线、覆盖率阈值 | — | — | CI lint/coverage job；bundle 预算断言 |
| B6 | `test_store`（backup/integrity/SHA256/保留 3/**旧版本拒绝 future schema 实测**） | 备份 UI/设置 | ✓ | — | — |
| B7 | `test_release_gate`（finally 调用 cleanup、清理错误不掩盖原错误、RunId 内残留=0、标记 100% 覆盖） | — | — | — | PS 5.1/7 语法；本地完整门禁 |

**批次统一收口**：每批先跑相关单测，再跑 `pnpm typecheck`+`pnpm test`+Python unittest（**先 `prepare-native-runtime.ps1 -OcrOnly` 准备模型**）+`pnpm build`+相关 Playwright；最终由 B7 对冻结候选跑完整 `scripts/run-zero-cost-release-gate.ps1`。

---

## 7. 风险与范围

### 7.1 范围内（B1–B7 将在单一集成分支顺序实施）

B1 删除清理作业；B2 Export Job；B3 来源预检；B4 本地数据/隐私边界；B5 真实 ESLint/覆盖率/bundle/CI；B6 备份/回滚；B7 文档收口+门禁清理修复+完整门禁+最终验收；共用错误码/契约前置。

### 7.2 明确不实施范围（out of scope）

- 不做 push/PR/merge/release/deploy/签名购买/历史重写/删分支/worktree；不用 `reset --hard`/`clean -fd`/`checkout --`/`--no-verify`。
- 不修改 `F:\OCR` 主工作区及其未暂存改动、真实 `%APPDATA%`/`%LOCALAPPDATA%`、真实任务数据。
- B0 不含 B1–B7 任何代码/schema/IPC/脚本/测试改动。
- 不声称远程 CI 通过、跨版本升级/回滚已验证、公开许可证已批准、稳定版已发布。
- 不引入遥测/远程服务/付费资源/真实用户数据。
- 审计仍未决的 HR-05（最小窗口）、HR-10（模块拆分）、HR-11（批量校对）不在本轮范围，除非用户另行授权。

### 7.3 主要风险

| 风险 | 等级 | 缓解 |
| --- | --- | --- |
| `ErrorCodeSchema` 闭合枚举，新增码不同步双端破坏解析 | R2 | 共用前置同步+契约测试；PROTOCOL_VERSION 按兼容性实测决定（§4.2） |
| B1 顺序/幂等改变影响 UI 与既有删除测试 | R2 | 成功形状不变；幂等仅“任务不存在”返回成功；补回归 |
| B2 一律不覆盖是行为变更（原同 kind 二次导出会覆盖） | R2 | UI 提示用户选新路径；补 E2E |
| B3 junction 不跟随可能影响合法链接库 | R2 | 仅作用用户来源；显式 opt-in；真实临时 junction 实测 |
| B6 旧版本遇 future schema 处理 | R2 | 实测旧版本；如实 PARTIAL，不改旧版本伪造 |
| B7 清理误删非本次目录 | R2 | 严格 RunId+前缀+标记+安全目标；清理错误不掩盖原错误 |

---

## 8. 每批验收标准（B1–B7；B0 不含代码验收）

### B0（本批）
- 仅 `docs/plans/stable-candidate-hardening.md`（首提交 `7d18a23c`）+ 本修订（第二提交）；无代码/schema/IPC/脚本/测试改动。
- 真实基线命令已跑并记录实际退出码/计数/bundle（§1.5/§1.6）；运行后工作树干净（§1.7）。
- 不声称 B1–B7 已完成。

### B1（任务删除清理作业）
- 存在持久化清理作业；任务清理完成前保持可见。
- 按 §5.2 顺序：持久化 job → 清派生目录 → DB 事务硬删除任务+job；崩溃重试目录不存在=可安全完成。
- 重复删除“任务不存在”→ 幂等成功（不再 `TASK_NOT_FOUND`）；非终态仍 `TASK_STATE_CONFLICT`。
- 清理失败任务保持可见可重试；原始来源文件永不删除（回归断言）。

### B2（Export Job）
- HTML 与 JSON 共用**持久化 Export Job**（schema 变更）。
- 全局最多一个 running，**其余合法请求 queued**（不拒绝）。
- 临时输出位于任务专属临时目录；每个作业使用含 `export_id` 的独立正式文件名，成功后原子 `os.replace`。
- 失败、取消或中断不会覆盖既有成功导出；临时和非成功正式残留按作业归属安全清理。

### B3（来源预检）
- 已实现可取消 Preflight Job；网络路径、大任务、跳过链接和磁盘紧张需要二次确认。
- 默认不跟随 junction/symlink/reparse point；Windows 真实子 junction 与父 junction 用例已验证 fail-closed。
- 磁盘检查针对 userData 所在卷；创建时重新枚举并校验 `scan_token`，变化 → `PREFLIGHT_STALE`。
- 创建成功后把安全清单固化到 `task_sources`，实际扫描不再重新递归被跳过的路径。
- 因新界面依赖新增预检方法且 v2 引擎无法履约，IPC 协议同步升级为 v3，旧引擎在握手阶段明确拒绝。

### B4（本地数据与隐私边界）
- 明确静态数据（DB/OCR/导出）明文威胁模型与保留/处置策略；与备份（B6）、卸载保留策略一致。
- 不引入遥测/远程；策略可文档化或最小设置项。

### B5（真实 ESLint/覆盖率/bundle/CI）
- 引入真实静态规则门禁（ESLint flat config 或 Biome），首批零告警基线。
- 覆盖率预算与 bundle 预算（对照 §1.6 JS raw 1,239,376 B / gzip 258,064 B）。
- CI 增对应 job；**HR-06 已授权，不再列为未授权**。

### B6（备份）
- `sqlite3` Online Backup API；备份后 `integrity_check` 通过并记 SHA-256。
- 默认保留最近 3 份；卸载不自动删除。
- **旧版本遇 future schema 必须拒绝打开**（实测旧版本；若真实无此保护，如实 PARTIAL，不改旧版本伪造）。

### B7（文档收口 + 完整门禁 + 最终验收）
- 冻结候选 SHA **前**完成所有跟踪文档。
- 修复门禁 `finally`：按 `run_id`+已知前缀+`.archivelens-test-owned`/`.archivelens-runid` 标记调用 `cleanup-test-artifacts.ps1 -Confirm`；**清理错误不掩盖原始错误**；补齐 PS smoke 失败路径与 `vertical.spec.ts` 标记覆盖（100% 核对）。
- 冻结候选后跑完整零成本门禁；**结束后本次 RunId 残留为 0**（dry-run 可审计）。
- 产出最终验收摘要（不发布、不 push、远程 CI 仅配置审查）。

---

## 9. 未验证项（B0 诚实披露）

1. **Python unittest 真实健康度**：本轮因未准备锁定 OCR 模型，79 error 为共同根因（§1.5）；门禁先 `prepare-native-runtime.ps1 -OcrOnly` 后的 278 通过为历史口径，**本轮未重跑**。
2. **B3 junction/symlink 跟随行为**：源码无显式安全策略，但 `rglob` 实际是否跟随 Windows junction/symlink **未实测**（§1.4、§8 B3）。
3. **旧版本遇 future schema**：当前代码拒绝更高版本；历史二进制是否拒绝 future schema **未实测**（§1.3、§5.3）。
4. **Setup/Portable 当前签名/制品**：本轮无制品，仅“不存在/未验证”；NotSigned 是策略非实测（§1.8）。
5. **远程 CI**：push 不执行，仅配置审查/本地模拟（§1.10）。
6. **`vertical.spec.ts` 标记与 PS smoke 失败路径**：标记覆盖待 B7 补齐核对（§1.9）。
7. **跨版本升级/回滚、公开许可证批准、正式发布授权**：未验证/未授权（审计 H-REL-01/H-LIC-01）。

---

## 附：本轮真实命令与退出码汇总

```text
pnpm install --frozen-lockfile                                  EXIT=0
pnpm typecheck                                                  EXIT=0
pnpm lint (= typecheck alias, not ESLint)                       EXIT=0
pnpm test (raw, Electron concurrent-install corruption)         EXIT=1  134 passed / 2 suites failed
pnpm --filter @archivelens/desktop exec install-electron        EXIT=0
pnpm test (after serial Electron prep)                          EXIT=0  24 files / 138 tests
PYTHONPATH="engine/src;engine" python -m unittest discover ...  EXIT=1  Ran 277 / errors=79(model) / skipped=1
pnpm --filter @archivelens/desktop exec playwright test --list  EXIT=0  25 tests / 4 files
pnpm build                                                      EXIT=0  electron 43.1.1, commit 7d18a23c, proto 2
# bundle: JS raw=1,239,376 gzip=258,064 | CSS raw=48,721 gzip=8,995 | ALL raw=1,298,039 gzip=277,024
# post-run: git status --porcelain empty; no untracked-non-ignored; outputs gitignored
```
