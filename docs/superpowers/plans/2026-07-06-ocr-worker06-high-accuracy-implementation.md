# OCR Worker_06 High-Accuracy Parallelization Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build a DJVU-only intermediate merge path plus high-accuracy PDF shard execution for `worker_06`, without lowering OCR fidelity or destroying the current checkpoint recovery path.

**Architecture:** Extend `report_pipeline.py` in three layers: controlled merge selection, page-range aware execution, and duplicate-document final aggregation. Keep the runtime model stable by preserving the existing OCR pipeline and adding small orchestration scripts that switch from the current single `worker_06` to shard workers only after the five DJVU workers finish.

**Tech Stack:** Python 3.11, `argparse`, `json`, `pathlib`, PowerShell watcher scripts, `unittest`, PyMuPDF, RapidOCR, Tesseract

---

## File Structure

**Modify**
- `F:\OCR\.tmp\work\report_pipeline.py`
  - Add worker-filtered merge selection
  - Add optional JSON output path for merge-only runs
  - Add page-range CLI handling for shard workers
  - Add document-level aggregation for split PDF final merge
- `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`
  - Add merge-selection and duplicate-document aggregation tests
- `F:\OCR\.tmp\work\tests\test_ocr_core.py`
  - Add page-range/checkpoint interaction tests if kept as core behavior tests

**Create**
- `F:\OCR\.tmp\work\merge_djvu_only.ps1`
  - One-shot script to merge `worker_01` to `worker_05` into the DJVU stage report
- `F:\OCR\.tmp\work\start_worker06_shards.ps1`
  - One-shot script to stop the original `worker_06`, compute shard ranges, and launch `worker_06a...`

**Reference**
- `F:\OCR\docs\superpowers\specs\2026-07-06-ocr-worker06-high-accuracy-design.md`

---

