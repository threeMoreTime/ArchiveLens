from __future__ import annotations

import hashlib
import sqlite3
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest import mock

from PIL import Image

from archivelens_engine.config import EngineConfig
from archivelens_engine.page_evidence import (
    PAGE_RENDER_LIMIT_EXCEEDED,
    SOURCE_EVIDENCE_UNAVAILABLE,
    SOURCE_FILE_CHANGED,
    PageEvidenceError,
    PageEvidenceService,
)


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


class PageEvidenceServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary.name)
        self.scan = self.root / "scan"
        self.scan.mkdir()
        self.service = PageEvidenceService(EngineConfig(render_dpi=144))

    def tearDown(self) -> None:
        self.temporary.cleanup()

    def make_document(self, source: Path, *, file_type: str = "PNG", page_count: int = 1) -> SimpleNamespace:
        stat = source.stat()
        return SimpleNamespace(
            document_id="document-1",
            source_id="source-1",
            file_path=source,
            relative_path=source.name,
            file_type=file_type,
            file_hash_sha256=sha256(source),
            file_size_bytes=stat.st_size,
            modified_time=stat.st_mtime,
            page_count=page_count,
        )

    @staticmethod
    def occurrence(**overrides: object) -> dict[str, object]:
        value: dict[str, object] = {
            "document_id": "document-1",
            "source_id": "source-1",
            "file_path": "",
            "relative_path": "source.png",
            "page_number": 1,
            "source_page_width": 64,
            "source_page_height": 48,
        }
        value.update(overrides)
        return value

    def test_raster_evidence_preserves_alpha_and_survives_missing_source_after_cache(self) -> None:
        source = self.root / "source.png"
        Image.new("RGBA", (64, 48), (20, 40, 60, 80)).save(source, "PNG")
        document = self.make_document(source)
        self.service.record_scan_page(scan_workspace=self.scan, document=document, page_payload=None)

        result = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(file_path=str(source)),
            target_css_width=64,
            target_css_height=48,
            device_pixel_ratio=1,
        )

        asset = self.scan / result["asset_relpath"]
        self.assertEqual(result["source_kind"], "raster")
        self.assertEqual(result["fidelity"], "verified_source")
        with Image.open(asset) as rendered:
            self.assertEqual(rendered.mode, "RGBA")
            self.assertEqual(rendered.getpixel((0, 0)), (20, 40, 60, 80))

        source.unlink()
        cached = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(file_path=str(source)),
            target_css_width=128,
            target_css_height=96,
            device_pixel_ratio=1,
        )
        self.assertEqual(cached["asset_relpath"], result["asset_relpath"])

        physical = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(file_path=str(source)),
            target_css_width=32,
            target_css_height=24,
            device_pixel_ratio=2,
        )
        self.assertEqual((physical["width_100_css"], physical["height_100_css"]), (32, 24))

    def test_oriented_jpeg_uses_display_orientation(self) -> None:
        source = self.root / "oriented.jpg"
        exif = Image.Exif()
        exif[274] = 6
        Image.new("RGB", (20, 10), "white").save(source, "JPEG", exif=exif)
        self.service.record_scan_page(
            scan_workspace=self.scan,
            document=self.make_document(source, file_type="JPEG"),
            page_payload=None,
        )

        result = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(
                file_path=str(source), source_page_width=10, source_page_height=20
            ),
            target_css_width=10,
            target_css_height=20,
            device_pixel_ratio=1,
        )

        with Image.open(self.scan / result["asset_relpath"]) as rendered:
            self.assertEqual(rendered.size, (10, 20))

    def test_multiframe_tiff_keeps_requested_frame_and_icc_profile(self) -> None:
        source = self.root / "frames.tiff"
        first = Image.new("RGB", (16, 12), "red")
        second = Image.new("RGB", (16, 12), "blue")
        first.save(
            source,
            "TIFF",
            save_all=True,
            append_images=[second],
            icc_profile=b"ArchiveLens test ICC",
        )
        first.close()
        second.close()
        self.service.record_scan_page(
            scan_workspace=self.scan,
            document=self.make_document(source, file_type="TIFF", page_count=2),
            page_payload=None,
        )

        result = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(
                file_path=str(source), page_number=2, source_page_width=16, source_page_height=12
            ),
            target_css_width=16,
            target_css_height=12,
            device_pixel_ratio=1,
        )

        with Image.open(self.scan / result["asset_relpath"]) as rendered:
            self.assertEqual(rendered.getpixel((0, 0)), (0, 0, 255))
            self.assertEqual(rendered.info.get("icc_profile"), b"ArchiveLens test ICC")

    def test_djvu_uses_native_decoder_pixels_and_reports_overscale_warning(self) -> None:
        source = self.root / "source.djvu"
        source.write_bytes(b"AT&T synthetic djvu")
        self.service.record_scan_page(
            scan_workspace=self.scan,
            document=self.make_document(source, file_type="DJVU"),
            page_payload=None,
        )
        rendered = self.root / "djvu-page.png"
        Image.new("RGB", (320, 240), "white").save(rendered, "PNG")

        with mock.patch.object(self.service.backends.djvu, "render_page", return_value=rendered) as render:
            result = self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(
                    file_path=str(source), source_page_width=320, source_page_height=240
                ),
                target_css_width=1280,
                target_css_height=960,
                device_pixel_ratio=1,
            )

        render.assert_called_once()
        self.assertEqual(result["source_kind"], "djvu")
        self.assertEqual(result["pixel_width"], 320)
        self.assertEqual(result["overscale_warning"], "仅放大观察，不会增加源文件细节")
        self.assertEqual(list((self.scan / "evidence" / "pages").glob(".page-*")), [])

    def test_changed_uncached_source_is_rejected(self) -> None:
        source = self.root / "source.png"
        Image.new("RGB", (32, 24), "white").save(source, "PNG")
        document = self.make_document(source)
        self.service.record_scan_page(scan_workspace=self.scan, document=document, page_payload=None)
        Image.new("RGB", (32, 24), "black").save(source, "PNG")

        with self.assertRaises(PageEvidenceError) as raised:
            self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(file_path=str(source), source_page_width=32, source_page_height=24),
                target_css_width=32,
                target_css_height=24,
                device_pixel_ratio=1,
            )
        self.assertEqual(raised.exception.code, SOURCE_FILE_CHANGED)

    def test_legacy_report_database_backfills_scan_hash(self) -> None:
        source = self.root / "legacy.png"
        Image.new("RGB", (40, 30), "white").save(source, "PNG")
        run_dir = self.scan / "run"
        run_dir.mkdir()
        connection = sqlite3.connect(run_dir / "report.db")
        connection.execute(
            """
            CREATE TABLE documents (
                document_id TEXT, file_path TEXT, file_type TEXT,
                file_hash_sha256 TEXT, file_size_bytes INTEGER,
                modified_time REAL, page_count INTEGER
            )
            """
        )
        stat = source.stat()
        connection.execute(
            "INSERT INTO documents VALUES (?, ?, ?, ?, ?, ?, ?)",
            ("document-1", str(source), "PNG", sha256(source), stat.st_size, stat.st_mtime, 1),
        )
        connection.commit()
        connection.close()

        result = self.service.prepare(
            scan_workspace=self.scan,
            occurrence=self.occurrence(file_path=str(source), source_page_width=40, source_page_height=30),
            target_css_width=40,
            target_css_height=30,
            device_pixel_ratio=1,
        )

        self.assertEqual(result["pixel_width"], 40)
        self.assertTrue((self.scan / "evidence" / "evidence.db").is_file())

    def test_missing_legacy_fingerprint_requires_rescan(self) -> None:
        source = self.root / "legacy.png"
        Image.new("RGB", (40, 30), "white").save(source, "PNG")

        with self.assertRaises(PageEvidenceError) as raised:
            self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(file_path=str(source), source_page_width=40, source_page_height=30),
                target_css_width=40,
                target_css_height=30,
                device_pixel_ratio=1,
            )
        self.assertEqual(raised.exception.code, SOURCE_EVIDENCE_UNAVAILABLE)

    def test_pdf_400_percent_requests_384_dpi_and_reuses_highest_asset(self) -> None:
        source = self.root / "source.pdf"
        source.write_bytes(b"pdf-source")
        document = self.make_document(source, file_type="PDF")
        self.service.record_scan_page(scan_workspace=self.scan, document=document, page_payload=None)
        rendered = self.root / "rendered.png"
        Image.new("RGB", (384, 512), "white").save(rendered, "PNG")

        with mock.patch.object(
            self.service.backends.pdfium,
            "render_page",
            return_value=rendered,
        ) as render_page:
            result = self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(
                    file_path=str(source), source_page_width=144, source_page_height=192
                ),
                target_css_width=384,
                target_css_height=512,
                device_pixel_ratio=1,
            )
            cached = self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(
                    file_path=str(source), source_page_width=144, source_page_height=192
                ),
                target_css_width=96,
                target_css_height=128,
                device_pixel_ratio=1,
            )

        render_page.assert_called_once_with(source, 0, 384)
        self.assertEqual(cached["asset_relpath"], result["asset_relpath"])
        self.assertEqual(result["width_100_css"], 96)
        self.assertIsNone(result["overscale_warning"])

    def test_pixel_limit_fails_before_rendering(self) -> None:
        source = self.root / "source.pdf"
        source.write_bytes(b"pdf-source")
        document = self.make_document(source, file_type="PDF")
        self.service.record_scan_page(scan_workspace=self.scan, document=document, page_payload=None)

        with self.assertRaises(PageEvidenceError) as raised:
            self.service.prepare(
                scan_workspace=self.scan,
                occurrence=self.occurrence(file_path=str(source), source_page_width=144, source_page_height=192),
                target_css_width=30_001,
                target_css_height=2,
                device_pixel_ratio=1,
            )
        self.assertEqual(raised.exception.code, PAGE_RENDER_LIMIT_EXCEEDED)


if __name__ == "__main__":
    unittest.main()
