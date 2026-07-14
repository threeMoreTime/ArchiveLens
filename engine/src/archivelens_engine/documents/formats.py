"""ArchiveLens 支持的来源格式与展示信息。"""

from __future__ import annotations

from pathlib import Path


FORMAT_TYPE_BY_SUFFIX = {
    ".pdf": "PDF",
    ".djvu": "DJVU",
    ".djv": "DJV",
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
}

RASTER_FORMAT_BY_SUFFIX = {
    ".tif": "TIFF",
    ".tiff": "TIFF",
    ".jpg": "JPEG",
    ".jpeg": "JPEG",
    ".png": "PNG",
}

COUNT_KEY_BY_SUFFIX = {
    ".pdf": "pdf",
    ".djvu": "djvu",
    ".djv": "djv",
    ".tif": "tiff",
    ".tiff": "tiff",
    ".jpg": "jpeg",
    ".jpeg": "jpeg",
    ".png": "png",
}
FORMAT_COUNT_KEYS = ("pdf", "djvu", "djv", "tiff", "jpeg", "png")

SUPPORTED_SOURCE_SUFFIXES = frozenset(FORMAT_TYPE_BY_SUFFIX)
RASTER_SOURCE_SUFFIXES = frozenset(RASTER_FORMAT_BY_SUFFIX)
SUPPORTED_SOURCE_LABEL = "PDF、DJVU、DJV、TIFF、JPEG 或 PNG"


def document_type(path: Path) -> str:
    return FORMAT_TYPE_BY_SUFFIX[path.suffix.lower()]


def count_key(path: Path) -> str:
    return COUNT_KEY_BY_SUFFIX[path.suffix.lower()]


__all__ = [
    "FORMAT_COUNT_KEYS",
    "FORMAT_TYPE_BY_SUFFIX",
    "RASTER_FORMAT_BY_SUFFIX",
    "RASTER_SOURCE_SUFFIXES",
    "SUPPORTED_SOURCE_LABEL",
    "SUPPORTED_SOURCE_SUFFIXES",
    "count_key",
    "document_type",
]
