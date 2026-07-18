"""B3 folder preflight safety, lifecycle and create-time revalidation tests."""

from __future__ import annotations

import os
import shutil
import subprocess
import sys
import tempfile
import threading
import time
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from archivelens_engine.config import DEFAULT_CONFIG
from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import (
    Server,
    _h_tasks_create,
    _h_tasks_preflight,
    _h_tasks_preflight_cancel,
    _h_tasks_preflight_get,
)
from archivelens_engine.source_preflight import PreflightCancelled, preflight_folder


def _png(path: Path, size: tuple[int, int] = (8, 8)) -> None:
    image = Image.new("RGB", size, "white")
    try:
        image.save(path, "PNG")
    finally:
        image.close()


class SourcePreflightTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="archivelens-preflight-"))
        self.source = self.tmp / "source"
        self.workspace = self.tmp / "workspace"
        self.source.mkdir()
        self.workspace.mkdir()

    def tearDown(self) -> None:
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_valid_folder_reports_formats_pages_bytes_and_stable_token(self) -> None:
        _png(self.source / "page.png")
        (self.source / "notes.txt").write_text("not a source", encoding="utf-8")
        first, manifest = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        second, _ = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        self.assertTrue(first["can_create"])
        self.assertEqual(first["supported_file_count"], 1)
        self.assertEqual(first["unsupported_file_count"], 1)
        self.assertEqual(first["known_pages"], 1)
        self.assertEqual(first["format_counts"]["png"], 1)
        self.assertGreater(first["total_bytes"], 0)
        self.assertEqual(first["scan_token"], second["scan_token"])
        self.assertEqual(manifest[0]["display_path"], "page.png")

    def test_spoofed_extension_is_blocking_invalid_file(self) -> None:
        (self.source / "fake.png").write_bytes(b"not a png")
        report, manifest = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        self.assertFalse(report["can_create"])
        self.assertIn("INVALID_FILES", report["blocking_codes"])
        self.assertEqual(report["invalid_file_count"], 1)
        self.assertEqual(manifest, [])

    def test_disk_shortage_blocks_creation(self) -> None:
        _png(self.source / "page.png")
        with mock.patch("archivelens_engine.source_preflight.shutil.disk_usage", return_value=mock.Mock(free=1)):
            report, _ = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        self.assertFalse(report["can_create"])
        self.assertIn("DISK_SPACE_LOW", report["blocking_codes"])

    def test_large_folder_is_soft_warning_not_hard_200_limit(self) -> None:
        _png(self.source / "a.png")
        _png(self.source / "b.png")
        with mock.patch("archivelens_engine.source_preflight.LARGE_FILE_COUNT", 1):
            report, manifest = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        self.assertTrue(report["can_create"])
        self.assertTrue(report["requires_confirmation"])
        self.assertIn("LARGE_FILE_COUNT", report["confirmation_codes"])
        self.assertEqual(len(manifest), 2)

    def test_document_over_500_pages_requires_confirmation(self) -> None:
        _png(self.source / "volume.png")
        with mock.patch("archivelens_engine.source_preflight.DocumentBackendRegistry.page_count", return_value=501):
            report, _ = preflight_folder(self.source, self.workspace, DEFAULT_CONFIG)
        self.assertTrue(report["can_create"])
        self.assertTrue(report["requires_confirmation"])
        self.assertIn("LARGE_PAGE_COUNT", report["confirmation_codes"])


class SourcePreflightHandlerTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="archivelens-preflight-handler-"))
        self.source = self.tmp / "source"
        self.source.mkdir()
        _png(self.source / "page.png")
        self.env = mock.patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"})
        self.env.start()
        self.server = Server(workspace_root=self.tmp / "workspace")

    def tearDown(self) -> None:
        self.server.store.close()
        self.env.stop()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _wait_terminal(self, preflight_id: str) -> dict:
        deadline = time.monotonic() + 10
        while time.monotonic() < deadline:
            job = _h_tasks_preflight_get(self.server, {"preflight_id": preflight_id})
            if job["status"] in {"completed", "cancelled", "failed"}:
                return job
            time.sleep(0.01)
        self.fail("preflight did not finish")

    def test_preflight_job_completes_and_create_persists_safe_manifest(self) -> None:
        started = _h_tasks_preflight(self.server, {"source_dir": str(self.source)})
        job = self._wait_terminal(started["preflight_id"])
        self.assertEqual(job["status"], "completed")
        report = job["result"]
        created = _h_tasks_create(
            self.server,
            {
                "source_type": "folder",
                "source_dir": str(self.source),
                "search_text": "档案",
                "preflight_token": report["scan_token"],
            },
        )
        self.assertEqual(created["file_count"], 1)
        self.assertNotIn("source_files", created)
        sources = self.server.store.list_task_sources(created["task_id"])
        self.assertEqual(len(sources), 1)
        self.assertEqual(Path(sources[0]["file_path"]), self.source / "page.png")

    def test_changed_folder_rejects_stale_token(self) -> None:
        report, _ = preflight_folder(self.source, self.server.workspace_root, self.server.config)
        _png(self.source / "later.png")
        with self.assertRaises(ProtocolError) as ctx:
            _h_tasks_create(
                self.server,
                {
                    "source_dir": str(self.source),
                    "search_text": "档案",
                    "preflight_token": report["scan_token"],
                },
            )
        self.assertEqual(ctx.exception.code, ErrorCode.PREFLIGHT_STALE)

    def test_confirmation_warning_must_be_explicit(self) -> None:
        _png(self.source / "second.png")
        with mock.patch("archivelens_engine.source_preflight.LARGE_FILE_COUNT", 1):
            report, _ = preflight_folder(self.source, self.server.workspace_root, self.server.config)
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_create(
                    self.server,
                    {
                        "source_dir": str(self.source),
                        "search_text": "档案",
                        "preflight_token": report["scan_token"],
                    },
                )
            self.assertEqual(ctx.exception.code, ErrorCode.VALIDATION_ERROR)
            created = _h_tasks_create(
                self.server,
                {
                    "source_dir": str(self.source),
                    "search_text": "档案",
                    "preflight_token": report["scan_token"],
                    "preflight_confirmed": True,
                },
            )
        self.assertEqual(created["file_count"], 2)

    def test_running_preflight_can_be_cancelled(self) -> None:
        entered = threading.Event()

        def slow_preflight(*_args: object, cancel_event: threading.Event | None = None, **_kwargs: object):
            entered.set()
            while cancel_event is not None and not cancel_event.wait(0.01):
                pass
            raise PreflightCancelled()

        with mock.patch("archivelens_engine.server.preflight_folder", side_effect=slow_preflight):
            started = _h_tasks_preflight(self.server, {"source_dir": str(self.source)})
            self.assertTrue(entered.wait(2))
            cancelling = _h_tasks_preflight_cancel(self.server, {"preflight_id": started["preflight_id"]})
            self.assertIn(cancelling["status"], {"cancelling", "cancelled"})
            job = self._wait_terminal(started["preflight_id"])
        self.assertEqual(job["status"], "cancelled")

    def test_preflight_thread_start_failure_is_terminal_and_does_not_consume_capacity(self) -> None:
        with mock.patch("archivelens_engine.server.threading.Thread.start", side_effect=RuntimeError("boom")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_preflight(self.server, {"source_dir": str(self.source)})
        self.assertEqual(ctx.exception.code, ErrorCode.UNKNOWN_ERROR)
        failed = list(self.server._preflight_jobs.values())[-1]
        self.assertEqual(failed["status"], "failed")
        self.assertNotIn(failed["preflight_id"], self.server._preflight_cancel_events)


@unittest.skipUnless(sys.platform == "win32", "Windows junction behavior")
class SourcePreflightWindowsTests(unittest.TestCase):
    def test_junction_is_skipped_and_outside_file_never_enters_manifest(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-preflight-junction-"))
        source = tmp / "source"
        outside = tmp / "outside"
        workspace = tmp / "workspace"
        source.mkdir()
        outside.mkdir()
        workspace.mkdir()
        _png(source / "inside.png")
        _png(outside / "outside.png")
        junction = source / "linked-outside"
        try:
            subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)], check=True, capture_output=True)
            report, manifest = preflight_folder(source, workspace, DEFAULT_CONFIG)
            self.assertEqual(report["skipped_link_count"], 1)
            self.assertIn("LINKS_SKIPPED", report["confirmation_codes"])
            self.assertEqual([Path(item["file_path"]).name for item in manifest], ["inside.png"])
        finally:
            subprocess.run(["cmd", "/c", "rmdir", str(junction)], check=False, capture_output=True)
            shutil.rmtree(tmp, ignore_errors=True)

    def test_parent_junction_in_selected_path_is_rejected(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-preflight-parent-junction-"))
        outside = tmp / "outside"
        workspace = tmp / "workspace"
        outside_source = outside / "source"
        outside_source.mkdir(parents=True)
        workspace.mkdir()
        _png(outside_source / "outside.png")
        junction = tmp / "linked-parent"
        try:
            subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)], check=True, capture_output=True)
            with self.assertRaises(PermissionError):
                preflight_folder(junction / "source", workspace, DEFAULT_CONFIG)
        finally:
            subprocess.run(["cmd", "/c", "rmdir", str(junction)], check=False, capture_output=True)
            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
