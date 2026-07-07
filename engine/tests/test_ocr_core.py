import unittest
import tempfile
from pathlib import Path

from archivelens_engine.report_pipeline import DocumentRecord, ReportPipeline, discover_worker_report_paths

from archivelens_engine.ocr_core import (
    assign_occurrence_indexes,
    build_context_fields,
    classify_verification_status,
    dedupe_occurrences,
    normalize_bbox,
    split_line_bbox,
)


class NormalizeBboxTests(unittest.TestCase):
    def test_normalize_bbox_keeps_expected_ratios(self) -> None:
        box = normalize_bbox(20, 40, 60, 140, 200, 400)
        self.assertEqual(box["source_x0"], 20.0)
        self.assertEqual(box["source_y0"], 40.0)
        self.assertEqual(box["source_x1"], 60.0)
        self.assertEqual(box["source_y1"], 140.0)
        self.assertEqual(box["normalized_x0"], 0.1)
        self.assertEqual(box["normalized_y0"], 0.1)
        self.assertEqual(box["normalized_x1"], 0.3)
        self.assertEqual(box["normalized_y1"], 0.35)


class SplitLineBboxTests(unittest.TestCase):
    def test_split_line_bbox_uses_vertical_segments_for_tall_boxes(self) -> None:
        boxes = split_line_bbox("甲約乙", (100, 20, 160, 320))
        self.assertEqual(len(boxes), 3)
        self.assertEqual(boxes[1], (100.0, 120.0, 160.0, 220.0))

    def test_split_line_bbox_uses_horizontal_segments_for_wide_boxes(self) -> None:
        boxes = split_line_bbox("ABCD", (10, 50, 210, 90))
        self.assertEqual(len(boxes), 4)
        self.assertEqual(boxes[2], (110.0, 50.0, 160.0, 90.0))


class BuildContextFieldsTests(unittest.TestCase):
    def test_build_context_fields_preserves_original_glyphs(self) -> None:
        context = build_context_fields("雙方應按照本協議約定的期限完成交付", 8)
        self.assertEqual(context["context_before"], "雙方應按照本協議")
        self.assertEqual(context["matched_character"], "約")
        self.assertEqual(context["context_after"], "定的期限完成交付")
        self.assertEqual(context["context_full"], "雙方應按照本協議約定的期限完成交付")


class DedupeOccurrencesTests(unittest.TestCase):
    def test_dedupe_occurrences_prefers_text_layer_when_boxes_overlap(self) -> None:
        items = [
            {
                "occurrence_id": "ocr-1",
                "file_path": "doc.pdf",
                "page_number": 3,
                "matched_character": "約",
                "unicode_codepoint": "U+7D04",
                "context_full": "前後約定內容",
                "location_method": "pdf_ocr",
                "detection_sources": ["ocr"],
                "source_x0": 100.0,
                "source_y0": 200.0,
                "source_x1": 120.0,
                "source_y1": 260.0,
            },
            {
                "occurrence_id": "text-1",
                "file_path": "doc.pdf",
                "page_number": 3,
                "matched_character": "約",
                "unicode_codepoint": "U+7D04",
                "context_full": "前後約定內容",
                "location_method": "pdf_text_layer",
                "detection_sources": ["text"],
                "source_x0": 102.0,
                "source_y0": 198.0,
                "source_x1": 121.0,
                "source_y1": 259.0,
            },
        ]
        deduped = dedupe_occurrences(items)
        self.assertEqual(len(deduped), 1)
        self.assertEqual(deduped[0]["location_method"], "pdf_text_layer")
        self.assertEqual(sorted(deduped[0]["detection_sources"]), ["ocr", "text"])

    def test_dedupe_occurrences_keeps_simplified_and_traditional_separate(self) -> None:
        items = [
            {
                "occurrence_id": "ocr-1",
                "file_path": "doc.pdf",
                "page_number": 3,
                "matched_character": "约",
                "unicode_codepoint": "U+7EA6",
                "context_full": "雙方另有约定",
                "location_method": "pdf_ocr",
                "detection_sources": ["ocr"],
                "source_x0": 100.0,
                "source_y0": 200.0,
                "source_x1": 120.0,
                "source_y1": 260.0,
            },
            {
                "occurrence_id": "text-1",
                "file_path": "doc.pdf",
                "page_number": 3,
                "matched_character": "約",
                "unicode_codepoint": "U+7D04",
                "context_full": "雙方另有約定",
                "location_method": "pdf_text_layer",
                "detection_sources": ["text"],
                "source_x0": 102.0,
                "source_y0": 198.0,
                "source_x1": 121.0,
                "source_y1": 259.0,
            },
        ]
        deduped = dedupe_occurrences(items)
        self.assertEqual(len(deduped), 2)


