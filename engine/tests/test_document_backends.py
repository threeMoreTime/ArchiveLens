from __future__ import annotations

from pathlib import Path

import pytest
from PIL import Image

from archivelens_engine.documents import backends
from archivelens_engine.documents.backends import DocumentBackendError, RasterImageBackend
from archivelens_engine.report_pipeline import ReportPipeline


@pytest.mark.parametrize("suffix", [".tif", ".tiff", ".jpg", ".jpeg", ".png"])
def test_raster_backend_supports_first_phase_extensions(tmp_path: Path, suffix: str) -> None:
    backend = RasterImageBackend()

    assert backend.supports(tmp_path / f"scan{suffix}")


def test_raster_backend_counts_and_renders_all_tiff_frames(tmp_path: Path) -> None:
    source = tmp_path / "archive.tiff"
    first = Image.new("L", (12, 8), color=20)
    second = Image.new("L", (9, 7), color=220)
    first.save(source, save_all=True, append_images=[second])
    backend = RasterImageBackend()

    assert backend.page_count(source) == 2
    rendered = backend.render_page(source, 1, 144)

    try:
        with Image.open(rendered) as image:
            assert image.size == (9, 7)
            assert image.mode == "RGB"
    finally:
        rendered.unlink(missing_ok=True)


def test_raster_backend_applies_exif_orientation(tmp_path: Path) -> None:
    source = tmp_path / "rotated.jpg"
    image = Image.new("RGB", (10, 20), color="white")
    exif = Image.Exif()
    exif[274] = 6
    image.save(source, exif=exif)
    backend = RasterImageBackend()

    rendered = backend.render_page(source, 0, 144)

    try:
        with Image.open(rendered) as output:
            assert output.size == (20, 10)
    finally:
        rendered.unlink(missing_ok=True)


def test_raster_backend_composites_transparent_png_on_white(tmp_path: Path) -> None:
    source = tmp_path / "transparent.png"
    Image.new("RGBA", (4, 4), color=(0, 0, 0, 0)).save(source)
    backend = RasterImageBackend()

    rendered = backend.render_page(source, 0, 144)

    try:
        with Image.open(rendered) as output:
            assert output.getpixel((0, 0)) == (255, 255, 255)
    finally:
        rendered.unlink(missing_ok=True)


def test_raster_backend_rejects_spoofed_extension_and_apng(tmp_path: Path) -> None:
    spoofed = tmp_path / "spoofed.png"
    Image.new("RGB", (4, 4), color="white").save(spoofed, format="JPEG")
    animated = tmp_path / "animated.png"
    first = Image.new("RGB", (4, 4), color="white")
    second = Image.new("RGB", (4, 4), color="black")
    first.save(animated, save_all=True, append_images=[second], duration=100, loop=0)
    backend = RasterImageBackend()

    with pytest.raises(DocumentBackendError, match="实际格式"):
        backend.validate(spoofed)
    with pytest.raises(DocumentBackendError, match="动态 PNG"):
        backend.validate(animated)


def test_raster_backend_enforces_confirmed_safety_limits(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "large.png"
    Image.new("RGB", (10, 10), color="white").save(source)
    backend = RasterImageBackend()

    monkeypatch.setattr(backends, "MAX_IMAGE_PIXELS", 99)
    with pytest.raises(DocumentBackendError, match="像素上限"):
        backend.validate(source)

    monkeypatch.setattr(backends, "MAX_IMAGE_PIXELS", 200_000_000)
    monkeypatch.setattr(backends, "MAX_IMAGE_EDGE", 9)
    with pytest.raises(DocumentBackendError, match="边长超过.*上限"):
        backend.validate(source)


def test_raster_backend_converts_pillow_decompression_bomb_to_domain_error(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    source = tmp_path / "bomb.png"
    source.write_bytes(b"placeholder")

    def raise_bomb(*_args: object, **_kwargs: object) -> Image.Image:
        raise Image.DecompressionBombError("too large")

    monkeypatch.setattr(backends.Image, "open", raise_bomb)

    with pytest.raises(DocumentBackendError, match="图片打开失败"):
        RasterImageBackend().validate(source)


def test_raster_backend_enforces_tiff_page_limit(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    source = tmp_path / "two-pages.tiff"
    first = Image.new("L", (2, 2), color=0)
    first.save(source, save_all=True, append_images=[Image.new("L", (2, 2), color=255)])
    backend = RasterImageBackend()
    monkeypatch.setattr(backends, "MAX_TIFF_PAGES", 1)

    with pytest.raises(DocumentBackendError, match="页数上限"):
        backend.validate(source)


def test_report_pipeline_discovers_mixed_raster_documents_and_tiff_pages(tmp_path: Path) -> None:
    Image.new("RGB", (6, 4), color="white").save(tmp_path / "one.jpg")
    first = Image.new("L", (4, 4), color=0)
    first.save(tmp_path / "two.tif", save_all=True, append_images=[Image.new("L", (4, 4), color=255)])
    pipeline = ReportPipeline(
        root_dir=tmp_path,
        output_html=tmp_path / "report.html",
        workspace_dir=tmp_path / "workspace",
        ocr_engine=object(),
        search_terms=("档案",),
    )

    try:
        documents = pipeline._scan_documents()
    finally:
        pipeline.close()

    assert [(item.relative_path, item.file_type, item.page_count) for item in documents] == [
        ("one.jpg", "JPEG", 1),
        ("two.tif", "TIFF", 2),
    ]
