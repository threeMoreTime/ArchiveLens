"""Core OCR helpers for the offline character report pipeline."""

from __future__ import annotations

import hashlib
import unicodedata
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


def build_bbox_hash(
    *,
    source_x0: float | int | str | None = None,
    source_y0: float | int | str | None = None,
    source_x1: float | int | str | None = None,
    source_y1: float | int | str | None = None,
    normalized_x0: float | int | str | None = None,
    normalized_y0: float | int | str | None = None,
    normalized_x1: float | int | str | None = None,
    normalized_y1: float | int | str | None = None,
) -> str:
    normalized_values = (normalized_x0, normalized_y0, normalized_x1, normalized_y1)
    source_values = (source_x0, source_y0, source_x1, source_y1)
    if all(value is not None for value in normalized_values):
        payload = "|".join(f"{float(value):.8f}" for value in normalized_values)
    elif all(value is not None for value in source_values):
        payload = "|".join(f"{float(value):.3f}" for value in source_values)
    else:
        raise ValueError("bbox_hash requires either normalized or source coordinates")
    return hashlib.sha1(payload.encode("ascii")).hexdigest()


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


def union_bboxes(boxes: Iterable[tuple[float, float, float, float]]) -> tuple[float, float, float, float]:
    """合并同一词语覆盖的字符框，生成一个词语级 bbox。"""
    values = list(boxes)
    if not values:
        raise ValueError("cannot union an empty bbox sequence")
    return (
        min(box[0] for box in values),
        min(box[1] for box in values),
        max(box[2] for box in values),
        max(box[3] for box in values),
    )


def build_context_fields(
    text: str,
    match_start: int,
    match_end: int | None = None,
    radius: int = 15,
) -> dict[str, str | int]:
    """构建不拆分命中词的上下文；省略 ``match_end`` 时兼容旧单字符调用。"""
    resolved_end = match_start + 1 if match_end is None else match_end
    if match_start < 0 or resolved_end <= match_start or resolved_end > len(text):
        raise ValueError("invalid match range")
    start = max(0, match_start - radius)
    end = min(len(text), resolved_end + radius)
    matched_text = text[match_start:resolved_end]
    result: dict[str, str | int] = {
        "context_before": text[start:match_start],
        "matched_text": matched_text,
        "match_start": match_start,
        "match_end": resolved_end,
        "context_after": text[resolved_end:end],
        "context_full": text[start:end],
        "text_line": text,
        "text_block": text,
    }
    if len(matched_text) == 1:
        result["matched_character"] = matched_text
    return result


def build_spatial_context_fields(
    lines: list[dict],
    target_line_index: int,
    match_start: int,
    match_end: int,
    *,
    direction: str = "ltr",
    radius: int = 15,
) -> dict[str, str | int]:
    """按页面阅读方向构建以关键词为中心的上下文。

    ``radius`` 表示关键词前后各自最多保留的可见字符数。空白字符不计数，
    标点、字母、数字和汉字均计数。跨行/跨列时按配置的阅读顺序继续取字。
    """
    if direction not in {"ltr", "rtl", "ttb", "btt"}:
        raise ValueError("invalid context reading direction")
    if type(radius) is not int or not 1 <= radius <= 50:
        raise ValueError("context radius must be between 1 and 50")
    if target_line_index < 0 or target_line_index >= len(lines):
        raise ValueError("invalid target line index")
    target_text = str(lines[target_line_index].get("text") or "")
    if match_start < 0 or match_end <= match_start or match_end > len(target_text):
        raise ValueError("invalid match range")

    ordered_tokens: list[dict] = []
    ordered_lines = sorted(
        enumerate(lines),
        key=lambda item: _context_line_sort_key(item[1].get("bbox"), direction),
    )
    for ordered_line_index, (line_index, line) in enumerate(ordered_lines):
        text = str(line.get("text") or "")
        bbox = line.get("bbox")
        if not text or not isinstance(bbox, (tuple, list)) or len(bbox) != 4:
            continue
        char_boxes = split_line_bbox(text, tuple(float(value) for value in bbox))
        line_tokens = [
            {
                "value": value,
                "line_index": line_index,
                "char_index": char_index,
                "bbox": char_boxes[char_index],
            }
            for char_index, value in enumerate(text)
        ]
        line_tokens.sort(key=lambda token: _context_character_sort_key(token["bbox"], direction))
        if ordered_tokens and ordered_line_index > 0:
            ordered_tokens.append({"value": "\n", "line_index": -1, "char_index": -1, "bbox": None})
        ordered_tokens.extend(line_tokens)

    target_positions = [
        index
        for index, token in enumerate(ordered_tokens)
        if token["line_index"] == target_line_index and match_start <= token["char_index"] < match_end
    ]
    if not target_positions:
        raise ValueError("matched text is missing from ordered OCR tokens")
    first_match = min(target_positions)
    last_match = max(target_positions)
    before = _take_context_tokens(ordered_tokens[:first_match], radius, from_end=True)
    after = _take_context_tokens(ordered_tokens[last_match + 1 :], radius, from_end=False)
    matched_text = target_text[match_start:match_end]
    result: dict[str, str | int] = {
        "context_before": before,
        "matched_text": matched_text,
        "match_start": match_start,
        "match_end": match_end,
        "context_after": after,
        "context_full": f"{before}{matched_text}{after}",
        "text_line": target_text,
        "text_block": f"{before}{matched_text}{after}",
    }
    if len(matched_text) == 1:
        result["matched_character"] = matched_text
    return result


