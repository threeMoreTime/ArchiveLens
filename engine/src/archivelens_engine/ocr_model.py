"""ArchiveLens 统一简繁识别模型的锁定信息与路径解析。"""

from __future__ import annotations

import hashlib
import os
import sys
from pathlib import Path


UNIFIED_OCR_MODEL_ID = "PP-OCRv6-small"
UNIFIED_OCR_MODEL_SOURCE_VERSION = "RapidOCR-3.9.1"
UNIFIED_OCR_MODEL_FILE = "PP-OCRv6_rec_small.onnx"
UNIFIED_OCR_MODEL_SHA256 = "6f327246b50388f3c176ae304bd95767ea6dc0c9ae92153ef8cbe210b3c14884"
UNIFIED_OCR_MODEL_CHARSET_SIZE = 18_680
ISOLATED_CHARACTER_TOP_K = 5


def sha256_file(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def validate_unified_ocr_model(path: Path) -> Path:
    """验证统一 OCR 模型存在且与依赖锁中的 SHA-256 一致。"""

    normalized = path.expanduser().resolve()
    if not normalized.is_file():
        raise FileNotFoundError(f"统一 OCR 模型不存在：{normalized}")
    actual = sha256_file(normalized)
    if actual != UNIFIED_OCR_MODEL_SHA256:
        raise RuntimeError(
            "统一 OCR 模型 SHA-256 不匹配："
            f"path={normalized} expected={UNIFIED_OCR_MODEL_SHA256} actual={actual}"
        )
    return normalized


def _candidate_paths() -> list[Path]:
    candidates: list[Path] = []
    configured = os.environ.get("AL_OCR_REC_MODEL")
    if configured:
        candidates.append(Path(configured))

    frozen_root = getattr(sys, "_MEIPASS", None)
    if frozen_root:
        candidates.append(Path(frozen_root) / "archivelens_models" / UNIFIED_OCR_MODEL_FILE)

    module_path = Path(__file__).resolve()
    for parent in module_path.parents:
        candidates.append(
            parent / "dist" / "native" / "win-x64" / "rapidocr" / UNIFIED_OCR_MODEL_FILE
        )
    return candidates


def resolve_unified_ocr_model(*, required: bool = True, verify_hash: bool = True) -> Path | None:
    """解析显式、打包或开发期模型路径，并按锁定 SHA-256 验证。"""

    checked: list[str] = []
    for candidate in _candidate_paths():
        normalized = candidate.expanduser().resolve()
        if str(normalized) in checked:
            continue
        checked.append(str(normalized))
        if not normalized.is_file():
            continue
        if verify_hash:
            validate_unified_ocr_model(normalized)
        return normalized

    if not required:
        return None
    locations = "；".join(checked) if checked else "未生成候选路径"
    raise FileNotFoundError(
        f"缺少统一 OCR 模型 {UNIFIED_OCR_MODEL_FILE}。"
        "请运行 scripts/prepare-native-runtime.ps1 -OcrOnly，"
        f"或通过 AL_OCR_REC_MODEL 指定锁定模型。已检查：{locations}"
    )


__all__ = [
    "ISOLATED_CHARACTER_TOP_K",
    "UNIFIED_OCR_MODEL_CHARSET_SIZE",
    "UNIFIED_OCR_MODEL_FILE",
    "UNIFIED_OCR_MODEL_ID",
    "UNIFIED_OCR_MODEL_SHA256",
    "UNIFIED_OCR_MODEL_SOURCE_VERSION",
    "resolve_unified_ocr_model",
    "sha256_file",
    "validate_unified_ocr_model",
]
