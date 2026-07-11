"""WorkerState 单元测试 —— 重点覆盖“残留 checkpoint 不得误判为 running”的回归。

任务 §十二 核心修复项。
"""

from __future__ import annotations

import unittest
from pathlib import Path

from archivelens_engine.runtime.worker_state import (
    DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
    WorkerState,
    classify_worker_status,
    heartbeat_expired,
    load_worker_state,
    now_iso,
    pid_alive,
    save_worker_state,
)


class WorkerStateRoundtripTests(unittest.TestCase):
    def test_save_and_load_roundtrip_preserves_all_fields(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "worker_01" / "worker-state.json"
            state = WorkerState(
                worker_id="worker_01",
                task_id="task-1",
                status="running",
                pid=12345,
                input_file="档案1.djvu",
                processed_pages=25,
                total_pages=100,
                occurrences_found=3,
            )
            save_worker_state(path, state)
            loaded = load_worker_state(path)
            self.assertIsNotNone(loaded)
            assert loaded is not None
            self.assertEqual(loaded.status, "running")
            self.assertEqual(loaded.pid, 12345)
            self.assertEqual(loaded.processed_pages, 25)

    def test_load_missing_returns_none(self) -> None:
        self.assertIsNone(load_worker_state(Path("does-not-exist.json")))

    def test_load_corrupt_returns_none(self) -> None:
        import tempfile

        with tempfile.TemporaryDirectory() as tmp:
            path = Path(tmp) / "bad.json"
            path.write_text("{not valid json", encoding="utf-8")
            self.assertIsNone(load_worker_state(path))


class ClassifyWorkerStatusTests(unittest.TestCase):
    def test_report_completed_wins_over_running_status(self) -> None:
        state = WorkerState(status="running", pid=1)
        self.assertEqual(classify_worker_status(state, report_completed=True), "completed")

    def test_running_with_alive_pid_and_fresh_heartbeat_stays_running(self) -> None:
        state = WorkerState(status="running", pid=1, heartbeat_at=now_iso())
        self.assertEqual(
            classify_worker_status(state, pid_is_alive=True),
            "running",
        )

    def test_residual_checkpoint_must_not_be_running(self) -> None:
        # 核心回归：旧逻辑会把残留 checkpoint 当 running。
        # 这里 WorkerState.status 仍为 running，但 pid 失联 → 必须判定为 stale。
        state = WorkerState(status="running", pid=99999, heartbeat_at=now_iso())
        self.assertEqual(classify_worker_status(state, pid_is_alive=False), "stale")

    def test_running_with_expired_heartbeat_is_stale(self) -> None:
        stale_hb = "2000-01-01T00:00:00+00:00"
        state = WorkerState(status="running", pid=1, heartbeat_at=stale_hb)
        self.assertEqual(
            classify_worker_status(state, pid_is_alive=True),
            "stale",
        )

    def test_running_without_pid_is_stale(self) -> None:
        state = WorkerState(status="running", pid=None)
        self.assertEqual(classify_worker_status(state), "stale")

    def test_terminal_status_is_kept(self) -> None:
        for terminal in ("completed", "failed", "cancelled"):
            with self.subTest(terminal=terminal):
                state = WorkerState(status=terminal)
                self.assertEqual(classify_worker_status(state), terminal)

    def test_queued_and_starting_pass_through(self) -> None:
        self.assertEqual(classify_worker_status(WorkerState(status="queued")), "queued")
        self.assertEqual(classify_worker_status(WorkerState(status="starting")), "starting")

    def test_empty_status_becomes_unknown(self) -> None:
        state = WorkerState(status="")
        self.assertEqual(classify_worker_status(state), "unknown")


class HeartbeatTests(unittest.TestCase):
    def test_none_heartbeat_is_expired(self) -> None:
        self.assertTrue(heartbeat_expired(None))

    def test_fresh_heartbeat_not_expired(self) -> None:
        self.assertFalse(heartbeat_expired(now_iso()))

    def test_old_heartbeat_expired(self) -> None:
        self.assertTrue(heartbeat_expired("2000-01-01T00:00:00+00:00"))

    def test_invalid_format_is_expired(self) -> None:
        self.assertTrue(heartbeat_expired("not-a-date"))


class PidAliveTests(unittest.TestCase):
    def test_none_pid_is_not_alive(self) -> None:
        self.assertFalse(pid_alive(None))

    def test_current_process_is_alive(self) -> None:
        import os

        self.assertTrue(pid_alive(os.getpid()))

    def test_impossible_pid_is_not_alive(self) -> None:
        # 4194303 是 Windows PID 上限附近，几乎不可能存在
        self.assertFalse(pid_alive(4194303))


if __name__ == "__main__":
    unittest.main()
