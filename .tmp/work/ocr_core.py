"""Core OCR helpers for the offline character report pipeline."""

from __future__ import annotations

from typing import Iterable


def normalize_bbox(
    x0: float,
    y0: float,
    x1: float,
    y1: float,
    page_width: float,
    page_height: float,
) -> dict[str, float]:
    return {
        "source_x0": float(x0),
        "source_y0": float(y0),
        "source_x1": float(x1),
        "source_y1": float(y1),
        "normalized_x0": float(x0) / float(page_width),
        "normalized_y0": float(y0) / float(page_height),
        "normalized_x1": float(x1) / float(page_width),
        "normalized_y1": float(y1) / float(page_height),
    }


def split_line_bbox(text: str, bbox: tuple[float, float, float, float]) -> list[tuple[float, float, float, float]]:
    if not text:
        return []
    x0, y0, x1, y1 = [float(value) for value in bbox]
    char_count = len(text)
    width = x1 - x0
    height = y1 - y0
    boxes: list[tuple[float, float, float, float]] = []
    if height >= width:
        step = height / char_count
        for index in range(char_count):
            top = y0 + (index * step)
            bottom = y0 + ((index + 1) * step)
            boxes.append((x0, top, x1, bottom))
        return boxes

    step = width / char_count
    for index in range(char_count):
        left = x0 + (index * step)
        right = x0 + ((index + 1) * step)
        boxes.append((left, y0, right, y1))
    return boxes


def build_context_fields(text: str, char_index: int, radius: int = 15) -> dict[str, str]:
    start = max(0, char_index - radius)
    end = min(len(text), char_index + radius + 1)
    return {
        "context_before": text[start:char_index],
        "matched_character": text[char_index],
        "context_after": text[char_index + 1 : end],
        "context_full": text[start:end],
        "text_line": text,
        "text_block": text,
    }


def dedupe_occurrences(items: Iterable[dict]) -> list[dict]:
    deduped: list[dict] = []
    for item in items:
        match = _find_merge_target(deduped, item)
        if match is None:
            deduped.append(dict(item))
            continue
        preferred = _prefer_occurrence(match, item)
        preferred["detection_sources"] = sorted(
            set(match.get("detection_sources", [])) | set(item.get("detection_sources", []))
        )
        if preferred is not match:
            deduped[deduped.index(match)] = preferred
    return deduped


def assign_occurrence_indexes(items: list[dict]) -> None:
    ordered = sorted(items, key=lambda item: (item["file_path"], item["page_number"], item["source_y0"], item["source_x0"]))
    by_document: dict[str, int] = {}
    by_page: dict[tuple[str, int], int] = {}
    for global_index, occurrence in enumerate(ordered, start=1):
        by_document.setdefault(occurrence["document_id"], 0)
        by_page.setdefault((occurrence["document_id"], occurrence["page_number"]), 0)
        by_document[occurrence["document_id"]] += 1
        by_page[(occurrence["document_id"], occurrence["page_number"])] += 1
        occurrence["global_occurrence_index"] = global_index
        occurrence["document_occurrence_index"] = by_document[occurrence["document_id"]]
        occurrence["page_occurrence_index"] = by_page[(occurrence["document_id"], occurrence["page_number"])]


def classify_verification_status(
    matched_character: str,
    ocr_confidence: float,
    secondary_result: str,
) -> tuple[str, str]:
    if secondary_result and secondary_result not in {"约", "約"}:
        return "rejected", "secondary_non_target"
    if secondary_result and secondary_result != matched_character:
        return "needs_review", "secondary_mismatch"
    if ocr_confidence >= 0.9 and secondary_result == matched_character:
        return "confirmed", ""
    if ocr_confidence >= 0.7:
        return "needs_review", "confidence_between_0_70_and_0_90"
    if secondary_result == matched_character:
        return "needs_review", "low_confidence_but_secondary_matches"
    return "rejected", "low_confidence"


def _find_merge_target(existing_items: list[dict], candidate: dict) -> dict | None:
    for existing in existing_items:
        if existing.get("file_path") != candidate.get("file_path"):
            continue
        if existing.get("page_number") != candidate.get("page_number"):
            continue
        if existing.get("matched_character") != candidate.get("matched_character"):
            continue
        if existing.get("unicode_codepoint") != candidate.get("unicode_codepoint"):
            continue
        if existing.get("context_full") != candidate.get("context_full"):
            continue
        if _bbox_center_distance(existing, candidate) > 8:
            continue
        if _vertical_overlap_ratio(existing, candidate) < 0.8:
            continue
        return existing
    return None


def _prefer_occurrence(left: dict, right: dict) -> dict:
    priority = {
        "pdf_text_layer": 3,
        "djvu_text_layer": 3,
        "pdf_ocr": 2,
        "djvu_ocr": 2,
    }
    left_score = priority.get(left.get("location_method"), 0)
    right_score = priority.get(right.get("location_method"), 0)
    return left if left_score >= right_score else dict(right)


def _bbox_center_distance(left: dict, right: dict) -> float:
    left_center_x = (left["source_x0"] + left["source_x1"]) / 2
    left_center_y = (left["source_y0"] + left["source_y1"]) / 2
    right_center_x = (right["source_x0"] + right["source_x1"]) / 2
    right_center_y = (right["source_y0"] + right["source_y1"]) / 2
    return abs(left_center_x - right_center_x) + abs(left_center_y - right_center_y)


def _vertical_overlap_ratio(left: dict, right: dict) -> float:
    top = max(left["source_y0"], right["source_y0"])
    bottom = min(left["source_y1"], right["source_y1"])
    overlap = max(0.0, bottom - top)
    left_height = left["source_y1"] - left["source_y0"]
    right_height = right["source_y1"] - right["source_y0"]
    smaller = min(left_height, right_height)
    if smaller <= 0:
        return 0.0
    return overlap / smaller
