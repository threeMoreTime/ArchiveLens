"""Block-aware OCR layout context for proofreading evidence.

The legacy context builder linearised every OCR line on a page.  Small bbox
differences could therefore interleave separate page regions.  This module
first partitions lines into spatial blocks, then returns only the matched line
and its immediate neighbours inside the same block.
"""

from __future__ import annotations

from dataclasses import dataclass
import hashlib
import json
import math
from statistics import median
from typing import Any, Iterable


LAYOUT_CONTEXT_VERSION = 2
LAYOUT_MODES = frozenset({"auto", "horizontal", "vertical"})
MAX_LAYOUT_PARTITION_LINES = 256
MAX_LAYOUT_CANDIDATE_BLOCKS = 64


Rect = tuple[float, float, float, float]


def stable_ocr_line_id(task_id: str, source_id: str, page_no: int, line_index: int) -> str:
    """Build the shared deterministic identity for one persisted OCR line."""
    payload = f"{task_id}\x1f{source_id}\x1f{page_no}\x1f{line_index}".encode("utf-8")
    return f"line_{hashlib.sha256(payload).hexdigest()[:32]}"


@dataclass(frozen=True)
class _LayoutLine:
    ocr_line_id: str
    line_index: int
    text: str
    rect: Rect


def _rect(raw_bbox: object) -> Rect | None:
    if isinstance(raw_bbox, str):
        try:
            raw_bbox = json.loads(raw_bbox)
        except (TypeError, ValueError, json.JSONDecodeError):
            return None
    if not isinstance(raw_bbox, (list, tuple)) or not raw_bbox:
        return None
    if len(raw_bbox) == 4 and all(isinstance(value, (int, float)) for value in raw_bbox):
        x0, y0, x1, y1 = (float(value) for value in raw_bbox)
    else:
        points: list[tuple[float, float]] = []
        for point in raw_bbox:
            if (
                isinstance(point, (list, tuple))
                and len(point) >= 2
                and isinstance(point[0], (int, float))
                and isinstance(point[1], (int, float))
            ):
                points.append((float(point[0]), float(point[1])))
        if not points:
            return None
        x0 = min(point[0] for point in points)
        y0 = min(point[1] for point in points)
        x1 = max(point[0] for point in points)
        y1 = max(point[1] for point in points)
    if not all(math.isfinite(value) for value in (x0, y0, x1, y1)) or x1 <= x0 or y1 <= y0:
        return None
    return x0, y0, x1, y1


def _line_records(lines: Iterable[dict[str, Any]]) -> list[_LayoutLine]:
    records: list[_LayoutLine] = []
    for fallback_index, line in enumerate(lines):
        text = str(line.get("raw_text") or line.get("text") or "")
        rect = _rect(line.get("bbox", line.get("bbox_json")))
        if not text or rect is None:
            continue
        records.append(
            _LayoutLine(
                ocr_line_id=str(line.get("ocr_line_id") or ""),
                line_index=int(line.get("line_index", fallback_index)),
                text=text,
                rect=rect,
            )
        )
    return records


def _union_rect(lines: Iterable[_LayoutLine]) -> Rect:
    values = list(lines)
    if not values:
        raise ValueError("cannot build a block from zero OCR lines")
    return (
        min(line.rect[0] for line in values),
        min(line.rect[1] for line in values),
        max(line.rect[2] for line in values),
        max(line.rect[3] for line in values),
    )


def _intersection_ratio(first: tuple[float, float], second: tuple[float, float]) -> float:
    overlap = max(0.0, min(first[1], second[1]) - max(first[0], second[0]))
    smallest = min(first[1] - first[0], second[1] - second[0])
    return overlap / smallest if smallest > 0 else 0.0


def _axis_gap(first: tuple[float, float], second: tuple[float, float]) -> float:
    if first[1] < second[0]:
        return second[0] - first[1]
    if second[1] < first[0]:
        return first[0] - second[1]
    return 0.0


