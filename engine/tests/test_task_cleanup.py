"""B1 任务删除一致性与重试清理的隔离测试。

覆盖已批准合同：独立持久化 cleanup job、删除顺序（job → 任务可见 → 清派生目录 →
DB 事务硬删除）、目录清理失败可重试、幂等删除、原始来源永不删除、受信路径推导
与 reparse/junction fail closed、清理中重启恢复、与运行/备注/导出的并发拒绝合同、
schema v7→v8 迁移与 future schema 拒绝。

Windows 真实文件锁与 junction 用例仅在 win32 运行；确定性故障注入用例跨平台，
但明确标注为“注入”而非真实 Windows 证明。
"""

from __future__ import annotations

import os
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path
from unittest.mock import patch

from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore
from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import (
    CleanupError,
    Server,
    _h_tasks_delete,
    _safe_task_derived_dirs,
)


def _make_server(tmp: Path) -> Server:
    """以 slowfake 模式构造 Server，避免依赖真实 OCR 模型。"""
    with patch.dict(os.environ, {"AL_SLOWFAKE_PAGES": "1"}):
        return Server(workspace_root=str(tmp))


def _seed_completed_task(server: Server, tmp: Path, *, task_id: str | None = None) -> tuple[str, Path, Path]:
    """创建一个终态任务及其派生目录与原始来源文件。"""
    source_dir = tmp / "source"
    source_dir.mkdir(parents=True, exist_ok=True)
    original = source_dir / "original.pdf"
    original.write_bytes(b"%PDF-1.4 original")
    tid = task_id or server.store.create_task(
        source_dir=str(source_dir),
        name="待清理任务",
        status="completed",
        search_terms=["档"],
        search_mode="exact_literal",
    )
    task_dir = Path(tmp) / "tasks" / tid
    (task_dir / "scan" / "pages").mkdir(parents=True, exist_ok=True)
    (task_dir / "scan" / "pages" / "page-1.png").write_bytes(b"generated page")
    (task_dir / "exports").mkdir(parents=True, exist_ok=True)
    (task_dir / "exports" / f"{tid}-report.json").write_text("{}", encoding="utf-8")
    server.store.update_task(tid, workspace_dir=str(task_dir / "scan"))
    return tid, task_dir, original


class TaskCleanupDeleteTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-test-"))
        self.server = _make_server(self.tmp)

    def tearDown(self) -> None:
        self.server.store.close()
        import shutil

        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_normal_delete_removes_task_and_derived_dirs_keeps_source(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertTrue(original.exists())
        self.assertFalse(task_dir.exists())
        self.assertIsNone(self.server.store.get_task(tid))
        self.assertIsNone(self.server.store.get_cleanup_job(tid))

    def test_duplicate_delete_is_idempotent(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        first = _h_tasks_delete(self.server, {"task_id": tid})
        # 响应丢失后重试：任务已不存在 → 幂等成功
        second = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(first, {"task_id": tid, "deleted": True})
        self.assertEqual(second, {"task_id": tid, "deleted": True})

    def test_delete_succeeds_when_dirs_already_absent(self) -> None:
        tid, task_dir, _original = _seed_completed_task(self.server, self.tmp)
        import shutil

        shutil.rmtree(task_dir)
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))

    def test_delete_nonterminal_task_rejected(self) -> None:
        tid = self.server.store.create_task(
            source_dir=str(self.tmp / "source"),
            name="running", status="running",
            search_terms=["档"], search_mode="exact_literal",
        )
        with self.assertRaises(ProtocolError) as ctx:
            _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)
        self.assertIsNotNone(self.server.store.get_task(tid))

    def test_cleanup_failure_records_structured_job_and_keeps_visible(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        attempts: dict[str, int] = {"n": 0}

        def fake_cleanup(workspace_root: Path, task_id: str) -> None:
            attempts["n"] += 1
            raise CleanupError("PERMISSION_DENIED", "注入：清理被拒绝")

        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=fake_cleanup):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})

        self.assertEqual(ctx.exception.code, ErrorCode.DATABASE_ERROR)
        details = ctx.exception.details
        self.assertEqual(details["cleanup_status"], "cleanup_failed")
        self.assertEqual(details["last_error_code"], "PERMISSION_DENIED")
        self.assertEqual(details["attempt_count"], 1)
        self.assertIsNotNone(details["last_attempt_at"])
        # 任务与 job 仍可见，原始来源未动
        self.assertIsNotNone(self.server.store.get_task(tid))
        job = self.server.store.get_cleanup_job(tid)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "cleanup_failed")
        self.assertTrue(original.exists())
        self.assertEqual(attempts["n"], 1)

    def test_cleanup_failed_retry_succeeds(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        # 第一次：注入失败
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "注入失败")):
            with self.assertRaises(ProtocolError):
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(self.server.store.get_cleanup_job(tid)["status"], "cleanup_failed")
        # 第二次：恢复真实清理 → 成功
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))
        self.assertIsNone(self.server.store.get_cleanup_job(tid))
        self.assertFalse(task_dir.exists())
        self.assertTrue(original.exists())

    def test_response_lost_after_success_retry_succeeds(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        # 模拟成功响应丢失：直接硬删除（等价于上一次成功落库后响应丢失）
        self.server.store.delete_task(tid)
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})

    def test_malicious_task_id_rejected_by_safe_derivation(self) -> None:
        for bad in ("", "..", "a/b", "a\\b", "a\x00b", "."):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, CleanupError)):
                    _safe_task_derived_dirs(self.tmp, bad)

    def test_safe_derived_dirs_rejects_drive_root_workspace(self) -> None:
        # workspace 根不得为盘根（防御）
        with self.assertRaises(CleanupError):
            _safe_task_derived_dirs(Path(os.environ.get("SystemDrive", "C:") + "\\"), "task_x")

    def test_concurrent_note_rejected_while_deleting(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        self.server.store.upsert_cleanup_job_pending(tid)
        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["review.updateNote"](
                self.server, {"task_id": tid, "occurrence_id": "occ-1", "note": "x"}
            )
        self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)
        self.assertEqual(ctx.exception.details["cleanup_status"], "pending")

    def test_concurrent_export_rejected_while_deleting(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        self.server.store.add_occurrences(tid, [{
            "occurrence_id": "occ-1", "file_name": "a.pdf", "page_number": 1,
            "matched_text": "档", "bbox_hash": "h",
        }])
        self.server.store.upsert_cleanup_job_pending(tid)
        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["export.json"](self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.TASK_STATE_CONFLICT)

    def test_cleanup_target_returns_validated_path_or_none(self) -> None:
        tid, task_dir, _original = _seed_completed_task(self.server, self.tmp)
        result = self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": tid})
        self.assertEqual(result["task_id"], tid)
        self.assertEqual(result["path"], str(task_dir))
        # 任务不存在 → TASK_NOT_FOUND
        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": "nonexistent"})
        self.assertEqual(ctx.exception.code, ErrorCode.TASK_NOT_FOUND)
        # 任务仍在但派生目录已清空 → path 为 None
        import shutil

        shutil.rmtree(task_dir)
        result2 = self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": tid})
        self.assertIsNone(result2["path"])


class TaskCleanupRestartRecoveryTests(unittest.TestCase):
    def test_pending_job_completed_on_restart_when_dirs_absent(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-restart-"))
        try:
            server = _make_server(tmp)
            tid, task_dir, _original = _seed_completed_task(server, tmp)
            server.store.upsert_cleanup_job_pending(tid)
            # 目录已不存在（例如上一次已清完但 DB 未提交即崩溃）
            import shutil

            shutil.rmtree(task_dir)
            server.store.close()
            # 重启：reconcile 应把 pending job 安全收尾
            server2 = _make_server(tmp)
            self.assertIsNone(server2.store.get_task(tid))
            self.assertIsNone(server2.store.get_cleanup_job(tid))
            server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_pending_job_failed_on_restart_records_cleanup_failed(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-restart-fail-"))
        try:
            server = _make_server(tmp)
            tid, _task_dir, _original = _seed_completed_task(server, tmp)
            server.store.upsert_cleanup_job_pending(tid)
            server.store.close()
            with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "重启注入失败")):
                server2 = _make_server(tmp)
            try:
                self.assertIsNotNone(server2.store.get_task(tid))
                job = server2.store.get_cleanup_job(tid)
                self.assertIsNotNone(job)
                self.assertEqual(job["status"], "cleanup_failed")
            finally:
                server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


@unittest.skipUnless(sys.platform == "win32", "Windows 真实文件锁/junction 行为")
class TaskCleanupWindowsRealTests(unittest.TestCase):
    """真实 Windows 行为（非 mock）：打开文件句柄阻止删除；junction 越界 fail closed。"""

    def test_open_file_handle_blocks_cleanup_then_retry_succeeds(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-winlock-"))
        try:
            server = _make_server(tmp)
            tid, task_dir, original = _seed_completed_task(server, tmp)
            locked_file = task_dir / "scan" / "pages" / "page-1.png"
            handle = open(locked_file, "rb")  # noqa: SIM115 — 故意持有句柄模拟 Windows 文件锁
            try:
                with self.assertRaises(ProtocolError) as ctx:
                    _h_tasks_delete(server, {"task_id": tid})
                self.assertEqual(ctx.exception.code, ErrorCode.DATABASE_ERROR)
                self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
                # 任务与来源仍在
                self.assertIsNotNone(server.store.get_task(tid))
                self.assertTrue(original.exists())
            finally:
                handle.close()
            # 释放锁后重试 → 成功（真实 Windows 证明）
            result = _h_tasks_delete(server, {"task_id": tid})
            self.assertEqual(result, {"task_id": tid, "deleted": True})
            self.assertIsNone(server.store.get_task(tid))
            server.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_junction_pointing_outside_root_is_rejected_fail_closed(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-junction-"))
        try:
            server = _make_server(tmp)
            tid, task_dir, _original = _seed_completed_task(server, tmp)
            # 清空真实 task_dir 后用 junction 指向根外目录（含“机密”文件）
            import shutil

            shutil.rmtree(task_dir)
            outside = tmp / "outside-secret"
            outside.mkdir()
            (outside / "secret.txt").write_text("must-not-be-deleted", encoding="utf-8")
            # mklink /J 创建 junction（无需管理员）
            subprocess.run(
                ["cmd", "/c", "mklink", "/J", str(task_dir), str(outside)],
                check=True,
                capture_output=True,
            )
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(server, {"task_id": tid})
            self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
            # fail closed：机密文件未被删除
            self.assertTrue((outside / "secret.txt").exists())
            self.assertEqual((outside / "secret.txt").read_text(encoding="utf-8"), "must-not-be-deleted")
            # 清理 junction（测试自身产物）
            subprocess.run(["cmd", "/c", "rmdir", str(task_dir)], check=False, capture_output=True)
            server.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)


class TaskCleanupSchemaTests(unittest.TestCase):
    def test_schema_version_is_v8(self) -> None:
        self.assertEqual(SCHEMA_VERSION, 8)

    def test_migration_from_v7_creates_cleanup_jobs_table(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-migrate-"))
        db_path = tmp / "archivelens.db"
        try:
            store = TaskStore(db_path)
            # 模拟旧 v7 库：删除新表并回退 user_version
            store.conn.execute("DROP TABLE task_cleanup_jobs")
            store.conn.execute("PRAGMA user_version = 7")
            store.conn.commit()
            store.close()
            # 重新打开应触发 v7→v8 迁移，重建表
            store2 = TaskStore(db_path)
            table = store2.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='task_cleanup_jobs'"
            ).fetchone()
            self.assertIsNotNone(table)
            version = store2.conn.execute("PRAGMA user_version").fetchone()[0]
            self.assertEqual(version, 8)
            # cleanup job 方法可用
            self.assertIsNone(store2.task_cleanup_status("task_none"))
            store2.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_future_schema_is_rejected(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-future-"))
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
