"""JSONL Sidecar server —— 桌面纵向闭环。

在 Phase 1 协议骨架基础上，补齐任务/结果/校对/导出/演示的完整 handler。
事件带 ``sequence`` 与 ``timestamp``（任务 §六.8），防前端乱序覆盖。
"""

from __future__ import annotations

import hashlib
import json
import math
import os
import shutil
import errno
import sys
import tempfile
import threading
import traceback
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Callable

from . import PROTOCOL_VERSION, __version__
from .build_info import load_build_info
from .config import DEFAULT_CONFIG, EngineConfig
from .db.store import (
    EXPORT_JOB_ACTIVE_STATUSES,
    EXPORT_JOB_PROGRESS_STATUSES,
    ExportJobCapacityError,
    ExportJobConflictError,
    LEGACY_TASK_REQUIRES_REVIEW,
    TaskStore,
    new_id,
    now_iso,
)
from .diagnostics import detect_all
from .documents import DocumentBackendError, RasterImageBackend
from .documents.formats import (
    FORMAT_COUNT_KEYS,
    RASTER_SOURCE_SUFFIXES,
    SUPPORTED_SOURCE_LABEL,
    SUPPORTED_SOURCE_SUFFIXES,
    count_key,
)
from .html_export import write_offline_review_report
from .ocr_core import build_bbox_hash
from .ocr_engine import ArchiveLensOCR
from .ocr_search import OCRSearchService, OCRSearchUnavailable, SCRIPT_SCOPES
from .page_evidence import PageEvidenceError, PageEvidenceService
from .protocol import (
    ErrorCode,
    ProtocolError,
    make_error,
    make_event,
    make_success,
    require_protocol_version,
    safe_parse,
)
from .runtime.task_control import TaskControl
from .runtime.task_state import LEGAL_TRANSITIONS, TERMINAL_TASK_STATUSES, TaskStateConflict, can_resume
from .search_terms import EXACT_LITERAL_SEARCH_MODE, normalize_search_text, unicode_sequence

Handler = Callable[["Server", dict[str, Any]], dict[str, Any]]
SLOWFAKE_SOURCE_ID = "source-main"
MAX_SOURCE_FILES = 200
RASTER_IMAGE_BACKEND = RasterImageBackend()
REVIEW_IMAGE_QUALITIES = {"standard", "clear", "high", "maximum"}
CONTEXT_READING_DIRECTIONS = {"ltr", "rtl", "ttb", "btt"}
DEFAULT_REVIEW_PREFERENCES = {
    "page_quality": "maximum",
    "context_direction": "ltr",
    "context_radius": 15,
}


def _write_protocol_line(line: str) -> None:
    try:
        sys.stdout.write(line + "\n")
        sys.stdout.flush()
    except UnicodeEncodeError:
        payload = (line + "\n").encode("utf-8")
        buffer = getattr(sys.stdout, "buffer", None)
        if buffer is not None:
            buffer.write(payload)
            buffer.flush()
            return
        sys.stdout.write(payload.decode("utf-8", errors="strict"))
        sys.stdout.flush()


class ThreadSafeRapidOCR:
    """单 RapidOCR 实例 + inference RLock（任务 §十一）。

    保守策略：未经明确并发安全实证前，多个调用串行进入 ONNX Session，
    避免多 Worker 同时推理导致崩溃/死锁。shutdown 时正在推理的调用会先完成。
    """

    def __init__(self, model_path: str | Path | None = None) -> None:
        self._engine = ArchiveLensOCR(model_path)
        self._lock = threading.RLock()

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._engine(*args, **kwargs)

    @property
    def model_info(self) -> dict[str, Any]:
        return dict(self._engine.model_info)


def _require(params: dict[str, Any], key: str, typ: type) -> Any:
    if key not in params:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"缺少参数：{key}")
    val = params[key]
    if not isinstance(val, typ):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"参数 {key} 类型应为 {typ.__name__}")
    return val


