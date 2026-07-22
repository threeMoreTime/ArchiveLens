"""Packaged PDF OCR smoke（任务 §十一）。

连接重新打包的 dist/engine exe，扫描 tests/fixtures/ocr，验证：
- 使用 packaged engine（非源码 Python）；
- pypdfium2 渲染 PDF；
- RapidOCR 产出 occurrence；
- results.query 返回命中；
- export.json 可生成。
"""

from __future__ import annotations

import argparse
import html
import json
import os
import queue
import re
import shutil
import subprocess
import sys
import tempfile
import threading
import time
from pathlib import Path

from smoke_output import configure_console, log_status

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FIXTURES = ROOT / "tests" / "fixtures" / "ocr"
EXPECTED_FAILURE_COUNT = 0
TASK_COMPLETION_TIMEOUT = int(os.environ.get("ARCHIVELENS_PACKAGED_OCR_TIMEOUT_SEC", "420"))
PROGRESS_LOG_INTERVAL_SEC = 30.0


def resolve_case(args: argparse.Namespace) -> tuple[str, str, int, dict[str, int]]:
    explicit = args.fixture is not None or args.search_text is not None or args.expected_count is not None
    case_id = args.case_id
    if case_id is None and not explicit:
        case_id = "custom-double"
    if case_id is not None:
        if explicit:
            raise ValueError("--case-id cannot be combined with --fixture/--search-text/--expected-count")
        manifest = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
        case = next((item for item in manifest["cases"] if item["id"] == case_id), None)
        if case is None:
            raise ValueError(f"unknown fixture case: {case_id}")
        expected_matches: dict[str, int] = {}
        for match in case.get("expected_matches", []):
            matched_text = str(match["matched_text"])
            expected_matches[matched_text] = expected_matches.get(matched_text, 0) + 1
        return (
            str(case["file"]),
            str(case["search_text"]),
            int(case["expected_count"]),
            expected_matches,
        )
    if args.fixture is None or args.search_text is None or args.expected_count is None:
        raise ValueError("explicit mode requires --fixture, --search-text, and --expected-count")
    expected_matches = {} if args.expected_count == 0 else {args.search_text: args.expected_count}
    return args.fixture, args.search_text, args.expected_count, expected_matches


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--case-id")
    parser.add_argument("--fixture")
    parser.add_argument("--search-text")
    parser.add_argument("--expected-count", type=int)
    args = parser.parse_args()
    configure_console()

    try:
        fixture_name, search_text, expected_count, expected_matches = resolve_case(args)
    except ValueError as exc:
        log_status("FAIL", str(exc))
        return 2
    fixture_path = (FIXTURES / fixture_name).resolve()
    if fixture_path.parent != FIXTURES.resolve() or not fixture_path.is_file():
        log_status("FAIL", f"fixture missing or outside fixture root: {fixture_name}")
        return 2

    if not EXE.exists():
        log_status("FAIL", f"engine exe missing {EXE}")
        return 1

    run_id = re.sub(r"[^A-Za-z0-9._-]", "-", os.environ.get("ARCHIVELENS_TEST_RUN_ID", "a11-local"))
    source_context = tempfile.TemporaryDirectory(prefix=f"archivelens-ocr-temp-{run_id}-packaged-")
    run_root = Path(source_context.name)
    (run_root / ".archivelens-test-owned").write_text(f"{run_id}\n", encoding="utf-8")
    source_dir = run_root / "source"
    source_dir.mkdir()
    shutil.copy2(fixture_path, source_dir / fixture_path.name)
    env = {**os.environ, "AL_WORKSPACE_ROOT": str(run_root / "workspace")}
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
            {"protocol_version": 4, "request_id": rid, "method": method, "params": params or {}},
            # Match Electron's JSON.stringify output: raw UTF-8 reaches the frozen
            # sidecar, which must not depend on the host console code page.
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

        rid = send("tasks.create", {"source_dir": str(source_dir), "search_text": search_text})
        resp = read_until(rid=rid, timeout=30)
        if not resp or not resp.get("ok"):
            log_status("FAIL", f"tasks.create {resp}")
            return 1
        task_id = resp["result"]["task_id"]
        active_task_id[0] = task_id
        log_status(
            "INFO",
            "task created: "
            + json.dumps(
                {
                    "task_id": task_id,
                    "files": resp["result"].get("file_count"),
                    "search_text": resp["result"].get("search_text"),
                    "search_terms": resp["result"].get("search_terms"),
                },
                ensure_ascii=True,
            ),
        )

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
        task_state = task_resp["result"]
        if task_state.get("search_text") != search_text or task_state.get("search_terms") != [search_text]:
            log_status(
                "FAIL",
                "persisted task search terms mismatch "
                + json.dumps(
                    {
                        "expected": search_text,
                        "actual_text": task_state.get("search_text"),
                        "actual_terms": task_state.get("search_terms"),
                    },
                    ensure_ascii=True,
                ),
            )
            return 1
        failure_count = int(task_state.get("failure_count", -1))
        workspace_dir = Path(task_state.get("workspace_dir") or "")

        rid = send("results.query", {"task_id": task_id, "limit": 200})
        resp = read_until(rid=rid, timeout=30)
        items = resp["result"]["items"]
        total = resp["result"]["total"]
        matched_texts: dict[str, int] = {}
        for it in items:
            matched = str(it.get("matched_text") or it.get("matched_character") or "")
            matched_texts[matched] = matched_texts.get(matched, 0) + 1
        log_status("INFO", f"results total={total} matches={json.dumps(matched_texts, ensure_ascii=True, sort_keys=True)}")

        for item in items:
            matched_text = str(item.get("matched_text") or "")
            if matched_text not in expected_matches:
                log_status("FAIL", f"unexpected matched_text: {item.get('matched_text')!r}")
                return 1
            if not item.get("context_full") or matched_text not in str(item.get("context_full")):
                log_status("FAIL", "occurrence context is missing the matched text")
                return 1
            coordinates = [item.get(key) for key in ("normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1")]
            if any(value is None or not 0 <= float(value) <= 1 for value in coordinates):
                log_status("FAIL", f"invalid normalized bbox: {coordinates}")
                return 1
            if float(item["normalized_x1"]) <= float(item["normalized_x0"]) or float(item["normalized_y1"]) <= float(item["normalized_y0"]):
                log_status("FAIL", f"empty occurrence bbox: {coordinates}")
                return 1
            crop_path = workspace_dir / str(item.get("crop_image_relpath") or "")
            if not item.get("crop_image_relpath") or not crop_path.is_file():
                log_status("FAIL", f"crop missing: {crop_path}")
                return 1

        rid = send("export.json", {"task_id": task_id})
        exp = read_until(rid=rid, timeout=30)
        json_path = Path(exp["result"]["path"])
        if not json_path.exists():
            log_status("FAIL", "export.json was not generated")
            return 1
        log_status("INFO", f"export.json: {json_path}")

        exported = json.loads(json_path.read_text(encoding="utf-8"))
        if exported.get("task", {}).get("search_text") != search_text:
            log_status(
                "FAIL",
                "export.json search_text mismatch "
                + json.dumps(
                    {
                        "expected": search_text,
                        "actual": exported.get("task", {}).get("search_text"),
                    },
                    ensure_ascii=True,
                ),
            )
            return 1
        if len(exported.get("occurrences", [])) != expected_count:
            log_status("FAIL", "export.json occurrence count mismatch")
            return 1

        rid = send("export.html", {"task_id": task_id})
        html_response = read_until(rid=rid, timeout=30)
        if not html_response or not html_response.get("ok"):
            log_status("FAIL", f"export.html {html_response}")
            return 1
        html_path = Path(html_response["result"]["path"])
        html_content = html_path.read_text(encoding="utf-8")
        if f"检索词：{html.escape(search_text, quote=True)}" not in html_content:
            log_status("FAIL", "export.html search_text mismatch")
            return 1
        if "http://" in html_content or "https://" in html_content:
            log_status("FAIL", "export.html contains remote URL")
            return 1

        if total != expected_count:
            log_status("FAIL", f"total={total} expected={expected_count}")
            return 1
        if matched_texts != expected_matches:
            log_status(
                "FAIL",
                f"matches={json.dumps(matched_texts, ensure_ascii=True, sort_keys=True)} "
                f"expected={json.dumps(expected_matches, ensure_ascii=True, sort_keys=True)}",
            )
            return 1
        if failure_count != EXPECTED_FAILURE_COUNT:
            log_status("FAIL", f"failure_count={failure_count} expected={EXPECTED_FAILURE_COUNT}")
            return 1

        log_status(
            "PASS",
            "packaged PDF OCR "
            f"fixture={fixture_name!r} search_text={search_text!r} total={total} "
            f"matches={json.dumps(matched_texts, ensure_ascii=True, sort_keys=True)} "
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
        source_context.cleanup()


if __name__ == "__main__":
    sys.exit(main())
