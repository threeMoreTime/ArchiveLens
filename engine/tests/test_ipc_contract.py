"""跨语言 IPC 契约测试（Python 端）。

与 apps/desktop/tests/contract.spec.ts 共享 tests/ipc-contract/fixtures/，
确保 TS Zod schema 与 Python protocol 对同一批 fixture 行为一致。
"""

from __future__ import annotations

import json
import os
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from PIL import Image

from archivelens_engine import PROTOCOL_VERSION
from archivelens_engine.protocol import (
    ErrorCode,
    ProtocolError,
    safe_parse,
    require_protocol_version,
)
from archivelens_engine.search_terms import normalize_search_text
from archivelens_engine.server import Server, _h_tasks_create

FIXTURE_DIR = Path(__file__).resolve().parents[2] / "tests" / "ipc-contract" / "fixtures"
VALIDATION_CASES = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "tests"
        / "search-terms"
        / "validation-cases.json"
    ).read_text(encoding="utf-8")
)

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
    "ENGINE_SHUTTING_DOWN",
    "ENGINE_STOPPED",
    "SOURCE_EVIDENCE_UNAVAILABLE",
    "SOURCE_FILE_CHANGED",
    "PAGE_RENDER_LIMIT_EXCEEDED",
    "OCR_CORPUS_UNAVAILABLE",
    "PREFLIGHT_STALE",
}


def load(name: str) -> dict:
    return json.loads((FIXTURE_DIR / name).read_text(encoding="utf-8"))


def build_string_from_codepoints(codepoints: list[int]) -> str:
    return "".join(chr(codepoint) for codepoint in codepoints)


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
        self.assertEqual(normalize_search_text(msg["params"]["search_text"]), "档案管理")

    def test_search_text_matches_shared_fixture(self) -> None:
        for case in VALIDATION_CASES["search_text_cases"]:
            value = build_string_from_codepoints(case["input_codepoints"])
            with self.subTest(case=case["id"]):
                if case["valid"]:
                    self.assertEqual(normalize_search_text(value), case["normalized"])
                else:
                    with self.assertRaisesRegex(ValueError, f"^{case['error']}$"):
                        normalize_search_text(value)

    def test_parallel_workers_only_accepts_integer_one(self) -> None:
        with tempfile.TemporaryDirectory() as tmpdir:
            src = Path(tmpdir) / "src"
            src.mkdir()
            image = Image.new("RGB", (8, 8), "white")
            try:
                image.save(src / "page.png", "PNG")
            finally:
                image.close()
            with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}):
                server = Server(workspace_root=tmpdir)
            try:
                for case in VALIDATION_CASES["parallel_workers_cases"]:
                    params = {"source_dir": str(src), "search_text": "档案"}
                    if not case.get("omit"):
                        params["parallel_workers"] = case["value"]
                    with self.subTest(case=case["id"]):
                        if case["valid"]:
                            result = _h_tasks_create(server, params)
                            self.assertEqual(result["status"], "draft")
                        else:
                            with self.assertRaises(ProtocolError) as ctx:
                                _h_tasks_create(server, params)
                            self.assertEqual(ctx.exception.code, ErrorCode.VALIDATION_ERROR)
            finally:
                server.store.close()

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
