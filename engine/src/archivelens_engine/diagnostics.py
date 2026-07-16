"""环境诊断。

为 Electron 诊断页与首次启动欢迎页提供结构化环境检测结果。

设计要点：

* 每项检查返回 ``PASS`` / ``WARN`` / ``FAIL`` 三态与面向用户的中文说明；
* 不直接抛出 Python 堆栈——失败项给出「影响 + 处理建议」；
* 原生工具版本通过子进程 ``--version`` 获取，失败降级为 WARN。
"""

from __future__ import annotations

import platform
import shutil
import subprocess
import sys
from dataclasses import dataclass, field
from pathlib import Path

from . import __version__
from .config import DEFAULT_CONFIG, EngineConfig, SIMPLE_LANG_FILES, TRAD_LANG_FILES
from .ocr_model import UNIFIED_OCR_MODEL_ID, UNIFIED_OCR_MODEL_SHA256

CHECK_PASS = "PASS"
CHECK_WARN = "WARN"
CHECK_FAIL = "FAIL"


@dataclass
class Check:
    key: str
    label: str
    status: str
    detail: str = ""
    impact: str = ""
    remedy: str = ""
    extra: dict[str, str] = field(default_factory=dict)


def _run_version(cmd: list[str], timeout: float = 4.0) -> str | None:
    """安全获取原生工具版本字符串。失败返回 None。"""
    try:
        proc = subprocess.run(
            cmd,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            timeout=timeout,
            shell=False,  # 安全：参数数组，禁用 shell
        )
    except (FileNotFoundError, subprocess.TimeoutExpired, OSError):
        return None
    text = (proc.stdout or b"").decode("utf-8", errors="replace")
    if not text:
        text = (proc.stderr or b"").decode("utf-8", errors="replace")
    return text.strip().splitlines()[0] if text.strip() else None


def _disk_free(path: Path) -> int | None:
    try:
        usage = shutil.disk_usage(path)
        return usage.free
    except OSError:
        return None


def _format_bytes(num: int | None) -> str:
    if num is None:
        return "未知"
    for unit in ("B", "KB", "MB", "GB", "TB"):
        if abs(num) < 1024.0:
            return f"{num:.1f} {unit}"
        num /= 1024.0
    return f"{num:.1f} PB"


def _native_remedy(config: EngineConfig, development_remedy: str) -> str:
    if config.native_source == "bundled":
        return "包内组件缺失或损坏，请重新安装 ArchiveLens；若问题仍存在，请保留诊断信息并联系维护人员。"
    return development_remedy


