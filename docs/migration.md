# 数据库迁移说明

## 当前 Schema v7

ArchiveLens 当前使用 SQLite schema v7。迁移在单个事务中执行；失败会
rollback，未来高于 v7 的 schema 会 fail-closed 且不修改数据库。已是 v7 的
数据库重复打开不会执行回填或索引重建。

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
