import json
import tempfile
import unittest
from pathlib import Path

from report_pipeline import (
    ReportPipeline,
    build_file_url,
    discover_worker_report_paths,
    embed_assets,
    load_browser_validation,
    merge_existing_reports,
    prepare_report_for_output,
    write_report_outputs,
)


def make_sample_report(output_html: Path) -> dict:
    return {
        "root_dir": r"E:\OCR",
        "output_html": str(output_html),
        "started_at": "2026-07-06T14:00:00",
        "finished_at": "2026-07-06T14:30:00",
        "documents": [
            {
                "document_id": "doc-1",
                "file_path": r"E:\OCR\示例 文件#1.djvu",
                "relative_path": "示例 文件#1.djvu",
                "file_type": "DJVU",
                "page_count": 1,
            }
        ],
        "pages": [
            {
                "page_image_id": "page-1",
                "document_id": "doc-1",
                "page_number": 1,
                "page_index": 0,
                "image_path": r"E:\OCR\.tmp\full_run_v4\worker_01\run\pages\page-1.webp",
                "page_width": 200,
                "page_height": 300,
                "occurrence_count": 1,
                "relative_path": "示例 文件#1.djvu",
                "file_name": "示例 文件#1.djvu",
            }
        ],
        "occurrences": [
            {
                "occurrence_id": "occ-1",
                "global_occurrence_index": 1,
                "document_id": "doc-1",
                "file_path": r"E:\OCR\示例 文件#1.djvu",
                "relative_path": "示例 文件#1.djvu",
                "file_name": "示例 文件#1.djvu",
                "file_extension": ".djvu",
                "file_size_bytes": 1234,
                "file_hash_sha256": "abc",
                "document_page_count": 1,
                "page_number": 1,
                "page_index": 0,
                "page_occurrence_index": 1,
                "document_occurrence_index": 1,
                "matched_character": "约",
                "character_variant": "simplified",
                "unicode_codepoint": "U+7EA6",
                "context_before": "前文",
                "context_after": "后文",
                "context_full": "前文约后文",
                "text_line": "前文约后文",
                "text_block": "前文约后文",
                "location_method": "djvu_ocr",
                "detection_sources": ["ocr"],
                "ocr_engine": "rapidocr-onnxruntime",
                "ocr_confidence": 0.93,
                "secondary_ocr_result": "约",
                "secondary_ocr_confidence": 0.95,
                "verification_method": "rapidocr_full_page_plus_tesseract_single_char",
                "verification_status": "confirmed",
                "review_reason": "",
                "source_x0": 10.0,
                "source_y0": 20.0,
                "source_x1": 30.0,
                "source_y1": 60.0,
                "source_page_width": 200.0,
                "source_page_height": 300.0,
                "source_coordinate_unit": "pixel",
                "source_coordinate_origin": "top_left",
                "normalized_x0": 0.05,
                "normalized_y0": 0.0666667,
                "normalized_x1": 0.15,
                "normalized_y1": 0.2,
                "page_rotation": 0,
                "render_dpi": 144,
                "page_image_id": "page-1",
                "crop_image_id": "crop-1",
                "crop_image_path": r"E:\OCR\.tmp\full_run_v4\worker_01\run\crops\crop-1.webp",
                "error_message": "",
            }
        ],
        "failures": [
            {
                "failure_id": "failure-1",
                "document_id": "doc-2",
                "file_path": r"E:\OCR\失败 文件#2.pdf",
                "file_type": "PDF",
                "file_size_bytes": 4321,
                "stage": "page_process",
                "error_type": "RuntimeError",
                "error_message": "boom",
                "page_number": 3,
                "fallback_action": "continue_next_page_or_file",
                "possible_missed_hits": True,
            }
        ],
        "stats": {
            "scan_dir": r"E:\OCR",
            "generated_at": "2026-07-06T14:30:00",
            "pdf_file_count": 1,
            "djvu_file_count": 1,
            "djv_file_count": 0,
            "success_file_count": 1,
            "failure_file_count": 1,
            "document_total_pages": 1,
            "hit_file_count": 1,
            "hit_page_count": 1,
            "simplified_total": 1,
            "traditional_total": 0,
            "combined_total": 1,
            "simplified_confirmed": 1,
            "traditional_confirmed": 0,
            "simplified_needs_review": 0,
            "traditional_needs_review": 0,
            "rejected_total": 0,
            "text_layer_hits": 3,
            "ocr_hits": 4,
            "pdf_text_layer_hits": 2,
            "pdf_ocr_hits": 1,
            "djvu_text_layer_hits": 1,
            "djvu_ocr_hits": 3,
            "only_simplified_files": 1,
            "only_traditional_files": 0,
            "both_variant_files": 0,
            "embedded_page_count": 1,
        },
        "assets": {},
    }


