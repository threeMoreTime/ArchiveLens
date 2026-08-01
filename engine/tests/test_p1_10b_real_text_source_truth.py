"""P1-10B-B0: 350 页真实文字 PDF 的 source truth 自动校验。

验证 source truth JSON 的结构、词频计算、模板分类、PDF 页数、
无文本层和 manifest 一致性。任何不一致必须测试失败。
"""
from __future__ import annotations

import json
import unittest
from pathlib import Path

FIXTURE_DIR = Path("tests/fixtures/p1-10b-synthetic")
TRUTH_PATH = FIXTURE_DIR / "real-text-350-source-truth.json"
PDF_PATH = FIXTURE_DIR / "real-text-350-page.pdf"
MANIFEST_PATH = FIXTURE_DIR / "fixture-manifest.json"

EXPECTED_TOTAL_PAGES = 350
EXPECTED_TEMPLATE_COUNT = 35
EXPECTED_SIMP_HITS = 1630
EXPECTED_TRAD_HITS = 280
EXPECTED_TOTAL_HITS = 1910
EXPECTED_SIMP_PAGES = 300
EXPECTED_TRAD_PAGES = 50
EXPECTED_VERTICAL_PAGES = 70
EXPECTED_HORIZONTAL_PAGES = 280
EXPECTED_SIMP_HORIZONTAL = 240
EXPECTED_SIMP_VERTICAL = 60
EXPECTED_TRAD_HORIZONTAL = 40
EXPECTED_TRAD_VERTICAL = 10


class RealTextSourceTruthTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with open(TRUTH_PATH, encoding="utf-8") as f:
            cls.truth = json.load(f)
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            cls.manifest = json.load(f)
        cls.pages = cls.truth["pages"]

    # --- 1. 总页数 ---
    def test_01_total_pages(self):
        self.assertEqual(self.truth["total_pages"], EXPECTED_TOTAL_PAGES)
        self.assertEqual(len(self.pages), EXPECTED_TOTAL_PAGES)

    # --- 2. page_number 连续 1~350 ---
    def test_02_page_numbers_continuous(self):
        numbers = [p["page_number"] for p in self.pages]
        self.assertEqual(numbers, list(range(1, EXPECTED_TOTAL_PAGES + 1)))

    # --- 3. template_id 恰好 35 个 ---
    def test_03_template_count(self):
        self.assertEqual(self.truth["template_count"], EXPECTED_TEMPLATE_COUNT)
        template_ids = {p["template_id"] for p in self.pages}
        self.assertEqual(len(template_ids), EXPECTED_TEMPLATE_COUNT)

    # --- 4. 每个 template_id 出现 10 次 ---
    def test_04_each_template_appears_10_times(self):
        from collections import Counter
        counts = Counter(p["template_id"] for p in self.pages)
        for tid, count in counts.items():
            self.assertEqual(count, 10, f"{tid} 出现 {count} 次，应为 10")

    # --- 5. 每页至少有一个正数词频 ---
    def test_05_each_page_has_positive_hits(self):
        for p in self.pages:
            total_hits = sum(p["terms"].values())
            self.assertGreater(total_hits, 0, f"page {p['page_number']} 词频为 0")

    # --- 6. 每页词频与模板生成逻辑一致 ---
    def test_06_page_hits_match_template_logic(self):
        """重新从模板定义计算词频，与 source truth 中的值比较。"""
        TERM_SIMP = "档案管理"
        TERM_TRAD = "檔案管理"
        for i in range(EXPECTED_TEMPLATE_COUNT):
            is_trad = (i % 7 == 6)
            if is_trad:
                term = TERM_TRAD
                title = f"歷史檔案管理編號{i+1}"
                body_lines = [f"第{j+1}條 檔案管理規定" for j in range(3 + i % 4)]
            else:
                term = TERM_SIMP
                title = f"历史档案管理编号{i+1}"
                body_lines = [f"第{j+1}条 档案管理规定" for j in range(3 + i % 4)]
            expected_hits = title.count(term) + sum(line.count(term) for line in body_lines)

            # 找到该模板的第一个页验证
            tid = f"template-{i+1:02d}"
            matching_pages = [p for p in self.pages if p["template_id"] == tid]
            for p in matching_pages:
                actual_hits = p["terms"].get(term, 0)
                self.assertEqual(actual_hits, expected_hits,
                                 f"{tid} page {p['page_number']}: 词频 {actual_hits} != {expected_hits}")

    # --- 7. 简体总次数 ---
    def test_07_simplified_total_hits(self):
        simp_term_entry = next(st for st in self.truth["search_terms"] if st["term"] == "档案管理")
        self.assertEqual(simp_term_entry["source_truth_hits"], EXPECTED_SIMP_HITS)

    # --- 8. 繁体总次数 ---
    def test_08_traditional_total_hits(self):
        trad_term_entry = next(st for st in self.truth["search_terms"] if st["term"] == "檔案管理")
        self.assertEqual(trad_term_entry["source_truth_hits"], EXPECTED_TRAD_HITS)

    # --- 9. 总次数 ---
    def test_09_grand_total_hits(self):
        total = sum(st["source_truth_hits"] for st in self.truth["search_terms"])
        self.assertEqual(total, EXPECTED_TOTAL_HITS)

    # --- 10. 简体/繁体、横排/竖排分类数量 ---
    def test_10_layout_script_classification(self):
        simp_pages = [p for p in self.pages if p["script"] == "simplified"]
        trad_pages = [p for p in self.pages if p["script"] == "traditional"]
        vert_pages = [p for p in self.pages if p["layout"] == "vertical"]
        horiz_pages = [p for p in self.pages if p["layout"] == "horizontal"]
        simp_h = [p for p in simp_pages if p["layout"] == "horizontal"]
        simp_v = [p for p in simp_pages if p["layout"] == "vertical"]
        trad_h = [p for p in trad_pages if p["layout"] == "horizontal"]
        trad_v = [p for p in trad_pages if p["layout"] == "vertical"]

        self.assertEqual(len(simp_pages), EXPECTED_SIMP_PAGES)
        self.assertEqual(len(trad_pages), EXPECTED_TRAD_PAGES)
        self.assertEqual(len(vert_pages), EXPECTED_VERTICAL_PAGES)
        self.assertEqual(len(horiz_pages), EXPECTED_HORIZONTAL_PAGES)
        self.assertEqual(len(simp_h), EXPECTED_SIMP_HORIZONTAL)
        self.assertEqual(len(simp_v), EXPECTED_SIMP_VERTICAL)
        self.assertEqual(len(trad_h), EXPECTED_TRAD_HORIZONTAL)
        self.assertEqual(len(trad_v), EXPECTED_TRAD_VERTICAL)

    # --- 11. PDF 页数为 350 ---
    def test_11_pdf_page_count(self):
        try:
            from pypdf import PdfReader
        except ImportError:
            self.skipTest("pypdf 不可用")
        reader = PdfReader(str(PDF_PATH))
        self.assertEqual(len(reader.pages), EXPECTED_TOTAL_PAGES)

    # --- 12. PDF 页面不存在可提取文本层 ---
    def test_12_pdf_no_text_layer(self):
        try:
            from pypdf import PdfReader
        except ImportError:
            self.skipTest("pypdf 不可用")
        reader = PdfReader(str(PDF_PATH))
        # 抽样检查前 5 页 + 后 5 页
        sample_indices = list(range(5)) + list(range(345, 350))
        for idx in sample_indices:
            text = reader.pages[idx].extract_text() or ""
            self.assertEqual(text.strip(), "",
                             f"PDF 第 {idx+1} 页有可提取文本层: '{text[:50]}'")

    # --- 13. manifest 指向的 source truth 文件存在 ---
    def test_13_manifest_references_source_truth(self):
        real_fixture = next(
            (f for f in self.manifest["fixtures"] if f["fixture_id"] == "real-text-350-page"),
            None,
        )
        self.assertIsNotNone(real_fixture, "manifest 中缺少 real-text-350-page")
        truth_ref = real_fixture.get("source_truth")
        self.assertEqual(truth_ref, "real-text-350-source-truth.json")
        self.assertTrue((FIXTURE_DIR / truth_ref).exists(), "source truth 文件不存在")

    # --- 14. manifest expected_terms 与 source truth 汇总一致 ---
    def test_14_manifest_expected_terms_match_truth(self):
        real_fixture = next(
            (f for f in self.manifest["fixtures"] if f["fixture_id"] == "real-text-350-page"),
            None,
        )
        self.assertIsNotNone(real_fixture)
        expected_terms = real_fixture.get("expected_terms")
        self.assertIsNotNone(expected_terms, "manifest 缺少 expected_terms")
        self.assertEqual(len(expected_terms), 2)

        for et in expected_terms:
            st = next(
                (st for st in self.truth["search_terms"] if st["term"] == et["term"]),
                None,
            )
            self.assertIsNotNone(st, f"source truth 中缺少 {et['term']}")
            self.assertEqual(et["source_truth_hits"], st["source_truth_hits"],
                             f"{et['term']} source_truth_hits 不一致")
            self.assertEqual(et["pages_containing_term"], st["pages_containing_term"],
                             f"{et['term']} pages_containing_term 不一致")


if __name__ == "__main__":
    unittest.main()
