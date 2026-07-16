"""统一简繁 OCR 适配器，并为孤立单字保留 Top-K 候选。"""

from __future__ import annotations

import unicodedata
from pathlib import Path
from typing import Any

import numpy as np

from .ocr_model import (
    ISOLATED_CHARACTER_TOP_K,
    UNIFIED_OCR_MODEL_FILE,
    UNIFIED_OCR_MODEL_ID,
    UNIFIED_OCR_MODEL_SHA256,
    UNIFIED_OCR_MODEL_SOURCE_VERSION,
    resolve_unified_ocr_model,
    validate_unified_ocr_model,
)
from .script_variants import ScriptVariantResolver


SCRIPT_RECONCILIATION_MAX_CONTEXT_CONFIDENCE = 0.85
SCRIPT_RECONCILIATION_MIN_ISOLATED_CONFIDENCE = 0.97
SCRIPT_RECONCILIATION_MIN_CONFIDENCE_GAIN = 0.15


def is_han_character(value: str) -> bool:
    if len(value) != 1:
        return False
    if value == "〇":
        return True
    return "CJK" in unicodedata.name(value, "")


def extract_single_character_top_k(
    predictions: np.ndarray,
    characters: list[str],
    *,
    primary_text: str,
    k: int = ISOLATED_CHARACTER_TOP_K,
) -> list[dict[str, Any]]:
    """从单字裁剪的 CTC 概率中提取稳定、去重的候选字形。"""

    if predictions.ndim == 3:
        if predictions.shape[0] != 1:
            raise ValueError("single-character predictions must contain one sample")
        predictions = predictions[0]
    if predictions.ndim != 2:
        raise ValueError("single-character predictions must have shape [time, classes]")
    if predictions.shape[1] != len(characters):
        raise ValueError("prediction class count does not match OCR character dictionary")
    if k <= 0:
        raise ValueError("top-k must be greater than zero")

    best_by_character: dict[str, float] = {}
    class_scores = predictions.max(axis=0)
    for class_index, raw_score in enumerate(class_scores.tolist()):
        if class_index == 0:
            continue
        character = characters[class_index]
        if not character or character.isspace() or len(character) != 1:
            continue
        score = float(raw_score)
        previous = best_by_character.get(character)
        if previous is None or score > previous:
            best_by_character[character] = score

    ranked = sorted(best_by_character.items(), key=lambda item: (-item[1], item[0]))
    if primary_text in best_by_character:
        ranked = [(primary_text, best_by_character[primary_text])] + [
            item for item in ranked if item[0] != primary_text
        ]
    selected = ranked[:k]
    return [
        {
            "rank": rank,
            "text": character,
            "confidence": round(max(0.0, min(1.0, score)), 6),
            "is_primary": character == primary_text,
        }
        for rank, (character, score) in enumerate(selected, start=1)
    ]


