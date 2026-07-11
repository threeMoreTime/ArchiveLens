"""JSONL Sidecar server —— 桌面纵向闭环。

在 Phase 1 协议骨架基础上，补齐任务/结果/校对/导出/演示的完整 handler。
事件带 ``sequence`` 与 ``timestamp``（任务 §六.8），防前端乱序覆盖。
"""

from __future__ import annotations

import html
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
from .db.store import LEGACY_TASK_REQUIRES_REVIEW, TaskStore, now_iso
from .diagnostics import detect_all
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
from .runtime.task_state import LEGAL_TRANSITIONS, TaskStateConflict
from .search_terms import EXACT_LITERAL_SEARCH_MODE, normalize_search_text, unicode_sequence

Handler = Callable[["Server", dict[str, Any]], dict[str, Any]]
SLOWFAKE_SOURCE_ID = "source-main"


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
                "tasks.inspectState": _h_tasks_inspect_state,
                "demo.create": _h_demo_create,
                "results.query": _h_results_query,
                "results.getDetail": _h_results_detail,
                "review.updateDecision": _h_review_decision,
                "review.updateNote": _h_review_note,
                "export.json": _h_export_json,
                "export.review": _h_export_review,
                "export.html": _h_export_html,
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
        source_id = str(getattr(document, "relative_path", "") or getattr(document, "document_id", "") or "")
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
            if tc.should_cancel():
                self.store.update_task(task_id, status="cancelled", finished_at=now_iso())
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
                    finished_at=now_iso(),
                )
                self.emit_task_event(
                    "task.completed",
                    task_id,
                    {
                        "processed_pages": int(final_task.get("processed_pages", final_total_pages) or final_total_pages),
                        "total_pages": final_total_pages,
                        "occurrence_count": final_occurrence_count,
                    },
                    worker_generation=worker_generation,
                )
        except Exception as exc:  # noqa: BLE001
            self.store.update_task(
                task_id,
                status="failed",
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


def _h_tasks_create(server: Server, params: dict) -> dict:
    source_dir = _require(params, "source_dir", str)
    if "parallel_workers" in params and (type(params["parallel_workers"]) is not int or params["parallel_workers"] != 1):
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, "parallel_workers 当前仅支持整数 1")
    try:
        search_text = normalize_search_text(_require(params, "search_text", str))
    except ValueError as exc:
        raise ProtocolError(ErrorCode.VALIDATION_ERROR, str(exc)) from exc
    src = Path(source_dir)
    if not src.exists() or not src.is_dir():
        raise ProtocolError(ErrorCode.PATH_NOT_FOUND, f"来源目录不存在：{source_dir}")
    output_dir = params.get("output_dir") or str(server.workspace_root / "tasks")
    out = Path(output_dir)
    try:
        out.mkdir(parents=True, exist_ok=True)
        (out / ".al-write-probe").write_text("ok", encoding="utf-8")
        (out / ".al-write-probe").unlink(missing_ok=True)
    except OSError as exc:
        raise ProtocolError(ErrorCode.PERMISSION_DENIED, f"输出目录不可写：{output_dir}", {"error": str(exc)})

    # 统计 PDF/DJVU/DJV
    counts = {"pdf": 0, "djvu": 0, "djv": 0}
    for p in src.rglob("*"):
        if not p.is_file():
            continue
        suffix = p.suffix.lower().lstrip(".")
        if suffix in counts:
            counts[suffix] += 1
    file_count = sum(counts.values())

    payload = {
        "source_dir": str(src),
        "file_count": file_count,
        "counts": counts,
        "search_text": search_text,
        "search_terms": [search_text],
        "search_mode": EXACT_LITERAL_SEARCH_MODE,
    }
    task_id, event = server.store.create_task_with_event(
        source_dir=str(src),
        output_dir=str(out),
        workspace_dir="",
        name=params.get("name") or src.name,
        file_count=file_count,
        status="draft",
        search_terms=[search_text],
        search_mode=EXACT_LITERAL_SEARCH_MODE,
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
    return task


def _h_tasks_list(server: Server, params: dict) -> dict:
    limit = int(params.get("limit", 50))
    offset = int(params.get("offset", 0))
    status = params.get("status")
    items = server.store.list_tasks(limit=limit, offset=offset, status=status)
    return {"items": items, "limit": limit, "offset": offset}


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
    scan_complete = task["status"] == "completed"
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
    scan_complete = task["status"] == "completed"
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


def _h_export_html(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    if task is None:
        raise ProtocolError(ErrorCode.TASK_NOT_FOUND, f"任务不存在: {task_id}")
    total, items = server.store.query_occurrences(task_id=task_id, limit=10**9, offset=0)
    integrity = _export_integrity(server, task, total)
    def escaped(value: Any) -> str:
        return html.escape(str(value or ""), quote=True)

    rows = "".join(
        f"<tr><td>{i + 1}</td><td>{escaped(r.get('file_name'))}</td><td>{escaped(r.get('page_number'))}</td>"
        f"<td>{escaped(r.get('matched_text') or r.get('matched_character'))}</td><td>{escaped(r.get('context_full'))}</td>"
        f"<td>{escaped(r.get('review_decision') or r.get('verification_status'))}</td>"
        f"<td>{escaped(r.get('review_note'))}</td></tr>"
        for i, r in enumerate(items)
    )
    search_text = escaped(task.get("search_text"))
    if not integrity["scan_complete"]:
        integrity_banner = "<aside class='warning'>此报告是扫描未完成时的阶段性快照，结果仍可能增加。</aside>"
    elif not integrity["review_complete"]:
        integrity_banner = (
            f"<aside class='warning'>此报告包含未完成校对的结果：尚有 "
            f"{integrity['unreviewed_count']} 条未校对。</aside>"
        )
    else:
        integrity_banner = "<aside class='complete'>扫描和校对均已完成，报告结果已完整核验。</aside>"
    html_document = (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<title>ArchiveLens 报告 — {search_text}</title>"
        "<style>body{font-family:'Microsoft YaHei',sans-serif;padding:24px}"
        "table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;font-size:13px}"
        "aside{padding:10px 12px;margin:12px 0}.warning{background:#fff4ce;border-left:4px solid #d38b00}.complete{background:#e7f5e9;border-left:4px solid #2b8a3e}</style>"
        "</head><body>"
        f"<h1>ArchiveLens 检索报告</h1>"
        f"<p>检索词：{search_text}</p>"
        f"<p>任务：{escaped(task.get('name'))} · 命中：{total}</p>{integrity_banner}"
        f"<p>已校对：{integrity['reviewed_count']} · 未校对：{integrity['unreviewed_count']} · "
        f"扫描完成：{str(integrity['scan_complete']).lower()} · 校对完成：{str(integrity['review_complete']).lower()} · "
        f"导出完整：true</p>"
        f"<table><thead><tr><th>#</th><th>文件</th><th>页</th><th>匹配词</th><th>上下文</th><th>校对</th><th>备注</th></tr></thead>"
        f"<tbody>{rows}</tbody></table></body></html>"
    )
    out = _export_dir(server, task_id) / f"{task_id}-report.html"
    out.write_text(html_document, encoding="utf-8")
    server.store.add_export(task_id=task_id, kind="html", path=str(out))
    return {"path": str(out), "occurrence_count": total}


def run_server(config: EngineConfig | None = None, workspace_root: str | Path | None = None) -> None:
    Server(config=config, workspace_root=workspace_root).run()


__all__ = ["Server", "Handler", "run_server"]
