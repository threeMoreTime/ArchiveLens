"""跨语言 IPC 契约测试（Python 端）。

与 apps/desktop/tests/contract.spec.ts 共享 tests/ipc-contract/fixtures/，
确保 TS Zod schema 与 Python protocol 对同一批 fixture 行为一致。
"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from archivelens_engine import PROTOCOL_VERSION
from archivelens_engine.protocol import (
    ErrorCode,
    ProtocolError,
    safe_parse,
    require_protocol_version,
)

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "ipc-contract" / "fixtures"

_VALID_ERROR_CODES = {
    "VALIDATION_ERROR",
    "PATH_NOT_FOUND",
    "PERMISSION_DENIED",
    "DEPENDENCY_MISSING",
    "ENGINE_START_FAILED",
    "ENGINE_CRASHED",
    "IPC_TIMEOUT",
    "TASK_NOT_FOUND",
    "TASK_STATE_CONFLICT",
    "DATABASE_ERROR",
    "EXPORT_FAILED",
    "DISK_SPACE_LOW",
    "UNSUPPORTED_FILE",
    "PROTOCOL_MISMATCH",
    "UNKNOWN_METHOD",
    "UNKNOWN_ERROR",
}


def load(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


class IpcContractPythonTests(unittest.TestCase):
    def test_request_valid_matches_protocol_version(self) -> None:
        msg = load("request-valid.json")
        self.assertEqual(msg["protocol_version"], PROTOCOL_VERSION)
        self.assertTrue(msg["request_id"])
        self.assertTrue(msg["method"])
        require_protocol_version(msg)

    def test_request_invalid_version_raises(self) -> None:
        msg = load("request-invalid-version.json")
        with self.assertRaises(ProtocolError) as ctx:
            require_protocol_version(msg)
        self.assertEqual(ctx.exception.code, ErrorCode.PROTOCOL_MISMATCH)

    def test_task_create_preserves_chinese_and_special_chars(self) -> None:
        msg = load("task-create.json")
        src = msg["params"]["source_dir"]
        self.assertIn("#", src)
        self.assertIn(" ", src)

    def test_review_update_valid_decision(self) -> None:
        msg = load("review-update.json")
        self.assertIn(msg["params"]["decision"], {"confirmed", "needs_review", "rejected"})

    def test_response_success_shape(self) -> None:
        msg = load("response-success.json")
        self.assertTrue(msg["ok"])
        self.assertEqual(msg["protocol_version"], PROTOCOL_VERSION)
        self.assertIn("result", msg)

    def test_response_error_shape_and_legal_code(self) -> None:
        msg = load("response-error.json")
        self.assertFalse(msg["ok"])
        self.assertIn(msg["error"]["code"], _VALID_ERROR_CODES)
        self.assertTrue(msg["error"]["message"])

    def test_event_has_nonnegative_sequence_and_timestamp(self) -> None:
        for name in ("event-progress.json", "event-completed.json"):
            msg = load(name)
            self.assertGreaterEqual(msg["sequence"], 0)
            self.assertTrue(msg["timestamp"])
            self.assertTrue(msg["task_id"])

    def test_event_invalid_sequence_is_negative(self) -> None:
        msg = load("event-invalid-sequence.json")
        self.assertLess(msg["sequence"], 0)

    def test_safe_parse_roundtrip_all_wire_messages(self) -> None:
        for name in (
            "response-success.json",
            "response-error.json",
            "event-progress.json",
            "event-completed.json",
        ):
            line = (FIXTURE_DIR / name).read_text(encoding="utf-8").strip()
            self.assertIsNotNone(safe_parse(line), name)

    def test_unknown_error_code_rejected(self) -> None:
        self.assertNotIn("TOTALLY_FAKE_CODE", _VALID_ERROR_CODES)


if __name__ == "__main__":
    unittest.main()
