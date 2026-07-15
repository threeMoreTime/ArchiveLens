from __future__ import annotations

import sys
import tempfile
import unittest
from pathlib import Path
from types import SimpleNamespace
from unittest.mock import patch

from archivelens_engine.diagnostics import CHECK_WARN, detect_all


class DiagnosticsSeverityTests(unittest.TestCase):
    def test_optional_ocr_components_limit_features_without_marking_core_unavailable(self) -> None:
        config = SimpleNamespace(
            has_tesseract=False,
            tesseract_cmd=Path("missing-tesseract"),
            has_djvu=False,
            djvu_bin_dir=Path("missing-djvu"),
            djvused_exe=Path("missing-djvu/djvused.exe"),
            tessdata_dir=None,
            native_source="configured",
            has_simplified_lang=False,
            has_traditional_lang=False,
            _traineddata_files=lambda: set(),
        )
        fake_modules = {
            "rapidocr_onnxruntime": SimpleNamespace(__version__="test"),
            "onnxruntime": SimpleNamespace(__version__="test"),
        }

        with tempfile.TemporaryDirectory() as workspace, patch.dict(sys.modules, fake_modules):
            result = detect_all(config=config, workspace_dir=Path(workspace))

        by_key = {check["key"]: check for check in result["checks"]}
        self.assertEqual(result["overall"], CHECK_WARN)
        self.assertEqual(by_key["tesseract"]["status"], CHECK_WARN)
        self.assertEqual(by_key["djvulibre"]["status"], CHECK_WARN)
        self.assertEqual(by_key["raster_formats"]["status"], "PASS")
        self.assertEqual(by_key["lang_simplified"]["status"], CHECK_WARN)

    def test_missing_bundled_component_recommends_reinstall_instead_of_host_install(self) -> None:
        config = SimpleNamespace(
            has_tesseract=False,
            tesseract_cmd=Path("resources/native/tesseract/tesseract.exe"),
            has_djvu=False,
            djvu_bin_dir=Path("resources/native/djvulibre"),
            djvused_exe=Path("resources/native/djvulibre/djvused.exe"),
            tessdata_dir=Path("resources/native/tesseract/tessdata"),
            native_source="bundled",
            has_simplified_lang=False,
            has_traditional_lang=False,
            _traineddata_files=lambda: set(),
        )
        fake_modules = {
            "rapidocr_onnxruntime": SimpleNamespace(__version__="test"),
            "onnxruntime": SimpleNamespace(__version__="test"),
        }

        with patch.dict(sys.modules, fake_modules):
            result = detect_all(config=config)

        by_key = {check["key"]: check for check in result["checks"]}
        for key in ("tesseract", "djvulibre", "lang_simplified", "lang_traditional"):
            self.assertIn("重新安装 ArchiveLens", by_key[key]["remedy"])
            self.assertNotIn("安装 DjVuLibre", by_key[key]["remedy"])

    def test_diagnostics_identifies_bundled_native_components(self) -> None:
        config = SimpleNamespace(
            has_tesseract=True,
            tesseract_cmd=Path("bundled/tesseract.exe"),
            has_djvu=True,
            djvu_bin_dir=Path("bundled/djvulibre"),
            djvused_exe=Path("bundled/djvulibre/djvused.exe"),
            tessdata_dir=Path("bundled/tessdata"),
            native_source="bundled",
            has_simplified_lang=True,
            has_traditional_lang=True,
            _traineddata_files=lambda: {"chi_sim.traineddata", "chi_tra.traineddata"},
        )
        fake_modules = {
            "rapidocr_onnxruntime": SimpleNamespace(__version__="test"),
            "onnxruntime": SimpleNamespace(__version__="test"),
        }

        with patch.dict(sys.modules, fake_modules), patch("archivelens_engine.diagnostics._run_version", return_value="test-version"):
            result = detect_all(config=config)

        by_key = {check["key"]: check for check in result["checks"]}
        for key in ("tesseract", "djvulibre", "lang_simplified", "lang_traditional"):
            self.assertEqual(by_key[key]["status"], "PASS")
            self.assertEqual(by_key[key]["extra"]["source"], "bundled")


if __name__ == "__main__":
    unittest.main()
