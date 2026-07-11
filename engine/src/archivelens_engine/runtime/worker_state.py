"""Worker 运行态模型。

修复历史缺陷（任务 §十二）：

    旧行为：``checkpoint-*.json`` 存在 ⇒ 判定 Worker 正在运行。
            → 应用崩溃 / 残留 checkpoint 时，被误显示为“运行中”。

    新行为：每个 Worker 持续写 ``worker-state.json``（原子），记录
            ``status`` / ``pid`` / ``heartbeat_at``。真实状态由
            :func:`classify_worker_status` 综合 ``status + pid 存活 + heartbeat 新鲜度``
            判定，不再单凭 checkpoint 存在。

只依赖标准库（避免引入 psutil 等运行时依赖）。
"""

from __future__ import annotations

import json
import os
import subprocess
from dataclasses import asdict, dataclass
from datetime import datetime, timezone
from pathlib import Path

#: heartbeat 默认 stale 阈值（秒）。超过即视为失联。
DEFAULT_HEARTBEAT_TIMEOUT_SECONDS = 120

#: Worker 状态枚举（与任务 §十二 一致）。
WORKER_STATUSES = (
    "queued",
    "starting",
    "running",
    "completed",
    "failed",
    "cancelled",
    "stale",
    "unknown",
)

#: 终态：一旦进入不再被 heartbeat/pid 改写。
TERMINAL_STATUSES = frozenset({"completed", "failed", "cancelled"})


@dataclass
class WorkerState:
    """单个 Worker 的运行态快照。"""

    schema_version: int = 1
    worker_id: str = ""
    task_id: str = ""
    status: str = "queued"
    pid: int | None = None
    input_file: str = ""
    started_at: str | None = None
    heartbeat_at: str | None = None
    finished_at: str | None = None
    exit_code: int | None = None
    processed_pages: int = 0
    total_pages: int = 0
    occurrences_found: int = 0
    failure_count: int = 0
    error_summary: str | None = None

    def to_dict(self) -> dict:
        return asdict(self)

    @classmethod
    def from_dict(cls, data: dict) -> "WorkerState":
        known = {f for f in cls.__dataclass_fields__}  # type: ignore[attr-defined]
        return cls(**{k: v for k, v in data.items() if k in known})


def now_iso() -> str:
    """UTC ISO-8601 时间戳（带时区，便于跨端解析）。"""
    return datetime.now(timezone.utc).isoformat()


def write_atomic(path: Path, data: dict) -> None:
    """原子写入 JSON：先写 ``.tmp`` 再 ``os.replace``，避免半写被误读。"""
    path.parent.mkdir(parents=True, exist_ok=True)
    tmp = path.with_name(path.name + ".tmp")
    tmp.write_text(json.dumps(data, ensure_ascii=False, indent=2), encoding="utf-8")
    os.replace(tmp, path)


def save_worker_state(path: Path, state: WorkerState) -> None:
    write_atomic(path, state.to_dict())


def load_worker_state(path: Path) -> WorkerState | None:
    if not path.exists():
        return None
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return None
    if not isinstance(data, dict):
        return None
    return WorkerState.from_dict(data)


def pid_alive(pid: int | None) -> bool:
    """检测进程是否存活。

    * ``pid`` 为 ``None`` ⇒ ``False``；
    * Windows：``tasklist /FO CSV``，无匹配时 stdout 为空，故「非空且含 pid」即存活；
    * POSIX：``os.kill(pid, 0)``。

    任何异常都视为“不存在”，避免误判为运行中（安全侧倾斜）。
    """
    if pid is None:
        return False
    try:
        if os.name == "nt":
            result = subprocess.run(
                ["tasklist", "/FI", f"PID eq {pid}", "/NH", "/FO", "CSV"],
                stdout=subprocess.PIPE,
                stderr=subprocess.DEVNULL,
                timeout=5,
                shell=False,
            )
            out = result.stdout.decode("utf-8", errors="replace")
            return bool(out.strip()) and str(pid) in out
        os.kill(pid, 0)
        return True
    except (ProcessLookupError, PermissionError, OSError, subprocess.TimeoutExpired):
        return False
    except Exception:  # noqa: BLE001 —— 保守判定为未存活
        return False


def heartbeat_expired(
    heartbeat_at: str | None,
    timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
    *,
    now: str | None = None,
) -> bool:
    """heartbeat 是否过期。"""
    if not heartbeat_at:
        return True
    try:
        hb = datetime.fromisoformat(heartbeat_at)
    except ValueError:
        return True
    current = datetime.fromisoformat(now) if now else datetime.now(timezone.utc)
    elapsed = (current - hb).total_seconds()
    return elapsed > timeout_seconds


def classify_worker_status(
    state: WorkerState,
    *,
    heartbeat_timeout_seconds: float = DEFAULT_HEARTBEAT_TIMEOUT_SECONDS,
    report_completed: bool = False,
    pid_is_alive: bool | None = None,
    now: str | None = None,
) -> str:
    """综合判定 Worker 真实状态（任务 §十二 运行态判断规则）。

    :param report_completed: ``report.json`` 存在且任务成功结束 ⇒ ``completed``。
    :param pid_is_alive: 可注入的 pid 存活判定（测试用）；默认调用 :func:`pid_alive`。
    :param now: 注入当前时间，便于测试。
    """
    if report_completed:
        return "completed"

    status = state.status or "unknown"

    if status in TERMINAL_STATUSES:
        return status

    if status == "running":
        alive = pid_alive(state.pid) if pid_is_alive is None else pid_is_alive
        if alive and not heartbeat_expired(state.heartbeat_at, heartbeat_timeout_seconds, now=now):
            return "running"
        return "stale"

    # 只有 checkpoint 没有 worker-state → queued/starting/unknown，绝不算 running
    if status in ("queued", "starting"):
        return status

    return "unknown"


__all__ = [
    "DEFAULT_HEARTBEAT_TIMEOUT_SECONDS",
    "WORKER_STATUSES",
    "TERMINAL_STATUSES",
    "WorkerState",
    "now_iso",
    "write_atomic",
    "save_worker_state",
    "load_worker_state",
    "pid_alive",
    "heartbeat_expired",
    "classify_worker_status",
]
