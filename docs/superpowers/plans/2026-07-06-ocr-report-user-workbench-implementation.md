# OCR Report User Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 把当前单文件离线 HTML 报告重构为面向用户的校对工作台，形成“左侧结果清单 + 右侧固定详情 + 同屏校对动作”的主流程，同时支持本地继续和导出校对记录。

**Architecture:** 保持 Python 端继续生成单文件离线 HTML，不引入额外服务。主要在 `report_pipeline.py` 的 `_build_html()` 中重写页面结构和前端脚本，同时扩展 `prepare_report_for_output()` 输出更适合用户界面的派生字段。测试继续集中在 `tests/test_report_pipeline_html.py`，通过 HTML 片段断言和 JSON 输出断言覆盖结构、文案、本地保存与导出入口。

**Tech Stack:** Python 3.11, 内嵌 HTML/CSS/JavaScript, unittest

---

## File Structure

**Modify:**
- `F:\OCR\.tmp\work\report_pipeline.py`
- `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

**Reference only:**
- `F:\OCR\docs\superpowers\specs\2026-07-06-ocr-report-user-workbench-design.md`
- `F:\OCR\.tmp\work\mockups\report-redesign-a-c.html`

**Validation:**
- `python -m py_compile report_pipeline.py`
- `python -m unittest discover -s tests -v`

**Repository note:**
- 当前 `F:\OCR` 不是 git 仓库，`git status` 会失败。因此本计划中的“提交”步骤统一替换为“检查变更范围并记录验证结果”，不要求伪造 commit。

### Task 1: 定义用户视角输出字段

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 先写失败测试，锁定白话字段和工作台所需派生数据**

```python
def test_prepare_report_for_output_adds_user_facing_fields(self) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        report = make_sample_report(output_html)

        prepare_report_for_output(report, workspace)

        occurrence = report["occurrences"][0]
        self.assertEqual(occurrence["user_verification_label"], "待判断")
        self.assertIn("第 1 页", occurrence["result_title"])
        self.assertIn("有出处页", occurrence["evidence_badges"])
        self.assertIn("有截取小图", occurrence["evidence_badges"])
```

- [ ] **Step 2: 运行单测并确认当前失败**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_prepare_report_for_output_adds_user_facing_fields -v`

Expected: FAIL，提示缺少 `user_verification_label`、`result_title` 或 `evidence_badges`

- [ ] **Step 3: 在 `prepare_report_for_output()` 中补齐用户界面所需派生字段**

```python
STATUS_LABELS = {
    "confirmed": "已确认",
    "needs_review": "待判断",
    "rejected": "排除",
}

def build_occurrence_user_fields(occurrence: dict[str, Any], page_map: dict[str, dict[str, Any]]) -> None:
    page = page_map[occurrence["page_image_id"]]
    badges: list[str] = []
    if page.get("image_asset_key"):
        badges.append("有出处页")
    if occurrence.get("crop_asset_key"):
        badges.append("有截取小图")
    occurrence["user_verification_label"] = STATUS_LABELS.get(
        occurrence["verification_status"],
        occurrence["verification_status"],
    )
    occurrence["result_title"] = (
        f'{occurrence["file_name"]} · 第 {occurrence["page_number"]} 页 · '
        f'第 {occurrence["page_occurrence_index"]} 处'
    )
    occurrence["evidence_badges"] = badges
    occurrence["context_preview"] = occurrence["context_full"][:80]
```

- [ ] **Step 4: 让 `prepare_report_for_output()` 对所有命中项调用派生字段构造逻辑**

```python
def prepare_report_for_output(report: dict[str, Any], workspace_dir: Path) -> None:
    report["validation"] = load_browser_validation(workspace_dir)
    page_map = {page["page_image_id"]: page for page in report.get("pages", [])}
    for page in report.get("pages", []):
        page["image_asset_key"] = page.get("image_asset_key", page["page_image_id"])
        page["user_page_label"] = f'第 {page["page_number"]} 页'
        page.pop("image_path", None)
    for occurrence in report.get("occurrences", []):
        occurrence["open_file_url"] = build_file_url(occurrence["file_path"])
        occurrence["crop_asset_key"] = occurrence.get("crop_asset_key", occurrence["crop_image_id"])
        build_occurrence_user_fields(occurrence, page_map)
        occurrence.pop("crop_image_path", None)
```

- [ ] **Step 5: 重新运行目标测试，确认通过**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_prepare_report_for_output_adds_user_facing_fields -v`

Expected: PASS

- [ ] **Step 6: 检查本任务变更范围并记录结果**

Run: `rg -n "STATUS_LABELS|user_verification_label|result_title|evidence_badges|context_preview" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 只命中本任务新增字段和对应测试

