"""B1 任务删除一致性与重试清理的隔离测试（复核修订版）。

覆盖：受信路径推导与 reparse/junction fail closed、文件系统探针在权限/IO 异常时
fail closed（不得用 Path.exists 吞异常）、每次真实清理尝试 attempt_count+1 并清空
旧错误、清理失败用匹配的闭合错误码（PERMISSION_DENIED/UNKNOWN_ERROR）、文件已清
理但 DB 事务失败时安全标记 cleanup_failed 可重试、重启恢复不阻塞启动、幂等删除、
非法 task_id 拒绝、与运行/备注/导出的并发拒绝合同、schema v7→v8 迁移与 future
schema 拒绝。

Windows 真实文件锁与 junction 用例仅在 win32 运行；确定性故障注入用例跨平台，
但明确标注为“注入”而非真实 Windows 证明。
"""

from __future__ import annotations

import errno
import os
import sqlite3
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
    _path_definitely_absent,
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


class _FakeDirEntry:
    """模拟 os.scandir 产出的目录项，用于注入 stat/is_dir 异常。"""

    def __init__(self, name: str, path: str, *, stat_raises: bool = False, is_link: bool = False, is_dir: bool = False) -> None:
        self.name = name
        self.path = path
        self._stat_raises = stat_raises
        self._is_link = is_link
        self._is_dir = is_dir

    def is_symlink(self) -> bool:
        return self._is_link

    def is_dir(self, follow_symlinks: bool = False) -> bool:
        return self._is_dir

    def stat(self, follow_symlinks: bool = False) -> os.stat_result:
        if self._stat_raises:
            raise PermissionError(errno.EACCES, "注入：拒绝访问属性")
        return os.stat_result((0o40755, 0, 0, 1, 0, 0, 0, 0, 0, 0))  # st_file_attributes=0


