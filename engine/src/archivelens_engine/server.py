"""JSONL Sidecar server —— 桌面纵向闭环。

在 Phase 1 协议骨架基础上，补齐任务/结果/校对/导出/演示的完整 handler。
事件带 ``sequence`` 与 ``timestamp``（任务 §六.8），防前端乱序覆盖。
"""

from __future__ import annotations

import hashlib
import json
import os
import shutil
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
from .db.store import LEGACY_TASK_REQUIRES_REVIEW, TaskStore, new_id, now_iso
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
from .runtime.task_state import LEGAL_TRANSITIONS, TERMINAL_TASK_STATUSES, TaskStateConflict
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

    def __init__(self) -> None:
        from rapidocr_onnxruntime import RapidOCR

        self._engine = RapidOCR()
        self._lock = threading.RLock()

    def __call__(self, *args: Any, **kwargs: Any) -> Any:
        with self._lock:
            return self._engine(*args, **kwargs)


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
        self.workspace_root = Path(workspace_root)
        (self.workspace_root / "tasks").mkdir(parents=True, exist_ok=True)
        self.store = TaskStore(db_path or (self.workspace_root / "archivelens.db"))
        self.store.reconcile_incomplete_tasks(reason="ENGINE_PROCESS_EXITED")
        self.build_info = load_build_info()

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
            self.ocr_engine: Any = ThreadSafeRapidOCR()
        else:
            self.ocr_engine = None
        self._shutting_down = False
        self._register_defaults()

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
                "tasks.inspectState": _h_tasks_inspect_state,
                "demo.create": _h_demo_create,
                "results.query": _h_results_query,
                "results.getDetail": _h_results_detail,
                "review.updateDecision": _h_review_decision,
                "review.updateNote": _h_review_note,
                "export.json": _h_export_json,
                "export.review": _h_export_review,
                "export.html": _h_export_html,
                "exports.list": _h_exports_list,
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
    ) -> None:
        source_id = str(getattr(document, "source_id", "") or getattr(document, "relative_path", "") or getattr(document, "document_id", "") or "")
        if not source_id:
            raise ValueError("real scan page completion requires a stable source_id")
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
            if tc.should_cancel():
                self.store.update_task(task_id, status="cancelled", failure_count=failure_count, finished_at=now_iso())
                self.emit_task_event(
                    "task.cancelled",
                    task_id,
                    {"reason": "cancelled"},
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
    if task is not None and task.get("error_code") == LEGACY_TASK_REQUIRES_REVIEW:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "旧任务缺少可信进度，不能自动恢复。请人工确认或重新创建任务。",
            {"reason": LEGACY_TASK_REQUIRES_REVIEW},
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


def _task_workspace_dirs_for_delete(server: Server, task_id: str) -> list[Path]:
    """返回该任务可安全清理的应用自有目录，绝不从任务记录读取任意路径。"""
    if not task_id or Path(task_id).name != task_id:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "任务标识无效，无法清理本地数据")
    workspace_root = server.workspace_root.resolve()
    task_dirs = [workspace_root / "tasks" / task_id, workspace_root / task_id]
    return [path for path in task_dirs if path.exists()]


def _h_tasks_delete(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    if task["status"] not in TERMINAL_TASK_STATUSES:
        raise ProtocolError(
            ErrorCode.TASK_STATE_CONFLICT,
            "任务仍可执行或恢复，必须先取消后才能删除",
            {"status": task["status"]},
        )

    staged_dirs: list[tuple[Path, Path]] = []
    try:
        for task_dir in _task_workspace_dirs_for_delete(server, task_id):
            staged_dir = task_dir.with_name(f".deleting-{task_id}-{new_id()}")
            task_dir.rename(staged_dir)
            staged_dirs.append((task_dir, staged_dir))
    except OSError as exc:
        for original_dir, staged_dir in reversed(staged_dirs):
            if staged_dir.exists():
                staged_dir.rename(original_dir)
        raise ProtocolError(
            ErrorCode.DATABASE_ERROR,
            "无法准备清理任务生成数据，任务未删除",
            {"task_id": task_id, "error": str(exc)},
        )

    try:
        if not server.store.delete_task(task_id):
            raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    except Exception:
        for original_dir, staged_dir in reversed(staged_dirs):
            if staged_dir.exists():
                staged_dir.rename(original_dir)
        raise

    try:
        for _original_dir, staged_dir in staged_dirs:
            shutil.rmtree(staged_dir)
    except OSError as exc:
        raise ProtocolError(
            ErrorCode.DATABASE_ERROR,
            "任务记录已删除，但部分生成数据清理失败",
            {"task_id": task_id, "error": str(exc)},
        )
    return {"task_id": task_id, "deleted": True}


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


def _validate_decision(decision: str) -> str:
    if decision not in {"confirmed", "needs_review", "rejected"}:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, f"非法 decision：{decision}")
    return decision


