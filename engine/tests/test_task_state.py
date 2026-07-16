"""TaskState 状态机单元测试。"""

from __future__ import annotations

import unittest

from archivelens_engine.runtime.task_state import (
    LEGAL_TRANSITIONS,
    TERMINAL_TASK_STATUSES,
    TaskState,
    TaskStateConflict,
    can_cancel,
    can_pause,
    can_resume,
)


class TransitionTests(unittest.TestCase):
    def test_legal_running_to_pausing_to_paused(self) -> None:
        s = TaskState(task_id="t1", status="running")
        s.transition("pausing")
        s.transition("paused")
        self.assertEqual(s.status, "paused")

    def test_paused_can_resume_to_running(self) -> None:
        s = TaskState(task_id="t1", status="paused")
        s.transition("running")
        self.assertEqual(s.status, "running")

    def test_illegal_draft_to_running_raises(self) -> None:
        s = TaskState(task_id="t1", status="draft")
        with self.assertRaises(TaskStateConflict):
            s.transition("running")

    def test_illegal_completed_to_running_raises(self) -> None:
        s = TaskState(task_id="t1", status="completed")
        with self.assertRaises(TaskStateConflict):
            s.transition("running")

    def test_running_can_recover(self) -> None:
        s = TaskState(task_id="t1", status="running")
        s.transition("recoverable")
        self.assertEqual(s.status, "recoverable")

    def test_recoverable_can_requeue(self) -> None:
        s = TaskState(task_id="t1", status="recoverable")
        s.transition("queued")
        self.assertEqual(s.status, "queued")

    def test_completed_and_cancelled_have_no_outgoing(self) -> None:
        # completed / cancelled 是真正无出口的终态；
        # failed 虽属终态（finished_at 已设），但允许用户手动重试 → queued/recoverable。
        self.assertEqual(LEGAL_TRANSITIONS["completed"], frozenset())
        self.assertEqual(LEGAL_TRANSITIONS["cancelled"], frozenset())
        self.assertIn("queued", LEGAL_TRANSITIONS["failed"])

    def test_started_at_set_on_first_running(self) -> None:
        s = TaskState(task_id="t1", status="paused")
        s.transition("running")
        self.assertIsNotNone(s.started_at)
        first = s.started_at
        s.transition("pausing")
        s.transition("running")
        # 再次进入 running 不覆盖 started_at
        self.assertEqual(s.started_at, first)

    def test_finished_at_set_on_terminal(self) -> None:
        s = TaskState(task_id="t1", status="stopping")
        s.transition("completed")
        self.assertIsNotNone(s.finished_at)


class CapabilityTests(unittest.TestCase):
    def test_can_pause_only_when_running(self) -> None:
        self.assertTrue(can_pause("running"))
        self.assertFalse(can_pause("paused"))
        self.assertFalse(can_pause("completed"))

    def test_can_resume_resumable_set(self) -> None:
        for status in ("paused", "recoverable"):
            self.assertTrue(can_resume(status), status)
        for status in ("running", "pausing", "completed", "stale", "failed"):
            self.assertFalse(can_resume(status), status)

    def test_can_cancel_until_terminal(self) -> None:
        self.assertTrue(can_cancel("running"))
        self.assertTrue(can_cancel("paused"))
        self.assertFalse(can_cancel("completed"))
        self.assertFalse(can_cancel("cancelled"))


if __name__ == "__main__":
    unittest.main()
