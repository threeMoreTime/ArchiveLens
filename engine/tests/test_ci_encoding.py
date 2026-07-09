"""CI 编码兼容回归测试。"""

from __future__ import annotations

import importlib.util
import io
import sys
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_STATUS_GLYPHS = ("✓", "✗", "✔", "✘", "→", "⚠", "❌", "✅")
CI_SMOKE_SCRIPTS = [
    ROOT / "scripts" / "html-smoke.py",
    ROOT / "scripts" / "packaged-ocr-smoke.py",
    ROOT / "scripts" / "shutdown-inference-smoke.py",
]
SMOKE_OUTPUT = ROOT / "scripts" / "smoke_output.py"


class CiEncodingTests(unittest.TestCase):
    @staticmethod
    def _load_smoke_output_module():
        spec = importlib.util.spec_from_file_location("archivelens_smoke_output", SMOKE_OUTPUT)
        assert spec and spec.loader
        module = importlib.util.module_from_spec(spec)
        spec.loader.exec_module(module)
        return module

    def test_ci_smoke_scripts_do_not_use_non_ascii_status_glyphs(self) -> None:
        violations: list[str] = []
        for path in CI_SMOKE_SCRIPTS:
            text = path.read_text(encoding="utf-8")
            for no, line in enumerate(text.splitlines(), 1):
                if not any(token in line for token in ('print(', 'sys.stdout', 'sys.stderr', 'Write-', 'console.')):
                    continue
                if any(glyph in line for glyph in FORBIDDEN_STATUS_GLYPHS):
                    violations.append(f"{path.relative_to(ROOT)}:{no}: {line.strip()}")

        self.assertEqual([], violations, "CI smoke scripts must use ASCII-only status markers")

    def test_log_status_is_safe_with_cp1252_like_stdout(self) -> None:
        module = self._load_smoke_output_module()

        class StrictCp1252Stdout:
            def __init__(self) -> None:
                self.buffer = io.BytesIO()

            def write(self, message: str) -> int:
                message.encode("cp1252", errors="strict")
                return self.buffer.write(message.encode("cp1252"))

            def flush(self) -> None:
                return None

        fake_stdout = StrictCp1252Stdout()
        original_stdout = sys.stdout
        try:
            sys.stdout = fake_stdout
            module.log_status("pass", "html smoke status line")
        finally:
            sys.stdout = original_stdout

        self.assertEqual(fake_stdout.buffer.getvalue().decode("ascii"), "[PASS] html smoke status line\n")


if __name__ == "__main__":
    unittest.main()
