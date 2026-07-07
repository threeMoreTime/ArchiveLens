"""IPC 协议层单元测试。

覆盖：消息解析、序列化、协议版本校验、错误模型。
与 Renderer 侧 Zod schema 构成契约（见 tests/ipc-contract）。
"""

from __future__ import annotations

import json
import unittest

from archivelens_engine import PROTOCOL_VERSION
from archivelens_engine.protocol import (
    ErrorCode,
    ProtocolError,
    make_error,
    make_event,
    make_success,
    require_protocol_version,
    safe_parse,
)


class SafeParseTests(unittest.TestCase):
    def test_safe_parse_valid_json_object(self) -> None:
        msg = safe_parse('{"a": 1}')
        self.assertEqual(msg, {"a": 1})

    def test_safe_parse_invalid_json_returns_none(self) -> None:
        self.assertIsNone(safe_parse("not json {"))

    def test_safe_parse_empty_line_returns_none(self) -> None:
        self.assertIsNone(safe_parse(""))
        self.assertIsNone(safe_parse("   \n"))

    def test_safe_parse_non_object_returns_none(self) -> None:
        # 数组、字符串、数字不是合法消息体
        self.assertIsNone(safe_parse("[1, 2, 3]"))
        self.assertIsNone(safe_parse('"hello"'))
        self.assertIsNone(safe_parse("42"))


class SerializationTests(unittest.TestCase):
    def test_make_success_shape_and_protocol_version(self) -> None:
        line = make_success("req-1", {"documents": 3})
        obj = json.loads(line)
        self.assertEqual(obj["protocol_version"], PROTOCOL_VERSION)
        self.assertTrue(obj["ok"])
        self.assertEqual(obj["request_id"], "req-1")
        self.assertEqual(obj["result"], {"documents": 3})

    def test_make_success_default_result_is_empty(self) -> None:
        obj = json.loads(make_success("req-2"))
        self.assertEqual(obj["result"], {})

    def test_make_error_carries_code_message_details(self) -> None:
        line = make_error("req-3", ErrorCode.DEPENDENCY_MISSING, "缺少繁体语言包", {"lang": "chi_tra"})
        obj = json.loads(line)
        self.assertFalse(obj["ok"])
        self.assertEqual(obj["error"]["code"], ErrorCode.DEPENDENCY_MISSING)
        self.assertEqual(obj["error"]["details"], {"lang": "chi_tra"})

    def test_make_error_allows_null_request_id(self) -> None:
        # 无效 JSON 无 request_id 时，Main 侧仍需可序列化错误
        obj = json.loads(make_error(None, ErrorCode.UNKNOWN_ERROR, "x"))
        self.assertIsNone(obj["request_id"])

    def test_make_event_shape(self) -> None:
        line = make_event("task.progress", task_id="t-1", payload={"done": 5})
        obj = json.loads(line)
        self.assertEqual(obj["event"], "task.progress")
        self.assertEqual(obj["task_id"], "t-1")
        self.assertEqual(obj["payload"], {"done": 5})
        self.assertNotIn("request_id", obj)

    def test_messages_are_single_line_and_utf8(self) -> None:
        # 中文不得破坏 JSON Lines 单行约束
        line = make_success("r", {"label": "已确认"})
        self.assertEqual(line.count("\n"), 0)
        self.assertIn("已确认", line)


class ProtocolVersionTests(unittest.TestCase):
    def test_require_protocol_version_matches(self) -> None:
        require_protocol_version({"protocol_version": PROTOCOL_VERSION})

    def test_require_protocol_version_mismatch_raises(self) -> None:
        with self.assertRaises(ProtocolError) as ctx:
            require_protocol_version({"protocol_version": 999})
        self.assertEqual(ctx.exception.code, ErrorCode.PROTOCOL_MISMATCH)
        self.assertEqual(ctx.exception.details["expected"], PROTOCOL_VERSION)


if __name__ == "__main__":
    unittest.main()
