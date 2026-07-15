"""Real PDF rendering and RapidOCR coverage for task-scoped search terms."""

from __future__ import annotations

import hashlib
import html
import json
import shutil
import tempfile
import unittest
from pathlib import Path

import pypdfium2 as pdfium
from PIL import Image

from archivelens_engine.server import (
    Server,
    _h_export_html,
    _h_export_json,
    _h_review_decision,
    _h_review_note,
    _h_tasks_create,
    _h_tasks_start,
)
from archivelens_engine.search_terms import unicode_sequence


ROOT = Path(__file__).resolve().parents[2]
FIXTURE_ROOT = ROOT / "tests" / "fixtures" / "ocr"
MANIFEST_PATH = FIXTURE_ROOT / "expected.json"


class CustomSearchFixtureTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.manifest = json.loads(MANIFEST_PATH.read_text(encoding="utf-8"))

    def test_fixture_files_match_manifest_hashes(self) -> None:
        self.assertEqual(self.manifest["schema_version"], 2)
        self.assertEqual(self.manifest["generator"]["font"]["name"], "SimHei")
        self.assertEqual(self.manifest["generator"]["font"]["version"], "5.05")
        self.assertFalse(self.manifest["generator"]["font"]["redistributed"])

        expected_hashes = {
            item["file"]: item["sha256"]
            for item in [*self.manifest["legacy_documents"], *self.manifest["cases"]]
        }
        for file_name, expected_hash in expected_hashes.items():
            fixture = FIXTURE_ROOT / file_name
            self.assertTrue(fixture.is_file(), file_name)
            self.assertEqual(hashlib.sha256(fixture.read_bytes()).hexdigest(), expected_hash)
            document = pdfium.PdfDocument(str(fixture))
            try:
                for page in document:
                    text_page = page.get_textpage()
                    try:
                        self.assertEqual(text_page.get_text_range(), "", file_name)
                    finally:
                        text_page.close()
                        page.close()
            finally:
                document.close()

    def test_real_engine_pipeline_matches_custom_search_cases(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            root = Path(tmp)
            server = Server(workspace_root=root / "engine")
            bbox_widths: dict[str, float] = {}
            try:
                for case in self.manifest["cases"]:
                    with self.subTest(case=case["id"]):
                        source_dir = root / "sources" / case["id"]
                        source_dir.mkdir(parents=True)
                        shutil.copy2(FIXTURE_ROOT / case["file"], source_dir / case["file"])

                        created = _h_tasks_create(
                            server,
                            {"source_dir": str(source_dir), "search_text": case["search_text"]},
                        )
                        task_id = created["task_id"]
                        _h_tasks_start(server, {"task_id": task_id})
                        server._scan_threads[task_id].join(timeout=120)
                        self.assertFalse(server._scan_threads[task_id].is_alive(), case["id"])

                        task = server.store.get_task(task_id)
                        assert task is not None
                        self.assertEqual(task["status"], "completed")
                        self.assertEqual(task["search_text"], case["search_text"])
                        self.assertEqual(task["search_terms"], [case["search_text"]])
                        self.assertEqual(task["search_mode"], "exact_literal")
                        self.assertEqual(task["failure_count"], 0)
                        self.assertEqual(task["occurrence_count"], case["expected_count"])

                        total, items = server.store.query_occurrences(task_id=task_id, limit=100, offset=0)
                        self.assertEqual(total, case["expected_count"])
                        actual = sorted(items, key=lambda item: (item["page_number"], item["match_start"]))
                        expected = sorted(
                            case["expected_matches"],
                            key=lambda item: (item["page_number"], item["match_start"]),
                        )
                        self.assertEqual(
                            [
                                {
                                    "matched_text": item["matched_text"],
                                    "page_number": item["page_number"],
                                    "match_start": item["match_start"],
                                    "match_end": item["match_end"],
                                }
                                for item in actual
                            ],
                            expected,
                        )
                        for item in actual:
                            self.assertEqual(item["unicode_sequence"], unicode_sequence(item["matched_text"]))
                            self.assertIn(item["matched_text"], item["context_full"])
                            self.assertGreater(item["ocr_confidence"], 0)
                            self.assertIn(item["verification_status"], {"confirmed", "needs_review", "rejected"})
                            self.assertGreater(item["source_x1"], item["source_x0"])
                            self.assertGreater(item["source_y1"], item["source_y0"])
                            for coordinate in ("normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1"):
                                self.assertGreaterEqual(item[coordinate], 0)
                                self.assertLessEqual(item[coordinate], 1)
                            crop = Path(task["workspace_dir"]) / item["crop_image_relpath"]
                            self.assertTrue(crop.is_file())
                            with Image.open(crop) as crop_image:
                                self.assertGreater(crop_image.width, 0)
                                self.assertGreater(crop_image.height, 0)
                            if case["id"] in {"custom-single", "custom-multi"}:
                                bbox_widths[case["id"]] = item["source_x1"] - item["source_x0"]

                        if items:
                            occurrence_id = items[0]["occurrence_id"]
                            _h_review_decision(
                                server,
                                {"task_id": task_id, "occurrence_id": occurrence_id, "decision": "confirmed"},
                            )
                            _h_review_note(
                                server,
                                {"task_id": task_id, "occurrence_id": occurrence_id, "note": "fixture A&B <safe>"},
                            )
                            _total, items = server.store.query_occurrences(task_id=task_id, limit=100, offset=0)

                        json_export = Path(_h_export_json(server, {"task_id": task_id})["path"])
                        json_payload = json.loads(json_export.read_text(encoding="utf-8"))
                        self.assertEqual(json_payload["task"]["search_text"], case["search_text"])
                        self.assertEqual(
                            [item["matched_text"] for item in json_payload["occurrences"]],
                            [item["matched_text"] for item in items],
                        )
                        if items:
                            self.assertEqual(json_payload["occurrences"][0]["review_decision"], "confirmed")
                            self.assertEqual(json_payload["occurrences"][0]["review_note"], "fixture A&B <safe>")

                        html_export = Path(_h_export_html(server, {"task_id": task_id})["path"])
                        html_content = html_export.read_text(encoding="utf-8")
                        self.assertIn(f"检索词：{html.escape(case['search_text'], quote=True)}", html_content)
                        if items:
                            self.assertIn("fixture A\\u0026B \\u003csafe\\u003e", html_content)
                            self.assertNotIn("fixture A&B <safe>", html_content)
                        self.assertNotIn("http://", html_content)
                        self.assertNotIn("https://", html_content)
                self.assertGreater(bbox_widths["custom-multi"], bbox_widths["custom-single"] * 2)
            finally:
                server.store.close()


if __name__ == "__main__":
    unittest.main()
