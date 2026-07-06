# OCR Worker_06 High-Accuracy Parallelization Design

**Date:** 2026-07-06  
**Scope:** `F:\OCR\.tmp\work\report_pipeline.py` and related runtime scripts under `F:\OCR\.tmp\work`  
**Status:** Draft approved in conversation, pending user review of this written spec

## Goal

在不牺牲现有识别精度的前提下：

1. 当 `worker_01` 到 `worker_05`（5 个 DJVU worker）完成后，先输出一份只包含这 5 个 DJVU 文件结果的单文件离线 HTML 阶段报告，放到 `F:\OCR`。
2. 随后暂停当前 `worker_06`，把剩余 PDF 页按页码切分为多个分片 worker 并行执行。
3. 所有 PDF 分片继续使用与当前 `worker_06` 相同的高精度识别链路，不通过降低 `DPI`、放宽判定阈值、跳过复核或快速预筛来换取速度。
4. PDF 分片全部完成后，再生成包含 DJVU + PDF 的最终单文件离线 HTML 报告。

## Non-Goals

- 不从头重扫已完成的 DJVU 文件。
- 不清空或删除现有 `worker_06` 的 checkpoint。
- 不修改 `RapidOCR` 模型、`Tesseract` 语言包、`verification_status` 判定规则。
- 不通过降低 `DEFAULT_RENDER_DPI=144` 来提速。
- 不改变最终报告的离线单文件 HTML 形态。

## Current Constraints

### Existing runtime behavior

- 当前每个 worker 在自己的 `worker_xx\run\checkpoint-*.json` 里保存断点。
- `merge_existing_reports()` 会无差别合并 `workspace_dir` 下所有 `worker_*/run/report.json`。
- 当前逻辑默认一个 worker 对应一份完整文档报告，不支持“同一 PDF 多分片报告”直接合并。
- 当前 `worker_06` 处理的是一份 1858 页 PDF，且没有可直接利用的文本层，因此主要耗时来自整页渲染和整页 OCR。

### User-approved accuracy policy

用户已明确接受：

- 可以在 5 个 DJVU worker 完成后暂停并重启 `worker_06`。
- 精确度优先于吞吐。
- 分片并行必须保持相同识别标准，而不是通过降低处理质量换速度。

## Recommended Approach

采用“两阶段交付 + 高精度 PDF 分片并行”方案。

### Phase 1: DJVU-only intermediate delivery

触发条件：

- `worker_01` 到 `worker_05` 已全部生成 `run/report.json`
- `worker_06` 尚未纳入最终合并

产出：

- 阶段性 HTML：`F:\OCR\约字检索报告-DJVU阶段版.html`
- 阶段性 JSON：`F:\OCR\.tmp\full_run_v4\run\report-djvu-only.json`

内容边界：

- 仅包含 `worker_01` 到 `worker_05` 的结果
- 不包含 `worker_06` 当前或后续 PDF 结果
- 不覆盖 `F:\OCR\约字检索报告.html`

### Phase 2: High-accuracy PDF shard execution

步骤：

1. 读取当前 `worker_06` 最新 checkpoint，获得 `next_page_index`。
2. 停止当前 `worker_06` 进程，但保留其 checkpoint、日志和已有中间结果。
3. 将剩余 PDF 页按连续页码划分为 2 到 4 个分片。
4. 为每个分片创建独立 worker 目录，例如：
   - `worker_06a`
   - `worker_06b`
   - `worker_06c`
   - `worker_06d`
5. 每个分片 worker 使用独立 `workspace-dir`、独立 checkpoint、独立 `report.json`。
6. 所有分片保持与原 `worker_06` 相同的识别链路：
   - `PDF 144 DPI`
   - `RapidOCR`
   - 单字 crop
   - `Tesseract --psm 10`
   - 原有 `classify_verification_status()` 判定规则
7. 所有 PDF 分片完成后，再执行最终合并。

## Functional Design

### 1. Intermediate merge for selected workers

当前 `discover_worker_report_paths()` 会返回所有 `worker_*` 的 `report.json`。这不满足“先只合并 5 个 DJVU worker”的需求。

需要新增受控合并入口，推荐支持以下能力：

- `--merge-workers worker_01 worker_02 worker_03 worker_04 worker_05`

行为：

- 只读取指定 worker 目录下的 `run/report.json`
- 保持现有 HTML/JSON 输出逻辑
- 输出到调用方指定的 `--output-html`
- JSON 路径允许调用方单独指定

推荐实现：

- 将 `discover_worker_report_paths()` 扩展为支持可选 worker 白名单
- 将 `merge_existing_reports()` 扩展为接收白名单参数
- 新增可选 CLI 参数：
  - `--merge-workers`
  - `--output-json`（避免阶段版 JSON 与默认 `run/report.json` 冲突）

### 2. PDF shard page-range support

当前 `_process_document()` 的页范围来自：

- checkpoint 的 `next_page_index`
- 全局 `page_limit`

为支持同一 PDF 多分片并行，需要新增显式页范围参数：

- `--start-page-index`
- `--end-page-index-exclusive`

行为要求：

- 实际处理区间为：
  - `start = max(checkpoint_next_page_index, cli_start_page_index)`
  - `end = min(document_page_count, cli_end_page_index_exclusive, page_limit_boundary_if_any)`
- 这样既能复用原断点，也能限制每个分片只处理自己的页段。

### 3. Worker_06 shard layout

分片 worker 目录不覆盖原 `worker_06`：