class Server:
    """JSONL 协议服务端，持有 TaskStore 与工作目录。"""

    def __init__(
        self,
        config: EngineConfig | None = None,
        workspace_root: str | Path | None = None,
        db_path: str | Path | None = None,
    ) -> None:
        self.config = config or DEFAULT_CONFIG
        if workspace_root is None:
            # 默认临时目录（测试友好）；生产由 Main 传入 userData/engine。
            workspace_root = os.environ.get("AL_WORKSPACE_ROOT") or Path(
                tempfile.mkdtemp(prefix="archivelens-engine-")
            )
        self.workspace_root = _safe_workspace_root(Path(workspace_root))
        _ensure_safe_owned_dir(self.workspace_root, "tasks")
        self.store = TaskStore(db_path or (self.workspace_root / "archivelens.db"))
        self.ocr_search = OCRSearchService(self.store)
        self._export_state_lock = threading.RLock()
        self._export_threads: dict[str, threading.Thread] = {}
        self._export_cancel_events: dict[str, threading.Event] = {}
        try:
            self.store.reconcile_incomplete_tasks(reason="ENGINE_PROCESS_EXITED")
            self.reconcile_cleanup_jobs()
            self.reconcile_export_jobs()
        except Exception:
            self.store.close()
            raise
        self.build_info = load_build_info()
        self.page_evidence = PageEvidenceService(self.config)

        self.handlers: dict[str, Handler] = {}
        self._stdout_lock = threading.Lock()
        self._scan_threads: dict[str, threading.Thread] = {}
        self._task_controls: dict[str, TaskControl] = {}
        # SlowFake 测试模式（任务 §十二）：AL_SLOWFAKE_PAGES>0 时用慢速假处理器替代真实 OCR。
        self.slowfake_pages = int(os.environ.get("AL_SLOWFAKE_PAGES", "0") or "0")
        self.slowfake_page_delay_ms = int(os.environ.get("AL_SLOWFAKE_PAGE_DELAY_MS", "0") or "0")
        self.slowfake_inter_page_delay_ms = int(
            os.environ.get("AL_SLOWFAKE_INTER_PAGE_DELAY_MS", "0") or "0"
        )
        self.slowfake_pause_transition_delay_ms = int(
            os.environ.get("AL_SLOWFAKE_PAUSE_TRANSITION_DELAY_MS", "0") or "0"
        )
        # 主线程预初始化 RapidOCR：打包冻结环境下后台线程内 onnxruntime InferenceSession
        # 创建会死锁（diag2 实证 task.started 后卡 90s）。主线程 init 后注入避免该问题。
        if self.slowfake_pages == 0:
            self.ocr_engine: Any = ThreadSafeRapidOCR(self.config.ocr_rec_model_path)
        else:
            self.ocr_engine = None
        self._shutting_down = False
        self._register_defaults()
        try:
            _schedule_export_jobs(self)
        except Exception:
            self.store.close()
            raise

    # ---- 输出 ----
    def emit(self, line: str) -> None:
        with self._stdout_lock:
            _write_protocol_line(line)

    def emit_event(self, event: str, task_id: str | None = None, payload: dict | None = None) -> None:
        self.emit(make_event(event, task_id, payload))

    def emit_task_event(
        self,
        event: str,
        task_id: str,
        payload: dict | None = None,
        *,
        source_id: str = "",
        worker_generation: int = 0,
    ) -> dict[str, Any]:
        event_row = self.store.append_task_event(
            task_id=task_id,
            event_type=event,
            payload=payload or {},
            source_id=source_id,
            worker_generation=worker_generation,
        )
        self.emit_task_event_row(event_row)
        return event_row

    def emit_task_event_row(self, event_row: dict[str, Any]) -> None:
        msg = {
            "protocol_version": PROTOCOL_VERSION,
            "event": event_row["event_type"],
            "task_id": event_row["task_id"],
            "sequence": event_row["sequence"],
            "timestamp": event_row["created_at"],
            "payload": event_row["payload"],
        }
        self.emit(json.dumps(msg, ensure_ascii=False))

    def reconcile_cleanup_jobs(self) -> int:
        """重启恢复：对中断（pending）的清理作业安全收尾。

        每个作业都是一次新的真实清理尝试（attempt_count+1、清空旧错误）。
        目录确凿不存在视为可安全完成；仍可清理则清理后硬删除；
        清理或 DB 失败则标记可诊断 cleanup_failed 等待 UI 重试。
        单个作业异常不得阻塞应用启动；未持久化异常写安全可定位的 stderr 诊断。
        """
        completed = 0
        try:
            jobs = self.store.list_cleanup_jobs_for_recovery()
        except Exception as exc:
            self._cleanup_diag("*", "list_cleanup_jobs", exc)
            return 0
        for job in jobs:
            task_id = str(job["task_id"])
            try:
                try:
                    task_exists = self.store.get_task(task_id) is not None
                except Exception as exc:
                    self._cleanup_diag(task_id, "get_task", exc)
                    continue
                if not task_exists:
                    try:
                        self.store.delete_cleanup_job(task_id)
                    except Exception as exc:
                        self._cleanup_diag(task_id, "delete_cleanup_job", exc)
                    continue
                # 开始一次新的重启恢复尝试
                try:
                    self.store.upsert_cleanup_job_pending(task_id)
                except Exception as exc:
                    self._cleanup_diag(task_id, "upsert", exc)
                    continue
                try:
                    _cleanup_task_dirs(self.workspace_root, task_id)
                except CleanupError as exc:
                    self._safe_mark_failed(task_id, exc.code, exc.summary, "cleanup")
                    continue
                try:
                    self.store.delete_task(task_id)
                except Exception as exc:
                    self._cleanup_diag(task_id, "delete_task", exc)
                    self._safe_mark_failed(
                        task_id, "DATABASE_ERROR", "重启恢复时记录删除失败，可重试", "delete_task"
                    )
                    continue
                completed += 1
            except Exception as exc:
                # 兜底：单个作业处理异常不得阻塞应用启动
                self._cleanup_diag(task_id, "reconcile_outer", exc)
                continue
        return completed

    def _safe_mark_failed(self, task_id: str, code: str, summary: str, stage: str) -> bool:
        """尝试标记 cleanup_failed；失败时写 stderr 诊断。返回是否成功持久化。"""
        try:
            self.store.mark_cleanup_failed(task_id, code, summary)
            return True
        except Exception as exc:
            self._cleanup_diag(task_id, f"mark_cleanup_failed:{stage}", exc)
            return False

    @staticmethod
    def _cleanup_diag(task_id: str, stage: str, exc: BaseException) -> None:
        """写安全、简短、可定位的诊断（仅 task_id + 阶段 + 异常类型；不含消息/路径/私密）。"""
        try:
            sys.stderr.write(
                f"[reconcile_cleanup] task_id={task_id} stage={stage} error={type(exc).__name__}\n"
            )
            sys.stderr.flush()
        except Exception:
            return

    def reconcile_export_jobs(self) -> int:
        """重启恢复：把上次仍运行中的导出作业标记 interrupted，清理专属临时目录。

        第一阶段不做字节级断点续传。UI 可基于 interrupted 作业重新导出（新 export_id）。
        状态无法持久化时 fail closed，避免界面伪装成仍在后台执行；清理失败持久化到 job。
        """
        reconciled = 0
        try:
            jobs = self.store.list_running_export_jobs_internal()
        except Exception as exc:
            self._cleanup_diag("*", "list_running_export_jobs", exc)
            raise RuntimeError("无法读取中断导出作业，已拒绝启动") from exc
        for job in jobs:
            export_id = str(job["export_id"])
            try:
                current = self.store.transition_export_job(
                    export_id,
                    EXPORT_JOB_ACTIVE_STATUSES,
                    status="interrupted",
                    current_stage="interrupted",
                    error_code="ENGINE_PROCESS_EXITED",
                    error_message="应用上次退出时导出尚未完成，可重试",
                    finished_at=now_iso(),
                )
            except Exception as exc:
                self._cleanup_diag(export_id, "mark_interrupted", exc)
                raise RuntimeError("无法持久化中断导出状态，已拒绝启动") from exc
            if current is None or current.get("status") != "interrupted":
                raise RuntimeError(f"导出作业状态恢复失败: {export_id}")
            reconciled += 1
        try:
            cleanup_jobs = self.store.list_export_jobs_needing_cleanup()
        except Exception as exc:
            self._cleanup_diag("*", "list_export_cleanup", exc)
            raise RuntimeError("无法读取导出临时清理状态，已拒绝启动") from exc
        for job in cleanup_jobs:
            _persist_export_temp_cleanup(self, str(job["export_id"]))
        return reconciled

    # ---- 单行处理 ----
    def handle_line(self, line: str) -> None:
        message = safe_parse(line)
        if message is None:
            sys.stderr.write(f"[server] invalid json ignored: {line.strip()[:200]!r}\n")
            return
        request_id = message.get("request_id")
        try:
            require_protocol_version(message)
            method = message.get("method")
            if self._shutting_down and method != "app.shutdown":
                raise ProtocolError(
                    ErrorCode.ENGINE_SHUTTING_DOWN,
                    "Engine 正在关闭，不接受新请求",
                )
            params = message.get("params") or {}
            if not isinstance(params, dict):
                raise ProtocolError(ErrorCode.VALIDATION_ERROR, "params 必须是对象")
            handler = self.handlers.get(method)
            if handler is None:
                raise ProtocolError(ErrorCode.UNKNOWN_METHOD, f"未知方法: {method}", {"method": method})
            result = handler(self, params)
            self.emit(make_success(request_id, result))
        except ProtocolError as exc:
            self.emit(make_error(request_id, exc.code, exc.message, exc.details))
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[server] handler 异常: {exc}\n{traceback.format_exc()}\n")
            self.emit(make_error(request_id, ErrorCode.UNKNOWN_ERROR, str(exc)))

    def run(self) -> None:
        self.emit_event(
            "engine.ready",
            payload={"engine_version": __version__, "protocol_version": PROTOCOL_VERSION},
        )
        while True:
            line = sys.stdin.readline()
            if not line:
                break
            self.handle_line(line)
            if self._shutting_down:
                break

    # ---- handler 注册 ----
    def _register_defaults(self) -> None:
        self.handlers.update(
            {
                "app.info": _h_app_info,
                "app.shutdown": _h_shutdown,
                "diagnostics.run": _h_diagnostics,
                "tasks.create": _h_tasks_create,
                "tasks.start": _h_tasks_start,
                "tasks.get": _h_tasks_get,
                "tasks.list": _h_tasks_list,
                "tasks.pause": _h_tasks_pause,
                "tasks.resume": _h_tasks_resume,
                "tasks.cancel": _h_tasks_cancel,
                "tasks.delete": _h_tasks_delete,
                "tasks.cleanupTarget": _h_tasks_cleanup_target,
                "tasks.inspectState": _h_tasks_inspect_state,
                "demo.create": _h_demo_create,
                "results.query": _h_results_query,
                "results.getDetail": _h_results_detail,
                "search.corpusStatus": _h_search_corpus_status,
                "search.execute": _h_search_execute,
                "search.sessions": _h_search_sessions,
                "search.hits": _h_search_hits,
                "search.preparePageImage": _h_search_prepare_page_image,
                "review.preparePageImage": _h_review_prepare_page_image,
                "review.updateDecision": _h_review_decision,
                "review.updateNote": _h_review_note,
                "export.json": _h_export_json,
                "export.review": _h_export_review,
                "export.html": _h_export_html,
                "exports.list": _h_exports_list,
                "exports.create": _h_exports_create,
                "exports.get": _h_exports_get,
                "exports.listJobs": _h_exports_list_jobs,
                "exports.cancel": _h_exports_cancel,
                "exports.retry": _h_exports_retry,
            }
        )

    # ---- 状态转换辅助 ----
    def _transition(self, task_id: str, target: str) -> None:
        task = self.store.get_task(task_id)
        if task is None:
            raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
        current = task["status"]
        if target not in LEGAL_TRANSITIONS.get(current, set()):
            raise ProtocolError(
                ErrorCode.TASK_STATE_CONFLICT,
                f"非法状态转换：{current} → {target}",
                {"current": current, "target": target},
            )
        self.store.update_task(task_id, status=target)

    # ---- 扫描线程 ----
    def start_scan_thread(self, task_id: str, *, entry_event: str = "task.started") -> int:
        generation = self.store.allocate_worker_generation(task_id)
        task = self.store.get_task(task_id)
        payload: dict[str, Any] = {"worker_generation": generation}
        if task is not None:
            payload["source_dir"] = task["source_dir"]
            payload["search_text"] = task["search_text"]
            payload["search_terms"] = task["search_terms"]
            payload["search_mode"] = task["search_mode"]
        self.emit_task_event(
            entry_event,
            task_id,
            payload,
            source_id=SLOWFAKE_SOURCE_ID if self.slowfake_pages > 0 else "",
            worker_generation=generation,
        )
        thread = threading.Thread(target=self._run_scan, args=(task_id, generation), daemon=True)
        self._scan_threads[task_id] = thread
        thread.start()
        return generation

    def _run_slowfake(self, task_id: str, tc: TaskControl, worker_generation: int) -> None:
        """慢速假处理器（任务 §十二 E2E）：N 页，每页 150~300ms，可 pause/resume/cancel。

        用于证明 TaskControl 在真实 Sidecar/线程下：pause 期间页数不增长、resume 继续、
        cancel 唤醒 paused 线程，且每页恰好处理一次。
        """
        import random
        import time as _time

        total = self.slowfake_pages
        processed_page_ids = self.store.list_processed_page_ids(task_id, SLOWFAKE_SOURCE_ID)
        processed = len(processed_page_ids)
        processed_page_set = set(processed_page_ids)
        self.store.update_task(
            task_id,
            total_pages=total,
            processed_pages=processed,
            worker_generation=worker_generation,
        )
        for page_no in range(1, total + 1):
            if page_no in processed_page_set:
                continue
            if tc.should_cancel():
                break
            if tc.is_paused():
                if self.slowfake_pause_transition_delay_ms > 0:
                    remaining_seconds = self.slowfake_pause_transition_delay_ms / 1000.0
                    while remaining_seconds > 0 and tc.is_paused() and not tc.should_cancel():
                        slice_seconds = min(0.05, remaining_seconds)
                        _time.sleep(slice_seconds)
                        remaining_seconds -= slice_seconds
                    if tc.should_cancel():
                        break
                    if not tc.is_paused():
                        self.store.update_task(task_id, status="running")
                        continue
                # 协作式：当前页已完成后真正进入 paused，再发 task.paused（避免假暂停）
                self.store.update_task(task_id, status="paused", processed_pages=processed)
                self.emit_task_event(
                    "task.paused",
                    task_id,
                    {
                        "processed_pages": processed,
                        "checkpoint": self.store.get_task_checkpoint(task_id, SLOWFAKE_SOURCE_ID),
                    },
                    source_id=SLOWFAKE_SOURCE_ID,
                    worker_generation=worker_generation,
                )
                tc.wait_if_paused()
                if tc.should_cancel():
                    break
                self.store.update_task(task_id, status="running")
            page_delay_seconds = (
                self.slowfake_page_delay_ms / 1000.0
                if self.slowfake_page_delay_ms > 0
                else random.uniform(0.15, 0.3)
            )
            _time.sleep(page_delay_seconds)
            outcome = self.store.record_page_completion(
                task_id=task_id,
                source_id=SLOWFAKE_SOURCE_ID,
                page_no=page_no,
                worker_generation=worker_generation,
                occurrences=[self._build_slowfake_occurrence(task_id, page_no)],
            )
            processed_page_ids = outcome["processed_page_ids"]
            processed = len(processed_page_ids)
            outcome["event"]["payload"]["total_pages"] = total
            self.emit_task_event_row(outcome["event"])
            if self.slowfake_inter_page_delay_ms > 0 and page_no < total:
                _time.sleep(self.slowfake_inter_page_delay_ms / 1000.0)
        if tc.should_cancel():
            self.store.update_task(task_id, status="cancelled", finished_at=now_iso())
            self.emit_task_event(
                "task.cancelled",
                task_id,
                {"reason": "cancelled"},
                source_id=SLOWFAKE_SOURCE_ID,
                worker_generation=worker_generation,
            )
        else:
            self.store.update_task(task_id, status="completed", processed_pages=total, finished_at=now_iso())
            self.emit_task_event(
                "task.completed",
                task_id,
                {"processed_pages": total, "total_pages": total},
                source_id=SLOWFAKE_SOURCE_ID,
                worker_generation=worker_generation,
            )

    def _build_slowfake_occurrence(self, task_id: str, page_no: int) -> dict[str, Any]:
        task = self.store.get_task(task_id) or {}
        search_terms = task.get("search_terms") or ["约", "約"]
        matched_text = str(search_terms[(page_no - 1) % len(search_terms)])
        matched_character = matched_text if len(matched_text) == 1 else None
        return {
            "occurrence_id": f"occ-{page_no}",
            "document_id": SLOWFAKE_SOURCE_ID,
            "source_id": SLOWFAKE_SOURCE_ID,
            "file_name": "slowfake.pdf",
            "relative_path": "slowfake.pdf",
            "page_number": page_no,
            "page_index": page_no - 1,
            "page_occurrence_index": 1,
            "matched_character": matched_character,
            "character_variant": "simplified" if matched_character == "约" else "traditional" if matched_character == "約" else None,
            "matched_text": matched_text,
            "match_start": 0,
            "match_end": len(matched_text),
            "unicode_sequence": unicode_sequence(matched_text),
            "bbox_hash": f"bbox-{page_no}-{matched_text}",
            "verification_status": "confirmed",
            "context_full": f"page-{page_no}-{matched_text}",
        }

    def _build_store_occurrence_rows(
        self,
        *,
        scan_workspace: Path,
        page_payload: dict[str, Any] | None,
        page_occurrences: list[dict[str, Any]],
        source_id: str,
    ) -> list[dict[str, Any]]:
        rows = []
        page_image_path = page_payload.get("image_path") if page_payload is not None else ""
        page_width = page_payload.get("page_width") if page_payload is not None else None
        page_height = page_payload.get("page_height") if page_payload is not None else None
        for occ in page_occurrences:
            row = dict(occ)
            row["source_id"] = source_id
            if not row.get("bbox_hash"):
                row["bbox_hash"] = build_bbox_hash(
                    source_x0=row.get("source_x0"),
                    source_y0=row.get("source_y0"),
                    source_x1=row.get("source_x1"),
                    source_y1=row.get("source_y1"),
                    normalized_x0=row.get("normalized_x0"),
                    normalized_y0=row.get("normalized_y0"),
                    normalized_x1=row.get("normalized_x1"),
                    normalized_y1=row.get("normalized_y1"),
                )
            try:
                row["page_image_relpath"] = (
                    str(Path(page_image_path).relative_to(scan_workspace)).replace("\\", "/")
                    if page_image_path
                    else ""
                )
            except ValueError:
                row["page_image_relpath"] = ""
            crop_path = row.get("crop_image_path") or ""
            try:
                row["crop_image_relpath"] = (
                    str(Path(crop_path).relative_to(scan_workspace)).replace("\\", "/")
                    if crop_path
                    else ""
                )
            except ValueError:
                row["crop_image_relpath"] = ""
            row["page_image_width"] = page_width
            row["page_image_height"] = page_height
            rows.append(row)
        return rows

    def _persist_real_page_completion(
        self,
        *,
        task_id: str,
        scan_workspace: Path,
        tc: TaskControl,
        worker_generation: int,
        document: Any,
        page_index: int,
        page_payload: dict[str, Any] | None,
        page_occurrences: list[dict[str, Any]],
        ocr_page: dict[str, Any] | None = None,
    ) -> None:
        source_id = str(getattr(document, "source_id", "") or getattr(document, "relative_path", "") or getattr(document, "document_id", "") or "")
        if not source_id:
            raise ValueError("real scan page completion requires a stable source_id")
        self.page_evidence.record_scan_page(
            scan_workspace=scan_workspace,
            document=document,
            page_payload=page_payload,
        )
        outcome = self.store.record_page_completion(
            task_id=task_id,
            source_id=source_id,
            page_no=page_index + 1,
            worker_generation=worker_generation,
            occurrences=self._build_store_occurrence_rows(
                scan_workspace=scan_workspace,
                page_payload=page_payload,
                page_occurrences=page_occurrences,
                source_id=source_id,
            ),
            ocr_page=ocr_page,
        )
        if outcome["event"] is not None:
            outcome["event"]["payload"]["total_pages"] = int(getattr(document, "page_count", 0) or 0)
            self.emit_task_event_row(outcome["event"])
        if tc.is_paused():
            self.store.update_task(task_id, status="paused")
            self.emit_task_event(
                "task.paused",
                task_id,
                {
                    "processed_pages": len(outcome["processed_page_ids"]),
                    "checkpoint": outcome["checkpoint"],
                },
                source_id=source_id,
                worker_generation=worker_generation,
            )
            tc.wait_if_paused()
            if not tc.should_cancel():
                self.store.update_task(task_id, status="running")

    def _run_scan(self, task_id: str, worker_generation: int) -> None:
        """在后台线程跑 ReportPipeline 并把结果导入 TaskStore。

        通过 TaskControl 实现协作式 pause/resume/cancel：管线在每个页面边界
        检查 should_cancel / wait_if_paused（任务 §十二）。
        """
        task = self.store.get_task(task_id)
        if task is None:
            return
        tc = TaskControl()
        self._task_controls[task_id] = tc
        if self.slowfake_pages > 0:
            self._run_slowfake(task_id, tc, worker_generation)
            self._task_controls.pop(task_id, None)
            return
        try:
            from .report_pipeline import ReportPipeline  # 延迟导入（重依赖）

            task_workspace = self.workspace_root / "tasks" / task_id
            scan_workspace = task_workspace / "scan"
            output_html = task_workspace / "report.html"
            self.store.update_task(task_id, workspace_dir=str(scan_workspace))
            pipeline = ReportPipeline(
                root_dir=Path(task["source_dir"]),
                output_html=output_html,
                workspace_dir=scan_workspace,
                config=self.config,
                search_terms=task["search_terms"],
                review_image_quality=task["review_preferences"]["page_quality"],
                context_direction=task["review_preferences"]["context_direction"],
                context_radius=task["review_preferences"]["context_radius"],
                source_files=self.store.list_task_sources(task_id) if task.get("source_kind") == "files" else None,
                resume_state_by_source=self.store.list_task_resume_states(task_id),
                task_control=tc,
                ocr_engine=self.ocr_engine,
                on_page_completed=lambda **kwargs: self._persist_real_page_completion(
                    task_id=task_id,
                    scan_workspace=scan_workspace,
                    tc=tc,
                    worker_generation=worker_generation,
                    **kwargs,
                ),
            )
            try:
                report = pipeline.run()
            finally:
                pipeline.close()
            final_total_pages = int(report.get("stats", {}).get("document_total_pages", 0) or 0)
            final_occurrence_count = self.store._count_occurrences(task_id)
            report_failures = report.get("failures", [])
            if not isinstance(report_failures, list):
                report_failures = []
            failure_count = self.store.replace_task_failures(task_id, report_failures)
            corpus_status = self.store.finalize_ocr_corpus(
                task_id,
                expected_pages=final_total_pages,
                failure_count=failure_count,
            )
            if tc.should_cancel():
                self.store.update_task(task_id, status="cancelled", failure_count=failure_count, finished_at=now_iso())
                self.emit_task_event(
                    "task.cancelled",
                    task_id,
                    {
                        "reason": "cancelled",
                        "ocr_corpus": corpus_status,
                    },
                    worker_generation=worker_generation,
                )
            else:
                final_task = self.store.get_task(task_id) or {}
                self.store.update_task(
                    task_id,
                    status="completed",
                    processed_pages=int(final_task.get("processed_pages", final_total_pages) or final_total_pages),
                    total_pages=final_total_pages,
                    occurrence_count=final_occurrence_count,
                    failure_count=failure_count,
                    error_code="PARTIAL_FAILURE" if failure_count else None,
                    error_message=f"{failure_count} 个页面处理失败，结果可能不完整。" if failure_count else None,
                    finished_at=now_iso(),
                )
                self.emit_task_event(
                    "task.completed",
                    task_id,
                    {
                        "processed_pages": int(final_task.get("processed_pages", final_total_pages) or final_total_pages),
                        "total_pages": final_total_pages,
                        "occurrence_count": final_occurrence_count,
                        "failure_count": failure_count,
                        "ocr_corpus": corpus_status,
                    },
                    worker_generation=worker_generation,
                )
        except Exception as exc:  # noqa: BLE001
            self.store.replace_task_failures(
                task_id,
                [{
                    "file_path": str(task.get("source_dir") or ""),
                    "stage": "task_scan",
                    "error_type": type(exc).__name__,
                    "error_message": str(exc),
                    "page_number": None,
                    "possible_missed_hits": True,
                }],
            )
            self.store.update_task(
                task_id,
                status="failed",
                failure_count=1,
                finished_at=now_iso(),
                error_code="TASK_RECOVERABLE" if self.store.get_task(task_id)["processed_pages"] > 0 else None,
                error_message=str(exc),
            )
            self.emit_task_event(
                "task.failed",
                task_id,
                {"error": str(exc)},
                worker_generation=worker_generation,
            )
        finally:
            self._task_controls.pop(task_id, None)

    def _import_report(self, task_id: str, task_workspace: Path, scan_workspace: Path, report: dict) -> None:
        pages_by_id = {p.get("page_image_id"): p for p in report.get("pages", [])}
        rows = []
        for occ in report.get("occurrences", []):
            page = pages_by_id.get(occ.get("page_image_id"), {})
            page_img = page.get("image_path") or occ.get("crop_image_path") or ""
            crop_img = occ.get("crop_image_path") or ""
            try:
                page_rel = str(Path(page_img).relative_to(scan_workspace)).replace("\\", "/") if page_img else ""
            except ValueError:
                page_rel = ""
            try:
                crop_rel = str(Path(crop_img).relative_to(scan_workspace)).replace("\\", "/") if crop_img else ""
            except ValueError:
                crop_rel = ""
            row = dict(occ)
            row["page_image_relpath"] = page_rel
            row["crop_image_relpath"] = crop_rel
            row["page_image_width"] = page.get("page_width")
            row["page_image_height"] = page.get("page_height")
            rows.append(row)
        self.store.add_occurrences(task_id, rows)
        # 让 Main 的 al-resource 能定位：task workspace_dir 指向 scan_workspace（图片所在）
        self.store.update_task(task_id, workspace_dir=str(scan_workspace))