class ClassifyVerificationStatusTests(unittest.TestCase):
    def test_classify_verification_status_confirms_high_confidence_matching_ocr(self) -> None:
        status, reason = classify_verification_status("約", 0.93, "約")
        self.assertEqual(status, "confirmed")
        self.assertEqual(reason, "")

    def test_classify_verification_status_marks_conflicts_for_review(self) -> None:
        status, reason = classify_verification_status("約", 0.95, "约")
        self.assertEqual(status, "needs_review")
        self.assertIn("secondary_mismatch", reason)

    def test_classify_verification_status_rejects_wrong_secondary_result(self) -> None:
        status, reason = classify_verification_status("約", 0.61, "書")
        self.assertEqual(status, "rejected")
        self.assertIn("secondary_non_target", reason)


class AssignOccurrenceIndexesTests(unittest.TestCase):
    def test_assign_occurrence_indexes_orders_by_file_page_and_bbox(self) -> None:
        items = [
            {
                "document_id": "doc-b",
                "file_path": "b.pdf",
                "page_number": 1,
                "source_y0": 40.0,
                "source_x0": 20.0,
            },
            {
                "document_id": "doc-a",
                "file_path": "a.pdf",
                "page_number": 2,
                "source_y0": 10.0,
                "source_x0": 10.0,
            },
            {
                "document_id": "doc-a",
                "file_path": "a.pdf",
                "page_number": 2,
                "source_y0": 12.0,
                "source_x0": 5.0,
            },
        ]
        assign_occurrence_indexes(items)
        self.assertEqual([item["global_occurrence_index"] for item in items], [3, 1, 2])
        self.assertEqual(items[1]["document_occurrence_index"], 1)
        self.assertEqual(items[2]["document_occurrence_index"], 2)
        self.assertEqual(items[1]["page_occurrence_index"], 1)
        self.assertEqual(items[2]["page_occurrence_index"], 2)


class CheckpointRoundtripTests(unittest.TestCase):
    def test_checkpoint_roundtrip_preserves_next_page_and_payloads(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            pipeline = ReportPipeline(
                root_dir=root,
                output_html=root / "out.html",
                workspace_dir=Path(tmp) / "work",
                page_limit=1,
                document_limit=1,
            )
            try:
                doc = DocumentRecord(
                    document_id="doc-1",
                    file_path=root / "a.djvu",
                    relative_path="a.djvu",
                    file_type="DJVU",
                    file_size_bytes=123,
                    file_hash_sha256="abc",
                    modified_time=1.0,
                    page_count=10,
                )
                pages = [{"page_image_id": "p1"}]
                occurrences = [{"occurrence_id": "o1"}]
                failures = [{"failure_id": "f1"}]
                pipeline._save_checkpoint(doc, 4, pages, occurrences, failures)
                restored = pipeline._load_checkpoint(doc)
                self.assertIsNotNone(restored)
                self.assertEqual(restored["next_page_index"], 4)
                self.assertEqual(restored["pages"], pages)
                self.assertEqual(restored["occurrences"], occurrences)
                self.assertEqual(restored["failures"], failures)
            finally:
                pipeline.close()


class PageRangeCheckpointTests(unittest.TestCase):
    def test_page_range_honors_checkpoint_and_cli_bounds(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "worker_06a"
            pipeline = ReportPipeline(
                root_dir=root,
                output_html=root / "out.html",
                workspace_dir=workspace,
                include_paths={str(root / "sample.pdf")},
                start_page_index=200,
                end_page_index_exclusive=260,
            )
            try:
                doc = DocumentRecord(
                    document_id="doc-1",
                    file_path=root / "sample.pdf",
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

    def test_page_range_uses_cli_start_when_checkpoint_is_behind(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp) / "root"
            root.mkdir()
            workspace = Path(tmp) / "worker_06b"
            pipeline = ReportPipeline(
                root_dir=root,
                output_html=root / "out.html",
                workspace_dir=workspace,
                start_page_index=300,
                end_page_index_exclusive=360,
            )
            try:
                doc = DocumentRecord(
                    document_id="doc-1",
                    file_path=root / "sample.pdf",
                    relative_path="sample.pdf",
                    file_type="PDF",
                    file_size_bytes=8,
                    file_hash_sha256="abc",
                    modified_time=0.0,
                    page_count=500,
                )
                pipeline._save_checkpoint(doc, 280, [], [], [])
                start, stop = pipeline._page_range_for_document(doc)
                self.assertEqual((start, stop), (300, 360))
            finally:
                pipeline.close()


class DiscoverWorkerReportsTests(unittest.TestCase):
    def test_discover_worker_report_paths_returns_sorted_existing_reports(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            (root / "worker_02" / "run").mkdir(parents=True)
            (root / "worker_01" / "run").mkdir(parents=True)
            (root / "worker_03" / "run").mkdir(parents=True)
            (root / "worker_02" / "run" / "report.json").write_text("{}", encoding="utf-8")
            (root / "worker_01" / "run" / "report.json").write_text("{}", encoding="utf-8")
            paths = discover_worker_report_paths(root)
            self.assertEqual(
                paths,
                [
                    root / "worker_01" / "run" / "report.json",
                    root / "worker_02" / "run" / "report.json",
                ],
            )


if __name__ == "__main__":
    unittest.main()
