"""HTML 离线导出 smoke（任务 §十六/§十七）。

真实 OCR fixtures → task.completed → export.html → 验证：
存在 / 大小 / 约 / 約 / ArchiveLens / 无 http(s) / 无开发路径。
"""

from __future__ import annotations

import json
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FX = ROOT / "tests" / "fixtures" / "ocr"

proc = subprocess.Popen(
    [str(EXE), "serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8",
)
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
        {"protocol_version": 1, "request_id": rid, "method": method, "params": params or {}},
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
    try:
        if not wait_event("engine.ready", 30):
            print("FAIL: engine.ready 超时")
            return 1
        print("[html] engine.ready")

        rid = send("tasks.create", {"source_dir": str(FX)})
        r = resp(rid, 30)
        if not r or not r.get("ok"):
            print(f"FAIL: tasks.create {r}")
            return 1
        tid = r["result"]["task_id"]
        print(f"[html] task: {tid}")

        rid = send("tasks.start", {"task_id": tid})
        resp(rid, 30)
        if not wait_event("task.completed", 300):
            print("FAIL: task.completed 超时")
            proc.kill()
            return 1
        print("[html] task.completed")

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
            print(f"FAIL: export.html {r}")
            proc.kill()
            return 1
        html_path = Path(r["result"]["path"])
        print(f"[html] export: {html_path} ({html_path.stat().st_size} bytes)")

        content = html_path.read_text(encoding="utf-8")
        checks = {
            "exists": html_path.exists(),
            "size>1KB": html_path.stat().st_size > 1024,
            "has 约": "约" in content,
            "has 約": "約" in content,
            "has ArchiveLens": "ArchiveLens" in content,
            "no http://": "http://" not in content,
            "no https://": "https://" not in content,
            "no repo source path": str(ROOT) not in content and str(ROOT).replace("\\", "/") not in content,
            "no .tmp": ".tmp" not in content,
            "has 已确认或 confirmed": "已确认" in content or "confirmed" in content.lower(),
        }
        all_ok = True
        for k, v in checks.items():
            print(f"  {'✓' if v else '✗'} {k}")
            if not v:
                all_ok = False

        proc.stdin.close()
        proc.wait(timeout=15)

        if all_ok:
            print("[html] PASS: HTML 离线 smoke（真实 OCR fixtures + export.html）")
            print("[html] 注：简化版 HTML，完整 React/B2 离线 Viewer 未完成")
            return 0
        else:
            print("[html] FAIL: 部分检查未通过")
            return 1
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}")
        proc.kill()
        return 1


if __name__ == "__main__":
    sys.exit(main())