# --------------------------------------------------------------------------- #
# handlers
# --------------------------------------------------------------------------- #
def _h_app_info(server: Server, params: dict) -> dict:
    return {
        "engine_version": __version__,
        "protocol_version": PROTOCOL_VERSION,
        "python_executable": sys.executable,
        "build_metadata": server.build_info,
    }


def _h_diagnostics(server: Server, params: dict) -> dict:
    return detect_all(server.config, server.workspace_root)


def _h_shutdown(server: Server, params: dict) -> dict:
    """优雅 shutdown（任务 §六）：设标志 + 唤醒 paused/cancel + emit。

    幂等：重复 shutdown 返回当前状态，不重复销毁。
    """
    if server._shutting_down:
        return {"status": "shutting_down", "already": True}
    server._shutting_down = True
    # 唤醒所有 paused/正在处理的任务（协作式退出）
    for task_id, tc in server._task_controls.items():
        task = server.store.get_task(task_id)
        if task is not None and task.get("status") == "paused":
            continue
        tc.request_cancel()
    # 导出采用协作式取消；未在退出窗口内结束的作业会在下次启动标记 interrupted。
    with server._export_state_lock:
        export_events = list(server._export_cancel_events.items())
    for export_id, event in export_events:
        try:
            current = server.store.transition_export_job(
                export_id,
                EXPORT_JOB_PROGRESS_STATUSES,
                status="cancelling",
                cancel_requested=1,
            )
            if current is not None and current.get("status") == "cancelling":
                event.set()
        except Exception as exc:
            server._cleanup_diag(export_id, "shutdown_cancel_export", exc)
    server.emit_event("engine.shutdown", payload={"reason": "requested"})
    return {"status": "shutting_down"}


def _file_source_display_paths(paths: list[Path]) -> list[str]:
    names = [path.name for path in paths]
    duplicate_names = {name for name in names if names.count(name) > 1}
    displays = [f"{path.parent.name}/{path.name}" if path.name in duplicate_names else path.name for path in paths]
    duplicate_displays = {name for name in displays if displays.count(name) > 1}
    return [str(path) if display in duplicate_displays else display for path, display in zip(paths, displays, strict=True)]


def _validate_file_sources(params: dict[str, Any]) -> tuple[list[dict[str, str]], str, str]:
    raw_files = params.get("source_files")
    if not isinstance(raw_files, list) or not all(isinstance(value, str) and value.strip() for value in raw_files):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "source_files 必须是至少包含一个路径的字符串数组")
    normalized: list[Path] = []
    seen: set[str] = set()
    invalid_files: list[dict[str, str]] = []
    for raw in raw_files:
        path = Path(raw).expanduser()
        try:
            resolved = path.resolve(strict=False)
        except OSError:
            resolved = path.absolute()
        canonical = os.path.normcase(str(resolved))
        if canonical in seen:
            continue
        seen.add(canonical)
        try:
            if not resolved.exists():
                invalid_files.append({"path": raw, "reason": "文件不存在"})
                continue
            if not resolved.is_file():
                invalid_files.append({"path": raw, "reason": "不是文件"})
                continue
        except (OSError, ValueError):
            invalid_files.append({"path": raw, "reason": "路径无效"})
            continue
        if resolved.suffix.lower() not in SUPPORTED_SOURCE_SUFFIXES:
            invalid_files.append({"path": raw, "reason": f"仅支持 {SUPPORTED_SOURCE_LABEL} 文件"})
            continue
        try:
            with resolved.open("rb") as handle:
                handle.read(1)
        except (OSError, ValueError):
            invalid_files.append({"path": raw, "reason": "文件不可读取"})
            continue
        if resolved.suffix.lower() in RASTER_SOURCE_SUFFIXES:
            try:
                RASTER_IMAGE_BACKEND.validate(resolved)
            except DocumentBackendError as exc:
                invalid_files.append({"path": raw, "reason": exc.message})
                continue
        normalized.append(resolved)
    if invalid_files:
        preview = "；".join(
            f"{Path(item['path']).name or item['path']}：{item['reason']}" for item in invalid_files[:5]
        )
        suffix = "；其余文件请查看错误详情" if len(invalid_files) > 5 else ""
        raise ProtocolError(
            ErrorCode.VALIDATION_ERROR,
            f"文件清单包含无效文件，未创建任务：{preview}{suffix}",
            {"invalid_files": invalid_files},
        )
    if not normalized:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "请至少选择一个有效文件")
    if len(normalized) > MAX_SOURCE_FILES:
        raise ProtocolError(
            ErrorCode.VALIDATION_ERROR,
            f"单个文件清单任务最多支持 {MAX_SOURCE_FILES} 个文件",
            {"max_source_files": MAX_SOURCE_FILES, "file_count": len(normalized)},
        )
    displays = _file_source_display_paths(normalized)
    records = [
        {
            "file_path": str(path),
            "file_name": path.name,
            "display_path": display,
            "source_id": f"source-{index + 1:03d}-{hashlib.sha256(os.path.normcase(str(path)).encode('utf-8')).hexdigest()[:12]}",
        }
        for index, (path, display) in enumerate(zip(normalized, displays, strict=True))
    ]
    try:
        common_parent = Path(os.path.commonpath([str(path.parent) for path in normalized]))
        source_dir = str(common_parent)
    except ValueError:
        source_dir = ""
    source_label = normalized[0].name if len(normalized) == 1 else f"{len(normalized)} 个已选文件"
    return records, source_dir, source_label