class _FakeScandirCtx:
    def __init__(self, entries: list[_FakeDirEntry]) -> None:
        self._entries = entries

    def __enter__(self) -> list[_FakeDirEntry]:
        return self._entries

    def __exit__(self, *args: object) -> bool:
        return False


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
        second = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(first, {"task_id": tid, "deleted": True})
        self.assertEqual(second, {"task_id": tid, "deleted": True})

    def test_response_lost_after_success_retry_succeeds(self) -> None:
        # 真实模拟：第一次 handler 完整成功（清目录 + 删 DB）后响应丢失，客户端重试。
        tid, task_dir, _original = _seed_completed_task(self.server, self.tmp)
        first = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(first, {"task_id": tid, "deleted": True})
        self.assertFalse(task_dir.exists())
        self.assertIsNone(self.server.store.get_task(tid))
        # 响应丢失后重试：任务与目录均已不存在 → 幂等成功，无副作用、无错误
        retry = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(retry, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))

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

    def test_illegal_task_id_rejected_before_idempotent_success(self) -> None:
        # 非法 task_id 必须返回 VALIDATION_ERROR，而非幂等成功
        for bad in ("..", "a/b", "a\\b", "a\x00b", ".", ""):
            with self.subTest(bad=bad):
                with self.assertRaises(ProtocolError) as ctx:
                    _h_tasks_delete(self.server, {"task_id": bad})
                self.assertEqual(ctx.exception.code, ErrorCode.VALIDATION_ERROR)
        # 合法但不存在的 ID 仍幂等成功
        self.assertEqual(
            _h_tasks_delete(self.server, {"task_id": "task_does_not_exist"}),
            {"task_id": "task_does_not_exist", "deleted": True},
        )

    def test_cleanup_failure_uses_matching_closed_error_code(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("PERMISSION_DENIED", "注入：清理被拒绝")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        # 文件系统权限错误必须用 PERMISSION_DENIED，不得称为 DATABASE_ERROR
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
        self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
        self.assertTrue(ctx.exception.details["cleanup_state_persisted"])
        self.assertEqual(ctx.exception.details["underlying_cleanup_error_code"], "PERMISSION_DENIED")
        self.assertEqual(ctx.exception.details["attempt_count"], 1)
        self.assertIsNotNone(ctx.exception.details["last_attempt_at"])
        job = self.server.store.get_cleanup_job(tid)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "cleanup_failed")
        self.assertEqual(job["last_error_code"], "PERMISSION_DENIED")
        self.assertIsNotNone(job["last_attempt_at"])
        # 任务与原始来源仍在
        self.assertIsNotNone(self.server.store.get_task(tid))
        self.assertTrue(original.exists())

    def test_fs_cleanup_failure_when_mark_also_fails_reports_truthful_pending(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        # 清理失败 + 标记失败态也失败 → 不得泄露原始 DB 异常、不得伪造 cleanup_failed
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("PERMISSION_DENIED", "注入：清理被拒绝")):
            with patch.object(self.server.store, "mark_cleanup_failed", side_effect=sqlite3.OperationalError("disk I/O")):
                with self.assertRaises(ProtocolError) as ctx:
                    _h_tasks_delete(self.server, {"task_id": tid})
        # 持久化失败占主导 → DATABASE_ERROR
        self.assertEqual(ctx.exception.code, ErrorCode.DATABASE_ERROR)
        # details 如实反映数据库实际状态（pending），不伪造 cleanup_failed
        self.assertEqual(ctx.exception.details["cleanup_status"], "pending")
        self.assertFalse(ctx.exception.details["cleanup_state_persisted"])
        self.assertEqual(ctx.exception.details["underlying_cleanup_error_code"], "PERMISSION_DENIED")
        # 用户可见消息不含原始 DB 异常文本
        self.assertNotIn("disk I/O", ctx.exception.message)
        self.assertNotIn("disk I/O", str(ctx.exception.details))
        # 数据库真实 job.status=pending；任务/目录/原始来源仍在
        self.assertEqual(self.server.store.get_cleanup_job(tid)["status"], "pending")
        self.assertIsNotNone(self.server.store.get_task(tid))
        self.assertTrue(task_dir.exists())
        self.assertTrue(original.exists())

    def test_db_delete_failure_when_mark_also_fails_reports_truthful_pending(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        # 文件清理成功，DB 删除失败，标记失败态也失败
        with patch.object(self.server.store, "delete_task", side_effect=sqlite3.OperationalError("disk full")):
            with patch.object(self.server.store, "mark_cleanup_failed", side_effect=sqlite3.OperationalError("disk full")):
                with self.assertRaises(ProtocolError) as ctx:
                    _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.DATABASE_ERROR)
        # 如实反映数据库实际状态（pending），cleanup_state_persisted=false，无含义反向字段
        self.assertEqual(ctx.exception.details["cleanup_status"], "pending")
        self.assertFalse(ctx.exception.details["cleanup_state_persisted"])
        self.assertNotIn("mark_failed", ctx.exception.details)
        self.assertNotIn("disk full", ctx.exception.message)
        # 文件已清理，任务仍可见（DB 未删），job 真实 pending
        self.assertFalse(task_dir.exists())
        self.assertIsNotNone(self.server.store.get_task(tid))
        self.assertEqual(self.server.store.get_cleanup_job(tid)["status"], "pending")
        self.assertTrue(original.exists())


    def test_cleanup_unknown_error_uses_unknown_error_code(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "注入：未知错误")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.UNKNOWN_ERROR)

    def test_attempt_count_increments_and_clears_old_error_each_real_attempt(self) -> None:
        tid, _task_dir, _original = _seed_completed_task(self.server, self.tmp)
        # 第一次尝试（注入 PERMISSION_DENIED 失败）
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("PERMISSION_DENIED", "首次失败")):
            with self.assertRaises(ProtocolError):
                _h_tasks_delete(self.server, {"task_id": tid})
        job = self.server.store.get_cleanup_job(tid)
        self.assertEqual(job["attempt_count"], 1)
        self.assertEqual(job["last_error_code"], "PERMISSION_DENIED")
        self.assertEqual(job["last_error_summary"], "首次失败")
        self.assertIsNotNone(job["last_attempt_at"])
        # 第二次尝试（注入 UNKNOWN_ERROR 失败）：attempt+1，旧错误被清空后写入新错误
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "二次失败")):
            with self.assertRaises(ProtocolError):
                _h_tasks_delete(self.server, {"task_id": tid})
        job2 = self.server.store.get_cleanup_job(tid)
        self.assertEqual(job2["attempt_count"], 2)
        self.assertEqual(job2["last_error_code"], "UNKNOWN_ERROR")
        self.assertEqual(job2["last_error_summary"], "二次失败")
        # 第三次：真实清理成功 → 任务与 job 全部删除
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))
        self.assertIsNone(self.server.store.get_cleanup_job(tid))

    def test_cleanup_failed_retry_succeeds(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "注入失败")):
            with self.assertRaises(ProtocolError):
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(self.server.store.get_cleanup_job(tid)["status"], "cleanup_failed")
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))
        self.assertIsNone(self.server.store.get_cleanup_job(tid))
        self.assertFalse(task_dir.exists())
        self.assertTrue(original.exists())

    def test_db_delete_failure_after_fs_cleanup_marks_cleanup_failed(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        # 文件清理成功，但 DB 硬删除抛错
        with patch.object(self.server.store, "delete_task", side_effect=sqlite3.OperationalError("disk I/O error")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.DATABASE_ERROR)
        self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
        # 文件已清理，任务/job 仍可见，原始来源未动
        self.assertFalse(task_dir.exists())
        self.assertIsNotNone(self.server.store.get_task(tid))
        job = self.server.store.get_cleanup_job(tid)
        self.assertIsNotNone(job)
        self.assertEqual(job["status"], "cleanup_failed")
        self.assertTrue(original.exists())
        # 恢复 delete_task 后重试 → 成功
        result = _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(result, {"task_id": tid, "deleted": True})
        self.assertIsNone(self.server.store.get_task(tid))

    def test_probe_lstat_permission_error_is_fail_closed(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        with patch("pathlib.Path.lstat", side_effect=PermissionError(errno.EACCES, "注入：拒绝 lstat")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
        self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
        # fail closed：任务、目录与原始来源仍在
        self.assertIsNotNone(self.server.store.get_task(tid))
        self.assertTrue(task_dir.exists())
        self.assertTrue(original.exists())

    def test_probe_scandir_permission_error_is_fail_closed(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        with patch("archivelens_engine.server.os.scandir", side_effect=PermissionError(errno.EACCES, "注入：拒绝 scandir")):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
        self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
        self.assertTrue(task_dir.exists())
        self.assertTrue(original.exists())

    def test_probe_child_stat_error_is_fail_closed(self) -> None:
        tid, task_dir, original = _seed_completed_task(self.server, self.tmp)
        fake_entries = [_FakeDirEntry("locked-child", str(task_dir / "locked-child"), stat_raises=True)]
        with patch("archivelens_engine.server.os.scandir", return_value=_FakeScandirCtx(fake_entries)):
            with self.assertRaises(ProtocolError) as ctx:
                _h_tasks_delete(self.server, {"task_id": tid})
        self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
        self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
        self.assertTrue(task_dir.exists())
        self.assertTrue(original.exists())

    def test_path_definitely_absent_distinguishes_enoent_from_uncheckable(self) -> None:
        # 确凿不存在 → True
        self.assertTrue(_path_definitely_absent(self.tmp / "definitely-missing"))
        # 存在 → False
        self.assertFalse(_path_definitely_absent(self.tmp))
        # 无法检查（lstat 权限错误）→ CleanupError（fail closed）
        with patch("pathlib.Path.lstat", side_effect=PermissionError(errno.EACCES, "denied")):
            with self.assertRaises(CleanupError):
                _path_definitely_absent(self.tmp)

    def test_malicious_task_id_rejected_by_safe_derivation(self) -> None:
        for bad in ("", "..", "a/b", "a\\b", "a\x00b", "."):
            with self.subTest(bad=bad):
                with self.assertRaises((ValueError, CleanupError)):
                    _safe_task_derived_dirs(self.tmp, bad)

    def test_safe_derived_dirs_rejects_drive_root_workspace(self) -> None:
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

    def test_cleanup_target_validates_task_id_and_returns_path_or_none(self) -> None:
        tid, task_dir, _original = _seed_completed_task(self.server, self.tmp)
        result = self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": tid})
        self.assertEqual(result["task_id"], tid)
        self.assertEqual(result["path"], str(task_dir))
        # 非法 task_id → VALIDATION_ERROR
        with self.assertRaises(ProtocolError) as ctx:
            self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": "../evil"})
        self.assertEqual(ctx.exception.code, ErrorCode.VALIDATION_ERROR)
        # 合法但不存在 → TASK_NOT_FOUND
        with self.assertRaises(ProtocolError) as ctx2:
            self.server.handlers["tasks.cleanupTarget"](self.server, {"task_id": "nonexistent"})
        self.assertEqual(ctx2.exception.code, ErrorCode.TASK_NOT_FOUND)
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
            import shutil

            shutil.rmtree(task_dir)
            server.store.close()
            server2 = _make_server(tmp)
            self.assertIsNone(server2.store.get_task(tid))
            self.assertIsNone(server2.store.get_cleanup_job(tid))
            server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_restart_recovery_increments_attempt_and_marks_failure(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-restart-attempt-"))
        try:
            server = _make_server(tmp)
            tid, _task_dir, _original = _seed_completed_task(server, tmp)
            server.store.upsert_cleanup_job_pending(tid)  # 首次尝试 attempt=1，中断
            self.assertEqual(server.store.get_cleanup_job(tid)["attempt_count"], 1)
            server.store.close()
            with patch("archivelens_engine.server._cleanup_task_dirs", side_effect=CleanupError("UNKNOWN_ERROR", "重启注入失败")):
                server2 = _make_server(tmp)  # 重启 → 重新执行（attempt→2）→ 失败
            try:
                job = server2.store.get_cleanup_job(tid)
                self.assertIsNotNone(job)
                self.assertEqual(job["status"], "cleanup_failed")
                self.assertEqual(job["attempt_count"], 2)  # 重启算下一次真实尝试
                self.assertIsNotNone(self.server_store_task(server2, tid))
            finally:
                server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_restart_recovery_db_failure_does_not_block_startup(self) -> None:
        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-restart-db-"))
        try:
            server = _make_server(tmp)
            tid, task_dir, _original = _seed_completed_task(server, tmp)
            server.store.upsert_cleanup_job_pending(tid)
            import shutil

            shutil.rmtree(task_dir)  # 目录已不存在 → cleanup 成功，但 delete_task 将抛错
            server.store.close()
            with patch("archivelens_engine.db.store.TaskStore.delete_task", side_effect=sqlite3.OperationalError("disk full")):
                server2 = _make_server(tmp)  # reconcile 遇 DB 失败但不阻塞启动
            try:
                # 任务仍可见，job 标记 cleanup_failed（可诊断、可重试）
                self.assertIsNotNone(self.server_store_task(server2, tid))
                job = server2.store.get_cleanup_job(tid)
                self.assertIsNotNone(job)
                self.assertEqual(job["status"], "cleanup_failed")
            finally:
                server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    def test_restart_recovery_writes_locatable_diagnostic_on_db_failure(self) -> None:
        import contextlib
        import io

        tmp = Path(tempfile.mkdtemp(prefix="archivelens-cleanup-restart-diag-"))
        try:
            server = _make_server(tmp)
            tid, task_dir, _original = _seed_completed_task(server, tmp)
            server.store.upsert_cleanup_job_pending(tid)
            import shutil

            shutil.rmtree(task_dir)
            server.store.close()
            buf = io.StringIO()
            # delete_task 失败 → reconcile 写安全诊断（task_id + 阶段 + 异常类型）
            with patch("archivelens_engine.db.store.TaskStore.delete_task", side_effect=sqlite3.OperationalError("disk full secret path C:\\private")):
                with contextlib.redirect_stderr(buf):
                    server2 = _make_server(tmp)
            try:
                diag = buf.getvalue()
                self.assertIn(tid, diag)
                self.assertIn("delete_task", diag)
                self.assertIn("OperationalError", diag)
                # 不输出异常消息/路径/私密内容
                self.assertNotIn("disk full", diag)
                self.assertNotIn("private", diag)
                self.assertNotIn("C:\\", diag)
            finally:
                server2.store.close()
        finally:
            import shutil

            shutil.rmtree(tmp, ignore_errors=True)

    @staticmethod
    def server_store_task(server: Server, task_id: str) -> object | None:
        return server.store.get_task(task_id)


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
                # 真实 Windows 文件锁属权限/共享拒绝 → PERMISSION_DENIED（非 DATABASE_ERROR）
                self.assertEqual(ctx.exception.code, ErrorCode.PERMISSION_DENIED)
                self.assertEqual(ctx.exception.details["cleanup_status"], "cleanup_failed")
                self.assertIsNotNone(server.store.get_task(tid))
                self.assertTrue(original.exists())
            finally:
                handle.close()
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
            import shutil

            shutil.rmtree(task_dir)
            outside = tmp / "outside-secret"
            outside.mkdir()
            (outside / "secret.txt").write_text("must-not-be-deleted", encoding="utf-8")
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
            store.conn.execute("DROP TABLE task_cleanup_jobs")
            store.conn.execute("PRAGMA user_version = 7")
            store.conn.commit()
            store.close()
            store2 = TaskStore(db_path)
            table = store2.conn.execute(
                "SELECT name FROM sqlite_master WHERE type='table' AND name='task_cleanup_jobs'"
            ).fetchone()
            self.assertIsNotNone(table)
            version = store2.conn.execute("PRAGMA user_version").fetchone()[0]
            self.assertEqual(version, 8)
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
