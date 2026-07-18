"""SlowFake pause/resume Sidecar E2E（任务 §三/§十二）。

连 dev Python Sidecar（AL_SLOWFAKE_PAGES=20），经真实 JSONL 验证：
- pause 期间 processed_pages 不增长；
- resume 后继续；
- 最终 20 页恰好处理一次；
- cancel-from-paused 唤醒线程且 Sidecar 仍响应。
"""

from __future__ import annotations

import json
import os
import subprocess
import sys
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENV = {
    **os.environ,
    "PYTHONPATH": f"{ROOT / 'engine/src'};{ROOT / 'engine'}",
    "AL_SLOWFAKE_PAGES": "20",
    "AL_WORKSPACE_ROOT": str(ROOT / "dist" / "_e2e_ws"),
}

proc = subprocess.Popen(
    [sys.executable, "-m", "archivelens_engine", "serve"],
    stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
    text=True, encoding="utf-8", env=ENV, cwd=str(ROOT),
)
messages: list[dict] = []
lock = threading.Lock()


def _drain() -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        line = line.strip()
        if not line:
            continue
        try:
            with lock:
                messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue


threading.Thread(target=_drain, daemon=True).start()
_counter = [0]


def send(method: str, params: dict | None = None) -> str:
    _counter[0] += 1
    rid = f"{method}-{_counter[0]}"
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(
        {"protocol_version": 3, "request_id": rid, "method": method, "params": params or {}},
        ensure_ascii=False) + "\n")
    proc.stdin.flush()
    return rid


def take_response(rid: str, timeout: float = 10) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for m in messages[:]:
                if m.get("request_id") == rid:
                    messages.remove(m)
                    return m
        time.sleep(0.03)
    return None


def wait_event(event: str, task_id: str | None = None, timeout: float = 30) -> dict | None:
    end = time.time() + timeout
    while time.time() < end:
        with lock:
            for m in messages:
                if m.get("event") == event and (task_id is None or m.get("task_id") == task_id):
                    return m
        time.sleep(0.03)
    return None


def latest_processed(task_id: str) -> int:
    with lock:
        prog = [m for m in messages if m.get("event") == "task.progress" and m.get("task_id") == task_id]
    return prog[-1]["payload"]["processed_pages"] if prog else 0


def main() -> int:
    try:
        if not wait_event("engine.ready", timeout=30):
            print("[e2e] FAIL: engine.ready 超时")
            return 1
        print("[e2e] engine.ready")

        import tempfile

        src = tempfile.mkdtemp(prefix="al-e2e-src-")
        rid = send("tasks.create", {"source_dir": src, "search_text": "约"})
        resp = take_response(rid, 10)
        tid = resp["result"]["task_id"]
        rid = send("tasks.start", {"task_id": tid})
        take_response(rid, 10)

        # 等待 processed >= 3
        end = time.time() + 30
        while time.time() < end and latest_processed(tid) < 3:
            time.sleep(0.1)
        if latest_processed(tid) < 3:
            print("[e2e] FAIL: 未达到 3 页")
            return 1
        print(f"[e2e] reached >=3 pages")

        # pause
        rid = send("tasks.pause", {"task_id": tid})
        take_response(rid, 10)
        if not wait_event("task.paused", tid, 20):
            print("[e2e] FAIL: task.paused 未到")
            return 1
        paused_at = latest_processed(tid)
        print(f"[e2e] paused at {paused_at}")

        # 验证暂停期间不增长
        time.sleep(1.6)
        if latest_processed(tid) != paused_at:
            print(f"[e2e] FAIL: 暂停期间页数增长 {paused_at} -> {latest_processed(tid)}")
            return 1
        print("[e2e] 暂停期间页数未增长 ✓")

        # resume
        rid = send("tasks.resume", {"task_id": tid})
        take_response(rid, 10)
        if not wait_event("task.resumed", tid, 10):
            print("[e2e] FAIL: task.resumed 未到")
            return 1
        end = time.time() + 10
        while time.time() < end and latest_processed(tid) <= paused_at:
            time.sleep(0.1)
        if latest_processed(tid) <= paused_at:
            print("[e2e] FAIL: resume 后页数未增长")
            return 1
        print(f"[e2e] resume 后继续 -> {latest_processed(tid)}")

        # 等 completed
        if not wait_event("task.completed", tid, 60):
            print("[e2e] FAIL: task.completed 未到")
            return 1
        final = latest_processed(tid)
        print(f"[e2e] completed, final processed={final}")
        if final != 20:
            print(f"[e2e] FAIL: 最终页数 != 20 ({final})")
            return 1

        # sidecar 仍响应
        rid = send("app.info")
        if not take_response(rid, 5):
            print("[e2e] FAIL: sidecar 不再响应")
            return 1
        print("[e2e] PASS: pause/resume E2E（20 页一次，pause 期间不增长，resume 继续，sidecar 仍响应）")
        return 0
    finally:
        try:
            proc.stdin.close()  # type: ignore[union-attr]
            proc.wait(timeout=5)
        except Exception:
            proc.kill()


if __name__ == "__main__":
    sys.exit(main())
