"""Folder source preflight and safe enumeration.

The preflight contract is intentionally independent from the renderer.  It is
also used by task creation so a renderer supplied summary can never authorize a
different directory snapshot.  Directory reparse points and symbolic links are
not followed.
"""

from __future__ import annotations

import ctypes
import hashlib
import os
import shutil
import stat
import threading
from pathlib import Path
from typing import Any

from .config import EngineConfig
from .documents import DocumentBackendError, DocumentBackendRegistry
from .documents.formats import FORMAT_COUNT_KEYS, SUPPORTED_SOURCE_SUFFIXES, count_key


DETAIL_LIMIT = 50
LARGE_FILE_COUNT = 200
LARGE_PAGE_COUNT = 500
LARGE_SOURCE_BYTES = 10 * 1024**3
BASE_REQUIRED_BYTES = 256 * 1024**2
PER_PAGE_REQUIRED_BYTES = 8 * 1024**2
SOURCE_INDEX_RATIO = 0.25
DISK_SAFETY_RATIO = 1.25
WINDOWS_REPARSE_POINT = 0x0400


class PreflightCancelled(Exception):
    """Raised when the caller cancels a running preflight."""


def _is_reparse_stat(value: os.stat_result) -> bool:
    return bool(getattr(value, "st_file_attributes", 0) & WINDOWS_REPARSE_POINT)


def _is_network_path(path: Path) -> bool:
    raw = str(path)
    if raw.startswith(("\\\\", "//")):
        return True
    if os.name != "nt":
        return False
    anchor = path.anchor
    if not anchor:
        return False
    try:
        # DRIVE_REMOTE = 4.  GetDriveTypeW requires no extra dependency.
        return int(ctypes.windll.kernel32.GetDriveTypeW(str(anchor))) == 4  # type: ignore[attr-defined]
    except (AttributeError, OSError, ValueError):
        return False


def _assert_source_chain_no_reparse(path: Path) -> Path:
    """Return an absolute lexical path after checking every existing component."""

    absolute = path.absolute()
    anchor = Path(absolute.anchor)
    current = anchor
    parts = absolute.parts[1:] if absolute.anchor else absolute.parts
    for part in parts:
        current = current / part
        value = current.lstat()
        if _is_reparse_stat(value) or current.is_symlink():
            raise PermissionError(f"来源路径包含 junction、reparse point 或符号链接：{current}")
    return absolute


def _check_cancel(cancel_event: threading.Event | None) -> None:
    if cancel_event is not None and cancel_event.is_set():
        raise PreflightCancelled()


def _detail(items: list[dict[str, Any]], item: dict[str, Any]) -> None:
    if len(items) < DETAIL_LIMIT:
        items.append(item)


def _source_signature_matches(path: Path) -> bool:
    suffix = path.suffix.lower()
    with path.open("rb") as handle:
        header = handle.read(16)
    if suffix == ".pdf":
        return header.startswith(b"%PDF-")
    if suffix in {".djvu", ".djv"}:
        return header.startswith(b"AT&TFORM")
    # RasterImageBackend validates both content and declared extension.
    return True


def _estimated_required_bytes(total_bytes: int, known_pages: int) -> int:
    estimate = BASE_REQUIRED_BYTES + int(total_bytes * SOURCE_INDEX_RATIO) + known_pages * PER_PAGE_REQUIRED_BYTES
    return int(estimate * DISK_SAFETY_RATIO)


def _warning(code: str, message: str) -> dict[str, str]:
    return {"code": code, "message": message}