def _orientation_for_line(line: _LayoutLine) -> tuple[str, float]:
    width = line.rect[2] - line.rect[0]
    height = line.rect[3] - line.rect[1]
    if height >= width:
        ratio = height / max(width, 1.0)
        return "vertical", min(1.0, 0.45 + (ratio - 1.0) / 3.0)
    ratio = width / max(height, 1.0)
    return "horizontal", min(1.0, 0.45 + (ratio - 1.0) / 3.0)


def _partition_blocks(lines: list[_LayoutLine], orientation: str) -> list[list[_LayoutLine]]:
    if not lines:
        return []
    cross_sizes = [
        (line.rect[2] - line.rect[0]) if orientation == "vertical" else (line.rect[3] - line.rect[1])
        for line in lines
    ]
    typical_cross_size = max(1.0, float(median(cross_sizes)))
    gap_limit = typical_cross_size * 2.6
    neighbours: dict[int, set[int]] = {index: set() for index in range(len(lines))}
    for left_index, left in enumerate(lines):
        for right_index in range(left_index + 1, len(lines)):
            right = lines[right_index]
            if orientation == "vertical":
                main_overlap = _intersection_ratio(
                    (left.rect[1], left.rect[3]),
                    (right.rect[1], right.rect[3]),
                )
                cross_gap = _axis_gap(
                    (left.rect[0], left.rect[2]),
                    (right.rect[0], right.rect[2]),
                )
            else:
                main_overlap = _intersection_ratio(
                    (left.rect[0], left.rect[2]),
                    (right.rect[0], right.rect[2]),
                )
                cross_gap = _axis_gap(
                    (left.rect[1], left.rect[3]),
                    (right.rect[1], right.rect[3]),
                )
            if main_overlap >= 0.28 and cross_gap <= gap_limit:
                neighbours[left_index].add(right_index)
                neighbours[right_index].add(left_index)

    blocks: list[list[_LayoutLine]] = []
    remaining = set(range(len(lines)))
    while remaining:
        seed = remaining.pop()
        pending = [seed]
        component = [seed]
        while pending:
            current = pending.pop()
            for neighbour in neighbours[current]:
                if neighbour in remaining:
                    remaining.remove(neighbour)
                    pending.append(neighbour)
                    component.append(neighbour)
        blocks.append([lines[index] for index in component])
    return blocks


def _normalized_rect(rect: Rect, page_width: float, page_height: float) -> dict[str, float]:
    width = max(1.0, float(page_width))
    height = max(1.0, float(page_height))
    return {
        "x0": max(0.0, min(1.0, rect[0] / width)),
        "y0": max(0.0, min(1.0, rect[1] / height)),
        "x1": max(0.0, min(1.0, rect[2] / width)),
        "y1": max(0.0, min(1.0, rect[3] / height)),
    }


def _source_rect(rect: Rect) -> dict[str, float]:
    return {"x0": rect[0], "y0": rect[1], "x1": rect[2], "y1": rect[3]}


def _line_matches_occurrence(line: _LayoutLine, occurrence: dict[str, Any]) -> bool:
    start = occurrence.get("match_start")
    end = occurrence.get("match_end")
    matched = str(occurrence.get("matched_text") or occurrence.get("matched_character") or "")
    return (
        isinstance(start, int)
        and isinstance(end, int)
        and 0 <= start < end <= len(line.text)
        and (not matched or line.text[start:end] == matched)
    )