class ArchiveLensOCR:
    """RapidOCR 检测/方向能力 + 锁定的统一简繁识别模型。"""

    def __init__(self, model_path: str | Path | None = None) -> None:
        resolved = (
            validate_unified_ocr_model(Path(model_path))
            if model_path is not None
            else resolve_unified_ocr_model(required=True)
        )
        assert resolved is not None

        from rapidocr_onnxruntime import RapidOCR

        self.model_path = resolved
        self._engine = RapidOCR(rec_model_path=str(resolved))
        self._script_variants = ScriptVariantResolver()

    @property
    def model_info(self) -> dict[str, Any]:
        return {
            "id": UNIFIED_OCR_MODEL_ID,
            "source_version": UNIFIED_OCR_MODEL_SOURCE_VERSION,
            "file": UNIFIED_OCR_MODEL_FILE,
            "sha256": UNIFIED_OCR_MODEL_SHA256,
        }

    def _raw_single_character_predictions(
        self,
        img_content: Any,
        result_items: list[list[Any]],
    ) -> dict[int, np.ndarray]:
        isolated_indexes = [
            index
            for index, item in enumerate(result_items)
            if len(item) >= 3 and is_han_character(str(item[1]))
        ]
        if not isolated_indexes:
            return {}

        source_image = self._engine.load_img(img_content)
        boxes = np.asarray([result_items[index][0] for index in isolated_indexes], dtype=np.float32)
        crop_images = self._engine.get_crop_img_list(source_image, boxes)
        if self._engine.use_cls:
            crop_images, _, _ = self._engine.text_cls(crop_images)

        predictions_by_index: dict[int, np.ndarray] = {}
        recognizer = self._engine.text_rec
        batch_size = max(1, int(recognizer.rec_batch_num))
        for batch_start in range(0, len(crop_images), batch_size):
            batch_crops = crop_images[batch_start : batch_start + batch_size]
            batch_indexes = isolated_indexes[batch_start : batch_start + batch_size]
            max_wh_ratio = max(
                recognizer.rec_image_shape[2] / recognizer.rec_image_shape[1],
                *(
                    crop.shape[1] / float(crop.shape[0])
                    for crop in batch_crops
                ),
            )
            normalized = [
                recognizer.resize_norm_img(crop, max_wh_ratio)[np.newaxis, :]
                for crop in batch_crops
            ]
            predictions = recognizer.session(
                np.concatenate(normalized).astype(np.float32)
            )[0]
            for result_index, prediction in zip(batch_indexes, predictions):
                predictions_by_index[result_index] = prediction[np.newaxis, :]
        return predictions_by_index

    def _reconcile_script_variants(
        self,
        img_content: Any,
        result_items: list[list[Any]],
    ) -> dict[int, dict[str, Any]]:
        """用同一模型的字符框结果校正低置信简繁混淆，并保留上下文原文。"""

        candidates: list[tuple[int, int, str, float, Any]] = []
        line_characters: dict[int, list[str]] = {}
        for line_index, item in enumerate(result_items):
            if len(item) < 6:
                continue
            contextual_text = str(item[1])
            word_boxes, word_characters, word_confidences = item[3:6]
            if (
                not isinstance(word_boxes, list)
                or not isinstance(word_characters, list)
                or not isinstance(word_confidences, list)
                or len(word_characters) <= 1
                or len(word_boxes) != len(word_characters)
                or len(word_confidences) != len(word_characters)
                or "".join(str(value) for value in word_characters) != contextual_text
            ):
                continue
            line_characters[line_index] = [str(value) for value in word_characters]
            for character_index, (character, confidence, box) in enumerate(
                zip(word_characters, word_confidences, word_boxes)
            ):
                character = str(character)
                confidence = float(confidence)
                if (
                    is_han_character(character)
                    and confidence <= SCRIPT_RECONCILIATION_MAX_CONTEXT_CONFIDENCE
                    and self._script_variants.has_script_variant(character)
                ):
                    candidates.append(
                        (line_index, character_index, character, confidence, box)
                    )
        if not candidates:
            return {}

        source_image = self._engine.load_img(img_content)
        boxes = np.asarray([candidate[4] for candidate in candidates], dtype=np.float32)
        crop_images = self._engine.get_crop_img_list(source_image, boxes)
        if self._engine.use_cls:
            crop_images, _, _ = self._engine.text_cls(crop_images)
        isolated_results, _ = self._engine.text_rec(crop_images, False)

        reconciliations: dict[int, list[dict[str, Any]]] = {}
        for candidate, isolated_result in zip(candidates, isolated_results):
            line_index, character_index, contextual_character, contextual_confidence, _ = (
                candidate
            )
            isolated_character, isolated_confidence = isolated_result
            isolated_character = str(isolated_character)
            isolated_confidence = float(isolated_confidence)
            if (
                not is_han_character(isolated_character)
                or isolated_confidence < SCRIPT_RECONCILIATION_MIN_ISOLATED_CONFIDENCE
                or isolated_confidence - contextual_confidence
                < SCRIPT_RECONCILIATION_MIN_CONFIDENCE_GAIN
                or not self._script_variants.same_script_family(
                    contextual_character,
                    isolated_character,
                )
            ):
                continue
            line_characters[line_index][character_index] = isolated_character
            reconciliations.setdefault(line_index, []).append(
                {
                    "character_index": character_index,
                    "contextual_text": contextual_character,
                    "contextual_confidence": round(contextual_confidence, 6),
                    "resolved_text": isolated_character,
                    "isolated_confidence": round(isolated_confidence, 6),
                    "method": "same_model_character_box_opencc_family",
                }
            )

        return {
            line_index: {
                "resolved_text": "".join(line_characters[line_index]),
                "reconciliations": entries,
            }
            for line_index, entries in reconciliations.items()
        }

    def __call__(self, img_content: Any, *args: Any, **kwargs: Any) -> Any:
        internal_kwargs = dict(kwargs)
        internal_kwargs["return_word_box"] = True
        result_items, timings = self._engine(img_content, *args, **internal_kwargs)
        if not result_items:
            return result_items, timings

        script_resolutions = self._reconcile_script_variants(img_content, result_items)
        raw_predictions = self._raw_single_character_predictions(img_content, result_items)
        characters = self._engine.text_rec.postprocess_op.character
        enriched: list[list[Any]] = []
        for index, item in enumerate(result_items):
            copied = list(item)
            contextual_text = str(item[1])
            resolution = script_resolutions.get(index)
            resolved_text = (
                str(resolution["resolved_text"]) if resolution else contextual_text
            )
            copied[1] = resolved_text
            metadata: dict[str, Any] = {
                "model": self.model_info,
                "contextual_text": contextual_text,
                "resolved_text": resolved_text,
                "script_reconciliations": (
                    list(resolution["reconciliations"]) if resolution else []
                ),
            }
            predictions = raw_predictions.get(index)
            if predictions is not None:
                metadata["isolated_character_top_k"] = extract_single_character_top_k(
                    predictions,
                    characters,
                    primary_text=resolved_text,
                )
            copied.append(metadata)
            enriched.append(copied)
        return enriched, timings


__all__ = [
    "ArchiveLensOCR",
    "extract_single_character_top_k",
    "is_han_character",
]
