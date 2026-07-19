"""文档渲染后端抽象（任务 §五）。

把对具体 PDF/DJVU/图片库的依赖从 ``ReportPipeline`` 中剥离，统一到
:class:`DocumentBackend`。当前实现：

* :class:`PdfiumBackend` —— 基于 pypdfium2（BSD-3），替代 PyMuPDF（AGPL）；
* :class:`DjvuLibreBackend` —— DjVuLibre 独立命令行组件（GPL，桌面完整包内置）。
* :class:`RasterImageBackend` —— Pillow TIFF/JPEG/PNG 后端。

统一错误码：
``DOCUMENT_BACKEND_UNAVAILABLE`` / ``DOCUMENT_OPEN_FAILED`` /
``PAGE_COUNT_FAILED`` / ``PAGE_RENDER_FAILED`` / ``UNSUPPORTED_DOCUMENT``。

页码约定：内部 ``page_index`` 0-based；UI/报告 ``page_number`` 1-based（由调用方 +1）。
"""

from __future__ import annotations

from contextlib import ExitStack
import subprocess
import tempfile
import threading
from pathlib import Path

from PIL import Image, ImageOps, UnidentifiedImageError

from ..config import DEFAULT_CONFIG, EngineConfig
from .formats import RASTER_FORMAT_BY_SUFFIX


MAX_IMAGE_PIXELS = 200_000_000
MAX_IMAGE_EDGE = 30_000
MAX_TIFF_PAGES = 5_000
# Pillow 默认阈值低于产品允许的 2 亿像素。后端在解码前执行更严格的
# 宽高与总像素校验，因此把全局炸弹阈值对齐为产品上限。
Image.MAX_IMAGE_PIXELS = MAX_IMAGE_PIXELS


# PDFium does not support concurrent calls from multiple threads, even when
# those calls use different PdfDocument/PdfiumBackend instances.  Scanning and
# evidence export run on separate worker threads, so every process-local
# PDFium operation must share this lock.
_PDFIUM_LOCK = threading.RLock()


class DocumentBackendError(Exception):
    def __init__(self, code: str, message: str, details: dict | None = None) -> None:
        super().__init__(message)
        self.code = code
        self.message = message
        self.details = details or {}


class PdfiumBackend:
    """基于 pypdfium2 的 PDF 后端（生产默认，替代 PyMuPDF）。"""

    def supports(self, path: Path) -> bool:
        return path.suffix.lower() == ".pdf"

    def page_count(self, path: Path) -> int:
        import pypdfium2 as pdfium

        try:
            with _PDFIUM_LOCK, ExitStack() as resources:
                pdf = pdfium.PdfDocument(str(path))
                resources.callback(pdf.close)
                return len(pdf)
        except Exception as exc:  # noqa: BLE001
            raise DocumentBackendError("DOCUMENT_OPEN_FAILED", f"PDF 打开失败：{exc}", {"path": str(path)}) from exc

    def page_size_points(self, path: Path, page_index: int) -> tuple[float, float]:
        """Return the PDF page size in 1/72-inch points without rasterizing it."""

        import pypdfium2 as pdfium

        try:
            with _PDFIUM_LOCK, ExitStack() as resources:
                pdf = pdfium.PdfDocument(str(path))
                resources.callback(pdf.close)
                page = pdf[page_index]
                resources.callback(page.close)
                width, height = page.get_size()
                return float(width), float(height)
        except Exception as exc:  # noqa: BLE001
            raise DocumentBackendError(
                "PAGE_RENDER_FAILED",
                f"PDF 页面尺寸读取失败：{exc}",
                {"page": page_index},
            ) from exc

    def render_page(self, path: Path, page_index: int, dpi: int) -> Path:
        import pypdfium2 as pdfium
        import os

        output_path: Path | None = None
        try:
            with _PDFIUM_LOCK, ExitStack() as resources:
                pdf = pdfium.PdfDocument(str(path))
                resources.callback(pdf.close)
                page = pdf[page_index]
                resources.callback(page.close)
                scale = dpi / 72.0
                bitmap = page.render(scale=scale)
                resources.callback(bitmap.close)
                pil_image = bitmap.to_pil()
                resources.callback(pil_image.close)

                fd, name = tempfile.mkstemp(suffix=".png", prefix="al-pdf-")
                output_path = Path(name)
                os.close(fd)  # 必须关闭 fd，否则 Windows 下后续 unlink 触发 WinError 32
                # to_pil() may share the PDFium bitmap buffer, so encode the PNG
                # before releasing the bitmap/page/document resources.
                pil_image.save(output_path, "PNG")
        except Exception as exc:  # noqa: BLE001
            details: dict[str, object] = {"page": page_index}
            if output_path is not None:
                try:
                    output_path.unlink(missing_ok=True)
                except OSError as cleanup_exc:
                    details["temporary_cleanup_error"] = str(cleanup_exc)
            raise DocumentBackendError("PAGE_RENDER_FAILED", f"PDF 渲染失败：{exc}", details) from exc

        assert output_path is not None
        return output_path


