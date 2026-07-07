# OCR Report B2 Zoom Workbench Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Rework the offline OCR report into the approved B2 equal-height review workbench with compact result cards, an evidence-first right pane, linked zoomable page/crop viewers, and an immersive preview layer.

**Architecture:** Keep the report as a single offline HTML generated from `report_pipeline.py`, but refactor the emitted CSS/HTML/JS into three clear layers: equal-height workspace layout, evidence viewer state and interactions, and compact information/action panels. Drive everything from the existing embedded `window.REPORT_DATA` object so no report JSON schema changes or network dependencies are introduced.

**Tech Stack:** Python 3 report generator, embedded HTML/CSS/vanilla JavaScript, `unittest`, Playwright-based browser verification, Git.

---

## File Structure

### Existing files to modify

- `F:\OCR\.tmp\work\report_pipeline.py`
  - Owns the generated single-file HTML, including CSS, HTML structure, and client-side JavaScript.
  - This is the main implementation surface for the B2 workbench.
- `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`
  - Owns HTML generation regression tests.
  - Add assertions for equal-height layout, compact B2 structure, zoom controls, linked viewer state, and immersive preview markup/hooks.

### Existing files to inspect while implementing

- `F:\OCR\docs\superpowers\specs\2026-07-07-ocr-report-b2-zoom-workbench-design.md`
  - Source of truth for layout/interaction requirements.
- `F:\OCR\.tmp\work\mockups\report-equal-height-zoom-compare.html`
  - Visual reference for early B variants.
- `F:\OCR\.tmp\work\mockups\report-b-compact-compare.html`
  - Visual reference for the approved compact B2 direction.

### Generated outputs to verify after implementation

- `F:\OCR\约字检索报告.html`
- `F:\OCR\.tmp\full_run_v4\run\report.json`

---

### Task 1: Lock the HTML contract with failing tests

**Files:**
- Modify: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`
- Inspect: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Write the failing test for equal-height B2 workspace markup**

```python
    def test_build_html_renders_equal_height_b2_workspace_structure(self) -> None:
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

        self.assertIn("workspace-shell", html)
        self.assertIn("results-pane", html)
        self.assertIn("detail-pane detail-pane-b2", html)
        self.assertIn("viewer-grid viewer-grid-b2", html)
        self.assertIn("detail-strip", html)
        self.assertIn("detail-bottom-bar", html)
```

- [ ] **Step 2: Run test to verify it fails**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- FAIL in `test_build_html_renders_equal_height_b2_workspace_structure`
- Missing strings such as `workspace-shell` and `detail-pane-b2`

- [ ] **Step 3: Write the failing test for compact result cards and compact info hierarchy**

```python
    def test_build_html_renders_compact_result_cards_and_source_detail_toggle(self) -> None:
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

        self.assertIn("result-meta-row", html)
        self.assertIn("result-context-line", html)
        self.assertIn("查看来源详情", html)
        self.assertIn("toggle-note-editor", html)
```

- [ ] **Step 4: Run test to verify it fails**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- FAIL in `test_build_html_renders_compact_result_cards_and_source_detail_toggle`
- Missing strings such as `result-meta-row` and `toggle-note-editor`

- [ ] **Step 5: Write the failing test for zoom controls, linked viewers, and immersive preview**

```python
    def test_build_html_renders_zoom_and_preview_hooks(self) -> None:
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

        self.assertIn("viewer-state", html)
        self.assertIn("function zoomViewer(", html)
        self.assertIn("function resetViewer(", html)
        self.assertIn("function recenterHit(", html)
        self.assertIn("function openImmersivePreview(", html)
        self.assertIn("function syncViewersFromPrimary(", html)
```

- [ ] **Step 6: Run test to verify it fails**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- FAIL in `test_build_html_renders_zoom_and_preview_hooks`
- Missing strings such as `viewer-state` and `openImmersivePreview`

- [ ] **Step 7: Commit**

```powershell
git add .tmp/work/tests/test_report_pipeline_html.py
git commit -m "test: lock B2 workbench HTML contract"
```

---

### Task 2: Implement the equal-height B2 layout skeleton

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Replace the current workspace shell CSS with an equal-height container**

```python
                .workspace-shell {
                  display: grid;
                  grid-template-rows: auto 1fr;
                  gap: 16px;
                  min-height: calc(100vh - 220px);
                }
                .workspace {
                  display: grid;
                  grid-template-columns: minmax(300px, 0.86fr) minmax(0, 1.14fr);
                  gap: 14px;
                  min-height: 0;
                }
                .results-pane,
                .detail-pane {
                  min-height: 0;
                  height: 100%;
                }
                .results-list,
                .detail-scroll {
                  min-height: 0;
                  overflow: auto;
                }