def _context_line_sort_key(raw_bbox: object, direction: str) -> tuple[float, float]:
    if not isinstance(raw_bbox, (tuple, list)) or len(raw_bbox) != 4:
        return (float("inf"), float("inf"))
    x0, y0, x1, y1 = (float(value) for value in raw_bbox)
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    if direction == "ltr":
        return (center_y, center_x)
    if direction == "rtl":
        return (center_y, -center_x)
    if direction == "ttb":
        return (-center_x, center_y)
    return (center_x, -center_y)


def _context_character_sort_key(
    bbox: tuple[float, float, float, float],
    direction: str,
) -> tuple[float, float]:
    x0, y0, x1, y1 = bbox
    center_x = (x0 + x1) / 2
    center_y = (y0 + y1) / 2
    if direction == "ltr":
        return (center_x, center_y)
    if direction == "rtl":
        return (-center_x, center_y)
    if direction == "ttb":
        return (center_y, -center_x)
    return (-center_y, center_x)


def _take_context_tokens(tokens: list[dict], radius: int, *, from_end: bool) -> str:
    iterable = reversed(tokens) if from_end else iter(tokens)
    selected: list[dict] = []
    visible_count = 0
    for token in iterable:
        selected.append(token)
        if not str(token["value"]).isspace():
            visible_count += 1
            if visible_count >= radius:
                break
    if from_end:
        selected.reverse()
    return "".join(str(token["value"]) for token in selected).strip()


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
    matched_text: str,
    ocr_confidence: float,
    secondary_result: str,
) -> tuple[str, str]:
    normalized_secondary = unicodedata.normalize("NFC", secondary_result)
    if normalized_secondary and matched_text not in normalized_secondary:
        if ocr_confidence < 0.7:
            return "rejected", "secondary_non_target"
        return "needs_review", "secondary_mismatch"
    if ocr_confidence >= 0.9 and normalized_secondary:
        return "confirmed", ""
    if ocr_confidence >= 0.7:
        return "needs_review", "confidence_between_0_70_and_0_90"
    if normalized_secondary:
        return "needs_review", "low_confidence_but_secondary_matches"
    return "rejected", "low_confidence"


def _find_merge_target(existing_items: list[dict], candidate: dict) -> dict | None:
    for existing in existing_items:
        if existing.get("file_path") != candidate.get("file_path"):
            continue
        if existing.get("page_number") != candidate.get("page_number"):
            continue
        if existing.get("matched_text", existing.get("matched_character")) != candidate.get(
            "matched_text", candidate.get("matched_character")
        ):
            continue
        if existing.get("unicode_sequence", existing.get("unicode_codepoint")) != candidate.get(
            "unicode_sequence", candidate.get("unicode_codepoint")
        ):
            continue
        existing_range = (existing.get("match_start"), existing.get("match_end"))
        candidate_range = (candidate.get("match_start"), candidate.get("match_end"))
        if all(value is not None for value in (*existing_range, *candidate_range)) and existing_range != candidate_range:
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