class DjvuLibreBackend:
    """DjVuLibre 独立命令行组件后端；生产路径由 Electron 注入。"""

    def __init__(self, djvu_bin_dir: Path) -> None:
        self.djvused = djvu_bin_dir / "djvused.exe"
        self.ddjvu = djvu_bin_dir / "ddjvu.exe"

    def supports(self, path: Path) -> bool:
        return path.suffix.lower() in {".djvu", ".djv"}

    def _ensure_available(self) -> None:
        if not (self.djvused.exists() and self.ddjvu.exists()):
            raise DocumentBackendError(
                "DOCUMENT_BACKEND_UNAVAILABLE",
                "DjVuLibre 外部组件未找到（djvused.exe / ddjvu.exe）",
            )

    def page_count(self, path: Path) -> int:
        self._ensure_available()
        try:
            result = subprocess.run(
                [str(self.djvused), "-e", "n", str(path)],
                capture_output=True,
                text=True,
                timeout=60,
                check=True,
                shell=False,
            )
            return int(result.stdout.strip())
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired, ValueError) as exc:
            raise DocumentBackendError("PAGE_COUNT_FAILED", f"DjVu 页数查询失败：{exc}") from exc

    def render_page(self, path: Path, page_index: int, dpi: int) -> Path:
        self._ensure_available()
        from PIL import Image

        ppm_fd, ppm_name = tempfile.mkstemp(suffix=".ppm", prefix="al-djvu-")
        import os

        os.close(ppm_fd)
        ppm_path = Path(ppm_name)
        png_fd, png_name = tempfile.mkstemp(suffix=".png", prefix="al-djvu-png-")
        os.close(png_fd)
        png_path = Path(png_name)
        try:
            subprocess.run(
                [
                    str(self.ddjvu),
                    "-format=ppm",
                    f"-page={page_index + 1}",
                    str(path),
                    str(ppm_path),
                ],
                capture_output=True,
                timeout=180,
                check=True,
                shell=False,
            )
            with Image.open(ppm_path) as rendered:
                rendered.save(png_path, "PNG")
            return png_path
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise DocumentBackendError("PAGE_RENDER_FAILED", f"DjVu 渲染失败：{exc}") from exc
        finally:
            ppm_path.unlink(missing_ok=True)


