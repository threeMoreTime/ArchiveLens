"""SQLite 并发安全测试（任务 §十）。

验证 TaskStore 在「扫描线程写 occurrence + IPC 线程查询 + Review 线程更新 +
Export 线程读取」并发下：
* 无 ``database is locked``；
* 无跨线程 ``ProgrammingError``；
* 无嵌套 transaction 错误；
* 数据一致（occurrence/review 不丢失）。
"""

from __future__ import annotations

import gc
import shutil
import tempfile
import threading
import unittest
from pathlib import Path

from archivelens_engine.db.store import TaskStore


class TaskStoreConcurrencyTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.store = TaskStore(Path(self.tmp) / "t.db")
        self.task_id = self.store.create_task()

    def tearDown(self) -> None:
        try:
            self.store.close()
        except Exception:
            pass
        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_concurrent_write_query_review_export(self) -> None:
        errors: list[Exception] = []

        def writer() -> None:
            try:
                for i in range(20):
                    self.store.add_occurrences(
                        self.task_id,
                        [{"matched_character": "约", "page_number": i, "page_occurrence_index": 1}],
                    )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def querier() -> None:
            try:
                for _ in range(30):
                    self.store.query_occurrences(task_id=self.task_id)
                    self.store.get_task(self.task_id)
                    self.store.list_tasks()
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def reviewer() -> None:
            try:
                for i in range(15):
                    self.store.upsert_review(
                        task_id=self.task_id,
                        occurrence_id=f"occ_{i}",
                        decision="confirmed",
                        note=f"备注{i}",
                    )
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        def exporter() -> None:
            try:
                for _ in range(10):
                    self.store.add_export(task_id=self.task_id, kind="json", path="x")
                    self.store.list_reviews(self.task_id)
            except Exception as exc:  # noqa: BLE001
                errors.append(exc)

        threads = [
            threading.Thread(target=writer),
            threading.Thread(target=querier),
            threading.Thread(target=reviewer),
            threading.Thread(target=exporter),
        ]
        for t in threads:
            t.start()
        for t in threads:
            t.join()

        # 不得出现 database is locked / ProgrammingError
        locked_msgs = [e for e in errors if "locked" in str(e).lower() or "ProgrammingError" in str(e)]
        self.assertEqual(locked_msgs, [], f"并发 SQLite 错误：{locked_msgs}")
        self.assertEqual(errors, [], f"其他并发错误：{errors}")

        # 数据一致：20 次 × 1 occurrence = 20
        total, items = self.store.query_occurrences(task_id=self.task_id, limit=10000)
        self.assertEqual(total, 20, f"occurrence 丢失：{total}")
        # review 不丢失（occ_0..occ_14，15 条；注意 occ_xxx 不在 occurrences 表，但 review_records 独立）
        reviews = self.store.list_reviews(self.task_id)
        self.assertEqual(len(reviews), 15, f"review 丢失：{len(reviews)}")


if __name__ == "__main__":
    unittest.main()
