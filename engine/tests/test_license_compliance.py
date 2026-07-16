from __future__ import annotations

import importlib.util
import json
import tempfile
import unittest
from pathlib import Path


ROOT = Path(__file__).resolve().parents[2]
SCRIPT = ROOT / "scripts" / "verify-license-compliance.py"
SPEC = importlib.util.spec_from_file_location("verify_license_compliance", SCRIPT)
assert SPEC is not None and SPEC.loader is not None
MODULE = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(MODULE)


class LicenseComplianceGateTests(unittest.TestCase):
    def test_source_technical_gate_passes_without_public_approval(self) -> None:
        result = MODULE.run_gate(mode="source")

        self.assertEqual(result["status"], "PASS")
        self.assertEqual(result["public_release_license_approval"], "NOT_GRANTED")
        self.assertEqual(result["formal_release_authorization"], "NOT_PROVIDED")
        self.assertEqual(result["monetary_cost"], 0)

    def test_public_gate_fails_closed_for_unapproved_candidate(self) -> None:
        approval = {
            "schema_version": 1,
            "scope": "public-distribution-license-review",
            "approved": False,
            "candidate_sha": "",
            "reviewer": "",
            "reviewed_at": "",
            "technical_evidence_reviewed": False,
            "decisions": {decision: False for decision in MODULE.REQUIRED_APPROVAL_DECISIONS},
            "blockers": ["review required"],
        }
        with tempfile.TemporaryDirectory() as temp_dir:
            approval_path = Path(temp_dir) / "approval.json"
            approval_path.write_text(json.dumps(approval), encoding="utf-8")
            result = MODULE.run_gate(
                mode="source",
                candidate_sha="a" * 40,
                require_public_approval=True,
                approval_path=approval_path,
            )

        self.assertEqual(result["status"], "FAIL")
        failure_codes = {failure["code"] for failure in result["failures"]}
        self.assertIn("PUBLIC_RELEASE_APPROVAL_REQUIRED", failure_codes)
        self.assertIn("PUBLIC_LICENSE_BLOCKERS_EMPTY", failure_codes)

    def test_packaged_gate_requires_real_resources(self) -> None:
        with tempfile.TemporaryDirectory() as temp_dir:
            result = MODULE.run_gate(
                mode="packaged",
                resources_root=Path(temp_dir),
                candidate_sha="b" * 40,
            )

        self.assertEqual(result["status"], "FAIL")
        failure_codes = {failure["code"] for failure in result["failures"]}
        self.assertIn("PACKAGED_PROJECT_LICENSE", failure_codes)
        self.assertIn("PACKAGED_NATIVE_LOCK", failure_codes)


if __name__ == "__main__":
    unittest.main()
