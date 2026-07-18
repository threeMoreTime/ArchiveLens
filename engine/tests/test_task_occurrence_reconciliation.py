"""扫描任务字形范围持久化与已扫描语料无重扫回填。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore
from archivelens_engine.ocr_search import OCRSearchService
from archivelens_engine.script_variants import ScriptVariantResolver
from archivelens_engine.server import Server


MODEL_SHA256 = "a" * 64


class TaskOccurrenceReconciliationTests(unittest.TestCase):
    def _ocr_line(self, raw_text: str) -> dict:
        resolver = ScriptVariantResolver()
        forms = resolver.forms(raw_text)
        return {
            "line_index": 0,
            "raw_text": raw_text,
            "resolved_text": raw_text,
            "confidence": 0.96,
            "bbox": [[10, 20], [210, 20], [210, 60], [10, 60]],
            "word_boxes": [],
            "word_text": [],
            "word_confidences": [],
            "isolated_character_top_k": [],
            "script_reconciliations": [],
            "search_forms": {
                "simplified": forms.simplified,
                "traditional": forms.traditional,
                "taiwan": forms.taiwan,
                "hong_kong": forms.hong_kong,
            },
        }

    def test_reconcile_adds_traditional_hit_once_without_changing_raw_ocr(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp) / "tasks.db")
            try:
                task_id = store.create_task(
                    source_dir="X",
                    source_files=[{
                        "source_id": "source-1",
                        "file_path": r"X:\乾隆.pdf",
                        "display_path": "乾隆.pdf",
                        "file_name": "乾隆.pdf",
                    }],
                    search_terms=["亏空"],
                    search_mode="exact_literal",
                    search_script_scope="both",
                )
                store.record_page_completion(
                    task_id=task_id,
                    source_id="source-1",
                    page_no=1,
                    worker_generation=1,
                    occurrences=[],
                    ocr_page={
                        "document_id": "doc-1",
                        "page_no": 1,
                        "page_index": 0,
                        "source_page_width": 1200,
                        "source_page_height": 1800,
                        "model": {"id": "PP-OCRv6-small", "source_version": "test", "sha256": MODEL_SHA256},
                        "lines": [self._ocr_line("原簿虧空待查")],
                    },
                )
                server = Server.__new__(Server)
                server.store = store
                server.ocr_search = OCRSearchService(store)
                task = store.get_task(task_id)
                assert task is not None

                self.assertEqual(server._reconcile_task_search_occurrences(task), 1)
                self.assertEqual(server._reconcile_task_search_occurrences(task), 0)
                total, items = store.query_occurrences(task_id=task_id)
                self.assertEqual(total, 1)
                self.assertEqual(items[0]["matched_text"], "虧空")
                self.assertEqual(items[0]["verification_status"], "needs_review")
                self.assertEqual(store.list_ocr_lines(task_id)[0]["raw_text"], "原簿虧空待查")
                checkpoint = store.get_task_checkpoint(task_id, "source-1")
                assert checkpoint is not None
                self.assertEqual(checkpoint["next_page"], 2)
            finally:
                store.close()

    def test_v10_migration_defaults_existing_tasks_to_both_scope(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "tasks.db"
            store = TaskStore(database)
            task_id = store.create_task(search_terms=["亏空"], search_mode="exact_literal")
            store.close()
            connection = sqlite3.connect(database)
            connection.execute("ALTER TABLE tasks DROP COLUMN search_script_scope")
            connection.execute("PRAGMA user_version = 10")
            connection.execute("UPDATE schema_meta SET value='10' WHERE key='schema_version'")
            connection.commit()
            connection.close()

            reopened = TaskStore(database)
            try:
                self.assertEqual(SCHEMA_VERSION, 11)
                task = reopened.get_task(task_id)
                assert task is not None
                self.assertEqual(task["search_script_scope"], "both")
                self.assertEqual(reopened.conn.execute("PRAGMA user_version").fetchone()[0], 11)
                self.assertIsNotNone(reopened.last_migration_backup)
            finally:
                reopened.close()


if __name__ == "__main__":
    unittest.main()
