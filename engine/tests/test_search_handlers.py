"""任务内简繁检索 IPC handler 契约。"""

from __future__ import annotations

import os
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from archivelens_engine.db.store import OCR_INDEX_LEGACY_REQUIRES_REOCR
from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.script_variants import ScriptVariantResolver
from archivelens_engine.server import (
    Server,
    _h_search_corpus_status,
    _h_search_execute,
    _h_search_hits,
    _h_search_prepare_page_image,
    _h_search_sessions,
)


class SearchHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        with mock.patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}):
            self.server = Server(
                workspace_root=self.temporary_directory.name,
            )
        self.resolver = ScriptVariantResolver()
        self.task_id = self.server.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir=str(
                Path(self.temporary_directory.name) / "tasks" / "task" / "scan"
            ),
            name="search-handler",
        )
        forms = self.resolver.forms("虧空")
        self.server.store.record_page_completion(
            task_id=self.task_id,
            source_id="sample.pdf",
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page={
                "document_id": "doc-1",
                "page_no": 1,
                "page_index": 0,
                "source_page_width": 1000,
                "source_page_height": 1400,
                "model": {
                    "id": "PP-OCRv6-small",
                    "source_version": "RapidOCR-3.9.1",
                    "sha256": "a" * 64,
                },
                "lines": [
                    {
                        "line_index": 0,
                        "raw_text": "虧空",
                        "resolved_text": "虧空",
                        "confidence": 0.95,
                        "bbox": [[100, 200], [300, 200], [300, 260], [100, 260]],
                        "word_boxes": [
                            [[100, 200], [200, 200], [200, 260], [100, 260]],
                            [[200, 200], [300, 200], [300, 260], [200, 260]],
                        ],
                        "search_forms": {
                            "simplified": forms.simplified,
                            "traditional": forms.traditional,
                            "taiwan": forms.taiwan,
                            "hong_kong": forms.hong_kong,
                        },
                    }
                ],
            },
        )
        self.server.store.finalize_ocr_corpus(
            self.task_id,
            expected_pages=1,
            failure_count=0,
        )

    def tearDown(self) -> None:
        self.server.store.close()
        self.temporary_directory.cleanup()

    def test_execute_history_hits_and_corpus_status_roundtrip(self) -> None:
        status = _h_search_corpus_status(
            self.server,
            {"task_id": self.task_id},
        )
        session = _h_search_execute(
            self.server,
            {
                "task_id": self.task_id,
                "query_text": "亏空",
                "script_scope": "both",
            },
        )
        history = _h_search_sessions(
            self.server,
            {"task_id": self.task_id},
        )
        results = _h_search_hits(
            self.server,
            {
                "task_id": self.task_id,
                "search_session_id": session["search_session_id"],
            },
        )

        self.assertEqual(status["status"], "ready")
        self.assertEqual(len(history["items"]), 1)
        self.assertEqual(results["total"], 1)
        hit = results["items"][0]
        self.assertEqual(hit["match_layer"], "variant_graph")
        self.assertEqual(hit["display_path"], "sample.pdf")
        self.assertEqual(hit["match_bbox"][0], [100.0, 200.0])
        self.assertAlmostEqual(hit["normalized_x0"], 0.1)
        self.assertAlmostEqual(hit["normalized_y1"], 260 / 1400)

    def test_prepare_page_image_uses_search_hit_without_exposing_source_path(self) -> None:
        session = _h_search_execute(
            self.server,
            {
                "task_id": self.task_id,
                "query_text": "亏空",
                "script_scope": "both",
            },
        )
        hit = _h_search_hits(
            self.server,
            {
                "task_id": self.task_id,
                "search_session_id": session["search_session_id"],
            },
        )["items"][0]
        expected = {
            "asset_relpath": "evidence/pages/page.png",
            "asset_version": "v1",
            "pixel_width": 1000,
            "pixel_height": 1400,
            "width_100_css": 1000,
            "height_100_css": 1400,
            "source_kind": "pdf",
            "fidelity": "verified_source",
            "overscale_warning": None,
        }
        self.server.page_evidence.prepare = mock.Mock(return_value=expected)

        result = _h_search_prepare_page_image(
            self.server,
            {
                "task_id": self.task_id,
                "search_hit_id": hit["search_hit_id"],
                "target_css_width": 800,
                "target_css_height": 1000,
                "device_pixel_ratio": 1,
            },
        )

        self.assertEqual(result, expected)
        occurrence = self.server.page_evidence.prepare.call_args.kwargs[
            "occurrence"
        ]
        self.assertEqual(occurrence["document_id"], "doc-1")
        self.assertEqual(occurrence["page_number"], 1)
        self.assertNotIn("file_path", occurrence)

    def test_hits_fail_closed_when_session_belongs_to_another_task(self) -> None:
        session = _h_search_execute(
            self.server,
            {
                "task_id": self.task_id,
                "query_text": "亏空",
                "script_scope": "both",
            },
        )
        other_task_id = self.server.store.create_task(
            source_dir="other",
            output_dir="Y",
            workspace_dir="Z",
            name="other",
        )

        with self.assertRaises(ProtocolError) as raised:
            _h_search_hits(
                self.server,
                {
                    "task_id": other_task_id,
                    "search_session_id": session["search_session_id"],
                },
            )

        self.assertEqual(raised.exception.code, ErrorCode.TASK_NOT_FOUND)

    def test_legacy_task_fails_closed_with_reocr_guidance(self) -> None:
        legacy_task_id = self.server.store.create_task(
            source_dir="legacy",
            output_dir="Y",
            workspace_dir="Z",
            name="legacy",
        )
        self.server.store.conn.execute(
            "UPDATE tasks SET ocr_index_status=? WHERE task_id=?",
            (OCR_INDEX_LEGACY_REQUIRES_REOCR, legacy_task_id),
        )
        self.server.store.conn.commit()

        with self.assertRaises(ProtocolError) as raised:
            _h_search_execute(
                self.server,
                {
                    "task_id": legacy_task_id,
                    "query_text": "亏空",
                    "script_scope": "both",
                },
            )

        self.assertEqual(
            raised.exception.code,
            ErrorCode.OCR_CORPUS_UNAVAILABLE,
        )
        self.assertTrue(raised.exception.details["requires_reocr"])


if __name__ == "__main__":
    unittest.main()
