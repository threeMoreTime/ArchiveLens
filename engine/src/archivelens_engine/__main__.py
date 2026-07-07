"""Engine 统一入口。

* ``archivelens-engine serve``：启动 JSONL Sidecar server（供 Electron 驱动）；
* 其余参数：兼容旧 CLI（等价于 ``report_pipeline.main``），用于批处理与高级用户。

入口故意保持极薄，仅做模式分流，业务逻辑仍在各自模块内。
"""

from __future__ import annotations

import sys


def cli_main() -> None:
    args = sys.argv[1:]
    if args and args[0] == "serve":
        from .server import run_server

        run_server()
        return

    # 传统 CLI 模式：保留原 report_pipeline.main 的全部参数与行为。
    from .report_pipeline import main

    main()


if __name__ == "__main__":
    cli_main()
