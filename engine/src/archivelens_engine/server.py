"""JSONL Sidecar server —— 桌面纵向闭环。

在 Phase 1 协议骨架基础上，补齐任务/结果/校对/导出/演示的完整 handler。
事件带 ``sequence`` 与 ``timestamp``（任务 §六.8），防前端乱序覆盖。
"""

from __future__ import annotations

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
from .config import DEFAULT_CONFIG, EngineConfig
from .db.store import TaskStore, now_iso
from .diagnostics import detect_all
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

Handler = Callable[["Server", dict[str, Any]], dict[str, Any]]


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
            workspace_root = Path(tempfile.mkdtemp(prefix="archivelens-engine-"))
        self.workspace_root = Path(workspace_root)
        (self.workspace_root / "tasks").mkdir(parents=True, exist_ok=True)
        self.store = TaskStore(db_path or (self.workspace_root / "archivelens.db"))

        self.handlers: dict[str, Handler] = {}
        self._stdout_lock = threading.Lock()
        self._seq = 0
        self._seq_lock = threading.Lock()
        self._scan_threads: dict[str, threading.Thread] = {}
        self._task_controls: dict[str, TaskControl] = {}
        # SlowFake 测试模式（任务 §十二）：AL_SLOWFAKE_PAGES>0 时用慢速假处理器替代真实 OCR。
        self.slowfake_pages = int(os.environ.get("AL_SLOWFAKE_PAGES", "0") or "0")
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
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def emit_event(self, event: str, task_id: str | None = None, payload: dict | None = None) -> None:
        self.emit(make_event(event, task_id, payload))

    def emit_task_event(self, event: str, task_id: str, payload: dict | None = None) -> None:
        """带 sequence + timestamp 的事件（任务 §六.8）。"""
        with self._seq_lock:
            self._seq += 1
            seq = self._seq
        msg = {
            "protocol_version": PROTOCOL_VERSION,
            "event": event,
            "task_id": task_id,
            "sequence": seq,
            "timestamp": now_iso(),
            "payload": payload or {},
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
        for line in sys.stdin:
            self.handle_line(line)

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
    def start_scan_thread(self, task_id: str) -> None:
        thread = threading.Thread(target=self._run_scan, args=(task_id,), daemon=True)
        self._scan_threads[task_id] = thread
        thread.start()

    def _run_slowfake(self, task_id: str, tc: TaskControl) -> None:
        """慢速假处理器（任务 §十二 E2E）：N 页，每页 150~300ms，可 pause/resume/cancel。

        用于证明 TaskControl 在真实 Sidecar/线程下：pause 期间页数不增长、resume 继续、
        cancel 唤醒 paused 线程，且每页恰好处理一次。
        """
        import random
        import time as _time

        total = self.slowfake_pages
        self.store.update_task(task_id, total_pages=total)
        processed = 0
        for page_index in range(total):
            if tc.should_cancel():
                break
            if tc.is_paused():
                # 协作式：当前页已完成后真正进入 paused，再发 task.paused（避免假暂停）
                self.store.update_task(task_id, status="paused", processed_pages=processed)
                self.emit_task_event("task.paused", task_id, {"processed_pages": processed})
                tc.wait_if_paused()
                if tc.should_cancel():
                    break
                self.store.update_task(task_id, status="running")
            _time.sleep(random.uniform(0.15, 0.3))
            processed += 1
            self.store.update_task(task_id, processed_pages=processed)
            self.emit_task_event(
                "task.progress",
                task_id,
                {"processed_pages": processed, "total_pages": total, "page_index": page_index},
            )
        if tc.should_cancel():
            self.store.update_task(task_id, status="cancelled", finished_at=now_iso())
            self.emit_task_event("task.cancelled", task_id, {})
        else:
            self.store.update_task(task_id, status="completed", processed_pages=total, finished_at=now_iso())
            self.emit_task_event("task.completed", task_id, {"processed_pages": total})

    def _run_scan(self, task_id: str) -> None:
        """在后台线程跑 ReportPipeline 并把结果导入 TaskStore。

        通过 TaskControl 实现协作式 pause/resume/cancel：管线在每个页面边界
        检查 should_cancel / wait_if_paused（任务 §十二）。
        """
        task = self.store.get_task(task_id)
        if task is None:
            return
        tc = TaskControl()
        self._task_controls[task_id] = tc
        self.emit_task_event("task.started", task_id, {"source_dir": task["source_dir"]})
        if self.slowfake_pages > 0:
            self._run_slowfake(task_id, tc)
            return
        try:
            from .report_pipeline import ReportPipeline  # 延迟导入（重依赖）

            task_workspace = self.workspace_root / "tasks" / task_id
            scan_workspace = task_workspace / "scan"
            output_html = task_workspace / "report.html"
            pipeline = ReportPipeline(
                root_dir=Path(task["source_dir"]),
                output_html=output_html,
                workspace_dir=scan_workspace,
                config=self.config,
                task_control=tc,
                ocr_engine=self.ocr_engine,
            )
            try:
                report = pipeline.run()
            finally:
                pipeline.close()
            self._import_report(task_id, task_workspace, scan_workspace, report)
            self.store.update_task(
                task_id,
                status="completed",
                processed_pages=report.get("stats", {}).get("document_total_pages", 0),
                total_pages=report.get("stats", {}).get("document_total_pages", 0),
                occurrence_count=self.store._count_occurrences(task_id),
                finished_at=now_iso(),
            )
            self.emit_task_event("task.completed", task_id, {"occurrence_count": self.store._count_occurrences(task_id)})
        except Exception as exc:  # noqa: BLE001
            self.store.update_task(
                task_id, status="failed", finished_at=now_iso(), error_message=str(exc)
            )
            self.emit_task_event("task.failed", task_id, {"error": str(exc)})

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
    for tc in server._task_controls.values():
        tc.request_cancel()
    server.emit_event("engine.shutdown", payload={"reason": "requested"})
    return {"status": "shutting_down"}


def _h_tasks_create(server: Server, params: dict) -> dict:
    source_dir = _require(params, "source_dir", str)
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

    task_id = server.store.create_task(
        source_dir=str(src),
        output_dir=str(out),
        workspace_dir="",
        name=params.get("name") or src.name,
        file_count=file_count,
        status="draft",
    )
    server.emit_task_event("task.created", task_id, {"source_dir": str(src), "file_count": file_count, "counts": counts})
    return {"task_id": task_id, "status": "draft", "file_count": file_count, "counts": counts}


def _h_tasks_start(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    server._transition(task_id, "queued")
    server._transition(task_id, "starting")
    server._transition(task_id, "running")
    server.store.update_task(task_id, started_at=now_iso())
    server.start_scan_thread(task_id)
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
    server.emit_task_event("task.pausing", task_id, {})
    return {"task_id": task_id, "status": "pausing"}


def _h_tasks_resume(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    tc = server._task_controls.get(task_id)
    if tc is not None:
        tc.request_resume()
    server._transition(task_id, "running")
    server.emit_task_event("task.resumed", task_id, {})
    return {"task_id": task_id, "status": "running"}


def _h_tasks_cancel(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    tc = server._task_controls.get(task_id)
    if tc is not None:
        tc.request_cancel()
    server.emit_task_event("task.cancelling", task_id, {})
    server.store.update_task(task_id, status="cancelled", finished_at=now_iso())
    server.emit_task_event("task.cancelled", task_id, {})
    return {"task_id": task_id, "status": "cancelled"}


def _h_demo_create(server: Server, params: dict) -> dict:
    from .demo import create_demo

    tasks_root = server.workspace_root / "tasks"
    tasks_root.mkdir(parents=True, exist_ok=True)
    result = create_demo(server.store, tasks_root)
    server.emit_task_event("task.created", result["task_id"], {"demo": True})
    server.emit_task_event("task.completed", result["task_id"], {"demo": True})
    return result


def _h_results_query(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    total, items = server.store.query_occurrences(
        task_id=task_id,
        limit=int(params.get("limit", 100)),
        offset=int(params.get("offset", 0)),
        document=params.get("document"),
        status=params.get("status"),
        character=params.get("character"),
        search=params.get("search"),
    )
    return {"total": total, "items": items, "task_id": task_id}


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


def _h_export_json(server: Server, params: dict) -> dict:
    task_id = _require(params, "task_id", str)
    task = server.store.get_task(task_id)
    total, items = server.store.query_occurrences(task_id=task_id, limit=10**9, offset=0)
    payload = {"task": task, "occurrences": items, "exported_at": now_iso()}
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
    total, items = server.store.query_occurrences(task_id=task_id, limit=10**9, offset=0)
    rows = "".join(
        f"<tr><td>{i + 1}</td><td>{r.get('file_name', '')}</td><td>{r.get('page_number', '')}</td>"
        f"<td>{r.get('matched_character', '')}</td><td>{r.get('context_full', '')}</td>"
        f"<td>{r.get('review_decision') or r.get('verification_status', '')}</td>"
        f"<td>{r.get('review_note') or ''}</td></tr>"
        for i, r in enumerate(items)
    )
    html = (
        "<!doctype html><html lang='zh-CN'><head><meta charset='utf-8'>"
        f"<title>ArchiveLens 报告 — {task_id}</title>"
        "<style>body{font-family:'Microsoft YaHei',sans-serif;padding:24px}"
        "table{border-collapse:collapse;width:100%}td,th{border:1px solid #ddd;padding:6px 8px;font-size:13px}</style>"
        "</head><body>"
        f"<h1>ArchiveLens 检索报告</h1>"
        f"<p>任务：{task.get('name', '')} · 命中：{total}</p>"
        f"<table><thead><tr><th>#</th><th>文件</th><th>页</th><th>字</th><th>上下文</th><th>校对</th><th>备注</th></tr></thead>"
        f"<tbody>{rows}</tbody></table></body></html>"
    )
    out = _export_dir(server, task_id) / f"{task_id}-report.html"
    out.write_text(html, encoding="utf-8")
    server.store.add_export(task_id=task_id, kind="html", path=str(out))
    return {"path": str(out), "occurrence_count": total}


def run_server(config: EngineConfig | None = None, workspace_root: str | Path | None = None) -> None:
    Server(config=config, workspace_root=workspace_root).run()


__all__ = ["Server", "Handler", "run_server"]