def locate_occurrence_line(
    lines: Iterable[dict[str, Any]],
    occurrence: dict[str, Any],
) -> int:
    """Return the persisted ``line_index`` that owns an occurrence bbox."""
    records = _line_records(lines)
    requested_id = str(occurrence.get("ocr_line_id") or "")
    if requested_id:
        exact = next((line for line in records if line.ocr_line_id == requested_id), None)
        if exact is not None:
            return exact.line_index

    occurrence_rect = _rect(
        (
            occurrence.get("source_x0"),
            occurrence.get("source_y0"),
            occurrence.get("source_x1"),
            occurrence.get("source_y1"),
        )
    )
    if occurrence_rect is None:
        raise ValueError("occurrence is missing a valid source bbox")
    occurrence_center = (
        (occurrence_rect[0] + occurrence_rect[2]) / 2,
        (occurrence_rect[1] + occurrence_rect[3]) / 2,
    )
    candidates = [line for line in records if _line_matches_occurrence(line, occurrence)] or records
    if not candidates:
        raise ValueError("page has no usable OCR lines")

    def score(line: _LayoutLine) -> tuple[int, float]:
        contains = (
            line.rect[0] <= occurrence_center[0] <= line.rect[2]
            and line.rect[1] <= occurrence_center[1] <= line.rect[3]
        )
        line_center = ((line.rect[0] + line.rect[2]) / 2, (line.rect[1] + line.rect[3]) / 2)
        distance = math.hypot(line_center[0] - occurrence_center[0], line_center[1] - occurrence_center[1])
        return (0 if contains else 1, distance)

    return min(candidates, key=score).line_index