```

- [ ] **Step 2: Run targeted tests to verify layout task is still failing on missing markup**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- The equal-height test may still FAIL because HTML structure has not been updated yet

- [ ] **Step 3: Rewrite the workspace HTML structure to emit the B2 shell**

```python
                <div class="workspace-shell">
                  <section class="workspace">
                    <aside class="results-pane">
                      ...
                      <div id="results-list" class="results-list"></div>
                    </aside>
                    <main class="detail-pane detail-pane-b2">
                      <div id="detail-scroll" class="detail-scroll">
                        <section id="detail-strip" class="detail-strip"></section>
                        <section class="viewer-grid viewer-grid-b2">
                          <section id="detail-page" class="viewer viewer-page"></section>
                          <section id="detail-crop" class="viewer viewer-crop"></section>
                        </section>
                        <section id="detail-bottom-bar" class="detail-bottom-bar"></section>
                        <details id="detail-more">
                          <summary>查看来源详情</summary>
                          <div id="detail-more-body" class="more-grid"></div>
                        </details>
                      </div>
                    </main>
                  </section>
                </div>
```

- [ ] **Step 4: Run targeted tests to verify equal-height structure now passes**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- `test_build_html_renders_equal_height_b2_workspace_structure`: PASS
- Other new tests still FAIL

- [ ] **Step 5: Commit**

```powershell
git add .tmp/work/report_pipeline.py
git commit -m "feat: add equal-height B2 workbench shell"
```

---

### Task 3: Compact the left result list and right-side information hierarchy

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Update result card CSS to increase list density**

```python
                .result-card {
                  padding: 10px 11px;
                  border-radius: 14px;
                }
                .result-card h3 {
                  margin: 0 0 6px;
                  font-size: 14px;
                  line-height: 1.45;
                }
                .result-meta-row,
                .result-context-line {
                  font-size: 12px;
                  color: var(--muted);
                  line-height: 1.48;
                }
                .result-chip {
                  padding: 3px 7px;
                  font-size: 11px;
                }
```

- [ ] **Step 2: Rewrite `renderResultsList()` to emit the compact card structure**

```javascript
                function renderResultsList() {
                  const host = document.getElementById("results-list");
                  if (!filtered.length) {
                    host.innerHTML = '<div class="empty-state">当前筛选下没有结果。</div>';
                    return;
                  }
                  host.innerHTML = filtered.map(item => `
                    <article class="result-card ${item.occurrence_id === currentOccurrenceId ? "active" : ""}" data-select="${item.occurrence_id}">
                      <div class="chip-row result-meta-row">
                        <span class="result-chip status-${getDecision(item)}">${escapeHtml(getDecisionLabel(item))}</span>
                        <span class="result-chip">第 ${item.page_occurrence_index} 处</span>
                      </div>
                      <h3>${escapeHtml(item.file_name)} · 第 ${item.page_number} 页</h3>
                      <p class="result-context-line">${escapeHtml(item.context_preview || item.context_full || "")}</p>
                    </article>
                  `).join("");
                }
```

- [ ] **Step 3: Move title/status/context into a compact right-side strip**

```javascript
                function renderDetailStrip(item) {
                  document.getElementById("detail-strip").innerHTML = `
                    <div class="detail-strip-main">
                      <div>
                        <h2>${escapeHtml(item.result_title)}</h2>
                        <p>${escapeHtml(item.context_preview || item.context_full || "")}</p>
                      </div>
                      <div class="chip-row">
                        <span class="result-chip status-${getDecision(item)}">${escapeHtml(getDecisionLabel(item))}</span>
                        <span class="result-chip">${escapeHtml(item.location_method || "未提供")}</span>
                        <span class="result-chip">${escapeHtml(item.ocr_confidence ?? "未提供")}</span>
                      </div>
                    </div>
                  `;
                }
```

- [ ] **Step 4: Move note editing behind an explicit toggle**

```javascript
                function renderNotePanel(item) {
                  const note = getNote(item);
                  return `
                    <div class="note-panel">
                      <button class="action-button" id="toggle-note-editor">添加备注</button>
                      <div id="note-editor" hidden>
                        <label for="note-input">备注</label>
                        <textarea id="note-input" placeholder="写下判断依据或线索。">${escapeHtml(note)}</textarea>
                      </div>
                    </div>
                  `;
                }