- 保留原目录：`F:\OCR\.tmp\full_run_v4\worker_06`
- 新增目录：
  - `F:\OCR\.tmp\full_run_v4\worker_06a`
  - `F:\OCR\.tmp\full_run_v4\worker_06b`
  - `F:\OCR\.tmp\full_run_v4\worker_06c`
  - 可选 `worker_06d`

这样做的原因：

- 原 `worker_06` 可作为回滚基线
- 新分片彼此不共享 checkpoint，避免竞争写入
- 新旧运行结果可清楚区分

### 4. Final merge for split PDF reports

最终合并时，不能再简单把所有 worker report 的 `documents` 直接拼接，因为同一 PDF 会出现在多个分片报告中。

最终合并需要按“文档级聚合”处理：

- `documents`
  - 按 `file_path + file_hash_sha256` 聚合为一条文档记录
  - `page_count` 保持原 PDF 总页数
  - `occurrence_count`、`failure_count` 为所有分片累计值
- `pages`
  - 按 `page_image_id` 或 `file_path + page_index` 去重
  - 按 `page_index` 排序
- `occurrences`
  - 聚合后再跑一次现有 `dedupe_occurrences()` 和 `assign_occurrence_indexes()`
- `failures`
  - 全量保留
- `stats`
  - 重新从聚合后的结果计算

推荐实现：

- 为 `_merge_worker_reports()` 增加“是否按文档聚合”的模式
- 对存在重复 `file_path` 的报告，走文档级聚合逻辑

## Accuracy Preservation Rules

以下内容在整个改造中必须保持不变：

- `DEFAULT_RENDER_DPI = 144`
- `RapidOCR()` 调用方式
- `pytesseract.image_to_data(..., config=\"--psm 10\")`
- 简繁体语言包选择逻辑
- 单字 crop 和 padding 逻辑
- `classify_verification_status()` 的阈值与状态输出

允许改动的只有执行编排：

- 合并选择范围
- 页范围控制
- 同一 PDF 的分片并行
- 最终聚合逻辑

## Operational Flow

### DJVU intermediate report flow

1. 监控 `worker_01` 到 `worker_05` 是否都生成 `run/report.json`
2. 一旦满足条件，执行一次指定 worker 合并
3. 输出 `F:\OCR\约字检索报告-DJVU阶段版.html`
4. 不触碰 `worker_06` 当前运行状态，除非接下来明确进入分片阶段

### Worker_06 split flow

1. 读取最新 `worker_06` checkpoint
2. 记录 `next_page_index`
3. 停掉当前 `worker_06`
4. 计算剩余页区间并切分
5. 启动 `worker_06a` ~ `worker_06N`
6. 等待所有分片完成并各自产出 `report.json`
7. 执行最终聚合合并
8. 输出 `F:\OCR\约字检索报告.html`

## Validation Plan

### Required verification before runtime switchover

- `python -m py_compile report_pipeline.py progress_dashboard.py`
- `python -m unittest discover -s tests -v`

### New tests required

至少补以下测试：

1. **指定 worker 合并测试**
   - 输入：`worker_01` ~ `worker_06` 中只有部分 `report.json`
   - 断言：`--merge-workers` 只合并白名单内结果

2. **页范围执行测试**
   - 输入：checkpoint + `start/end` 参数
   - 断言：只处理交集页段，且能正确续跑

3. **同一 PDF 多分片最终聚合测试**
   - 输入：同一 `file_path` 的多个分片 report
   - 断言：
     - 最终只保留一个 document 记录
     - pages/occurrences/failures 正确汇总
     - stats 正确重算

### Runtime verification

在真实切换时需要验证：

- 阶段版 HTML 能直接离线打开
- 阶段版只包含 5 个 DJVU 文件
- 分片 worker 均在各自页段推进
- `worker_06` 原目录未被破坏
- 最终 HTML 包含 DJVU + PDF 全量结果

## Risks

### Primary risks

- 最终合并若仍按“一个 worker = 一个文档”思路实现，会导致同一 PDF 重复计数
- 分片页范围处理不严谨会造成漏页或重复页
- 若误覆盖原 `worker_06` 目录，会损失当前可回退状态

### Mitigations

- 原 `worker_06` 保留不删，作为回滚基线
- 分片独立目录运行
- 最终合并必须基于文档聚合测试通过后再切换
- 阶段版与最终版使用不同输出文件名

## Rollback

如果分片并行方案失败：

1. 保留已生成的 DJVU 阶段版报告
2. 停止所有 `worker_06*` 分片进程
3. 忽略新分片目录
4. 使用原 `worker_06` checkpoint 恢复单 worker 继续跑

回滚时不需要删除原始文档，也不需要删除 `F:\OCR\.tmp\full_run_v4`。

## Implementation Boundary

本设计文档批准后，后续实现应仅限于：

- `F:\OCR\.tmp\work\report_pipeline.py`
- 必要测试文件
- 必要 watcher/运行脚本（若需要新增受控 merge 或 shard 启动脚本）

不应顺手扩展到无关重构、UI 改版或 OCR 判定规则修改。

## Spec Self-Review

- Placeholder scan: 无 `TODO` / `TBD`
- Internal consistency: 阶段版与最终版输出边界明确，不互相覆盖
- Scope check: 聚焦于 DJVU 阶段交付 + `worker_06` 高精度分片并行，未扩展到无关功能
- Ambiguity check: 已明确阶段版文件名、分片目录策略、精度保护规则、回滚方式
