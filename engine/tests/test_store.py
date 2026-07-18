"""TaskStore 持久化与查询测试。"""

from __future__ import annotations

import gc
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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

    def test_task_review_preferences_roundtrip(self) -> None:
        task_id = self.store.create_task(
            review_image_quality="high",
            context_direction="ttb",
            context_radius=32,
        )
        task = self.store.get_task(task_id)
        assert task is not None
        self.assertEqual(
            task["review_preferences"],
            {"page_quality": "maximum", "context_direction": "ttb", "context_radius": 32},
        )

    def test_task_list_supports_search_status_and_total_count(self) -> None:
        first = self.store.create_task(source_dir=r"C:\档案\县志", name="县志检索", search_terms=["契约"], search_mode="exact_literal")
        second = self.store.create_task(source_dir=r"C:\档案\报纸", name="报纸检索", search_terms=["新闻"], search_mode="exact_literal")
        self.store.update_task(first, status="completed")
        self.store.update_task(second, status="running")

        self.assertEqual([task["task_id"] for task in self.store.list_tasks(query="县志")], [first])
        self.assertEqual([task["task_id"] for task in self.store.list_tasks(query="新闻")], [second])
        self.assertEqual(self.store.count_tasks(status="completed"), 1)
        self.assertEqual(self.store.count_tasks(query="档案"), 2)

    def test_file_sources_are_persisted_and_searchable(self) -> None:
        task_id = self.store.create_task(
            source_kind="files",
            source_label="2 个已选文件",
            source_files=[
                {"source_id": "source-a", "file_path": r"C:\甲\同名.pdf", "display_path": "甲/同名.pdf"},
                {"source_id": "source-b", "file_path": r"D:\乙\同名.pdf", "display_path": "乙/同名.pdf"},
            ],
            search_terms=["档案"],
            search_mode="exact_literal",
        )
        task = self.store.get_task(task_id)
        assert task is not None
        self.assertEqual(task["source_kind"], "files")
        self.assertEqual(task["source_label"], "2 个已选文件")
        self.assertEqual(task["source_files"], [r"C:\甲\同名.pdf", r"D:\乙\同名.pdf"])
        self.assertEqual([row["source_id"] for row in self.store.list_task_sources(task_id)], ["source-a", "source-b"])
        self.assertEqual([row["task_id"] for row in self.store.list_tasks(query="乙/同名")], [task_id])

    def test_export_snapshot_streams_in_permanent_sequence_order(self) -> None:
        task_id = self.store.create_task(
            source_kind="files",
            source_files=[
                {"source_id": "source-z", "file_path": r"C:\甲\z.pdf", "display_path": "z.pdf"},
                {"source_id": "source-a", "file_path": r"D:\乙\a.pdf", "display_path": "a.pdf"},
            ],
            search_terms=["档案"],
            search_mode="exact_literal",
        )
        self.store.add_occurrences(task_id, [
            {"occurrence_id": "occ-a", "source_id": "source-a", "file_name": "a.pdf", "relative_path": "a.pdf", "page_number": 1, "page_occurrence_index": 1, "matched_text": "档案", "bbox_hash": "bbox-a"},
            {"occurrence_id": "occ-z", "source_id": "source-z", "file_name": "z.pdf", "relative_path": "z.pdf", "page_number": 1, "page_occurrence_index": 1, "matched_text": "档案", "bbox_hash": "bbox-z"},
        ])

        with self.store.occurrence_export_snapshot(task_id, batch_size=1) as (total, page_count, rows):
            self.store.add_occurrences(task_id, [
                {"occurrence_id": "occ-late", "source_id": "source-z", "file_name": "z.pdf", "relative_path": "z.pdf", "page_number": 2, "page_occurrence_index": 1, "matched_text": "档案", "bbox_hash": "bbox-late"},
            ])
            snapshot_rows = list(rows)

        self.assertEqual((total, page_count), (2, 2))
        self.assertEqual([row["source_id"] for row in snapshot_rows], ["source-a", "source-z"])
        self.assertEqual([row["source_ordinal"] for row in snapshot_rows], [1, 0])
        self.assertEqual([row["global_sequence"] for row in snapshot_rows], [1, 2])
        self.assertEqual(self.store.query_occurrences(task_id=task_id)[0], 3)

    def test_task_failures_and_export_history_roundtrip(self) -> None:
        task_id = self.store.create_task()
        self.store.replace_task_failures(
            task_id,
            [{
                "failure_id": "failure-1",
                "file_path": r"C:\档案\破损.pdf",
                "page_number": 12,
                "stage": "page_process",
                "error_type": "DecodeError",
                "error_message": "页面无法解码",
                "possible_missed_hits": True,
            }],
        )
        failures = self.store.list_task_failures(task_id)
        self.assertEqual(len(failures), 1)
        self.assertEqual(failures[0]["page_number"], 12)
        self.assertEqual(failures[0]["error_message"], "页面无法解码")

        self.store.add_export(task_id=task_id, kind="json", path=r"C:\exports\first.json")
        self.store.add_export(task_id=task_id, kind="html", path=r"C:\exports\second.html")
        exports = self.store.list_exports(task_id=task_id)
        self.assertEqual([item["kind"] for item in exports], ["html", "json"])

    def test_create_task_persists_single_exact_literal_search_term(self) -> None:
        tid = self.store.create_task(search_terms=["档案"], search_mode="exact_literal")
        task = self.store.get_task(tid)
        assert task is not None
        self.assertEqual(task["search_terms"], ["档案"])
        self.assertEqual(task["search_text"], "档案")
        self.assertEqual(task["search_mode"], "exact_literal")
        with self.assertRaisesRegex(ValueError, "immutable"):
            self.store.update_task(tid, search_terms_json='["其他"]')

    def test_create_task_with_event_is_one_transaction(self) -> None:
        task_id, event = self.store.create_task_with_event(
            source_dir="X",
            search_terms=["档案"],
            search_mode="exact_literal",
            event_type="task.created",
            event_payload={"search_text": "档案"},
        )
        task = self.store.get_task(task_id)
        assert task is not None
        self.assertEqual(task["last_event_sequence"], 1)
        self.assertEqual(event["sequence"], 1)
        self.assertEqual([row["event_type"] for row in self.store.list_task_events(task_id)], ["task.created"])

    def test_create_task_with_event_rolls_back_when_event_insert_fails(self) -> None:
        self.store.conn.execute(
            "CREATE TRIGGER fail_task_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(FAIL, 'injected event failure'); END"
        )
        self.store.conn.commit()
        with self.assertRaisesRegex(Exception, "injected event failure"):
            self.store.create_task_with_event(event_type="task.created", event_payload={})
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0], 0)

    def test_create_task_with_event_rolls_back_when_sequence_update_fails(self) -> None:
        self.store.conn.execute(
            "CREATE TRIGGER fail_sequence BEFORE UPDATE OF last_event_sequence ON tasks BEGIN SELECT RAISE(FAIL, 'injected sequence failure'); END"
        )
        self.store.conn.commit()
        with self.assertRaisesRegex(Exception, "injected sequence failure"):
            self.store.create_task_with_event(event_type="task.created", event_payload={})
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0], 0)

    def test_duplicate_generated_task_id_rolls_back_second_create(self) -> None:
        with mock.patch("archivelens_engine.db.store.new_id", return_value="task-fixed"):
            self.store.create_task_with_event(event_type="task.created", event_payload={})
            with self.assertRaises(Exception):
                self.store.create_task_with_event(event_type="task.created", event_payload={})
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 1)
        self.assertEqual(self.store.conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0], 1)

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
