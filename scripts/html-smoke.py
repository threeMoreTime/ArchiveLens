"""HTML 离线导出 smoke（任务 §十六/§十七）。

真实 OCR fixtures → task.completed → export.html → 验证：
存在 / 大小 / 检索词 / ArchiveLens / 无 http(s) / 无开发路径。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

from smoke_output import configure_console, log_status

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FX = ROOT / "tests" / "fixtures" / "ocr"
MODE = os.environ.get("ARCHIVELENS_HTML_SMOKE_MODE", "auto").strip().lower()
SEARCH_TEXT = os.environ.get("ARCHIVELENS_HTML_SMOKE_SEARCH_TEXT", "约")


def start_engine() -> subprocess.Popen[str]:
    packaged_available = EXE.exists()
    use_packaged = MODE == "packaged" or (MODE == "auto" and packaged_available)
    if use_packaged:
        print(f"[html] launch mode: packaged ({EXE})")
        return subprocess.Popen(
            [str(EXE), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
        )

    env = {
        **os.environ,
        "PYTHONPATH": f"{ROOT / 'engine/src'};{ROOT / 'engine'}",
    }
    print(f"[html] launch mode: source ({sys.executable})")
    return subprocess.Popen(
        [sys.executable, "-m", "archivelens_engine", "serve"],
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
        text=True,
        encoding="utf-8",
        env=env,
        cwd=str(ROOT),
    )


proc = start_engine()
messages: list[str] = []
lock = threading.Lock()


def _drain() -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        with lock:
            messages.append(line.rstrip())


threading.Thread(target=_drain, daemon=True).start()
_counter = [0]


def send(method: str, params: dict | None = None) -> str:
    _counter[0] += 1
    rid = f"{method}-{_counter[0]}"
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(
        {"protocol_version": 2, "request_id": rid, "method": method, "params": params or {}},
        ensure_ascii=False) + "\n")
    proc.stdin.flush()
    return rid


def resp(rid: str, timeout: float = 30) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for m in messages[:]:
                if f'"request_id": "{rid}"' in m:
                    messages.remove(m)
                    return json.loads(m)
        time.sleep(0.03)
    return None


def wait_event(event: str, timeout: float = 300) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for m in messages:
                if f'"event": "{event}"' in m:
                    return json.loads(m)
        time.sleep(0.1)
    return None


def main() -> int:
    configure_console()
    try:
        if not wait_event("engine.ready", 30):
            log_status("FAIL", "engine.ready timeout")
            return 1
        log_status("INFO", "engine.ready")

        rid = send("tasks.create", {"source_dir": str(FX), "search_text": SEARCH_TEXT})
        r = resp(rid, 30)
        if not r or not r.get("ok"):
            log_status("FAIL", f"tasks.create {r}")
            return 1
        tid = r["result"]["task_id"]
        log_status("INFO", f"task created: {tid}")

        rid = send("tasks.start", {"task_id": tid})
        resp(rid, 30)
        if not wait_event("task.completed", 300):
            log_status("FAIL", "task.completed timeout")
            proc.kill()
            return 1
        log_status("INFO", "task.completed")

        # 设置 review（验证 review 在 HTML 中显示）
        rid = send("results.query", {"task_id": tid, "limit": 5})
        r = resp(rid, 30)
        items = r["result"]["items"] if r and r.get("ok") else []
        if items:
            send("review.updateDecision", {"task_id": tid, "occurrence_id": items[0]["occurrence_id"], "decision": "confirmed"})
            resp(f"review.updateDecision-{_counter[0]}", 10)

        # export.html
        rid = send("export.html", {"task_id": tid})
        r = resp(rid, 30)
        if not r or not r.get("ok"):
            log_status("FAIL", f"export.html {r}")
            proc.kill()
            return 1
        html_path = Path(r["result"]["path"])
        log_status("INFO", f"export: {html_path} ({html_path.stat().st_size} bytes)")

        content = html_path.read_text(encoding="utf-8")
        checks = {
            "exists": html_path.exists(),
            "size>1KB": html_path.stat().st_size > 1024,
            "has search text": SEARCH_TEXT in content,
            "has ArchiveLens": "ArchiveLens" in content,
            "no http://": "http://" not in content,
            "no https://": "https://" not in content,
            "no repo source path": str(ROOT) not in content and str(ROOT).replace("\\", "/") not in content,
            "no .tmp": ".tmp" not in content,
            "has 已确认或 confirmed": "已确认" in content or "confirmed" in content.lower(),
        }
        all_ok = True
        for k, v in checks.items():
            log_status("PASS" if v else "FAIL", k)
            if not v:
                all_ok = False

        proc.stdin.close()
        proc.wait(timeout=15)

        if all_ok:
            log_status("PASS", "HTML offline smoke passed")
            log_status("INFO", "simplified HTML export path validated; full React/B2 offline viewer still pending")
            return 0
        else:
            log_status("FAIL", "HTML smoke checks failed")
            return 1
    except Exception as exc:  # noqa: BLE001
        log_status("FAIL", exc)
        proc.kill()
        return 1


if __name__ == "__main__":
    sys.exit(main())
