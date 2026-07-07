"""文档渲染后端抽象（PDF/DJVU）。"""

from .backends import (
    DjvuLibreBackend,
    DocumentBackendError,
    DocumentBackendRegistry,
    PdfiumBackend,
)

__all__ = [
    "DocumentBackendError",
    "PdfiumBackend",
    "DjvuLibreBackend",
    "DocumentBackendRegistry",
]
