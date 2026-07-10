"""Engine 统一入口。

* ``archivelens-engine serve``：启动 JSONL Sidecar server（供 Electron 驱动）；
* 其余参数：兼容旧 CLI（等价于 ``report_pipeline.main``），用于批处理与高级用户。

入口故意保持极薄，仅做模式分流，业务逻辑仍在各自模块内。
"""

from __future__ import annotations

import sys


def configure_utf8_stdio() -> None:
    """Keep JSONL IPC UTF-8 even when a frozen Windows executable ignores env hints."""
    for stream in (sys.stdin, sys.stdout, sys.stderr):
        reconfigure = getattr(stream, "reconfigure", None)
        if callable(reconfigure):
            reconfigure(encoding="utf-8", errors="strict")


def cli_main() -> None:
    configure_utf8_stdio()
    args = sys.argv[1:]
    if args and args[0] == "serve":
        from archivelens_engine.server import run_server

        run_server()
        return

    # 传统 CLI 模式：保留原 report_pipeline.main 的全部参数与行为。
    from archivelens_engine.report_pipeline import main

    main()


if __name__ == "__main__":
    cli_main()
