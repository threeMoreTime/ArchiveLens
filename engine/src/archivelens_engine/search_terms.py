"""任务级检索词的规范化和安全字面量匹配。"""

from __future__ import annotations

import unicodedata

LEGACY_SEARCH_TERMS = ("约", "約")
LEGACY_SEARCH_MODE = "legacy_fixed_pair"
EXACT_LITERAL_SEARCH_MODE = "exact_literal"
MAX_SEARCH_TEXT_LENGTH = 32


def normalize_search_text(value: str) -> str:
    """规范化一个用户输入的检索词，失败时给出可展示的中文错误。"""
    if not isinstance(value, str):
        raise ValueError("检索词必须是文字或词语")
    normalized = unicodedata.normalize("NFC", value.strip())
    if not normalized:
        raise ValueError("请输入检索文字或词语")
    if len(normalized) > MAX_SEARCH_TEXT_LENGTH:
        raise ValueError(f"检索词最多 {MAX_SEARCH_TEXT_LENGTH} 个字符")
    if any(character in "\r\n" for character in normalized):
        raise ValueError("检索词不能包含换行")
    if any(unicodedata.category(character).startswith("C") for character in normalized):
        raise ValueError("检索词不能包含控制字符")
    return normalized


def find_literal_matches(text: str, search_text: str) -> list[tuple[int, int]]:
    """返回同一 OCR 行内所有精确字面量匹配，包含重叠匹配。"""
    if not search_text:
        return []
    matches: list[tuple[int, int]] = []
    start = 0
    while True:
        match_start = text.find(search_text, start)
        if match_start < 0:
            return matches
        matches.append((match_start, match_start + len(search_text)))
        start = match_start + 1


def unicode_sequence(text: str) -> str:
    """返回稳定的 Unicode code point 表示，供导出和审计使用。"""
    return " ".join(f"U+{ord(character):04X}" for character in text)


__all__ = [
    "EXACT_LITERAL_SEARCH_MODE",
    "LEGACY_SEARCH_MODE",
    "LEGACY_SEARCH_TERMS",
    "MAX_SEARCH_TEXT_LENGTH",
    "find_literal_matches",
    "normalize_search_text",
    "unicode_sequence",
]
