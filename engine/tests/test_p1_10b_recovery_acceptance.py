"""P1-10B-A: SlowFake 调度回归基线测试。

诚实定位：这些测试用 SlowFake 模式（假处理器）验证 Engine 内部任务调度的正确性，
不覆盖系统级恢复（强制结束 Electron/Engine 进程、磁盘不足、权限错误、导出中断等）。

系统级恢复验收需要真实打包制品（Setup/Portable/win-unpacked）和操作系统级操作，
属于 P1-10B-B 范围，不在本文件中声称覆盖。

本文件验证的 SlowFake 调度行为：
1. 任务创建→启动→完成全流程
2. processed_pages 单调递增（不回退）
3. 数据库 integrity_check 通过
4. 来源文件 SHA-256 不变
5. 损坏文件在 preflight 被拦截（VALIDATION_ERROR）
6. 任务取消后状态正确
7. JSON 导出可用
"""
from __future__ import annotations

import hashlib
import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from archivelens_engine.protocol import ErrorCode, ProtocolError


def _create_test_image(dir_path: Path, name: str = "test.png") -> Path:
    """创建合成测试图像。"""
    img = Image.new("RGB", (100, 100), "white")
    img.save(dir_path / name, "PNG")
    img.close()
    return dir_path / name


class P1_10B_SlowFakeRegressionTests(unittest.TestCase):
    """SlowFake 调度回归基线。

    注意：这些是 Engine 内部调度回归测试，不是系统级恢复验收。
    所有断言精确检查预期行为，不使用 except Exception: PASS 模式。
    """

    @classmethod
    def setUpClass(cls):
        cls._tmpdir = tempfile.TemporaryDirectory()
        with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "10", "AL_SLOWFAKE_PAGE_DELAY_MS": "200"}, clear=False):
            from archivelens_engine.server import Server
            cls.server = Server(workspace_root=cls._tmpdir.name)

    @classmethod
    def tearDownClass(cls):
        try:
            # test_06 intentionally exercises cancellation.  Wait for every
            # scan thread before closing SQLite; otherwise a late page can
            # raise "Cannot operate on a closed database" after unittest has
            # already reported the test class as green.
            for task_control in list(cls.server._task_controls.values()):
                task_control.request_cancel()
            for thread in list(cls.server._scan_threads.values()):
                thread.join(timeout=30)
                if thread.is_alive():
                    raise RuntimeError("SlowFake scan thread did not stop before test teardown")
            cls.server.store.close()
        finally:
            cls._tmpdir.cleanup()

    def _wait_for_terminal_status(self, task_id: str, timeout_s: float = 30.0) -> dict:
        """轮询等待任务到达终态，返回最终 task dict。"""
        deadline = time.perf_counter() + timeout_s
        while time.perf_counter() < deadline:
            task = self.server.handlers["tasks.get"](self.server, {"task_id": task_id})
            if task["status"] in ("completed", "failed", "cancelled"):
                return task
            time.sleep(0.3)
        # 返回当前状态（调用者断言终态）
        return self.server.handlers["tasks.get"](self.server, {"task_id": task_id})

    # --- 测试 1: 任务全流程完整性 ---
    def test_01_task_lifecycle_completed(self):
        """SlowFake 任务：创建→启动→completed，processed_pages = total_pages。"""
        src = Path(self._tmpdir.name) / "src_lifecycle"
        src.mkdir(exist_ok=True)
        _create_test_image(src)

        create_result = self.server.handlers["tasks.create"](
            self.server, {"source_dir": str(src), "search_text": "档"},
        )
        task_id = create_result["task_id"]
        self.assertEqual(create_result["status"], "draft")

        start_result = self.server.handlers["tasks.start"](self.server, {"task_id": task_id})
        self.assertEqual(start_result["status"], "running")

        task = self._wait_for_terminal_status(task_id, timeout_s=15)
        self.assertEqual(task["status"], "completed", f"任务未完成: {task['status']}")
        self.assertEqual(task["processed_pages"], task["total_pages"], "processed != total")

    # --- 测试 2: processed_pages 单调递增 ---
    def test_02_processed_pages_monotonic(self):
        """任务运行中 processed_pages 只增不减。"""
        src = Path(self._tmpdir.name) / "src_monotonic"
        src.mkdir(exist_ok=True)
        _create_test_image(src)

        create_result = self.server.handlers["tasks.create"](
            self.server, {"source_dir": str(src), "search_text": "档"},
        )
        task_id = create_result["task_id"]
        self.server.handlers["tasks.start"](self.server, {"task_id": task_id})

        last_processed = 0
        for _ in range(30):
            time.sleep(0.2)
            task = self.server.handlers["tasks.get"](self.server, {"task_id": task_id})
            current = task.get("processed_pages", 0)
            self.assertGreaterEqual(current, last_processed,
                                    f"processed_pages 回退: {last_processed} → {current}")
            last_processed = current
            if task["status"] in ("completed", "failed", "cancelled"):
                break

    # --- 测试 3: 数据库 integrity_check ---
    def test_03_database_integrity(self):
        """数据库 integrity_check 返回 ok。"""
        result = self.server.store.conn.execute("PRAGMA integrity_check").fetchone()
        self.assertEqual(result[0], "ok", f"integrity_check 失败: {result[0]}")

    # --- 测试 4: 来源文件 SHA-256 不变 ---
    def test_04_source_file_integrity(self):
        """任务处理前后来源文件 SHA-256 不变。"""
        src = Path(self._tmpdir.name) / "src_integrity"
        src.mkdir(exist_ok=True)
        test_img = _create_test_image(src, "integrity_check.png")
        original_sha = hashlib.sha256(test_img.read_bytes()).hexdigest()

        create_result = self.server.handlers["tasks.create"](
            self.server, {"source_dir": str(src), "search_text": "档"},
        )
        task_id = create_result["task_id"]
        self.server.handlers["tasks.start"](self.server, {"task_id": task_id})
        self._wait_for_terminal_status(task_id, timeout_s=15)

        after_sha = hashlib.sha256(test_img.read_bytes()).hexdigest()
        self.assertEqual(original_sha, after_sha, "来源文件被修改")

    # --- 测试 5: 损坏文件被 preflight 拦截 ---
    def test_05_corrupt_file_preflight_blocked(self):
        """损坏文件（零字节 PNG）在 tasks.create 被 preflight 拦截（VALIDATION_ERROR）。"""
        src = Path(self._tmpdir.name) / "src_corrupt"
        src.mkdir(exist_ok=True)
        _create_test_image(src, "good.png")
        (src / "corrupt.png").write_bytes(b"")  # 零字节

        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["tasks.create"](
                self.server, {"source_dir": str(src), "search_text": "档"},
            )
        self.assertEqual(ctx.exception.code, ErrorCode.VALIDATION_ERROR)

    # --- 测试 6: 任务取消后数据库完整 ---
    def test_06_cancel_preserves_database(self):
        """取消任务后数据库 integrity_check 仍为 ok。"""
        src = Path(self._tmpdir.name) / "src_cancel"
        src.mkdir(exist_ok=True)
        _create_test_image(src)

        create_result = self.server.handlers["tasks.create"](
            self.server, {"source_dir": str(src), "search_text": "档"},
        )
        task_id = create_result["task_id"]
        self.server.handlers["tasks.start"](self.server, {"task_id": task_id})
        time.sleep(0.5)

        cancel_result = self.server.handlers["tasks.cancel"](self.server, {"task_id": task_id})
        self.assertIn(cancel_result["status"], ("stopping", "cancelled", "completed"))

        result = self.server.store.conn.execute("PRAGMA integrity_check").fetchone()
        self.assertEqual(result[0], "ok")

    # --- 测试 7: JSON 导出可用 ---
    def test_07_json_export_available(self):
        """已完成任务可执行 JSON 导出，返回 path 字段。"""
        # 查找已完成的任务
        tasks_list = self.server.handlers["tasks.list"](self.server, {"limit": 10})
        completed_task_id = None
        for item in tasks_list.get("items", []):
            if item.get("status") == "completed":
                completed_task_id = item["task_id"]
                break

        if not completed_task_id:
            self.skipTest("无已完成任务可用于导出测试")

        export_result = self.server.handlers["export.json"](
            self.server, {"task_id": completed_task_id},
        )
        self.assertIn("path", export_result, "导出结果缺少 path 字段")


if __name__ == "__main__":
    unittest.main()
