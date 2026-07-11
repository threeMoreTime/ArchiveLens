# 数据库迁移说明

## Schema v3

A11 使用 SQLite schema v3。迁移在单个事务中执行；失败会 rollback，未来高于 v3 的 schema 会 fail-closed 且不修改数据库。已是 v3 的数据库重复打开不会执行回填或索引重建。

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
