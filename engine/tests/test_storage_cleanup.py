"""B4 本地数据清理边界：只重试数据库登记的终态导出临时残留。"""

from __future__ import annotations

import os
import shutil
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import CleanupError, Server


class StorageCleanupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.root = Path(tempfile.mkdtemp(prefix="archivelens-storage-cleanup-"))
        with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}):
            self.server = Server(workspace_root=self.root)
        self.task_id = self.server.store.create_task(
            source_dir=str(self.root / "source"),
            name="local-data-test",
            status="completed",
            search_terms=["档"],
            search_mode="exact_literal",
        )

    def tearDown(self) -> None:
        self.server.store.close()
        shutil.rmtree(self.root, ignore_errors=True)

    def _temp_for(self, export_id: str) -> Path:
        temporary = self.root / ".export-jobs" / export_id
        temporary.mkdir(parents=True, exist_ok=True)
        (temporary / "partial").write_text("temporary", encoding="utf-8")
        self.server.store.update_export_job(export_id, temporary_path=str(temporary))
        return temporary

    def test_manual_cleanup_cleans_terminal_jobs_preserves_success_and_skips_active(self) -> None:
        failed = self.server.store.create_export_job(task_id=self.task_id, format="html")
        self.server.store.finish_export_job(failed["export_id"], status="failed")
        failed_temp = self._temp_for(failed["export_id"])

        completed = self.server.store.create_export_job(task_id=self.task_id, format="json")
        final = self.root / "tasks" / self.task_id / "exports" / "kept-report.json"
        final.parent.mkdir(parents=True, exist_ok=True)
        final.write_text("successful", encoding="utf-8")
        self.assertTrue(
            self.server.store.complete_export_job(
                completed["export_id"],
                task_id=self.task_id,
                kind="json",
                path=str(final),
                progress_completed=1,
                progress_total=1,
            )
        )
        completed_temp = self._temp_for(completed["export_id"])

        active = self.server.store.create_export_job(task_id=self.task_id, format="review")
        active_temp = self._temp_for(active["export_id"])

        result = self.server.handlers["storage.cleanupTemporary"](self.server, {})

        self.assertEqual(result, {
            "attempted": 2,
            "completed": 2,
            "failed": 0,
            "skipped_active": 1,
            "remaining": 0,
        })
        self.assertFalse(failed_temp.exists())
        self.assertFalse(completed_temp.exists())
        self.assertTrue(active_temp.exists())
        self.assertEqual(final.read_text(encoding="utf-8"), "successful")
        self.assertEqual(
            self.server.store.get_export_job(completed["export_id"])["cleanup_status"],
            "completed",
        )

    def test_manual_cleanup_rejects_parameters(self) -> None:
        with self.assertRaises(ProtocolError) as context:
            self.server.handlers["storage.cleanupTemporary"](self.server, {"path": "C:\\"})
        self.assertEqual(context.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_manual_cleanup_reports_failure_and_keeps_retryable_state(self) -> None:
        failed = self.server.store.create_export_job(task_id=self.task_id, format="html")
        self.server.store.finish_export_job(failed["export_id"], status="failed")
        temporary = self._temp_for(failed["export_id"])
        with patch(
            "archivelens_engine.server._cleanup_export_temp",
            side_effect=CleanupError("PERMISSION_DENIED", "injected private path"),
        ):
            result = self.server.handlers["storage.cleanupTemporary"](self.server, {})

        self.assertEqual(result["attempted"], 1)
        self.assertEqual(result["completed"], 0)
        self.assertEqual(result["failed"], 1)
        self.assertEqual(result["remaining"], 1)
        self.assertTrue(temporary.exists())
        job = self.server.store.get_export_job(failed["export_id"])
        self.assertEqual(job["cleanup_status"], "failed")
        self.assertNotIn("private path", job["cleanup_error_message"])


if __name__ == "__main__":
    unittest.main()