def _h_tasks_create(server: Server, params: dict) -> dict:
    if "parallel_workers" in params and (type(params["parallel_workers"]) is not int or params["parallel_workers"] != 1):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "parallel_workers 当前仅支持整数 1")
    try:
        search_text = normalize_search_text(_require(params, "search_text", str))
    except ValueError as exc:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, str(exc)) from exc
    raw_preferences = params.get("review_preferences", DEFAULT_REVIEW_PREFERENCES)
    if not isinstance(raw_preferences, dict):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "review_preferences 必须是对象")
    review_preferences = {
        "page_quality": raw_preferences.get("page_quality", DEFAULT_REVIEW_PREFERENCES["page_quality"]),
        "context_direction": raw_preferences.get("context_direction", DEFAULT_REVIEW_PREFERENCES["context_direction"]),
        "context_radius": raw_preferences.get("context_radius", DEFAULT_REVIEW_PREFERENCES["context_radius"]),
    }
    if review_preferences["page_quality"] not in REVIEW_IMAGE_QUALITIES:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "page_quality 仅支持 standard、clear、high 或 maximum")
    review_preferences["page_quality"] = "maximum"
    if review_preferences["context_direction"] not in CONTEXT_READING_DIRECTIONS:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "context_direction 仅支持 ltr、rtl、ttb 或 btt")
    if type(review_preferences["context_radius"]) is not int or not 1 <= review_preferences["context_radius"] <= 50:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "context_radius 必须是 1 到 50 的整数")
    source_type = params.get("source_type") or ("files" if "source_files" in params else "folder")
    if source_type not in {"folder", "files"}:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "source_type 仅支持 folder 或 files")
    source_files: list[dict[str, str]] | None = None
    if source_type == "folder":
        source_dir = _require(params, "source_dir", str)
        src = Path(source_dir)
        if not src.exists() or not src.is_dir():
            raise ProtocolError(ErrorCode.PATH_NOT_FOUND, f"来源目录不存在：{source_dir}")
        source_kind = "folder"
        source_label = src.name or str(src)
    else:
        source_files, source_dir, source_label = _validate_file_sources(params)
        src = Path(source_dir) if source_dir else Path.cwd()
        source_kind = "files"
    output_dir = params.get("output_dir") or str(server.workspace_root / "tasks")
    out = Path(output_dir)
    try:
        out.mkdir(parents=True, exist_ok=True)
        (out / ".al-write-probe").write_text("ok", encoding="utf-8")
        (out / ".al-write-probe").unlink(missing_ok=True)
    except OSError as exc:
        raise ProtocolError(ErrorCode.PERMISSION_DENIED, f"输出目录不可写：{output_dir}", {"error": str(exc)})

    counts = {key: 0 for key in FORMAT_COUNT_KEYS}
    if source_files is None:
        invalid_files: list[dict[str, str]] = []
        for p in src.rglob("*"):
            if not p.is_file():
                continue
            if p.suffix.lower() not in SUPPORTED_SOURCE_SUFFIXES:
                continue
            if p.suffix.lower() in RASTER_SOURCE_SUFFIXES:
                try:
                    RASTER_IMAGE_BACKEND.validate(p)
                except DocumentBackendError as exc:
                    invalid_files.append({"path": str(p), "reason": exc.message})
                    continue
            counts[count_key(p)] += 1
        if invalid_files:
            preview = "；".join(f"{Path(item['path']).name}：{item['reason']}" for item in invalid_files[:5])
            suffix = "；其余文件请查看错误详情" if len(invalid_files) > 5 else ""
            raise ProtocolError(
                ErrorCode.VALIDATION_ERROR,
                f"文件夹包含无效图片，未创建任务：{preview}{suffix}",
                {"invalid_files": invalid_files},
            )
    else:
        for source in source_files:
            counts[count_key(Path(source["file_path"]))] += 1
    file_count = sum(counts.values())

    payload = {
        "source_dir": source_dir,
        "source_kind": source_kind,
        "source_label": source_label,
        "file_count": file_count,
        "counts": counts,
        "search_text": search_text,
        "search_terms": [search_text],
        "search_mode": EXACT_LITERAL_SEARCH_MODE,
        "review_preferences": review_preferences,
    }
    if source_files is not None:
        payload["source_files"] = [source["file_path"] for source in source_files]
    task_id, event = server.store.create_task_with_event(
        source_dir=source_dir,
        source_kind=source_kind,
        source_label=source_label,
        source_files=source_files,
        output_dir=str(out),
        workspace_dir="",
        name=params.get("name") or source_label,
        file_count=file_count,
        status="draft",
        search_terms=[search_text],
        search_mode=EXACT_LITERAL_SEARCH_MODE,
        review_image_quality=review_preferences["page_quality"],
        context_direction=review_preferences["context_direction"],
        context_radius=review_preferences["context_radius"],
        event_type="task.created",
        event_payload=payload,
    )
    server.emit_task_event_row(event)
    return {"task_id": task_id, "status": "draft", **payload}


def _h_tasks_start(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    server._transition(task_id, "queued")
    server._transition(task_id, "starting")
    server._transition(task_id, "running")
    server.store.update_task(task_id, started_at=now_iso())
    server.start_scan_thread(task_id, entry_event="task.started")
    return {"task_id": task_id, "status": "running"}


def _h_tasks_get(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    return {**task, "failures": server.store.list_task_failures(task_id)}


def _h_tasks_list(server: Server, params: dict) -> dict:
    limit = _validate_results_page_parameter(params, "limit", default=50, minimum=1, maximum=100)
    offset = _validate_results_page_parameter(params, "offset", default=0, minimum=0)
    status = params.get("status")
    query = params.get("query")
    if status is not None and not isinstance(status, str):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "status 必须是字符串")
    if query is not None and not isinstance(query, str):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "query 必须是字符串")
    items = server.store.list_tasks(limit=limit, offset=offset, status=status, query=query)
    total = server.store.count_tasks(status=status, query=query)
    return {"items": items, "limit": limit, "offset": offset, "total": total}


def _h_tasks_pause(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    tc = server._task_controls.get(task_id)
    if tc is not None:
        # 协作式：请求暂停；扫描线程在当前页完成后发 task.paused（真正暂停）
        tc.request_pause()
    try:
        server._transition(task_id, "pausing")
    except ProtocolError:
        pass
    task = server.store.get_task(task_id)
    server.emit_task_event(
        "task.pausing",
        task_id,
        {},
        source_id=SLOWFAKE_SOURCE_ID if server.slowfake_pages > 0 else "",
        worker_generation=int(task["worker_generation"] if task else 0),
    )
    return {"task_id": task_id, "status": "pausing"}


def _h_tasks_resume(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    if task.get("error_code") == LEGACY_TASK_REQUIRES_REVIEW:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "旧任务缺少可信进度，不能自动恢复。请人工确认或重新创建任务。",
            {"reason": LEGACY_TASK_REQUIRES_REVIEW},
        )
    current = str(task["status"])
    if not can_resume(current):
        guidance = (
            "失败任务不能直接继续；请使用原任务参数重新创建任务。"
            if current == "failed"
            else "陈旧任务必须先转换为可恢复状态后才能继续。"
            if current == "stale"
            else "当前任务状态不支持继续。"
        )
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            guidance,
            {"current": current, "allowed": ["paused", "recoverable"]},
        )
    tc = server._task_controls.get(task_id)
    server._transition(task_id, "running")
    task = server.store.get_task(task_id)
    if tc is not None:
        tc.request_resume()
        server.emit_task_event(
            "task.resumed",
            task_id,
            {
                "search_text": task["search_text"],
                "search_terms": task["search_terms"],
                "search_mode": task["search_mode"],
            },
            source_id=SLOWFAKE_SOURCE_ID if server.slowfake_pages > 0 else "",
            worker_generation=int(task["worker_generation"] if task else 0),
        )
    else:
        server.start_scan_thread(task_id, entry_event="task.resumed")
    return {"task_id": task_id, "status": "running"}


def _h_tasks_cancel(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    tc = server._task_controls.get(task_id)
    task = server.store.get_task(task_id)
    if tc is not None:
        tc.request_cancel()
        try:
            server._transition(task_id, "stopping")
        except ProtocolError:
            pass
        server.emit_task_event(
            "task.cancelling",
            task_id,
            {},
            source_id=SLOWFAKE_SOURCE_ID if server.slowfake_pages > 0 else "",
            worker_generation=int(task["worker_generation"] if task else 0),
        )
        return {"task_id": task_id, "status": "stopping"}
    server.store.update_task(task_id, status="cancelled", finished_at=now_iso())
    server.emit_task_event(
        "task.cancelled",
        task_id,
        {"reason": "cancelled"},
        source_id=SLOWFAKE_SOURCE_ID if server.slowfake_pages > 0 else "",
        worker_generation=int(task["worker_generation"] if task else 0),
    )
    return {"task_id": task_id, "status": "cancelled"}


class CleanupError(Exception):
    """安全清理失败（fail closed）。``code`` 为底层原因码，``summary`` 为安全摘要。"""

    def __init__(self, code: str, summary: str) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary


def _classify_oserror(exc: OSError) -> str:
    """把底层 OSError 映射为闭合错误码字符串（PERMISSION_DENIED/UNKNOWN_ERROR）。"""
    return "PERMISSION_DENIED" if exc.errno in (errno.EACCES, errno.EPERM) else "UNKNOWN_ERROR"


def _cleanup_error_code_to_protocol(code: str) -> str:
    """cleanup 内部原因码 → 对外 ProtocolError 闭合错误码。"""
    return ErrorCode.PERMISSION_DENIED if code == "PERMISSION_DENIED" else ErrorCode.UNKNOWN_ERROR


def _validate_task_id_segment(task_id: str) -> None:
    """task_id 必须是单一路径段：非空、无分隔符/NUL、非 . 或 .. 。"""
    if not isinstance(task_id, str) or not task_id:
        raise ValueError("任务标识无效")
    if "\x00" in task_id or "/" in task_id or "\\" in task_id:
        raise ValueError("任务标识无效")
    if task_id in {".", ".."} or Path(task_id).name != task_id:
        raise ValueError("任务标识无效")


def _require_task_id_segment(task_id: str) -> None:
    """handler 入口校验：非法 task_id 返回 VALIDATION_ERROR 而非幂等成功。"""
    try:
        _validate_task_id_segment(task_id)
    except ValueError as exc:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, str(exc), {"task_id": task_id}) from exc


def _path_definitely_absent(path: Path) -> bool:
    """仅在确凿不存在（ENOENT/ENOTDIR）时返回 True；任何无法检查的情况 fail closed。

    不得用 ``Path.exists()``，它会吞掉权限/IO 异常而误判目录已不存在。
    """
    try:
        path.lstat()
    except FileNotFoundError:
        return True
    except NotADirectoryError:
        return True
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"无法检查任务目录状态，已拒绝清理：{exc.strerror or str(exc)}",
        ) from exc
    return False


def _is_reparse_point(path: Path) -> bool:
    """判断路径自身是否为 symlink/junction 等 reparse point（不跟随）。fail closed。"""
    try:
        info = path.lstat()
    except FileNotFoundError:
        return False
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"无法检查任务目录属性，已拒绝清理：{exc.strerror or str(exc)}",
        ) from exc
    import stat as _stat

    if _stat.S_ISLNK(info.st_mode):
        return True
    # FILE_ATTRIBUTE_REPARSE_POINT = 0x400（覆盖 junction 等）；非 Windows 无该属性。
    return bool(getattr(info, "st_file_attributes", 0) & 0x400)


def _safe_workspace_root(workspace_root: Path) -> Path:
    """建立并返回真实 workspace 根；根自身是 reparse point 时 fail closed。"""
    raw = workspace_root.expanduser().absolute()
    if _is_reparse_point(raw):
        raise CleanupError("PERMISSION_DENIED", "workspace 根不能是 reparse point")
    try:
        raw.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"无法建立 workspace 根：{exc.strerror or str(exc)}",
        ) from exc
    if _is_reparse_point(raw):
        raise CleanupError("PERMISSION_DENIED", "workspace 根在建立时变成 reparse point")
    return raw.resolve()


