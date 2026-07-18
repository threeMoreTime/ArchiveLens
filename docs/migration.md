# 数据库迁移说明

## 当前 Schema v11

ArchiveLens 当前使用 SQLite schema v11。迁移在单个事务中执行；失败会
rollback，未来高于 v11 的 schema 会 fail-closed 且不修改数据库。已是 v11 的
数据库重复打开不会执行回填或索引重建。

## 迁移前备份与失败恢复

打开 `0 < user_version < 11` 的历史数据库时，Engine 会在执行任何 schema DDL 前使用
SQLite Online Backup API 建立一致性快照：

```text
userData/engine/backups/
├─ archivelens-schema-v<旧>-to-v11-<UTC>-<id>.sqlite3
└─ archivelens-schema-v<旧>-to-v11-<UTC>-<id>.json
```

备份必须与源 schema 一致、通过 `PRAGMA integrity_check`，并记录 SHA-256、字节数、
源/目标 schema、创建时间和迁移结果。数据库、备份目录、备份文件或元数据若是符号链接
或 Windows reparse point，迁移会在写入前 fail-closed。备份及元数据使用临时文件和
原子替换，默认保留最近 3 对；卸载不会删除这些本地明文备份。

若迁移事务失败，Engine 会 rollback、关闭连接、重新校验备份的路径、大小、SHA-256、
schema 和完整性，然后原子恢复并重新抛出原始迁移错误。恢复本身无法验证时，Engine
抛出 `MigrationRecoveryError` 并停止继续写入；不会假装启动成功。全新库、当前 v11 库
和未来 schema 均不创建迁移备份。备份注册表采用数据库外 JSON 元数据，避免为了备份
能力再次修改待保护的数据库 schema。

该备份只复制 schema 迁移会修改的 SQLite 数据库；来源档案、页面图片和导出不参与
schema 迁移，因此不会被复制或删除。SQLite Online Backup 会包含已经 commit、但仍在
WAL 中的内容。

v10 → v11 在任务表增加不可变的 `search_script_scope`，取值为
`simplified / traditional / both`。历史任务安全回填为 `both`；新任务在创建时固化
设置页当时的默认范围。恢复历史未完成任务时，Engine 会从已经持久化的 OCR 原文与
OpenCC 索引幂等补齐旧页命中，不重新 OCR、不修改 checkpoint，也不覆盖 OCR 原文。
同一位置重复回填由稳定业务键去重；无法可靠映射回原文坐标的长度变化索引只保留在
任务内检索页，不伪造校对结果坐标。

v9 → v10 为持久化导出作业增加临时目录清理状态、结构化错误和重试次数，并建立
格式、生命周期状态、清理状态及“同一任务同一格式最多一个活动作业”的数据库约束。
迁移若发现旧库中存在重复活动作业，会保留最新一项，其余标记为 `interrupted`，不会
删除已成功导出的文件。合法导出按创建顺序排队，全局最多一个作业写入；应用重启后
继续排队作业，并把此前实际运行中的作业标记为可重试的 `interrupted`。

v8 → v9 新增 `export_jobs`，持久化 JSON/HTML 导出的阶段、进度、取消请求、临时路径、
正式路径和错误。每个作业使用独立临时目录及带 `export_id` 的独立正式文件名；只有
写入成功并完成数据库事务后才记入成功历史。失败或取消不覆盖已有成功文件，临时文件
清理失败会保留可诊断记录并在启动时重试。

v7 → v8 新增 `task_cleanup_jobs`，记录任务删除的尝试次数、错误和恢复状态。删除只清理
应用工作区内的派生数据，来源文件只读且永不进入清理集合；文件占用、权限或路径安全
校验失败时任务仍可见并可重试。Windows reparse point、junction 和越出工作区的父目录
链一律 fail-closed。

## 已验证的历史升级与降级边界

本轮从历史提交 `7d8f3d26` 重建了 `0.1.0-alpha.10`（协议 v1、schema v2）的 Engine、
Setup 和 Portable。重建制品创建 demo 任务、6 条结果、校对结论、备注和 JSON 导出后，
当前源码成功迁移到 schema v10；上述数据和导出文件均保留，迁移前 v2 备份校验通过。
这证明了该历史源码到当前 schema 的数据库升级路径，但重建制品不是当年归档发布制品，
不能替代“上一可信发布安装器”的 provenance 门禁。

