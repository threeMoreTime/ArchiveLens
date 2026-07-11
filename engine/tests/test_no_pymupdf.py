"""生产 Engine 不得依赖 PyMuPDF（任务 §六门禁）。

AGPL 合规：默认发行链路必须可证明 ``import fitz`` 已从生产代码移除，
PyMuPDF 不再是运行时依赖。
"""

from __future__ import annotations

import unittest
from pathlib import Path

SRC = Path(__file__).resolve().parents[1] / "src" / "archivelens_engine"


class NoPyMuPDFTests(unittest.TestCase):
    def test_report_pipeline_does_not_import_fitz(self) -> None:
        content = (SRC / "report_pipeline.py").read_text(encoding="utf-8")
        self.assertNotIn("import fitz", content, "report_pipeline 不得 import fitz")
        self.assertNotIn("fitz.open", content)
        self.assertNotIn("fitz.Matrix", content)

    def test_pyproject_does_not_declare_pymupdf(self) -> None:
        content = (Path(__file__).resolve().parents[1] / "pyproject.toml").read_text(encoding="utf-8")
        self.assertNotIn("PyMuPDF", content, "pyproject 不得声明 PyMuPDF 运行时依赖")

    def test_lock_does_not_pin_pymupdf(self) -> None:
        content = (Path(__file__).resolve().parents[1] / "requirements-lock.txt").read_text(encoding="utf-8")
        self.assertNotIn("PyMuPDF==", content)

    def test_backends_use_pypdfium2(self) -> None:
        content = (SRC / "documents" / "backends.py").read_text(encoding="utf-8")
        self.assertIn("pypdfium2", content)


if __name__ == "__main__":
    unittest.main()
