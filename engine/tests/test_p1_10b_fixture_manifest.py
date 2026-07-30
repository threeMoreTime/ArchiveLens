"""P1-10B-A: 合成语料 manifest 一致性校验。

验证 fixture-manifest.json 的结构完整性、文件存在性、SHA 一致性和字段统一性。
确保 manifest 是后续 P1-10B-B OCR 验收的可信输入。
"""
from __future__ import annotations

import hashlib
import json
import unittest
from pathlib import Path

MANIFEST_PATH = Path("tests/fixtures/p1-10b-synthetic/fixture-manifest.json")
FIXTURE_DIR = MANIFEST_PATH.parent
EXPECTED_COUNT = 19

# 必须存在的 fixture_id（不得缺失）
REQUIRED_IDS = {
    "traditional-vertical-1",
    "multicolumn-1",
    "low-contrast-1",
    "rotated-synthetic-1",
    "noise-1",
    "corrupt-truncated-1",
    "corrupt-zero-byte-1",
    "encrypted-pdf-1",
    "large-350-page",
}


def _sha256(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


class FixtureManifestTests(unittest.TestCase):

    @classmethod
    def setUpClass(cls):
        with open(MANIFEST_PATH, encoding="utf-8") as f:
            cls.manifest = json.load(f)
        cls.fixtures = cls.manifest["fixtures"]

    def test_fixture_count(self):
        self.assertEqual(len(self.fixtures), EXPECTED_COUNT,
                         f"fixture 数量应为 {EXPECTED_COUNT}，实际 {len(self.fixtures)}")

    def test_fixture_ids_unique(self):
        ids = [f["fixture_id"] for f in self.fixtures]
        self.assertEqual(len(ids), len(set(ids)), f"fixture_id 重复: {ids}")

    def test_required_fixtures_present(self):
        actual_ids = {f["fixture_id"] for f in self.fixtures}
        missing = REQUIRED_IDS - actual_ids
        self.assertFalse(missing, f"缺少必需 fixture: {missing}")

    def test_all_files_exist(self):
        for f in self.fixtures:
            # 加密 PDF 的 SHA 含随机盐值，跨平台不可重复；用文件名匹配。
            if f.get("generated_at_runtime"):
                continue
            matched = False
            for candidate in FIXTURE_DIR.iterdir():
                if candidate.is_file() and _sha256(candidate) == f["sha256"]:
                    matched = True
                    break
            self.assertTrue(matched, f"{f['fixture_id']}: 目录中找不到 SHA 匹配的文件")

    def test_sha256_matches(self):
        """manifest 中的 SHA-256 与实际文件一致（跳过加密 PDF）。"""
        for f in self.fixtures:
            if f.get("generated_at_runtime"):
                continue
            found = False
            for candidate in FIXTURE_DIR.iterdir():
                if candidate.is_file() and _sha256(candidate) == f["sha256"]:
                    found = True
                    break
            self.assertTrue(found, f"{f['fixture_id']}: SHA-256 不匹配")

    def test_expected_hits_structure_unified(self):
        """所有 fixture 的 expected_hits 必须是对象（dict），不能是字符串。"""
        for f in self.fixtures:
            self.assertIsInstance(
                f["expected_hits"], dict,
                f"{f['fixture_id']}: expected_hits 应为 dict，实际 {type(f['expected_hits']).__name__}",
            )
            # 对象必须包含 term, min_hits, allowed_missing
            for key in ("term", "min_hits", "allowed_missing"):
                self.assertIn(key, f["expected_hits"],
                              f"{f['fixture_id']}: expected_hits 缺少 {key}")

    def test_expected_task_result_present(self):
        """所有 fixture 必须包含 expected_task_result 字段。"""
        for f in self.fixtures:
            self.assertIn("expected_task_result", f,
                          f"{f['fixture_id']}: 缺少 expected_task_result")
            self.assertIn(f["expected_task_result"], ("completed", "rejected"),
                          f"{f['fixture_id']}: expected_task_result 值非法: {f['expected_task_result']}")

    def test_no_duplicate_sha256(self):
        """无重复 SHA-256。"""
        shas = [f["sha256"] for f in self.fixtures]
        dupes = [s for s in shas if shas.count(s) > 1]
        self.assertFalse(dupes, f"重复 SHA-256: {set(dupes)}")


if __name__ == "__main__":
    unittest.main()
