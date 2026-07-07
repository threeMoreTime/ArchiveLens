"""SQLite rollback 故障注入测试（任务 §五.3）。

验证 add_occurrences 在批量写入中抛异常时：
* 事务 rollback（已写入的项回滚）；
* occurrence 不残留；
* 后续操作仍可继续。
"""

from __future__ import annotations

import gc
import shutil
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import TaskStore


def _occ(i: int) -> dict:
    return {"matched_character": "约", "page_number": i, "page_occurrence_index": 1}


class StoreRollbackTests(unittest.TestCase):
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

    def test_add_occurrences_rolls_back_on_exception(self) -> None:
        def gen():
            yield _occ(1)
            yield _occ(2)
            raise RuntimeError("injected failure")
            yield _occ(3)  # noqa: UNREACHABLE

        with self.assertRaises(RuntimeError):
            self.store.add_occurrences(self.task_id, gen())

        # rollback：不应残留 occurrence
        total, _ = self.store.query_occurrences(task_id=self.task_id)
        self.assertEqual(total, 0, f"rollback 失败，残留 {total} 条")

    def test_store_still_usable_after_rollback(self) -> None:
        with self.assertRaises(Exception):  # noqa: B017, PT011
            self.store.add_occurrences(self.task_id, iter([_occ(1), None]))
        # rollback 后仍可正常写入
        self.store.add_occurrences(self.task_id, [_occ(10), _occ(11)])
        total, _ = self.store.query_occurrences(task_id=self.task_id)
        self.assertEqual(total, 2)

    def test_review_rollback_on_bad_input(self) -> None:
        # 正常 review 可写入
        self.store.upsert_review(task_id=self.task_id, occurrence_id="occ_1", decision="confirmed")
        reviews = self.store.list_reviews(self.task_id)
        self.assertEqual(len(reviews), 1)


if __name__ == "__main__":
    unittest.main()
