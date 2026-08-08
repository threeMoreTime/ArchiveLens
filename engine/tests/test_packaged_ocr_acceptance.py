"""P1-10B packaged OCR artifact provenance tests."""

from __future__ import annotations

import importlib.util
import json
import sys
import tempfile
import unittest
from pathlib import Path
from unittest import mock


ROOT = Path(__file__).resolve().parents[2]
SCRIPTS = ROOT / "scripts"
if str(SCRIPTS) not in sys.path:
    sys.path.insert(0, str(SCRIPTS))
SCRIPT = SCRIPTS / "p1-10b-packaged-ocr-acceptance.py"
SPEC = importlib.util.spec_from_file_location("p1_10b_packaged_ocr_acceptance", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
sys.modules[SPEC.name] = MODULE
SPEC.loader.exec_module(MODULE)


class PackagedOcrAcceptanceTests(unittest.TestCase):
    @staticmethod
    def _write_artifact(root: Path, name: str, commit: str = "a" * 40) -> Path:
        artifact_dir = root / name
        artifact_dir.mkdir()
        executable = artifact_dir / "archivelens-engine.exe"
        executable.write_bytes((name + "-engine").encode("ascii"))
        (artifact_dir / "app.info.json").write_text(
            json.dumps(
                {
                    "version": "test-version",
                    "git_commit": commit,
                    "protocol_version": MODULE.PROTOCOL_VERSION,
                    "build_time": "2026-08-02T00:00:00Z",
                }
            ),
            encoding="utf-8",
        )
        return executable

    def test_explicit_artifact_requires_matching_provenance_and_records_hash(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable = self._write_artifact(Path(temporary_directory), "valid")
            with (
                mock.patch.object(MODULE, "worktree_is_dirty", return_value=False),
                mock.patch.object(MODULE, "current_git_head", return_value="a" * 40),
                mock.patch.object(MODULE, "expected_engine_version", return_value="test-version"),
            ):
                artifact = MODULE.resolve_engine(str(executable))

        self.assertEqual(artifact.executable, executable.resolve())
        self.assertEqual(artifact.metadata["git_commit"], "a" * 40)
        self.assertEqual(len(artifact.sha256), 64)
        self.assertTrue(artifact.release_grade)

    def test_stale_artifact_is_rejected(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            executable = self._write_artifact(Path(temporary_directory), "stale", commit="b" * 40)
            with (
                mock.patch.object(MODULE, "worktree_is_dirty", return_value=False),
                mock.patch.object(MODULE, "current_git_head", return_value="a" * 40),
                mock.patch.object(MODULE, "expected_engine_version", return_value="test-version"),
            ):
                with self.assertRaisesRegex(MODULE.AcceptanceError, "SHA mismatch"):
                    MODULE.resolve_engine(str(executable))

    def test_default_resolution_rejects_multiple_matching_artifacts(self) -> None:
        with tempfile.TemporaryDirectory() as temporary_directory:
            root = Path(temporary_directory)
            first = self._write_artifact(root, "first")
            second = self._write_artifact(root, "second")
            with (
                mock.patch.object(MODULE, "DEFAULT_ENGINE_CANDIDATES", (first, second)),
                mock.patch.object(MODULE, "worktree_is_dirty", return_value=False),
                mock.patch.object(MODULE, "current_git_head", return_value="a" * 40),
                mock.patch.object(MODULE, "expected_engine_version", return_value="test-version"),
            ):
                with self.assertRaisesRegex(MODULE.AcceptanceError, "multiple packaged Engine artifacts"):
                    MODULE.resolve_engine(None)


if __name__ == "__main__":
    unittest.main()
