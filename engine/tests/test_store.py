"""TaskStore 持久化与查询测试。"""

from __future__ import annotations

import gc
import shutil
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import TaskStore


class TaskStoreTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.store = TaskStore(Path(self.tmp) / "t.db")

    def tearDown(self) -> None:
        try:
            self.store.close()
        except Exception:
            pass
        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_create_get_list_update_roundtrip(self) -> None:
        tid = self.store.create_task(
            source_dir="X", output_dir="Y", workspace_dir="Z", name="n", file_count=3
        )
        task = self.store.get_task(tid)
        assert task is not None
        self.assertEqual(task["status"], "draft")
        self.assertEqual(task["file_count"], 3)
        self.store.update_task(tid, status="running", processed_pages=5)
        self.assertEqual(self.store.get_task(tid)["status"], "running")
        self.assertEqual(len(self.store.list_tasks()), 1)

    def test_create_task_persists_single_exact_literal_search_term(self) -> None:
        tid = self.store.create_task(search_terms=["档案"], search_mode="exact_literal")
        task = self.store.get_task(tid)
        assert task is not None
        self.assertEqual(task["search_terms"], ["档案"])
        self.assertEqual(task["search_text"], "档案")
        self.assertEqual(task["search_mode"], "exact_literal")
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.store.update_task(tid, search_terms_json='["其他"]')

    def test_occurrence_uses_matched_text_without_replacing_existing_review(self) -> None:
        tid = self.store.create_task(search_terms=["档案"], search_mode="exact_literal")
        occurrence = {
            "occurrence_id": "occ-first",
            "source_id": "source-1",
            "page_number": 1,
            "matched_text": "档案",
            "match_start": 0,
            "match_end": 2,
            "unicode_sequence": "U+6863 U+6848",
            "bbox_hash": "bbox-1",
        }
        self.store.add_occurrences(tid, [occurrence])
        self.store.upsert_review(task_id=tid, occurrence_id="occ-first", note="保留")
        duplicate = {**occurrence, "occurrence_id": "occ-second"}
        self.store.add_occurrences(tid, [duplicate])
        total, items = self.store.query_occurrences(task_id=tid)
        self.assertEqual(total, 1)
        self.assertEqual(items[0]["occurrence_id"], "occ-first")
        self.assertEqual(items[0]["review_note"], "保留")

    def test_occurrence_query_filter_and_review_join(self) -> None:
        tid = self.store.create_task()
        self.store.add_occurrences(
            tid,
            [
                {
                    "matched_character": "约",
                    "character_variant": "simplified",
                    "verification_status": "confirmed",
                    "context_full": "a约b",
                    "file_name": "f.pdf",
                    "page_number": 1,
                    "page_occurrence_index": 1,
                },
                {
                    "matched_character": "約",
                    "character_variant": "traditional",
                    "verification_status": "needs_review",
                    "context_full": "c約d",
                    "file_name": "f.pdf",
                    "page_number": 2,
                    "page_occurrence_index": 1,
                },
            ],
        )
        total, items = self.store.query_occurrences(task_id=tid, character="simplified")
        self.assertEqual(total, 1)
        self.assertEqual(items[0]["matched_character"], "约")
        self.store.upsert_review(
            task_id=tid, occurrence_id=items[0]["occurrence_id"], decision="rejected"
        )
        _, items2 = self.store.query_occurrences(task_id=tid, character="simplified")
        self.assertEqual(items2[0]["review_decision"], "rejected")

    def test_search_filter(self) -> None:
        tid = self.store.create_task()
        self.store.add_occurrences(
            tid,
            [
                {"context_full": "立約存档", "matched_character": "約", "page_number": 1, "page_occurrence_index": 1},
                {"context_full": "无关内容", "matched_character": "約", "page_number": 2, "page_occurrence_index": 1},
            ],
        )
        total, _ = self.store.query_occurrences(task_id=tid, search="存档")
        self.assertEqual(total, 1)

    def test_review_upsert_note_then_decision(self) -> None:
        tid = self.store.create_task()
        self.store.add_occurrences(tid, [{"matched_character": "约", "page_number": 1, "page_occurrence_index": 1}])
        _, items = self.store.query_occurrences(task_id=tid)
        occ_id = items[0]["occurrence_id"]
        self.store.upsert_review(task_id=tid, occurrence_id=occ_id, note="待复查")
        self.store.upsert_review(task_id=tid, occurrence_id=occ_id, decision="confirmed")
        detail = self.store.get_occurrence_detail(tid, occ_id)
        assert detail is not None
        self.assertEqual(detail["review_decision"], "confirmed")
        self.assertEqual(detail["review_note"], "待复查")


if __name__ == "__main__":
    unittest.main()
