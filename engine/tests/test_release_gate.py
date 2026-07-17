from __future__ import annotations

import hashlib
import json
import shutil
import subprocess
import sys
import tempfile
import unittest
import uuid
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
GATE_SCRIPT = ROOT / "scripts" / "run-zero-cost-release-gate.ps1"
VERIFY_SCRIPT = ROOT / "scripts" / "verify-release-chain.ps1"
SMOKE_HELPER = ROOT / "scripts" / "release-smoke-evidence.ps1"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def write_file(path: Path, content: str | bytes) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    if isinstance(content, bytes):
        path.write_bytes(content)
    else:
        path.write_text(content, encoding="utf-8")


def file_manifest(root: Path) -> list[dict[str, object]]:
    return [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
        }
        for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file())
    ]


def tree_sha256(root: Path) -> str:
    lines = [f"{entry['path'].lower()}\t{entry['sha256']}" for entry in file_manifest(root)]
    return hashlib.sha256(("\n".join(lines) + "\n").encode()).hexdigest()


def ps_quote(path: Path) -> str:
    return str(path).replace("'", "''")


@unittest.skipUnless(sys.platform == "win32", "Release gate is Windows-specific")
class ReleaseGateTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.powershell = shutil.which("powershell.exe")
        if not cls.powershell:
            raise unittest.SkipTest("powershell.exe is unavailable")

    def test_gate_policy_is_complete_zero_cost_and_non_releasing(self) -> None:
        text = GATE_SCRIPT.read_text(encoding="utf-8-sig")

        for required in (
            "frozen dependency install",
            "serial Electron runtime preparation",
            "locked OCR model preparation",
            "python engine test suite",
            "complete Playwright E2E suite",
            "Setup and Portable build",
            "Setup install launch uninstall smoke",
            "Portable launch cleanup smoke",
            "complete same-SHA release chain verification",
            "RequireCompleteCandidate",
            'monetary_cost = 0',
            'formal_release_action = "NOT_PERFORMED"',
            'upgrade_rollback_status = "NOT_VERIFIED"',
            '$ErrorActionPreference = "Continue"',
            "[Management.Automation.ErrorRecord]",
            "$script:Steps.ToArray()",
            '"AL_OCR_REC_MODEL"',
            '"-OcrOnly"',
            '"install-electron"',
        ):
            self.assertIn(required, text)

        self.assertLess(
            text.index("frozen dependency install"),
            text.index("serial Electron runtime preparation"),
        )
        self.assertLess(
            text.index("serial Electron runtime preparation"),
            text.index("workspace unit tests"),
        )
        self.assertLess(
            text.index("locked OCR model preparation"),
            text.index("python engine test suite"),
        )
        self.assertLess(
            text.index("python engine test suite"),
            text.index("locked native runtime preparation"),
        )

        self.assertNotIn("--allow-partial", text)
        for forbidden in ("git push", "gh release", "gh pr create", "npm publish", "pnpm publish"):
            self.assertNotIn(forbidden, text.lower())

        installer_text = (ROOT / "scripts" / "smoke-installer.ps1").read_text(encoding="utf-8-sig")
        self.assertIn('PSObject.Properties["DisplayName"]', installer_text)

    def test_smoke_helper_rejects_paths_outside_owned_temp_prefix(self) -> None:
        with tempfile.TemporaryDirectory(prefix="archivelens-setup-smoke-unit-") as owned:
            command = f"""
. '{ps_quote(SMOKE_HELPER)}'
$safe = Assert-ReleaseSmokeOwnedRoot '{ps_quote(Path(owned))}' 'archivelens-setup-smoke-'
Write-Output ('SAFE=' + $safe)
try {{
  Assert-ReleaseSmokeOwnedRoot '{ps_quote(ROOT)}' 'archivelens-setup-smoke-' | Out-Null
  Write-Output 'UNSAFE_ACCEPTED'
  exit 3
}}
catch {{
  Write-Output 'UNSAFE_REJECTED'
}}
"""
            result = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    command,
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("SAFE=", result.stdout)
        self.assertIn("UNSAFE_REJECTED", result.stdout)
        self.assertNotIn("UNSAFE_ACCEPTED", result.stdout)

    def test_smoke_helper_can_enumerate_process_descendants_on_powershell_51(self) -> None:
        command = f"""
. '{ps_quote(SMOKE_HELPER)}'
$descendants = @(Get-ReleaseSmokeDescendants $PID)
Write-Output ('DESCENDANT_PROBE_PASS=' + $descendants.Count)
"""
        result = subprocess.run(
            [
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-Command",
                command,
            ],
            cwd=ROOT,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
        )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("DESCENDANT_PROBE_PASS=", result.stdout)

    def test_smoke_helper_stops_only_the_requested_process_tree(self) -> None:
        root_process = subprocess.Popen(
            [
                sys.executable,
                "-c",
                (
                    "import subprocess,sys,time;"
                    "subprocess.Popen([sys.executable,'-c','import time;time.sleep(60)']);"
                    "time.sleep(60)"
                ),
            ]
        )
        try:
            command = f"""
. '{ps_quote(SMOKE_HELPER)}'
Start-Sleep -Milliseconds 500
Stop-ReleaseSmokeProcessTree {root_process.pid}
Write-Output 'PROCESS_TREE_STOP_PASS'
"""
            result = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    command,
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
                timeout=20,
            )
            root_process.wait(timeout=5)
        finally:
            if root_process.poll() is None:
                subprocess.run(
                    ["taskkill.exe", "/PID", str(root_process.pid), "/T", "/F"],
                    capture_output=True,
                    check=False,
                )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("PROCESS_TREE_STOP_PASS", result.stdout)

    def test_smoke_helper_removes_only_verified_portable_extraction(self) -> None:
        with tempfile.TemporaryDirectory(prefix="archivelens-portable-extraction-unit-") as temp_dir:
            extraction = Path(temp_dir)
            desktop = extraction / "ArchiveLens.exe"
            desktop.write_bytes(b"verified portable desktop")
            command = f"""
. '{ps_quote(SMOKE_HELPER)}'
Remove-ReleaseSmokePortableExtraction '{ps_quote(extraction)}' '{sha256(desktop)}'
if (Test-Path -LiteralPath '{ps_quote(extraction)}') {{ exit 3 }}
Write-Output 'PORTABLE_EXTRACTION_CLEANUP_PASS'
"""
            result = subprocess.run(
                [
                    self.powershell,
                    "-NoProfile",
                    "-ExecutionPolicy",
                    "Bypass",
                    "-Command",
                    command,
                ],
                cwd=ROOT,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )

        self.assertEqual(0, result.returncode, result.stdout + result.stderr)
        self.assertIn("PORTABLE_EXTRACTION_CLEANUP_PASS", result.stdout)

    def test_complete_release_chain_accepts_bound_evidence_and_rejects_tampering(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            temp = Path(temp_dir)
            git_root = temp / "candidate-repo"
            artifacts = temp / "artifacts"
            git_root.mkdir()
            subprocess.run(["git", "init", "-q", str(git_root)], check=True)
            write_file(git_root / "README.md", "candidate\n")
            subprocess.run(["git", "-C", str(git_root), "add", "README.md"], check=True)
            subprocess.run(
                [
                    "git",
                    "-C",
                    str(git_root),
                    "-c",
                    "user.name=ArchiveLens Test",
                    "-c",
                    "user.email=test@example.invalid",
                    "commit",
                    "-q",
                    "-m",
                    "test candidate",
                ],
                check=True,
            )
            candidate_sha = subprocess.run(
                ["git", "-C", str(git_root), "rev-parse", "HEAD"],
                check=True,
                capture_output=True,
                text=True,
            ).stdout.strip()
            version = "0.1.0-test"

            native_root = artifacts / "native"
            clean_tesseract = native_root / "tesseract"
            clean_djvu = native_root / "djvulibre"
            bundled_resources = artifacts / "resources"
            bundled_tesseract = bundled_resources / "native" / "tesseract"
            bundled_djvu = bundled_resources / "native" / "djvulibre"

            runtime_files = {
                "tesseract.exe": b"tesseract",
                "tessdata/chi_sim.traineddata": b"chi-sim",
                "tessdata/chi_tra.traineddata": b"chi-tra",
                "tessdata/chi_sim_vert.traineddata": b"chi-sim-vert",
                "tessdata/chi_tra_vert.traineddata": b"chi-tra-vert",
            }
            for relative, content in runtime_files.items():
                write_file(clean_tesseract / relative, content)
                write_file(bundled_tesseract / relative, content)
            for relative, content in {
                "ddjvu.exe": b"ddjvu",
                "djvused.exe": b"djvused",
            }.items():
                write_file(clean_djvu / relative, content)
                write_file(bundled_djvu / relative, content)

            notice_files = {
                "Tesseract/LICENSE.txt": "Apache-2.0\n",
                "Tesseract-Windows-Build/AUTHORS.txt": "authors\n",
                "Tesseract-Windows-Build/BUILD-README.md": "build\n",
                "tessdata_fast/LICENSE.txt": "Apache-2.0\n",
                "DjVuLibre/COPYING.txt": "GPL-2.0-only\n",
            }
            for relative, content in notice_files.items():
                write_file(native_root / "licenses" / relative, content)
                write_file(bundled_resources / "licenses" / relative, content)

            source_relative = "djvulibre/djvulibre-3.5.29.tar.gz"
            write_file(native_root / "sources" / source_relative, b"djvu-source")
            write_file(bundled_resources / "sources" / source_relative, b"djvu-source")
            write_file(native_root / "native-dependencies.lock.json", '{"schema_version":1}\n')
            write_file(bundled_resources / "native-dependencies.lock.json", '{"schema_version":1}\n')

            engine = artifacts / "engine" / "archivelens-engine.exe"
            desktop = artifacts / "desktop" / "ArchiveLens.exe"
            bundled_engine = bundled_resources / "engine" / "win-x64" / "archivelens-engine.exe"
            setup = artifacts / "ArchiveLens-test-setup.exe"
            portable = artifacts / "ArchiveLens-test-portable.exe"
            for path, content in (
                (engine, b"engine"),
                (desktop, b"desktop"),
                (bundled_engine, b"engine"),
                (setup, b"setup"),
                (portable, b"portable"),
            ):
                write_file(path, content)

            engine_info = artifacts / "engine-app.info.json"
            desktop_info = bundled_resources / "app.info.json"
            metadata = {"git_commit": candidate_sha, "version": version}
            write_file(engine_info, json.dumps(metadata))
            write_file(desktop_info, json.dumps(metadata))

            tesseract_notices = [
                {
                    "path": relative,
                    "sha256": sha256(native_root / "licenses" / relative),
                    "bytes": (native_root / "licenses" / relative).stat().st_size,
                }
                for relative in (
                    "Tesseract/LICENSE.txt",
                    "Tesseract-Windows-Build/AUTHORS.txt",
                    "Tesseract-Windows-Build/BUILD-README.md",
                    "tessdata_fast/LICENSE.txt",
                )
            ]
            djvu_notices = [
                {
                    "path": "DjVuLibre/COPYING.txt",
                    "sha256": sha256(native_root / "licenses" / "DjVuLibre/COPYING.txt"),
                    "bytes": (native_root / "licenses" / "DjVuLibre/COPYING.txt").stat().st_size,
                }
            ]
            tesseract_tree = tree_sha256(clean_tesseract)
            djvu_tree = tree_sha256(clean_djvu)
            manifest = {
                "git_commit": candidate_sha,
                "version": version,
                "engine_sha256": sha256(engine),
                "desktop_sha256": sha256(desktop),
                "setup_sha256": sha256(setup),
                "portable_sha256": sha256(portable),
                "native_lock_sha256": sha256(native_root / "native-dependencies.lock.json"),
                "native_dependencies": [
                    {
                        "name": "tesseract",
                        "runtime_tree_sha256": tesseract_tree,
                        "runtime_files": file_manifest(clean_tesseract),
                        "license_files": tesseract_notices,
                    },
                    {
                        "name": "djvulibre",
                        "runtime_tree_sha256": djvu_tree,
                        "runtime_files": file_manifest(clean_djvu),
                        "license_files": djvu_notices,
                        "corresponding_source_sha256": sha256(native_root / "sources" / source_relative),
                    },
                ],
                "test_summary": {
                    "schema_version": 1,
                    "scope": "local-zero-cost-non-release",
                    "candidate_sha": candidate_sha,
                    "monetary_cost": 0,
                    "formal_release_action": "NOT_PERFORMED",
                    "steps": [{"name": "fixture gate", "status": "PASS"}],
                },
            }
            manifest_path = artifacts / "release-manifest.json"
            write_file(manifest_path, json.dumps(manifest))

            evidence_base = {
                "status": "PASS",
                "candidate_sha": candidate_sha,
                "version": version,
                "application_ready": True,
                "process_cleanup": "PASS",
                "resource_evidence": {
                    "desktop_sha256": sha256(desktop),
                    "engine_sha256": sha256(engine),
                    "native_tesseract_tree_sha256": tesseract_tree,
                    "native_djvulibre_tree_sha256": djvu_tree,
                    "license_gate_status": "PASS",
                    "offline_native_status": "PASS",
                },
            }
            setup_evidence = dict(evidence_base)
            setup_evidence["kind"] = "setup"
            setup_evidence["uninstall"] = "PASS"
            setup_evidence["resource_evidence"] = dict(evidence_base["resource_evidence"])
            setup_evidence["resource_evidence"]["artifact_sha256"] = sha256(setup)
            portable_evidence = dict(evidence_base)
            portable_evidence["kind"] = "portable"
            portable_evidence["extraction_cleanup"] = "PASS"
            portable_evidence["extraction_cleanup_mode"] = "GATE_OWNED_DIRECTORY"
            portable_evidence["resource_evidence"] = dict(evidence_base["resource_evidence"])
            portable_evidence["resource_evidence"]["artifact_sha256"] = sha256(portable)
            setup_evidence_path = artifacts / "setup-smoke.json"
            portable_evidence_path = artifacts / "portable-smoke.json"
            write_file(setup_evidence_path, json.dumps(setup_evidence))
            write_file(portable_evidence_path, json.dumps(portable_evidence))

            command = [
                self.powershell,
                "-NoProfile",
                "-ExecutionPolicy",
                "Bypass",
                "-File",
                str(VERIFY_SCRIPT),
                "-CandidateSha",
                candidate_sha,
                "-Version",
                version,
                "-WorktreePath",
                str(git_root),
                "-EngineAppInfo",
                str(engine_info),
                "-DesktopAppInfo",
                str(desktop_info),
                "-ManifestPath",
                str(manifest_path),
                "-EngineExe",
                str(engine),
                "-DesktopExe",
                str(desktop),
                "-BundledEngineExe",
                str(bundled_engine),
                "-NativeRoot",
                str(native_root),
                "-BundledResourcesRoot",
                str(bundled_resources),
                "-SetupExe",
                str(setup),
                "-PortableExe",
                str(portable),
                "-SetupEvidenceJson",
                str(setup_evidence_path),
                "-PortableEvidenceJson",
                str(portable_evidence_path),
                "-RequireCompleteCandidate",
            ]
            passed = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertEqual(0, passed.returncode, passed.stdout + passed.stderr)
            self.assertEqual(candidate_sha, json.loads(passed.stdout)["candidate_sha"])

            setup.write_bytes(b"tampered")
            rejected = subprocess.run(
                command,
                capture_output=True,
                text=True,
                encoding="utf-8",
                errors="replace",
            )
            self.assertNotEqual(0, rejected.returncode)
            self.assertIn("RELEASE_ARTIFACT_HASH_MISMATCH", rejected.stdout + rejected.stderr)


if __name__ == "__main__":
    unittest.main()