```

- [ ] **Step 5: Run targeted tests to verify compact structure**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- Compact result card test: PASS
- Zoom/preview test: still FAIL

- [ ] **Step 6: Commit**

```powershell
git add .tmp/work/report_pipeline.py
git commit -m "feat: compact result list and B2 info hierarchy"
```

---

### Task 4: Build the page viewer, crop viewer, and linked viewer state

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Add persistent viewer state containers**

```javascript
                let viewerState = {
                  page: { scale: 1, offsetX: 0, offsetY: 0 },
                  crop: { scale: 1, offsetX: 0, offsetY: 0 },
                  target: null,
                };
```

- [ ] **Step 2: Add reusable viewer helpers**

```javascript
                function zoomViewer(kind, delta) {
                  const current = viewerState[kind];
                  current.scale = Math.max(0.6, Math.min(4, Number((current.scale + delta).toFixed(2))));
                  renderActiveDetail();
                }

                function resetViewer(kind) {
                  viewerState[kind] = { scale: 1, offsetX: 0, offsetY: 0 };
                  renderActiveDetail();
                }

                function recenterHit() {
                  viewerState.page.offsetX = 0;
                  viewerState.page.offsetY = 0;
                  viewerState.crop.offsetX = 0;
                  viewerState.crop.offsetY = 0;
                  renderActiveDetail();
                }

                function syncViewersFromPrimary(item) {
                  viewerState.target = item.occurrence_id;
                  viewerState.crop.offsetX = viewerState.page.offsetX;
                  viewerState.crop.offsetY = viewerState.page.offsetY;
                }
```

- [ ] **Step 3: Rewrite `renderDetailPage()` as the primary B2 evidence view**

```javascript
                function renderDetailPage(item) {
                  const page = pageMap[item.page_image_id];
                  const assetUrl = page ? loadAsset(page.image_asset_key) : "";
                  document.getElementById("detail-page").innerHTML = `
                    <div class="viewer-head">
                      <span>出处页</span>
                      <div class="toolbar">
                        <button class="tool" data-zoom="page:-0.2">-</button>
                        <span class="tool">${Math.round(viewerState.page.scale * 100)}%</span>
                        <button class="tool" data-zoom="page:0.2">+</button>
                        <button class="tool" data-reset="page">适应视图</button>
                      </div>
                    </div>
                    <div class="stage page-stage" data-preview="page">
                      ${assetUrl ? `
                        <div class="sheet" style="transform: translate(${viewerState.page.offsetX}px, ${viewerState.page.offsetY}px) scale(${viewerState.page.scale});">
                          <img src="${assetUrl}" alt="出处页">
                          <div class="hit-box" style="left:${item.normalized_x0 * 100}%;top:${item.normalized_y0 * 100}%;width:${(item.normalized_x1 - item.normalized_x0) * 100}%;height:${(item.normalized_y1 - item.normalized_y0) * 100}%;"></div>
                        </div>
                      ` : '<div class="empty-image">这条记录没有可显示的出处页图片。</div>'}
                    </div>
                    <div class="viewer-foot"><span>滚轮缩放 / 拖拽平移 / 双击复位</span></div>
                  `;
                }
```

- [ ] **Step 4: Rewrite `renderDetailCrop()` as the supporting magnifier view**

```javascript
                function renderDetailCrop(item) {
                  const assetUrl = loadAsset(item.crop_asset_key);
                  document.getElementById("detail-crop").innerHTML = `
                    <div class="viewer-head">
                      <span>截取小图</span>
                      <div class="toolbar">
                        <button class="tool" data-zoom="crop:-0.2">-</button>
                        <span class="tool">${Math.round(viewerState.crop.scale * 100)}%</span>
                        <button class="tool" data-zoom="crop:0.2">+</button>
                        <button class="tool" data-reset="crop">适应视图</button>
                      </div>
                    </div>
                    <div class="stage crop-stage" data-preview="crop">
                      ${assetUrl ? `
                        <div class="sheet" style="transform: translate(${viewerState.crop.offsetX}px, ${viewerState.crop.offsetY}px) scale(${viewerState.crop.scale});">
                          <img src="${assetUrl}" alt="截取小图">
                        </div>
                      ` : '<div class="empty-image">这条记录没有可显示的截取小图。</div>'}
                    </div>
                    <div class="viewer-foot"><span>字形放大镜，围绕同一命中目标显示</span></div>
                  `;
                }
