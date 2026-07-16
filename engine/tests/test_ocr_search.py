"""简繁范围、分层命中与持久化检索会话测试。"""

from __future__ import annotations

import sqlite3
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.db.store import (
    OCR_INDEX_LEGACY_REQUIRES_REOCR,
    TaskStore,
)
from archivelens_engine.ocr_search import (
    MATCH_LAYER_CONTEXT_RESOLVED,
    MATCH_LAYER_OCR_TOP_K,
    MATCH_LAYER_RAW_EXACT,
    MATCH_LAYER_VARIANT_GRAPH,
    OCRSearchService,
    OCRSearchUnavailable,
    SCRIPT_SCOPE_BOTH,
    SCRIPT_SCOPE_SIMPLIFIED,
    SCRIPT_SCOPE_TRADITIONAL,
)
from archivelens_engine.script_variants import ScriptVariantResolver


MODEL_SHA256 = "a" * 64
SOURCE_ID = "source-main"


class OCRSearchServiceTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.store = TaskStore(Path(self.temporary_directory.name) / "search.db")
        self.resolver = ScriptVariantResolver()
        self.service = OCRSearchService(self.store, self.resolver)

    def tearDown(self) -> None:
        self.store.close()
        self.temporary_directory.cleanup()

    def _line(
        self,
        line_index: int,
        raw_text: str,
        *,
        resolved_text: str | None = None,
        top_k: list[dict] | None = None,
    ) -> dict:
        resolved = resolved_text if resolved_text is not None else raw_text
        forms = self.resolver.forms(resolved)
        return {
            "line_index": line_index,
            "raw_text": raw_text,
            "resolved_text": resolved,
            "confidence": 0.94,
            "bbox": [
                [10, 20 + line_index * 40],
                [210, 20 + line_index * 40],
                [210, 50 + line_index * 40],
                [10, 50 + line_index * 40],
            ],
            "isolated_character_top_k": top_k or [],
            "script_reconciliations": (
                [
                    {
                        "character_index": 0,
                        "contextual_text": raw_text[0],
                        "resolved_text": resolved[0],
                    }
                ]
                if raw_text != resolved
                else []
            ),
            "search_forms": {
                "simplified": forms.simplified,
                "traditional": forms.traditional,
                "taiwan": forms.taiwan,
                "hong_kong": forms.hong_kong,
            },
        }

    def _create_ready_task(
        self,
        lines: list[dict],
        *,
        expected_pages: int = 1,
    ) -> str:
        task_id = self.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir="Z",
            name="search",
        )
        self.store.record_page_completion(
            task_id=task_id,
            source_id=SOURCE_ID,
            page_no=1,
            worker_generation=1,
            occurrences=[],
            ocr_page={
                "document_id": "doc-1",
                "page_no": 1,
                "page_index": 0,
                "source_page_width": 1200,
                "source_page_height": 1800,
                "model": {
                    "id": "PP-OCRv6-small",
                    "source_version": "RapidOCR-3.9.1",
                    "sha256": MODEL_SHA256,
                },
                "lines": lines,
            },
        )
        self.store.finalize_ocr_corpus(
            task_id,
            expected_pages=expected_pages,
            failure_count=0,
        )
        return task_id

    def _hits(self, session_id: str) -> list[dict]:
        total, hits = self.store.query_ocr_search_hits(
            session_id,
            limit=200,
        )
        self.assertEqual(total, len(hits))
        return hits

    def test_both_scope_keeps_highest_layer_for_each_source_position(self) -> None:
        task_id = self._create_ready_task(
            [
                self._line(0, "亏空"),
                self._line(1, "虧空"),
                self._line(2, "虧空", resolved_text="亏空"),
            ]
        )

        session = self.service.search(
            task_id=task_id,
            query_text="亏空",
            script_scope=SCRIPT_SCOPE_BOTH,
        )
        hits = self._hits(session["search_session_id"])

        self.assertEqual(len(hits), 3)
        self.assertEqual(
            {hit["line_index"]: hit["match_layer"] for hit in hits},
            {
                0: MATCH_LAYER_RAW_EXACT,
                1: MATCH_LAYER_VARIANT_GRAPH,
                2: MATCH_LAYER_CONTEXT_RESOLVED,
            },
        )
        self.assertEqual(session["counts"]["total"], 3)
        self.assertEqual(session["counts"]["layers"][MATCH_LAYER_RAW_EXACT], 1)
        self.assertEqual(
            session["counts"]["layers"][MATCH_LAYER_CONTEXT_RESOLVED],
            1,
        )

    def test_single_script_scopes_filter_by_original_image_glyph(self) -> None:
        task_id = self._create_ready_task(
            [
                self._line(0, "亏空"),
                self._line(1, "虧空"),
                self._line(2, "虧空", resolved_text="亏空"),
            ]
        )

        simplified = self.service.search(
            task_id=task_id,
            query_text="亏空",
            script_scope=SCRIPT_SCOPE_SIMPLIFIED,
        )
        traditional = self.service.search(
            task_id=task_id,
            query_text="亏空",
            script_scope=SCRIPT_SCOPE_TRADITIONAL,
        )

        self.assertEqual(
            [hit["line_index"] for hit in self._hits(simplified["search_session_id"])],
            [0],
        )
        self.assertEqual(
            {
                hit["line_index"]
                for hit in self._hits(traditional["search_session_id"])
            },
            {1, 2},
        )

    def test_neutral_glyph_matches_both_scopes_but_mixed_requires_both(self) -> None:
        task_id = self._create_ready_task(
            [
                self._line(0, "空"),
                self._line(1, "亏虧"),
            ]
        )

        simplified_neutral = self.service.search(
            task_id=task_id,
            query_text="空",
            script_scope=SCRIPT_SCOPE_SIMPLIFIED,
        )
        traditional_neutral = self.service.search(
            task_id=task_id,
            query_text="空",
            script_scope=SCRIPT_SCOPE_TRADITIONAL,
        )
        mixed_single_scope = self.service.search(
            task_id=task_id,
            query_text="亏虧",
            script_scope=SCRIPT_SCOPE_SIMPLIFIED,
        )
        mixed_both = self.service.search(
            task_id=task_id,
            query_text="亏虧",
            script_scope=SCRIPT_SCOPE_BOTH,
        )

        self.assertEqual(simplified_neutral["counts"]["total"], 1)
        self.assertEqual(traditional_neutral["counts"]["total"], 1)
        self.assertEqual(mixed_single_scope["counts"]["total"], 0)
        self.assertEqual(mixed_both["counts"]["total"], 1)
        self.assertEqual(
            self._hits(mixed_both["search_session_id"])[0]["source_script"],
            "mixed",
        )

    def test_non_primary_top_k_is_lowest_pending_review_layer(self) -> None:
        task_id = self._create_ready_task(
            [
                self._line(
                    0,
                    "虧",
                    top_k=[
                        {
                            "rank": 1,
                            "text": "虧",
                            "confidence": 0.90,
                            "is_primary": True,
                        },
                        {
                            "rank": 2,
                            "text": "亏",
                            "confidence": 0.08,
                            "is_primary": False,
                        },
                    ],
                )
            ]
        )

        simplified = self.service.search(
            task_id=task_id,
            query_text="亏",
            script_scope=SCRIPT_SCOPE_SIMPLIFIED,
        )
        hits = self._hits(simplified["search_session_id"])

        self.assertEqual(len(hits), 1)
        self.assertEqual(hits[0]["match_layer"], MATCH_LAYER_OCR_TOP_K)
        self.assertEqual(hits[0]["layer_priority"], 4)
        self.assertEqual(
            hits[0]["verification_status"],
            "candidate_pending_review",
        )
        self.assertEqual(simplified["counts"]["candidate_pending_review"], 1)

        traditional = self.service.search(
            task_id=task_id,
            query_text="亏",
            script_scope=SCRIPT_SCOPE_TRADITIONAL,
        )
        traditional_hit = self._hits(traditional["search_session_id"])[0]
        self.assertEqual(
            traditional_hit["match_layer"],
            MATCH_LAYER_VARIANT_GRAPH,
        )

    def test_sessions_are_repeatable_persistent_and_keep_query_graph(self) -> None:
        task_id = self._create_ready_task([self._line(0, "頭髮")])

        first = self.service.search(
            task_id=task_id,
            query_text="头发",
        )
        second = self.service.search(
            task_id=task_id,
            query_text="头发",
        )
        history = self.store.list_ocr_search_sessions(task_id)

        self.assertNotEqual(
            first["search_session_id"],
            second["search_session_id"],
        )
        self.assertEqual(len(history), 2)
        self.assertEqual(
            first["query_forms"]["forms"]["traditional"],
            "頭髮",
        )
        self.assertEqual(
            first["query_forms"]["semantic_status"],
            "opencc_phrase_confirmed",
        )
        self.assertEqual(first["counts"]["total"], 1)
        with self.assertRaises(KeyError):
            self.store.query_ocr_search_hits("search-missing")

    def test_partial_corpus_is_searchable_but_explicitly_incomplete(self) -> None:
        task_id = self._create_ready_task(
            [self._line(0, "亏空")],
            expected_pages=2,
        )

        session = self.service.search(
            task_id=task_id,
            query_text="亏空",
        )

        self.assertTrue(session["counts"]["corpus_incomplete"])
        self.assertEqual(session["counts"]["corpus_status"], "partial")

    def test_search_session_and_hits_roll_back_as_one_transaction(self) -> None:
        task_id = self._create_ready_task([self._line(0, "亏空")])
        line_id = self.store.list_ocr_lines(task_id)[0]["ocr_line_id"]
        duplicate_hit = {
            "ocr_line_id": line_id,
            "match_layer": MATCH_LAYER_RAW_EXACT,
            "layer_priority": 1,
            "index_kind": "raw",
            "matched_text": "亏空",
            "index_start": 0,
            "index_end": 2,
            "source_start": 0,
            "source_end": 2,
            "source_text": "亏空",
            "source_script": "simplified",
            "verification_status": "source_exact",
            "confidence": 0.94,
            "payload": {},
        }

        with self.assertRaises(sqlite3.IntegrityError):
            self.store.save_ocr_search_results(
                task_id=task_id,
                query_text="亏空",
                normalized_query="亏空",
                script_scope=SCRIPT_SCOPE_BOTH,
                query_forms=self.resolver.query_graph("亏空"),
                hits=[duplicate_hit, duplicate_hit],
                counts={"total": 2},
            )

        self.assertEqual(self.store.list_ocr_search_sessions(task_id), [])
        successful = self.service.search(
            task_id=task_id,
            query_text="亏空",
        )
        self.assertEqual(successful["counts"]["total"], 1)

    def test_legacy_task_requires_explicit_reocr_instead_of_fabricated_search(self) -> None:
        task_id = self.store.create_task(
            source_dir="X",
            output_dir="Y",
            workspace_dir="Z",
            name="legacy",
        )
        self.store.conn.execute(
            """
            UPDATE tasks SET ocr_index_status=?
            WHERE task_id=?
            """,
            (OCR_INDEX_LEGACY_REQUIRES_REOCR, task_id),
        )
        self.store.conn.commit()

        with self.assertRaises(OCRSearchUnavailable) as raised:
            self.service.search(
                task_id=task_id,
                query_text="亏空",
            )

        self.assertTrue(raised.exception.requires_reocr)
        self.assertEqual(
            raised.exception.status,
            OCR_INDEX_LEGACY_REQUIRES_REOCR,
        )


if __name__ == "__main__":
    unittest.main()