def preflight_folder(
    source_dir: str | Path,
    workspace_root: str | Path,
    config: EngineConfig,
    *,
    cancel_event: threading.Event | None = None,
) -> tuple[dict[str, Any], list[dict[str, str]]]:
    """Inspect a folder without following links and return report + manifest.

    The returned manifest is private engine data used to freeze the safe file
    set.  The public report contains only bounded diagnostic details.
    """

    root_input = Path(source_dir)
    _check_cancel(cancel_event)
    try:
        root_input = _assert_source_chain_no_reparse(root_input)
        root_lstat = root_input.lstat()
    except FileNotFoundError as exc:
        raise FileNotFoundError(f"来源目录不存在：{source_dir}") from exc
    except OSError as exc:
        raise PermissionError(f"无法读取来源目录：{source_dir}：{exc}") from exc
    if not stat.S_ISDIR(root_lstat.st_mode):
        raise NotADirectoryError(f"来源路径不是文件夹：{source_dir}")
    if _is_reparse_stat(root_lstat) or root_input.is_symlink():
        raise PermissionError("来源根目录不能是 junction、reparse point 或符号链接")
    root = root_input.resolve(strict=True)

    backend_registry = DocumentBackendRegistry(config)
    format_counts = {key: 0 for key in FORMAT_COUNT_KEYS}
    unsupported_count = 0
    duplicate_count = 0
    total_bytes = 0
    known_pages = 0
    unknown_page_count = 0
    inaccessible_total = 0
    invalid_total = 0
    skipped_link_total = 0
    long_path_total = 0
    inaccessible: list[dict[str, Any]] = []
    invalid: list[dict[str, Any]] = []
    skipped_links: list[dict[str, Any]] = []
    manifest: list[dict[str, str]] = []
    token_rows: list[str] = []
    seen_file_ids: set[tuple[int, int]] = set()
    stack = [root]

    while stack:
        _check_cancel(cancel_event)
        current = stack.pop()
        try:
            with os.scandir(current) as iterator:
                entries = sorted(iterator, key=lambda item: item.name.casefold(), reverse=True)
        except OSError as exc:
            inaccessible_total += 1
            _detail(inaccessible, {"path": str(current), "reason": str(exc)})
            continue
        for entry in entries:
            _check_cancel(cancel_event)
            path = Path(entry.path)
            try:
                entry_stat = entry.stat(follow_symlinks=False)
            except OSError as exc:
                inaccessible_total += 1
                _detail(inaccessible, {"path": str(path), "reason": str(exc)})
                continue
            if entry.is_symlink() or _is_reparse_stat(entry_stat):
                skipped_link_total += 1
                _detail(skipped_links, {"path": str(path), "reason": "已跳过联接或符号链接"})
                continue
            if stat.S_ISDIR(entry_stat.st_mode):
                stack.append(path)
                continue
            if not stat.S_ISREG(entry_stat.st_mode):
                continue
            if len(str(path)) >= 240:
                long_path_total += 1
            suffix = path.suffix.lower()
            if suffix not in SUPPORTED_SOURCE_SUFFIXES:
                unsupported_count += 1
                continue
            file_id = (int(entry_stat.st_dev), int(entry_stat.st_ino))
            if file_id[1] and file_id in seen_file_ids:
                duplicate_count += 1
                continue
            if file_id[1]:
                seen_file_ids.add(file_id)
            try:
                if not _source_signature_matches(path):
                    raise DocumentBackendError("UNSUPPORTED_DOCUMENT", "文件扩展名与实际格式不一致")
                pages = backend_registry.page_count(path)
                after_stat = path.stat()
                if (
                    after_stat.st_size != entry_stat.st_size
                    or after_stat.st_mtime_ns != entry_stat.st_mtime_ns
                ):
                    raise DocumentBackendError("SOURCE_FILE_CHANGED", "文件在预检期间发生变化")
            except DocumentBackendError as exc:
                invalid_total += 1
                _detail(invalid, {"path": str(path), "reason": exc.message, "code": exc.code})
                continue
            except OSError as exc:
                inaccessible_total += 1
                _detail(inaccessible, {"path": str(path), "reason": str(exc)})
                continue
            if pages <= 0:
                unknown_page_count += 1
            else:
                known_pages += int(pages)
            relative = path.relative_to(root).as_posix()
            format_counts[count_key(path)] += 1
            total_bytes += int(entry_stat.st_size)
            normalized_path = os.path.normcase(str(path.resolve(strict=True)))
            source_id = f"source-{len(manifest) + 1:06d}-{hashlib.sha256(normalized_path.encode('utf-8')).hexdigest()[:12]}"
            manifest.append(
                {
                    "file_path": str(path),
                    "file_name": path.name,
                    "display_path": relative,
                    "source_id": source_id,
                }
            )
            token_rows.append(f"{relative}\0{entry_stat.st_size}\0{entry_stat.st_mtime_ns}")

    _check_cancel(cancel_event)
    supported_count = len(manifest)
    estimated_required = _estimated_required_bytes(total_bytes, known_pages)
    try:
        disk = shutil.disk_usage(Path(workspace_root))
        available_disk = int(disk.free)
    except OSError:
        available_disk = -1

    warnings: list[dict[str, str]] = []
    confirmation_codes: list[str] = []
    blocking_codes: list[str] = []
    if _is_network_path(root_input):
        warnings.append(_warning("NETWORK_PATH", "来源位于网络路径，处理期间断线会导致任务失败。"))
        confirmation_codes.append("NETWORK_PATH")
    if skipped_link_total:
        warnings.append(_warning("LINKS_SKIPPED", f"已安全跳过 {skipped_link_total} 个联接或符号链接。"))
        confirmation_codes.append("LINKS_SKIPPED")
    if supported_count > LARGE_FILE_COUNT:
        warnings.append(_warning("LARGE_FILE_COUNT", f"文件数量较大（{supported_count} 个），处理可能耗时较长。"))
        confirmation_codes.append("LARGE_FILE_COUNT")
    if known_pages > LARGE_PAGE_COUNT:
        warnings.append(_warning("LARGE_PAGE_COUNT", f"已知页数较大（{known_pages} 页），请预留处理时间和磁盘空间。"))
        confirmation_codes.append("LARGE_PAGE_COUNT")
    if total_bytes > LARGE_SOURCE_BYTES:
        warnings.append(_warning("LARGE_SOURCE_BYTES", "来源文件总体积超过 10 GiB。"))
        confirmation_codes.append("LARGE_SOURCE_BYTES")
    if unsupported_count:
        warnings.append(_warning("UNSUPPORTED_FILES", f"有 {unsupported_count} 个不支持的文件，不会纳入任务。"))
    if duplicate_count:
        warnings.append(_warning("DUPLICATES_SKIPPED", f"有 {duplicate_count} 个重复文件实体已跳过。"))
    if long_path_total:
        warnings.append(_warning("LONG_PATHS", f"有 {long_path_total} 个路径接近或超过传统 Windows 长路径限制。"))
    if supported_count == 0:
        blocking_codes.append("NO_SUPPORTED_FILES")
    if invalid_total:
        blocking_codes.append("INVALID_FILES")
    if inaccessible_total:
        blocking_codes.append("INACCESSIBLE_PATHS")
    if available_disk >= 0 and available_disk < estimated_required:
        blocking_codes.append("DISK_SPACE_LOW")
        warnings.append(_warning("DISK_SPACE_LOW", "当前可用磁盘空间低于保守需求估算，不能创建任务。"))
    elif available_disk >= 0 and available_disk < int(estimated_required * 1.5):
        warnings.append(_warning("DISK_SPACE_TIGHT", "磁盘余量偏低，导出或临时文件可能耗尽空间。"))
        confirmation_codes.append("DISK_SPACE_TIGHT")
    elif available_disk < 0:
        warnings.append(_warning("DISK_SPACE_UNKNOWN", "无法取得任务工作区所在磁盘的可用空间。"))
        confirmation_codes.append("DISK_SPACE_UNKNOWN")

    token_hasher = hashlib.sha256()
    token_hasher.update(os.path.normcase(str(root)).encode("utf-8"))
    for row in token_rows:
        token_hasher.update(b"\n")
        token_hasher.update(row.encode("utf-8"))
    scan_token = token_hasher.hexdigest()
    detail_total = inaccessible_total + invalid_total + skipped_link_total
    report: dict[str, Any] = {
        "source_dir": str(root),
        "supported_file_count": supported_count,
        "unsupported_file_count": unsupported_count,
        "duplicate_count": duplicate_count,
        "total_bytes": total_bytes,
        "format_counts": format_counts,
        "known_pages": known_pages,
        "estimated_pages": known_pages,
        "page_count_complete": unknown_page_count == 0,
        "unknown_page_file_count": unknown_page_count,
        "inaccessible_files": inaccessible,
        "inaccessible_count": inaccessible_total,
        "invalid_files": invalid,
        "invalid_file_count": invalid_total,
        "skipped_links": skipped_links,
        "skipped_link_count": skipped_link_total,
        "warning_codes": [item["code"] for item in warnings],
        "warnings": warnings,
        "available_disk_bytes": available_disk,
        "estimated_required_disk_bytes": estimated_required,
        "estimate_basis": "256 MiB base + 25% source bytes + 8 MiB per known page, then 25% safety margin",
        "requires_confirmation": bool(confirmation_codes),
        "confirmation_codes": confirmation_codes,
        "blocking_codes": blocking_codes,
        "can_create": not blocking_codes,
        "truncated_details": detail_total > len(inaccessible) + len(invalid) + len(skipped_links),
        "scan_token": scan_token,
    }
    return report, manifest


__all__ = ["PreflightCancelled", "preflight_folder"]