```

- [ ] **Step 5: Add default-view reset on result switch**

```javascript
                function resetViewerStateForOccurrence(item) {
                  viewerState = {
                    page: { scale: 1.25, offsetX: 0, offsetY: 0 },
                    crop: { scale: 2.4, offsetX: 0, offsetY: 0 },
                    target: item?.occurrence_id || null,
                  };
                }

                function selectOccurrence(occurrenceId) {
                  currentOccurrenceId = occurrenceId;
                  const item = occurrenceMap[occurrenceId];
                  resetViewerStateForOccurrence(item);
                  renderResultsList();
                  renderActiveDetail();
                  saveReviewState();
                }
```

- [ ] **Step 6: Run targeted tests to verify zoom hooks now pass**

Run:

```powershell
python -m unittest discover -s tests -p 'test_report_pipeline_html.py' -v
```

Expected:

- Zoom/preview hook test: partially PASS
- If immersive preview strings are still missing, only those assertions should fail

- [ ] **Step 7: Commit**

```powershell
git add .tmp/work/report_pipeline.py
git commit -m "feat: add B2 linked page and crop viewers"
```

---

### Task 5: Add immersive preview, drag/zoom listeners, and compact bottom actions

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Add immersive preview HTML shell**

```python
                    <div id="immersive-preview" class="immersive-preview" hidden>
                      <div class="immersive-bar">
                        <span id="immersive-title">预览</span>
                        <div class="toolbar">
                          <button class="tool" data-immersive-zoom="-0.2">-</button>
                          <span id="immersive-scale">100%</span>
                          <button class="tool" data-immersive-zoom="0.2">+</button>
                          <button class="tool" id="immersive-reset">复位</button>
                          <button class="tool" id="immersive-close">关闭</button>
                        </div>
                      </div>
                      <div id="immersive-stage" class="immersive-stage"></div>
                    </div>
```

- [ ] **Step 2: Add immersive preview functions**

```javascript
                let immersiveState = { kind: null, scale: 1, offsetX: 0, offsetY: 0 };

                function openImmersivePreview(kind) {
                  immersiveState = { kind, scale: kind === "crop" ? viewerState.crop.scale : viewerState.page.scale, offsetX: 0, offsetY: 0 };
                  document.getElementById("immersive-preview").hidden = false;
                  renderImmersivePreview();
                }

                function closeImmersivePreview() {
                  document.getElementById("immersive-preview").hidden = true;
                }
```

- [ ] **Step 3: Add render/refresh orchestration helpers**

```javascript
                function renderDetailBottomBar(item) {
                  document.getElementById("detail-bottom-bar").innerHTML = `
                    <div class="meta-row">
                      <span class="meta-chip">上下文：${escapeHtml(item.context_preview || item.context_full || "")}</span>
                      <span class="meta-chip">页码：第 ${item.page_number} 页</span>
                      <span class="meta-chip">来源方式：${escapeHtml(item.location_method || "未提供")}</span>
                    </div>
                    <div class="decision-row">
                      <button class="primary-button" data-decision="confirmed">已确认</button>
                      <button class="action-button" data-decision="needs_review">待判断</button>
                      <button class="action-button" data-decision="rejected">排除</button>
                      <button class="action-button" data-nav="prev">上一条</button>
                      <button class="action-button" data-nav="next">下一条</button>
                      <button class="primary-button" data-nav="pending">下一条待处理</button>
                      <button class="action-button" id="recenter-hit">重新居中</button>
                    </div>
                    ${renderNotePanel(item)}
                  `;
                }

                function renderActiveDetail() {
                  const item = occurrenceMap[currentOccurrenceId];
                  if (!item) {
                    renderEmptyDetail();
                    return;
                  }
                  syncViewersFromPrimary(item);
                  renderDetailStrip(item);
                  renderDetailPage(item);
                  renderDetailCrop(item);
                  renderDetailBottomBar(item);
                  renderMoreInfoPanel(item);
                }