class RasterImageBackend:
    """基于 Pillow 的 TIFF/JPEG/PNG 后端。"""

    def supports(self, path: Path) -> bool:
        return path.suffix.lower() in RASTER_FORMAT_BY_SUFFIX

    def _open(self, path: Path) -> Image.Image:
        expected = RASTER_FORMAT_BY_SUFFIX.get(path.suffix.lower())
        if expected is None:
            raise DocumentBackendError("UNSUPPORTED_DOCUMENT", f"不支持的图片类型：{path.suffix}")
        try:
            image = Image.open(path)
        except (Image.DecompressionBombError, OSError, UnidentifiedImageError, ValueError) as exc:
            raise DocumentBackendError(
                "DOCUMENT_OPEN_FAILED",
                f"图片打开失败：{exc}",
                {"path": str(path)},
            ) from exc
        if image.format != expected:
            actual = image.format or "未知"
            image.close()
            raise DocumentBackendError(
                "UNSUPPORTED_DOCUMENT",
                f"文件扩展名与实际格式不一致：期望 {expected}，实际格式 {actual}",
                {"path": str(path), "expected_format": expected, "actual_format": actual},
            )
        return image

    def _validate_frame(self, image: Image.Image, path: Path, frame_index: int) -> None:
        try:
            image.seek(frame_index)
        except EOFError as exc:
            raise DocumentBackendError(
                "PAGE_COUNT_FAILED",
                f"图片页索引无效：{frame_index + 1}",
                {"path": str(path), "page": frame_index + 1},
            ) from exc
        width, height = image.size
        if width <= 0 or height <= 0:
            raise DocumentBackendError("DOCUMENT_OPEN_FAILED", "图片宽高必须大于 0", {"path": str(path)})
        if width > MAX_IMAGE_EDGE or height > MAX_IMAGE_EDGE:
            raise DocumentBackendError(
                "DOCUMENT_OPEN_FAILED",
                f"图片边长超过 {MAX_IMAGE_EDGE} 像素上限",
                {"path": str(path), "width": width, "height": height, "max_edge": MAX_IMAGE_EDGE},
            )
        pixels = width * height
        if pixels > MAX_IMAGE_PIXELS:
            raise DocumentBackendError(
                "DOCUMENT_OPEN_FAILED",
                f"图片单页超过 {MAX_IMAGE_PIXELS} 像素上限",
                {"path": str(path), "pixels": pixels, "max_pixels": MAX_IMAGE_PIXELS},
            )

    def _validate_open_image(self, image: Image.Image, path: Path) -> int:
        frame_count = int(getattr(image, "n_frames", 1) or 1)
        if image.format == "PNG" and frame_count > 1:
            raise DocumentBackendError("UNSUPPORTED_DOCUMENT", "不支持动态 PNG/APNG", {"path": str(path)})
        if image.format != "TIFF" and frame_count != 1:
            raise DocumentBackendError("UNSUPPORTED_DOCUMENT", "该图片格式仅支持单页文件", {"path": str(path)})
        if image.format == "TIFF" and frame_count > MAX_TIFF_PAGES:
            raise DocumentBackendError(
                "PAGE_COUNT_FAILED",
                f"多页 TIFF 超过 {MAX_TIFF_PAGES} 页数上限",
                {"path": str(path), "page_count": frame_count, "max_pages": MAX_TIFF_PAGES},
            )
        for frame_index in range(frame_count):
            self._validate_frame(image, path, frame_index)
        return frame_count

    def validate(self, path: Path) -> int:
        image = self._open(path)
        try:
            return self._validate_open_image(image, path)
        finally:
            image.close()

    def page_count(self, path: Path) -> int:
        return self.validate(path)

    @staticmethod
    def _to_rgb(image: Image.Image) -> Image.Image:
        normalized = ImageOps.exif_transpose(image)
        if normalized.mode in {"RGBA", "LA"} or "transparency" in normalized.info:
            rgba = normalized.convert("RGBA")
            background = Image.new("RGB", rgba.size, "white")
            background.paste(rgba, mask=rgba.getchannel("A"))
            return background
        return normalized.convert("RGB")

    def render_page(self, path: Path, page_index: int, dpi: int) -> Path:
        del dpi  # 图片来源使用原始像素，不按文档 DPI 重采样。
        image = self._open(path)
        try:
            frame_count = self._validate_open_image(image, path)
            if page_index < 0 or page_index >= frame_count:
                raise DocumentBackendError(
                    "PAGE_RENDER_FAILED",
                    f"图片页码超出范围：{page_index + 1}",
                    {"path": str(path), "page": page_index + 1, "page_count": frame_count},
                )
            image.seek(page_index)
            output = self._to_rgb(image.copy())
        except DocumentBackendError:
            raise
        except (OSError, ValueError) as exc:
            raise DocumentBackendError(
                "PAGE_RENDER_FAILED",
                f"图片渲染失败：{exc}",
                {"path": str(path), "page": page_index + 1},
            ) from exc
        finally:
            image.close()

        import os

        fd, name = tempfile.mkstemp(suffix=".png", prefix="al-image-")
        os.close(fd)
        try:
            try:
                output.save(name, "PNG")
            except (OSError, ValueError) as exc:
                Path(name).unlink(missing_ok=True)
                raise DocumentBackendError(
                    "PAGE_RENDER_FAILED",
                    f"图片渲染结果写入失败：{exc}",
                    {"path": str(path), "page": page_index + 1},
                ) from exc
        finally:
            output.close()
        return Path(name)


class DocumentBackendRegistry:
    """按扩展名选择后端；业务层不再散判 ``.pdf`` / 拼接 ddjvu 路径。"""

    def __init__(self, config: EngineConfig | None = None) -> None:
        self.config = config or DEFAULT_CONFIG
        self.pdfium = PdfiumBackend()
        self.djvu = DjvuLibreBackend(self.config.djvu_bin_dir)
        self.raster = RasterImageBackend()

    def select(self, path: Path) -> PdfiumBackend | DjvuLibreBackend | RasterImageBackend:
        if self.pdfium.supports(path):
            return self.pdfium
        if self.djvu.supports(path):
            return self.djvu
        if self.raster.supports(path):
            return self.raster
        raise DocumentBackendError("UNSUPPORTED_DOCUMENT", f"不支持的文档类型：{path.suffix}")

    def validate_source(self, path: Path) -> None:
        backend = self.select(path)
        if isinstance(backend, RasterImageBackend):
            backend.validate(path)

    def page_count(self, path: Path) -> int:
        return self.select(path).page_count(path)

    def render_page(self, path: Path, page_index: int, dpi: int) -> Path:
        return self.select(path).render_page(path, page_index, dpi)

    def djvu_status(self) -> dict:
        available = self.djvu.djvused.exists() and self.djvu.ddjvu.exists()
        return {
            "feature": "djvu",
            "status": "available" if available else "missing",
            "provider": "djvulibre",
            "path": str(self.config.djvu_bin_dir) if available else None,
            "message": None if available else "未检测到 DjVuLibre，DJVU/DJV 扫描将不可用；PDF 不受影响。",
        }


__all__ = [
    "DocumentBackendError",
    "PdfiumBackend",
    "DjvuLibreBackend",
    "RasterImageBackend",
    "DocumentBackendRegistry",
]
