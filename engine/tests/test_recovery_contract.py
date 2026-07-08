"""恢复证据模型测试：processed pages / checkpoint / event sequence / migration。"""

from __future__ import annotations

import gc
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import TaskStore


SOURCE_ID = "source-main"


def _occ(page_no: int, matched_character: str = "约") -> dict:
    return {
        "occurrence_id": f"occ-page-{page_no}",
        "document_id": SOURCE_ID,
        "source_id": SOURCE_ID,
        "file_name": "slowfake.pdf",
        "relative_path": "slowfake.pdf",
        "page_number": page_no,
        "page_index": page_no - 1,
        "page_occurrence_index": 1,
        "matched_character": matched_character,
        "character_variant": "simplified" if matched_character == "约" else "traditional",
        "bbox_hash": f"bbox-{page_no}-{matched_character}",
        "verification_status": "confirmed",
        "context_full": f"page-{page_no}-{matched_character}",
    }


class RecoveryContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "recovery.db"
        self.store = TaskStore(self.db_path)
        self.task_id = self.store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="recover")

    def tearDown(self) -> None:
        try:
            self.store.close()
        except Exception:
            pass
        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_processed_page_ids_are_unique_and_sorted(self) -> None:
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=2,
            worker_generation=1,
            occurrences=[_occ(2)],
        )
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[_occ(1)],
        )
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=2,
            worker_generation=1,
            occurrences=[_occ(2)],
        )

        self.assertEqual(
            self.store.list_processed_page_ids(self.task_id, SOURCE_ID),
            [1, 2],
        )

    def test_checkpoint_tracks_real_persisted_progress(self) -> None:
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=3,
            worker_generation=1,
            occurrences=[_occ(3)],
        )

        checkpoint = self.store.get_task_checkpoint(self.task_id, SOURCE_ID)
        assert checkpoint is not None
        self.assertEqual(checkpoint["last_completed_page"], 3)
        self.assertEqual(checkpoint["next_page"], 4)
        self.assertEqual(checkpoint["processed_page_ids"], [3])
        self.assertEqual(checkpoint["worker_generation"], 1)

    def test_checkpoint_does_not_advance_when_occurrence_write_fails(self) -> None:
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[_occ(1)],
        )

        bad = _occ(2)
        bad["matched_character"] = None
        with self.assertRaises(Exception):  # noqa: B017, PT011
            self.store.record_page_completion(
                task_id=self.task_id,
                source_id=SOURCE_ID,
                page_no=2,
                worker_generation=1,
                occurrences=[bad],
            )

        checkpoint = self.store.get_task_checkpoint(self.task_id, SOURCE_ID)
        assert checkpoint is not None
        self.assertEqual(checkpoint["last_completed_page"], 1)
        self.assertEqual(checkpoint["next_page"], 2)
        self.assertEqual(self.store.list_processed_page_ids(self.task_id, SOURCE_ID), [1])

    def test_event_sequence_is_persistent_and_monotonic_across_restart(self) -> None:
        self.store.append_task_event(
            task_id=self.task_id,
            event_type="task.started",
            payload={"worker_generation": 1},
            source_id=SOURCE_ID,
            worker_generation=1,
        )
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[_occ(1)],
        )
        first = self.store.list_task_events(self.task_id)
        self.assertEqual([event["sequence"] for event in first], [1, 2])

        self.store.close()
        self.store = TaskStore(self.db_path)
        self.store.append_task_event(
            task_id=self.task_id,
            event_type="task.resumed",
            payload={"worker_generation": 2},
            source_id=SOURCE_ID,
            worker_generation=2,
        )

        second = self.store.list_task_events(self.task_id)
        self.assertEqual([event["sequence"] for event in second], [1, 2, 3])
        self.assertEqual(second[-1]["event_type"], "task.resumed")

    def test_reconcile_incomplete_tasks_marks_running_as_recoverable(self) -> None:
        self.store.update_task(self.task_id, status="running")
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=4,
            worker_generation=2,
            occurrences=[_occ(4)],
        )

        changed = self.store.reconcile_incomplete_tasks(reason="ENGINE_PROCESS_EXITED")

        self.assertEqual(changed, 1)
        task = self.store.get_task(self.task_id)
        assert task is not None
        self.assertEqual(task["status"], "recoverable")
        self.assertEqual(task["error_code"], "ENGINE_PROCESS_EXITED")


class RecoveryMigrationTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.db_path = Path(self.tmp) / "legacy.db"
        conn = sqlite3.connect(self.db_path)
        conn.executescript(
            """
            CREATE TABLE tasks (
                task_id TEXT PRIMARY KEY,
                name TEXT NOT NULL DEFAULT '',
                source_dir TEXT NOT NULL DEFAULT '',
                output_dir TEXT NOT NULL DEFAULT '',
                workspace_dir TEXT NOT NULL DEFAULT '',
                status TEXT NOT NULL DEFAULT 'draft',
                is_demo INTEGER NOT NULL DEFAULT 0,
                file_count INTEGER NOT NULL DEFAULT 0,
                total_pages INTEGER NOT NULL DEFAULT 0,
                processed_pages INTEGER NOT NULL DEFAULT 0,
                occurrence_count INTEGER NOT NULL DEFAULT 0,
                failure_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL,
                started_at TEXT,
                updated_at TEXT,
                finished_at TEXT,
                error_code TEXT,
                error_message TEXT
            );
            CREATE TABLE occurrences (
                occurrence_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                document_id TEXT,
                file_path TEXT,
                relative_path TEXT,
                file_name TEXT,
                page_number INTEGER,
                page_index INTEGER,
                page_occurrence_index INTEGER,
                matched_character TEXT,
                character_variant TEXT,
                unicode_codepoint TEXT,
                context_before TEXT,
                context_after TEXT,
                context_full TEXT,
                ocr_confidence REAL,
                secondary_ocr_result TEXT,
                verification_status TEXT,
                location_method TEXT,
                source_page_width REAL,
                source_page_height REAL,
                source_x0 REAL, source_y0 REAL, source_x1 REAL, source_y1 REAL,
                normalized_x0 REAL, normalized_y0 REAL, normalized_x1 REAL, normalized_y1 REAL,
                page_image_relpath TEXT,
                crop_image_relpath TEXT,
                page_image_width INTEGER,
                page_image_height INTEGER
            );
            CREATE TABLE review_records (
                task_id TEXT NOT NULL,
                occurrence_id TEXT NOT NULL,
                decision TEXT,
                note TEXT NOT NULL DEFAULT '',
                reviewed_at TEXT,
                updated_at TEXT,
                PRIMARY KEY (task_id, occurrence_id)
            );
            CREATE TABLE exports (
                export_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                kind TEXT NOT NULL,
                path TEXT NOT NULL,
                created_at TEXT NOT NULL
            );
            CREATE TABLE schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            INSERT INTO schema_meta(key, value) VALUES ('schema_version', '1');
            PRAGMA user_version = 1;
            INSERT INTO tasks(task_id, name, status, created_at)
            VALUES ('task_legacy', 'legacy', 'running', '2026-07-08T00:00:00+00:00');
            """
        )
        conn.commit()
        conn.close()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_legacy_database_is_migrated_without_losing_tasks(self) -> None:
        store = TaskStore(self.db_path)
        try:
            task = store.get_task("task_legacy")
            assert task is not None
            self.assertEqual(task["name"], "legacy")
            self.assertIsNotNone(store.conn.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone())
            self.assertEqual(
                store.conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'").fetchone()[0],
                "task_events",
            )
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
