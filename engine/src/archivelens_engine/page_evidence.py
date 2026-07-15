"""Verified, task-local page evidence generation and caching.

The main task database remains the source of truth for OCR/review state.  This
module owns only regenerable image evidence below ``<scan>/evidence`` and uses
the scan-time SHA-256 stored by the report pipeline to prevent a changed source
file from being paired with historical OCR coordinates.
"""

from __future__ import annotations

import hashlib
import math
import os
import sqlite3
import tempfile
import threading
import time
from contextlib import contextmanager
from pathlib import Path
from typing import Any

from PIL import Image, ImageOps

from .config import DEFAULT_CONFIG, EngineConfig
from .documents import DocumentBackendError, DocumentBackendRegistry
from .documents.backends import MAX_IMAGE_EDGE, MAX_IMAGE_PIXELS, RasterImageBackend


SOURCE_EVIDENCE_UNAVAILABLE = "SOURCE_EVIDENCE_UNAVAILABLE"
SOURCE_FILE_CHANGED = "SOURCE_FILE_CHANGED"
PAGE_RENDER_LIMIT_EXCEEDED = "PAGE_RENDER_LIMIT_EXCEEDED"

PDF_CSS_DPI = 96.0
MAX_ZOOM = 4.0
MAX_DEVICE_PIXEL_RATIO = 4.0


