# ArchiveLens 升级与安全回滚证据（2026-07-18）

## 结论

总体状态：**PARTIAL**。

- 当前 schema v10 的迁移前备份、失败自动恢复、future schema 拒绝：VERIFIED。
- 历史 `alpha.10` schema v2 数据向当前 v10 迁移：VERIFIED。
- 历史 `alpha.10` 直接打开未来 schema 的安全性：FAIL；它会改写新库。
- 当年可信发布安装器 provenance：`BLOCKED_BY_MISSING_TRUSTED_PREVIOUS_ARTIFACT`。
- 正式发布、push、PR、merge、真实用户数据操作：NOT PERFORMED。
- 资金支出：0。

## 历史候选来源与重建

| 项 | 结果 |
| --- | --- |
| 历史提交 | `7d8f3d26b5616d33c882eee7ee26afef12f10b9e` |
| 版本 / Electron / IPC / schema | `0.1.0-alpha.10` / 31.4.0 / 1 / 2 |
| Git tag | 无 |
| 仓库内历史 Setup/Portable | 无 |
| 冻结依赖安装 | PASS；486 包全部复用本机缓存，0 下载 |
| TypeScript / Vitest / desktop build | PASS / 33 PASS / PASS |
| Python Engine 重建 | PASS；Python 3.11.9 / PyInstaller 6.14.1 |
| Setup SHA-256 | `E3B52BB850E229548800381135A3F242F42800B0605A3EC8F678F3559D7BA5C9` |
| Portable SHA-256 | `6F313439B5010205D5C6C0582F12B10DF8493D7B24E8357139B88923D648D1E1` |

这些 SHA 只标识本轮本地重建制品。它们不是当年发布哈希，不得用于声称历史制品来源
可信，也不会提交安装包或构建目录。

## v2 → v10 向前升级演练

重建的打包 Engine 在隔离 `AL_WORKSPACE_ROOT` 中完成：

1. 创建 demo 任务；
2. 生成 6 条 occurrence；
3. 保存一条 `confirmed` 人工结论和备注；
4. 生成并登记 JSON 导出；
5. 优雅关闭旧 Engine；
6. 用当前 `TaskStore` 打开同一数据库。

验证结果：

| 检查 | 结果 |
| --- | --- |
| `user_version` | 2 → 10 |
| 任务 | 1，保留 |
| occurrence | 6，保留 |
| 人工结论 / 备注 | 保留 |
| 旧导出记录 / 文件 | 保留 |
| 迁移前备份 | `migration_completed`，源 v2、目标 v10 |
| 备份 SHA-256 / integrity | 64 位 SHA-256、`integrity_check=ok` |

首次演练脚本误用新版 `output_path` 读取旧版实际返回的 `path`，因此在导出后报告
`KeyError`；生成的数据随后仍成功迁移。修正测试脚本契约后在全新隔离目录重跑，上表
所有检查均通过。该失败属于测试 harness，不是产品迁移失败，原始结果未被隐藏。

## 历史 future-schema 实测

在隔离目录创建只有 marker 表且 `PRAGMA user_version=10` 的 fixture，再启动重建的
`alpha.10` Engine：

- Engine 发出 `engine.ready`，没有拒绝；
- 数据库 SHA-256 改变；
- 新增 8 张旧版表；
- `user_version` 从 10 降为 2；
- marker 数据仍在，但新 schema 已被旧版静默改写。

结论：`UNSAFE_HISTORICAL_FUTURE_SCHEMA_GUARD`。旧版不能作为直接降级路径。

## 当前备份与故障恢复验证

自动化覆盖：正常迁移、迁移中途失败后恢复、备份创建失败阻止迁移、恢复失败 fail-closed、
篡改备份拒绝、当前/全新/future schema 不备份、最近 3 对保留、结果元数据写入失败不反向
伪造已提交迁移失败、数据库目录 reparse point 拒绝、WAL 已提交内容进入快照，以及错误
schema/完整性、记录归属、损坏元数据和底层 I/O 失败。15 项定向测试的文件覆盖率为
lines 99.15%、branches 97.92%；质量门禁固定下限为 95% / 90%。

## 回滚合同与剩余阻塞

安全回滚必须在应用完全退出后，用与旧程序 schema 匹配且通过校验的升级前备份替换数据库，
再启动旧程序。禁止旧程序直接试开新库，禁止手改 `user_version`。

本轮重建证明历史源码可重建并支持数据库向前迁移，但仓库没有当年归档安装器及其发布哈希；
因此真实发布制品的 Setup→Setup、Portable→Portable 升级/回滚 provenance 仍无法验证。该阻塞
不会被本地重建、Mock 或修改历史版本消除。