class BuildFileUrlTests(unittest.TestCase):
    def test_build_file_url_encodes_special_characters(self) -> None:
        path = r"E:\OCR\目录 名#%.pdf"
        self.assertEqual(
            build_file_url(path),
            "file:///E:/OCR/%E7%9B%AE%E5%BD%95%20%E5%90%8D%23%25.pdf",
        )


class BrowserValidationLoadTests(unittest.TestCase):
    def test_load_browser_validation_merges_saved_results_with_defaults(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp)
            (workspace / "browser_validation.json").write_text(
                json.dumps(
                    {
                        "html_direct_open": "通过",
                        "search": "通过",
                        "open_original_file": "受浏览器限制",
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            validation = load_browser_validation(workspace)
            self.assertEqual(validation["html_direct_open"], "通过")
            self.assertEqual(validation["search"], "通过")
            self.assertEqual(validation["open_original_file"], "受浏览器限制")
            self.assertEqual(validation["traditional_filter"], "NOT_RUN")


class PrepareReportForOutputTests(unittest.TestCase):
    def test_prepare_report_for_output_adds_user_facing_fields(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "workspace"
            workspace.mkdir()
            report = make_sample_report(Path(tmp) / "报告.html")
            report["occurrences"][0]["verification_status"] = "needs_review"

            prepare_report_for_output(report, workspace)

            page = report["pages"][0]
            occurrence = report["occurrences"][0]
            self.assertEqual(page["user_page_label"], "第 1 页")
            self.assertEqual(occurrence["user_verification_label"], "待判断")
            self.assertEqual(occurrence["result_title"], "示例 文件#1.djvu · 第 1 页 · 第 1 处")
            self.assertEqual(occurrence["context_preview"], "前文约后文")
            self.assertIn("有出处页", occurrence["evidence_badges"])
            self.assertIn("有截取小图", occurrence["evidence_badges"])


class WriteReportOutputsTests(unittest.TestCase):
    def test_write_report_outputs_injects_urls_validation_and_html_size(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            output_html = root / "约字检索报告.html"
            workspace = Path(tmp) / "work"
            pipeline = ReportPipeline(
                root_dir=root,
                output_html=output_html,
                workspace_dir=workspace,
            )
            try:
                (workspace / "browser_validation.json").write_text(
                    json.dumps({"html_direct_open": "通过", "search": "通过"}, ensure_ascii=False),
                    encoding="utf-8",
                )
                report = make_sample_report(output_html)
                write_report_outputs(
                    report=report,
                    output_html=output_html,
                    json_path=workspace / "run" / "report.json",
                    build_html=pipeline._build_html,
                    workspace_dir=workspace,
                )
                saved = json.loads((workspace / "run" / "report.json").read_text(encoding="utf-8"))
                self.assertIn("open_file_url", saved["occurrences"][0])
                self.assertEqual(
                    saved["occurrences"][0]["open_file_url"],
                    "file:///E:/OCR/%E7%A4%BA%E4%BE%8B%20%E6%96%87%E4%BB%B6%231.djvu",
                )
                self.assertIn("image_asset_key", saved["pages"][0])
                self.assertIn("crop_asset_key", saved["occurrences"][0])
                self.assertNotIn("image_path", saved["pages"][0])
                self.assertNotIn("crop_image_path", saved["occurrences"][0])
                self.assertEqual(saved["validation"]["html_direct_open"], "通过")
                self.assertGreater(saved["stats"]["html_file_size_bytes"], 0)
                html = output_html.read_text(encoding="utf-8")
                self.assertIn("档案校对工作台", html)
                self.assertIn("结果清单", html)
                self.assertIn("导出校对记录", html)
                self.assertIn("查看来源详情", html)
                self.assertIn("localStorage", html)
                self.assertNotIn("验证状态", html)
                self.assertNotIn("OCR 引擎", html)
                self.assertNotIn(r"E:\OCR\.tmp\full_run_v4", html)
            finally:
                pipeline.close()


class WorkbenchHtmlTests(unittest.TestCase):
    def test_build_html_renders_user_workbench_layout(self) -> None:
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

            self.assertIn("档案校对工作台", html)
            self.assertIn("结果清单", html)
            self.assertIn("workspace-shell", html)
            self.assertIn("detail-pane detail-pane-b2", html)
            self.assertIn("viewer-grid viewer-grid-b2", html)
            self.assertIn("detail-strip", html)
            self.assertIn("detail-bottom-bar", html)
            self.assertIn("出处页预览", html)
            self.assertIn("截取小图", html)
            self.assertNotIn("验证状态", html)
            self.assertNotIn("OCR 引擎", html)

    def test_build_html_includes_workbench_interactions(self) -> None:
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

            self.assertIn("function renderResultsList()", html)
            self.assertIn("function selectOccurrence(", html)
            self.assertIn("function goToNextPending()", html)
            self.assertIn("function zoomViewer(", html)
            self.assertIn("function resetViewer(", html)
            self.assertIn("function syncViewersFromPrimary(", html)
            self.assertIn("function openImmersivePreview(", html)
            self.assertIn("上一条", html)
            self.assertIn("下一条", html)
            self.assertIn("下一条待处理", html)
            self.assertIn("重新居中", html)

    def test_build_html_includes_local_review_persistence_and_export(self) -> None:
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

            self.assertIn("localStorage", html)
            self.assertIn("saveReviewState", html)
            self.assertIn("loadReviewState", html)
            self.assertIn("export-review", html)
            self.assertIn("导出校对记录", html)
            self.assertIn("toggle-note-editor", html)
            self.assertIn("查看来源详情", html)

    def test_build_html_excludes_loading_feedback_hooks(self) -> None:
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

            self.assertNotIn("function setDetailLoading(", html)
            self.assertNotIn("function renderResultsSkeleton(", html)
            self.assertNotIn("function renderDetailSkeleton()", html)
            self.assertNotIn("detail-loading", html)
            self.assertNotIn("spinner", html)
            self.assertNotIn("skeleton-", html)
            self.assertNotIn("正在导出", html)
            self.assertNotIn("正在切换内容", html)
            self.assertNotIn("正在更新结果", html)
            self.assertNotIn("正在准备内容", html)

    def test_build_html_excludes_detail_loading_cleanup_hooks(self) -> None:
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

            self.assertNotIn("setDetailLoading(true", html)
            self.assertNotIn("setDetailLoading(false);", html)
            self.assertNotIn("renderResultsSkeleton();", html)
            self.assertNotIn("renderDetailSkeleton();", html)
            self.assertNotIn("startInitialLoading();", html)

    def test_build_html_uses_closest_for_result_selection_clicks(self) -> None:
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

            self.assertIn("function getClosestActionValue(", html)
            self.assertIn('event.target.closest(`[${attributeName}]`)', html)
            self.assertIn('const selectId = getClosestActionValue(event, "data-select");', html)

    def test_build_html_removes_old_table_and_viewer_first_flow(self) -> None:
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

            self.assertNotIn("<table>", html)
            self.assertNotIn("待人工复核", html)
            self.assertNotIn("处理失败文件", html)
            self.assertNotIn("执行报告", html)
            self.assertIn("viewer-shell", html)
            self.assertIn("view-toolbar", html)
            self.assertIn("result-meta-row", html)
            self.assertIn("result-context-line", html)


class MergeExistingReportsTests(unittest.TestCase):
    def test_discover_worker_report_paths_filters_requested_workers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "full_run_v4"
            for name in ("worker_01", "worker_02", "worker_06"):
                run_dir = workspace / name / "run"
                run_dir.mkdir(parents=True)
                (run_dir / "report.json").write_text(
                    json.dumps(
                        {
                            "documents": [],
                            "pages": [],
                            "occurrences": [],
                            "failures": [],
                            "started_at": "2026-07-06T00:00:00",
                            "finished_at": "2026-07-06T00:00:00",
                        },
                        ensure_ascii=False,
                    ),
                    encoding="utf-8",
                )

            paths = discover_worker_report_paths(workspace, worker_names={"worker_01", "worker_02"})
            self.assertEqual([path.parent.parent.name for path in paths], ["worker_01", "worker_02"])

    def test_merge_existing_reports_writes_custom_json_path(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "full_run_v4"
            (workspace / "run").mkdir(parents=True)
            run_dir = workspace / "worker_01" / "run"
            run_dir.mkdir(parents=True)
            pages_dir = run_dir / "pages"
            crops_dir = run_dir / "crops"
            pages_dir.mkdir(parents=True)
            crops_dir.mkdir(parents=True)
            (pages_dir / "page-1.webp").write_bytes(b"page")
            (crops_dir / "crop-1.webp").write_bytes(b"crop")
            payload = make_sample_report(root / "partial.html")
            payload["root_dir"] = str(root)
            payload["output_html"] = str(root / "partial.html")
            payload["pages"][0]["image_path"] = str(pages_dir / "page-1.webp")
            payload["occurrences"][0]["crop_image_path"] = str(crops_dir / "crop-1.webp")
            (run_dir / "report.json").write_text(
                json.dumps(payload, ensure_ascii=False),
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
            self.assertEqual(merged["documents"][0]["relative_path"], "示例 文件#1.djvu")


class SplitPdfAggregationTests(unittest.TestCase):
    def test_merge_existing_reports_collapses_split_pdf_documents(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "full_run_v4"
            (workspace / "run").mkdir(parents=True)
            shared_file = str(root / "道光婺源县志.pdf")

            for worker_name, page_number, document_id in (("worker_06a", 300, "doc-a"), ("worker_06b", 301, "doc-b")):
                run_dir = workspace / worker_name / "run"
                pages_dir = run_dir / "pages"
                crops_dir = run_dir / "crops"
                pages_dir.mkdir(parents=True)
                crops_dir.mkdir(parents=True)
                page_path = pages_dir / f"{worker_name}-page.webp"
                crop_path = crops_dir / f"{worker_name}-crop.webp"
                page_path.write_bytes(b"page")
                crop_path.write_bytes(b"crop")
                report = {
                    "root_dir": str(root),
                    "output_html": str(root / f"{worker_name}.html"),
                    "started_at": "2026-07-06T00:00:00",
                    "finished_at": "2026-07-06T00:10:00",
                    "documents": [
                        {
                            "document_id": document_id,
                            "file_path": shared_file,
                            "relative_path": "道光婺源县志.pdf",
                            "file_type": "PDF",
                            "page_count": 1858,
                            "occurrence_count": 1,
                            "failure_count": 0,
                        }
                    ],
                    "pages": [
                        {
                            "page_image_id": f"{document_id}-p{page_number}",
                            "document_id": document_id,
                            "page_number": page_number,
                            "page_index": page_number - 1,
                            "image_path": str(page_path),
                            "page_width": 200,
                            "page_height": 300,
                            "occurrence_count": 1,
                            "relative_path": "道光婺源县志.pdf",
                            "file_name": "道光婺源县志.pdf",
                        }
                    ],
                    "occurrences": [
                        {
                            "occurrence_id": f"occ-{document_id}",
                            "global_occurrence_index": 0,
                            "document_id": document_id,
                            "file_path": shared_file,
                            "relative_path": "道光婺源县志.pdf",
                            "file_name": "道光婺源县志.pdf",
                            "file_extension": ".pdf",
                            "file_size_bytes": 1,
                            "file_hash_sha256": "hash-1",
                            "document_page_count": 1858,
                            "page_number": page_number,
                            "page_index": page_number - 1,
                            "page_occurrence_index": 0,
                            "document_occurrence_index": 0,
                            "matched_character": "约",
                            "character_variant": "simplified",
                            "unicode_codepoint": "U+7EA6",
                            "context_before": "",
                            "context_after": "",
                            "context_full": "约",
                            "text_line": "约",
                            "text_block": "约",
                            "location_method": "pdf_ocr",
                            "detection_sources": ["ocr"],
                            "ocr_engine": "rapidocr-onnxruntime",
                            "ocr_confidence": 0.9,
                            "secondary_ocr_result": "约",
                            "secondary_ocr_confidence": 0.9,
                            "verification_method": "rapidocr_full_page_plus_tesseract_single_char",
                            "verification_status": "confirmed",
                            "review_reason": "",
                            "source_x0": 0.0,
                            "source_y0": 0.0,
                            "source_x1": 1.0,
                            "source_y1": 1.0,
                            "source_page_width": 200.0,
                            "source_page_height": 300.0,
                            "source_coordinate_unit": "pixel",
                            "source_coordinate_origin": "top_left",
                            "normalized_x0": 0.0,
                            "normalized_y0": 0.0,
                            "normalized_x1": 0.1,
                            "normalized_y1": 0.1,
                            "page_rotation": 0,
                            "render_dpi": 144,
                            "page_image_id": f"{document_id}-p{page_number}",
                            "crop_image_id": f"crop-{document_id}",
                            "crop_image_path": str(crop_path),
                            "error_message": "",
                        }
                    ],
                    "failures": [],
                    "stats": {
                        "scan_dir": str(root),
                        "generated_at": "2026-07-06T00:10:00",
                        "pdf_file_count": 1,
                        "djvu_file_count": 0,
                        "djv_file_count": 0,
                        "success_file_count": 1,
                        "failure_file_count": 0,
                        "document_total_pages": 1858,
                        "hit_file_count": 1,
                        "hit_page_count": 1,
                        "simplified_total": 1,
                        "traditional_total": 0,
                        "combined_total": 1,
                        "simplified_confirmed": 1,
                        "traditional_confirmed": 0,
                        "simplified_needs_review": 0,
                        "traditional_needs_review": 0,
                        "rejected_total": 0,
                        "text_layer_hits": 0,
                        "ocr_hits": 1,
                        "pdf_ocr_hits": 1,
                        "djvu_ocr_hits": 0,
                        "only_simplified_files": 1,
                        "only_traditional_files": 0,
                        "both_variant_files": 0,
                        "embedded_page_count": 1,
                    },
                    "validation": {},
                    "assets": {},
                }
                (run_dir / "report.json").write_text(json.dumps(report, ensure_ascii=False), encoding="utf-8")

            merged = merge_existing_reports(
                root_dir=root,
                workspace_dir=workspace,
                output_html=root / "final.html",
            )

            self.assertEqual(len(merged["documents"]), 1)
            self.assertEqual(merged["documents"][0]["page_count"], 1858)
            self.assertEqual(merged["documents"][0]["occurrence_count"], 2)
            self.assertEqual(sorted(page["page_index"] for page in merged["pages"]), [299, 300])

    def test_merge_existing_reports_reuses_embedded_assets_from_worker_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "full_run_v4"
            (workspace / "run").mkdir(parents=True)
            worker_run = workspace / "worker_01" / "run"
            worker_run.mkdir(parents=True)

            source_workspace = Path(tmp) / "source-workspace"
            source_pipeline = ReportPipeline(
                root_dir=root,
                output_html=root / "source.html",
                workspace_dir=source_workspace,
            )
            try:
                report = make_sample_report(root / "source.html")
                page_path = source_workspace / "page-1.webp"
                crop_path = source_workspace / "crop-1.webp"
                page_path.write_bytes(b"page")
                crop_path.write_bytes(b"crop")
                report["pages"][0]["image_path"] = str(page_path)
                report["occurrences"][0]["crop_image_path"] = str(crop_path)
                embed_assets(report)
                write_report_outputs(
                    report=report,
                    output_html=root / "source.html",
                    json_path=worker_run / "report.json",
                    build_html=source_pipeline._build_html,
                    workspace_dir=source_workspace,
                )
            finally:
                source_pipeline.close()

            merged = merge_existing_reports(
                root_dir=root,
                workspace_dir=workspace,
                output_html=root / "merged.html",
                worker_names={"worker_01"},
            )

            self.assertIn("assets", merged)
            self.assertTrue(merged["assets"])
            self.assertIn(merged["pages"][0]["image_asset_key"], merged["assets"])
            self.assertIn(merged["occurrences"][0]["crop_asset_key"], merged["assets"])


if __name__ == "__main__":
    unittest.main()
