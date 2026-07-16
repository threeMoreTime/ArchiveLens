"""基于 OpenCC 的简繁字形族与地区字形解析。"""

from __future__ import annotations

from dataclasses import dataclass

import opencc


OPENCC_VERSION = "1.2.0"


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


__all__ = [
    "OPENCC_VERSION",
    "ScriptForms",
    "ScriptVariantResolver",
]