### Task 2: 重建 HTML 为“左清单 + 右详情 + 校对动作”结构

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 先写失败测试，锁定新页面结构和白话文案**

```python
def test_build_html_renders_user_workbench_layout(self) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        pipeline = ReportPipeline(root_dir=root, output_html=output_html, workspace_dir=workspace)
        report = make_sample_report(output_html)
        prepare_report_for_output(report, workspace)

        html = pipeline._build_html(report)

        self.assertIn("档案校对工作台", html)
        self.assertIn("结果清单", html)
        self.assertIn("出处页", html)
        self.assertIn("截取小图", html)
        self.assertIn("校对结论", html)
        self.assertNotIn("验证状态", html)
        self.assertNotIn("OCR 引擎", html)
```

- [ ] **Step 2: 运行单测并确认当前失败**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_renders_user_workbench_layout -v`

Expected: FAIL，页面仍是旧表格结构与旧文案

- [ ] **Step 3: 重写 `_build_html()` 的主结构，去掉旧“搜索与筛选 / 检索结果表 / 查看器弹层”布局**

```html
<section class="toolbar">
  <h2>筛选</h2>
  <div class="filters">
    <select id="doc-filter"></select>
    <input id="page-range-start" inputmode="numeric" placeholder="起始页">
    <input id="page-range-end" inputmode="numeric" placeholder="结束页">
    <label class="toggle"><input id="with-images-only" type="checkbox">只看有出处图片</label>
    <label class="toggle"><input id="pending-only" type="checkbox">只看待处理</label>
    <button id="reset">清空筛选</button>
    <button id="export-review">导出校对记录</button>
  </div>
</section>
<section class="workspace">
  <aside class="results-pane">
    <h2>结果清单</h2>
    <div id="results-list"></div>
  </aside>
  <main class="detail-pane">
    <section id="detail-summary"></section>
    <section id="detail-page"></section>
    <section id="detail-crop"></section>
    <section id="detail-context"></section>
    <section id="detail-actions"></section>
    <details id="detail-more"><summary>更多信息</summary><div id="detail-more-body"></div></details>
  </main>
</section>
```

- [ ] **Step 4: 用白话文案替换旧标签和状态展示**

```javascript
const STATUS_LABELS = {
  confirmed: "已确认",
  needs_review: "待判断",
  rejected: "排除",
};

function renderStatusBadge(item) {
  return `<span class="status-badge status-${item.verification_status}">
    ${STATUS_LABELS[item.verification_status] || item.verification_status}
  </span>`;
}
```

- [ ] **Step 5: 保留“更多信息”折叠区，但把技术字段移出主视图**

```javascript
function renderMoreInfo(item) {
  return [
    `完整路径：${item.file_path}`,
    `定位方式：${item.location_method}`,
    `识别把握：${item.ocr_confidence ?? "未提供"}`,
    `原始代码点：${item.unicode_codepoint}`,
  ].join("<br>");
}
```

- [ ] **Step 6: 重新运行目标测试，确认结构与文案达标**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_renders_user_workbench_layout -v`

Expected: PASS

- [ ] **Step 7: 检查本任务变更范围并记录结果**

Run: `rg -n "档案校对工作台|结果清单|出处页|截取小图|校对结论|更多信息" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 命中新的页面结构、文案和测试

### Task 3: 实现左侧结果清单、右侧详情同步和连续处理

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 先写失败测试，锁定新交互脚本入口**

```python
def test_build_html_includes_workbench_interactions(self) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        pipeline = ReportPipeline(root_dir=root, output_html=output_html, workspace_dir=workspace)
        report = make_sample_report(output_html)
        prepare_report_for_output(report, workspace)

        html = pipeline._build_html(report)

        self.assertIn("function renderResultsList()", html)
        self.assertIn("function selectOccurrence(", html)
        self.assertIn("function goToNextPending()", html)
        self.assertIn("上一条", html)
        self.assertIn("下一条", html)
        self.assertIn("下一条待处理", html)
```

- [ ] **Step 2: 运行单测并确认当前失败**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_includes_workbench_interactions -v`

Expected: FAIL，旧脚本仍是表格渲染和弹层查看器

- [ ] **Step 3: 把旧 `renderResults()` 重写为卡片列表渲染，并在点击时同步右侧详情**