def _assert_path_chain_no_reparse(root: Path, candidate: Path) -> None:
    """检查 root 到 candidate 的每一级现有路径，防止父级 junction/symlink 穿越。"""
    try:
        relative = candidate.relative_to(root)
    except ValueError as exc:
        raise CleanupError("PERMISSION_DENIED", "派生路径越出 workspace 根") from exc
    current = root
    for part in relative.parts:
        current = current / part
        if _is_reparse_point(current):
            raise CleanupError("PERMISSION_DENIED", "派生路径包含 reparse point，已拒绝")


def _ensure_safe_owned_dir(workspace_root: Path, *parts: str) -> Path:
    """仅在已验证的 app-owned 路径链内建目录，并在创建后再次验证。"""
    root = _safe_workspace_root(workspace_root)
    candidate = root.joinpath(*parts)
    _assert_path_chain_no_reparse(root, candidate)
    try:
        candidate.mkdir(parents=True, exist_ok=True)
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"无法建立应用目录：{exc.strerror or str(exc)}",
        ) from exc
    _assert_path_chain_no_reparse(root, candidate)
    return candidate


def _safe_task_derived_dirs(workspace_root: Path, task_id: str) -> list[Path]:
    """从受信 workspace_root + 已验证 task_id 推导任务派生目录；fail closed。

    绝不读取任务记录中的任意绝对路径；推导结果必须严格位于 workspace_root 之内，
    且不得是盘根、workspace 根或 reparse point。
    """
    _validate_task_id_segment(task_id)
    root = _safe_workspace_root(workspace_root)
    root_drive = os.path.splitdrive(str(root))[0]
    if str(root).rstrip("\\/") == root_drive:
        raise CleanupError("PERMISSION_DENIED", "workspace 根不能是盘根")
    candidates = [root / "tasks" / task_id, root / task_id]
    safe: list[Path] = []
    for candidate in candidates:
        if candidate == root:
            raise CleanupError("PERMISSION_DENIED", "任务目录与 workspace 根重合")
        # 深度防御：词法 containment（task_id 已为单段，正常不会越界）
        try:
            candidate.relative_to(root)
        except ValueError as exc:
            raise CleanupError("PERMISSION_DENIED", "任务目录越出 workspace 根") from exc
        _assert_path_chain_no_reparse(root, candidate)
        safe.append(candidate)
    return safe


def _assert_tree_has_no_reparse(root: Path) -> None:
    """递归扫描目录树；发现任何 reparse point 即 fail closed，绝不跟随。

    scandir/stat/is_dir 的任何权限或 IO 异常都转换为 CleanupError（不得静默 continue）。
    """
    if _path_definitely_absent(root):
        return
    pending = [root]
    while pending:
        current = pending.pop()
        try:
            with os.scandir(current) as entries:
                child_entries = list(entries)
        except OSError as exc:
            raise CleanupError(
                _classify_oserror(exc),
                f"无法扫描任务目录，已拒绝清理：{exc.strerror or str(exc)}",
            ) from exc
        for entry in child_entries:
            try:
                is_link = entry.is_symlink()
                if not is_link:
                    attributes = getattr(entry.stat(follow_symlinks=False), "st_file_attributes", 0)
                    is_link = bool(attributes & 0x400)
            except OSError as exc:
                raise CleanupError(
                    _classify_oserror(exc),
                    f"无法检查任务目录项属性，已拒绝清理：{entry.name}",
                ) from exc
            if is_link:
                raise CleanupError("PERMISSION_DENIED", f"任务目录包含 reparse point，已拒绝清理：{entry.name}")
            try:
                is_dir = entry.is_dir(follow_symlinks=False)
            except OSError as exc:
                raise CleanupError(
                    _classify_oserror(exc),
                    f"无法检查任务目录项类型，已拒绝清理：{entry.name}",
                ) from exc
            if is_dir:
                pending.append(Path(entry.path))


def _cleanup_task_dirs(workspace_root: Path, task_id: str) -> None:
    """安全清理任务派生目录；确凿缺失视为已清理；reparse/junction/无法检查 fail closed。"""
    for candidate in _safe_task_derived_dirs(workspace_root, task_id):
        if _path_definitely_absent(candidate):
            continue
        _assert_tree_has_no_reparse(candidate)
        try:
            shutil.rmtree(candidate)
        except OSError as exc:
            raise CleanupError(
                _classify_oserror(exc),
                f"清理任务目录失败：{exc.strerror or str(exc)}",
            ) from exc


def _resolve_cleanup_target(workspace_root: Path, task_id: str) -> str | None:
    """返回首个确凿存在的受信派生目录（供 Main 受控打开）；不存在返回 None。fail closed。"""
    for candidate in _safe_task_derived_dirs(workspace_root, task_id):
        if not _path_definitely_absent(candidate):
            return str(candidate)
    return None


# --------------------------------------------------------------------------- #
# 导出作业（B2）：持久化生命周期、原子输出、可取消、重启恢复
# --------------------------------------------------------------------------- #
class ExportCancelled(Exception):
    """用户请求取消导出（在安全检查点抛出）。"""


class ExportFailed(Exception):
    """导出失败。``code`` 为闭合错误码字符串，``summary`` 为安全摘要。"""

    def __init__(self, code: str, summary: str) -> None:
        super().__init__(summary)
        self.code = code
        self.summary = summary


#: 导出作业终态
EXPORT_JOB_TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled", "interrupted"})
#: 进度阶段 → 作业状态
_EXPORT_STAGE_STATUS = {
    "preparing": "preparing",
    "images": "rendering_images",
    "building": "building",
    "writing": "writing",
}


def _validate_export_id_segment(export_id: str) -> None:
    """export_id 必须是单一路径段（用于推导受信临时目录）。"""
    if not isinstance(export_id, str) or not export_id:
        raise ValueError("导出标识无效")
    if "\x00" in export_id or "/" in export_id or "\\" in export_id:
        raise ValueError("导出标识无效")
    if export_id in {".", ".."} or Path(export_id).name != export_id:
        raise ValueError("导出标识无效")


def _safe_export_temp_dir(workspace_root: Path, export_id: str) -> Path:
    """从受信 workspace_root + 已验证 export_id 推导专属临时目录；fail closed。"""
    _validate_export_id_segment(export_id)
    root = _safe_workspace_root(workspace_root)
    candidate = root / ".export-jobs" / export_id
    if candidate == root:
        raise CleanupError("PERMISSION_DENIED", "导出临时目录与 workspace 根重合")
    try:
        candidate.relative_to(root)
    except ValueError as exc:
        raise CleanupError("PERMISSION_DENIED", "导出临时目录越出 workspace 根") from exc
    _assert_path_chain_no_reparse(root, candidate)
    return candidate


def _prepare_export_temp_dir(workspace_root: Path, export_id: str) -> Path:
    _validate_export_id_segment(export_id)
    _ensure_safe_owned_dir(workspace_root, ".export-jobs")
    candidate = _ensure_safe_owned_dir(workspace_root, ".export-jobs", export_id)
    return candidate


def _cleanup_export_temp(workspace_root: Path, export_id: str) -> None:
    """安全清理单个 export_id 的专属临时目录；fail closed（绝不删除其他 job/任务/来源）。"""
    candidate = _safe_export_temp_dir(workspace_root, export_id)
    if _path_definitely_absent(candidate):
        return
    _assert_tree_has_no_reparse(candidate)
    try:
        shutil.rmtree(candidate)
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"清理导出临时目录失败：{exc.strerror or str(exc)}",
        ) from exc


def _export_final_path(workspace_root: Path, task_id: str, fmt: str, export_id: str) -> Path:
    """返回 job-owned 唯一正式路径；失败作业永远不会覆盖既有成功导出。"""
    _validate_task_id_segment(task_id)
    _validate_export_id_segment(export_id)
    _require_format(fmt)
    root = _safe_workspace_root(workspace_root)
    suffix = "report.html" if fmt == "html" else ("review.json" if fmt == "review" else "report.json")
    candidate = root / "tasks" / task_id / "exports" / f"{task_id}-{export_id}-{suffix}"
    _assert_path_chain_no_reparse(root, candidate.parent)
    return candidate


def _prepare_export_final_path(workspace_root: Path, task_id: str, fmt: str, export_id: str) -> Path:
    _validate_task_id_segment(task_id)
    _validate_export_id_segment(export_id)
    _ensure_safe_owned_dir(workspace_root, "tasks")
    _ensure_safe_owned_dir(workspace_root, "tasks", task_id)
    _ensure_safe_owned_dir(workspace_root, "tasks", task_id, "exports")
    return _export_final_path(workspace_root, task_id, fmt, export_id)


def _require_format(fmt: str) -> str:
    if fmt not in {"html", "json", "review"}:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "format 仅支持 html、json 或 review")
    return fmt



def _h_tasks_delete(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    _require_task_id_segment(task_id)
    task = server.store.get_task(task_id)
    if task is None:
        # 幂等：合法但任务已不存在（含响应丢失后的重试）视为已删除
        return {"task_id": task_id, "deleted": True}
    if task["status"] not in TERMINAL_TASK_STATUSES:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "任务仍可执行或恢复，必须先取消后才能删除",
            {"status": task["status"]},
        )
    # B2 串联：任务仍有运行中的导出作业时拒绝删除（不能边导出边删除目录）
    active_exports = server.store.list_active_export_jobs(task_id=task_id)
    if active_exports:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "任务仍有导出正在运行，请先取消或等待完成后再删除",
            {"task_id": task_id, "active_export_count": len(active_exports)},
        )

    # 1. 原子持久化 cleanup job（pending，attempt_count+1，清空旧错误）：任务保持可见
    job = server.store.upsert_cleanup_job_pending(task_id)
    # 2. 安全清理仅属于该任务的派生目录（绝不触碰原始来源）
    try:
        _cleanup_task_dirs(server.workspace_root, task_id)
    except CleanupError as exc:
        details, persisted = _record_cleanup_failure(server, task_id, exc.code, exc.summary, job)
        if persisted:
            # 失败态已落库：对外用底层清理原因码（PERMISSION_DENIED/UNKNOWN_ERROR）
            code = _cleanup_error_code_to_protocol(exc.code)
            message = f"任务记录清理失败，可重试：{exc.summary}"
        else:
            # 失败态无法持久化：清楚反映数据库持久化失败（占主导），仍保留底层原因诊断
            code = ErrorCode.DATABASE_ERROR
            message = "任务清理失败，且无法记录失败状态，请重试"
        raise ProtocolError(code, message, details) from exc
    # 3. DB 事务硬删除：任务派生记录 + 任务 + cleanup job（文件系统清理不冒充 DB 事务）
    try:
        deleted = server.store.delete_task(task_id)
    except Exception as exc:
        details, _persisted = _record_cleanup_failure(
            server, task_id, "DATABASE_ERROR", "任务文件已清理，但记录删除失败，可重试", job
        )
        raise ProtocolError(
            ErrorCode.DATABASE_ERROR,
            "任务文件已清理，但记录删除失败，可重试",
            details,
        ) from exc
    if not deleted:
        # 并发已删除：幂等成功
        return {"task_id": task_id, "deleted": True}
    return {"task_id": task_id, "deleted": True}