def detect_all(config: EngineConfig | None = None, workspace_dir: Path | None = None) -> dict:
    """执行完整环境自检，返回面向 UI 的诊断结构。"""
    cfg = config or DEFAULT_CONFIG
    checks: list[Check] = []

    # ---- Tesseract ----
    tesseract_ver = _run_version([str(cfg.tesseract_cmd), "--version"]) if cfg.has_tesseract else None
    checks.append(
        Check(
            key="tesseract",
            label="Tesseract OCR",
            # Tesseract only provides the secondary single-character check. The
            # RapidOCR pipeline can still scan without it, so this is degraded
            # capability rather than an application-wide outage.
            status=CHECK_PASS if cfg.has_tesseract else CHECK_WARN,
            detail=tesseract_ver or "未找到 tesseract.exe",
            impact="单字符二次识别将不可用，confirmed 判定降级为 needs_review。" if not cfg.has_tesseract else "",
            remedy=_native_remedy(
                cfg,
                "安装 Tesseract OCR，并确保 tesseract.exe 可从系统 PATH 或应用支持的组件目录访问。",
            ) if not cfg.has_tesseract else "",
            extra={"path": str(cfg.tesseract_cmd), "source": cfg.native_source},
        )
    )

    # ---- DjVuLibre ----
    djvu_ver = _run_version([str(cfg.djvused_exe), "-v"]) if cfg.has_djvu else None
    checks.append(
        Check(
            key="djvulibre",
            label="DjVuLibre",
            # Missing DjVu tools limit supported input formats but do not block
            # PDF scanning.
            status=CHECK_PASS if cfg.has_djvu else CHECK_WARN,
            detail=djvu_ver or ("ddjvu / djvused 就绪" if cfg.has_djvu else "未找到 ddjvu.exe / djvused.exe"),
            impact="无法扫描 DJVU / DJV 文件（PDF 和图片格式不受影响）。" if not cfg.has_djvu else "",
            remedy=_native_remedy(cfg, "安装 DjVuLibre，或仅扫描 PDF、TIFF、JPEG、PNG 文件。") if not cfg.has_djvu else "",
            extra={"path": str(cfg.djvu_bin_dir), "source": cfg.native_source},
        )
    )

    # ---- Pillow 图片解码能力 ----
    try:
        from PIL import features

        raster_features = {
            "JPEG": features.check("jpg"),
            "PNG": features.check("zlib"),
            "TIFF": features.check("libtiff"),
        }
    except Exception:
        raster_features = {"JPEG": False, "PNG": False, "TIFF": False}
    missing_raster = [name for name, available in raster_features.items() if not available]
    checks.append(
        Check(
            key="raster_formats",
            label="图片格式解码",
            status=CHECK_PASS if not missing_raster else CHECK_FAIL,
            detail="TIFF / JPEG / PNG 就绪" if not missing_raster else f"缺少解码能力：{', '.join(missing_raster)}",
            impact="对应图片格式无法扫描。" if missing_raster else "",
            remedy="修复或重新安装 ArchiveLens Engine 的 Pillow 运行组件。" if missing_raster else "",
            extra={name.lower(): "available" if available else "missing" for name, available in raster_features.items()},
        )
    )

    # ---- 语言包 ----
    checks.append(
        Check(
            key="lang_simplified",
            label="简体中文语言包",
            status=CHECK_PASS if cfg.has_simplified_lang else CHECK_WARN,
            detail=", ".join(_lang_present(cfg, simplified=True)) or "缺少 chi_sim.traineddata",
            impact="简体“约”的二次识别不可用。" if not cfg.has_simplified_lang else "",
            remedy=_native_remedy(cfg, "在 tessdata 目录放入 chi_sim.traineddata。") if not cfg.has_simplified_lang else "",
            extra={"path": str(cfg.tessdata_dir or ""), "source": cfg.native_source},
        )
    )
    checks.append(
        Check(
            key="lang_traditional",
            label="繁体中文语言包",
            status=CHECK_PASS if cfg.has_traditional_lang else CHECK_WARN,
            detail=", ".join(_lang_present(cfg, simplified=False)) or "缺少 chi_tra.traineddata",
            impact="繁体“約”的二次识别结果可能不可用。" if not cfg.has_traditional_lang else "",
            remedy=_native_remedy(cfg, "在 tessdata 目录放入 chi_tra.traineddata。") if not cfg.has_traditional_lang else "",
            extra={"path": str(cfg.tessdata_dir or ""), "source": cfg.native_source},
        )
    )

    # ---- RapidOCR / onnxruntime ----
    rapid_ver = None
    onnx_ver = None
    try:
        import rapidocr_onnxruntime  # noqa: F401

        rapid_ver = getattr(rapidocr_onnxruntime, "__version__", "rapidocr-onnxruntime")
    except Exception:
        pass
    try:
        import onnxruntime

        onnx_ver = onnxruntime.__version__
    except Exception:
        pass
    checks.append(
        Check(
            key="rapidocr",
            label="RapidOCR 主识别引擎",
            status=CHECK_PASS if rapid_ver else CHECK_FAIL,
            detail=rapid_ver or "rapidocr_onnxruntime 未安装",
            impact="无法执行 OCR，扫描不可用。" if not rapid_ver else "",
            remedy="修复或重新安装 ArchiveLens Engine；开发环境请按锁定依赖重新安装 rapidocr-onnxruntime。" if not rapid_ver else "",
        )
    )
    checks.append(
        Check(
            key="onnxruntime",
            label="ONNX Runtime",
            status=CHECK_PASS if onnx_ver else CHECK_FAIL,
            detail=onnx_ver or "onnxruntime 未安装",
            impact="RapidOCR 无法加载模型，扫描不可用。" if not onnx_ver else "",
            remedy="修复或重新安装 ArchiveLens Engine；开发环境请按锁定依赖重新安装 onnxruntime。" if not onnx_ver else "",
        )
    )
    unified_model_available = cfg.has_unified_ocr_model
    checks.append(
        Check(
            key="ocr_model",
            label="统一简繁 OCR 模型",
            status=CHECK_PASS if unified_model_available else CHECK_FAIL,
            detail=(
                f"{UNIFIED_OCR_MODEL_ID}（SHA-256 已验证）"
                if unified_model_available
                else "锁定模型缺失或 SHA-256 不匹配"
            ),
            impact="无法可靠执行简繁字形保留与 OCR 扫描。" if not unified_model_available else "",
            remedy=_native_remedy(
                cfg,
                "运行 scripts/prepare-native-runtime.ps1 -OcrOnly，重新准备锁定的统一 OCR 模型。",
            ) if not unified_model_available else "",
            extra={
                "path": str(cfg.ocr_rec_model_path or ""),
                "model_id": UNIFIED_OCR_MODEL_ID,
                "sha256": UNIFIED_OCR_MODEL_SHA256,
                "source": cfg.native_source,
            },
        )
    )

    # ---- 工作目录可写 ----
    if workspace_dir is not None:
        try:
            workspace_dir.mkdir(parents=True, exist_ok=True)
            (workspace_dir / ".al-write-probe").write_text("ok", encoding="utf-8")
            (workspace_dir / ".al-write-probe").unlink(missing_ok=True)
            writable = True
        except OSError:
            writable = False
        free = _disk_free(workspace_dir)
        checks.append(
            Check(
                key="workspace",
                label="工作目录",
                status=CHECK_PASS if writable else CHECK_FAIL,
                detail=f"{workspace_dir}（剩余 {_format_bytes(free)}）",
                impact="任务数据无法写入。" if not writable else "",
                remedy="检查目录权限和可用磁盘空间；修复后重新运行环境诊断。" if not writable else "",
                extra={"free_bytes": str(free) if free is not None else ""},
            )
        )

    overall = CHECK_FAIL if any(c.status == CHECK_FAIL for c in checks) else (
        CHECK_WARN if any(c.status == CHECK_WARN for c in checks) else CHECK_PASS
    )

    return {
        "engine_version": __version__,
        "python_version": platform.python_version(),
        "python_executable": sys.executable,
        "platform": platform.platform(),
        "overall": overall,
        "checks": [_check_to_dict(c) for c in checks],
    }


def _lang_present(config: EngineConfig, simplified: bool) -> list[str]:
    files = config._traineddata_files()
    wanted = SIMPLE_LANG_FILES if simplified else TRAD_LANG_FILES
    present = [name.replace(".traineddata", "") for name in wanted if name in files]
    return present


def _check_to_dict(c: Check) -> dict:
    return {
        "key": c.key,
        "label": c.label,
        "status": c.status,
        "detail": c.detail,
        "impact": c.impact,
        "remedy": c.remedy,
        "extra": c.extra,
    }


__all__ = ["detect_all", "Check", "CHECK_PASS", "CHECK_WARN", "CHECK_FAIL"]
