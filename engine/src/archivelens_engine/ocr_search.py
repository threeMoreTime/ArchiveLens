"""任务本地 OCR 语料的简繁双向、分层检索。"""

from __future__ import annotations

from collections import Counter
from typing import Any

from .db.store import (
    OCR_INDEX_PARTIAL,
    OCR_INDEX_READY,
    TaskStore,
)
from .script_variants import (
    ScriptVariantResolver,
)
from .search_terms import find_literal_matches, normalize_search_text


SCRIPT_SCOPE_SIMPLIFIED = "simplified"
SCRIPT_SCOPE_TRADITIONAL = "traditional"
SCRIPT_SCOPE_BOTH = "both"
SCRIPT_SCOPES = {
    SCRIPT_SCOPE_SIMPLIFIED,
    SCRIPT_SCOPE_TRADITIONAL,
    SCRIPT_SCOPE_BOTH,
}

MATCH_LAYER_RAW_EXACT = "raw_exact"
MATCH_LAYER_CONTEXT_RESOLVED = "context_resolved"
MATCH_LAYER_VARIANT_GRAPH = "variant_graph"
MATCH_LAYER_OCR_TOP_K = "ocr_top_k"

LAYER_PRIORITY = {
    MATCH_LAYER_RAW_EXACT: 1,
    MATCH_LAYER_CONTEXT_RESOLVED: 2,
    MATCH_LAYER_VARIANT_GRAPH: 3,
    MATCH_LAYER_OCR_TOP_K: 4,
}

VERIFICATION_SOURCE_EXACT = "source_exact"
VERIFICATION_CONTEXT_RESOLVED = "context_resolved"
VERIFICATION_VARIANT_RELATED = "variant_related"
VERIFICATION_CANDIDATE_PENDING_REVIEW = "candidate_pending_review"
UNKNOWN_SOURCE_SCRIPT = "unknown"


class OCRSearchUnavailable(RuntimeError):
    def __init__(self, status: str, *, requires_reocr: bool) -> None:
        super().__init__(f"OCR search corpus is unavailable: {status}")
        self.status = status
        self.requires_reocr = requires_reocr