def _record_cleanup_failure(
    server: Server,
    task_id: str,
    target_code: str,
    target_summary: str,
    fallback_job: dict[str, Any] | None,
) -> tuple[dict[str, Any], bool]:
    """如实记录清理失败，返回 (details, persisted)。

    - mark 成功 → cleanup_status='cleanup_failed'，cleanup_state_persisted=true。
    - mark 抛错或返回 None → 读取实际 job 状态（通常 pending），
      cleanup_state_persisted=false，目标 code/summary 作为诊断字段。
    绝不声称已持久化失败态，不泄露原始 DB 异常文本。
    """
    fallback = fallback_job or {}
    actual_status = str(fallback.get("status") or "pending")
    attempt_count = int(fallback.get("attempt_count") or 0)
    last_attempt_at = fallback.get("last_attempt_at")
    persisted = False
    try:
        marked = server.store.mark_cleanup_failed(task_id, target_code, target_summary)
    except Exception:
        marked = None
    if marked is not None:
        persisted = True
        actual_status = str(marked.get("status") or "cleanup_failed")
        attempt_count = int(marked.get("attempt_count") or attempt_count)
        last_attempt_at = marked.get("last_attempt_at")
    else:
        # mark 未成功：读取实际 job 状态（若可），不得伪造 cleanup_failed
        try:
            actual_job = server.store.get_cleanup_job(task_id)
        except Exception:
            actual_job = None
        if actual_job:
            actual_status = str(actual_job.get("status") or actual_status)
            attempt_count = int(actual_job.get("attempt_count") or attempt_count)
            last_attempt_at = actual_job.get("last_attempt_at")
    details = {
        "task_id": task_id,
        "cleanup_status": actual_status,
        "cleanup_state_persisted": persisted,
        "attempt_count": attempt_count,
        "last_attempt_at": last_attempt_at,
        "underlying_cleanup_error_code": target_code,
        "underlying_cleanup_error_summary": target_summary,
    }
    return details, persisted


def _h_tasks_cleanup_target(server: Server, params: dict) -> dict:
    """返回受信派生目录，供 Main 受控打开（renderer 不接触绝对路径）。"""
    task_id = _require(params, "task_id", str)
    _require_task_id_segment(task_id)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    try:
        path = _resolve_cleanup_target(server.workspace_root, task_id)
    except CleanupError as exc:
        raise ProtocolError(_cleanup_error_code_to_protocol(exc.code), exc.summary, {"task_id": task_id}) from exc
    return {"task_id": task_id, "path": path}


def _assert_not_cleaning(server: Server, task_id: str) -> None:
    """删除生命周期中的任务拒绝产生会被静默丢弃的新状态（备注/导出/校对）。"""
    status = server.store.task_cleanup_status(task_id)
    if status is not None:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "任务正在删除，无法修改校对或导出",
            {"task_id": task_id, "cleanup_status": status},
        )


def _h_tasks_inspect_state(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    requested_source_id = params.get("source_id")
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    if requested_source_id:
        source_id = requested_source_id
    elif server.slowfake_pages > 0:
        source_id = SLOWFAKE_SOURCE_ID
    else:
        source_id = server.store.resolve_task_source_id(task_id)
    total, items = server.store.query_occurrences(task_id=task_id, limit=10**9, offset=0)
    return {
        "task": task,
        "task_id": task_id,
        "source_id": source_id,
        "processed_page_ids": server.store.list_processed_page_ids(task_id, source_id),
        "occurrence_ids": [item["occurrence_id"] for item in items],
        "checkpoint": server.store.get_task_checkpoint(task_id, source_id),
        "events": server.store.list_task_events(task_id),
        "occurrence_count": total,
    }


def _h_demo_create(server: Server, params: dict) -> dict:
    from .demo import create_demo

    tasks_root = server.workspace_root / "tasks"
    tasks_root.mkdir(parents=True, exist_ok=True)
    result = create_demo(server.store, tasks_root)
    task = server.store.get_task(result["task_id"])
    assert task is not None
    server.emit_task_event(
        "task.created",
        result["task_id"],
        {
            "demo": True,
            "search_text": task["search_text"],
            "search_terms": task["search_terms"],
            "search_mode": task["search_mode"],
        },
    )
    server.emit_task_event("task.completed", result["task_id"], {"demo": True})
    return result


def _h_results_query(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    limit = _validate_results_page_parameter(params, "limit", default=100, minimum=1, maximum=200)
    offset = _validate_results_page_parameter(params, "offset", default=0, minimum=0)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    filters = {
        "document": params.get("document"),
        "status": params.get("status"),
        "character": params.get("character"),
        "search": params.get("search"),
    }
    review_summary = server.store.get_occurrence_review_summary(task_id=task_id, **filters)
    total = review_summary["reviewed_count"] + review_summary["unreviewed_count"]
    _total, items = server.store.query_occurrences(
        task_id=task_id,
        limit=limit,
        offset=offset,
        total_override=total,
        **filters,
    )
    scan_complete = task["status"] == "completed" and int(task.get("failure_count", 0) or 0) == 0
    review_complete = scan_complete and review_summary["unreviewed_count"] == 0
    return {
        "total": total,
        "items": items,
        "task_id": task_id,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
        "review_summary": review_summary,
        "task_status": task["status"],
        "scan_complete": scan_complete,
        "review_complete": review_complete,
    }


def _validate_results_page_parameter(
    params: dict,
    key: str,
    *,
    default: int,
    minimum: int,
    maximum: int | None = None,
) -> int:
    value = params.get(key, default)
    if isinstance(value, bool) or not isinstance(value, int):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"{key} 必须是整数")
    if value < minimum or (maximum is not None and value > maximum):
        upper = f"，且不大于 {maximum}" if maximum is not None else ""
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"{key} 必须不小于 {minimum}{upper}")
    return value


def _h_results_detail(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occ_id = _require(params, "occurrence_id", str)
    detail = server.store.get_occurrence_detail(task_id, occ_id)
    if detail is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"结果不存在: {occ_id}")
    return detail


