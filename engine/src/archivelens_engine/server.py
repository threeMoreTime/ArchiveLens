"""JSONL Sidecar server。

Electron Main 通过 ``child_process.spawn`` 以参数数组启动本模块的
``archivelens-engine serve``，随后经 stdin/stdout 交换 UTF-8 JSON Lines。

健壮性保证（见 docs/ipc-protocol.md §9.5）：

* stdout 写入加锁，保证整行原子输出（不出现半行/粘包错位）；
* 无效 JSON 仅记录到 stderr，不响应、不崩溃；
* 未知方法返回 ``UNKNOWN_METHOD`` 错误响应；
* 任意 handler 异常被兜底为 ``UNKNOWN_ERROR``，server 不退出；
* 启动即发出 ``engine.ready`` 事件，便于 Main 校验协议版本。
"""

from __future__ import annotations

import sys
import threading
from typing import Any, Callable

from . import PROTOCOL_VERSION, __version__
from .config import DEFAULT_CONFIG, EngineConfig
from .diagnostics import detect_all
from .protocol import (
    ErrorCode,
    ProtocolError,
    make_error,
    make_event,
    make_success,
    require_protocol_version,
    safe_parse,
)

Handler = Callable[["Server", dict[str, Any]], dict[str, Any]]


class Server:
    """JSONL 协议服务端。"""

    def __init__(
        self,
        config: EngineConfig | None = None,
        handlers: dict[str, Handler] | None = None,
    ) -> None:
        self.config = config or DEFAULT_CONFIG
        self.handlers: dict[str, Handler] = handlers or {}
        self._stdout_lock = threading.Lock()
        self._register_defaults()

    # ---- 输出 ----
    def emit(self, line: str) -> None:
        """原子写一行到 stdout。"""
        with self._stdout_lock:
            sys.stdout.write(line + "\n")
            sys.stdout.flush()

    def emit_event(self, event: str, task_id: str | None = None, payload: dict | None = None) -> None:
        self.emit(make_event(event, task_id, payload))

    # ---- 默认方法 ----
    def _register_defaults(self) -> None:
        self.handlers.setdefault("app.info", _handle_app_info)
        self.handlers.setdefault("diagnostics.run", _handle_diagnostics)

    # ---- 单行处理 ----
    def handle_line(self, line: str) -> None:
        message = safe_parse(line)
        if message is None:
            # 无 request_id 可回带，仅记录；Main 侧不应依赖该行。
            sys.stderr.write(f"[server] invalid json ignored: {line.strip()[:200]!r}\n")
            return

        request_id = message.get("request_id")
        try:
            require_protocol_version(message)
            method = message.get("method")
            params = message.get("params") or {}
            if not isinstance(params, dict):
                raise ProtocolError(ErrorCode.VALIDATION_ERROR, "params 必须是对象")
            handler = self.handlers.get(method)
            if handler is None:
                raise ProtocolError(
                    ErrorCode.UNKNOWN_METHOD,
                    f"未知方法: {method}",
                    {"method": method},
                )
            result = handler(self, params)
            self.emit(make_success(request_id, result))
        except ProtocolError as exc:
            self.emit(make_error(request_id, exc.code, exc.message, exc.details))
        except Exception as exc:  # noqa: BLE001 —— server 必须兜底，不得因单请求崩溃
            self.emit(make_error(request_id, ErrorCode.UNKNOWN_ERROR, str(exc)))

    def run(self) -> None:
        """主循环：逐行读取 stdin。"""
        self.emit_event(
            "engine.ready",
            payload={
                "engine_version": __version__,
                "protocol_version": PROTOCOL_VERSION,
            },
        )
        for line in sys.stdin:
            self.handle_line(line)


# --------------------------------------------------------------------------- #
# 默认 handler
# --------------------------------------------------------------------------- #
def _handle_app_info(server: Server, params: dict[str, Any]) -> dict[str, Any]:
    return {
        "engine_version": __version__,
        "protocol_version": PROTOCOL_VERSION,
        "python_executable": sys.executable,
    }


def _handle_diagnostics(server: Server, params: dict[str, Any]) -> dict[str, Any]:
    workspace = params.get("workspace_dir")
    workspace_path = None
    if isinstance(workspace, str) and workspace:
        from pathlib import Path

        workspace_path = Path(workspace)
    return detect_all(server.config, workspace_path)


def run_server(config: EngineConfig | None = None) -> None:
    """``python -m archivelens_engine serve`` 入口。"""
    Server(config=config).run()


__all__ = ["Server", "Handler", "run_server"]