```

- [ ] **Step 4: Wire zoom, preview, drag, reset, recenter, note-toggle, and keyboard listeners**

```javascript
                document.addEventListener("click", event => {
                  const zoom = getClosestActionValue(event, "data-zoom");
                  if (zoom) {
                    const [kind, delta] = zoom.split(":");
                    zoomViewer(kind, Number(delta));
                    return;
                  }
                  if (event.target.id === "recenter-hit") {
                    recenterHit();
                    return;
                  }
                  if (event.target.id === "toggle-note-editor") {
                    const editor = document.getElementById("note-editor");
                    if (editor) editor.hidden = !editor.hidden;
                    return;
                  }
                  const preview = getClosestActionValue(event, "data-preview");
                  if (preview) {
                    openImmersivePreview(preview);
                    return;
                  }
                });

                document.addEventListener("keydown", event => {
                  if (event.key === "Escape") closeImmersivePreview();
                });
```

- [ ] **Step 5: Run full verification**

Run:

```powershell
python -m py_compile report_pipeline.py progress_dashboard.py
python -m unittest discover -s tests -v
python report_pipeline.py --merge-only --root-dir F:\OCR --workspace-dir F:\OCR\.tmp\full_run_v4 --output-html F:\OCR\约字检索报告.html --output-json F:\OCR\.tmp\full_run_v4\run\report.json
```

Expected:

- `py_compile`: no output
- `unittest`: all tests PASS
- merge command prints JSON summary with `success_file_count: 6`

- [ ] **Step 6: Run browser verification against the rebuilt report**

Run:

```powershell
@'
from pathlib import Path
print(Path(r"F:\OCR\约字检索报告.html").exists())
'@ | python -
```

Then manually verify in browser:

- Left and right panels stay equal-height
- Result switch resets both viewers to the new default framing
- Page viewer zoom/pan works
- Crop viewer zoom/pan works
- Immersive preview opens and closes with `Esc`
- `重新居中` returns to the hit area

- [ ] **Step 7: Commit**

```powershell
git add .tmp/work/report_pipeline.py .tmp/work/tests/test_report_pipeline_html.py
git commit -m "feat: implement B2 linked zoom review workbench"
```

---

### Task 6: Publish the updated report artifacts and sync repository state

**Files:**
- Modify: `F:\OCR\约字检索报告.html`
- Modify: `F:\OCR\.tmp\full_run_v4\run\report.json`
- Inspect: `F:\OCR\.gitignore`

- [ ] **Step 1: Confirm the generated report omits loading UI and contains the new B2 hooks**

Run:

```powershell
rg -n "workspace-shell|detail-pane-b2|openImmersivePreview|syncViewersFromPrimary|查看来源详情|重新居中" F:\OCR\约字检索报告.html
```

Expected:

- At least one hit for each of the six strings above

- [ ] **Step 2: Confirm ignored large artifacts remain untracked**

Run:

```powershell
git status --short
```

Expected:

- No raw `*.pdf`, `*.djvu`, final large HTML backups, or `.tmp/full_run_v4/` worker artifacts staged

- [ ] **Step 3: Commit generated report changes if the repository policy for this workspace tracks them**

```powershell
git add .tmp/work/report_pipeline.py .tmp/work/tests/test_report_pipeline_html.py
git commit -m "chore: finalize B2 report workbench rollout"
```

Expected:

- If no extra changes remain after Task 5, skip this commit

---

## Self-Review

### 1. Spec coverage

- Equal-height workspace: covered in Task 2
- Compact left list and compact right-side info hierarchy: covered in Task 3
- B2 evidence-first right pane: covered in Tasks 2, 3, and 4
- Zoom/pan/reset behavior: covered in Tasks 4 and 5
- Linked viewer behavior with shared target but independent scale: covered in Task 4
- Immersive preview layer: covered in Task 5
- Recenter action and default view reset on result switch: covered in Tasks 4 and 5
- Offline rebuild and regression verification: covered in Tasks 5 and 6

No spec gaps found.

### 2. Placeholder scan

- No `TODO`, `TBD`, or “implement later”
- Every task includes exact file paths, code snippets, and commands
- Every test step includes an expected failure or pass condition

### 3. Type consistency

- Viewer state uses `page`, `crop`, and `target` consistently across Tasks 4 and 5
- `renderActiveDetail()` is referenced after being defined in Task 5
- `openImmersivePreview`, `syncViewersFromPrimary`, `recenterHit`, `zoomViewer`, and `resetViewer` use consistent names across all tasks

Plan complete and saved to `docs/superpowers/plans/2026-07-07-ocr-report-b2-zoom-workbench-implementation.md`. Two execution options:

**1. Subagent-Driven (recommended)** - I dispatch a fresh subagent per task, review between tasks, fast iteration

**2. Inline Execution** - Execute tasks in this session using executing-plans, batch execution with checkpoints

**Which approach?**