def build_layout_context(
    lines: Iterable[dict[str, Any]],
    *,
    target_line_index: int,
    match_start: int,
    match_end: int,
    layout_mode: str = "auto",
    page_width: float = 0,
    page_height: float = 0,
    block_override: object | None = None,
) -> dict[str, Any]:
    """Build a three-column or three-row context around one OCR match."""
    if layout_mode not in LAYOUT_MODES:
        raise ValueError("layout_mode must be auto, horizontal, or vertical")
    records = _line_records(lines)
    target = next((line for line in records if line.line_index == target_line_index), None)
    if target is None:
        raise ValueError("target OCR line is missing")
    if not 0 <= match_start < match_end <= len(target.text):
        raise ValueError("invalid match range")

    detected_orientation, orientation_confidence = _orientation_for_line(target)
    orientation = detected_orientation if layout_mode == "auto" else layout_mode
    if layout_mode != "auto":
        orientation_confidence = 1.0
    compatible = [
        line
        for line in records
        if layout_mode != "auto" or _orientation_for_line(line)[0] == orientation
    ]
    if target not in compatible:
        compatible.append(target)
    if len(compatible) > MAX_LAYOUT_PARTITION_LINES:
        target_center = (
            (target.rect[0] + target.rect[2]) / 2,
            (target.rect[1] + target.rect[3]) / 2,
        )

        def distance_from_target(line: _LayoutLine) -> float:
            line_center = (
                (line.rect[0] + line.rect[2]) / 2,
                (line.rect[1] + line.rect[3]) / 2,
            )
            return math.hypot(
                line_center[0] - target_center[0],
                line_center[1] - target_center[1],
            )

        nearest = sorted(
            (line for line in compatible if line is not target),
            key=distance_from_target,
        )[: MAX_LAYOUT_PARTITION_LINES - 1]
        compatible = [target, *nearest]
    blocks = _partition_blocks(compatible, orientation)
    candidate_pool: list[dict[str, Any]] = []
    target_block: list[_LayoutLine] | None = None
    for index, block in enumerate(blocks):
        block_rect = _union_rect(block)
        candidate_pool.append(
            {
                "id": f"block-{index + 1}",
                "orientation": orientation,
                "line_count": len(block),
                "bbox": _source_rect(block_rect),
                "normalized_bbox": _normalized_rect(block_rect, page_width, page_height),
                "contains_target": target in block,
            }
        )
        if target in block:
            target_block = block

    target_center = (
        (target.rect[0] + target.rect[2]) / 2,
        (target.rect[1] + target.rect[3]) / 2,
    )

    def candidate_rank(candidate: dict[str, Any]) -> tuple[int, float]:
        bbox = candidate["bbox"]
        center_x = (float(bbox["x0"]) + float(bbox["x1"])) / 2
        center_y = (float(bbox["y0"]) + float(bbox["y1"])) / 2
        return (
            0 if candidate["contains_target"] else 1,
            math.hypot(center_x - target_center[0], center_y - target_center[1]),
        )

    candidates = sorted(candidate_pool, key=candidate_rank)[:MAX_LAYOUT_CANDIDATE_BLOCKS]

    override_rect = _rect(block_override)
    if override_rect is not None:
        selected = []
        for line in compatible:
            center_x = (line.rect[0] + line.rect[2]) / 2
            center_y = (line.rect[1] + line.rect[3]) / 2
            if override_rect[0] <= center_x <= override_rect[2] and override_rect[1] <= center_y <= override_rect[3]:
                selected.append(line)
        if target not in selected:
            selected.append(target)
        target_block = selected

    target_block = target_block or [target]
    ordered = sorted(
        target_block,
        key=(
            (lambda line: (-(line.rect[0] + line.rect[2]) / 2, (line.rect[1] + line.rect[3]) / 2))
            if orientation == "vertical"
            else (lambda line: ((line.rect[1] + line.rect[3]) / 2, (line.rect[0] + line.rect[2]) / 2))
        ),
    )
    target_position = ordered.index(target)
    selected_lines = ordered[max(0, target_position - 1) : target_position + 2]
    uncertain_reason = ""
    if layout_mode == "auto" and orientation_confidence < 0.65:
        uncertain_reason = "orientation_uncertain"
    elif len(target_block) == 1:
        uncertain_reason = "block_uncertain"
    if uncertain_reason:
        selected_lines = [target]

    context_rect = _union_rect(selected_lines)
    items: list[dict[str, Any]] = []
    for line in selected_lines:
        role = "target" if line is target else "context"
        item = {
            "ocr_line_id": line.ocr_line_id,
            "line_index": line.line_index,
            "role": role,
            "text": line.text,
            "bbox": _source_rect(line.rect),
            "normalized_bbox": _normalized_rect(line.rect, page_width, page_height),
            "match_start": match_start if line is target else None,
            "match_end": match_end if line is target else None,
        }
        items.append(item)

    plain_text = "\n".join(line.text for line in selected_lines)
    confidence = min(orientation_confidence, 0.55 if uncertain_reason else 0.95)
    return {
        "version": LAYOUT_CONTEXT_VERSION,
        "status": "uncertain" if uncertain_reason else "ready",
        "reason": uncertain_reason,
        "orientation": orientation,
        "confidence": round(confidence, 4),
        "target_line_index": target.line_index,
        "target_ocr_line_id": target.ocr_line_id,
        "match_start": match_start,
        "match_end": match_end,
        "plain_text": plain_text,
        "bbox": _source_rect(context_rect),
        "normalized_bbox": _normalized_rect(context_rect, page_width, page_height),
        "block_bbox": _source_rect(_union_rect(target_block)),
        "normalized_block_bbox": _normalized_rect(_union_rect(target_block), page_width, page_height),
        "items": items,
        "candidate_blocks": candidates,
    }


def build_occurrence_layout_context(
    lines: Iterable[dict[str, Any]],
    occurrence: dict[str, Any],
    *,
    layout_mode: str = "auto",
    block_override: object | None = None,
) -> dict[str, Any]:
    line_values = list(lines)
    target_line_index = locate_occurrence_line(line_values, occurrence)
    start = occurrence.get("match_start")
    end = occurrence.get("match_end")
    if not isinstance(start, int) or not isinstance(end, int):
        raise ValueError("occurrence is missing its OCR match range")
    return build_layout_context(
        line_values,
        target_line_index=target_line_index,
        match_start=start,
        match_end=end,
        layout_mode=layout_mode,
        page_width=float(occurrence.get("source_page_width") or 0),
        page_height=float(occurrence.get("source_page_height") or 0),
        block_override=block_override,
    )