```javascript
function renderResultsList() {
  const host = document.getElementById("results-list");
  host.innerHTML = filtered.map(item => `
    <article class="result-card ${item.occurrence_id === currentOccurrenceId ? "active" : ""}"
      data-select="${item.occurrence_id}">
      <h3>${item.result_title}</h3>
      <p class="context-line">${item.context_preview}</p>
      <div class="meta-line">
        ${renderStatusBadge(item)}
        ${item.evidence_badges.map(label => `<span class="evidence-chip">${label}</span>`).join("")}
      </div>
    </article>
  `).join("");
}

function selectOccurrence(occurrenceId) {
  currentOccurrenceId = occurrenceId;
  renderResultsList();
  renderDetailPane(occurrenceMap[occurrenceId]);
}
```

- [ ] **Step 4: 用固定详情渲染替换旧 `openViewer()` / `drawViewer()` 主流程**

```javascript
function renderDetailPane(item) {
  renderDetailSummary(item);
  renderDetailPage(item);
  renderDetailCrop(item);
  renderDetailContext(item);
  renderDetailActions(item);
  renderMoreInfoPanel(item);
}

function goToNextPending() {
  const pending = filtered.filter(item => item.verification_status === "needs_review");
  const idx = pending.findIndex(item => item.occurrence_id === currentOccurrenceId);
  if (idx >= 0 && idx < pending.length - 1) {
    selectOccurrence(pending[idx + 1].occurrence_id);
  }
}
```

- [ ] **Step 5: 保留原页高亮能力，但把动作改成“页内定位 + 单独查看出处页”**

```javascript
function renderDetailPage(item) {
  const page = pageMap[item.page_image_id];
  document.getElementById("detail-page").innerHTML = `
    <div class="detail-block">
      <div class="detail-block-head">
        <h2>出处页</h2>
        <div class="action-row">
          <button id="focus-current-page">在本页定位</button>
          <button id="open-page-alone">单独查看出处页</button>
        </div>
      </div>
      <div id="page-stage"></div>
    </div>
  `;
  drawPageHighlight(item, page);
}
```

- [ ] **Step 6: 重新运行目标测试，确认交互脚本存在**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_includes_workbench_interactions -v`

Expected: PASS

- [ ] **Step 7: 检查本任务变更范围并记录结果**

Run: `rg -n "renderResultsList|selectOccurrence|goToNextPending|renderDetailPane|detail-page" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 命中新的清单、详情和连续处理逻辑

### Task 4: 接入本地继续、校对动作和导出校对记录

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 先写失败测试，锁定本地保存与导出入口**

```python
def test_build_html_includes_local_review_persistence_and_export(self) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        pipeline = ReportPipeline(root_dir=root, output_html=output_html, workspace_dir=workspace)
        report = make_sample_report(output_html)
        prepare_report_for_output(report, workspace)

        html = pipeline._build_html(report)

        self.assertIn("localStorage", html)
        self.assertIn("saveReviewState", html)
        self.assertIn("loadReviewState", html)
        self.assertIn("export-review", html)
        self.assertIn("导出校对记录", html)
```

- [ ] **Step 2: 运行单测并确认当前失败**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_includes_local_review_persistence_and_export -v`

Expected: FAIL，当前 HTML 没有本地状态持久化和导出能力

- [ ] **Step 3: 在脚本中定义本地状态模型，保存筛选、当前条目、结论和备注**

```javascript
const STORAGE_KEY = "ocr-report-review-state-v1";

function saveReviewState() {
  const payload = {
    filters: readFilterState(),
    currentOccurrenceId,
    decisions: reviewState.decisions,
    notes: reviewState.notes,
  };
  localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
}

function loadReviewState() {
  const raw = localStorage.getItem(STORAGE_KEY);
  if (!raw) return;
  const saved = JSON.parse(raw);
  reviewState = {
    decisions: saved.decisions || {},
    notes: saved.notes || {},
  };
  restoreFilterState(saved.filters || {});
  currentOccurrenceId = saved.currentOccurrenceId || filtered[0]?.occurrence_id || null;
}
```

- [ ] **Step 4: 把“已确认 / 待判断 / 排除 / 备注”动作接入本地状态**

```javascript
function applyDecision(status) {
  if (!currentOccurrenceId) return;
  reviewState.decisions[currentOccurrenceId] = status;
  saveReviewState();
  renderResultsList();
  renderDetailPane(occurrenceMap[currentOccurrenceId]);
}

