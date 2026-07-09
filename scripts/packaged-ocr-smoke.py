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
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
EXE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
FIXTURES = ROOT / "tests" / "fixtures" / "ocr"
WS = ROOT / "dist" / "_ocr_ws"
EXPECTED = json.loads((FIXTURES / "expected.json").read_text(encoding="utf-8"))
EXPECTED_TOTAL = 14
EXPECTED_COUNTS = {"约": 7, "約": 7}
EXPECTED_FAILURE_COUNT = 0


def main() -> int:
    if not EXE.exists():
        print(f"[smoke] FAIL: engine exe 不存在 {EXE}")
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

    counter = [0]

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
        assert proc.stdout is not None
        while time.time() < end:
            line = proc.stdout.readline()
            if not line:
                return None
            try:
                msg = json.loads(line)
            except json.JSONDecodeError:
                continue
            if rid and msg.get("request_id") == rid:
                return msg
            if event and msg.get("event") == event:
                return msg
        return None

    try:
        if not read_until(event="engine.ready", timeout=40):
            print("[smoke] FAIL: engine.ready 超时")
            return 1
        print("[smoke] engine.ready")

        rid = send("tasks.create", {"source_dir": str(FIXTURES)})
        resp = read_until(rid=rid, timeout=30)
        if not resp or not resp.get("ok"):
            print("[smoke] FAIL: tasks.create", resp)
            return 1
        task_id = resp["result"]["task_id"]
        print(f"[smoke] task created: {task_id} files={resp['result'].get('file_count')}")

        rid = send("tasks.start", {"task_id": task_id})
        read_until(rid=rid, timeout=30)

        completed = read_until(event="task.completed", timeout=420)
        if not completed:
            failed = read_until(event="task.failed", timeout=5)
            print("[smoke] FAIL: 任务未完成", failed)
            return 1
        print("[smoke] task.completed")

        rid = send("tasks.get", {"task_id": task_id})
        task_resp = read_until(rid=rid, timeout=30)
        if not task_resp or not task_resp.get("ok"):
            print("[smoke] FAIL: tasks.get", task_resp)
            return 1
        failure_count = int(task_resp["result"].get("failure_count", -1))

        rid = send("results.query", {"task_id": task_id, "limit": 200})
        resp = read_until(rid=rid, timeout=30)
        items = resp["result"]["items"]
        total = resp["result"]["total"]
        chars: dict[str, int] = {}
        for it in items:
            chars[it["matched_character"]] = chars.get(it["matched_character"], 0) + 1
        print(f"[smoke] results total={total} chars={chars}")

        rid = send("export.json", {"task_id": task_id})
        exp = read_until(rid=rid, timeout=30)
        json_path = Path(exp["result"]["path"])
        if not json_path.exists():
            print("[smoke] FAIL: export.json 未生成")
            return 1
        print(f"[smoke] export.json: {json_path}")

        if total == 0:
            print("[smoke] FAIL: 无任何 occurrence（OCR 未命中）")
            return 1
        if "约" not in chars and "約" not in chars:
            print("[smoke] FAIL: 既无“约”也无“約”")
            return 1
        if total != EXPECTED_TOTAL:
            print(f"[smoke] FAIL: total={total}，预期 {EXPECTED_TOTAL}")
            return 1
        if chars != EXPECTED_COUNTS:
            print(f"[smoke] FAIL: chars={chars}，预期 {EXPECTED_COUNTS}")
            return 1
        if failure_count != EXPECTED_FAILURE_COUNT:
            print(f"[smoke] FAIL: failure_count={failure_count}，预期 {EXPECTED_FAILURE_COUNT}")
            return 1

        print(
            f"[smoke] PASS: packaged PDF OCR total={total} chars={chars} failure_count={failure_count}，"
            "pypdfium2 渲染，RapidOCR 识别"
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
