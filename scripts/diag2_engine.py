"""诊断打包 exe RapidOCR init：读 stdout events + 90s 内存监控。"""
import json
import subprocess
import tempfile
import threading
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FX = ROOT / "tests" / "fixtures" / "ocr"
proc = subprocess.Popen(
    [str(EXE), "serve"], stdin=subprocess.PIPE, stdout=subprocess.PIPE,
    stderr=subprocess.PIPE, text=True, encoding="utf-8",
)
events: list[str] = []


def drain() -> None:
    assert proc.stdout is not None
    for line in proc.stdout:
        events.append(line.rstrip())


threading.Thread(target=drain, daemon=True).start()


def send(m: str, p: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps({"protocol_version": 4, "request_id": m, "method": m, "params": p}) + "\n")
    proc.stdin.flush()


for _ in range(40):
    if any("engine.ready" in e for e in events):
        break
    time.sleep(0.5)
print("[diag2] engine.ready")

send("tasks.create", {"source_dir": tempfile.mkdtemp(prefix="al-d2-"), "search_text": "约"})
tid = None
for _ in range(20):
    time.sleep(0.3)
    for e in events:
        try:
            msg = json.loads(e)
        except json.JSONDecodeError:
            continue
        if msg.get("request_id") == "tasks.create" and msg.get("ok"):
            tid = msg["result"]["task_id"]
            break
    if tid:
        break
print(f"[diag2] task {tid}")
send("tasks.start", {"task_id": tid})

for i in range(18):
    time.sleep(5)
    mem = subprocess.run(
        ["tasklist", "/FI", "IMAGENAME eq archivelens-engine.exe", "/NH", "/FO", "CSV"],
        capture_output=True, text=True,
    ).stdout.strip()[-30:]
    prog = [e for e in events if '"task.progress"' in e]
    started = any('"task.started"' in e for e in events)
    failed = any('"task.failed"' in e for e in events)
    print(f"[diag2] {(i+1)*5}s mem={mem} started={started} progress={len(prog)} failed={failed} total_events={len(events)}")
    if prog or failed:
        break

print("=== 最后 5 events ===")
for e in events[-5:]:
    print(e[:200])
proc.kill()
