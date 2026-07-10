"""用户检索词的输入与字面量匹配契约。"""

from __future__ import annotations

import unittest

from archivelens_engine.search_terms import (
    find_literal_matches,
    normalize_search_text,
    unicode_sequence,
)


class SearchTextValidationTests(unittest.TestCase):
    def test_normalize_search_text_trims_and_normalizes_nfc(self) -> None:
        self.assertEqual(normalize_search_text("  e\u0301  "), "é")
        self.assertEqual(normalize_search_text("档 案"), "档 案")

    def test_normalize_search_text_rejects_empty_linebreak_control_and_long_input(self) -> None:
        for value in ("", "   ", "档\n案", "档\x00案", "档\t案", "档" * 33):
            with self.subTest(value=repr(value)):
                with self.assertRaisesRegex(ValueError, "检索"):
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