class PageEvidenceError(Exception):
    def __init__(self, code: str, message: str, details: dict[str, Any] | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class PageEvidenceService:
    """Create and reuse the highest verified lossless page image per task page."""

    def __init__(self, config: EngineConfig | None = None) -> None:
        self.config = config or DEFAULT_CONFIG
        self.backends = DocumentBackendRegistry(self.config)
        self._lock = threading.RLock()
        self._verified_sources: set[tuple[str, int, int, str]] = set()

    @staticmethod
    def _database_path(scan_workspace: Path) -> Path:
        return scan_workspace / "evidence" / "evidence.db"

    @staticmethod
    def _pages_dir(scan_workspace: Path) -> Path:
        return scan_workspace / "evidence" / "pages"

    def _connect(self, scan_workspace: Path) -> sqlite3.Connection:
        database_path = self._database_path(scan_workspace)
        database_path.parent.mkdir(parents=True, exist_ok=True)
        connection = sqlite3.connect(database_path)
        connection.row_factory = sqlite3.Row
        connection.execute("PRAGMA journal_mode = WAL")
        connection.execute("PRAGMA busy_timeout = 5000")
        connection.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY,
                source_id TEXT NOT NULL DEFAULT '',
                file_path TEXT NOT NULL,
                relative_path TEXT NOT NULL DEFAULT '',
                file_type TEXT NOT NULL,
                file_hash_sha256 TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                modified_time REAL NOT NULL,
                page_count INTEGER NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL
            );
            CREATE TABLE IF NOT EXISTS page_assets (
                document_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                relpath TEXT NOT NULL,
                pixel_width INTEGER NOT NULL,
                pixel_height INTEGER NOT NULL,
                render_dpi INTEGER,
                source_hash_sha256 TEXT NOT NULL,
                revision TEXT NOT NULL,
                created_at REAL NOT NULL,
                updated_at REAL NOT NULL,
                PRIMARY KEY (document_id, page_number)
            );
            """
        )
        return connection

    @contextmanager
    def _connection(self, scan_workspace: Path):
        connection = self._connect(scan_workspace)
        try:
            with connection:
                yield connection
        finally:
            connection.close()

    def record_scan_page(
        self,
        *,
        scan_workspace: Path,
        document: Any,
        page_payload: dict[str, Any] | None,
    ) -> None:
        """Persist scan-time source identity and register a lossless base PNG."""

        document_id = str(getattr(document, "document_id", "") or "")
        if not document_id:
            return
        now = time.time()
        with self._lock, self._connection(scan_workspace) as connection:
            connection.execute(
                """
                INSERT INTO documents (
                    document_id, source_id, file_path, relative_path, file_type,
                    file_hash_sha256, file_size_bytes, modified_time, page_count,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                ON CONFLICT(document_id) DO UPDATE SET
                    source_id=excluded.source_id,
                    file_path=excluded.file_path,
                    relative_path=excluded.relative_path,
                    file_type=excluded.file_type,
                    file_hash_sha256=excluded.file_hash_sha256,
                    file_size_bytes=excluded.file_size_bytes,
                    modified_time=excluded.modified_time,
                    page_count=excluded.page_count,
                    updated_at=excluded.updated_at
                """,
                (
                    document_id,
                    str(getattr(document, "source_id", "") or ""),
                    str(getattr(document, "file_path", "") or ""),
                    str(getattr(document, "relative_path", "") or ""),
                    str(getattr(document, "file_type", "") or ""),
                    str(getattr(document, "file_hash_sha256", "") or ""),
                    int(getattr(document, "file_size_bytes", 0) or 0),
                    float(getattr(document, "modified_time", 0.0) or 0.0),
                    int(getattr(document, "page_count", 0) or 0),
                    now,
                    now,
                ),
            )
            if not page_payload:
                return
            file_type = str(getattr(document, "file_type", "") or "").upper()
            # The OCR raster backend intentionally composites transparency onto
            # white for recognition.  Raster evidence therefore must be decoded
            # again from the verified original instead of promoting that OCR copy.
            if file_type in {"TIFF", "TIF", "JPEG", "JPG", "PNG"}:
                return
            image_path = Path(str(page_payload.get("image_path") or ""))
            if image_path.suffix.lower() != ".png" or not image_path.is_file():
                return
            try:
                relpath = image_path.resolve().relative_to(scan_workspace.resolve()).as_posix()
            except ValueError:
                return
            width = int(page_payload.get("page_width") or 0)
            height = int(page_payload.get("page_height") or 0)
            if width <= 0 or height <= 0:
                return
            existing = connection.execute(
                "SELECT * FROM page_assets WHERE document_id=? AND page_number=?",
                (document_id, int(page_payload.get("page_number") or 0)),
            ).fetchone()
            source_hash = str(getattr(document, "file_hash_sha256", "") or "")
            if (
                existing is not None
                and str(existing["source_hash_sha256"]) == source_hash
                and int(existing["pixel_width"]) >= width
                and int(existing["pixel_height"]) >= height
            ):
                return
            render_dpi = int(self.config.render_dpi) if file_type == "PDF" else None
            self._upsert_asset(
                connection,
                document_id=document_id,
                page_number=int(page_payload.get("page_number") or 0),
                relpath=relpath,
                pixel_width=width,
                pixel_height=height,
                render_dpi=render_dpi,
                source_hash=source_hash,
            )

    def prepare(
        self,
        *,
        scan_workspace: Path,
        occurrence: dict[str, Any],
        target_css_width: float,
        target_css_height: float,
        device_pixel_ratio: float,
        is_demo: bool = False,
    ) -> dict[str, Any]:
        if not math.isfinite(target_css_width) or not math.isfinite(target_css_height):
            raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "目标显示尺寸无效")
        if target_css_width <= 0 or target_css_height <= 0:
            raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "目标显示尺寸必须大于 0")
        if not math.isfinite(device_pixel_ratio) or not 0.5 <= device_pixel_ratio <= MAX_DEVICE_PIXEL_RATIO:
            raise PageEvidenceError(
                PAGE_RENDER_LIMIT_EXCEEDED,
                f"屏幕像素密度必须位于 0.5 到 {MAX_DEVICE_PIXEL_RATIO:g} 之间",
            )
        if is_demo:
            return self._prepare_demo(
                scan_workspace=scan_workspace,
                occurrence=occurrence,
                device_pixel_ratio=device_pixel_ratio,
            )

        with self._lock:
            document = self._load_or_recover_document(scan_workspace, occurrence)
            source_kind = self._source_kind(str(document["file_type"]))
            page_number = int(occurrence.get("page_number") or 0)
            if page_number <= 0:
                raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "校对记录缺少有效页码")

            requested_width = max(1, math.ceil(target_css_width * device_pixel_ratio))
            requested_height = max(1, math.ceil(target_css_height * device_pixel_ratio))
            if source_kind == "pdf":
                self._validate_pixel_limits(requested_width, requested_height)

            with self._connection(scan_workspace) as connection:
                cached = self._valid_cached_asset(
                    connection,
                    scan_workspace=scan_workspace,
                    document_id=str(document["document_id"]),
                    page_number=page_number,
                    source_hash=str(document["file_hash_sha256"]),
                )
                source_width = float(occurrence.get("source_page_width") or 0.0)
                source_height = float(occurrence.get("source_page_height") or 0.0)
                if source_kind == "pdf":
                    if source_width > 0 and source_height > 0:
                        factor = PDF_CSS_DPI / float(self.config.render_dpi)
                        width_100_css = source_width * factor
                        height_100_css = source_height * factor
                    elif cached is not None and int(cached["render_dpi"] or 0) > 0:
                        cached_dpi = float(cached["render_dpi"])
                        width_100_css = int(cached["pixel_width"]) / cached_dpi * PDF_CSS_DPI
                        height_100_css = int(cached["pixel_height"]) / cached_dpi * PDF_CSS_DPI
                    else:
                        width_100_css, height_100_css = self._pdf_100_css_size(
                            occurrence=occurrence,
                            source_path=Path(str(document["file_path"])),
                            page_index=page_number - 1,
                        )
                else:
                    if source_width > 0 and source_height > 0:
                        native_width, native_height = int(source_width), int(source_height)
                    elif cached is not None:
                        native_width = int(cached["pixel_width"])
                        native_height = int(cached["pixel_height"])
                    else:
                        native_width, native_height = self._native_page_size(
                            Path(str(document["file_path"])), page_number - 1
                        )
                    width_100_css = native_width / device_pixel_ratio
                    height_100_css = native_height / device_pixel_ratio
                if cached is not None and (
                    source_kind != "pdf"
                    or (
                        int(cached["pixel_width"]) >= requested_width
                        and int(cached["pixel_height"]) >= requested_height
                    )
                ):
                    return self._result(
                        cached,
                        source_kind=source_kind,
                        width_100_css=width_100_css,
                        height_100_css=height_100_css,
                    )

                source_path = Path(str(document["file_path"]))
                self._verify_source(source_path, document)
                render_dpi: int | None = None
                try:
                    if source_kind == "pdf":
                        render_dpi = max(
                            1,
                            math.ceil(
                                max(
                                    requested_width / width_100_css * PDF_CSS_DPI,
                                    requested_height / height_100_css * PDF_CSS_DPI,
                                )
                            ),
                        )
                        rendered_path = self.backends.pdfium.render_page(source_path, page_number - 1, render_dpi)
                    elif source_kind == "raster":
                        rendered_path = self._render_raster_evidence(source_path, page_number - 1)
                    else:
                        rendered_path = self.backends.djvu.render_page(source_path, page_number - 1, self.config.render_dpi)
                    try:
                        asset = self._persist_rendered_asset(
                            connection,
                            scan_workspace=scan_workspace,
                            document=document,
                            page_number=page_number,
                            rendered_path=rendered_path,
                            render_dpi=render_dpi,
                            previous=cached,
                        )
                    finally:
                        rendered_path.unlink(missing_ok=True)
                except DocumentBackendError as exc:
                    limit_error = "max_pixels" in exc.details or "max_edge" in exc.details
                    raise PageEvidenceError(
                        PAGE_RENDER_LIMIT_EXCEEDED if limit_error else SOURCE_EVIDENCE_UNAVAILABLE,
                        "页面超过安全像素上限，请降低缩放比例" if limit_error else f"无法从原文件生成页面证据：{exc.message}",
                        exc.details,
                    ) from exc
                return self._result(
                    asset,
                    source_kind=source_kind,
                    width_100_css=width_100_css,
                    height_100_css=height_100_css,
                )

    def prepare_for_export(
        self,
        *,
        scan_workspace: Path,
        occurrence: dict[str, Any],
        is_demo: bool = False,
    ) -> dict[str, Any]:
        if is_demo:
            return self._prepare_demo(scan_workspace=scan_workspace, occurrence=occurrence, device_pixel_ratio=1.0)
        with self._lock:
            document = self._load_or_recover_document(scan_workspace, occurrence)
            source_kind = self._source_kind(str(document["file_type"]))
            if source_kind == "pdf":
                width_100_css, height_100_css = self._pdf_100_css_size(
                    occurrence=occurrence,
                    source_path=Path(str(document["file_path"])),
                    page_index=int(occurrence.get("page_number") or 0) - 1,
                )
                target_width = width_100_css * MAX_ZOOM
                target_height = height_100_css * MAX_ZOOM
            else:
                target_width = max(1.0, float(occurrence.get("source_page_width") or 1.0))
                target_height = max(1.0, float(occurrence.get("source_page_height") or 1.0))
        return self.prepare(
            scan_workspace=scan_workspace,
            occurrence=occurrence,
            target_css_width=target_width,
            target_css_height=target_height,
            device_pixel_ratio=1.0,
            is_demo=False,
        )

    def _load_or_recover_document(
        self, scan_workspace: Path, occurrence: dict[str, Any]
    ) -> sqlite3.Row:
        document_id = str(occurrence.get("document_id") or "")
        if not document_id:
            raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "校对记录缺少文档身份，无法验证原文件")
        with self._connection(scan_workspace) as connection:
            row = connection.execute(
                "SELECT * FROM documents WHERE document_id=?", (document_id,)
            ).fetchone()
            if row is not None:
                return row
            recovered = self._recover_legacy_document(scan_workspace, occurrence)
            if recovered is None:
                raise PageEvidenceError(
                    SOURCE_EVIDENCE_UNAVAILABLE,
                    "旧任务缺少扫描时 SHA-256，无法证明当前文件与 OCR 来源一致；请重新扫描",
                    {"document_id": document_id},
                )
            now = time.time()
            connection.execute(
                """
                INSERT INTO documents (
                    document_id, source_id, file_path, relative_path, file_type,
                    file_hash_sha256, file_size_bytes, modified_time, page_count,
                    created_at, updated_at
                ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                """,
                (
                    document_id,
                    str(occurrence.get("source_id") or ""),
                    recovered["file_path"],
                    str(occurrence.get("relative_path") or ""),
                    recovered["file_type"],
                    recovered["file_hash_sha256"],
                    recovered["file_size_bytes"],
                    recovered["modified_time"],
                    recovered["page_count"],
                    now,
                    now,
                ),
            )
            return connection.execute(
                "SELECT * FROM documents WHERE document_id=?", (document_id,)
            ).fetchone()

    @staticmethod
    def _recover_legacy_document(
        scan_workspace: Path, occurrence: dict[str, Any]
    ) -> sqlite3.Row | None:
        report_database = scan_workspace / "run" / "report.db"
        if not report_database.is_file():
            return None
        connection = sqlite3.connect(f"file:{report_database.as_posix()}?mode=ro", uri=True)
        connection.row_factory = sqlite3.Row
        try:
            row = connection.execute(
                """
                SELECT document_id, file_path, file_type, file_hash_sha256,
                       file_size_bytes, modified_time, page_count
                FROM documents WHERE document_id=?
                """,
                (str(occurrence.get("document_id") or ""),),
            ).fetchone()
            if row is None and occurrence.get("file_path"):
                row = connection.execute(
                    """
                    SELECT document_id, file_path, file_type, file_hash_sha256,
                           file_size_bytes, modified_time, page_count
                    FROM documents WHERE file_path=?
                    """,
                    (str(occurrence["file_path"]),),
                ).fetchone()
            return row
        except sqlite3.Error:
            return None
        finally:
            connection.close()

    def _verify_source(self, source_path: Path, document: sqlite3.Row) -> None:
        if not source_path.is_file():
            raise PageEvidenceError(
                SOURCE_EVIDENCE_UNAVAILABLE,
                "原文件不存在，无法生成与扫描结果一致的高清页面；请恢复原文件或重新扫描",
                {"file_name": source_path.name},
            )
        stat = source_path.stat()
        expected_hash = str(document["file_hash_sha256"])
        cache_key = (str(source_path.resolve()), stat.st_size, stat.st_mtime_ns, expected_hash)
        if cache_key in self._verified_sources:
            return
        actual_hash = self._sha256(source_path)
        if actual_hash != expected_hash:
            raise PageEvidenceError(
                SOURCE_FILE_CHANGED,
                "原文件内容已变化，不能将新页面套用到旧 OCR 坐标；请重新扫描",
                {"file_name": source_path.name},
            )
        self._verified_sources.add(cache_key)

    @staticmethod
    def _sha256(path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _native_page_size(self, source_path: Path, page_index: int) -> tuple[int, int]:
        rendered = self.backends.render_page(source_path, page_index, self.config.render_dpi)
        try:
            with Image.open(rendered) as image:
                return image.size
        finally:
            rendered.unlink(missing_ok=True)

    def _pdf_100_css_size(
        self,
        *,
        occurrence: dict[str, Any],
        source_path: Path,
        page_index: int,
    ) -> tuple[float, float]:
        source_width = float(occurrence.get("source_page_width") or 0.0)
        source_height = float(occurrence.get("source_page_height") or 0.0)
        if source_width > 0 and source_height > 0:
            factor = PDF_CSS_DPI / float(self.config.render_dpi)
            return source_width * factor, source_height * factor
        width_points, height_points = self.backends.pdfium.page_size_points(source_path, page_index)
        return width_points / 72.0 * PDF_CSS_DPI, height_points / 72.0 * PDF_CSS_DPI

    @staticmethod
    def _render_raster_evidence(source_path: Path, page_index: int) -> Path:
        backend = RasterImageBackend()
        image = backend._open(source_path)  # noqa: SLF001 - reuse authoritative validation.
        try:
            frame_count = backend._validate_open_image(image, source_path)  # noqa: SLF001
            if page_index < 0 or page_index >= frame_count:
                raise DocumentBackendError(
                    "PAGE_RENDER_FAILED",
                    f"图片页码超出范围：{page_index + 1}",
                    {"path": str(source_path), "page": page_index + 1, "page_count": frame_count},
                )
            image.seek(page_index)
            icc_profile = image.info.get("icc_profile")
            rendered = ImageOps.exif_transpose(image.copy())
            if rendered.mode == "P" and "transparency" in rendered.info:
                rendered = rendered.convert("RGBA")
            elif rendered.mode not in {"1", "L", "LA", "P", "RGB", "RGBA", "I", "I;16"}:
                rendered = rendered.convert("RGB")
        finally:
            image.close()
        fd, name = tempfile.mkstemp(suffix=".png", prefix="al-evidence-raster-")
        os.close(fd)
        try:
            options: dict[str, Any] = {"format": "PNG"}
            if isinstance(icc_profile, bytes):
                options["icc_profile"] = icc_profile
            rendered.save(name, **options)
        except Exception:
            Path(name).unlink(missing_ok=True)
            raise
        finally:
            rendered.close()
        return Path(name)

    def _persist_rendered_asset(
        self,
        connection: sqlite3.Connection,
        *,
        scan_workspace: Path,
        document: sqlite3.Row,
        page_number: int,
        rendered_path: Path,
        render_dpi: int | None,
        previous: sqlite3.Row | None,
    ) -> sqlite3.Row:
        pages_dir = self._pages_dir(scan_workspace)
        pages_dir.mkdir(parents=True, exist_ok=True)
        with Image.open(rendered_path) as image:
            width, height = image.size
            self._validate_pixel_limits(width, height)
            image_format = str(image.format or "").upper()
            if image_format != "PNG":
                raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "页面证据必须为无损 PNG")
            image.verify()
        source_hash = str(document["file_hash_sha256"])
        identity = f"{document['document_id']}\0{page_number}\0{width}\0{height}\0{source_hash}"
        revision = hashlib.sha256(identity.encode("utf-8")).hexdigest()[:20]
        safe_document = hashlib.sha256(str(document["document_id"]).encode("utf-8")).hexdigest()[:16]
        final_name = f"{safe_document}-p{page_number}-{width}x{height}-{revision}.png"
        final_path = pages_dir / final_name
        fd, temporary_name = tempfile.mkstemp(suffix=".png", prefix=".page-", dir=pages_dir)
        os.close(fd)
        temporary_path = Path(temporary_name)
        try:
            with Image.open(rendered_path) as source:
                options: dict[str, Any] = {"format": "PNG", "optimize": False}
                icc_profile = source.info.get("icc_profile")
                if isinstance(icc_profile, bytes):
                    options["icc_profile"] = icc_profile
                source.save(temporary_path, **options)
            os.replace(temporary_path, final_path)
        finally:
            temporary_path.unlink(missing_ok=True)
        relpath = final_path.resolve().relative_to(scan_workspace.resolve()).as_posix()
        self._upsert_asset(
            connection,
            document_id=str(document["document_id"]),
            page_number=page_number,
            relpath=relpath,
            pixel_width=width,
            pixel_height=height,
            render_dpi=render_dpi,
            source_hash=source_hash,
            revision=revision,
        )
        row = connection.execute(
            "SELECT * FROM page_assets WHERE document_id=? AND page_number=?",
            (str(document["document_id"]), page_number),
        ).fetchone()
        if previous is not None and str(previous["relpath"]) != relpath:
            old_relpath = str(previous["relpath"])
            if old_relpath.startswith("evidence/pages/"):
                (scan_workspace / old_relpath).unlink(missing_ok=True)
        return row

    @staticmethod
    def _upsert_asset(
        connection: sqlite3.Connection,
        *,
        document_id: str,
        page_number: int,
        relpath: str,
        pixel_width: int,
        pixel_height: int,
        render_dpi: int | None,
        source_hash: str,
        revision: str | None = None,
    ) -> None:
        now = time.time()
        revision_value = revision or hashlib.sha256(
            f"{relpath}\0{pixel_width}\0{pixel_height}\0{source_hash}".encode("utf-8")
        ).hexdigest()[:20]
        connection.execute(
            """
            INSERT INTO page_assets (
                document_id, page_number, relpath, pixel_width, pixel_height,
                render_dpi, source_hash_sha256, revision, created_at, updated_at
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
            ON CONFLICT(document_id, page_number) DO UPDATE SET
                relpath=excluded.relpath,
                pixel_width=excluded.pixel_width,
                pixel_height=excluded.pixel_height,
                render_dpi=excluded.render_dpi,
                source_hash_sha256=excluded.source_hash_sha256,
                revision=excluded.revision,
                updated_at=excluded.updated_at
            """,
            (
                document_id,
                page_number,
                relpath,
                pixel_width,
                pixel_height,
                render_dpi,
                source_hash,
                revision_value,
                now,
                now,
            ),
        )

    @staticmethod
    def _valid_cached_asset(
        connection: sqlite3.Connection,
        *,
        scan_workspace: Path,
        document_id: str,
        page_number: int,
        source_hash: str,
    ) -> sqlite3.Row | None:
        row = connection.execute(
            "SELECT * FROM page_assets WHERE document_id=? AND page_number=?",
            (document_id, page_number),
        ).fetchone()
        if row is None or str(row["source_hash_sha256"]) != source_hash:
            return None
        asset_path = scan_workspace / str(row["relpath"])
        if not asset_path.is_file():
            connection.execute(
                "DELETE FROM page_assets WHERE document_id=? AND page_number=?",
                (document_id, page_number),
            )
            return None
        try:
            with Image.open(asset_path) as image:
                if image.format != "PNG" or image.size != (
                    int(row["pixel_width"]),
                    int(row["pixel_height"]),
                ):
                    return None
                image.verify()
        except OSError:
            return None
        return row

    @staticmethod
    def _source_kind(file_type: str) -> str:
        normalized = file_type.upper()
        if normalized == "PDF":
            return "pdf"
        if normalized in {"DJVU", "DJV"}:
            return "djvu"
        return "raster"

    @staticmethod
    def _validate_pixel_limits(width: int, height: int) -> None:
        if width <= 0 or height <= 0:
            raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "页面像素尺寸无效")
        if width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE or width * height > MAX_IMAGE_PIXELS:
            raise PageEvidenceError(
                PAGE_RENDER_LIMIT_EXCEEDED,
                "目标缩放超过安全像素上限，请降低缩放比例",
                {
                    "width": width,
                    "height": height,
                    "max_edge": MAX_IMAGE_EDGE,
                    "max_pixels": MAX_IMAGE_PIXELS,
                },
            )

    @staticmethod
    def _result(
        row: sqlite3.Row,
        *,
        source_kind: str,
        width_100_css: float,
        height_100_css: float,
    ) -> dict[str, Any]:
        return {
            "asset_relpath": str(row["relpath"]),
            "asset_version": str(row["revision"]),
            "pixel_width": int(row["pixel_width"]),
            "pixel_height": int(row["pixel_height"]),
            "width_100_css": width_100_css,
            "height_100_css": height_100_css,
            "source_kind": source_kind,
            "fidelity": "verified_source",
            "overscale_warning": "仅放大观察，不会增加源文件细节" if source_kind != "pdf" else None,
        }

    @staticmethod
    def _prepare_demo(
        *,
        scan_workspace: Path,
        occurrence: dict[str, Any],
        device_pixel_ratio: float,
    ) -> dict[str, Any]:
        relpath = str(occurrence.get("page_image_relpath") or "")
        asset_path = scan_workspace / relpath
        if not relpath or not asset_path.is_file():
            raise PageEvidenceError(SOURCE_EVIDENCE_UNAVAILABLE, "体验任务页面图片不可用")
        with Image.open(asset_path) as image:
            width, height = image.size
        return {
            "asset_relpath": relpath,
            "asset_version": str(asset_path.stat().st_mtime_ns),
            "pixel_width": width,
            "pixel_height": height,
            "width_100_css": width / device_pixel_ratio,
            "height_100_css": height / device_pixel_ratio,
            "source_kind": "demo",
            "fidelity": "generated_demo",
            "overscale_warning": "体验数据仅用于功能演示，不代表原文件细节",
        }


__all__ = [
    "MAX_ZOOM",
    "PAGE_RENDER_LIMIT_EXCEEDED",
    "PDF_CSS_DPI",
    "SOURCE_EVIDENCE_UNAVAILABLE",
    "SOURCE_FILE_CHANGED",
    "PageEvidenceError",
    "PageEvidenceService",
]
