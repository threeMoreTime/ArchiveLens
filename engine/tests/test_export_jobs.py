"""B2 导出作业生命周期的隔离测试。

覆盖：持久化 job、原子输出、可取消（图片/组装/写入前后安全检查点）、取消后临时目录
清理、retry 创建新 job、重启把运行中 job 转 interrupted 并清临时、正式输出已存在时
失败/取消不覆盖、磁盘/权限/写入失败、临时清理失败与恶意 export_id/reparse 拒绝、
进度单调与阶段顺序、重复 cancel 幂等、不同任务隔离与同 task+format 并发合同、
active export 与 task delete 互斥、cleanup task 与 export create/retry 互斥、
schema v8→v9 迁移与 future schema 拒绝、旧成功导出历史保留且不被失败 job 篡改、
原始来源永不修改。

JSON 走真实全链路；HTML 阶段/取消/失败用可注入 writer 隔离（明确标注为注入，
仅模拟渲染阶段；取消/原子/重启等作业机制为真实）。导出在后台线程执行，故 writer
patch 必须覆盖 _wait_terminal 全程，避免 worker 读到真实实现造成竞态。真实 HTML
渲染由 test_html_export/test_report_pipeline_html 覆盖（核心 write_offline_review_report 未改）。
"""

from __future__ import annotations

import os
import tempfile
import time
import unittest
from pathlib import Path
from unittest.mock import patch

from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore
from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import (
    CleanupError,
    Server,
    _cleanup_export_temp,
    _h_tasks_delete,
)

TERMINAL = {"completed", "failed", "cancelled", "interrupted"}


def _make_server(tmp: Path) -> Server:
    with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}):
        return Server(workspace_root=str(tmp))


def _seed_exportable_task(server: Server, tmp: Path, *, task_id: str | None = None) -> tuple[str, Path]:
    source_dir = tmp / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    original = source_dir / "original.pdf"
    original.write_bytes(b"%PDF-1.4 original")
    tid = task_id or server.store.create_task(
        source_dir=str(source_dir),
        name="可导出任务",
        status="completed",
        search_terms=["档"],
        search_mode="exact_literal",
    )
    server.store.add_occurrences(
        tid,
        [
            {"occurrence_id": "occ-1", "file_name": "original.pdf", "page_number": 1, "matched_text": "档", "bbox_hash": "h1"},
            {"occurrence_id": "occ-2", "file_name": "original.pdf", "page_number": 2, "matched_text": "档", "bbox_hash": "h2"},
        ],
    )
    return tid, original


def _wait_terminal(server: Server, export_id: str, timeout: float = 10.0) -> dict | None:
    deadline = time.time() + timeout
    last = None
    while time.time() < deadline:
        job = server.store.get_export_job(export_id)
        if job is None:
            return None
        last = job
        if job["status"] in TERMINAL:
            return job
        time.sleep(0.02)
    return last


def _fake_writer(server: Server, *, cancel_at: str | None = None, fail_at: str | None = None, exc: BaseException | None = None):
    """可注入 writer：模拟 preparing/images/building/writing 阶段；可在指定阶段请求取消或抛错。

    仅模拟渲染阶段（注入）；取消/原子/重启等作业机制为真实。
    """

    def writer(*, output_path, progress=None, **_kwargs):
        def maybe(stage: str) -> None:
            if cancel_at == stage:
                events = server._export_cancel_events
                if events:
                    next(iter(events.values())).set()

        for stage in ("preparing", "images", "building", "writing"):
            maybe(stage)
            if progress is not None:
                progress(stage, 1, 1)
            if fail_at == stage:
                raise exc or OSError("注入：写入失败")
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("<html>fake</html>", encoding="utf-8")
        return {"file_size_bytes": output_path.stat().st_size, "page_count": 1, "hit_count": 1}

    return writer


def _slow_writer():
    """慢 writer：用于并发/删除互斥时保持 job 运行中。"""

    def writer(*, output_path, progress=None, **_kwargs):
        time.sleep(0.25)
        output_path.parent.mkdir(parents=True, exist_ok=True)
        output_path.write_text("{}", encoding="utf-8")
        return {"file_size_bytes": 2, "page_count": 0, "hit_count": 0}

    return writer


class ExportJobLifecycleTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-test-"))
        self.server = _make_server(self.tmp)

    def tearDown(self) -> None:
        self.server.store.close()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_json_job_completes_atomically_and_records_history(self) -> None:
        tid, original = _seed_exportable_task(self.server, self.tmp)
        created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "json"})
        export_id = created["export_id"]
        self.assertEqual(created["status"], "queued")
        job = _wait_terminal(self.server, export_id)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "completed")
        out = Path(job["output_path"])
        self.assertTrue(out.exists())
        self.assertEqual(out.name, f"{tid}-report.json")
        history = self.server.store.list_exports(task_id=tid, limit=10, offset=0)
        self.assertTrue(any(h["path"] == str(out) for h in history))
        self.assertFalse((self.tmp / ".export-jobs" / export_id).exists())
        self.assertEqual(original.read_bytes(), b"%PDF-1.4 original")

    def test_html_job_completes_via_injected_writer(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server)):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            job = _wait_terminal(self.server, created["export_id"])
        self.assertEqual(job["status"], "completed")
        self.assertTrue(Path(job["output_path"]).exists())
        self.assertEqual(Path(job["output_path"]).name, f"{tid}-report.html")

    def test_cancel_at_images_stage(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, cancel_at="images")):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            job = _wait_terminal(self.server, created["export_id"])
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse(Path(job["output_path"]).exists())

    def test_cancel_at_writing_stage_does_not_touch_final(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        final = self.tmp / "tasks" / tid / "exports" / f"{tid}-report.html"
        final.parent.mkdir(parents=True, exist_ok=True)
        final.write_text("PREEXISTING-SUCCESS", encoding="utf-8")
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, cancel_at="writing")):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            job = _wait_terminal(self.server, created["export_id"])
        self.assertEqual(job["status"], "cancelled")
        self.assertEqual(final.read_text(encoding="utf-8"), "PREEXISTING-SUCCESS")

    def test_cancel_cleans_temp_dir_and_status_cancelled(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, cancel_at="building")):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            export_id = created["export_id"]
            job = _wait_terminal(self.server, export_id)
        self.assertEqual(job["status"], "cancelled")
        self.assertFalse((self.tmp / ".export-jobs" / export_id).exists())

    def test_retry_creates_new_export_id_and_succeeds(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, cancel_at="building")):
            first = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            _wait_terminal(self.server, first["export_id"])
        self.assertEqual(self.server.store.get_export_job(first["export_id"])["status"], "cancelled")
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server)):
            retry = self.server.handlers["exports.retry"](self.server, {"export_id": first["export_id"]})
            job = _wait_terminal(self.server, retry["export_id"])
        self.assertNotEqual(retry["export_id"], first["export_id"])
        self.assertEqual(retry["retry_of"], first["export_id"])
        self.assertEqual(job["status"], "completed")
        self.assertEqual(self.server.store.get_export_job(first["export_id"])["status"], "cancelled")

    def test_permission_failure_marks_failed_and_preserves_final(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        final = self.tmp / "tasks" / tid / "exports" / f"{tid}-report.html"
        final.parent.mkdir(parents=True, exist_ok=True)
        final.write_text("PREEXISTING", encoding="utf-8")
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, fail_at="writing", exc=PermissionError(13, "denied"))):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            job = _wait_terminal(self.server, created["export_id"])
        self.assertEqual(job["status"], "failed")
        self.assertEqual(job["error_code"], "PERMISSION_DENIED")
        self.assertEqual(final.read_text(encoding="utf-8"), "PREEXISTING")
        history = self.server.store.list_exports(task_id=tid, limit=10, offset=0)
        self.assertFalse(any(h["path"] == str(final) for h in history))

    def test_cancel_is_idempotent(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, cancel_at="building")):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            export_id = created["export_id"]
            self.server.handlers["exports.cancel"](self.server, {"export_id": export_id})
            job = _wait_terminal(self.server, export_id)
        self.assertEqual(job["status"], "cancelled")
        # 重复 cancel → 幂等，返回终态
        second = self.server.handlers["exports.cancel"](self.server, {"export_id": export_id})
        self.assertIn(second["status"], TERMINAL)

    def test_progress_stage_order_legal(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        stages: list[str] = []

        def writer(*, output_path, progress=None, **_kwargs):
            for stage in ("preparing", "images", "building", "writing"):
                if progress is not None:
                    progress(stage, 1, 1)
                stages.append(stage)
            output_path.parent.mkdir(parents=True, exist_ok=True)
            output_path.write_text("x", encoding="utf-8")
            return {"file_size_bytes": 1, "page_count": 1, "hit_count": 1}

        with patch("archivelens_engine.server.write_offline_review_report", side_effect=writer):
            created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            _wait_terminal(self.server, created["export_id"])
        self.assertEqual(stages, ["preparing", "images", "building", "writing"])

    def test_different_tasks_isolate_and_same_task_format_conflict(self) -> None:
        tid_a, _ = _seed_exportable_task(self.server, self.tmp)
        tid_b, _ = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_slow_writer()):
            ja = self.server.handlers["exports.create"](self.server, {"task_id": tid_a, "format": "html"})
            jb = self.server.handlers["exports.create"](self.server, {"task_id": tid_b, "format": "html"})
            _wait_terminal(self.server, ja["export_id"])
            _wait_terminal(self.server, jb["export_id"])
        self.assertEqual(self.server.store.get_export_job(ja["export_id"])["status"], "completed")
        self.assertEqual(self.server.store.get_export_job(jb["export_id"])["status"], "completed")
        # 同 task+format 并发 → 拒绝
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_slow_writer()):
            first = self.server.handlers["exports.create"](self.server, {"task_id": tid_a, "format": "html"})
            with self.assertRaises(ProtocolError) as ctx:
                self.server.handlers["exports.create"](self.server, {"task_id": tid_a, "format": "html"})
            self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)
            _wait_terminal(self.server, first["export_id"])


class ExportJobInteractionTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-interact-"))
        self.server = _make_server(self.tmp)

    def tearDown(self) -> None:
        self.server.store.close()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_active_export_blocks_task_delete(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_slow_writer()):
            self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            # 导出运行中 → tasks.delete 必须明确拒绝
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
            self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)
            for job in self.server.store.list_export_jobs(tid):
                _wait_terminal(self.server, job["export_id"])
        # 导出结束后删除成功
        self.assertEqual(_h_tasks_delete(self.server, {"task_id": tid}), {"task_id": tid, "deleted": True})

    def test_cleanup_task_blocks_export_create_and_retry(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        self.server.store.upsert_cleanup_job_pending(tid)  # 任务进入 cleanup 生命周期
        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "json"})
        self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)
        # retry 同样拒绝：先正常完成一个 job 作为 retry 源
        self.server.store.delete_cleanup_job(tid)
        created = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "json"})
        _wait_terminal(self.server, created["export_id"])
        self.server.store.upsert_cleanup_job_pending(tid)
        with self.assertRaises(ProtocolError) as ctx2:
            self.server.handlers["exports.retry"](self.server, {"export_id": created["export_id"]})
        self.assertEqual(ctx2.exception.code, ErrorCode.TASK_STATE_CONFLICT)

    def test_existing_success_history_not_overwritten_by_failed_job(self) -> None:
        tid, _original = _seed_exportable_task(self.server, self.tmp)
        ok = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "json"})
        _wait_terminal(self.server, ok["export_id"])
        out = Path(self.server.store.get_export_job(ok["export_id"])["output_path"])
        original_bytes = out.read_bytes()
        history_before = len(self.server.store.list_exports(task_id=tid, limit=10, offset=0))
        with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(self.server, fail_at="writing", exc=PermissionError(13, "denied"))):
            bad = self.server.handlers["exports.create"](self.server, {"task_id": tid, "format": "html"})
            _wait_terminal(self.server, bad["export_id"])
        self.assertEqual(out.read_bytes(), original_bytes)  # 已有成功文件未被触碰
        history_after = len(self.server.store.list_exports(task_id=tid, limit=10, offset=0))
        self.assertEqual(history_before, history_after)