### Task 1: Controlled DJVU-Only Merge

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py:1313-1499`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Write the failing merge-selection tests**

```python
class MergeExistingReportsTests(unittest.TestCase):
    def test_discover_worker_report_paths_filters_requested_workers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "full_run_v4"
            for name in ("worker_01", "worker_02", "worker_06"):
                run_dir = workspace / name / "run"
                run_dir.mkdir(parents=True)
                (run_dir / "report.json").write_text(
                    json.dumps({"documents": [], "pages": [], "occurrences": [], "failures": [], "started_at": "2026-07-06T00:00:00", "finished_at": "2026-07-06T00:00:00"}),
                    encoding="utf-8",
                )

            paths = discover_worker_report_paths(workspace, worker_names={"worker_01", "worker_02"})
            self.assertEqual([path.parent.parent.name for path in paths], ["worker_01", "worker_02"])

    def test_merge_existing_reports_writes_custom_json_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "full_run_v4"
            run_dir = workspace / "worker_01" / "run"
            run_dir.mkdir(parents=True)
            (run_dir / "report.json").write_text(
                json.dumps(
                    {
                        "root_dir": str(root),
                        "output_html": str(root / "partial.html"),
                        "started_at": "2026-07-06T00:00:00",
                        "finished_at": "2026-07-06T00:10:00",
                        "documents": [{"document_id": "doc-1", "file_path": str(root / "01.djvu"), "relative_path": "01.djvu", "file_type": "DJVU", "page_count": 1, "occurrence_count": 0, "failure_count": 0}],
                        "pages": [],
                        "occurrences": [],
                        "failures": [],
                        "stats": {"scan_dir": str(root), "generated_at": "2026-07-06T00:10:00"},
                        "validation": {},
                        "assets": {},
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            output_html = root / "约字检索报告-DJVU阶段版.html"
            output_json = workspace / "run" / "report-djvu-only.json"
            merged = merge_existing_reports(
                root_dir=root,
                workspace_dir=workspace,
                output_html=output_html,
                output_json=output_json,
                worker_names={"worker_01"},
            )
            self.assertTrue(output_html.exists())
            self.assertTrue(output_json.exists())
            self.assertEqual(len(merged["documents"]), 1)
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `python -m unittest tests.test_report_pipeline_html.MergeExistingReportsTests -v`  
Expected: `FAIL` because `discover_worker_report_paths()` and `merge_existing_reports()` do not yet accept `worker_names` or `output_json`.

- [ ] **Step 3: Implement worker filtering and custom JSON output**

```python
def discover_worker_report_paths(workspace_dir: Path, worker_names: set[str] | None = None) -> list[Path]:
    paths: list[Path] = []
    for worker in sorted([p for p in workspace_dir.iterdir() if p.is_dir() and p.name.startswith("worker_")]):
        if worker_names is not None and worker.name not in worker_names:
            continue
        report_path = worker / "run" / "report.json"
        if report_path.exists():
            paths.append(report_path)
    return paths


def merge_existing_reports(
    root_dir: Path,
    workspace_dir: Path,
    output_html: Path,
    output_json: Path | None = None,
    worker_names: set[str] | None = None,
) -> dict[str, Any]:
    coordinator = ReportPipeline(
        root_dir=root_dir,
        output_html=output_html,
        workspace_dir=workspace_dir,
    )
    try:
        report_paths = discover_worker_report_paths(workspace_dir, worker_names=worker_names)
        merged = _merge_worker_reports(coordinator, report_paths)
        embed_assets(merged)
        json_path = output_json or coordinator.json_path
        write_report_outputs(
            report=merged,
            output_html=output_html,
            json_path=json_path,
            build_html=coordinator._build_html,
            workspace_dir=workspace_dir,
        )
        return merged
    finally:
        coordinator.close()
```

- [ ] **Step 4: Add CLI plumbing for `--merge-workers` and `--output-json`**

```python
parser.add_argument("--merge-workers", nargs="*", default=None)
parser.add_argument("--output-json", default=None)

if args.merge_only:
    report = merge_existing_reports(
        root_dir=Path(args.root_dir),
        workspace_dir=Path(args.workspace_dir),
        output_html=Path(args.output_html),
        output_json=Path(args.output_json) if args.output_json else None,
        worker_names=set(args.merge_workers) if args.merge_workers else None,
    )
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m unittest tests.test_report_pipeline_html.MergeExistingReportsTests -v`  
Expected: `OK`

- [ ] **Step 6: Record the intended no-op commit boundary**

```bash
# Workspace currently has no .git; do not commit here.
# If repository control is introduced later:
git add F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py
git commit -m "feat: support DJVU-only intermediate merge outputs"
```

### Task 2: Page-Range Aware PDF Shard Execution

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py:54-82`
- Modify: `F:\OCR\.tmp\work\report_pipeline.py:239-285`
- Test: `F:\OCR\.tmp\work\tests\test_ocr_core.py`

- [ ] **Step 1: Write the failing page-range tests**

```python
class PageRangeCheckpointTests(unittest.TestCase):
    def test_page_range_honors_checkpoint_and_cli_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            pdf_path = root / "sample.pdf"
            pdf_path.write_bytes(b"%PDF-1.4 fake")

            workspace = Path(tmp) / "worker_06a"
            pipeline = ReportPipeline(
                root_dir=root,
                output_html=root / "out.html",
                workspace_dir=workspace,
                include_paths={str(pdf_path)},
                start_page_index=200,
                end_page_index_exclusive=260,
            )
            try:
                doc = DocumentRecord(
                    document_id="doc-1",
                    file_path=pdf_path,
                    relative_path="sample.pdf",
                    file_type="PDF",
                    file_size_bytes=8,
                    file_hash_sha256="abc",
                    modified_time=0.0,
                    page_count=500,
                )
                pipeline._save_checkpoint(doc, 220, [], [], [])
                start, stop = pipeline._page_range_for_document(doc)
                self.assertEqual((start, stop), (220, 260))
            finally:
                pipeline.close()
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `python -m unittest tests.test_ocr_core.PageRangeCheckpointTests -v`  
Expected: `FAIL` because `ReportPipeline` has no shard page-range API yet.

- [ ] **Step 3: Add page-range fields to `ReportPipeline` and range calculation helper**

```python
class ReportPipeline:
    def __init__(
        self,
        root_dir: Path,
        output_html: Path,
        workspace_dir: Path,
        page_limit: int | None = None,
        document_limit: int | None = None,
        include_paths: set[str] | None = None,
        start_page_index: int | None = None,
        end_page_index_exclusive: int | None = None,
    ) -> None:
        self.start_page_index = start_page_index
        self.end_page_index_exclusive = end_page_index_exclusive

    def _page_range_for_document(self, document: DocumentRecord) -> tuple[int, int]:
        checkpoint = self._load_checkpoint(document)
        checkpoint_start = checkpoint.get("next_page_index", 0) if checkpoint else 0
        start = max(checkpoint_start, self.start_page_index or 0)
        stop = document.page_count
        if self.page_limit is not None:
            stop = min(stop, self.page_limit)
        if self.end_page_index_exclusive is not None:
            stop = min(stop, self.end_page_index_exclusive)
        return start, stop
```

- [ ] **Step 4: Update `_process_document()` and CLI arguments to use the new range**

```python
parser.add_argument("--start-page-index", type=int, default=None)
parser.add_argument("--end-page-index-exclusive", type=int, default=None)

start_page_index, page_stop = self._page_range_for_document(document)
page_indexes = range(start_page_index, page_stop)
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m unittest tests.test_ocr_core.PageRangeCheckpointTests -v`  
Expected: `OK`

- [ ] **Step 6: Record the intended no-op commit boundary**

```bash
# Workspace currently has no .git; do not commit here.
git add F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_ocr_core.py
git commit -m "feat: add page-range aware shard execution"
```

### Task 3: Duplicate-Document Final Aggregation

**Files:**
- Modify: `F:\OCR\.tmp\work\report_pipeline.py:1428-1457`
- Test: `F:\OCR\.tmp\work\tests\test_report_pipeline_html.py`

- [ ] **Step 1: Write the failing duplicate-document merge test**

```python
class SplitPdfAggregationTests(unittest.TestCase):
    def test_merge_worker_reports_collapses_split_pdf_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "full_run_v4"
            report_a = workspace / "worker_06a" / "run"
            report_b = workspace / "worker_06b" / "run"
            report_a.mkdir(parents=True)
            report_b.mkdir(parents=True)

            shared_file = str(root / "道光婺源县志.pdf")
            payload_a = {
                "root_dir": str(root),
                "output_html": str(root / "a.html"),
                "started_at": "2026-07-06T00:00:00",
                "finished_at": "2026-07-06T00:10:00",
                "documents": [{"document_id": "doc-a", "file_path": shared_file, "relative_path": "道光婺源县志.pdf", "file_type": "PDF", "page_count": 1858, "occurrence_count": 1, "failure_count": 0, "file_hash_sha256": "hash-1"}],
                "pages": [{"page_image_id": "p-300", "document_id": "doc-a", "page_number": 300, "page_index": 299, "relative_path": "道光婺源县志.pdf", "file_name": "道光婺源县志.pdf", "page_width": 10, "page_height": 10, "occurrence_count": 1}],
                "occurrences": [{"occurrence_id": "occ-a", "document_id": "doc-a", "page_image_id": "p-300", "file_path": shared_file, "relative_path": "道光婺源县志.pdf", "file_name": "道光婺源县志.pdf", "file_extension": ".pdf", "file_size_bytes": 1, "file_hash_sha256": "hash-1", "document_page_count": 1858, "page_number": 300, "page_index": 299, "page_occurrence_index": 0, "document_occurrence_index": 0, "matched_character": "约", "character_variant": "simplified", "unicode_codepoint": "U+7EA6", "context_before": "", "context_after": "", "context_full": "约", "text_line": "约", "text_block": "约", "location_method": "pdf_ocr", "detection_sources": ["ocr"], "ocr_engine": "rapidocr-onnxruntime", "ocr_confidence": 0.9, "secondary_ocr_result": "约", "secondary_ocr_confidence": 0.9, "verification_method": "rapidocr_full_page_plus_tesseract_single_char", "verification_status": "confirmed", "review_reason": "", "source_x0": 0.0, "source_y0": 0.0, "source_x1": 1.0, "source_y1": 1.0, "source_page_width": 10.0, "source_page_height": 10.0, "source_coordinate_unit": "pixel", "source_coordinate_origin": "top_left", "normalized_x0": 0.0, "normalized_y0": 0.0, "normalized_x1": 0.1, "normalized_y1": 0.1, "page_rotation": 0, "render_dpi": 144, "crop_image_id": "crop-a", "page_image_id": "p-300", "error_message": ""}],
                "failures": [],
                "stats": {"scan_dir": str(root), "generated_at": "2026-07-06T00:10:00"},
                "validation": {},
                "assets": {},
            }
            payload_b = json.loads(json.dumps(payload_a, ensure_ascii=False))
            payload_b["documents"][0]["document_id"] = "doc-b"
            payload_b["pages"][0]["document_id"] = "doc-b"
            payload_b["pages"][0]["page_image_id"] = "p-301"
            payload_b["pages"][0]["page_number"] = 301
            payload_b["pages"][0]["page_index"] = 300
            payload_b["occurrences"][0]["document_id"] = "doc-b"
            payload_b["occurrences"][0]["page_image_id"] = "p-301"
            payload_b["occurrences"][0]["occurrence_id"] = "occ-b"
            payload_b["occurrences"][0]["page_number"] = 301
            payload_b["occurrences"][0]["page_index"] = 300

            (report_a / "report.json").write_text(json.dumps(payload_a, ensure_ascii=False), encoding="utf-8")
            (report_b / "report.json").write_text(json.dumps(payload_b, ensure_ascii=False), encoding="utf-8")

            merged = merge_existing_reports(root, workspace, root / "final.html")
            self.assertEqual(len(merged["documents"]), 1)
            self.assertEqual(sorted(page["page_index"] for page in merged["pages"]), [299, 300])
```

- [ ] **Step 2: Run the targeted tests to verify they fail**

Run: `python -m unittest tests.test_report_pipeline_html.SplitPdfAggregationTests -v`  
Expected: `FAIL` because duplicate PDF documents are currently concatenated, not aggregated.

- [ ] **Step 3: Implement document-level aggregation in `_merge_worker_reports()`**

```python
def _merge_worker_reports(coordinator: ReportPipeline, report_paths: list[Path]) -> dict[str, Any]:
    raw_documents: list[dict[str, Any]] = []
    raw_pages: list[dict[str, Any]] = []
    raw_occurrences: list[dict[str, Any]] = []
    raw_failures: list[dict[str, Any]] = []
    started_at: list[str] = []
    finished_at: list[str] = []
    for path in report_paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        raw_documents.extend(report["documents"])
        raw_pages.extend(report["pages"])
        raw_occurrences.extend(report["occurrences"])
        raw_failures.extend(report["failures"])
        started_at.append(report["started_at"])
        finished_at.append(report["finished_at"])

    documents = aggregate_documents(raw_documents, raw_pages, raw_occurrences, raw_failures)
    pages = sorted(dedupe_pages(raw_pages), key=lambda item: (item["relative_path"], item["page_index"]))
    occurrences = dedupe_occurrences(raw_occurrences)
    assign_occurrence_indexes(occurrences)
    failures = raw_failures
```

- [ ] **Step 4: Add small helpers instead of inlining aggregation**

```python
def aggregate_documents(
    documents: list[dict[str, Any]],
    pages: list[dict[str, Any]],
    occurrences: list[dict[str, Any]],
    failures: list[dict[str, Any]],
) -> list[dict[str, Any]]:
    grouped: dict[tuple[str, str], dict[str, Any]] = {}
    for document in documents:
        key = (document["file_path"], document.get("file_hash_sha256", ""))
        current = grouped.get(key)
        if current is None:
            grouped[key] = dict(document)
            continue
        current["occurrence_count"] = current.get("occurrence_count", 0) + document.get("occurrence_count", 0)
        current["failure_count"] = current.get("failure_count", 0) + document.get("failure_count", 0)
    return list(grouped.values())
```

- [ ] **Step 5: Run the tests to verify they pass**

Run: `python -m unittest tests.test_report_pipeline_html.SplitPdfAggregationTests -v`  
Expected: `OK`

- [ ] **Step 6: Record the intended no-op commit boundary**

```bash
# Workspace currently has no .git; do not commit here.
git add F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py
git commit -m "feat: aggregate split PDF worker reports safely"
```

### Task 4: Runtime Scripts for Stage Merge and Worker_06 Shards

**Files:**
- Create: `F:\OCR\.tmp\work\merge_djvu_only.ps1`
- Create: `F:\OCR\.tmp\work\start_worker06_shards.ps1`
- Test: manual dry-run commands in PowerShell

- [ ] **Step 1: Create the DJVU-only merge script**

```powershell
$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$rootDir = "F:\OCR"
$outputHtml = Join-Path $rootDir "约字检索报告-DJVU阶段版.html"
$outputJson = Join-Path $workspaceDir "run\report-djvu-only.json"

Set-Location $workdir

python report_pipeline.py `
  --merge-only `
  --root-dir $rootDir `
  --workspace-dir $workspaceDir `
  --output-html $outputHtml `
  --output-json $outputJson `
  --merge-workers worker_01 worker_02 worker_03 worker_04 worker_05
```

- [ ] **Step 2: Dry-run the merge script syntax**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -File F:\OCR\.tmp\work\merge_djvu_only.ps1`  
Expected: once the first five workers have `report.json`, the command writes the stage HTML and stage JSON without touching `worker_06`.

- [ ] **Step 3: Create the worker_06 shard launcher**

```powershell
$ErrorActionPreference = "Stop"

$workdir = "F:\OCR\.tmp\work"
$workspaceDir = "F:\OCR\.tmp\full_run_v4"
$rootDir = "F:\OCR"
$workerDir = Join-Path $workspaceDir "worker_06"
$checkpoint = Get-ChildItem (Join-Path $workerDir "run") -Filter "checkpoint-*.json" | Sort-Object LastWriteTime -Descending | Select-Object -First 1
$payload = Get-Content -Raw $checkpoint.FullName | ConvertFrom-Json
$start = [int]$payload.next_page_index
$end = [int]$payload.document_page_count
$remaining = $end - $start
$shardCount = if ($remaining -ge 1200) { 4 } elseif ($remaining -ge 600) { 3 } else { 2 }
$chunk = [Math]::Ceiling($remaining / $shardCount)
$pythonExe = (python -c "import sys; print(sys.executable)").Trim()

Get-CimInstance Win32_Process |
  Where-Object { $_.Name -eq "python.exe" -and $_.CommandLine -match "worker_06(\\\\partial.html|\\s)" } |
  ForEach-Object { Stop-Process -Id $_.ProcessId -Force }

for ($index = 0; $index -lt $shardCount; $index++) {
  $shardName = "worker_06" + [char]([int][char]'a' + $index)
  $shardDir = Join-Path $workspaceDir $shardName
  $shardStart = $start + ($index * $chunk)
  $shardEnd = [Math]::Min($end, $shardStart + $chunk)
  if ($shardStart -ge $shardEnd) { continue }

  New-Item -ItemType Directory -Force -Path $shardDir | Out-Null
  $cmd = "& { Set-Location '$workdir'; & '$pythonExe' 'report_pipeline.py' '--root-dir' '$rootDir' '--workspace-dir' '$shardDir' '--output-html' '$shardDir\\partial.html' '--include-path' '$rootDir\\道光婺源县志.pdf' '--start-page-index' '$shardStart' '--end-page-index-exclusive' '$shardEnd' }"
  Start-Process powershell.exe -ArgumentList @('-NoProfile', '-ExecutionPolicy', 'Bypass', '-Command', $cmd) -WindowStyle Hidden | Out-Null
}
```

- [ ] **Step 4: Dry-run the shard script logic without starting OCR**

Run: `powershell -NoProfile -ExecutionPolicy Bypass -Command "$payload = Get-Content -Raw 'F:\OCR\.tmp\full_run_v4\worker_06\run\checkpoint-389f8baad2856694.json' | ConvertFrom-Json; $payload.next_page_index; $payload.document_page_count"`  
Expected: prints the current start and total page bounds that the shard script will use.

- [ ] **Step 5: Run the full verification suite after both scripts and code changes exist**

Run: `python -m py_compile report_pipeline.py progress_dashboard.py`  
Expected: no output

Run: `python -m unittest discover -s tests -v`  
Expected: `OK`

- [ ] **Step 6: Record the intended no-op commit boundary**

```bash
# Workspace currently has no .git; do not commit here.
git add F:\OCR\.tmp\work\report_pipeline.py F:\OCR\.tmp\work\merge_djvu_only.ps1 F:\OCR\.tmp\work\start_worker06_shards.ps1 F:\OCR\.tmp\work\tests\test_ocr_core.py F:\OCR\.tmp\work\tests\test_report_pipeline_html.py
git commit -m "feat: add high-accuracy worker_06 shard orchestration"
```

## Self-Review

**Spec coverage:**  
- DJVU 阶段版：Task 1 + Task 4 covered  
- 页范围分片：Task 2 covered  
- 同一 PDF 多分片最终聚合：Task 3 covered  
- 高精度保持不降 DPI：plan 未引入任何 DPI、阈值、模型变更  
- 回滚保留原 `worker_06`：Task 4 的目录策略 covered

**Placeholder scan:**  
- No `TODO` / `TBD` / “similar to previous task” placeholders remain.

**Type consistency:**  
- `worker_names`, `output_json`, `start_page_index`, `end_page_index_exclusive`, and `_page_range_for_document()` are used consistently across tasks.
