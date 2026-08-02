"""Engine shutdown 生命周期测试（任务 §六/§七）。

验证：
* shutdown 后新请求返回 ENGINE_SHUTTING_DOWN；
* shutdown 幂等；
* 当前 TaskControl 被 cancel（唤醒 paused）。
"""

from __future__ import annotations

import io
import json
import sqlite3
import sys
import tempfile
import threading
import time
import unittest
from contextlib import redirect_stdout
from unittest import mock

from archivelens_engine import PROTOCOL_VERSION
from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.runtime.task_control import TaskControl
from archivelens_engine.server import Server, _h_tasks_preflight
from archivelens_engine.source_preflight import PreflightCancelled


def _capture(server: Server, line: str) -> dict:
    buf = io.StringIO()
    with redirect_stdout(buf):
        server.handle_line(line)
    # stdout 可能含 event + response 多行；取含 "ok" 的响应行
    for l in reversed(buf.getvalue().splitlines()):
        l = l.strip()
        if not l:
            continue
        msg = json.loads(l)
        if "ok" in msg:
            return msg
    return {}


class ShutdownTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.server = Server(workspace_root=self.tmp)

    def tearDown(self) -> None:
        try:
            self.server.store.close()
        except Exception:
            pass
        import gc, shutil
        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _req(self, method: str, rid: str = "r1") -> str:
        return json.dumps({"protocol_version": PROTOCOL_VERSION, "request_id": rid, "method": method, "params": {}})

    def test_shutdown_rejects_new_requests(self) -> None:
        # shutdown
        msg = _capture(self.server, self._req("app.shutdown", "s1"))
        self.assertTrue(msg["ok"])
        self.assertEqual(msg["result"]["status"], "shutting_down")
        # 新请求被拒
        msg2 = _capture(self.server, self._req("app.info", "r2"))
        self.assertFalse(msg2["ok"])
        self.assertEqual(msg2["error"]["code"], ErrorCode.ENGINE_SHUTTING_DOWN)

    def test_shutdown_is_idempotent(self) -> None:
        _capture(self.server, self._req("app.shutdown", "s1"))
        msg = _capture(self.server, self._req("app.shutdown", "s2"))
        self.assertTrue(msg["ok"])
        self.assertTrue(msg["result"].get("already"))

    def test_shutdown_cancels_active_task_controls(self) -> None:
        task_id = self.server.store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="running")
        self.server.store.update_task(task_id, status="running")
        tc = TaskControl()
        self.server._task_controls[task_id] = tc
        tc.request_pause()
        self.assertTrue(tc.is_paused())
        _capture(self.server, self._req("app.shutdown", "s1"))
        # cancel 唤醒 paused
        self.assertTrue(tc.should_cancel())
        self.assertFalse(tc.is_paused())

    def test_shutdown_does_not_cancel_already_paused_tasks(self) -> None:
        task_id = self.server.store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="paused")
        self.server.store.update_task(task_id, status="paused")
        tc = TaskControl()
        self.server._task_controls[task_id] = tc
        tc.request_pause()
        self.assertTrue(tc.is_paused())

        _capture(self.server, self._req("app.shutdown", "s1"))

        self.assertFalse(tc.should_cancel())
        self.assertTrue(tc.is_paused())

    def test_engine_shutdown_event_emitted(self) -> None:
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.server.handle_line(self._req("app.shutdown", "s1"))
        lines = [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]
        events = [m for m in lines if m.get("event") == "engine.shutdown"]
        self.assertEqual(len(events), 1)

    def test_run_stops_after_shutdown_request_without_waiting_for_eof(self) -> None:
        import sys

        original_stdin = sys.stdin
        buf = io.StringIO()
        try:
            sys.stdin = io.StringIO(self._req("app.shutdown", "s1") + "\n" + self._req("app.info", "r2") + "\n")
            with redirect_stdout(buf):
                self.server.run()
        finally:
            sys.stdin = original_stdin
        lines = [json.loads(l) for l in buf.getvalue().splitlines() if l.strip()]
        responses = [m for m in lines if "ok" in m]
        self.assertEqual(len(responses), 1)
        self.assertEqual(responses[0]["request_id"], "s1")

    def test_close_releases_database_when_workers_are_stopped(self) -> None:
        self.server.close(timeout=0)
        with self.assertRaises(sqlite3.ProgrammingError):
            self.server.store.conn.execute("SELECT 1")

    def test_forced_eof_close_preserves_active_task_for_recovery(self) -> None:
        self.server.slowfake_pages = 100
        self.server.slowfake_page_delay_ms = 50
        self.server.slowfake_inter_page_delay_ms = 50
        task_id = self.server.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir="Z",
            name="recoverable",
        )
        self.server.store.update_task(task_id, status="running")
        self.server.start_scan_thread(task_id)
        deadline = time.monotonic() + 5
        while time.monotonic() < deadline:
            task = self.server.store.get_task(task_id)
            if int(task.get("processed_pages", 0)) >= 2:
                break
            time.sleep(0.01)

        original_stdin = sys.stdin
        try:
            sys.stdin = io.StringIO("")
            with redirect_stdout(io.StringIO()):
                self.server.run()
        finally:
            sys.stdin = original_stdin

        self.server.close(cancel_workers=False)
        task = self.server.store.get_task(task_id)
        self.assertIsNotNone(task)
        self.assertEqual(task["status"], "running")
        self.server.store.conn.execute("SELECT 1")

        with self.server._scan_state_lock:
            task_control = self.server._task_controls.get(task_id)
        if task_control is not None:
            task_control.request_cancel()
        for thread in self.server._worker_threads_snapshot():
            thread.join(timeout=2)
        self.server.close(timeout=2)

    def test_scan_cancel_control_is_registered_before_thread_start(self) -> None:
        task_id = self.server.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir="Z",
            name="running",
        )
        self.server.store.update_task(task_id, status="running")
        captured: list[TaskControl] = []

        def fake_run(_task_id: str, _worker_generation: int, task_control: TaskControl) -> None:
            captured.append(task_control)

        original_start = threading.Thread.start

        def shutdown_before_start() -> None:
            _capture(self.server, self._req("app.shutdown", "race"))
            thread = self.server._scan_threads[task_id]
            original_start(thread)

        with (
            mock.patch.object(self.server, "_run_scan", side_effect=fake_run),
            mock.patch.object(threading.Thread, "start", side_effect=shutdown_before_start),
        ):
            self.server.start_scan_thread(task_id)

        self.assertEqual(len(captured), 1)
        self.assertTrue(captured[0].should_cancel())

    def test_close_waits_for_running_preflight_before_closing_store(self) -> None:
        entered = threading.Event()
        release = threading.Event()

        def blocking_preflight(*_args: object, **_kwargs: object) -> tuple[dict, list]:
            entered.set()
            release.wait(timeout=5)
            raise PreflightCancelled()

        with mock.patch("archivelens_engine.server.preflight_folder", side_effect=blocking_preflight):
            started = _h_tasks_preflight(self.server, {"source_dir": self.tmp})
            self.assertTrue(entered.wait(timeout=2))
            self.server.close(timeout=0.01)
            self.server.store.conn.execute("SELECT 1")
            release.set()
            thread = self.server._preflight_jobs[started["preflight_id"]]["thread"]
            thread.join(timeout=2)
            self.assertFalse(thread.is_alive())
            self.server.close(timeout=2)

        with self.assertRaises(sqlite3.ProgrammingError):
            self.server.store.conn.execute("SELECT 1")


if __name__ == "__main__":
    unittest.main()
