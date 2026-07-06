# OCR Report Loading Feedback Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 为当前离线 HTML 校对工作台补充混合式 loading 反馈，包括结果切换轻 loading、首次打开与筛选刷新骨架屏、导出按钮工作中状态。

**Architecture:** 保持现有单文件 HTML 结构不变，只在 `report_pipeline.py` 的 `_build_html()` 内增加 CSS、状态变量和前端渲染控制。测试继续集中在 `tests/test_report_pipeline_html.py`，通过 HTML 文本断言校验 loading 容器、骨架类名、状态函数和导出按钮工作中文案。

**Tech Stack:** Python 3.11, 内嵌 HTML/CSS/JavaScript, unittest

---

## File Structure

**Modify:**
- `F:\OCR\.tmp\work\report_pipeline.py`
- `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

**Reference only:**
- `F:\OCR\docs\superpowers\specs\2026-07-06-ocr-report-user-workbench-design.md`

**Validation:**
- `python -m py_compile report_pipeline.py`
- `python -m unittest discover -s tests -v`

**Repository note:**
- 当前 `F:\OCR` 不是 git 仓库，因此本计划不包含 commit / merge 步骤，只包含文件级验证与结果汇报。

### Task 1: 为 loading 反馈补测试基线

**Files:**
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`

- [ ] **Step 1: 先写失败测试，锁定 loading 结构和状态函数**

```python
def test_build_html_includes_loading_feedback_hooks(self) -> None:
    with tempfile.TemporaryDirectory() as tmp:
        root = Path(tmp) / "root"
        root.mkdir()
        workspace = Path(tmp) / "workspace"
        workspace.mkdir()
        output_html = root / "报告.html"
        pipeline = ReportPipeline(root_dir=root, output_html=output_html, workspace_dir=workspace)
        try:
            report = make_sample_report(output_html)
            prepare_report_for_output(report, workspace)
            html = pipeline._build_html(report)
        finally:
            pipeline.close()

        self.assertIn("function setDetailLoading(", html)
        self.assertIn("function renderResultsSkeleton()", html)
        self.assertIn("function renderDetailSkeleton()", html)
        self.assertIn('data-export-label="导出校对记录"', html)
        self.assertIn("正在导出", html)
```

- [ ] **Step 2: 运行 HTML 专项测试并确认当前失败**

Run: `python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v`

Expected: FAIL，缺少 loading 结构与函数

- [ ] **Step 3: 检查本任务变更范围**

