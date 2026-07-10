"""诊断打包 engine exe 的真实扫描卡点（RapidOCR 加载）。"""
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
stderr_buf: list[str] = []


def drain_stderr() -> None:
    assert proc.stderr is not None
    for line in proc.stderr:
        stderr_buf.append(line.rstrip())


threading.Thread(target=drain_stderr, daemon=True).start()


def send(method: str, params: dict) -> None:
    assert proc.stdin is not None
    proc.stdin.write(json.dumps(
        {"protocol_version": 2, "request_id": method, "method": method, "params": params},
        ensure_ascii=False) + "\n")
    proc.stdin.flush()


assert proc.stdout is not None
# 等 ready
for _ in range(40):
    line = proc.stdout.readline()
    if not line:
        break
    if "engine.ready" in line:
        print("[diag] engine.ready")
        break

send("tasks.create", {"source_dir": str(FX), "search_text": "约"})
tid = None
for _ in range(10):
    line = proc.stdout.readline()
    if not line:
        break
    msg = json.loads(line)
    if msg.get("request_id") == "tasks.create":
        tid = msg["result"]["task_id"]
        print(f"[diag] task {tid} files={msg['result'].get('file_count')}")
        break

if tid:
    send("tasks.start", {"task_id": tid})
    print("[diag] tasks.start sent, 等待 25s 观察 RapidOCR 加载/扫描...")
    time.sleep(25)

print("=== stderr (尾 30 行) ===")
print("\n".join(stderr_buf[-30:]) or "(空)")
proc.kill()
print("[diag] engine killed")
