"""TaskControl 协作式 pause/resume/cancel 测试（任务 §十二）。"""

from __future__ import annotations

import threading
import time
import unittest

from archivelens_engine.runtime.task_control import TaskControl


class TaskControlTests(unittest.TestCase):
    def test_pause_blocks_then_resume_releases(self) -> None:
        tc = TaskControl()
        tc.request_pause()
        self.assertTrue(tc.is_paused())

        ticks: list[int] = []

        def worker() -> None:
            tc.wait_if_paused()
            ticks.append(1)

        t = threading.Thread(target=worker)
        t.start()
        time.sleep(0.3)
        self.assertEqual(ticks, [])  # 仍被阻塞

        tc.request_resume()
        t.join(timeout=2)
        self.assertFalse(t.is_alive())
        self.assertEqual(ticks, [1])

    def test_cancel_wakes_paused_worker(self) -> None:
        tc = TaskControl()
        tc.request_pause()

        finished: list[bool] = []

        def worker() -> None:
            tc.wait_if_paused()
            finished.append(tc.should_cancel())

        t = threading.Thread(target=worker)
        t.start()
        time.sleep(0.2)
        tc.request_cancel()
        t.join(timeout=2)
        self.assertFalse(t.is_alive())
        self.assertTrue(finished[0])

    def test_not_paused_wait_returns_immediately(self) -> None:
        tc = TaskControl()
        tc.wait_if_paused()  # 不应阻塞
        self.assertFalse(tc.is_paused())


if __name__ == "__main__":
    unittest.main()
