"""Alpha10 (schema v2) 到 A11 搜索词模型的无损迁移测试。"""

from __future__ import annotations

import json
import sqlite3
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore
from archivelens_engine.report_pipeline import DocumentRecord, ReportPipeline


def create_alpha10_database(path: Path, *, status: str) -> None:
    conn = sqlite3.connect(path)
    try:
        conn.executescript(
            """
            CREATE TABLE tasks (
                task_id TEXT PRIMARY KEY, name TEXT NOT NULL DEFAULT '', source_dir TEXT NOT NULL DEFAULT '',
                output_dir TEXT NOT NULL DEFAULT '', workspace_dir TEXT NOT NULL DEFAULT '', status TEXT NOT NULL,
                is_demo INTEGER NOT NULL DEFAULT 0, file_count INTEGER NOT NULL DEFAULT 0,
                total_pages INTEGER NOT NULL DEFAULT 0, processed_pages INTEGER NOT NULL DEFAULT 0,
                occurrence_count INTEGER NOT NULL DEFAULT 0, failure_count INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL, started_at TEXT, updated_at TEXT, finished_at TEXT,
                last_event_sequence INTEGER NOT NULL DEFAULT 0, worker_generation INTEGER NOT NULL DEFAULT 0,
                error_code TEXT, error_message TEXT
            );
            CREATE TABLE occurrences (
                occurrence_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '',
                file_name TEXT, page_number INTEGER, page_occurrence_index INTEGER, matched_character TEXT, character_variant TEXT,
                bbox_hash TEXT NOT NULL DEFAULT '', unicode_codepoint TEXT, context_full TEXT,
                verification_status TEXT
            );
            CREATE TABLE review_records (
                task_id TEXT NOT NULL, occurrence_id TEXT NOT NULL, decision TEXT, note TEXT NOT NULL DEFAULT '',
                reviewed_at TEXT, updated_at TEXT, PRIMARY KEY (task_id, occurrence_id)
            );
            CREATE TABLE exports (export_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, kind TEXT NOT NULL, path TEXT NOT NULL, created_at TEXT NOT NULL);
            CREATE TABLE task_processed_pages (task_id TEXT NOT NULL, source_id TEXT NOT NULL, page_no INTEGER NOT NULL, created_at TEXT NOT NULL, PRIMARY KEY (task_id, source_id, page_no));
            CREATE TABLE task_checkpoints (task_id TEXT NOT NULL, source_id TEXT NOT NULL, last_completed_page INTEGER NOT NULL DEFAULT 0, next_page INTEGER NOT NULL DEFAULT 1, processed_page_ids_json TEXT NOT NULL DEFAULT '[]', worker_generation INTEGER NOT NULL DEFAULT 0, updated_at TEXT NOT NULL, PRIMARY KEY (task_id, source_id));
            CREATE TABLE task_events (event_id TEXT PRIMARY KEY, task_id TEXT NOT NULL, source_id TEXT NOT NULL DEFAULT '', sequence INTEGER NOT NULL, event_type TEXT NOT NULL, payload_json TEXT NOT NULL DEFAULT '{}', worker_generation INTEGER NOT NULL DEFAULT 0, created_at TEXT NOT NULL);
            CREATE UNIQUE INDEX idx_occ_business_key ON occurrences(task_id, source_id, page_number, matched_character, bbox_hash) WHERE source_id <> '' AND bbox_hash <> '';
            CREATE UNIQUE INDEX idx_task_events_sequence ON task_events(task_id, sequence);
            PRAGMA user_version = 2;
            """
        )
        conn.execute(
            "INSERT INTO tasks(task_id, status, created_at, last_event_sequence, worker_generation, occurrence_count) VALUES ('task-v2', ?, '2026-07-09T00:00:00+00:00', 3, 1, 1)",
            (status,),
        )
        conn.execute(
            "INSERT INTO occurrences(occurrence_id, task_id, source_id, file_name, page_number, page_occurrence_index, matched_character, character_variant, bbox_hash, unicode_codepoint, context_full, verification_status) VALUES ('occ-v2', 'task-v2', 'source-v2', 'legacy.pdf', 3, 1, '约', 'simplified', 'bbox-v2', 'U+7EA6', '旧任务约定', 'confirmed')"
        )
        conn.execute("INSERT INTO review_records(task_id, occurrence_id, note) VALUES ('task-v2', 'occ-v2', '保留备注')")
        conn.execute("INSERT INTO exports(export_id, task_id, kind, path, created_at) VALUES ('exp-v2', 'task-v2', 'json', 'legacy.json', '2026-07-09T00:00:00+00:00')")
        conn.execute("INSERT INTO task_processed_pages(task_id, source_id, page_no, created_at) VALUES ('task-v2', 'source-v2', 1, '2026-07-09T00:00:00+00:00')")
        conn.execute("INSERT INTO task_checkpoints(task_id, source_id, last_completed_page, next_page, processed_page_ids_json, worker_generation, updated_at) VALUES ('task-v2', 'source-v2', 1, 2, '[1]', 1, '2026-07-09T00:00:00+00:00')")
        conn.execute("INSERT INTO task_events(event_id, task_id, source_id, sequence, event_type, payload_json, worker_generation, created_at) VALUES ('evt-v2', 'task-v2', 'source-v2', 3, 'task.progress', '{\"page_no\":1}', 1, '2026-07-09T00:00:00+00:00')")
        conn.commit()
    finally:
        conn.close()


