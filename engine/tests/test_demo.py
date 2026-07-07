"""演示模式测试：内置 fixture 不依赖原生 OCR。"""

from __future__ import annotations

import gc
import shutil
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import TaskStore
from archivelens_engine.demo import DEMO_DOCUMENTS, create_demo


class DemoTests(unittest.TestCase):
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

    def test_create_demo_writes_six_occurrences_with_images(self) -> None:
        result = create_demo(self.store, Path(self.tmp) / "tasks")
        self.assertEqual(result["occurrence_count"], 6)
        self.assertEqual(result["status"], "completed")

        task = self.store.get_task(result["task_id"])
        assert task is not None
        self.assertTrue(task["is_demo"])

        total, items = self.store.query_occurrences(task_id=result["task_id"])
        self.assertEqual(total, 6)
        self.assertEqual({i["matched_character"] for i in items}, {"约", "約"})
        self.assertEqual(
            {i["verification_status"] for i in items},
            {"confirmed", "needs_review", "rejected"},
        )
        names = {i["file_name"] for i in items}
        self.assertTrue(any("#" in n for n in names))
        self.assertTrue(any("%" in n for n in names))

        ws = Path(result["workspace_dir"])
        self.assertTrue(any((ws / "pages").glob("*.png")))
        self.assertTrue(any((ws / "crops").glob("*.png")))

    def test_demo_documents_cover_special_chars(self) -> None:
        names = " ".join(d["file_name"] for d in DEMO_DOCUMENTS)
        self.assertIn(" ", names)
        self.assertIn("#", names)


if __name__ == "__main__":
    unittest.main()
