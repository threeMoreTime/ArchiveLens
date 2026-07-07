"""协作式任务控制（任务 §十二）。

为 ReportPipeline 页循环提供 cancel / pause 同步原语，使扫描能：

* 处理当前页之前检查 cancel；
* 处理完当前页并保存 checkpoint 后，在 pause 状态阻塞等待 resume；
* cancel / Engine shutdown 能唤醒 paused 线程安全退出。

不 busy-loop：基于 :class:`threading.Event`，``wait_if_paused`` 周期性重检
以兼顾 cancel 唤醒。
"""

from __future__ import annotations

import threading


class TaskControl:
    def __init__(self) -> None:
        self._cancel = threading.Event()
        self._pause = threading.Event()  # set 表示处于暂停

    # ---- cancel ----
    def should_cancel(self) -> bool:
        return self._cancel.is_set()

    def request_cancel(self) -> None:
        self._cancel.set()
        self._pause.clear()  # 唤醒可能正在 wait 的暂停

    # ---- pause / resume ----
    def request_pause(self) -> None:
        self._pause.set()

    def request_resume(self) -> None:
        self._pause.clear()

    def is_paused(self) -> bool:
        return self._pause.is_set()

    def wait_if_paused(self, poll_seconds: float = 0.2) -> None:
        """若处于暂停则阻塞，直到 resume 或 cancel。"""
        while self._pause.is_set() and not self._cancel.is_set():
            self._pause.wait(timeout=poll_seconds)


__all__ = ["TaskControl"]
