"""不可变 OCR 语料、简繁索引与页面事务契约。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from archivelens_engine.db.store import (
    OCR_INDEX_BUILDING,
    OCR_INDEX_NOT_BUILT,
    OCR_INDEX_PARTIAL,
    OCR_INDEX_READY,
    TaskStore,
)


SOURCE_ID = "source-document"
MODEL_SHA256 = "a" * 64


def _ocr_page(
    page_no: int = 1,
    *,
    model_sha256: str = MODEL_SHA256,
    raw_text: str = "虧空",
    resolved_text: str = "虧空",
) -> dict:
    return {
        "document_id": "doc-1",
        "page_no": page_no,
        "page_index": page_no - 1,
        "source_page_width": 1200,
        "source_page_height": 1800,
        "model": {
            "id": "PP-OCRv6-small",
            "source_version": "RapidOCR-3.9.1",
            "sha256": model_sha256,
        },
        "lines": [
            {
                "line_index": 0,
                "raw_text": raw_text,
                "resolved_text": resolved_text,
                "confidence": 0.93,
                "bbox": [[10.0, 20.0], [210.0, 20.0], [210.0, 80.0], [10.0, 80.0]],
                "word_boxes": [],
                "word_text": [],
                "word_confidences": [],
                "isolated_character_top_k": [],
                "script_reconciliations": [],
                "search_forms": {
                    "simplified": "亏空",
                    "traditional": "虧空",
                    "taiwan": "虧空",
                    "hong_kong": "虧空",
                },
            }
        ],
    }


def _occurrence(page_no: int = 1) -> dict:
    return {
        "occurrence_id": f"occ-{page_no}",
        "document_id": "doc-1",
        "source_id": SOURCE_ID,
        "file_name": "sample.pdf",
        "relative_path": "sample.pdf",
        "page_number": page_no,
        "page_index": page_no - 1,
        "matched_text": "亏空",
        "match_start": 0,
        "match_end": 2,
        "bbox_hash": f"bbox-{page_no}",
        "verification_status": "confirmed",
        "context_full": "亏空",
    }


class OCRCorpusContractTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temporary_directory.name) / "corpus.db")
        self.task_id = self.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir="Z",
            name="corpus",
        )

    def tearDown(self) -> None:
        self.store.close()
        self.temporary_directory.cleanup()

    def test_new_task_starts_without_fabricated_corpus(self) -> None:
        status = self.store.get_ocr_corpus_status(self.task_id)

        self.assertEqual(status["status"], OCR_INDEX_NOT_BUILT)
        self.assertEqual(status["corpus_version"], 0)
        self.assertEqual(status["indexed_pages"], 0)
        self.assertEqual(status["line_count"], 0)
        self.assertFalse(status["requires_reocr"])

    def test_page_completion_atomically_persists_raw_evidence_and_all_indexes(self) -> None:
        outcome = self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[_occurrence()],
            ocr_page=_ocr_page(),
        )

        self.assertEqual(outcome["ocr_line_count"], 1)
        self.assertEqual(outcome["event"]["payload"]["ocr_line_count"], 1)
        status = self.store.get_ocr_corpus_status(self.task_id)
        self.assertEqual(status["status"], OCR_INDEX_BUILDING)
        self.assertEqual(status["indexed_pages"], 1)
        self.assertEqual(status["line_count"], 1)
        self.assertEqual(status["model_sha256"], MODEL_SHA256)

        lines = self.store.list_ocr_lines(self.task_id)
        self.assertEqual(len(lines), 1)
        self.assertEqual(lines[0]["raw_text"], "虧空")
        self.assertEqual(lines[0]["resolved_text"], "虧空")
        self.assertEqual(lines[0]["bbox"][0], [10.0, 20.0])
        index_rows = self.store.conn.execute(
            """
            SELECT index_kind, indexed_text
            FROM ocr_line_indexes
            WHERE task_id=?
            ORDER BY index_kind
            """,
            (self.task_id,),
        ).fetchall()
        self.assertEqual(
            {row["index_kind"]: row["indexed_text"] for row in index_rows},
            {
                "hong_kong": "虧空",
                "simplified": "亏空",
                "taiwan": "虧空",
                "traditional": "虧空",
            },
        )

    def test_raw_evidence_is_immutable_but_correction_layer_is_writable(self) -> None:
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page=_ocr_page(),
        )
        line_id = self.store.list_ocr_lines(self.task_id)[0]["ocr_line_id"]

        with self.assertRaisesRegex(sqlite3.IntegrityError, "immutable"):
            self.store.conn.execute(
                "UPDATE ocr_lines SET raw_text='亏空' WHERE ocr_line_id=?",
                (line_id,),
            )
        self.store.conn.execute(
            """
            UPDATE ocr_lines
            SET correction_text=?, correction_provenance_json=?
            WHERE ocr_line_id=?
            """,
            ("虧空", '{"source":"human-review"}', line_id),
        )
        self.store.conn.commit()

        line = self.store.list_ocr_lines(self.task_id)[0]
        self.assertEqual(line["raw_text"], "虧空")
        self.assertEqual(line["correction_text"], "虧空")
        self.assertEqual(
            line["correction_provenance"],
            {"source": "human-review"},
        )

    def test_occurrence_failure_rolls_back_corpus_checkpoint_and_event(self) -> None:
        with mock.patch.object(
            self.store,
            "add_occurrence",
            side_effect=RuntimeError("injected occurrence failure"),
        ):
            with self.assertRaisesRegex(RuntimeError, "injected occurrence failure"):
                self.store.record_page_completion(
                    task_id=self.task_id,
                    source_id=SOURCE_ID,
                    page_no=1,
                    worker_generation=1,
                    occurrences=[_occurrence()],
                    ocr_page=_ocr_page(),
                )

        self.assertEqual(self.store.list_processed_page_ids(self.task_id, SOURCE_ID), [])
        self.assertIsNone(self.store.get_task_checkpoint(self.task_id, SOURCE_ID))
        self.assertEqual(self.store.list_ocr_lines(self.task_id), [])
        self.assertEqual(
            self.store.conn.execute(
                "SELECT COUNT(*) FROM ocr_corpus_pages WHERE task_id=?",
                (self.task_id,),
            ).fetchone()[0],
            0,
        )
        self.assertEqual(
            self.store.get_ocr_corpus_status(self.task_id)["status"],
            OCR_INDEX_NOT_BUILT,
        )
        self.assertEqual(self.store.list_task_events(self.task_id), [])

    def test_duplicate_page_is_idempotent_and_model_drift_is_rejected(self) -> None:
        first = self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page=_ocr_page(),
        )
        duplicate = self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page=_ocr_page(raw_text="不同内容"),
        )

        self.assertFalse(first["already_processed"])
        self.assertTrue(duplicate["already_processed"])
        self.assertEqual(duplicate["ocr_line_count"], 0)
        self.assertEqual(len(self.store.list_ocr_lines(self.task_id)), 1)
        with self.assertRaisesRegex(ValueError, "cannot change"):
            self.store.record_page_completion(
                task_id=self.task_id,
                source_id=SOURCE_ID,
                page_no=2,
                worker_generation=1,
                occurrences=[],
                ocr_page=_ocr_page(2, model_sha256="b" * 64),
            )
        self.assertEqual(self.store.list_processed_page_ids(self.task_id, SOURCE_ID), [1])
        self.assertEqual(len(self.store.list_ocr_lines(self.task_id)), 1)

    def test_finalize_marks_complete_and_incomplete_corpora_truthfully(self) -> None:
        self.store.record_page_completion(
            task_id=self.task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page=_ocr_page(),
        )

        partial = self.store.finalize_ocr_corpus(
            self.task_id,
            expected_pages=2,
            failure_count=0,
        )
        self.assertEqual(partial["status"], OCR_INDEX_PARTIAL)
        ready = self.store.finalize_ocr_corpus(
            self.task_id,
            expected_pages=1,
            failure_count=0,
        )
        self.assertEqual(ready["status"], OCR_INDEX_READY)


if __name__ == "__main__":
    unittest.main()
