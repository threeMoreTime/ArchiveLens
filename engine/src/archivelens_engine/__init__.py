"""ArchiveLens OCR engine.

本地 PDF、DJVU、TIFF、JPEG、PNG 档案 OCR 检索引擎。
该包同时提供：

* 传统 CLI 入口（兼容旧脚本与批处理）；
* JSONL stdin/stdout Sidecar server（供 Electron Main 进程驱动）。

引擎所有运行数据写入用户数据目录，不依赖开发机绝对路径。
"""

from __future__ import annotations

__version__ = "0.1.0-alpha.11"

#: Electron Main 与 Python Engine 之间 IPC 协议版本。两端必须一致。
PROTOCOL_VERSION: int = 4

__all__ = ["__version__", "PROTOCOL_VERSION"]
