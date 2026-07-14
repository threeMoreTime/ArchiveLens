"""演示模式测试：内置 fixture 不依赖原生 OCR。"""

from __future__ import annotations

import gc
import shutil
import tempfile
import unittest
from pathlib import Path

from PIL import Image

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
        first_item = next(i for i in items if i["page_image_relpath"] == "pages/doc1-p1.png")
        with Image.open(ws / "pages" / "doc1-p1.png") as page:
            body_area = page.convert("RGB").crop((60, 240, 420, 560))
            body_dark_pixels = sum(
                1 for red, green, blue in body_area.get_flattened_data()
                if red < 150 and green < 150 and blue < 150
            )
            hit_area = page.convert("RGB").crop(
                (
                    int(first_item["source_x0"]),
                    int(first_item["source_y0"]),
                    int(first_item["source_x1"]),
                    int(first_item["source_y1"]),
                )
            )
            hit_dark_pixels = sum(
                1 for red, green, blue in hit_area.get_flattened_data()
                if red < 150 and green < 150 and blue < 150
            )
        self.assertGreater(body_dark_pixels, 900, "演示出处页应展示完整正文，而非仅显示 OCR 上下文")
        self.assertGreater(hit_dark_pixels, 10, "命中框应定位到正文中的实际命中字符")

    def test_demo_documents_cover_special_chars(self) -> None:
        names = " ".join(d["file_name"] for d in DEMO_DOCUMENTS)
        self.assertIn(" ", names)
        self.assertIn("#", names)


if __name__ == "__main__":
    unittest.main()
