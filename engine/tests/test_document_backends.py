from __future__ import annotations

import sys
import threading
import types
from pathlib import Path

import pytest
from PIL import Image

from archivelens_engine.documents import backends
from archivelens_engine.documents.backends import (
    DjvuLibreBackend,
    DocumentBackendError,
    PdfiumBackend,
    RasterImageBackend,
)
from archivelens_engine.report_pipeline import ReportPipeline


@pytest.mark.parametrize("second_operation", ["page_size_points", "render_page"])
def test_pdfium_backend_serializes_calls_across_instances(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
    second_operation: str,
) -> None:
    state_lock = threading.Lock()
    first_entered = threading.Event()
    allow_first_exit = threading.Event()
    overlapping_call = threading.Event()
    active_documents = 0
    document_count = 0
    max_active_documents = 0

    class ObservableLock:
        def __init__(self) -> None:
            self._lock = threading.Lock()
            self._state_lock = threading.Lock()
            self._attempt_count = 0
            self.second_attempted = threading.Event()

        def __enter__(self) -> ObservableLock:
            with self._state_lock:
                self._attempt_count += 1
                if self._attempt_count == 2:
                    self.second_attempted.set()
            self._lock.acquire()
            return self

        def __exit__(self, _exc_type: object, _exc: object, _traceback: object) -> None:
            self._lock.release()

    observable_lock = ObservableLock()
    monkeypatch.setattr(backends, "_PDFIUM_LOCK", observable_lock)

    class FakeImage:
        def save(self, path: Path, _format: str) -> None:
            path.write_bytes(b"synthetic-png")

        def close(self) -> None:
            return None

    class FakeBitmap:
        def to_pil(self) -> FakeImage:
            return FakeImage()

        def close(self) -> None:
            return None

    class FakePage:
        def get_size(self) -> tuple[float, float]:
            return 612.0, 792.0

        def render(self, *, scale: float) -> FakeBitmap:
            assert scale == 2.0
            return FakeBitmap()

        def close(self) -> None:
            return None

    class FakePdfDocument:
        def __init__(self, _path: str) -> None:
            nonlocal active_documents, document_count, max_active_documents
            with state_lock:
                document_count += 1
                call_number = document_count
                active_documents += 1
                max_active_documents = max(max_active_documents, active_documents)
                if active_documents > 1:
                    overlapping_call.set()
            if call_number == 1:
                first_entered.set()
                if not allow_first_exit.wait(timeout=2):
                    raise TimeoutError("test did not release the first PDFium call")

        def __len__(self) -> int:
            return 1

        def __getitem__(self, _page_index: int) -> FakePage:
            return FakePage()

        def close(self) -> None:
            nonlocal active_documents
            with state_lock:
                active_documents -= 1

    monkeypatch.setitem(sys.modules, "pypdfium2", types.SimpleNamespace(PdfDocument=FakePdfDocument))
    source = tmp_path / "archive.pdf"
    source.write_bytes(b"synthetic")
    first_backend = PdfiumBackend()
    second_backend = PdfiumBackend()
    results: list[object] = []
    errors: list[BaseException] = []

    def run_first() -> None:
        try:
            results.append(first_backend.page_count(source))
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    def run_second() -> None:
        try:
            if second_operation == "page_size_points":
                results.append(second_backend.page_size_points(source, 0))
            else:
                results.append(second_backend.render_page(source, 0, 144))
        except BaseException as exc:  # pragma: no cover - asserted below
            errors.append(exc)

    first_thread = threading.Thread(target=run_first)
    second_thread = threading.Thread(target=run_second)
    first_thread.start()
    assert first_entered.wait(timeout=1)
    second_thread.start()

    try:
        assert observable_lock.second_attempted.wait(timeout=1)
        assert document_count == 1
        assert not overlapping_call.is_set()
    finally:
        allow_first_exit.set()
        first_thread.join(timeout=2)
        second_thread.join(timeout=2)

    try:
        assert not first_thread.is_alive()
        assert not second_thread.is_alive()
        assert errors == []
        assert max_active_documents == 1
        assert document_count == 2
    finally:
        for result in results:
            if isinstance(result, Path):
                result.unlink(missing_ok=True)


def test_pdfium_backend_releases_render_resources_after_png_encoding(
    tmp_path: Path,
    monkeypatch: pytest.MonkeyPatch,
) -> None:
    close_order: list[str] = []

    class FakeImage:
        def save(self, path: Path, _format: str) -> None:
            close_order.append("save")
            path.write_bytes(b"synthetic-png")

        def close(self) -> None:
            close_order.append("image")

    class FakeBitmap:
        def to_pil(self) -> FakeImage:
            return FakeImage()

        def close(self) -> None:
            close_order.append("bitmap")

    class FakePage:
        def render(self, *, scale: float) -> FakeBitmap:
            assert scale == 2.0
            return FakeBitmap()

        def close(self) -> None:
            close_order.append("page")

    class FakePdfDocument:
        def __init__(self, _path: str) -> None:
            return None

        def __getitem__(self, _page_index: int) -> FakePage:
            return FakePage()

        def close(self) -> None:
            close_order.append("document")

    monkeypatch.setitem(sys.modules, "pypdfium2", types.SimpleNamespace(PdfDocument=FakePdfDocument))
    source = tmp_path / "archive.pdf"
    source.write_bytes(b"synthetic")

    rendered = PdfiumBackend().render_page(source, 0, 144)

    try:
        assert rendered.read_bytes() == b"synthetic-png"
        assert close_order == ["save", "image", "bitmap", "page", "document"]
    finally:
        rendered.unlink(missing_ok=True)


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


def test_djvu_backend_closes_rendered_temp_file_handle(tmp_path: Path, monkeypatch: pytest.MonkeyPatch) -> None:
    tools = tmp_path / "djvu"
    tools.mkdir()
    (tools / "ddjvu.exe").write_bytes(b"test")
    (tools / "djvused.exe").write_bytes(b"test")
    source = tmp_path / "archive.djvu"
    source.write_bytes(b"synthetic")

    def fake_run(command: list[str], **_kwargs: object) -> object:
        Image.new("RGB", (8, 6), "white").save(Path(command[-1]), "PPM")
        return object()

    monkeypatch.setattr(backends.subprocess, "run", fake_run)
    rendered = DjvuLibreBackend(tools).render_page(source, 0, 144)

    with Image.open(rendered) as image:
        assert image.size == (8, 6)
    rendered.unlink()
    assert not rendered.exists()


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
