"""恢复 handler 测试：resume / inspect 使用真实持久化状态。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from PIL import Image

from archivelens_engine.server import Server, _h_tasks_create, _h_tasks_resume, _h_tasks_start
from archivelens_engine.protocol import ProtocolError


class RecoveryHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.src = Path(self.tmp) / "src"
        self.src.mkdir()
        image = Image.new("RGB", (8, 8), color="white")
        try:
            image.save(self.src / "page.png")
        finally:
            image.close()
        self.server = Server(workspace_root=self.tmp)

    def tearDown(self) -> None:
        try:
            self.server.store.close()
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_resume_without_live_task_control_starts_new_scan_thread(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="paused")
        self.server.store.record_page_completion(
            task_id=task_id,
            source_id="source-main",
            page_no=3,
            worker_generation=1,
            occurrences=[
                {
                    "occurrence_id": "occ-3",
                    "document_id": "source-main",
                    "source_id": "source-main",
                    "file_name": "slowfake.pdf",
                    "relative_path": "slowfake.pdf",
                    "page_number": 3,
                    "page_index": 2,
                    "page_occurrence_index": 1,
                    "matched_character": "约",
                    "character_variant": "simplified",
                    "bbox_hash": "bbox-3",
                    "verification_status": "confirmed",
                    "context_full": "page-3",
                }
            ],
        )

        with patch.object(self.server, "start_scan_thread") as start_scan_thread:
            result = _h_tasks_resume(self.server, {"task_id": task_id})

        self.assertEqual(result["status"], "running")
        start_scan_thread.assert_called_once()

    def test_repeated_resume_does_not_start_two_scan_threads(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="paused")
        with patch.object(self.server, "start_scan_thread") as start_scan_thread:
            _h_tasks_resume(self.server, {"task_id": task_id})
            with self.assertRaises(ProtocolError):
                _h_tasks_resume(self.server, {"task_id": task_id})
        start_scan_thread.assert_called_once()

    def test_recoverable_task_can_resume_without_live_control(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="recoverable")

        with patch.object(self.server, "start_scan_thread") as start_scan_thread:
            result = _h_tasks_resume(self.server, {"task_id": task_id})

        self.assertEqual(result["status"], "running")
        start_scan_thread.assert_called_once()

    def test_non_resumable_tasks_cannot_resume_directly(self) -> None:
        for status in ("pausing", "failed", "stale"):
            with self.subTest(status=status):
                created = _h_tasks_create(
                    self.server,
                    {"source_dir": str(self.src), "search_text": "档案"},
                )
                task_id = created["task_id"]
                self.server.store.update_task(task_id, status=status)

                with patch.object(self.server, "start_scan_thread") as start_scan_thread:
                    with self.assertRaises(ProtocolError) as raised:
                        _h_tasks_resume(self.server, {"task_id": task_id})

                self.assertEqual(raised.exception.code, "TASK_STATE_CONFLICT")
                self.assertEqual(raised.exception.details["current"], status)
                self.assertEqual(self.server.store.get_task(task_id)["status"], status)
                start_scan_thread.assert_not_called()

    def test_legacy_task_requiring_review_cannot_resume_automatically(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(
            task_id,
            status="recoverable",
            error_code="LEGACY_TASK_REQUIRES_REVIEW",
        )

        with patch.object(self.server, "start_scan_thread") as start_scan_thread:
            with self.assertRaises(ProtocolError) as raised:
                _h_tasks_resume(self.server, {"task_id": task_id})

        self.assertEqual(raised.exception.code, "TASK_STATE_CONFLICT")
        start_scan_thread.assert_not_called()

    def test_inspect_state_returns_persisted_checkpoint_processed_pages_and_events(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.append_task_event(
            task_id=task_id,
            event_type="task.started",
            payload={"worker_generation": 1},
            source_id="source-main",
            worker_generation=1,
        )
        self.server.store.record_page_completion(
            task_id=task_id,
            source_id="source-main",
            page_no=1,
            worker_generation=1,
            occurrences=[
                {
                    "occurrence_id": "occ-1",
                    "document_id": "source-main",
                    "source_id": "source-main",
                    "file_name": "slowfake.pdf",
                    "relative_path": "slowfake.pdf",
                    "page_number": 1,
                    "page_index": 0,
                    "page_occurrence_index": 1,
                    "matched_character": "约",
                    "character_variant": "simplified",
                    "bbox_hash": "bbox-1",
                    "verification_status": "confirmed",
                    "context_full": "page-1",
                }
            ],
        )

        state = self.server.handlers["tasks.inspectState"](self.server, {"task_id": task_id})

        self.assertEqual(state["processed_page_ids"], [1])
        self.assertEqual(state["checkpoint"]["last_completed_page"], 1)
        self.assertEqual(state["checkpoint"]["next_page"], 2)
        self.assertEqual([event["sequence"] for event in state["events"]], [1, 2, 3])
        self.assertEqual([event["event_type"] for event in state["events"]], ["task.created", "task.started", "task.progress"])
        self.assertEqual(len(state["occurrence_ids"]), 1)

    def test_inspect_state_derives_real_source_id_without_explicit_param(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        source_id = "long-real-ocr.pdf"
        self.server.store.record_page_completion(
            task_id=task_id,
            source_id=source_id,
            page_no=1,
            worker_generation=2,
            occurrences=[
                {
                    "occurrence_id": "occ-real-1",
                    "document_id": source_id,
                    "source_id": source_id,
                    "file_name": source_id,
                    "relative_path": source_id,
                    "page_number": 1,
                    "page_index": 0,
                    "page_occurrence_index": 1,
                    "matched_character": "约",
                    "character_variant": "simplified",
                    "bbox_hash": "bbox-real-1",
                    "verification_status": "confirmed",
                    "context_full": "page-1",
                }
            ],
        )

        state = self.server.handlers["tasks.inspectState"](self.server, {"task_id": task_id})

        self.assertEqual(state["source_id"], source_id)
        self.assertEqual(state["processed_page_ids"], [1])
        self.assertIsNotNone(state["checkpoint"])
        self.assertEqual(state["checkpoint"]["source_id"], source_id)

    def test_real_page_completion_duplicate_is_a_server_noop(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="running")
        document = SimpleNamespace(document_id="real-doc.pdf", relative_path="real-doc.pdf", page_count=1)
        page_occurrence = self.server._build_slowfake_occurrence(task_id, 1)
        page_occurrence["occurrence_id"] = "occ-real-1"
        page_occurrence["source_id"] = "real-doc.pdf"
        page_occurrence["relative_path"] = "real-doc.pdf"
        page_occurrence["file_name"] = "real-doc.pdf"

        for _ in range(2):
            self.server._persist_real_page_completion(
                task_id=task_id,
                scan_workspace=Path(self.tmp),
                tc=SimpleNamespace(is_paused=lambda: False),
                worker_generation=1,
                document=document,
                page_index=0,
                page_payload=None,
                page_occurrences=[page_occurrence],
            )

        state = self.server.handlers["tasks.inspectState"](self.server, {"task_id": task_id})
        self.assertEqual(state["processed_page_ids"], [1])
        self.assertEqual(len(state["occurrence_ids"]), 1)
        self.assertEqual([event["event_type"] for event in state["events"]], ["task.created", "task.progress"])

    def test_real_scan_path_persists_processed_pages_checkpoint_and_progress_events(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="running")
        self.server.store.update_task(task_id, started_at="2026-07-09T00:00:00+00:00")
        worker_generation = self.server.store.allocate_worker_generation(task_id)
        self.server.emit_task_event(
            "task.started",
            task_id,
            {"worker_generation": worker_generation},
            worker_generation=worker_generation,
        )

        class FakeReportPipeline:
            def __init__(self, *args, workspace_dir: Path, output_html: Path, **kwargs) -> None:
                self.workspace_dir = workspace_dir
                self.output_html = output_html
                self.on_page_completed = kwargs.get("on_page_completed")

            def run(self) -> dict:
                pages_dir = self.workspace_dir / "pages"
                crops_dir = self.workspace_dir / "crops"
                pages_dir.mkdir(parents=True, exist_ok=True)
                crops_dir.mkdir(parents=True, exist_ok=True)
                doc = SimpleNamespace(document_id="real-doc.pdf", relative_path="real-doc.pdf", page_count=2)
                for page_no, matched_character in ((1, "约"), (2, "約")):
                    page_path = pages_dir / f"p{page_no}.png"
                    crop_path = crops_dir / f"c{page_no}.png"
                    page_path.write_bytes(b"page")
                    crop_path.write_bytes(b"crop")
                    if callable(self.on_page_completed):
                        self.on_page_completed(
                            document=doc,
                            page_index=page_no - 1,
                            page_payload={
                                "page_image_id": f"real-doc-p{page_no}",
                                "image_path": str(page_path),
                                "page_width": 1000,
                                "page_height": 1400,
                            },
                            page_occurrences=[
                                {
                                    "occurrence_id": f"occ-real-{page_no}",
                                    "document_id": "real-doc.pdf",
                                    "source_id": "real-doc.pdf",
                                    "file_name": "real-doc.pdf",
                                    "relative_path": "real-doc.pdf",
                                    "page_number": page_no,
                                    "page_index": page_no - 1,
                                    "page_occurrence_index": 1,
                                    "matched_character": matched_character,
                                    "character_variant": "simplified" if matched_character == "约" else "traditional",
                                    "bbox_hash": f"bbox-real-{page_no}",
                                    "verification_status": "confirmed",
                                    "context_full": f"page-{page_no}-{matched_character}",
                                    "crop_image_path": str(crop_path),
                                }
                            ],
                            ocr_page={
                                "document_id": "real-doc.pdf",
                                "page_no": page_no,
                                "page_index": page_no - 1,
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
                                        "raw_text": matched_character,
                                        "resolved_text": matched_character,
                                        "confidence": 0.99,
                                        "bbox": [[10, 10], [20, 10], [20, 20], [10, 20]],
                                        "search_forms": {
                                            "simplified": "约",
                                            "traditional": "約",
                                            "taiwan": "約",
                                            "hong_kong": "約",
                                        },
                                    }
                                ],
                            },
                        )
                self.output_html.parent.mkdir(parents=True, exist_ok=True)
                self.output_html.write_text("<html>ok</html>", encoding="utf-8")
                return {"stats": {"document_total_pages": 2}, "pages": [], "occurrences": []}

            def close(self) -> None:
                return None

        with patch("archivelens_engine.report_pipeline.ReportPipeline", FakeReportPipeline):
            self.server._run_scan(task_id, worker_generation)

        state = self.server.handlers["tasks.inspectState"](self.server, {"task_id": task_id})
        self.assertEqual(state["source_id"], "real-doc.pdf")
        self.assertEqual(state["processed_page_ids"], [1, 2])
        self.assertIsNotNone(state["checkpoint"])
        self.assertEqual(state["checkpoint"]["last_completed_page"], 2)
        self.assertEqual(state["checkpoint"]["next_page"], 3)
        self.assertEqual(
            [event["event_type"] for event in state["events"]],
            ["task.created", "task.started", "task.progress", "task.progress", "task.completed"],
        )
        self.assertEqual(len(state["occurrence_ids"]), 2)
        corpus_status = self.server.store.get_ocr_corpus_status(task_id)
        self.assertEqual(corpus_status["status"], "ready")
        self.assertEqual(corpus_status["indexed_pages"], 2)
        self.assertEqual(corpus_status["line_count"], 2)

    def test_real_scan_path_backfills_bbox_hash_for_report_occurrences(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src), "search_text": "档案"})
        task_id = created["task_id"]
        self.server.store.update_task(task_id, status="running")
        worker_generation = self.server.store.allocate_worker_generation(task_id)
        self.server.emit_task_event(
            "task.started",
            task_id,
            {"worker_generation": worker_generation},
            worker_generation=worker_generation,
        )

        class FakeReportPipeline:
            def __init__(self, *args, workspace_dir: Path, output_html: Path, **kwargs) -> None:
                self.workspace_dir = workspace_dir
                self.output_html = output_html
                self.on_page_completed = kwargs.get("on_page_completed")

            def run(self) -> dict:
                pages_dir = self.workspace_dir / "pages"
                crops_dir = self.workspace_dir / "crops"
                pages_dir.mkdir(parents=True, exist_ok=True)
                crops_dir.mkdir(parents=True, exist_ok=True)
                page_path = pages_dir / "p1.png"
                crop_path = crops_dir / "c1.png"
                page_path.write_bytes(b"page")
                crop_path.write_bytes(b"crop")
                if callable(self.on_page_completed):
                    self.on_page_completed(
                        document=SimpleNamespace(document_id="real-doc.pdf", relative_path="real-doc.pdf", page_count=1),
                        page_index=0,
                        page_payload={
                            "page_image_id": "real-doc-p1",
                            "image_path": str(page_path),
                            "page_width": 1000,
                            "page_height": 1400,
                        },
                        page_occurrences=[
                            {
                                "occurrence_id": "occ-real-1",
                                "document_id": "real-doc.pdf",
                                "source_id": "real-doc.pdf",
                                "file_name": "real-doc.pdf",
                                "relative_path": "real-doc.pdf",
                                "page_number": 1,
                                "page_index": 0,
                                "page_occurrence_index": 1,
                                "matched_character": "约",
                                "character_variant": "simplified",
                                "verification_status": "confirmed",
                                "context_full": "page-1-约",
                                "source_x0": 10.0,
                                "source_y0": 20.0,
                                "source_x1": 30.0,
                                "source_y1": 40.0,
                                "normalized_x0": 0.01,
                                "normalized_y0": 0.02,
                                "normalized_x1": 0.03,
                                "normalized_y1": 0.04,
                                "crop_image_path": str(crop_path),
                            }
                        ],
                    )
                self.output_html.parent.mkdir(parents=True, exist_ok=True)
                self.output_html.write_text("<html>ok</html>", encoding="utf-8")
                return {"stats": {"document_total_pages": 1}, "pages": [], "occurrences": []}

            def close(self) -> None:
                return None

        with patch("archivelens_engine.report_pipeline.ReportPipeline", FakeReportPipeline):
            self.server._run_scan(task_id, worker_generation)

        total, items = self.server.store.query_occurrences(task_id=task_id, limit=10, offset=0)
        self.assertEqual(total, 1)
        self.assertTrue(items[0]["bbox_hash"])


if __name__ == "__main__":
    unittest.main()
