# 零成本本地发布门禁

本流程落实 HR-02 的已批准方案：建立可复用、可审计的完整候选验证链，但不执行
正式发布。它只使用本机、仓库脚本和已锁定的公开依赖，不购买证书、法律服务、
CI 额度、托管、商店或其他服务。

## 运行方式

标准模式：

```powershell
pnpm gate:release-local
```

已有完整且通过哈希校验的原生依赖缓存时：

```powershell
pnpm gate:release-local -- -OfflineNative
```

门禁开始时必须满足：

- Windows 10/11 x64；
- Node.js 22.13 或更高版本；
- Python 3.11；
- 当前 worktree 无已暂存、未暂存或未跟踪的非忽略内容；
- 当前 `HEAD` 是准备验证的冻结候选；
- 不存在会被安装 smoke 覆盖的 ArchiveLens 用户安装或快捷方式。

最后一条是 fail-closed 的用户数据保护：安装 smoke 只使用任务拥有的系统临时目录，
若检测到已有用户安装，不会覆盖或卸载它。

## 门禁步骤

1. 冻结完整 Git SHA、版本和工具链版本；
2. `pnpm install --frozen-lockfile`，随后串行执行 Electron 运行时准备；不得让多个
   测试进程在缺少 `electron/dist` 时同时触发首次安装；
3. 源码许可证技术门禁；
4. 先按锁文件准备并校验统一 OCR 模型，将其路径注入当前门禁进程，再运行 Python
   全量测试及覆盖率预算、TypeScript 类型检查、真实 ESLint、Desktop Vitest 覆盖率预算、
   源码构建和 Renderer/Main/Preload 体积预算；
5. 复用已校验模型缓存，准备完整原生组件并重建 PyInstaller Engine；
6. 从同一 SHA 构建 win-unpacked、Setup 和 Portable；
7. 运行完整 Playwright E2E；
8. 运行包内许可证、离线原生组件、八组 OCR、推理中退出和 HTML 导出 smoke；
9. 对 Setup 执行任务隔离的静默安装、启动、Sidecar 就绪、进程清理和卸载；
10. 对 Portable 执行任务隔离的启动、包内资源验证、进程和解压目录清理。若
    electron-builder wrapper 未自动删除随机临时目录，门禁只会删除已由子进程关系、
    候选 SHA、Desktop 哈希、系统临时目录边界和无残留进程共同证明归属本次运行的
    精确目录，并记录 `GATE_OWNED_DIRECTORY`；
11. 记录 Setup / Portable 的 Authenticode 状态。当前 Alpha 接受 `Valid` 或
    `NotSigned`，不会购买或调用付费签名服务；
12. 生成非 partial 的 `release-manifest.json`、`SHA256SUMS.txt`，并验证源码、
    Engine、win-unpacked、Setup、Portable、原生运行树和 smoke 证据绑定同一 SHA；
13. 无论前述步骤成功还是失败，都在 `finally` 中按本次 `RunId` 清理测试拥有的临时
    目录和 Playwright 报告目录，再执行一次 dry-run，确认本次运行残留为 0。

任何实际失败都会令门禁退出非零。公开许可证审核未批准属于预期阻塞，但技术门禁
仍必须通过；脚本会验证该失败只来自 `PUBLIC_*` 人工批准项。清理失败不会覆盖原始
门禁错误；若原门禁成功而清理失败，则整个门禁仍判为失败。

清理只接受双重归属证据：目录名必须包含已知前缀和本次 `RunId`，且目录内
`.archivelens-test-owned` 的内容必须精确等于该 `RunId`；报告目录同样要求
`.archivelens-runid` 精确匹配。盘根、仓库根、用户目录和 reparse point 会被拒绝，
不存在标记、标记不匹配或非本次运行的目录不会被删除。

## 证据

每次运行使用唯一目录：

```text
.tmp/release-gate/<完整候选 SHA>/<UTC 时间>/
```

主要文件：

- `release-gate-summary.json`：最终状态、零费用边界、未执行的外部动作和稳定版阻塞项；
  其中 `test_artifact_cleanup_status`、`test_artifact_cleanup` 和
  `test_artifact_cleanup_error` 记录清理及零残留复核；
- `test-summary.json`：写入 release manifest 的已执行检查摘要；
- `setup-smoke-evidence.json`：安装、实际包内资源、启动、清理和卸载证据；
- `portable-smoke-evidence.json`：便携版实际包内资源、启动和清理证据；
- `verify-release-chain.json`：最终同 SHA 制品链校验结果；
- `logs/`：每个实际执行步骤的独立日志。

覆盖率与体积的机器可读摘要位于 gitignored 的 `coverage/`。预算源为
`scripts/quality-budgets.json`；CI 与本地候选门禁调用同一检查脚本，避免两套阈值漂移。

生成制品继续位于 `apps/desktop/release/`，并由 `.gitignore` 排除。证据和制品都
不得作为用户真实文档提交到 Git。

## 状态含义

- `release-gate-summary.status = PASS`：当前本地候选的源码、构建、打包和 smoke
  证据完整通过；
- `formal_release_action = NOT_PERFORMED`：没有发布、上传、部署、推送、PR 或合并；
- `public_release_license_gate = BLOCKED_EXPECTED`：许可证人工审核尚未批准；
- `upgrade_rollback_status = NOT_VERIFIED`：没有上一可信稳定版安装器，不能证明
  跨版本升级和回退；
- `stable_public_release_status = BLOCKED`：至少仍需许可证人工批准、正式发布授权和
  真实跨版本升级/回滚证据。

本地候选通过不等于稳定版或公开发布批准。

## 真实升级与回滚门禁

稳定公开发布前必须另行提供上一可信稳定版本的安装器和对应 SHA-256，在隔离的
Windows 测试账户或虚拟机中完成：

1. 安装上一稳定版并创建可识别的本地任务数据；
2. 安装冻结候选并验证程序、任务数据库、历史结果和设置兼容；
3. 验证升级失败时的恢复路径和日志；
4. 按已批准的产品策略执行回退，并验证数据是否仍可读取；
5. 保存前后版本、制品哈希、测试数据摘要和结果。

当前仓库没有可据此执行的上一可信发布制品，因此自动门禁必须保留
`NOT_VERIFIED`，不能用同版本覆盖安装或 Mock 数据冒充跨版本验证。本轮已从历史
`alpha.10` 提交重建 Setup/Portable，并完成打包 Engine 创建数据后向当前 schema 的
数据库升级演练；该结果证明源码级升级兼容，但不能把 2026-07-18 重建制品冒充历史发布
provenance。历史 `alpha.10` 还会改写未来 schema，因此降级必须恢复升级前备份，禁止旧版
直接打开当前数据库。证据见
[`reviews/2026-07-18-upgrade-rollback-evidence.md`](reviews/2026-07-18-upgrade-rollback-evidence.md)。