class OCRSearchService:
    """执行检索并把会话与命中证据持久化到 TaskStore。"""

    def __init__(
        self,
        store: TaskStore,
        resolver: ScriptVariantResolver | None = None,
    ) -> None:
        self.store = store
        self.resolver = resolver or ScriptVariantResolver()

    @staticmethod
    def _source_mapping(
        source_text: str,
        indexed_text: str,
        start: int,
        end: int,
    ) -> tuple[int | None, int | None, str]:
        if len(source_text) != len(indexed_text):
            return None, None, ""
        return start, end, source_text[start:end]

    def _source_script(self, text: str) -> str:
        return (
            self.resolver.classify_script(text)
            if text
            else UNKNOWN_SOURCE_SCRIPT
        )

    def _in_scope(self, source_script: str, script_scope: str) -> bool:
        return self.resolver.script_matches_scope(
            source_script,
            script_scope,
        )

    @staticmethod
    def _dedupe_key(hit: dict[str, Any]) -> tuple[Any, ...]:
        source_start = hit.get("source_start")
        source_end = hit.get("source_end")
        if isinstance(source_start, int) and isinstance(source_end, int):
            return (
                hit["ocr_line_id"],
                source_start,
                source_end,
            )
        return (
            hit["ocr_line_id"],
            None,
            hit["index_start"],
            hit["index_end"],
        )

    @staticmethod
    def _add_best_hit(
        best_hits: dict[tuple[Any, ...], dict[str, Any]],
        hit: dict[str, Any],
    ) -> None:
        key = OCRSearchService._dedupe_key(hit)
        existing = best_hits.get(key)
        if (
            existing is None
            or int(hit["layer_priority"]) < int(existing["layer_priority"])
        ):
            best_hits[key] = hit

    def _add_text_layer_hits(
        self,
        *,
        best_hits: dict[tuple[Any, ...], dict[str, Any]],
        line: dict[str, Any],
        indexed_text: str,
        query_text: str,
        raw_text: str,
        layer: str,
        index_kind: str,
        verification_status: str,
        script_scope: str,
        payload: dict[str, Any] | None = None,
    ) -> None:
        for index_start, index_end in find_literal_matches(
            indexed_text,
            query_text,
        ):
            source_start, source_end, source_text = self._source_mapping(
                raw_text,
                indexed_text,
                index_start,
                index_end,
            )
            source_script = self._source_script(source_text)
            if not self._in_scope(source_script, script_scope):
                continue
            hit_payload = dict(payload or {})
            hit_payload["source_mapping"] = (
                "exact_length"
                if source_start is not None
                else "unavailable_length_change"
            )
            self._add_best_hit(
                best_hits,
                {
                    "ocr_line_id": line["ocr_line_id"],
                    "match_layer": layer,
                    "layer_priority": LAYER_PRIORITY[layer],
                    "index_kind": index_kind,
                    "matched_text": indexed_text[index_start:index_end],
                    "index_start": index_start,
                    "index_end": index_end,
                    "source_start": source_start,
                    "source_end": source_end,
                    "source_text": source_text,
                    "source_script": source_script,
                    "verification_status": verification_status,
                    "confidence": float(
                        line.get("line_confidence", 0.0) or 0.0
                    ),
                    "payload": hit_payload,
                },
            )

    def _add_top_k_hits(
        self,
        *,
        best_hits: dict[tuple[Any, ...], dict[str, Any]],
        line: dict[str, Any],
        query_simplified: str,
        script_scope: str,
    ) -> None:
        raw_text = str(line.get("raw_text") or "")
        candidates = line.get("isolated_top_k")
        if (
            len(raw_text) != 1
            or not isinstance(candidates, list)
        ):
            return
        for candidate in candidates:
            if (
                not isinstance(candidate, dict)
                or candidate.get("is_primary") is True
            ):
                continue
            candidate_text = candidate.get("text")
            if (
                not isinstance(candidate_text, str)
                or len(candidate_text) != 1
                or self.resolver.forms(candidate_text).simplified
                != query_simplified
            ):
                continue
            source_script = self._source_script(candidate_text)
            if not self._in_scope(source_script, script_scope):
                continue
            self._add_best_hit(
                best_hits,
                {
                    "ocr_line_id": line["ocr_line_id"],
                    "match_layer": MATCH_LAYER_OCR_TOP_K,
                    "layer_priority": LAYER_PRIORITY[MATCH_LAYER_OCR_TOP_K],
                    "index_kind": "ocr_top_k",
                    "matched_text": candidate_text,
                    "index_start": 0,
                    "index_end": 1,
                    "source_start": 0,
                    "source_end": 1,
                    "source_text": raw_text,
                    "source_script": source_script,
                    "verification_status": (
                        VERIFICATION_CANDIDATE_PENDING_REVIEW
                    ),
                    "confidence": float(
                        candidate.get("confidence", 0.0) or 0.0
                    ),
                    "payload": {
                        "candidate": dict(candidate),
                        "primary_ocr_text": raw_text,
                        "semantic_status": "glyph_only_unconfirmed",
                        "semantic_label": "仅字形关联，语义未确认",
                    },
                },
            )

    def search(
        self,
        *,
        task_id: str,
        query_text: str,
        script_scope: str = SCRIPT_SCOPE_BOTH,
    ) -> dict[str, Any]:
        if script_scope not in SCRIPT_SCOPES:
            raise ValueError("script_scope must be simplified, traditional, or both")
        normalized_query = normalize_search_text(query_text)
        corpus_status = self.store.get_ocr_corpus_status(task_id)
        if corpus_status["status"] not in {
            OCR_INDEX_READY,
            OCR_INDEX_PARTIAL,
        }:
            raise OCRSearchUnavailable(
                str(corpus_status["status"]),
                requires_reocr=bool(corpus_status["requires_reocr"]),
            )

        query_graph = self.resolver.query_graph(normalized_query)
        query_forms = dict(query_graph["forms"])
        candidate_lines = self.store.list_ocr_search_candidate_lines(
            task_id,
            normalized_query=normalized_query,
            query_forms=query_forms,
            include_top_k=len(normalized_query) == 1,
        )
        best_hits: dict[tuple[Any, ...], dict[str, Any]] = {}
        for line in candidate_lines:
            raw_text = str(line.get("raw_text") or "")
            resolved_text = str(line.get("resolved_text") or "")
            self._add_text_layer_hits(
                best_hits=best_hits,
                line=line,
                indexed_text=raw_text,
                query_text=normalized_query,
                raw_text=raw_text,
                layer=MATCH_LAYER_RAW_EXACT,
                index_kind="raw",
                verification_status=VERIFICATION_SOURCE_EXACT,
                script_scope=script_scope,
            )
            self._add_text_layer_hits(
                best_hits=best_hits,
                line=line,
                indexed_text=resolved_text,
                query_text=normalized_query,
                raw_text=raw_text,
                layer=MATCH_LAYER_CONTEXT_RESOLVED,
                index_kind="resolved",
                verification_status=VERIFICATION_CONTEXT_RESOLVED,
                script_scope=script_scope,
                payload={
                    "script_reconciliations": line.get(
                        "script_reconciliations",
                    )
                    or [],
                },
            )
            indexes = line.get("indexes")
            if isinstance(indexes, dict):
                for index_kind in (
                    "simplified",
                    "traditional",
                    "taiwan",
                    "hong_kong",
                ):
                    indexed_text = indexes.get(index_kind)
                    graph_query = query_forms.get(index_kind)
                    if (
                        not isinstance(indexed_text, str)
                        or not isinstance(graph_query, str)
                    ):
                        continue
                    self._add_text_layer_hits(
                        best_hits=best_hits,
                        line=line,
                        indexed_text=indexed_text,
                        query_text=graph_query,
                        raw_text=raw_text,
                        layer=MATCH_LAYER_VARIANT_GRAPH,
                        index_kind=index_kind,
                        verification_status=VERIFICATION_VARIANT_RELATED,
                        script_scope=script_scope,
                        payload={
                            "semantic_status": query_graph[
                                "semantic_status"
                            ],
                            "semantic_label": query_graph["semantic_label"],
                            "opencc_phrase_evidence": query_graph[
                                "opencc_phrase_evidence"
                            ],
                        },
                    )
            if len(normalized_query) == 1:
                self._add_top_k_hits(
                    best_hits=best_hits,
                    line=line,
                    query_simplified=query_forms["simplified"],
                    script_scope=script_scope,
                )

        hits = sorted(
            best_hits.values(),
            key=lambda hit: (
                int(hit["layer_priority"]),
                str(hit["ocr_line_id"]),
                (
                    int(hit["source_start"])
                    if isinstance(hit.get("source_start"), int)
                    else int(hit["index_start"])
                ),
            ),
        )
        layer_counts = Counter(
            str(hit["match_layer"])
            for hit in hits
        )
        script_counts = Counter(
            str(hit["source_script"])
            for hit in hits
        )
        verification_counts = Counter(
            str(hit["verification_status"])
            for hit in hits
        )
        counts = {
            "total": len(hits),
            "layers": dict(layer_counts),
            "scripts": dict(script_counts),
            "verification": dict(verification_counts),
            "candidate_pending_review": verification_counts.get(
                VERIFICATION_CANDIDATE_PENDING_REVIEW,
                0,
            ),
            "corpus_status": corpus_status["status"],
            "corpus_incomplete": corpus_status["status"] == OCR_INDEX_PARTIAL,
        }
        return self.store.save_ocr_search_results(
            task_id=task_id,
            query_text=query_text,
            normalized_query=normalized_query,
            script_scope=script_scope,
            query_forms=query_graph,
            hits=hits,
            counts=counts,
        )


__all__ = [
    "LAYER_PRIORITY",
    "MATCH_LAYER_CONTEXT_RESOLVED",
    "MATCH_LAYER_OCR_TOP_K",
    "MATCH_LAYER_RAW_EXACT",
    "MATCH_LAYER_VARIANT_GRAPH",
    "OCRSearchService",
    "OCRSearchUnavailable",
    "SCRIPT_SCOPE_BOTH",
    "SCRIPT_SCOPE_SIMPLIFIED",
    "SCRIPT_SCOPE_TRADITIONAL",
    "SCRIPT_SCOPES",
    "VERIFICATION_CANDIDATE_PENDING_REVIEW",
]
