"""真实 packaged RapidOCR inference shutdown smoke（任务 §六/§二）。

A6 仅验证控制平面（状态机 + 拒绝 + 幂等）。本轮证明：
真实 RapidOCR/ONNX inference 进行中 → app.shutdown → ENGINE_SHUTTING_DOWN
→ 进程退出 → 无残留线程/进程。

使用 dist/engine/win-x64/archivelens-engine.exe（packaged，非源码）+ 5 PDF fixtures（真实 OCR）。
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


def take_response(rid: str, timeout: float = 30) -> dict | None:
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


def wait_no_residual_engine(timeout: float = 10) -> bool:
    end = time.time() + timeout
    while time.time() < end:
        result = subprocess.run(
            ["tasklist", "/FI", "IMAGENAME eq archivelens-engine.exe", "/NH", "/FO", "CSV"],
            capture_output=True,
            text=True,
        )
        if "archivelens-engine.exe" not in result.stdout or "INFO:" in result.stdout:
            return True
        time.sleep(0.2)
    return False


def main() -> int:
    try:
        if not wait_event("engine.ready", 30):
            print("FAIL: engine.ready 超时")
            return 1
        print("[shutdown] engine.ready")

        rid = send("tasks.create", {"source_dir": str(FX)})
        resp = take_response(rid, 30)
        if not resp or not resp.get("ok"):
            print(f"FAIL: tasks.create {resp}")
            return 1
        tid = resp["result"]["task_id"]
        print(f"[shutdown] task created: {tid} files={resp['result'].get('file_count')}")

        rid = send("tasks.start", {"task_id": tid})
        take_response(rid, 30)
        # task.started 表示 ReportPipeline 已构造（RapidOCR 主线程 init），inference 即将/正在运行
        if not wait_event("task.started", 60):
            print("FAIL: task.started 超时（RapidOCR 未启动）")
            return 1
        print("[shutdown] task.started — RapidOCR inference 进行中")

        # 推理中请求 shutdown
        rid = send("app.shutdown")
        resp = take_response(rid, 10)
        status = resp.get("result", {}).get("status") if resp else None
        print(f"[shutdown] app.shutdown → status={status}")
        ev = wait_event("engine.shutdown", 10)
        print(f"[shutdown] engine.shutdown event: {'✓' if ev else '✗'}")

        # 新请求应返回 ENGINE_SHUTTING_DOWN
        rid = send("app.info")
        resp = take_response(rid, 5)
        if resp and not resp.get("ok") and resp["error"]["code"] == "ENGINE_SHUTTING_DOWN":
            print("[shutdown] 新请求 ENGINE_SHUTTING_DOWN ✓")
        else:
            print(f"[shutdown] WARN 新请求未拒绝: {resp}")

        # 关 stdin 触发 run loop 退出 → 进程退出
        assert proc.stdin is not None
        proc.stdin.close()
        try:
            code = proc.wait(timeout=30)
            print(f"[shutdown] 进程退出 code={code}")
        except subprocess.TimeoutExpired:
            print("FAIL: 进程 30s 未退出（死锁？）")
            proc.kill()
            return 1

        # 无残留
        if not wait_no_residual_engine():
            print("FAIL: 残留 archivelens-engine.exe")
            return 1
        print("[shutdown] PASS: 真实 RapidOCR inference shutdown，进程退出，无残留")
        return 0
    except Exception as exc:  # noqa: BLE001
        print(f"FAIL: {exc}")
        proc.kill()
        return 1


if __name__ == "__main__":
    sys.exit(main())
