"""用户检索词的输入与字面量匹配契约。"""

from __future__ import annotations

import json
import unittest
from pathlib import Path

from archivelens_engine.search_terms import (
    find_literal_matches,
    normalize_search_text,
    unicode_sequence,
)

VALIDATION_CASES = json.loads(
    (
        Path(__file__).resolve().parents[2]
        / "tests"
        / "search-terms"
        / "validation-cases.json"
    ).read_text(encoding="utf-8")
)


def _string_from_codepoints(codepoints: list[int]) -> str:
    return "".join(chr(codepoint) for codepoint in codepoints)


class SearchTextValidationTests(unittest.TestCase):
    def test_normalize_search_text_matches_shared_fixture(self) -> None:
        for case in VALIDATION_CASES["search_text_cases"]:
            value = _string_from_codepoints(case["input_codepoints"])
            with self.subTest(case=case["id"]):
                if case["valid"]:
                    self.assertEqual(normalize_search_text(value), case["normalized"])
                else:
                    with self.assertRaisesRegex(ValueError, f"^{case['error']}$"):
                        normalize_search_text(value)


class LiteralMatchTests(unittest.TestCase):
    def test_finds_repeated_and_overlapping_exact_literals(self) -> None:
        self.assertEqual(find_literal_matches("档案档案", "档案"), [(0, 2), (2, 4)])
        self.assertEqual(find_literal_matches("aaaa", "aa"), [(0, 2), (1, 3), (2, 4)])
        self.assertEqual(find_literal_matches("ArchiveLens", "archive"), [])

    def test_unicode_sequence_uses_every_codepoint(self) -> None:
        self.assertEqual(unicode_sequence("档案"), "U+6863 U+6848")


if __name__ == "__main__":
    unittest.main()