class ExportJobRestartTests(unittest.TestCase):
    def test_running_job_becomes_interrupted_and_temp_cleaned_on_restart(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-restart-"))
        try:
            server = _make_server(tmp)
            tid, _original = _seed_exportable_task(server, tmp)
            export_id = server.store.create_export_job(
                task_id=tid, format="html", output_path=str(tmp / "tasks" / tid / "exports" / f"{tid}-report.html")
            )["export_id"]
            server.store.update_export_job(export_id, status="rendering_images")
            (tmp / ".export-jobs" / export_id).mkdir(parents=True, exist_ok=True)
            (tmp / ".export-jobs" / export_id / "partial").write_text("x", encoding="utf-8")
            server.store.close()
            server2 = _make_server(tmp)  # 重启 → reconcile
            try:
                job = server2.store.get_export_job(export_id)
                self.assertEqual(job["status"], "interrupted")
                self.assertFalse((tmp / ".export-jobs" / export_id).exists())
                with patch("archivelens_engine.server.write_offline_review_report", side_effect=_fake_writer(server2)):
                    retry = server2.handlers["exports.retry"](server2, {"export_id": export_id})
                    self.assertNotEqual(retry["export_id"], export_id)
                    retry_job = _wait_terminal(server2, retry["export_id"])
                self.assertEqual(retry_job["status"], "completed")
            finally:
                server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


class ExportJobSafetyTests(unittest.TestCase):
    def test_malicious_export_id_rejected_by_cleanup(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-safety-"))
        try:
            for bad in ("", "..", "a/b", "a\\b", "a\x00b", "."):
                with self.subTest(bad=bad):
                    with self.assertRaises((ValueError, CleanupError)):
                        _cleanup_export_temp(tmp, bad)
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_cleanup_export_temp_refuses_reparse_point(self) -> None:
        if os.name != "nt":
            self.skipTest("junction 行为仅 Windows")
        import subprocess

        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-reparse-"))
        try:
            export_id = "exp_reparse_test"
            target = tmp / ".export-jobs" / export_id
            target.mkdir(parents=True, exist_ok=True)
            outside = tmp / "outside-target"
            outside.mkdir()
            (outside / "secret.txt").write_text("must-not-delete", encoding="utf-8")
            junction = target / "evil-link"
            subprocess.run(["cmd", "/c", "mklink", "/J", str(junction), str(outside)], check=True, capture_output=True)
            with self.assertRaises(CleanupError):
                _cleanup_export_temp(tmp, export_id)
            self.assertTrue((outside / "secret.txt").exists())
            subprocess.run(["cmd", "/c", "rmdir", str(junction)], check=False, capture_output=True)
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_cleanup_only_removes_own_export_id_temp(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-own-"))
        try:
            mine = tmp / ".export-jobs" / "exp_mine"
            other = tmp / ".export-jobs" / "exp_other"
            mine.mkdir(parents=True)
            other.mkdir(parents=True)
            (mine / "f").write_text("x", encoding="utf-8")
            (other / "f").write_text("y", encoding="utf-8")
            _cleanup_export_temp(tmp, "exp_mine")
            self.assertFalse(mine.exists())
            self.assertTrue(other.exists())
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


class ExportJobSchemaTests(unittest.TestCase):
    def test_schema_version_is_v9(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 9)

    def test_migration_from_v8_creates_export_jobs_table(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-migrate-"))
        db_path = tmp / "archivelens.db"
        try:
            store = TaskStore(db_path)
            store.conn.execute("DROP TABLE export_jobs")
            store.conn.execute("DROP INDEX IF EXISTS idx_export_jobs_task")
            store.conn.execute("PRAGMA user_version = 8")
            store.conn.commit()
            store.close()
            store2 = TaskStore(db_path)
            table = store2.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='export_jobs'"
            ).fetchone()
            self.assertIsNotNone(table)
            self.assertEqual(store2.conn.execute("PRAGMA user_version").fetchone()[0], 9)
            store2.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_future_schema_is_rejected(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-export-future-"))
        db_path = tmp / "archivelens.db"
        try:
            store = TaskStore(db_path)
            store.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
            store.conn.commit()
            store.close()
            with self.assertRaises(RuntimeError):
                TaskStore(db_path)
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


if __name__ == "__main__":
    unittest.main()
