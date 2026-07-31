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
EXPECTED_COUNT = 20

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
    "real-text-350-page",
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
        """所有 fixture 的 relative_path 指向的文件必须实际存在。"""
        for f in self.fixtures:
            rel_path = f.get("relative_path")
            self.assertIsNotNone(rel_path, f"{f['fixture_id']}: 缺少 relative_path")
            file_path = FIXTURE_DIR / rel_path
            self.assertTrue(file_path.exists(), f"{f['fixture_id']}: 文件不存在 {rel_path}")

    def test_sha256_matches(self):
        """确定性 fixture 的 SHA-256 与实际文件一致；runtime fixture 跳过 SHA 但验证格式。"""
        for f in self.fixtures:
            file_path = FIXTURE_DIR / f["relative_path"]
            if f.get("generated_at_runtime"):
                # runtime PDF：验证文件存在 + 可打开（加密 PDF 用密码）
                if f["format"] == "PDF":
                    from pypdf import PdfReader
                    try:
                        reader = PdfReader(str(file_path))
                        if reader.is_encrypted:
                            reader.decrypt("test123")
                        page_count = len(reader.pages)
                        self.assertEqual(page_count, f["pages"],
                                         f"{f['fixture_id']}: PDF 页数 {page_count} != 预期 {f['pages']}")
                    except Exception as e:
                        self.fail(f"{f['fixture_id']}: PDF 无法打开: {e}")
                continue
            # 确定性 fixture：SHA-256 必须匹配
            actual_sha = _sha256(file_path)
            self.assertEqual(actual_sha, f["sha256"],
                             f"{f['fixture_id']}: SHA-256 不匹配")

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
