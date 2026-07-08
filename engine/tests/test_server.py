"""JSONL server 单元测试。

覆盖：成功响应、未知方法、协议版本不匹配、无效 JSON 兜底、diagnostics 方法、ready 事件。
"""

from __future__ import annotations

import io
import json
import os
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

from archivelens_engine import PROTOCOL_VERSION, __version__
from archivelens_engine.protocol import ErrorCode
from archivelens_engine.server import Server


def _capture(server: Server, line: str) -> list[dict]:
    """让 server 处理一行，返回其写到 stdout 的所有 JSON 消息。"""
    buf = io.StringIO()
    with redirect_stdout(buf):
        server.handle_line(line)
    return [json.loads(raw) for raw in buf.getvalue().splitlines() if raw.strip()]


class ServerDispatchTests(unittest.TestCase):
    def setUp(self) -> None:
        # Server 构造不触发 RapidOCR 初始化，可安全构造。
        self.server = Server()

    def test_app_info_returns_engine_and_protocol_version(self) -> None:
        line = json.dumps(
            {"protocol_version": PROTOCOL_VERSION, "request_id": "r1", "method": "app.info", "params": {}}
        )
        msgs = _capture(self.server, line)
        self.assertEqual(len(msgs), 1)
        msg = msgs[0]
        self.assertTrue(msg["ok"])
        self.assertEqual(msg["request_id"], "r1")
        self.assertEqual(msg["result"]["protocol_version"], PROTOCOL_VERSION)
        self.assertEqual(msg["result"]["engine_version"], __version__)

    def test_unknown_method_returns_error(self) -> None:
        line = json.dumps(
            {"protocol_version": PROTOCOL_VERSION, "request_id": "r2", "method": "nope", "params": {}}
        )
        msgs = _capture(self.server, line)
        self.assertFalse(msgs[0]["ok"])
        self.assertEqual(msgs[0]["error"]["code"], ErrorCode.UNKNOWN_METHOD)
        self.assertEqual(msgs[0]["request_id"], "r2")

    def test_protocol_version_mismatch_returns_error(self) -> None:
        line = json.dumps(
            {"protocol_version": 999, "request_id": "r3", "method": "app.info", "params": {}}
        )
        msgs = _capture(self.server, line)
        self.assertEqual(msgs[0]["error"]["code"], ErrorCode.PROTOCOL_MISMATCH)

    def test_invalid_json_does_not_crash_or_respond(self) -> None:
        # 无效 JSON 无 request_id，server 应静默（仅写 stderr），stdout 无输出
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.server.handle_line("not-json{")
        self.assertEqual(buf.getvalue(), "")

    def test_params_not_object_returns_validation_error(self) -> None:
        line = json.dumps(
            {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": "r4",
                "method": "app.info",
                "params": "not-an-object",
            }
        )
        msgs = _capture(self.server, line)
        self.assertEqual(msgs[0]["error"]["code"], ErrorCode.VALIDATION_ERROR)

    def test_diagnostics_returns_check_list(self) -> None:
        line = json.dumps(
            {"protocol_version": PROTOCOL_VERSION, "request_id": "r5", "method": "diagnostics.run", "params": {}}
        )
        msgs = _capture(self.server, line)
        result = msgs[0]["result"]
        self.assertIn("overall", result)
        self.assertIn("checks", result)
        keys = {c["key"] for c in result["checks"]}
        self.assertIn("tesseract", keys)
        self.assertIn("djvulibre", keys)


class ServerReadyEventTests(unittest.TestCase):
    def test_run_emits_ready_thenProcesses(self) -> None:
        # 用有限 stdin 验证 ready 事件先于请求响应
        import sys

        server = Server()
        original_stdin = sys.stdin
        buf = io.StringIO()
        try:
            sys.stdin = io.StringIO(
                json.dumps({"protocol_version": PROTOCOL_VERSION, "request_id": "x", "method": "app.info", "params": {}})
                + "\n"
            )
            with redirect_stdout(buf):
                server.run()
        finally:
            sys.stdin = original_stdin
        lines = [json.loads(raw) for raw in buf.getvalue().splitlines() if raw.strip()]
        self.assertEqual(lines[0]["event"], "engine.ready")
        self.assertEqual(lines[0]["payload"]["protocol_version"], PROTOCOL_VERSION)
        self.assertTrue(lines[1]["ok"])


class ServerWorkspaceOverrideTests(unittest.TestCase):
    def test_workspace_root_defaults_to_al_workspace_root_env(self) -> None:
        tmp = tempfile.mkdtemp()
        previous = os.environ.get("AL_WORKSPACE_ROOT")
        os.environ["AL_WORKSPACE_ROOT"] = tmp
        try:
            server = Server()
            try:
                self.assertEqual(server.workspace_root, Path(tmp))
                self.assertEqual(server.store.db_path, Path(tmp) / "archivelens.db")
            finally:
                server.store.close()
        finally:
            if previous is None:
                os.environ.pop("AL_WORKSPACE_ROOT", None)
            else:
                os.environ["AL_WORKSPACE_ROOT"] = previous
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
