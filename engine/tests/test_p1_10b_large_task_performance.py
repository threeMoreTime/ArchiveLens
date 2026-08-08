"""P1-10B-A: SlowFake 大任务调度回归基线。

诚实定位：使用 SlowFake 模式（假处理器）验证 Engine 对 350 页任务的处理完整性，
不覆盖真实打包制品的 OCR 推理性能。

真实打包制品性能验收（每页 OCR 耗时、P50/P95、峰值内存、CPU 等）
需要用 Setup/Portable/win-unpacked 的真实 Engine，属于 P1-10B-B 范围。
"""
from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch


class P1_10B_LargeTaskPerformanceTests(unittest.TestCase):
    """350 页大任务性能验收。"""

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        # P1-10B-A 只验证 350 页任务调度；必须显式启用 SlowFake，避免误跑真实 OCR。
        with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "350", "AL_SLOWFAKE_PAGE_DELAY_MS": "10"}, clear=False):
            from archivelens_engine.server import Server
            cls.server = Server(workspace_root=cls._tmpdir.name)
        cls.metrics = {}

    @classmethod
    def tearDownClass(cls):
        try:
            cls.server.store.close()
        finally:
            cls._tmpdir.cleanup()

    def test_large_task_350_pages(self):
        """350 页 PDF 大任务：创建→启动→完成→完整性检查。"""
        self.assertEqual(
            self.server.slowfake_pages,
            350,
            "P1-10B-A 必须走 350 页 SlowFake 分支，真实 OCR 应由 P1-10B-B 验收",
        )
        large_pdf = Path("tests/fixtures/p1-10b-synthetic/large-350-page.pdf")
        if not large_pdf.exists():
            self.skipTest("350 页 PDF fixture 不存在")

        import hashlib
        import shutil

        # 复制到测试源目录
        src = Path(self._tmpdir.name) / "src_large"
        src.mkdir()
        shutil.copy2(large_pdf, src / "large.pdf")
        original_sha = hashlib.sha256(large_pdf.read_bytes()).hexdigest()

        # 创建任务
        t0 = time.perf_counter()
        create_result = self.server.handlers["tasks.create"](
            self.server,
            {"source_dir": str(src), "search_text": "档"},
        )
        task_id = create_result["task_id"]
        create_elapsed = time.perf_counter() - t0

        # 启动任务
        t1 = time.perf_counter()
        self.server.handlers["tasks.start"](self.server, {"task_id": task_id})
        start_elapsed = time.perf_counter() - t1

        # 轮询等待完成（最多 300 秒）
        t2 = time.perf_counter()
        task = None
        for _ in range(600):
            time.sleep(0.5)
            task = self.server.handlers["tasks.get"](self.server, {"task_id": task_id})
            if task["status"] in ("completed", "failed", "cancelled"):
                break
        total_elapsed = time.perf_counter() - t2

        # 断言任务完成
        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "completed", f"大任务未完成: status={task['status']}")

        # 断言页数
        self.assertEqual(task["total_pages"], 350, f"总页数应为 350，实际 {task['total_pages']}")
        self.assertEqual(task["processed_pages"], 350, f"已处理页应为 350，实际 {task['processed_pages']}")

        # 数据库完整性
        result = self.server.store.conn.execute("PRAGMA integrity_check").fetchone()
        self.assertEqual(result[0], "ok")

        # 来源文件不变
        after_sha = hashlib.sha256((src / "large.pdf").read_bytes()).hexdigest()
        self.assertEqual(original_sha, after_sha, "来源文件被修改！")

        # 记录性能指标
        self.metrics["create_time_s"] = round(create_elapsed, 3)
        self.metrics["start_time_s"] = round(start_elapsed, 3)
        self.metrics["total_processing_time_s"] = round(total_elapsed, 3)
        self.metrics["total_pages"] = 350
        self.metrics["processed_pages"] = 350
        self.metrics["per_page_avg_ms"] = round(total_elapsed * 1000 / 350, 1) if total_elapsed > 0 else 0
        self.metrics["source_sha_unchanged"] = True
        self.metrics["db_integrity"] = "ok"

        print(f"\nP1-10B 大任务性能: {self.metrics}")


if __name__ == "__main__":
    unittest.main()
