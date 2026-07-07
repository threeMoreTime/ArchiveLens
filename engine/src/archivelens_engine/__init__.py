"""ArchiveLens OCR engine.

本地 PDF/DJVU 档案中检索简体“约”与繁体“約”的 OCR 引擎。
该包同时提供：

* 传统 CLI 入口（兼容旧脚本与批处理）；
* JSONL stdin/stdout Sidecar server（供 Electron Main 进程驱动）。

引擎所有运行数据写入用户数据目录，不依赖开发机绝对路径。
"""

from __future__ import annotations

__version__ = "0.1.0-alpha.4"

#: Electron Main 与 Python Engine 之间 IPC 协议版本。两端必须一致。
PROTOCOL_VERSION: int = 1

__all__ = ["__version__", "PROTOCOL_VERSION"]