def _h_review_decision(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occ_id = _require(params, "occurrence_id", str)
    decision = _validate_decision(_require(params, "decision", str))
    updated = server.store.upsert_review(
        task_id=task_id, occurrence_id=occ_id, decision=decision
    )
    return {"occurrence_id": occ_id, "decision": decision, "updated_at": updated}


def _h_review_note(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    occ_id = _require(params, "occurrence_id", str)
    note = _require(params, "note", str)
    updated = server.store.upsert_review(task_id=task_id, occurrence_id=occ_id, note=note)
    return {"occurrence_id": occ_id, "note": note, "updated_at": updated}


def _export_dir(server: Server, task_id: str) -> Path:
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    exports_dir = server.workspace_root / "tasks" / task_id / "exports"
    exports_dir.mkdir(parents=True, exist_ok=True)
    return exports_dir


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
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    total, items = server.store.query_occurrences(task_id=task_id, limit=10**9, offset=0)
    integrity = _export_integrity(server, task, total)
    payload = {"task": task, "occurrences": items, "integrity": integrity, "exported_at": integrity["exported_at"]}
    out = _export_dir(server, task_id) / f"{task_id}-report.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    server.store.add_export(task_id=task_id, kind="json", path=str(out))
    return {"path": str(out), "occurrence_count": total}


def _h_export_review(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    reviews = server.store.list_reviews(task_id)
    payload = {"task_id": task_id, "exported_at": now_iso(), "records": reviews}
    out = _export_dir(server, task_id) / f"{task_id}-review.json"
    out.write_text(json.dumps(payload, ensure_ascii=False, indent=2), encoding="utf-8")
    server.store.add_export(task_id=task_id, kind="review", path=str(out))
    return {"path": str(out), "record_count": len(reviews)}


def _h_exports_list(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    if server.store.get_task(task_id) is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    limit = _validate_results_page_parameter(params, "limit", default=20, minimum=1, maximum=100)
    offset = _validate_results_page_parameter(params, "offset", default=0, minimum=0)
    items = server.store.list_exports(task_id=task_id, limit=limit, offset=offset)
    return {"task_id": task_id, "items": items, "limit": limit, "offset": offset}


def _h_export_html(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    out = _export_dir(server, task_id) / f"{task_id}-report.html"
    try:
        with server.store.occurrence_export_snapshot(task_id) as (total, page_count, items):
            integrity = _export_integrity(server, task, total)
            exported_at = integrity["exported_at"]
            workspace_value = task.get("workspace_dir")
            server.emit_event("export.progress", task_id, {"stage": "preparing", "completed": 0, "total": total})

            def report_progress(stage: str, completed: int, progress_total: int) -> None:
                server.emit_event(
                    "export.progress",
                    task_id,
                    {"stage": stage, "completed": completed, "total": progress_total},
                )

            result = write_offline_review_report(
                output_path=out,
                task=task,
                items=items,
                integrity=integrity,
                workspace_dir=Path(workspace_value) if workspace_value else None,
                exported_at=exported_at,
                expected_page_count=page_count,
                progress=report_progress,
            )
    except Exception:
        server.emit_event("export.progress", task_id, {"stage": "failed", "completed": 0, "total": 0})
        raise
    server.store.add_export(task_id=task_id, kind="html", path=str(out))
    server.emit_event("export.progress", task_id, {"stage": "completed", "completed": total, "total": total})
    return {"path": str(out), "occurrence_count": total, "file_size_bytes": result["file_size_bytes"]}


def run_server(config: EngineConfig | None = None, workspace_root: str | Path | None = None) -> None:
    Server(config=config, workspace_root=workspace_root).run()


__all__ = ["Server", "Handler", "run_server"]
