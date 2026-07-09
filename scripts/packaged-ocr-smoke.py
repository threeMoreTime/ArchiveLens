"""Packaged PDF OCR smoke（任务 §十一）。

连接重新打包的 dist/engine exe，扫描 tests/fixtures/ocr，验证：
- 使用 packaged engine（非源码 Python）；
- pypdfium2 渲染 PDF；
- RapidOCR 产出 occurrence；
- results.query 返回命中；
- export.json 可生成。
"""

from __future__ import annotations

import json
import os
import queue
import subprocess
import sys
import threading
import time
from pathlib import Path

from smoke_output import configure_console, log_status

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FIXTURES = ROOT / "tests" / "fixtures" / "ocr"
WS = ROOT / "dist" / "_ocr_ws"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
EXPECTED_TOTAL = 14
EXPECTED_COUNTS = {"约": 7, "約": 7}
EXPECTED_FAILURE_COUNT = 0
TASK_COMPLETION_TIMEOUT = int(os.environ.get("ARCHIVELENS_PACKAGED_OCR_TIMEOUT_SEC", "420"))
PROGRESS_LOG_INTERVAL_SEC = 30.0


def main() -> int:
    configure_console()

    if not EXE.exists():
        log_status("FAIL", f"engine exe missing {EXE}")
        return 1

    env = {**os.environ, "AL_WORKSPACE_ROOT": str(WS)}
    proc = subprocess.Popen(
        [str(EXE), "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
    )
    stdout_queue: queue.Queue[str | None] = queue.Queue()
    stderr_tail: list[str] = []
    active_task_id: list[str | None] = [None]
    last_progress_log_at = [0.0]

    counter = [0]

    def pump_stdout() -> None:
        assert proc.stdout is not None
        for line in proc.stdout:
            stdout_queue.put(line)
        stdout_queue.put(None)

    def pump_stderr() -> None:
        assert proc.stderr is not None
        for line in proc.stderr:
            stderr_tail.append(line.rstrip())
            if len(stderr_tail) > 50:
                del stderr_tail[:-50]

    threading.Thread(target=pump_stdout, daemon=True).start()
    threading.Thread(target=pump_stderr, daemon=True).start()

    def send(method: str, params: dict | None = None) -> str:
        counter[0] += 1
        rid = f"r{counter[0]}"
        line = json.dumps(
            {"protocol_version": 1, "request_id": rid, "method": method, "params": params or {}},
            ensure_ascii=False,
        )
        assert proc.stdin is not None
        proc.stdin.write(line + "\n")
        proc.stdin.flush()
        return rid

    def read_until(rid=None, event=None, timeout=300):
        end = time.time() + timeout
        while time.time() < end:
            remaining = max(0.1, end - time.time())
            try:
                line = stdout_queue.get(timeout=min(1.0, remaining))
            except queue.Empty:
                if proc.poll() is not None:
                    return None
                continue
            if line is None:
                return None
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if (
                msg.get("event") == "task.progress"
                and msg.get("task_id") == active_task_id[0]
                and (time.time() - last_progress_log_at[0]) >= PROGRESS_LOG_INTERVAL_SEC
            ):
                payload = msg.get("payload") or {}
                log_status(
                    "INFO",
                    "progress "
                    + json.dumps(
                        {
                            "task_id": msg.get("task_id"),
                            "page_no": payload.get("page_no"),
                            "processed_pages": payload.get("processed_pages"),
                            "source_id": payload.get("source_id"),
                        },
                        ensure_ascii=True,
                    ),
                )
                last_progress_log_at[0] = time.time()
            if rid and msg.get("request_id") == rid:
                return msg
            if event and msg.get("event") == event:
                return msg
        return None

    def stderr_summary() -> str:
        if not stderr_tail:
            return "<stderr empty>"
        return " | ".join(stderr_tail[-10:])

    try:
        if not read_until(event="engine.ready", timeout=40):
            log_status("FAIL", "engine.ready timeout")
            return 1
        log_status("INFO", "engine.ready")

        rid = send("tasks.create", {"source_dir": str(FIXTURES)})
        resp = read_until(rid=rid, timeout=30)
        if not resp or not resp.get("ok"):
            log_status("FAIL", f"tasks.create {resp}")
            return 1
        task_id = resp["result"]["task_id"]
        active_task_id[0] = task_id
        log_status("INFO", f"task created: {task_id} files={resp['result'].get('file_count')}")

        rid = send("tasks.start", {"task_id": task_id})
        read_until(rid=rid, timeout=30)

        completed = read_until(event="task.completed", timeout=TASK_COMPLETION_TIMEOUT)
        if not completed:
            failed = read_until(event="task.failed", timeout=5)
            rid = send("tasks.get", {"task_id": task_id})
            task_state = read_until(rid=rid, timeout=30)
            log_status(
                "FAIL",
                "task did not complete in time "
                + json.dumps(
                    {
                        "timeout_sec": TASK_COMPLETION_TIMEOUT,
                        "task_failed_event": failed,
                        "task_state": task_state.get("result") if task_state and task_state.get("ok") else task_state,
                        "stderr_tail": stderr_tail[-10:],
                    },
                    ensure_ascii=True,
                ),
            )
            return 1
        log_status("INFO", "task.completed")

        rid = send("tasks.get", {"task_id": task_id})
        task_resp = read_until(rid=rid, timeout=30)
        if not task_resp or not task_resp.get("ok"):
            log_status("FAIL", f"tasks.get {task_resp}")
            return 1
        failure_count = int(task_resp["result"].get("failure_count", -1))

        rid = send("results.query", {"task_id": task_id, "limit": 200})
        resp = read_until(rid=rid, timeout=30)
        items = resp["result"]["items"]
        total = resp["result"]["total"]
        chars: dict[str, int] = {}
        for it in items:
            chars[it["matched_character"]] = chars.get(it["matched_character"], 0) + 1
        log_status("INFO", f"results total={total} chars={json.dumps(chars, ensure_ascii=True, sort_keys=True)}")

        rid = send("export.json", {"task_id": task_id})
        exp = read_until(rid=rid, timeout=30)
        json_path = Path(exp["result"]["path"])
        if not json_path.exists():
            log_status("FAIL", "export.json was not generated")
            return 1
        log_status("INFO", f"export.json: {json_path}")

        if total == 0:
            log_status("FAIL", "no occurrences found")
            return 1
        if "约" not in chars and "約" not in chars:
            log_status("FAIL", "neither simplified nor traditional target characters were found")
            return 1
        if total != EXPECTED_TOTAL:
            log_status("FAIL", f"total={total} expected={EXPECTED_TOTAL}")
            return 1
        if chars != EXPECTED_COUNTS:
            log_status(
                "FAIL",
                f"chars={json.dumps(chars, ensure_ascii=True, sort_keys=True)} "
                f"expected={json.dumps(EXPECTED_COUNTS, ensure_ascii=True, sort_keys=True)}",
            )
            return 1
        if failure_count != EXPECTED_FAILURE_COUNT:
            log_status("FAIL", f"failure_count={failure_count} expected={EXPECTED_FAILURE_COUNT}")
            return 1

        log_status(
            "PASS",
            "packaged PDF OCR "
            f"total={total} chars={json.dumps(chars, ensure_ascii=True, sort_keys=True)} "
            f"failure_count={failure_count}"
        )
        return 0
    finally:
        try:
            proc.stdin.close()  # type: ignore[union-attr]
        except Exception:
            pass
        try:
            proc.wait(timeout=10)
        except subprocess.TimeoutExpired:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