def _h_search_corpus_status(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    return {
        "task_id": task_id,
        **server.store.get_ocr_corpus_status(task_id),
    }


def _h_search_execute(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    query_text = _require(params, "query_text", str)
    script_scope = params.get("script_scope", "both")
    if not isinstance(script_scope, str) or script_scope not in SCRIPT_SCOPES:
        raise ProtocolError(
            ErrorCode.VALIDATION_ERROR,
            "简繁命中范围必须是 simplified、traditional 或 both",
        )
    try:
        return server.ocr_search.search(
            task_id=task_id,
            query_text=query_text,
            script_scope=script_scope,
        )
    except KeyError as exc:
        raise ProtocolError(
            ErrorCode.TASK_NOT_FOUND,
            f"任务不存在: {task_id}",
        ) from exc
    except OCRSearchUnavailable as exc:
        message = (
            "旧任务没有可验证的 OCR 语料，请使用原来源重新创建扫描任务。"
            if exc.requires_reocr
            else "当前任务的 OCR 检索语料尚未可用，请等待扫描完成或重新扫描。"
        )
        raise ProtocolError(
            ErrorCode.OCR_CORPUS_UNAVAILABLE,
            message,
            {
                "status": exc.status,
                "requires_reocr": exc.requires_reocr,
            },
        ) from exc
    except ValueError as exc:
        raise ProtocolError(
            ErrorCode.VALIDATION_ERROR,
            str(exc),
        ) from exc


def _h_search_sessions(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    limit = _validate_results_page_parameter(
        params,
        "limit",
        default=50,
        minimum=1,
        maximum=200,
    )
    return {
        "task_id": task_id,
        "items": server.store.list_ocr_search_sessions(task_id, limit=limit),
    }


def _h_search_hits(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    search_session_id = _require(params, "search_session_id", str)
    limit = _validate_results_page_parameter(
        params,
        "limit",
        default=100,
        minimum=1,
        maximum=200,
    )
    offset = _validate_results_page_parameter(
        params,
        "offset",
        default=0,
        minimum=0,
    )
    try:
        session = server.store.get_ocr_search_session(search_session_id)
        if session["task_id"] != task_id:
            raise KeyError(search_session_id)
        total, items = server.store.query_ocr_search_hits(
            search_session_id,
            limit=limit,
            offset=offset,
        )
    except KeyError as exc:
        raise ProtocolError(
            ErrorCode.TASK_NOT_FOUND,
            f"检索会话不存在: {search_session_id}",
        ) from exc
    return {
        "search_session_id": search_session_id,
        "task_id": session["task_id"],
        "session": session,
        "total": total,
        "limit": limit,
        "offset": offset,
        "has_more": offset + len(items) < total,
        "items": items,
    }


def _h_search_prepare_page_image(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    search_hit_id = _require(params, "search_hit_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    hit = server.store.get_ocr_search_hit_evidence(
        task_id=task_id,
        search_hit_id=search_hit_id,
    )
    if hit is None:
        raise ProtocolError(
            ErrorCode.TASK_NOT_FOUND,
            f"检索结果不存在: {search_hit_id}",
        )
    workspace_value = task.get("workspace_dir")
    if not workspace_value:
        raise ProtocolError(
            ErrorCode.SOURCE_EVIDENCE_UNAVAILABLE,
            "任务缺少扫描工作目录，请重新扫描",
        )
    occurrence = {
        "document_id": hit["document_id"],
        "source_id": hit["source_id"],
        "relative_path": hit["display_path"],
        "page_number": hit["page_no"],
        "source_page_width": hit["source_page_width"],
        "source_page_height": hit["source_page_height"],
    }
    try:
        return server.page_evidence.prepare(
            scan_workspace=Path(str(workspace_value)),
            occurrence=occurrence,
            target_css_width=_require_finite_number(
                params,
                "target_css_width",
            ),
            target_css_height=_require_finite_number(
                params,
                "target_css_height",
            ),
            device_pixel_ratio=_require_finite_number(
                params,
                "device_pixel_ratio",
            ),
            is_demo=False,
        )
    except PageEvidenceError as exc:
        raise ProtocolError(exc.code, exc.message, exc.details) from exc


def _require_finite_number(params: dict, key: str) -> float:
    value = params.get(key)
    if isinstance(value, bool) or not isinstance(value, (int, float)):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"{key} 必须是有限数字")
    number = float(value)
    if not math.isfinite(number):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"{key} 必须是有限数字")
    return number


def _h_review_prepare_page_image(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occurrence_id = _require(params, "occurrence_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    occurrence = server.store.get_occurrence_detail(task_id, occurrence_id)
    if occurrence is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"结果不存在: {occurrence_id}")
    workspace_value = task.get("workspace_dir")
    if not workspace_value:
        raise ProtocolError(ErrorCode.SOURCE_EVIDENCE_UNAVAILABLE, "任务缺少扫描工作目录，请重新扫描")
    try:
        return server.page_evidence.prepare(
            scan_workspace=Path(str(workspace_value)),
            occurrence=occurrence,
            target_css_width=_require_finite_number(params, "target_css_width"),
            target_css_height=_require_finite_number(params, "target_css_height"),
            device_pixel_ratio=_require_finite_number(params, "device_pixel_ratio"),
            is_demo=bool(task.get("is_demo")),
        )
    except PageEvidenceError as exc:
        raise ProtocolError(exc.code, exc.message, exc.details) from exc


def _validate_decision(decision: str) -> str:
    if decision not in {"confirmed", "needs_review", "rejected"}:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"非法 decision：{decision}")
    return decision


def _h_review_decision(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occ_id = _require(params, "occurrence_id", str)
    decision = _validate_decision(_require(params, "decision", str))
    _assert_not_cleaning(server, task_id)
    updated = server.store.upsert_review(
        task_id=task_id, occurrence_id=occ_id, decision=decision
    )
    return {"occurrence_id": occ_id, "decision": decision, "updated_at": updated}


def _h_review_note(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occ_id = _require(params, "occurrence_id", str)
    note = _require(params, "note", str)
    _assert_not_cleaning(server, task_id)
    updated = server.store.upsert_review(task_id=task_id, occurrence_id=occ_id, note=note)
    return {"occurrence_id": occ_id, "note": note, "updated_at": updated}


def _export_integrity(server: Server, task: dict, total: int) -> dict[str, Any]:
    review_summary = server.store.get_occurrence_review_summary(task_id=task["task_id"])
    scan_complete = task["status"] == "completed" and int(task.get("failure_count", 0) or 0) == 0
    review_complete = scan_complete and review_summary["unreviewed_count"] == 0
    return {
        "task_id": task["task_id"],
        "task_status": task["status"],
        "search_text": task["search_text"],
        "search_terms": task["search_terms"],
        "search_mode": task["search_mode"],
        "total_occurrences": total,
        "exported_occurrences": total,
        **review_summary,
        "scan_complete": scan_complete,
        "review_complete": review_complete,
        "export_complete": True,
        "fully_verified": scan_complete and review_complete,
        "exported_at": now_iso(),
    }


def _h_export_json(server: Server, params: dict) -> dict:
    """同步兼容入口（阻塞当前线程）；UI 应使用 exports.create 走异步 job。"""
    return _run_sync_export(server, params, "json")


def _h_export_review(server: Server, params: dict) -> dict:
    """同步兼容入口（阻塞当前线程）；UI 应使用 exports.create 走异步 job。"""
    return _run_sync_export(server, params, "review")


def _h_export_html(server: Server, params: dict) -> dict:
    """同步兼容入口（阻塞当前线程）；UI 应使用 exports.create 走异步 job。"""
    return _run_sync_export(server, params, "html")


_EXPORT_ERROR_CODES = {
    "PERMISSION_DENIED",
    "UNKNOWN_ERROR",
    "SOURCE_EVIDENCE_UNAVAILABLE",
    "SOURCE_FILE_CHANGED",
    "PAGE_RENDER_LIMIT_EXCEEDED",
    "TASK_NOT_FOUND",
    "DATABASE_ERROR",
}


def _export_error_code_to_protocol(code: str) -> str:
    return code if code in _EXPORT_ERROR_CODES else ErrorCode.UNKNOWN_ERROR


def _render_html_export(
    server: Server,
    task: dict[str, Any],
    temp_dir: Path,
    final_path: Path,
    progress: Callable[[str, int, int], None],
) -> dict[str, Any]:
    workspace_value = task.get("workspace_dir")
    with server.store.occurrence_export_snapshot(task["task_id"]) as (total, page_count, items):
        integrity = _export_integrity(server, task, total)
        exported_at = integrity["exported_at"]
        progress("preparing", 0, total)

        def resolve_page_image(item: dict[str, Any]) -> dict[str, Any]:
            if not workspace_value:
                raise ExportFailed("SOURCE_EVIDENCE_UNAVAILABLE", "任务缺少扫描工作目录，请重新扫描")
            try:
                return server.page_evidence.prepare_for_export(
                    scan_workspace=Path(str(workspace_value)),
                    occurrence=item,
                    is_demo=bool(task.get("is_demo")),
                )
            except PageEvidenceError as exc:
                raise ExportFailed(_export_error_code_to_protocol(exc.code), exc.message) from exc

        temp_output = temp_dir / "report.html"
        try:
            built = write_offline_review_report(
                output_path=temp_output,
                task=task,
                items=items,
                integrity=integrity,
                workspace_dir=Path(workspace_value) if workspace_value else None,
                exported_at=exported_at,
                expected_page_count=page_count,
                progress=progress,
                page_image_resolver=resolve_page_image,
            )
        except (ExportCancelled, ExportFailed):
            raise
        except OSError as exc:
            raise ExportFailed(_classify_oserror(exc), "生成 HTML 报告失败") from exc
        except Exception as exc:  # noqa: BLE001
            raise ExportFailed("UNKNOWN_ERROR", "生成 HTML 报告失败") from exc
    os.replace(temp_output, final_path)  # 原子替换到正式输出
    return {
        "path": str(final_path),
        "occurrence_count": total,
        "file_size_bytes": int(built["file_size_bytes"]),
        "progress_completed": total,
        "progress_total": total,
    }


def _render_json_export(
    server: Server,
    task: dict[str, Any],
    temp_dir: Path,
    final_path: Path,
    progress: Callable[[str, int, int], None],
) -> dict[str, Any]:
    progress("preparing", 0, 0)
    total, items = server.store.query_occurrences(task_id=task["task_id"], limit=10**9, offset=0)
    integrity = _export_integrity(server, task, total)
    payload = {"task": task, "occurrences": items, "integrity": integrity, "exported_at": integrity["exported_at"]}
    progress("building", total, total)
    temp_output = temp_dir / "report.json"
    try:
        temp_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        size = temp_output.stat().st_size
        progress("writing", total, total)
        os.replace(temp_output, final_path)  # 原子替换
    except OSError as exc:
        raise ExportFailed(_classify_oserror(exc), "写入 JSON 导出失败") from exc
    return {
        "path": str(final_path),
        "occurrence_count": total,
        "file_size_bytes": size,
        "progress_completed": total,
        "progress_total": total,
    }


def _render_review_export(
    server: Server,
    task_id: str,
    temp_dir: Path,
    final_path: Path,
    progress: Callable[[str, int, int], None],
) -> dict[str, Any]:
    progress("preparing", 0, 0)
    reviews = server.store.list_reviews(task_id)
    payload = {"task_id": task_id, "exported_at": now_iso(), "records": reviews}
    progress("building", len(reviews), len(reviews))
    temp_output = temp_dir / "review.json"
    try:
        temp_output.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
        size = temp_output.stat().st_size
        progress("writing", len(reviews), len(reviews))
        os.replace(temp_output, final_path)  # 原子替换
    except OSError as exc:
        raise ExportFailed(_classify_oserror(exc), "写入校对导出失败") from exc
    return {
        "path": str(final_path),
        "record_count": len(reviews),
        "file_size_bytes": size,
        "progress_completed": len(reviews),
        "progress_total": len(reviews),
    }


def _export_cancel_requested(server: Server, export_id: str, event: threading.Event | None) -> bool:
    if event is not None and event.is_set():
        return True
    job = server.store.get_export_job_internal(export_id)
    return bool(job and (job.get("cancel_requested") or job.get("status") == "cancelling"))


def _remove_job_owned_output(server: Server, export_id: str, task_id: str, fmt: str) -> None:
    """只移除由 export_id 唯一命名的失败输出；路径异常时 fail closed。"""
    candidate = _export_final_path(server.workspace_root, task_id, fmt, export_id)
    if _path_definitely_absent(candidate):
        return
    if _is_reparse_point(candidate):
        raise CleanupError("PERMISSION_DENIED", "失败导出文件是 reparse point，已拒绝清理")
    try:
        candidate.unlink()
    except OSError as exc:
        raise CleanupError(
            _classify_oserror(exc),
            f"回滚失败导出文件失败：{exc.strerror or str(exc)}",
        ) from exc


def _persist_export_temp_cleanup(server: Server, export_id: str) -> None:
    """清理作业独占残留并持久化结果；绝不触碰已登记成功的正式输出。"""
    cleanup_error: CleanupError | None = None
    job = server.store.get_export_job_internal(export_id)
    if job is None:
        raise RuntimeError(f"导出作业不存在，无法持久化清理结果: {export_id}")
    if str(job.get("status") or "") != "completed":
        try:
            _remove_job_owned_output(
                server,
                export_id,
                str(job.get("task_id") or ""),
                str(job.get("format") or ""),
            )
        except CleanupError as exc:
            cleanup_error = exc
        except (ProtocolError, ValueError):
            cleanup_error = CleanupError("PERMISSION_DENIED", "导出正式文件路径不可信，已拒绝清理")
    try:
        _cleanup_export_temp(server.workspace_root, export_id)
    except CleanupError as exc:
        cleanup_error = cleanup_error or exc
    except Exception:  # noqa: BLE001
        cleanup_error = cleanup_error or CleanupError("UNKNOWN_ERROR", "导出临时文件清理失败")
    if cleanup_error is not None:
        persisted = server.store.mark_export_cleanup_result(
            export_id,
            success=False,
            error_code=cleanup_error.code,
            error_message="导出残留文件清理失败，将在下次启动重试",
        )
        if not persisted:
            raise RuntimeError(f"导出清理失败状态无法持久化: {export_id}") from cleanup_error
        return
    if not server.store.mark_export_cleanup_result(export_id, success=True):
        raise RuntimeError(f"导出清理成功状态无法持久化: {export_id}")


def _run_export_job_core(server: Server, export_id: str) -> dict[str, Any]:
    """执行导出作业核心：专属临时目录写入 → 原子替换 → 成功历史。

    成功返回 result 并把 job 标记 completed；取消抛 ExportCancelled；失败抛 ExportFailed。
    只有原子输出成功后才写 exports 成功历史（失败/取消绝不覆盖已有成功文件）。
    """
    job = server.store.get_export_job_internal(export_id)
    if job is None:
        raise ExportFailed("UNKNOWN_ERROR", "导出作业不存在")
    task_id = str(job["task_id"])
    fmt = str(job["format"])
    task = server.store.get_task(task_id)
    if task is None:
        raise ExportFailed("TASK_NOT_FOUND", "任务不存在")
    # 防竞态：运行中任务进入 cleanup 生命周期则中止
    _assert_not_cleaning(server, task_id)
    with server._export_state_lock:
        cancel_event = server._export_cancel_events.get(export_id)

    def progress(stage: str, completed: int, progress_total: int) -> None:
        if _export_cancel_requested(server, export_id, cancel_event):
            raise ExportCancelled()
        status = _EXPORT_STAGE_STATUS.get(stage, "preparing")
        current = server.store.set_export_job_progress(
            export_id,
            status=status,
            current_stage=stage,
            completed=int(completed),
            total=int(progress_total),
        )
        if current is None:
            raise ExportFailed("DATABASE_ERROR", "导出作业记录不存在")
        if current.get("status") == "cancelling" or current.get("cancel_requested"):
            raise ExportCancelled()
        if current.get("status") != status:
            raise ExportFailed("DATABASE_ERROR", "导出作业状态发生冲突")
        server.emit_event(
            "export.progress",
            task_id,
            {"export_id": export_id, "stage": stage, "completed": int(completed), "total": int(progress_total)},
        )
    if _export_cancel_requested(server, export_id, cancel_event):
        raise ExportCancelled()
    current = server.store.transition_export_job(
        export_id,
        ("queued",),
        require_cancel_requested=False,
        status="preparing",
        current_stage="preparing",
        started_at=now_iso(),
    )
    if current is None or current.get("status") == "cancelling" or current.get("cancel_requested"):
        raise ExportCancelled()
    if current.get("status") != "preparing":
        raise ExportFailed("DATABASE_ERROR", "导出作业无法启动")
    temp_dir = _prepare_export_temp_dir(server.workspace_root, export_id)
    server.store.update_export_job(
        export_id,
        temporary_path=str(temp_dir),
        cleanup_status="pending",
        cleanup_error_code="",
        cleanup_error_message="",
    )
    final_path = _prepare_export_final_path(server.workspace_root, task_id, fmt, export_id)
    server.store.update_export_job(export_id, output_path=str(final_path))

    if fmt == "html":
        result = _render_html_export(server, task, temp_dir, final_path, progress)
    elif fmt == "json":
        result = _render_json_export(server, task, temp_dir, final_path, progress)
    else:
        result = _render_review_export(server, task_id, temp_dir, final_path, progress)

    # 文件是 export_id 唯一命名；DB 完成事务失败或取消竞态时回滚该 job-owned 文件。
    try:
        completed = server.store.complete_export_job(
            export_id,
            task_id=task_id,
            kind=fmt,
            path=str(final_path),
            progress_completed=int(result.get("progress_completed", 0)),
            progress_total=int(result.get("progress_total", 0)),
        )
    except Exception as exc:
        try:
            completion_recorded = server.store.export_completion_recorded(
                export_id, path=str(final_path)
            )
        except Exception:  # noqa: BLE001 - commit 结果无法确认时保留唯一输出，避免误删成功文件
            completion_recorded = None
        if completion_recorded:
            completed = True
        elif completion_recorded is None:
            try:
                server.store.mark_export_cleanup_result(
                    export_id,
                    success=False,
                    error_code="DATABASE_ERROR",
                    error_message="导出完成状态无法确认，已保留唯一输出供诊断",
                )
            except Exception:
                pass
            raise ExportFailed("DATABASE_ERROR", "导出完成状态无法确认，未覆盖既有成功结果") from exc
        else:
            try:
                _remove_job_owned_output(server, export_id, task_id, fmt)
            except CleanupError as cleanup_exc:
                server.store.mark_export_cleanup_result(
                    export_id,
                    success=False,
                    error_code=cleanup_exc.code,
                    error_message="失败导出文件回滚失败，需要人工检查",
                )
            raise ExportFailed("DATABASE_ERROR", "导出完成状态写入失败，未登记成功结果") from exc
    if not completed:
        try:
            _remove_job_owned_output(server, export_id, task_id, fmt)
        except CleanupError as cleanup_exc:
            server.store.mark_export_cleanup_result(
                export_id,
                success=False,
                error_code=cleanup_exc.code,
                error_message="取消后的导出文件回滚失败，需要人工检查",
            )
        if _export_cancel_requested(server, export_id, cancel_event):
            raise ExportCancelled()
        raise ExportFailed("DATABASE_ERROR", "导出完成状态发生冲突，未登记成功结果")
    server.emit_event(
        "export.progress",
        task_id,
        {
            "export_id": export_id,
            "stage": "completed",
            "completed": int(result.get("progress_completed", 0)),
            "total": int(result.get("progress_total", 0)),
        },
    )
    return result


def _schedule_export_jobs(server: Server) -> str | None:
    """持久化 FIFO 调度：全局最多一个导出 worker，其余保持 queued。"""
    with server._export_state_lock:
        if server._shutting_down:
            return None
        if any(thread.is_alive() for thread in server._export_threads.values()):
            return None
        queued = server.store.list_queued_export_jobs_internal(limit=1)
        if not queued:
            return None
        export_id = str(queued[0]["export_id"])
        cancel_event = threading.Event()
        thread = threading.Thread(target=_run_export_worker, args=(server, export_id), daemon=True)
        server._export_cancel_events[export_id] = cancel_event
        server._export_threads[export_id] = thread
        try:
            thread.start()
        except Exception:
            server._export_cancel_events.pop(export_id, None)
            server._export_threads.pop(export_id, None)
            server.store.finish_export_job(
                export_id,
                status="interrupted",
                error_code="ENGINE_PROCESS_EXITED",
                error_message="导出工作线程启动失败，可重试",
            )
            raise
        return export_id


def _run_export_worker(server: Server, export_id: str) -> None:
    job = server.store.get_export_job_internal(export_id)
    task_id = str(job["task_id"]) if job else None
    try:
        _run_export_job_core(server, export_id)  # 成功时已标记 completed + 发 export.progress completed
    except ExportCancelled:
        current = server.store.finish_export_job(export_id, status="cancelled")
        if task_id and current is not None and current.get("status") == "cancelled":
            server.emit_event("export.progress", task_id, {"export_id": export_id, "stage": "cancelled", "completed": 0, "total": 0})
    except ExportFailed as exc:
        current = server.store.finish_export_job(
            export_id, status="failed", error_code=exc.code, error_message=exc.summary
        )
        if task_id and current is not None and current.get("status") == "failed":
            server.emit_event("export.progress", task_id, {"export_id": export_id, "stage": "failed", "error_code": exc.code, "completed": 0, "total": 0})
    except CleanupError as exc:
        current = server.store.finish_export_job(
            export_id, status="failed", error_code=exc.code, error_message=exc.summary
        )
        if task_id and current is not None and current.get("status") == "failed":
            server.emit_event("export.progress", task_id, {"export_id": export_id, "stage": "failed", "error_code": exc.code, "completed": 0, "total": 0})
    except Exception as exc:  # noqa: BLE001
        current = server.store.finish_export_job(
            export_id, status="failed", error_code="UNKNOWN_ERROR", error_message="导出失败"
        )
        if task_id and current is not None and current.get("status") == "failed":
            server.emit_event("export.progress", task_id, {"export_id": export_id, "stage": "failed", "error_code": "UNKNOWN_ERROR", "completed": 0, "total": 0})
        sys.stderr.write(f"[export_worker] export_id={export_id} error={type(exc).__name__}\n")
        sys.stderr.flush()
    finally:
        try:
            _persist_export_temp_cleanup(server, export_id)
        except Exception as exc:  # noqa: BLE001
            sys.stderr.write(f"[export_worker] export_id={export_id} cleanup_temp error={type(exc).__name__}\n")
            sys.stderr.flush()
        if task_id:
            try:
                cleanup_job = server.store.get_export_job(export_id)
                server.emit_event(
                    "export.cleanup",
                    task_id,
                    {
                        "export_id": export_id,
                        "cleanup_status": cleanup_job.get("cleanup_status", "pending") if cleanup_job else "pending",
                    },
                )
            except Exception as exc:  # noqa: BLE001
                server._cleanup_diag(export_id, "emit_export_cleanup", exc)
        with server._export_state_lock:
            server._export_cancel_events.pop(export_id, None)
            server._export_threads.pop(export_id, None)
        try:
            _schedule_export_jobs(server)
        except Exception as exc:  # noqa: BLE001
            server._cleanup_diag(export_id, "schedule_next_export", exc)


def _run_sync_export(server: Server, params: dict, fmt: str) -> dict:
    """同步兼容入口共享核心：创建 job 并在当前线程跑完（无取消）；返回旧形状。"""
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    _assert_not_cleaning(server, task_id)
    try:
        job = server.store.create_export_job(task_id=task_id, format=fmt, require_idle=True)
    except (ExportJobConflictError, ExportJobCapacityError) as exc:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "已有导出正在执行，请稍后重试") from exc
    export_id = job["export_id"]
    cancel_event = threading.Event()
    with server._export_state_lock:
        server._export_cancel_events[export_id] = cancel_event
        server._export_threads[export_id] = threading.current_thread()
    try:
        result = _run_export_job_core(server, export_id)
    except ExportCancelled:  # 同步入口不应触发，防御
        server.store.finish_export_job(export_id, status="cancelled")
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "导出已取消") from None
    except ExportFailed as exc:
        server.store.finish_export_job(
            export_id, status="failed", error_code=exc.code, error_message=exc.summary
        )
        raise ProtocolError(_export_error_code_to_protocol(exc.code), exc.summary) from exc
    except CleanupError as exc:
        server.store.finish_export_job(
            export_id, status="failed", error_code=exc.code, error_message=exc.summary
        )
        raise ProtocolError(_export_error_code_to_protocol(exc.code), exc.summary) from exc
    finally:
        with server._export_state_lock:
            server._export_cancel_events.pop(export_id, None)
            server._export_threads.pop(export_id, None)
        try:
            _persist_export_temp_cleanup(server, export_id)
        except Exception as exc:  # noqa: BLE001
            server._cleanup_diag(export_id, "sync_export_cleanup", exc)
        try:
            _schedule_export_jobs(server)
        except Exception as exc:  # noqa: BLE001
            server._cleanup_diag(export_id, "schedule_after_sync_export", exc)
    if fmt == "review":
        return {"path": result["path"], "record_count": int(result.get("record_count", 0))}
    base = {"path": result["path"], "occurrence_count": int(result.get("occurrence_count", 0))}
    if fmt == "html":
        base["file_size_bytes"] = int(result.get("file_size_bytes", 0))
    return base


def _h_exports_create(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    fmt = _require_format(_require(params, "format", str))
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    _assert_not_cleaning(server, task_id)
    try:
        job = server.store.create_export_job(task_id=task_id, format=fmt)
    except ExportJobConflictError as exc:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "该任务已有同格式导出正在运行") from exc
    except ExportJobCapacityError as exc:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "当前导出任务已达并发上限，请稍后重试") from exc
    try:
        _schedule_export_jobs(server)
    except Exception as exc:
        server.store.finish_export_job(
            job["export_id"],
            status="interrupted",
            error_code="ENGINE_PROCESS_EXITED",
            error_message="导出工作线程启动失败，可重试",
        )
        raise ProtocolError(ErrorCode.UNKNOWN_ERROR, "导出工作线程启动失败，可重试") from exc
    return {"export_id": job["export_id"], "task_id": task_id, "format": fmt, "status": "queued"}


def _h_exports_get(server: Server, params: dict) -> dict:
    export_id = _require(params, "export_id", str)
    _validate_export_id_segment(export_id)
    job = server.store.get_export_job(export_id)
    if job is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"导出作业不存在: {export_id}")
    return job


def _h_exports_list_jobs(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    limit = _validate_results_page_parameter(params, "limit", default=50, minimum=1, maximum=100)
    offset = _validate_results_page_parameter(params, "offset", default=0, minimum=0)
    return {
        "task_id": task_id,
        "items": server.store.list_export_jobs(task_id, limit=limit, offset=offset),
        "limit": limit,
        "offset": offset,
        "total": server.store.count_export_jobs(task_id),
    }


def _h_exports_cancel(server: Server, params: dict) -> dict:
    export_id = _require(params, "export_id", str)
    _validate_export_id_segment(export_id)
    job = server.store.get_export_job(export_id)
    if job is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"导出作业不存在: {export_id}")
    # 幂等：已终态（含 cancelled）→ 直接返回当前状态
    if job["status"] in EXPORT_JOB_TERMINAL_STATUSES:
        return {"export_id": export_id, "status": job["status"]}
    with server._export_state_lock:
        event = server._export_cancel_events.get(export_id)
        thread = server._export_threads.get(export_id)
        worker_alive = event is not None and thread is not None and thread.is_alive()
    if not worker_alive:
        target = "cancelled" if job["status"] == "queued" else "interrupted"
        current = server.store.transition_export_job(
            export_id,
            EXPORT_JOB_ACTIVE_STATUSES,
            status=target,
            current_stage=target,
            cancel_requested=1,
            error_code="" if target == "cancelled" else "ENGINE_PROCESS_EXITED",
            error_message="" if target == "cancelled" else "导出工作线程不存在，可重试",
            finished_at=now_iso(),
        )
        _persist_export_temp_cleanup(server, export_id)
        _schedule_export_jobs(server)
        actual = str(current["status"]) if current else target
        return {"export_id": export_id, "status": actual}
    current = server.store.transition_export_job(
        export_id,
        EXPORT_JOB_PROGRESS_STATUSES,
        status="cancelling",
        cancel_requested=1,
    )
    actual = str(current["status"]) if current else str(job["status"])
    if actual == "cancelling":
        event.set()
    return {"export_id": export_id, "status": actual}


def _h_exports_retry(server: Server, params: dict) -> dict:
    export_id = _require(params, "export_id", str)
    _validate_export_id_segment(export_id)
    old = server.store.get_export_job(export_id)
    if old is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"导出作业不存在: {export_id}")
    if old["status"] not in {"failed", "cancelled", "interrupted"}:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "仅失败、取消或中断的导出可以重试")
    task_id = old["task_id"]
    fmt = old["format"]
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    _assert_not_cleaning(server, task_id)
    try:
        job = server.store.create_export_job(task_id=task_id, format=fmt, retry_of=export_id)
    except ExportJobConflictError as exc:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "该任务已有同格式导出正在运行") from exc
    except ExportJobCapacityError as exc:
        raise ProtocolError(ErrorCode.TASK_STATE_CONFLICT, "当前导出任务已达并发上限，请稍后重试") from exc
    try:
        _schedule_export_jobs(server)
    except Exception as exc:
        server.store.finish_export_job(
            job["export_id"],
            status="interrupted",
            error_code="ENGINE_PROCESS_EXITED",
            error_message="导出工作线程启动失败，可重试",
        )
        raise ProtocolError(ErrorCode.UNKNOWN_ERROR, "导出工作线程启动失败，可重试") from exc
    return {"export_id": job["export_id"], "task_id": task_id, "format": fmt, "status": "queued", "retry_of": export_id}



def _h_exports_list(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    limit = _validate_results_page_parameter(params, "limit", default=20, minimum=1, maximum=100)
    offset = _validate_results_page_parameter(params, "offset", default=0, minimum=0)
    items = server.store.list_exports(task_id=task_id, limit=limit, offset=offset)
    return {"task_id": task_id, "items": items, "limit": limit, "offset": offset}


def run_server(config: EngineConfig | None = None, workspace_root: str | Path | None = None) -> None:
    Server(config=config, workspace_root=workspace_root).run()


__all__ = ["Server", "Handler", "run_server"]
