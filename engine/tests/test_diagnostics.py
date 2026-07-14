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


if __name__ == "__main__":
    unittest.main()
