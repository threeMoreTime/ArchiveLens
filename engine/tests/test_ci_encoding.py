"""CI 编码兼容回归测试。"""

from __future__ import annotations

import importlib.util
import io
import json
import os
import shutil
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
FORBIDDEN_STATUS_GLYPHS = ("✓", "✗", "✔", "✘", "→", "⚠", "❌", "✅")
CI_SMOKE_SCRIPTS = [
    ROOT / "scripts" / "html-smoke.py",
    ROOT / "scripts" / "packaged-ocr-smoke.py",
    ROOT / "scripts" / "shutdown-inference-smoke.py",
]
POWERSHELL_RELEASE_SCRIPTS = [
    ROOT / "scripts" / "build-engine.ps1",
    ROOT / "scripts" / "release-smoke-evidence.ps1",
    ROOT / "scripts" / "run-zero-cost-release-gate.ps1",
    ROOT / "scripts" / "verify-release-chain.ps1",
    ROOT / "scripts" / "smoke-installer.ps1",
    ROOT / "scripts" / "smoke-portable.ps1",
    ROOT / "scripts" / "cleanup-test-artifacts.ps1",
]
FORBIDDEN_POWERSHELL_OUTPUT_CHARS = FORBIDDEN_STATUS_GLYPHS + ("“", "”", "‘", "’")
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

    def test_release_powershell_scripts_use_utf8_bom(self) -> None:
        violations: list[str] = []
        utf8_bom = b"\xef\xbb\xbf"
        for path in POWERSHELL_RELEASE_SCRIPTS:
            if not path.read_bytes().startswith(utf8_bom):
                violations.append(str(path.relative_to(ROOT)))

        self.assertEqual([], violations, "Release PowerShell scripts must use UTF-8 BOM for Windows PowerShell 5.1")

    def test_release_powershell_output_lines_are_ascii_safe(self) -> None:
        violations: list[str] = []
        output_tokens = ("Write-Host", "Write-Output", "Write-Warning", "Write-Error", "throw", "Fail ")
        for path in POWERSHELL_RELEASE_SCRIPTS:
            text = path.read_text(encoding="utf-8-sig")
            for no, line in enumerate(text.splitlines(), 1):
                if not any(token in line for token in output_tokens):
                    continue
                if any(char in line for char in FORBIDDEN_POWERSHELL_OUTPUT_CHARS):
                    violations.append(f"{path.relative_to(ROOT)}:{no}: {line.strip()}")
                    continue
                if any(ord(char) > 127 for char in line):
                    violations.append(f"{path.relative_to(ROOT)}:{no}: {line.strip()}")

        self.assertEqual([], violations, "Release PowerShell output lines must be ASCII-safe")

    def test_windows_powershell_can_parse_release_scripts(self) -> None:
        if sys.platform != "win32":
            self.skipTest("Windows PowerShell parser check only runs on Windows")

        powershell = shutil.which("powershell.exe")
        if not powershell:
            self.skipTest("powershell.exe is unavailable")

        parser_script = """
$ErrorActionPreference = 'Stop'
$scripts = @(
  'scripts/build-engine.ps1',
  'scripts/release-smoke-evidence.ps1',
  'scripts/run-zero-cost-release-gate.ps1',
  'scripts/verify-release-chain.ps1',
  'scripts/smoke-installer.ps1',
  'scripts/smoke-portable.ps1',
  'scripts/cleanup-test-artifacts.ps1'
)
foreach ($script in $scripts) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $script),
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) {
    $errors | Format-List * | Out-String | Write-Output
    exit 1
  }
}
Write-Output 'WINDOWS_POWERSHELL_PARSE_PASS'
"""
        result = subprocess.run(
            [powershell, "-NoProfile", "-ExecutionPolicy", "Bypass", "-Command", parser_script],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("WINDOWS_POWERSHELL_PARSE_PASS", result.stdout)

    def test_cleanup_script_resolves_repo_root_from_its_own_location(self) -> None:
        if sys.platform != "win32":
            self.skipTest("cleanup integration check only runs on Windows")

        powershell = shutil.which("powershell.exe")
        if not powershell:
            self.skipTest("powershell.exe is unavailable")

        run_id = "a11-cleanup-default-root-test"
        with tempfile.TemporaryDirectory() as tmp:
            fake_repo = Path(tmp) / "repo"
            script_dir = fake_repo / "scripts"
            report_dir = fake_repo / "apps" / "desktop" / "test-results"
            script_dir.mkdir(parents=True)
            report_dir.mkdir(parents=True)
            shutil.copy2(ROOT / "scripts" / "cleanup-test-artifacts.ps1", script_dir)
            (report_dir / ".archivelens-runid").write_text(run_id, encoding="utf-8")

            result = subprocess.run(
                [
                    powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-File",
                    str(script_dir / "cleanup-test-artifacts.ps1"),
                    "-RunId",
                    run_id,
                ],
                cwd=Path(tmp),
                capture_output=True,
                text=True,
                encoding="utf-8-sig",
            )
            self.assertEqual(0, result.returncode, result.stdout + result.stderr)
            payload = json.loads(result.stdout)
            self.assertEqual(payload["mode"], "dry-run")
            self.assertEqual(payload["found"], 1)
            self.assertTrue(os.path.samefile(payload["paths"][0]["Path"], report_dir))

    def test_powershell_7_can_parse_release_scripts_when_available(self) -> None:
        if sys.platform != "win32":
            self.skipTest("PowerShell 7 parser check only runs on Windows")

        pwsh = shutil.which("pwsh")
        if not pwsh:
            self.skipTest("pwsh is unavailable")

        parser_script = """
$ErrorActionPreference = 'Stop'
$scripts = @(
  'scripts/build-engine.ps1',
  'scripts/release-smoke-evidence.ps1',
  'scripts/run-zero-cost-release-gate.ps1',
  'scripts/verify-release-chain.ps1',
  'scripts/smoke-installer.ps1',
  'scripts/smoke-portable.ps1',
  'scripts/cleanup-test-artifacts.ps1'
)
foreach ($script in $scripts) {
  $tokens = $null
  $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile(
    (Resolve-Path $script),
    [ref]$tokens,
    [ref]$errors
  )
  if ($errors.Count -gt 0) {
    $errors | Format-List * | Out-String | Write-Output
    exit 1
  }
}
Write-Output 'POWERSHELL_7_PARSE_PASS'
"""
        result = subprocess.run(
            [pwsh, "-NoProfile", "-Command", parser_script],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("POWERSHELL_7_PARSE_PASS", result.stdout)


if __name__ == "__main__":
    unittest.main()