同一历史 Engine 面对隔离的 schema v10 fixture 时没有拒绝：它启动成功，把
`user_version` 从 10 改为 2，并新增旧版表。因此 **alpha.10 不具备 future schema
保护，绝不能用于直接打开当前数据库**。该事实不能通过修改历史源码或重新打包伪造为
通过。

安全降级合同固定为：

```text
确认 ArchiveLens 已完全退出
→ 隔离新版本数据目录
→ 卸载新版本（保留 userData）
→ 安装旧版本
→ 仅恢复升级前、schema 与旧版本匹配且校验通过的备份
→ 再启动旧版本并核验任务数据
```

不得让旧程序试探性打开新 schema，也不得手工修改 `PRAGMA user_version`。当前仓库没有
当年归档的可信 `alpha.10` 安装器，因此真实已发布制品的 Setup→Setup、Portable→Portable
升级/回滚仍标记 `BLOCKED_BY_MISSING_TRUSTED_PREVIOUS_ARTIFACT`，总体最多为 PARTIAL。
本轮重建与数据库级演练证据见
[`reviews/2026-07-18-upgrade-rollback-evidence.md`](reviews/2026-07-18-upgrade-rollback-evidence.md)。

## Schema v7 OCR 语料与简繁索引

v6 → v7 只新增 OCR 语料和检索索引结构：

- `tasks` 增加语料版本、索引状态、模型 ID、模型 SHA-256 和已索引页数；
- `ocr_corpus_pages`、`ocr_lines` 保存任务内逐页、逐行 OCR 证据；
- `ocr_line_indexes` 保存简体、标准繁体、台湾、香港四套 OpenCC 索引文本；
- `ocr_search_sessions`、`ocr_search_hits` 为后续可重复检索保留持久化结果结构；
- `ocr_lines` 的原文、上下文解析文本、坐标、置信度、模型和候选证据由
  SQLite trigger 保护为不可变；人工校对只能写入独立的 nullable correction
  字段，不能覆盖 OCR 原文。

页面完成时，OCR 语料、四套索引、旧 occurrence、processed page、checkpoint 和
`task.progress` 事件在同一事务提交；任一写入失败会整体 rollback。任务结束后索引
状态根据已索引页数和失败数标记为 `ready` 或 `partial`。

旧任务不会伪造 OCR 全文，也不会自动用转换文本覆盖历史结果。迁移后统一标记为
`legacy_requires_reocr`，原 occurrence、校对、备注、checkpoint、事件和导出仍
保留；要使用新简繁双向索引，必须由用户明确创建重新 OCR/索引任务。

## 本地设置 v3

`userData/settings.json` 的版本由 2 升为 3，只新增全局
`appearance.search_script_scope`，允许 `simplified / traditional / both`，默认
`both`。读取 v1/v2 时在内存中补默认值并在下次用户保存设置时原子写入 v3；不访问
或改写任务数据库、OCR 原文、索引及用户源文件。回滚旧应用前可备份该 JSON；旧应用
若不能识别 v3，应恢复备份，而不是手工修改任务数据。

## Schema v5 历史

v4 → v5 是仅新增结构的迁移：任务表增加 `source_kind` 与 `source_label`，并新增 `task_sources` 表保存文件清单的顺序、展示名和稳定 source ID。旧任务默认标记为 `folder`，来源标签回填为原 `source_dir`；旧任务的 occurrence、校对、备注、checkpoint、事件与导出记录不会被删除或改写。

## Alpha10 已完成任务

- `search_terms` 回填为 `["约", "約"]`；
- `search_mode` 为 `legacy_fixed_pair`；
- occurrences、review、note、export、processed pages、checkpoint 与 events 保留；
- completed 状态不改变，不出现错误恢复提示。

## Alpha10 未完成任务

具备可信 `task_processed_pages` 与 `task_checkpoints` 的任务按 source 独立恢复，支持非连续已处理页集合。缺少这些可信证据的旧任务标记：

```text
LEGACY_TASK_REQUIRES_REVIEW
```

该状态不允许自动 resume，不伪造 checkpoint、不删除旧结果、不修改校对和导出记录，也不会静默从头扫描。用户可查看旧结果，并基于原来源目录创建新的 A11 任务。