class Alpha10MigrationTests(unittest.TestCase):
    def test_completed_task_preserves_results_review_note_export_and_legacy_terms(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "completed-v2.db"
            create_alpha10_database(path, status="completed")
            store = TaskStore(path)
            try:
                task = store.get_task("task-v2")
                assert task is not None
                self.assertEqual(task["search_terms"], ["约", "約"])
                self.assertEqual(task["search_mode"], "legacy_fixed_pair")
                self.assertEqual(task["search_text"], "约 / 約")
                total, items = store.query_occurrences(task_id="task-v2")
                self.assertEqual(total, 1)
                self.assertEqual(items[0]["matched_text"], "约")
                self.assertEqual(items[0]["unicode_sequence"], "U+7EA6")
                self.assertEqual(items[0]["review_note"], "保留备注")
                self.assertEqual(
                    store.conn.execute("SELECT path FROM exports WHERE task_id='task-v2'").fetchone()[0],
                    "legacy.json",
                )
                self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            finally:
                store.close()

            reopened = TaskStore(path)
            try:
                self.assertEqual(reopened.get_task("task-v2")["search_terms"], ["约", "約"])
                self.assertEqual(reopened.query_occurrences(task_id="task-v2")[0], 1)
            finally:
                reopened.close()

    def test_unfinished_task_keeps_checkpoint_and_events_without_inventing_new_term(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "unfinished-v2.db"
            create_alpha10_database(path, status="paused")
            store = TaskStore(path)
            try:
                task = store.get_task("task-v2")
                assert task is not None
                self.assertEqual(task["search_terms"], ["约", "約"])
                self.assertEqual(store.list_processed_page_ids("task-v2", "source-v2"), [1])
                self.assertEqual(store.get_task_checkpoint("task-v2", "source-v2")["next_page"], 2)
                self.assertEqual([event["sequence"] for event in store.list_task_events("task-v2")], [3])
            finally:
                store.close()

    def test_migrated_paused_task_drives_pipeline_from_sqlite_state(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "paused-resume-v2.db"
            create_alpha10_database(path, status="paused")
            store = TaskStore(path)
            try:
                task = store.get_task("task-v2")
                assert task is not None
                self.assertEqual(task["search_terms"], ["约", "約"])
                states = store.list_task_resume_states("task-v2")
                pipeline = object.__new__(ReportPipeline)
                pipeline.resume_state_by_source = states
                pipeline.page_limit = None
                pipeline.start_page_index = None
                pipeline.end_page_index_exclusive = None
                doc = DocumentRecord(
                    document_id="random",
                    file_path=Path("source-v2"),
                    relative_path="source-v2",
                    file_type="PDF",
                    file_size_bytes=1,
                    file_hash_sha256="a" * 64,
                    modified_time=0,
                    page_count=4,
                )
                self.assertEqual([index + 1 for index in pipeline._page_indexes_for_document(doc)], [2, 3, 4])
                self.assertEqual(store.allocate_worker_generation("task-v2"), 2)
            finally:
                store.close()


if __name__ == "__main__":
    unittest.main()
