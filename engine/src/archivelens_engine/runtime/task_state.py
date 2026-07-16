"""Task 状态机。

任务 §十二 要求的完整状态集合与合法转换。任何越权转换抛
:class:`TaskStateConflict`（对应 IPC ``TASK_STATE_CONFLICT``），
避免 UI 显示“正在运行”而底层实际已停滞。
"""

from __future__ import annotations

from dataclasses import dataclass, field
from datetime import datetime, timezone

#: Task 状态枚举（任务 §十二）。
TASK_STATUSES = (
    "draft",
    "queued",
    "starting",
    "running",
    "pausing",
    "paused",
    "stopping",
    "completed",
    "failed",
    "cancelled",
    "recoverable",
    "stale",
)

#: 终态：不再自动流转。
TERMINAL_TASK_STATUSES = frozenset({"completed", "failed", "cancelled"})

#: 可由 ``tasks.resume`` 直接恢复的状态集合。
#:
#: ``stale`` 必须先由恢复协调逻辑归一化为 ``recoverable``；``failed`` 是
#: 已完成失败记录，未来如需重试应使用独立 retry 合同，不能复用 resume。
RESUMABLE_STATUSES = frozenset({"paused", "recoverable"})

#: 合法状态转换（from → {to...}）。
LEGAL_TRANSITIONS: dict[str, frozenset[str]] = {
    "draft": frozenset({"queued", "cancelled"}),
    "queued": frozenset({"starting", "cancelled"}),
    "starting": frozenset({"running", "failed", "cancelled"}),
    "running": frozenset({"pausing", "stopping", "completed", "failed", "recoverable"}),
    "pausing": frozenset({"paused", "running", "failed", "stopping"}),
    "paused": frozenset({"running", "stopping", "cancelled"}),
    "stopping": frozenset({"completed", "cancelled", "failed"}),
    "recoverable": frozenset({"queued", "cancelled", "running"}),
    "stale": frozenset({"recoverable", "cancelled"}),
    "completed": frozenset(),
    "failed": frozenset({"queued", "cancelled", "recoverable"}),
    "cancelled": frozenset(),
}


class TaskStateConflict(Exception):
    """非法状态转换。"""

    def __init__(self, current: str, target: str) -> None:
        super().__init__(f"非法任务状态转换：{current} → {target}")
        self.current = current
        self.target = target


@dataclass
class TaskState:
    """单个扫描任务的状态快照。"""

    task_id: str = ""
    status: str = "draft"
    source_dir: str = ""
    output_dir: str = ""
    worker_count: int = 1
    created_at: str = field(default_factory=lambda: datetime.now(timezone.utc).isoformat())
    started_at: str | None = None
    finished_at: str | None = None
    total_pages: int = 0
    processed_pages: int = 0
    occurrences_found: int = 0
    failure_count: int = 0
    last_error: str | None = None

    def transition(self, target: str) -> str:
        """校验并执行状态转换；非法时抛 :class:`TaskStateConflict`。"""
        legal = LEGAL_TRANSITIONS.get(self.status, frozenset())
        if target not in legal:
            raise TaskStateConflict(self.status, target)
        self.status = target
        now = datetime.now(timezone.utc).isoformat()
        if target == "running" and self.started_at is None:
            self.started_at = now
        if target in TERMINAL_TASK_STATUSES and self.finished_at is None:
            self.finished_at = now
        return target


def can_pause(status: str) -> bool:
    return status in {"running"}


def can_resume(status: str) -> bool:
    return status in RESUMABLE_STATUSES


def can_cancel(status: str) -> bool:
    return status not in TERMINAL_TASK_STATUSES


__all__ = [
    "TASK_STATUSES",
    "TERMINAL_TASK_STATUSES",
    "RESUMABLE_STATUSES",
    "LEGAL_TRANSITIONS",
    "TaskStateConflict",
    "TaskState",
    "can_pause",
    "can_resume",
    "can_cancel",
]
