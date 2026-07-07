"""Electron Main ↔ Python Engine IPC 协议。

传输层：UTF-8 JSON Lines（stdin/stdout，每行一个完整 JSON 对象）。

协议要点（详见 docs/ipc-protocol.md）：

* stdout **只**输出协议消息；普通日志走 stderr 或日志文件；
* 每条消息必含 ``protocol_version``；
* 请求必含唯一 ``request_id``，响应/事件按需回带；
* 不兼容的协议版本必须**显式失败**，不得静默继续；
* 无效 JSON 不得导致任一端崩溃——由 :func:`safe_parse` 统一兜底。
"""

from __future__ import annotations

import json
import uuid
from dataclasses import dataclass, field
from typing import Any

from . import PROTOCOL_VERSION


# --------------------------------------------------------------------------- #
# 错误码（与 Renderer 侧统一错误模型一一对应，见 docs/ipc-protocol.md）
# --------------------------------------------------------------------------- #
class ErrorCode:
    VALIDATION_ERROR = "VALIDATION_ERROR"
    PATH_NOT_FOUND = "PATH_NOT_FOUND"
    PERMISSION_DENIED = "PERMISSION_DENIED"
    DEPENDENCY_MISSING = "DEPENDENCY_MISSING"
    ENGINE_START_FAILED = "ENGINE_START_FAILED"
    ENGINE_CRASHED = "ENGINE_CRASHED"
    IPC_TIMEOUT = "IPC_TIMEOUT"
    TASK_NOT_FOUND = "TASK_NOT_FOUND"
    TASK_STATE_CONFLICT = "TASK_STATE_CONFLICT"
    DATABASE_ERROR = "DATABASE_ERROR"
    EXPORT_FAILED = "EXPORT_FAILED"
    DISK_SPACE_LOW = "DISK_SPACE_LOW"
    UNSUPPORTED_FILE = "UNSUPPORTED_FILE"
    PROTOCOL_MISMATCH = "PROTOCOL_MISMATCH"
    UNKNOWN_METHOD = "UNKNOWN_METHOD"
    UNKNOWN_ERROR = "UNKNOWN_ERROR"


# --------------------------------------------------------------------------- #
# 消息数据模型
# --------------------------------------------------------------------------- #
@dataclass
class Request:
    protocol_version: int
    request_id: str
    method: str
    params: dict[str, Any] = field(default_factory=dict)


@dataclass
class ErrorPayload:
    code: str
    message: str
    details: dict[str, Any] = field(default_factory=dict)


class ProtocolError(Exception):
    """可被 server 转换为错误响应的业务异常。"""

    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


# --------------------------------------------------------------------------- #
# 序列化辅助
# --------------------------------------------------------------------------- #
def new_request_id() -> str:
    return uuid.uuid4().hex


def safe_parse(line: str) -> dict[str, Any] | None:
    """安全解析一行 JSON。

    无效 JSON 返回 ``None``（调用方记录但不得抛出）。
    """
    line = line.strip()
    if not line:
        return None
    try:
        value = json.loads(line)
    except json.JSONDecodeError:
        return None
    return value if isinstance(value, dict) else None


def make_success(request_id: str, result: dict[str, Any] | None = None) -> str:
    return json.dumps(
        {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "ok": True,
            "result": result or {},
        },
        ensure_ascii=False,
    )


def make_error(
    request_id: str | None,
    code: str,
    message: str,
    details: dict[str, Any] | None = None,
) -> str:
    return json.dumps(
        {
            "protocol_version": PROTOCOL_VERSION,
            "request_id": request_id,
            "ok": False,
            "error": {"code": code, "message": message, "details": details or {}},
        },
        ensure_ascii=False,
    )


def make_event(
    event: str,
    task_id: str | None = None,
    payload: dict[str, Any] | None = None,
) -> str:
    return json.dumps(
        {
            "protocol_version": PROTOCOL_VERSION,
            "event": event,
            "task_id": task_id,
            "payload": payload or {},
        },
        ensure_ascii=False,
    )


def require_protocol_version(message: dict[str, Any]) -> None:
    """校验消息协议版本；不匹配时抛 :class:`ProtocolError`。"""
    version = message.get("protocol_version")
    if version != PROTOCOL_VERSION:
        raise ProtocolError(
            ErrorCode.PROTOCOL_MISMATCH,
            f"IPC 协议版本不匹配：期望 {PROTOCOL_VERSION}，收到 {version!r}",
            {"expected": PROTOCOL_VERSION, "received": version},
        )


__all__ = [
    "ErrorCode",
    "Request",
    "ErrorPayload",
    "ProtocolError",
    "new_request_id",
    "safe_parse",
    "make_success",
    "make_error",
    "make_event",
    "require_protocol_version",
]
