from __future__ import annotations

import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from archivelens_engine.layout_context import build_occurrence_layout_context
from archivelens_engine.server import Server


class LayoutContextHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.server = Server(workspace_root=self.temporary_directory.name)
        self.task_id = self.server.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir=str(Path(self.temporary_directory.name) / "tasks" / "layout"),
            name="layout-context",
            layout_mode="auto",
        )
        self.source_id = "source-layout"
        top_lines = [
            ("塋地已令查明給還其因獲罪草進之世職亦", [[166, 103], [190, 103], [195, 361], [171, 362]]),
            ("至其虧空錢粮已令該部查奏寬免其入官之墳", [[193, 105], [216, 105], [216, 360], [194, 360]]),
            ("即位以來軫念伊等生計艱難頻頒賞賚優卹備", [[217, 105], [239, 105], [240, 360], [219, 361]]),
        ]
        bottom_lines = [
            ("廉以贍給家口倘伊等不知痛改前非仍為覆轍", [[171, 411], [191, 411], [195, 664], [175, 664]]),
            ("權用外任上為國家効力辯公下亦可得俸祿養", [[194, 409], [216, 409], [219, 666], [198, 666]]),
            ("裕可免窘乏之虞況旗負內之老成護慎者可望", [[217, 409], [239, 409], [244, 665], [222, 665]]),
        ]
        lines = []
        for line_index, (text, bbox) in enumerate([*top_lines, *bottom_lines]):
            lines.append(
                {
                    "line_index": line_index,
                    "raw_text": text,
                    "resolved_text": text,
                    "confidence": 0.95,
                    "bbox": bbox,
                    "search_forms": {
                        "simplified": text,
                        "traditional": text,
                        "taiwan": text,
                        "hong_kong": text,
                    },
                }
            )
        self.server.store.record_page_completion(
            task_id=self.task_id,
            source_id=self.source_id,
            page_no=1,
            worker_generation=1,
            occurrences=[
                {
                    "occurrence_id": "occ-layout",
                    "document_id": "doc-layout",
                    "source_id": self.source_id,
                    "file_name": "sample.pdf",
                    "relative_path": "sample.pdf",
                    "page_number": 1,
                    "page_index": 0,
                    "matched_text": "虧空",
                    "match_start": 2,
                    "match_end": 4,
                    "line_index": 1,
                    "bbox_hash": "bbox-layout",
                    "source_page_width": 608,
                    "source_page_height": 764,
                    "source_x0": 193,
                    "source_y0": 131.8,
                    "source_x1": 216,
                    "source_y1": 158.7,
                    "normalized_x0": 193 / 608,
                    "normalized_y0": 131.8 / 764,
                    "normalized_x1": 216 / 608,
                    "normalized_y1": 158.7 / 764,
                    "verification_status": "confirmed",
                    "context_full": "旧版错误上下文",
                }
            ],
            ocr_page={
                "document_id": "doc-layout",
                "page_no": 1,
                "page_index": 0,
                "source_page_width": 608,
                "source_page_height": 764,
                "model": {
                    "id": "PP-OCRv6-small",
                    "source_version": "RapidOCR-3.9.1",
                    "sha256": "a" * 64,
                },
                "lines": lines,
            },
        )

    def tearDown(self) -> None:
        self.server.store.close()
        self.temporary_directory.cleanup()

    def test_old_occurrence_rebuilds_from_saved_ocr_without_losing_review(self) -> None:
        self.server.handlers["review.updateDecision"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout", "decision": "confirmed"},
        )
        self.server.handlers["review.updateNote"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout", "note": "人工已核"},
        )

        result = self.server.handlers["review.layoutContext"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout"},
        )

        context = result["context"]
        self.assertEqual(context["status"], "ready")
        self.assertEqual(context["orientation"], "vertical")
        self.assertEqual([item["line_index"] for item in context["items"]], [2, 1, 0])
        self.assertEqual(context["items"][1]["text"][2:4], "虧空")
        self.assertNotIn("權用外任", context["plain_text"])
        detail = self.server.handlers["results.getDetail"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout"},
        )
        self.assertEqual(detail["review_decision"], "confirmed")
        self.assertEqual(detail["review_note"], "人工已核")
        self.assertEqual(detail["global_sequence"], 1)
        self.assertEqual(detail["context_full"], context["plain_text"])
        self.assertEqual(detail["layout_context"]["target_ocr_line_id"], detail["ocr_line_id"])

        rebuilt = self.server.handlers["review.rebuildLayoutContexts"](
            self.server,
            {"task_id": self.task_id, "limit": 25},
        )
        self.assertEqual(rebuilt["batch_processed"], 0)
        self.assertEqual(rebuilt["remaining"], 0)

    def test_page_block_override_previews_then_persists_for_only_that_page(self) -> None:
        params = {
            "task_id": self.task_id,
            "occurrence_id": "occ-layout",
            "layout_mode": "vertical",
            "normalized_block_bbox": {
                "x0": 0.25,
                "y0": 0.1,
                "x1": 0.42,
                "y1": 0.49,
            },
        }
        preview = self.server.handlers["review.previewLayoutContext"](self.server, params)
        self.assertFalse(preview["context"]["has_page_override"])
        self.assertEqual([item["line_index"] for item in preview["context"]["items"]], [2, 1, 0])

        saved = self.server.handlers["review.updateLayoutOverride"](self.server, params)
        self.assertTrue(saved["context"]["has_page_override"])
        self.assertEqual(saved["progress"]["remaining"], 0)
        override = self.server.store.get_page_layout_override(
            task_id=self.task_id,
            source_id=self.source_id,
            page_no=1,
        )
        self.assertIsNotNone(override)
        assert override is not None
        self.assertEqual(override["layout_mode"], "vertical")

    def test_task_delete_removes_page_layout_overrides(self) -> None:
        self.server.store.upsert_page_layout_override(
            task_id=self.task_id,
            source_id=self.source_id,
            page_no=1,
            layout_mode="vertical",
            block_bbox=None,
        )
        self.assertIsNotNone(self.server.store.get_page_layout_override(
            task_id=self.task_id,
            source_id=self.source_id,
            page_no=1,
        ))

        self.assertTrue(self.server.store.delete_task(self.task_id))

        remaining = self.server.store.conn.execute(
            "SELECT COUNT(*) FROM layout_context_page_overrides WHERE task_id=?",
            (self.task_id,),
        ).fetchone()[0]
        self.assertEqual(remaining, 0)

    def test_concurrent_override_change_cannot_persist_stale_layout_context(self) -> None:
        self.server.store.upsert_page_layout_override(
            task_id=self.task_id,
            source_id=self.source_id,
            page_no=1,
            layout_mode="vertical",
            block_bbox=None,
        )
        calls = 0

        def build_with_racing_override(*args, **kwargs):
            nonlocal calls
            calls += 1
            if calls == 1:
                self.server.store.upsert_page_layout_override(
                    task_id=self.task_id,
                    source_id=self.source_id,
                    page_no=1,
                    layout_mode="horizontal",
                    block_bbox=None,
                )
            return build_occurrence_layout_context(*args, **kwargs)

        with patch(
            "archivelens_engine.server.build_occurrence_layout_context",
            side_effect=build_with_racing_override,
        ):
            result = self.server.handlers["review.layoutContext"](
                self.server,
                {"task_id": self.task_id, "occurrence_id": "occ-layout"},
            )

        self.assertEqual(calls, 2)
        self.assertEqual(result["context"]["effective_layout_mode"], "horizontal")
        detail = self.server.handlers["results.getDetail"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout"},
        )
        self.assertEqual(detail["layout_context_status"], "ready")
        self.assertEqual(detail["layout_context"]["effective_layout_mode"], "horizontal")

    def test_missing_ocr_uses_schema_valid_target_only_fallback_without_overwriting_legacy_context(self) -> None:
        self.server.store.add_occurrences(
            self.task_id,
            [{
                "occurrence_id": "occ-layout-fallback",
                "document_id": "doc-layout",
                "source_id": self.source_id,
                "file_name": "sample.pdf",
                "relative_path": "sample.pdf",
                "page_number": 2,
                "page_index": 1,
                "matched_text": "虧空",
                "bbox_hash": "bbox-layout-fallback",
                "context_full": "旧任务保留的上下文证据",
            }],
        )

        result = self.server.handlers["review.layoutContext"](
            self.server,
            {"task_id": self.task_id, "occurrence_id": "occ-layout-fallback"},
        )

        context = result["context"]
        self.assertEqual(context["status"], "uncertain")
        self.assertEqual(context["reason"], "ocr_evidence_missing")
        self.assertEqual(len(context["items"]), 1)
        self.assertGreater(context["normalized_bbox"]["x1"], context["normalized_bbox"]["x0"])
        self.assertGreater(context["normalized_bbox"]["y1"], context["normalized_bbox"]["y0"])
        detail = self.server.store.get_occurrence_detail(self.task_id, "occ-layout-fallback")
        assert detail is not None
        self.assertEqual(detail["context_full"], "旧任务保留的上下文证据")


if __name__ == "__main__":
    unittest.main()
