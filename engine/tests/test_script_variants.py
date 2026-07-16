from __future__ import annotations

import unittest

from archivelens_engine.script_variants import ScriptVariantResolver


class ScriptVariantResolverTests(unittest.TestCase):
    @classmethod
    def setUpClass(cls) -> None:
        cls.resolver = ScriptVariantResolver()

    def test_forms_keep_original_and_generate_mainstream_regional_variants(self) -> None:
        forms = self.resolver.forms("里面")

        self.assertEqual(forms.original, "里面")
        self.assertEqual(forms.simplified, "里面")
        self.assertNotEqual(forms.traditional, forms.simplified)
        self.assertNotEqual(forms.taiwan, forms.simplified)
        self.assertNotEqual(forms.hong_kong, forms.simplified)

    def test_same_family_accepts_script_variants_without_merging_semantics(self) -> None:
        self.assertTrue(self.resolver.same_script_family("约", "約"))
        self.assertTrue(self.resolver.same_script_family("里", "裡"))
        self.assertFalse(self.resolver.same_script_family("虧", "虚"))
        self.assertFalse(self.resolver.same_script_family("约", "约"))

    def test_variant_detection_skips_invariant_characters(self) -> None:
        self.assertTrue(self.resolver.has_script_variant("约"))
        self.assertTrue(self.resolver.has_script_variant("約"))
        self.assertFalse(self.resolver.has_script_variant("上"))

    def test_script_classification_distinguishes_neutral_and_mixed_text(self) -> None:
        self.assertEqual(self.resolver.classify_script("亏空"), "simplified")
        self.assertEqual(self.resolver.classify_script("虧空"), "traditional")
        self.assertEqual(self.resolver.classify_script("空"), "neutral")
        self.assertEqual(self.resolver.classify_script("亏虧"), "mixed")
        self.assertTrue(self.resolver.script_matches_scope("neutral", "simplified"))
        self.assertTrue(self.resolver.script_matches_scope("neutral", "traditional"))
        self.assertFalse(self.resolver.script_matches_scope("mixed", "simplified"))

    def test_single_character_graph_keeps_one_to_many_variants_unconfirmed(self) -> None:
        graph = self.resolver.query_graph("发")
        candidates = {
            item["text"]: item
            for item in graph["single_character_variants"]
        }

        self.assertIn("發", candidates)
        self.assertIn("髮", candidates)
        self.assertEqual(
            candidates["髮"]["semantic_label"],
            "仅字形关联，语义未确认",
        )
        self.assertEqual(graph["semantic_status"], "glyph_only_unconfirmed")

    def test_phrase_graph_marks_only_detectable_opencc_phrase_evidence(self) -> None:
        graph = self.resolver.query_graph("头发")

        self.assertEqual(graph["forms"]["traditional"], "頭髮")
        self.assertEqual(graph["semantic_status"], "opencc_phrase_confirmed")
        self.assertIn("traditional", graph["opencc_phrase_evidence"])
        self.assertEqual(
            graph["opencc_phrase_evidence"]["traditional"]["character_form"],
            "頭發",
        )


if __name__ == "__main__":
    unittest.main()
