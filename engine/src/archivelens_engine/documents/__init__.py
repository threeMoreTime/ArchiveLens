"""文档渲染后端抽象（PDF/DJVU/TIFF/JPEG/PNG）。"""

from .backends import (
    DjvuLibreBackend,
    DocumentBackendError,
    DocumentBackendRegistry,
    PdfiumBackend,
    RasterImageBackend,
)

__all__ = [
    "DocumentBackendError",
    "PdfiumBackend",
    "DjvuLibreBackend",
    "RasterImageBackend",
    "DocumentBackendRegistry",
]
