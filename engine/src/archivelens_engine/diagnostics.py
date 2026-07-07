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
            status=CHECK_PASS if cfg.has_tesseract else CHECK_FAIL,
            detail=tesseract_ver or "未找到 tesseract.exe",
            impact="单字符二次识别将不可用，confirmed 判定降级为 needs_review。" if not cfg.has_tesseract else "",
            remedy="重新安装 OCR 组件，或在设置中选择有效的 Tesseract 目录。" if not cfg.has_tesseract else "",
            extra={"path": str(cfg.tesseract_cmd)},
        )
    )

    # ---- DjVuLibre ----
    checks.append(
        Check(
            key="djvulibre",
            label="DjVuLibre",
            status=CHECK_PASS if cfg.has_djvu else CHECK_FAIL,
            detail="ddjvu / djvused 就绪" if cfg.has_djvu else "未找到 ddjvu.exe / djvused.exe",
            impact="无法扫描 DJVU / DJV 文件（PDF 不受影响）。" if not cfg.has_djvu else "",
            remedy="安装 DjVuLibre，或仅扫描 PDF 目录。" if not cfg.has_djvu else "",
            extra={"path": str(cfg.djvu_bin_dir)},
        )
    )

    # ---- 语言包 ----
    checks.append(
        Check(
            key="lang_simplified",
            label="简体中文语言包",
            status=CHECK_PASS if cfg.has_simplified_lang else CHECK_FAIL,
            detail=", ".join(_lang_present(cfg, simplified=True)) or "缺少 chi_sim.traineddata",
            impact="简体“约”的二次识别不可用。" if not cfg.has_simplified_lang else "",
            remedy="在 tessdata 目录放入 chi_sim.traineddata。" if not cfg.has_simplified_lang else "",
        )
    )
    checks.append(
        Check(
            key="lang_traditional",
            label="繁体中文语言包",
            status=CHECK_PASS if cfg.has_traditional_lang else CHECK_WARN,
            detail=", ".join(_lang_present(cfg, simplified=False)) or "缺少 chi_tra.traineddata",
            impact="繁体“約”的二次识别结果可能不可用。" if not cfg.has_traditional_lang else "",
            remedy="在 tessdata 目录放入 chi_tra.traineddata。" if not cfg.has_traditional_lang else "",
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
        )
    )
    checks.append(
        Check(
            key="onnxruntime",
            label="ONNX Runtime",
            status=CHECK_PASS if onnx_ver else CHECK_FAIL,
            detail=onnx_ver or "onnxruntime 未安装",
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
