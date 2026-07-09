"""CI/local smoke helpers for ASCII-safe console output."""

from __future__ import annotations

from typing import Any
import sys


ALLOWED_STATUSES = {"PASS", "FAIL", "WARN", "INFO", "SKIP"}


def configure_console() -> None:
    if hasattr(sys.stdout, "reconfigure"):
        sys.stdout.reconfigure(encoding="utf-8", errors="backslashreplace")
    if hasattr(sys.stderr, "reconfigure"):
        sys.stderr.reconfigure(encoding="utf-8", errors="backslashreplace")


def ascii_text(value: Any) -> str:
    if isinstance(value, bytes):
        text = value.decode("utf-8", errors="backslashreplace")
    else:
        text = str(value)
    return text.encode("ascii", errors="backslashreplace").decode("ascii")


def log_status(status: str, message: Any) -> None:
    normalized = status.upper()
    if normalized not in ALLOWED_STATUSES:
        raise ValueError(f"unsupported status: {status}")
    print(f"[{normalized}] {ascii_text(message)}", flush=True)
