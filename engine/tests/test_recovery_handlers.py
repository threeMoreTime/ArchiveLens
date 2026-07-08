"""恢复 handler 测试：resume / inspect 使用真实持久化状态。"""

from __future__ import annotations

import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from archivelens_engine.server import Server, _h_tasks_create, _h_tasks_resume, _h_tasks_start


class RecoveryHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.src = Path(self.tmp) / "src"
        self.src.mkdir()
        self.server = Server(workspace_root=self.tmp)

    def tearDown(self) -> None:
        try:
            self.server.store.close()
        except Exception:
            pass
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_resume_without_live_task_control_starts_new_scan_thread(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src)})
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

    def test_inspect_state_returns_persisted_checkpoint_processed_pages_and_events(self) -> None:
        created = _h_tasks_create(self.server, {"source_dir": str(self.src)})
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
        created = _h_tasks_create(self.server, {"source_dir": str(self.src)})
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


if __name__ == "__main__":
    unittest.main()
