"""文档渲染后端抽象（任务 §五）。

把对具体 PDF/DJVU 库的依赖从 ``ReportPipeline`` 中剥离，统一到
:class:`DocumentBackend`。当前实现：

* :class:`PdfiumBackend` —— 基于 pypdfium2（BSD-3），替代 PyMuPDF（AGPL）；
* :class:`DjvuLibreBackend` —— DjVuLibre 外部组件（GPL，可选，不随包）。

统一错误码：
``DOCUMENT_BACKEND_UNAVAILABLE`` / ``DOCUMENT_OPEN_FAILED`` /
``PAGE_COUNT_FAILED`` / ``PAGE_RENDER_FAILED`` / ``UNSUPPORTED_DOCUMENT``。

页码约定：内部 ``page_index`` 0-based；UI/报告 ``page_number`` 1-based（由调用方 +1）。
"""

from __future__ import annotations

import subprocess
import tempfile
from pathlib import Path

from ..config import DEFAULT_CONFIG, EngineConfig


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
            pdf = pdfium.PdfDocument(str(path))
            try:
                return len(pdf)
            finally:
                pdf.close()
        except Exception as exc:  # noqa: BLE001
            raise DocumentBackendError("DOCUMENT_OPEN_FAILED", f"PDF 打开失败：{exc}", {"path": str(path)}) from exc

    def render_page(self, path: Path, page_index: int, dpi: int) -> Path:
        import pypdfium2 as pdfium

        try:
            pdf = pdfium.PdfDocument(str(path))
            try:
                page = pdf[page_index]
                scale = dpi / 72.0
                pil_image = page.render(scale=scale).to_pil()
            finally:
                pdf.close()
        except Exception as exc:  # noqa: BLE001
            raise DocumentBackendError("PAGE_RENDER_FAILED", f"PDF 渲染失败：{exc}", {"page": page_index}) from exc

        import os
        fd, name = tempfile.mkstemp(suffix=".png", prefix="al-pdf-")
        os.close(fd)  # 必须关闭 fd，否则 Windows 下后续 unlink 触发 WinError 32
        pil_image.save(name, "PNG")
        return Path(name)


class DjvuLibreBackend:
    """DjVuLibre 外部组件后端（可选，不随默认安装包分发）。"""

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
        png_path = Path(tempfile.mkstemp(suffix=".png", prefix="al-djvu-png-")[1])
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
            Image.open(ppm_path).save(png_path, "PNG")
            return png_path
        except (subprocess.CalledProcessError, subprocess.TimeoutExpired) as exc:
            raise DocumentBackendError("PAGE_RENDER_FAILED", f"DjVu 渲染失败：{exc}") from exc
        finally:
            ppm_path.unlink(missing_ok=True)


class DocumentBackendRegistry:
    """按扩展名选择后端；业务层不再散判 ``.pdf`` / 拼接 ddjvu 路径。"""

    def __init__(self, config: EngineConfig | None = None) -> None:
        self.config = config or DEFAULT_CONFIG
        self.pdfium = PdfiumBackend()
        self.djvu = DjvuLibreBackend(self.config.djvu_bin_dir)

    def select(self, path: Path) -> PdfiumBackend | DjvuLibreBackend:
        if self.pdfium.supports(path):
            return self.pdfium
        if self.djvu.supports(path):
            return self.djvu
        raise DocumentBackendError("UNSUPPORTED_DOCUMENT", f"不支持的文档类型：{path.suffix}")

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
    "DocumentBackendRegistry",
]
