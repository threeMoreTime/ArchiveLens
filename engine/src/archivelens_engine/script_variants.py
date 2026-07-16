"""基于 OpenCC 的简繁字形族与地区字形解析。"""

from __future__ import annotations

from dataclasses import dataclass
from threading import RLock
from typing import Any

import opencc


OPENCC_VERSION = "1.2.0"
SCRIPT_SIMPLIFIED = "simplified"
SCRIPT_TRADITIONAL = "traditional"
SCRIPT_NEUTRAL = "neutral"
SCRIPT_MIXED = "mixed"
GLYPH_ONLY_UNCONFIRMED_LABEL = "仅字形关联，语义未确认"
OPENCC_PHRASE_CONFIRMED_LABEL = "OpenCC 词语映射支持"

_VARIANT_GRAPH_LOCK = RLock()
_VARIANT_GRAPH_CACHE: dict[str, tuple[str, ...]] | None = None
_MAINSTREAM_HAN_RANGES = (
    (0x3400, 0x4DC0),
    (0x4E00, 0xA000),
    (0xF900, 0xFB00),
)


@dataclass(frozen=True)
class ScriptForms:
    original: str
    simplified: str
    traditional: str
    taiwan: str
    hong_kong: str


class ScriptVariantResolver:
    """集中复用 OpenCC 转换器，且永不覆盖调用方传入的原文。"""

    def __init__(self) -> None:
        self._s2t = opencc.OpenCC("s2t.json")
        self._t2s = opencc.OpenCC("t2s.json")
        self._s2tw = opencc.OpenCC("s2tw.json")
        self._s2hk = opencc.OpenCC("s2hk.json")

    def forms(self, text: str) -> ScriptForms:
        simplified = self._t2s.convert(text)
        return ScriptForms(
            original=text,
            simplified=simplified,
            traditional=self._s2t.convert(simplified),
            taiwan=self._s2tw.convert(simplified),
            hong_kong=self._s2hk.convert(simplified),
        )

    def has_script_variant(self, character: str) -> bool:
        if len(character) != 1:
            return False
        forms = self.forms(character)
        return len(
            {
                forms.simplified,
                forms.traditional,
                forms.taiwan,
                forms.hong_kong,
            }
        ) > 1

    def same_script_family(self, left: str, right: str) -> bool:
        if len(left) != 1 or len(right) != 1:
            return False
        return left != right and self._t2s.convert(left) == self._t2s.convert(right)

    def classify_script(self, text: str) -> str:
        scripts: set[str] = set()
        for character in text:
            forms = self.forms(character)
            variants = {
                forms.traditional,
                forms.taiwan,
                forms.hong_kong,
            }
            if len({forms.simplified, *variants}) == 1:
                continue
            if character == forms.simplified:
                scripts.add(SCRIPT_SIMPLIFIED)
            elif character in variants or self._t2s.convert(character) != character:
                scripts.add(SCRIPT_TRADITIONAL)
        if not scripts:
            return SCRIPT_NEUTRAL
        if len(scripts) > 1:
            return SCRIPT_MIXED
        return next(iter(scripts))

    @staticmethod
    def script_matches_scope(script: str, scope: str) -> bool:
        if scope == "both":
            return True
        if script == SCRIPT_NEUTRAL:
            return scope in {SCRIPT_SIMPLIFIED, SCRIPT_TRADITIONAL}
        return script == scope

    def _variant_graph(self) -> dict[str, tuple[str, ...]]:
        global _VARIANT_GRAPH_CACHE
        with _VARIANT_GRAPH_LOCK:
            if _VARIANT_GRAPH_CACHE is None:
                collected: dict[str, set[str]] = {}
                for start, stop in _MAINSTREAM_HAN_RANGES:
                    for codepoint in range(start, stop):
                        character = chr(codepoint)
                        simplified = self._t2s.convert(character)
                        if (
                            len(simplified) == 1
                            and simplified != character
                        ):
                            collected.setdefault(simplified, set()).add(character)
                _VARIANT_GRAPH_CACHE = {
                    simplified: tuple(sorted(variants))
                    for simplified, variants in collected.items()
                }
            return _VARIANT_GRAPH_CACHE

    def mainstream_traditional_variants(self, character: str) -> tuple[str, ...]:
        if len(character) != 1:
            return ()
        simplified = self._t2s.convert(character)
        if len(simplified) != 1:
            return ()
        direct_forms = self.forms(simplified)
        preferred = [
            direct_forms.traditional,
            direct_forms.taiwan,
            direct_forms.hong_kong,
        ]
        variants = set(self._variant_graph().get(simplified, ()))
        variants.update(
            value for value in preferred if value != simplified
        )
        ordered: list[str] = []
        for value in preferred:
            if value in variants and value not in ordered:
                ordered.append(value)
        ordered.extend(sorted(variants.difference(ordered)))
        return tuple(ordered)

    def phrase_evidence(self, text: str) -> dict[str, dict[str, str]]:
        forms = self.forms(text)
        simplified_characters = [
            self._t2s.convert(character)
            for character in text
        ]
        per_character = {
            "traditional": "".join(
                self._s2t.convert(character)
                for character in simplified_characters
            ),
            "taiwan": "".join(
                self._s2tw.convert(character)
                for character in simplified_characters
            ),
            "hong_kong": "".join(
                self._s2hk.convert(character)
                for character in simplified_characters
            ),
        }
        full = {
            "traditional": forms.traditional,
            "taiwan": forms.taiwan,
            "hong_kong": forms.hong_kong,
        }
        return {
            kind: {
                "phrase_form": full[kind],
                "character_form": per_character[kind],
            }
            for kind in full
            if len(text) > 1 and full[kind] != per_character[kind]
        }

    def query_graph(self, text: str) -> dict[str, Any]:
        forms = self.forms(text)
        phrase_evidence = self.phrase_evidence(text)
        single_character_variants: list[dict[str, Any]] = []
        if len(text) == 1:
            simplified = forms.simplified
            regional_forms = {
                "standard": forms.traditional,
                "taiwan": forms.taiwan,
                "hong_kong": forms.hong_kong,
            }
            for candidate in self.mainstream_traditional_variants(text):
                regions = [
                    region
                    for region, regional_form in regional_forms.items()
                    if candidate == regional_form
                ]
                if not regions:
                    regions = ["opencc_t2s_reverse"]
                single_character_variants.append(
                    {
                        "text": candidate,
                        "simplified": simplified,
                        "regions": regions,
                        "semantic_status": "glyph_only_unconfirmed",
                        "semantic_label": GLYPH_ONLY_UNCONFIRMED_LABEL,
                    }
                )
        semantic_status = (
            "opencc_phrase_confirmed"
            if phrase_evidence
            else "glyph_only_unconfirmed"
        )
        return {
            "forms": {
                "original": forms.original,
                "simplified": forms.simplified,
                "traditional": forms.traditional,
                "taiwan": forms.taiwan,
                "hong_kong": forms.hong_kong,
            },
            "semantic_status": semantic_status,
            "semantic_label": (
                OPENCC_PHRASE_CONFIRMED_LABEL
                if phrase_evidence
                else GLYPH_ONLY_UNCONFIRMED_LABEL
            ),
            "opencc_phrase_evidence": phrase_evidence,
            "single_character_variants": single_character_variants,
        }


__all__ = [
    "OPENCC_VERSION",
    "GLYPH_ONLY_UNCONFIRMED_LABEL",
    "OPENCC_PHRASE_CONFIRMED_LABEL",
    "SCRIPT_MIXED",
    "SCRIPT_NEUTRAL",
    "SCRIPT_SIMPLIFIED",
    "SCRIPT_TRADITIONAL",
    "ScriptForms",
    "ScriptVariantResolver",
]