Run: `rg -n "loading|skeleton|导出校对记录" F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 只命中新加的测试断言

### Task 2: 接入首次打开与筛选刷新的骨架屏

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 在 `_build_html()` 的样式区增加骨架屏样式**

```css
.skeleton-block {
  position: relative;
  overflow: hidden;
  border-radius: 14px;
  background: linear-gradient(90deg, #f6ecd8 0%, #fff7eb 50%, #f6ecd8 100%);
  background-size: 200% 100%;
  animation: skeletonShift 1.2s ease-in-out infinite;
}
.skeleton-card { min-height: 96px; }
.skeleton-detail { min-height: 180px; }
@keyframes skeletonShift {
  0% { background-position: 200% 0; }
  100% { background-position: -200% 0; }
}
```

- [ ] **Step 2: 添加骨架渲染函数**

```javascript
function renderResultsSkeleton(count = 5) {
  const host = document.getElementById("results-list");
  host.innerHTML = Array.from({ length: count }, () => `
    <div class="result-card skeleton-card skeleton-block"></div>
  `).join("");
}

function renderDetailSkeleton() {
  ["detail-summary", "detail-page", "detail-crop", "detail-context", "detail-actions"].forEach(id => {
    document.getElementById(id).innerHTML = '<div class="skeleton-detail skeleton-block"></div>';
  });
}
```

- [ ] **Step 3: 在首次初始化和恢复本地状态前先显示骨架**

```javascript
function startInitialLoading() {
  renderResultsSkeleton();
  renderDetailSkeleton();
}
```

- [ ] **Step 4: 在筛选刷新入口加骨架渲染**

```javascript
function applyFilters() {
  renderResultsSkeleton();
  setDetailLoading(true);
  window.requestAnimationFrame(() => {
    // 原有筛选与排序逻辑
    ...
    renderResultsList();
    ...
    setDetailLoading(false);
  });
}
```

- [ ] **Step 5: 运行 HTML 专项测试，确认骨架函数与关键字存在**

Run: `python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v`

Expected: 新增 loading 测试至少推进到下一类失败，且不再报缺少 skeleton 相关函数

### Task 3: 为结果切换和详情区添加轻 loading

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 在详情区外层增加可切换的 loading 遮罩容器**

```html
<main class="detail-pane">
  <div id="detail-loading" class="detail-loading" hidden>
    <div class="spinner"></div>
    <span>正在切换内容…</span>
  </div>
  ...
</main>
```

- [ ] **Step 2: 增加详情轻 loading 的样式和控制函数**

```css
.detail-pane { position: relative; }
.detail-loading {
  position: absolute;
  inset: 0;
  display: grid;
  place-items: center;
  gap: 10px;
  background: rgba(255, 250, 240, 0.68);
  backdrop-filter: blur(2px);
  z-index: 2;
}
.spinner {
  width: 28px;
  height: 28px;
  border-radius: 50%;
  border: 3px solid rgba(159, 63, 16, 0.2);
  border-top-color: #9f3f10;
  animation: spin 0.8s linear infinite;
}
@keyframes spin {
  to { transform: rotate(360deg); }
}
```

```javascript
function setDetailLoading(isLoading, message = "正在切换内容…") {
  const node = document.getElementById("detail-loading");
  node.hidden = !isLoading;
  node.querySelector("span").textContent = message;
}
```

- [ ] **Step 3: 在结果切换时短暂开启右侧 loading**

```javascript
function selectOccurrence(occurrenceId) {
  currentOccurrenceId = occurrenceId;
  renderResultsList();
  setDetailLoading(true);
  window.requestAnimationFrame(() => {
    renderDetailPane(occurrenceMap[occurrenceId]);
    setDetailLoading(false);
    saveReviewState();
  });
}
```

- [ ] **Step 4: 运行 HTML 专项测试，确认轻 loading 钩子存在**

Run: `python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v`

Expected: PASS 或只剩导出状态相关失败

### Task 4: 为导出按钮增加工作中状态

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 给导出按钮加默认标签属性**

```html
<button
  id="export-review"
  class="primary-button"
  data-export-label="导出校对记录"
  data-export-loading-label="正在导出"
>导出校对记录</button>
```

- [ ] **Step 2: 在导出时切换按钮状态，防止重复点击**

```javascript
function setExportLoading(isLoading) {
  const button = document.getElementById("export-review");
  button.disabled = isLoading;
  button.textContent = isLoading
    ? button.dataset.exportLoadingLabel
    : button.dataset.exportLabel;
}

function exportReviewData() {
  setExportLoading(true);
  try {
    ...
  } finally {
    window.setTimeout(() => setExportLoading(false), 250);
  }
}
```

- [ ] **Step 3: 运行 HTML 专项测试，确认导出按钮 loading 文案存在**

Run: `python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v`

Expected: PASS

### Task 5: 完成全量验证并重生成阶段版 HTML

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: 运行语法校验**

Run: `python -m py_compile report_pipeline.py progress_dashboard.py`

Expected: PASS

- [ ] **Step 2: 运行完整测试**

Run: `python -m unittest discover -s tests -v`

Expected: PASS

- [ ] **Step 3: 重新生成 DJVU 阶段版报告**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File 'F:\OCR\.tmp\work\merge_djvu_only.ps1'`

Expected: PASS，并输出最新统计 JSON

- [ ] **Step 4: 校验生成文件包含 loading 关键入口**

Run: `rg -n "detail-loading|renderResultsSkeleton|正在导出|正在切换内容|skeleton-block" F:\OCR\约字检索报告-DJVU阶段版.html`

Expected: 命中新加的 loading 结构和文案

- [ ] **Step 5: 记录变更范围**

Run: `rg -n "detail-loading|renderResultsSkeleton|renderDetailSkeleton|setDetailLoading|setExportLoading|正在导出" F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

Expected: 只命中这轮 loading 相关改动

---

## Self-Review

- Spec coverage: 已覆盖结果切换轻 loading、首次打开骨架屏、筛选刷新骨架屏、导出按钮工作中状态。
- Placeholder scan: 计划中未保留占位语句，也没有依赖“参照前文”才能执行的步骤。
- Type consistency: 新增状态命名统一围绕 `renderResultsSkeleton`、`renderDetailSkeleton`、`setDetailLoading`、`setExportLoading`，避免后续漂移。

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-07-07-ocr-report-loading-feedback-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

Which approach?

