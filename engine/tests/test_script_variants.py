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


if __name__ == "__main__":
    unittest.main()
