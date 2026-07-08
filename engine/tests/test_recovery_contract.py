"""恢复证据模型测试：processed pages / checkpoint / event sequence / migration。"""

from __future__ import annotations

import gc
import shutil
import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

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
        self.maxDiff = None

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _legacy_task(
        self,
        *,
        task_id: str,
        name: str,
        status: str,
        processed_pages: int = 0,
        occurrence_count: int = 0,
        total_pages: int = 0,
        error_code: str | None = None,
    ) -> dict[str, object]:
        return {
            "task_id": task_id,
            "name": name,
            "source_dir": f"C:/legacy/{task_id}/source",
            "output_dir": f"C:/legacy/{task_id}/output",
            "workspace_dir": f"C:/legacy/{task_id}/workspace",
            "status": status,
            "is_demo": 0,
            "file_count": 1,
            "total_pages": total_pages,
            "processed_pages": processed_pages,
            "occurrence_count": occurrence_count,
            "failure_count": 0,
            "created_at": "2026-07-08T00:00:00+00:00",
            "started_at": "2026-07-08T00:01:00+00:00",
            "updated_at": "2026-07-08T00:02:00+00:00",
            "finished_at": "2026-07-08T00:03:00+00:00" if status in {"completed", "cancelled", "failed"} else None,
            "error_code": error_code,
            "error_message": None,
        }

    def _legacy_occurrence(
        self,
        *,
        occurrence_id: str,
        task_id: str,
        matched_character: str,
        page_number: int,
    ) -> dict[str, object]:
        return {
            "occurrence_id": occurrence_id,
            "task_id": task_id,
            "document_id": "legacy-doc",
            "file_path": f"C:/legacy/{task_id}/source/legacy.pdf",
            "relative_path": "legacy.pdf",
            "file_name": "legacy.pdf",
            "page_number": page_number,
            "page_index": page_number - 1,
            "page_occurrence_index": 1,
            "matched_character": matched_character,
            "character_variant": "simplified" if matched_character == "约" else "traditional",
            "unicode_codepoint": f"U+{ord(matched_character):04X}",
            "context_before": "前文",
            "context_after": "后文",
            "context_full": f"legacy-{page_number}-{matched_character}",
            "ocr_confidence": 0.98,
            "secondary_ocr_result": matched_character,
            "verification_status": "confirmed",
            "location_method": "ocr",
            "source_page_width": 1000.0,
            "source_page_height": 1400.0,
            "source_x0": 10.0,
            "source_y0": 20.0,
            "source_x1": 30.0,
            "source_y1": 40.0,
            "normalized_x0": 0.01,
            "normalized_y0": 0.02,
            "normalized_x1": 0.03,
            "normalized_y1": 0.04,
            "page_image_relpath": "pages/p1.png",
            "crop_image_relpath": "crops/c1.png",
            "page_image_width": 1000,
            "page_image_height": 1400,
        }

    def _create_legacy_db(
        self,
        name: str,
        *,
        tasks: list[dict[str, object]] | None = None,
        occurrences: list[dict[str, object]] | None = None,
        reviews: list[dict[str, object]] | None = None,
        exports: list[dict[str, object]] | None = None,
    ) -> Path:
        db_path = Path(self.tmp) / name
        conn = sqlite3.connect(db_path)
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
            """
        )
        if tasks:
            conn.executemany(
                """
                INSERT INTO tasks (
                    task_id, name, source_dir, output_dir, workspace_dir, status,
                    is_demo, file_count, total_pages, processed_pages, occurrence_count,
                    failure_count, created_at, started_at, updated_at, finished_at,
                    error_code, error_message
                ) VALUES (
                    :task_id, :name, :source_dir, :output_dir, :workspace_dir, :status,
                    :is_demo, :file_count, :total_pages, :processed_pages, :occurrence_count,
                    :failure_count, :created_at, :started_at, :updated_at, :finished_at,
                    :error_code, :error_message
                )
                """,
                tasks,
            )
        if occurrences:
            conn.executemany(
                """
                INSERT INTO occurrences (
                    occurrence_id, task_id, document_id, file_path, relative_path, file_name,
                    page_number, page_index, page_occurrence_index, matched_character,
                    character_variant, unicode_codepoint, context_before, context_after,
                    context_full, ocr_confidence, secondary_ocr_result, verification_status,
                    location_method, source_page_width, source_page_height,
                    source_x0, source_y0, source_x1, source_y1,
                    normalized_x0, normalized_y0, normalized_x1, normalized_y1,
                    page_image_relpath, crop_image_relpath, page_image_width, page_image_height
                ) VALUES (
                    :occurrence_id, :task_id, :document_id, :file_path, :relative_path, :file_name,
                    :page_number, :page_index, :page_occurrence_index, :matched_character,
                    :character_variant, :unicode_codepoint, :context_before, :context_after,
                    :context_full, :ocr_confidence, :secondary_ocr_result, :verification_status,
                    :location_method, :source_page_width, :source_page_height,
                    :source_x0, :source_y0, :source_x1, :source_y1,
                    :normalized_x0, :normalized_y0, :normalized_x1, :normalized_y1,
                    :page_image_relpath, :crop_image_relpath, :page_image_width, :page_image_height
                )
                """,
                occurrences,
            )
        if reviews:
            conn.executemany(
                """
                INSERT INTO review_records(task_id, occurrence_id, decision, note, reviewed_at, updated_at)
                VALUES (:task_id, :occurrence_id, :decision, :note, :reviewed_at, :updated_at)
                """,
                reviews,
            )
        if exports:
            conn.executemany(
                """
                INSERT INTO exports(export_id, task_id, kind, path, created_at)
                VALUES (:export_id, :task_id, :kind, :path, :created_at)
                """,
                exports,
            )
        conn.commit()
        conn.close()
        return db_path

    def _assert_schema_v2(self, store: TaskStore) -> None:
        self.assertEqual(
            store.conn.execute("SELECT value FROM schema_meta WHERE key='schema_version'").fetchone()[0],
            "2",
        )
        self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], 2)
        self.assertEqual(
            {
                row[0]
                for row in store.conn.execute(
                    "SELECT name FROM sqlite_master WHERE type='table' AND name IN ('task_processed_pages', 'task_checkpoints', 'task_events')"
                ).fetchall()
            },
            {"task_processed_pages", "task_checkpoints", "task_events"},
        )

    def test_empty_legacy_database_migrates_and_supports_new_progress_contract(self) -> None:
        db_path = self._create_legacy_db("legacy-empty.db")
        store = TaskStore(db_path)
        try:
            self._assert_schema_v2(store)
            task_id = store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="migrated-empty")
            store.append_task_event(
                task_id=task_id,
                event_type="task.started",
                payload={"worker_generation": 1},
                source_id=SOURCE_ID,
                worker_generation=1,
            )
            outcome = store.record_page_completion(
                task_id=task_id,
                source_id=SOURCE_ID,
                page_no=1,
                worker_generation=1,
                occurrences=[_occ(1)],
            )
            self.assertEqual(outcome["processed_page_ids"], [1])
            checkpoint = store.get_task_checkpoint(task_id, SOURCE_ID)
            assert checkpoint is not None
            self.assertEqual(checkpoint["last_completed_page"], 1)
            self.assertEqual(checkpoint["next_page"], 2)
            self.assertEqual([event["sequence"] for event in store.list_task_events(task_id)], [1, 2])
        finally:
            store.close()

    def test_completed_legacy_database_preserves_occurrences_reviews_notes_and_exports(self) -> None:
        db_path = self._create_legacy_db(
            "legacy-completed.db",
            tasks=[
                self._legacy_task(
                    task_id="task_completed",
                    name="completed legacy",
                    status="completed",
                    processed_pages=2,
                    occurrence_count=2,
                    total_pages=2,
                ),
            ],
            occurrences=[
                self._legacy_occurrence(
                    occurrence_id="occ_completed_1",
                    task_id="task_completed",
                    matched_character="约",
                    page_number=1,
                ),
                self._legacy_occurrence(
                    occurrence_id="occ_completed_2",
                    task_id="task_completed",
                    matched_character="約",
                    page_number=2,
                ),
            ],
            reviews=[
                {
                    "task_id": "task_completed",
                    "occurrence_id": "occ_completed_1",
                    "decision": "confirmed",
                    "note": "legacy note",
                    "reviewed_at": "2026-07-08T00:04:00+00:00",
                    "updated_at": "2026-07-08T00:04:00+00:00",
                }
            ],
            exports=[
                {
                    "export_id": "exp_legacy_completed",
                    "task_id": "task_completed",
                    "kind": "html",
                    "path": "C:/legacy/task_completed/report.html",
                    "created_at": "2026-07-08T00:05:00+00:00",
                }
            ],
        )
        for _ in range(2):
            store = TaskStore(db_path)
            try:
                self._assert_schema_v2(store)
                task = store.get_task("task_completed")
                assert task is not None
                self.assertEqual(task["status"], "completed")
                total, items = store.query_occurrences(task_id="task_completed", limit=100, offset=0)
                self.assertEqual(total, 2)
                self.assertEqual([item["occurrence_id"] for item in items], ["occ_completed_1", "occ_completed_2"])
                reviews = store.list_reviews("task_completed")
                self.assertEqual(len(reviews), 1)
                self.assertEqual(reviews[0]["decision"], "confirmed")
                self.assertEqual(reviews[0]["note"], "legacy note")
                self.assertEqual(store.list_task_events("task_completed"), [])
                self.assertIsNone(store.get_task_checkpoint("task_completed", SOURCE_ID))
                self.assertEqual(
                    store.conn.execute("SELECT COUNT(*) FROM exports WHERE task_id='task_completed'").fetchone()[0],
                    1,
                )
            finally:
                store.close()

    def test_unfinished_legacy_database_becomes_recoverable_without_fabricated_checkpoint(self) -> None:
        db_path = self._create_legacy_db(
            "legacy-unfinished.db",
            tasks=[
                self._legacy_task(
                    task_id="task_unfinished",
                    name="unfinished legacy",
                    status="running",
                    processed_pages=2,
                    occurrence_count=2,
                    total_pages=5,
                ),
            ],
            occurrences=[
                self._legacy_occurrence(
                    occurrence_id="occ_unfinished_1",
                    task_id="task_unfinished",
                    matched_character="约",
                    page_number=1,
                ),
                self._legacy_occurrence(
                    occurrence_id="occ_unfinished_2",
                    task_id="task_unfinished",
                    matched_character="約",
                    page_number=2,
                ),
            ],
        )
        store = TaskStore(db_path)
        try:
            self._assert_schema_v2(store)
            changed = store.reconcile_incomplete_tasks("LEGACY_TASK_REQUIRES_REVIEW")
            self.assertEqual(changed, 1)
            task = store.get_task("task_unfinished")
            assert task is not None
            self.assertEqual(task["status"], "recoverable")
            self.assertEqual(task["error_code"], "LEGACY_TASK_REQUIRES_REVIEW")
            total, _ = store.query_occurrences(task_id="task_unfinished", limit=100, offset=0)
            self.assertEqual(total, 2)
            self.assertEqual(store.list_processed_page_ids("task_unfinished", SOURCE_ID), [])
            self.assertIsNone(store.get_task_checkpoint("task_unfinished", SOURCE_ID))
            events = store.list_task_events("task_unfinished")
            self.assertEqual([event["sequence"] for event in events], [1])
            self.assertEqual(events[0]["event_type"], "task.recoverable")
        finally:
            store.close()

    def test_legacy_migration_rollback_allows_retry_after_failure(self) -> None:
        db_path = self._create_legacy_db(
            "legacy-rollback.db",
            tasks=[self._legacy_task(task_id="task_rollback", name="rollback", status="draft")],
        )
        original = TaskStore._ensure_column
        injected_failure = RuntimeError("boom during migration")
        call_count = {"value": 0}

        def flaky_ensure(store: TaskStore, table: str, column: str, ddl: str) -> None:
            original(store, table, column, ddl)
            call_count["value"] += 1
            if call_count["value"] == 1:
                raise injected_failure

        with mock.patch.object(TaskStore, "_ensure_column", new=flaky_ensure):
            with self.assertRaises(RuntimeError):
                TaskStore(db_path)

        conn = sqlite3.connect(db_path)
        try:
            task_columns = {row[1] for row in conn.execute("PRAGMA table_info(tasks)").fetchall()}
            self.assertNotIn("last_event_sequence", task_columns)
            self.assertEqual(conn.execute("PRAGMA user_version").fetchone()[0], 1)
            self.assertIsNone(
                conn.execute("SELECT name FROM sqlite_master WHERE type='table' AND name='task_events'").fetchone()
            )
        finally:
            conn.close()

        store = TaskStore(db_path)
        try:
            self._assert_schema_v2(store)
            task = store.get_task("task_rollback")
            assert task is not None
            self.assertEqual(task["name"], "rollback")
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
