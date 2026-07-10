"""Engine 运行配置：原生工具路径与默认参数的单一真相源。

历史实现把 ``C:\\Program Files\\Tesseract-OCR``、
``C:\\Program Files (x86)\\DjVuLibre``、``F:\\OCR`` 等绝对路径硬编码在
``report_pipeline`` 模块顶部，导致换机即坏。

本模块把这些路径集中为 :class:`EngineConfig`，并提供三种注入方式：

1. 显式构造 ``EngineConfig(tesseract_cmd=...)``；
2. 环境变量 ``AL_TESSERACT_CMD`` / ``AL_DJVU_BIN_DIR`` / ``AL_TESSDATA_DIR``
   （PyInstaller 打包后由 Electron Main 通过子进程环境注入安装包内路径）；
3. :data:`DEFAULT_CONFIG` —— Windows 标准安装位置回退，仅供开发期。

不再出现“开发机固定路径”作为唯一来源。
"""

from __future__ import annotations

import os
from dataclasses import dataclass, field
from pathlib import Path

#: Alpha10 历史任务的默认检索目标；新任务改由任务级 ``search_terms`` 提供。
#: 值为 ``(variant, unicode_codepoint)``，仅保留给 legacy 数据兼容。
TARGET_CHARS: dict[str, tuple[str, str]] = {
    "约": ("simplified", "U+7EA6"),
    "約": ("traditional", "U+7D04"),
}

#: 简体中文 Tesseract 语言包文件名。
SIMPLE_LANG_FILES = ("chi_sim.traineddata", "chi_sim_vert.traineddata")
#: 繁体中文 Tesseract 语言包文件名。
TRAD_LANG_FILES = ("chi_tra.traineddata", "chi_tra_vert.traineddata")


def _env_path(var_name: str, default: Path | None = None) -> Path | None:
    """从环境变量读取路径，未设置时返回 ``default``。"""
    value = os.environ.get(var_name)
    return Path(value) if value else default


@dataclass
class EngineConfig:
    """Engine 原生依赖与渲染参数。

    所有路径字段均可被环境变量覆盖，便于打包后由宿主进程注入。
    """

    tesseract_cmd: Path = field(
        default_factory=lambda: _env_path(
            "AL_TESSERACT_CMD",
            Path(r"C:\Program Files\Tesseract-OCR\tesseract.exe"),
        )
    )
    djvu_bin_dir: Path = field(
        default_factory=lambda: _env_path(
            "AL_DJVU_BIN_DIR",
            Path(r"C:\Program Files (x86)\DjVuLibre"),
        )
    )
    tessdata_dir: Path | None = field(
        default_factory=lambda: _env_path("AL_TESSDATA_DIR", None)
    )
    render_dpi: int = 144
    target_chars: dict[str, tuple[str, str]] = field(
        default_factory=lambda: dict(TARGET_CHARS)
    )

    # ---- 衍生路径 ----
    @property
    def djvused_exe(self) -> Path:
        return self.djvu_bin_dir / "djvused.exe"

    @property
    def ddjvu_exe(self) -> Path:
        return self.djvu_bin_dir / "ddjvu.exe"

    # ---- 依赖可用性 ----
    @property
    def has_tesseract(self) -> bool:
        return self.tesseract_cmd.exists()

    @property
    def has_djvu(self) -> bool:
        return self.djvused_exe.exists() and self.ddjvu_exe.exists()

    def _traineddata_files(self) -> set[str]:
        if not self.tessdata_dir or not self.tessdata_dir.exists():
            return set()
        return {p.name for p in self.tessdata_dir.glob("*.traineddata")}

    @property
    def has_simplified_lang(self) -> bool:
        files = self._traineddata_files()
        return any(name in files for name in SIMPLE_LANG_FILES)

    @property
    def has_traditional_lang(self) -> bool:
        files = self._traineddata_files()
        return any(name in files for name in TRAD_LANG_FILES)


#: 开发期默认配置（Windows 标准安装位置回退）。
#: 生产环境应通过环境变量或显式构造覆盖。
DEFAULT_CONFIG: EngineConfig = EngineConfig()


__all__ = [
    "EngineConfig",
    "DEFAULT_CONFIG",
    "TARGET_CHARS",
    "SIMPLE_LANG_FILES",
    "TRAD_LANG_FILES",
]
