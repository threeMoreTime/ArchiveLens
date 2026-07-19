"""任务内永久命中序号的迁移、追加与查询合同。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore


class OccurrenceSequenceTests(unittest.TestCase):
    def _downgrade_to_v11(self, database: Path) -> None:
        """把当前测试库还原成可信 v11 形状，供真实迁移路径使用。"""
        connection = sqlite3.connect(database)
        try:
            connection.execute("DROP TRIGGER IF EXISTS trg_occurrences_sequence_insert")
            connection.execute("DROP TRIGGER IF EXISTS trg_occurrences_sequence_update")
            connection.execute("DROP INDEX IF EXISTS idx_occ_task_sequence")
            columns = {
                row[1]
                for row in connection.execute("PRAGMA table_info(occurrences)").fetchall()
            }
            if "global_sequence" in columns:
                connection.execute("ALTER TABLE occurrences DROP COLUMN global_sequence")
            connection.execute("PRAGMA user_version = 11")
            connection.execute(
                "UPDATE schema_meta SET value='11' WHERE key='schema_version'"
            )
            connection.commit()
        finally:
            connection.close()

    @staticmethod
    def _occurrence(
        occurrence_id: str,
        *,
        source_id: str,
        page_number: int,
        page_occurrence_index: int,
        bbox_hash: str,
        context: str = "档案命中",
    ) -> dict:
        return {
            "occurrence_id": occurrence_id,
            "source_id": source_id,
            "file_name": f"{source_id}.pdf",
            "relative_path": f"目录/{source_id}.pdf",
            "page_number": page_number,
            "page_occurrence_index": page_occurrence_index,
            "matched_text": "档案",
            "bbox_hash": bbox_hash,
            "context_full": context,
        }

    def test_v11_migration_backfills_source_page_and_in_page_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "tasks.db"
            store = TaskStore(database)
            task_id = store.create_task(
                source_kind="files",
                source_files=[
                    {
                        "source_id": "source-z",
                        "file_path": r"C:\甲\z.pdf",
                        "display_path": "甲/z.pdf",
                    },
                    {
                        "source_id": "source-a",
                        "file_path": r"D:\乙\a.pdf",
                        "display_path": "乙/a.pdf",
                    },
                ],
            )
            store.add_occurrences(
                task_id,
                [
                    self._occurrence(
                        "occ-a", source_id="source-a", page_number=1,
                        page_occurrence_index=1, bbox_hash="bbox-a",
                    ),
                    self._occurrence(
                        "occ-z-2b", source_id="source-z", page_number=2,
                        page_occurrence_index=2, bbox_hash="bbox-z-2b",
                    ),
                    self._occurrence(
                        "occ-z-1", source_id="source-z", page_number=1,
                        page_occurrence_index=1, bbox_hash="bbox-z-1",
                    ),
                    self._occurrence(
                        "occ-z-2a", source_id="source-z", page_number=2,
                        page_occurrence_index=1, bbox_hash="bbox-z-2a",
                    ),
                ],
            )
            store.close()
            self._downgrade_to_v11(database)

            reopened = TaskStore(database)
            try:
                self.assertEqual(SCHEMA_VERSION, 12)
                self.assertEqual(
                    reopened.conn.execute("PRAGMA user_version").fetchone()[0],
                    12,
                )
                total, rows = reopened.query_occurrences(task_id=task_id)
                self.assertEqual(total, 4)
                self.assertEqual(
                    [row["occurrence_id"] for row in rows],
                    ["occ-z-1", "occ-z-2a", "occ-z-2b", "occ-a"],
                )
                self.assertEqual(
                    [row["global_sequence"] for row in rows],
                    [1, 2, 3, 4],
                )
                self.assertIsNotNone(reopened.last_migration_backup)
            finally:
                reopened.close()

    def test_sequence_is_stable_append_only_and_duplicate_safe(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp) / "tasks.db")
            try:
                task_id = store.create_task()
                original = self._occurrence(
                    "occ-first", source_id="source-1", page_number=5,
                    page_occurrence_index=1, bbox_hash="bbox-first",
                )
                store.add_occurrences(task_id, [original])
                store.add_occurrences(
                    task_id,
                    [{**original, "occurrence_id": "occ-duplicate"}],
                )
                store.add_occurrences(
                    task_id,
                    [self._occurrence(
                        "occ-second", source_id="source-1", page_number=1,
                        page_occurrence_index=1, bbox_hash="bbox-second",
                    )],
                )

                total, rows = store.query_occurrences(task_id=task_id)
                self.assertEqual(total, 2)
                self.assertEqual(
                    [(row["occurrence_id"], row["global_sequence"]) for row in rows],
                    [("occ-first", 1), ("occ-second", 2)],
                )
                with store.occurrence_export_snapshot(task_id) as (_, _, snapshot):
                    self.assertEqual(
                        [row["global_sequence"] for row in snapshot],
                        [1, 2],
                    )
            finally:
                store.close()

    def test_filtered_pagination_retains_permanent_sequence_order(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp) / "tasks.db")
            try:
                task_id = store.create_task()
                store.add_occurrences(
                    task_id,
                    [
                        self._occurrence(
                            "occ-1", source_id="source-1", page_number=3,
                            page_occurrence_index=1, bbox_hash="bbox-1", context="需复核 档案",
                        ),
                        self._occurrence(
                            "occ-2", source_id="source-1", page_number=1,
                            page_occurrence_index=1, bbox_hash="bbox-2", context="其他 档案",
                        ),
                        self._occurrence(
                            "occ-3", source_id="source-1", page_number=2,
                            page_occurrence_index=1, bbox_hash="bbox-3", context="需复核 档案",
                        ),
                    ],
                )
                total, first_page = store.query_occurrences(
                    task_id=task_id, search="需复核", limit=1, offset=0
                )
                _, second_page = store.query_occurrences(
                    task_id=task_id, search="需复核", limit=1, offset=1
                )
                self.assertEqual(total, 2)
                self.assertEqual(first_page[0]["global_sequence"], 1)
                self.assertEqual(second_page[0]["global_sequence"], 3)
            finally:
                store.close()

    def test_database_rejects_invalid_or_reused_sequence(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            store = TaskStore(Path(tmp) / "tasks.db")
            try:
                task_id = store.create_task()
                store.add_occurrences(
                    task_id,
                    [self._occurrence(
                        "occ-first", source_id="source-1", page_number=1,
                        page_occurrence_index=1, bbox_hash="bbox-first",
                    )],
                )
                with self.assertRaises(sqlite3.IntegrityError):
                    store.conn.execute(
                        "INSERT INTO occurrences(occurrence_id, task_id, global_sequence) "
                        "VALUES ('occ-invalid', ?, 0)",
                        (task_id,),
                    )
                store.conn.rollback()
                with self.assertRaises(sqlite3.IntegrityError):
                    store.conn.execute(
                        "INSERT INTO occurrences(occurrence_id, task_id, global_sequence) "
                        "VALUES ('occ-reused', ?, 1)",
                        (task_id,),
                    )
                store.conn.rollback()
                with self.assertRaises(sqlite3.IntegrityError):
                    store.conn.execute(
                        "UPDATE occurrences SET global_sequence=0 WHERE occurrence_id='occ-first'"
                    )
                store.conn.rollback()
            finally:
                store.close()

    def test_failed_v12_migration_restores_v11_database(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            database = Path(tmp) / "tasks.db"
            store = TaskStore(database)
            store.create_task()
            store.close()
            self._downgrade_to_v11(database)

            with mock.patch.object(
                TaskStore,
                "_ensure_occurrence_sequence_contract",
                side_effect=RuntimeError("injected sequence migration failure"),
            ):
                with self.assertRaisesRegex(
                    RuntimeError, "injected sequence migration failure"
                ):
                    TaskStore(database)

            connection = sqlite3.connect(database)
            try:
                self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], 11)
                columns = {
                    row[1]
                    for row in connection.execute("PRAGMA table_info(occurrences)").fetchall()
                }
                self.assertNotIn("global_sequence", columns)
            finally:
                connection.close()


if __name__ == "__main__":
    unittest.main()
