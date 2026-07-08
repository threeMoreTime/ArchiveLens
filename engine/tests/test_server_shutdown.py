"""Engine shutdown 生命周期测试（任务 §六/§七）。

验证：
* shutdown 后新请求返回 ENGINE_SHUTTING_DOWN；
* shutdown 幂等；
* 当前 TaskControl 被 cancel（唤醒 paused）。
"""

from __future__ import annotations

import io
import json
import tempfile
import unittest
from contextlib import redirect_stdout

from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.runtime.task_control import TaskControl
from archivelens_engine.server import Server


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
        return json.dumps({"protocol_version": 1, "request_id": rid, "method": method, "params": {}})

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


if __name__ == "__main__":
    unittest.main()
