from __future__ import annotations

import unittest
from pathlib import Path
from tempfile import TemporaryDirectory
from unittest.mock import patch

import numpy as np
import pypdfium2 as pdfium

from archivelens_engine.ocr_engine import ArchiveLensOCR, extract_single_character_top_k, is_han_character


class OCRCandidateTests(unittest.TestCase):
    def test_han_character_detection_keeps_script_variants(self) -> None:
        for character in ("亏", "虧", "臺", "裏", "〇"):
            self.assertTrue(is_han_character(character))
        for value in ("", "亏空", "A", "。"):
            self.assertFalse(is_han_character(value))

    def test_top_k_excludes_blank_and_keeps_primary_first(self) -> None:
        characters = ["blank", "亏", "虧", "空", "A", " "]
        predictions = np.asarray(
            [
                [
                    [0.7, 0.10, 0.08, 0.04, 0.03, 0.05],
                    [0.1, 0.15, 0.55, 0.08, 0.07, 0.05],
                    [0.1, 0.75, 0.05, 0.04, 0.03, 0.03],
                ]
            ],
            dtype=np.float32,
        )

        candidates = extract_single_character_top_k(
            predictions,
            characters,
            primary_text="虧",
            k=3,
        )

        self.assertEqual([item["text"] for item in candidates], ["虧", "亏", "空"])
        self.assertTrue(candidates[0]["is_primary"])
        self.assertEqual([item["rank"] for item in candidates], [1, 2, 3])

    def test_top_k_rejects_dictionary_shape_mismatch(self) -> None:
        with self.assertRaisesRegex(ValueError, "class count"):
            extract_single_character_top_k(
                np.zeros((1, 3, 4), dtype=np.float32),
                ["blank", "亏"],
                primary_text="亏",
            )

    def test_explicit_model_path_rejects_hash_mismatch_before_runtime_load(self) -> None:
        with TemporaryDirectory() as temporary_directory:
            model_path = Path(temporary_directory) / "model.onnx"
            model_path.write_bytes(b"not-the-locked-model")
            with patch(
                "archivelens_engine.ocr_model.sha256_file",
                return_value="0" * 64,
            ):
                with self.assertRaisesRegex(RuntimeError, "SHA-256"):
                    ArchiveLensOCR(model_path)

    def test_real_isolated_character_keeps_model_metadata_and_top_k(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2]
            / "tests"
            / "fixtures"
            / "ocr"
            / "custom-single.pdf"
        )
        with TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "single.png"
            document = pdfium.PdfDocument(str(fixture))
            try:
                page = document[0]
                try:
                    page.render(scale=2.0).to_pil().save(image_path, "PNG")
                finally:
                    page.close()
            finally:
                document.close()

            results, _ = ArchiveLensOCR()(str(image_path))

        self.assertIsNotNone(results)
        isolated = next(item for item in results if item[1] == "档")
        metadata = isolated[-1]
        self.assertEqual(metadata["model"]["id"], "PP-OCRv6-small")
        candidates = metadata["isolated_character_top_k"]
        self.assertLessEqual(len(candidates), 5)
        self.assertEqual(candidates[0]["text"], "档")
        self.assertTrue(candidates[0]["is_primary"])

    def test_real_mixed_script_line_preserves_context_and_resolves_glyphs(self) -> None:
        fixture = (
            Path(__file__).resolve().parents[2]
            / "tests"
            / "fixtures"
            / "ocr"
            / "legacy-pair.pdf"
        )
        with TemporaryDirectory() as temporary_directory:
            image_path = Path(temporary_directory) / "pair.png"
            document = pdfium.PdfDocument(str(fixture))
            try:
                page = document[0]
                try:
                    page.render(scale=2.0).to_pil().save(image_path, "PNG")
                finally:
                    page.close()
            finally:
                document.close()

            results, _ = ArchiveLensOCR()(str(image_path))

        pair = next(item for item in results if item[1] == "约約")
        metadata = pair[-1]
        self.assertEqual(metadata["contextual_text"], "約約")
        self.assertEqual(metadata["resolved_text"], "约約")
        self.assertEqual(len(metadata["script_reconciliations"]), 1)
        reconciliation = metadata["script_reconciliations"][0]
        self.assertEqual(reconciliation["contextual_text"], "約")
        self.assertEqual(reconciliation["resolved_text"], "约")
        self.assertEqual(
            reconciliation["method"],
            "same_model_character_box_opencc_family",
        )


if __name__ == "__main__":
    unittest.main()