function updateNote(value) {
  if (!currentOccurrenceId) return;
  reviewState.notes[currentOccurrenceId] = value;
  saveReviewState();
}
```

- [ ] **Step 5: 提供“导出校对记录”按钮，导出完整 JSON**

```javascript
function exportReviewData() {
  const records = data.occurrences.map(item => ({
    occurrence_id: item.occurrence_id,
    file_name: item.file_name,
    file_path: item.file_path,
    page_number: item.page_number,
    context_full: item.context_full,
    verification_status: reviewState.decisions[item.occurrence_id] || item.verification_status,
    note: reviewState.notes[item.occurrence_id] || "",
  }));
  const blob = new Blob([JSON.stringify({ exported_at: new Date().toISOString(), records }, null, 2)], {
    type: "application/json",
  });
  downloadBlob(blob, "约字检索报告-校对记录.json");
}
```

- [ ] **Step 6: 重新运行目标测试，确认本地继续和导出入口具备**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_includes_local_review_persistence_and_export -v`

Expected: PASS

- [ ] **Step 7: 检查本任务变更范围并记录结果**

Run: `rg -n "localStorage|saveReviewState|loadReviewState|applyDecision|exportReviewData|约字检索报告-校对记录.json" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 命中本地保存、状态动作和导出逻辑

### Task 5: 清理旧技术视角 UI 并完成回归验证

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 先写失败测试，锁定旧 UI 已被替换**

```python
def test_build_html_removes_old_table_and_viewer_first_flow(self) -> None:
    with TemporaryDirectory() as tmp:
        root = Path(tmp)
        workspace = root / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        pipeline = ReportPipeline(root_dir=root, output_html=output_html, workspace_dir=workspace)
        report = make_sample_report(output_html)
        prepare_report_for_output(report, workspace)

        html = pipeline._build_html(report)

        self.assertNotIn("<table>", html)
        self.assertNotIn("待人工复核", html)
        self.assertNotIn("处理失败文件", html)
        self.assertNotIn("执行报告", html)
        self.assertNotIn("viewer", html)
```

- [ ] **Step 2: 运行单测并确认当前失败**

Run: `python -m unittest tests.test_report_pipeline_html.ReportPipelineHtmlTests.test_build_html_removes_old_table_and_viewer_first_flow -v`

Expected: FAIL，旧表格和旧查看器痕迹仍在

- [ ] **Step 3: 删除旧主表格、旧查看器主流程和面向技术汇报的主区块**

```python
# 从 _build_html() 中删除以下旧区块
# - <section><h2>检索结果</h2><table>...</table></section>
# - <section><h2>待人工复核</h2>...</section>
# - <section><h2>处理失败文件</h2>...</section>
# - <section><h2>执行报告</h2>...</section>
# - <div id="viewer" class="viewer">...</div>
#
# 对应 JS 删除：
# - renderReview()
# - renderFailures()
# - renderExecutionReport()
# - openViewer()
# - drawViewer() 中仅服务弹层的分支
```

- [ ] **Step 4: 在测试里补一个整体验证，确保关键新文案存在、旧文案不存在**

```python
def test_write_report_outputs_renders_user_workbench_html(self) -> None:
    ...
    self.assertIn("档案校对工作台", html)
    self.assertIn("只看待处理", html)
    self.assertIn("导出校对记录", html)
    self.assertIn("更多信息", html)
    self.assertNotIn("验证状态", html)
    self.assertNotIn("OCR 引擎", html)
```

- [ ] **Step 5: 运行完整校验链**

Run: `python -m py_compile report_pipeline.py`

Expected: PASS，无语法错误

Run: `python -m unittest discover -s tests -v`

Expected: PASS，所有现有与新增测试通过

- [ ] **Step 6: 记录最终变更范围和验证结果**

Run: `rg -n "档案校对工作台|只看待处理|导出校对记录|更多信息|localStorage" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 命中新工作台核心入口

Run: `Get-Item F:\OCR\docs\superpowers\specs\2026-07-06-ocr-report-user-workbench-design.md, F:\OCR\docs\superpowers\plans\2026-07-06-ocr-report-user-workbench-implementation.md | Select-Object FullName,Length,LastWriteTime`

Expected: 设计和计划文件都存在

---

## Self-Review

- Spec coverage: 已覆盖页面结构、左侧清单、右侧详情、白话文案、本地继续、导出校对记录、旧技术主区块下线和最终验证。
- Placeholder scan: 计划中未保留占位语句，也没有引用“参考前一任务”这类不自洽步骤。
- Type consistency: 新增状态标签统一围绕 `verification_status`、`user_verification_label`、`reviewState.decisions` 和 `reviewState.notes` 命名，避免后续任务漂移。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-06-ocr-report-user-workbench-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?
