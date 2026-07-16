"""ArchiveLens zero-cost license and public-release technical gate.

The source and packaged modes validate reproducible engineering evidence. The
optional public-approval check is deliberately fail-closed and never authorizes
an actual release by itself.
"""

from __future__ import annotations

import argparse
import hashlib
import json
import re
import sys
import tomllib
from datetime import datetime
from pathlib import Path
from typing import Any


ROOT = Path(__file__).resolve().parents[1]
APPROVAL_PATH = ROOT / "docs" / "compliance" / "public-release-license-approval.json"
HEX_SHA256 = re.compile(r"^[0-9a-f]{64}$")
HEX_GIT_SHA = re.compile(r"^[0-9a-f]{40}$")
REQUIRED_APPROVAL_DECISIONS = (
    "djvulibre_binary_source_correspondence_reviewed",
    "djvulibre_gpl_distribution_obligations_reviewed",
    "rapidocr_model_redistribution_reviewed",
    "bundled_notices_and_source_offer_reviewed",
)
RAPIDOCR_MODELS = (
    "ch_PP-OCRv4_det_infer.onnx",
    "ch_PP-OCRv4_rec_infer.onnx",
    "ch_ppocr_mobile_v2.0_cls_infer.onnx",
)


class ComplianceGate:
    def __init__(self, *, mode: str) -> None:
        self.mode = mode
        self.checks: list[dict[str, Any]] = []
        self.failures: list[dict[str, str]] = []
        self.evidence: dict[str, Any] = {}

    def record(self, condition: bool, code: str, message: str) -> bool:
        self.checks.append({"code": code, "status": "PASS" if condition else "FAIL", "message": message})
        if not condition:
            self.failures.append({"code": code, "message": message})
        return condition

    def require_file(self, path: Path, code: str) -> Path | None:
        if self.record(path.is_file(), code, f"required file: {path}"):
            return path
        return None

    def result(self, *, public_approval: bool) -> dict[str, Any]:
        return {
            "status": "PASS" if not self.failures else "FAIL",
            "mode": self.mode,
            "public_release_license_approval": "GRANTED" if public_approval else "NOT_GRANTED",
            "checks": self.checks,
            "failures": self.failures,
            "evidence": self.evidence,
            "legal_assurance": "NOT_PROVIDED",
            "formal_release_authorization": "NOT_PROVIDED",
            "monetary_cost": 0,
        }


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for chunk in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def load_json(path: Path) -> dict[str, Any]:
    return json.loads(path.read_text(encoding="utf-8"))


def normalized_text(path: Path) -> str:
    return path.read_text(encoding="utf-8").replace("\r\n", "\n")


def validate_source(gate: ComplianceGate, root: Path = ROOT) -> dict[str, Any] | None:
    package_path = gate.require_file(root / "package.json", "SOURCE_PACKAGE_JSON")
    engine_project_path = gate.require_file(root / "engine" / "pyproject.toml", "SOURCE_ENGINE_PROJECT")
    license_path = gate.require_file(root / "LICENSE", "SOURCE_PROJECT_LICENSE")
    notices_path = gate.require_file(root / "THIRD_PARTY_NOTICES.md", "SOURCE_THIRD_PARTY_NOTICES")
    lock_path = gate.require_file(root / "scripts" / "native-dependencies.lock.json", "SOURCE_NATIVE_LOCK")
    builder_path = gate.require_file(root / "apps" / "desktop" / "electron-builder.yml", "SOURCE_BUILDER_CONFIG")
    manifest_script_path = gate.require_file(root / "scripts" / "generate-manifest.py", "SOURCE_MANIFEST_GENERATOR")
    release_verify_path = gate.require_file(root / "scripts" / "verify-release-chain.ps1", "SOURCE_RELEASE_VERIFY")
    inventory_path = gate.require_file(root / "licenses" / "manifest.json", "SOURCE_LICENSE_INVENTORY")
    approval_path = gate.require_file(APPROVAL_PATH, "SOURCE_PUBLIC_APPROVAL_RECORD")
    required = (
        package_path,
        engine_project_path,
        license_path,
        notices_path,
        lock_path,
        builder_path,
        manifest_script_path,
        release_verify_path,
        inventory_path,
        approval_path,
    )
    if any(path is None for path in required):
        return None

    package = load_json(package_path)
    engine_project = tomllib.loads(engine_project_path.read_text(encoding="utf-8"))
    project_license = normalized_text(license_path)
    notices = normalized_text(notices_path)
    native_lock = load_json(lock_path)
    builder = normalized_text(builder_path)
    manifest_script = normalized_text(manifest_script_path)
    release_verify = normalized_text(release_verify_path)
    inventory = load_json(inventory_path)
    approval = load_json(approval_path)

    gate.record(package.get("license") == "MIT", "SOURCE_ROOT_LICENSE_DECLARATION", "root package declares MIT")
    gate.record(
        engine_project.get("project", {}).get("license", {}).get("text") == "MIT",
        "SOURCE_ENGINE_LICENSE_DECLARATION",
        "engine project declares MIT",
    )
    gate.record(
        "MIT License" in project_license and "Copyright (c) 2026 ArchiveLens" in project_license,
        "SOURCE_MIT_TEXT",
        "root MIT text and project copyright are present",
    )

    required_notice_markers = (
        "DjVuLibre",
        "GPL-2.0",
        "djvulibre-3.5.29.tar.gz",
        "RapidOCR",
        "百度",
        "不构成法律意见",
        "licenses/Tesseract/LICENSE.txt",
    )
    gate.record(
        all(marker in notices for marker in required_notice_markers),
        "SOURCE_NOTICE_CONTENT",
        "third-party notices identify DjVuLibre, corresponding source, RapidOCR model ownership, and legal limits",
    )

    components = native_lock.get("components", {})
    djvu = components.get("djvulibre", {})
    gate.record(djvu.get("version") == "3.5.29+4.12", "SOURCE_DJVU_VERSION", "DjVuLibre version is locked")
    gate.record(djvu.get("license") == "GPL-2.0-only", "SOURCE_DJVU_LICENSE", "DjVuLibre license identifier is locked")
    gate.record(
        str(djvu.get("installer", {}).get("url", "")).startswith("https://downloads.sourceforge.net/"),
        "SOURCE_DJVU_BINARY_ORIGIN",
        "DjVuLibre Windows binary uses the locked SourceForge origin",
    )
    gate.record(
        str(djvu.get("source", {}).get("url", "")).startswith("https://downloads.sourceforge.net/"),
        "SOURCE_DJVU_SOURCE_ORIGIN",
        "DjVuLibre corresponding source uses the locked SourceForge origin",
    )
    for label, value in (
        ("installer", djvu.get("installer", {}).get("sha256", "")),
        ("source", djvu.get("source", {}).get("sha256", "")),
        ("runtime tree", djvu.get("runtime_tree_sha256", "")),
    ):
        gate.record(bool(HEX_SHA256.fullmatch(str(value))), f"SOURCE_DJVU_{label.upper().replace(' ', '_')}_HASH", f"DjVuLibre {label} SHA-256 is pinned")

    required_runtime = {
        "ddjvu.exe",
        "djvused.exe",
        "libdjvulibre.dll",
        "libjpeg.dll",
        "libtiff.dll",
        "libz.dll",
        "COPYING.txt",
    }
    gate.record(
        required_runtime.issubset(set(djvu.get("runtime_files", []))),
        "SOURCE_DJVU_RUNTIME_INVENTORY",
        "DjVuLibre executable, dependent DLL, and GPL text inventory is complete",
    )
    gate.record(
        "from: ../../LICENSE" in builder
        and "to: licenses/ArchiveLens/LICENSE.txt" in builder
        and "from: ../../THIRD_PARTY_NOTICES.md" in builder
        and "to: licenses/ArchiveLens/THIRD_PARTY_NOTICES.md" in builder
        and "to: licenses" in builder
        and "to: sources" in builder,
        "SOURCE_PACKAGING_LICENSE_FILES",
        "electron-builder packages project license, notices, native licenses, and corresponding source",
    )
    gate.record(
        "corresponding_source_url" in manifest_script
        and "corresponding_source_sha256" in manifest_script
        and "DjVuLibre/COPYING.txt" in manifest_script,
        "SOURCE_MANIFEST_LICENSE_EVIDENCE",
        "release manifest records DjVuLibre source and license evidence",
    )
    gate.record(
        "DjVuLibre corresponding source mismatch" in release_verify
        and "DjVuLibre\\COPYING.txt" in release_verify,
        "SOURCE_RELEASE_CHAIN_LICENSE_EVIDENCE",
        "release-chain verification checks DjVuLibre source and GPL text",
    )
    gate.record(
        inventory.get("schema_version") == 2
        and inventory.get("project", {}).get("license") == "MIT"
        and inventory.get("bundled", {}).get("djvulibre", {}).get("distribution") == "bundled",
        "SOURCE_LICENSE_INVENTORY_CURRENT",
        "license inventory reflects the current bundled runtime strategy",
    )
    gate.record(
        approval.get("schema_version") == 1
        and approval.get("scope") == "public-distribution-license-review"
        and set(REQUIRED_APPROVAL_DECISIONS).issubset(set(approval.get("decisions", {}))),
        "SOURCE_APPROVAL_SCHEMA",
        "public-release approval record is complete and fail-closed",
    )

    gate.evidence["native_lock"] = {
        "path": str(lock_path),
        "sha256": sha256(lock_path),
        "djvulibre_version": djvu.get("version"),
        "djvulibre_binary_sha256": djvu.get("installer", {}).get("sha256"),
        "djvulibre_source_sha256": djvu.get("source", {}).get("sha256"),
    }
    gate.evidence["approval_record"] = {
        "path": str(approval_path),
        "approved": bool(approval.get("approved")),
        "blockers": approval.get("blockers", []),
    }
    return approval


def validate_packaged(
    gate: ComplianceGate,
    resources_root: Path,
    *,
    candidate_sha: str | None,
) -> None:
    resources = resources_root.resolve()
    required_paths = {
        "PACKAGED_PROJECT_LICENSE": resources / "licenses" / "ArchiveLens" / "LICENSE.txt",
        "PACKAGED_PROJECT_NOTICES": resources / "licenses" / "ArchiveLens" / "THIRD_PARTY_NOTICES.md",
        "PACKAGED_APACHE_LICENSE": resources / "licenses" / "Tesseract" / "LICENSE.txt",
        "PACKAGED_TESSDATA_LICENSE": resources / "licenses" / "tessdata_fast" / "LICENSE.txt",
        "PACKAGED_DJVU_LICENSE": resources / "licenses" / "DjVuLibre" / "COPYING.txt",
        "PACKAGED_NATIVE_LOCK": resources / "native-dependencies.lock.json",
        "PACKAGED_DESKTOP_INFO": resources / "app.info.json",
        "PACKAGED_ENGINE_INFO": resources / "engine" / "win-x64" / "app.info.json",
    }
    present: dict[str, Path] = {}
    for code, path in required_paths.items():
        found = gate.require_file(path, code)
        if found is not None:
            present[code] = found

    if "PACKAGED_NATIVE_LOCK" not in present:
        return
    packaged_lock = load_json(present["PACKAGED_NATIVE_LOCK"])
    source_lock = load_json(ROOT / "scripts" / "native-dependencies.lock.json")
    gate.record(packaged_lock == source_lock, "PACKAGED_LOCK_MATCH", "packaged native lock matches source")
    djvu = packaged_lock["components"]["djvulibre"]
    source_archive = resources / "sources" / "djvulibre" / djvu["source"]["file_name"]
    if gate.require_file(source_archive, "PACKAGED_DJVU_SOURCE") is not None:
        gate.record(
            sha256(source_archive) == djvu["source"]["sha256"],
            "PACKAGED_DJVU_SOURCE_HASH",
            "packaged DjVuLibre corresponding source matches the locked SHA-256",
        )

    if "PACKAGED_PROJECT_LICENSE" in present:
        gate.record(
            normalized_text(present["PACKAGED_PROJECT_LICENSE"]) == normalized_text(ROOT / "LICENSE"),
            "PACKAGED_PROJECT_LICENSE_MATCH",
            "packaged ArchiveLens license matches source",
        )
    if "PACKAGED_PROJECT_NOTICES" in present:
        gate.record(
            normalized_text(present["PACKAGED_PROJECT_NOTICES"]) == normalized_text(ROOT / "THIRD_PARTY_NOTICES.md"),
            "PACKAGED_PROJECT_NOTICES_MATCH",
            "packaged third-party notices match source",
        )
    if "PACKAGED_APACHE_LICENSE" in present:
        gate.record(
            "Apache License" in normalized_text(present["PACKAGED_APACHE_LICENSE"]),
            "PACKAGED_APACHE_TEXT",
            "a full Apache-2.0 license text is distributed for Apache-licensed components",
        )
    if "PACKAGED_DJVU_LICENSE" in present:
        gate.record(
            "GNU GENERAL PUBLIC LICENSE" in normalized_text(present["PACKAGED_DJVU_LICENSE"]),
            "PACKAGED_GPL_TEXT",
            "the DjVuLibre GPL text is distributed",
        )

    engine_root = resources / "engine" / "win-x64"
    model_inventory: list[dict[str, Any]] = []
    for model_name in RAPIDOCR_MODELS:
        matches = [path for path in engine_root.rglob(model_name) if path.is_file()]
        gate.record(len(matches) == 1, f"PACKAGED_MODEL_{model_name}", f"exactly one packaged RapidOCR model: {model_name}")
        if len(matches) == 1:
            model_inventory.append(
                {
                    "file": str(matches[0].relative_to(engine_root)).replace("\\", "/"),
                    "size": matches[0].stat().st_size,
                    "sha256": sha256(matches[0]),
                }
            )
    onnx_license = [path for path in engine_root.rglob("LICENSE") if "onnxruntime" in str(path).lower()]
    onnx_notices = [path for path in engine_root.rglob("ThirdPartyNotices.txt") if "onnxruntime" in str(path).lower()]
    gate.record(bool(onnx_license), "PACKAGED_ONNXRUNTIME_LICENSE", "ONNX Runtime license is bundled")
    gate.record(bool(onnx_notices), "PACKAGED_ONNXRUNTIME_NOTICES", "ONNX Runtime third-party notices are bundled")

    if candidate_sha is not None:
        gate.record(bool(HEX_GIT_SHA.fullmatch(candidate_sha)), "PACKAGED_CANDIDATE_SHA_FORMAT", "candidate SHA is a full Git SHA")
        for code, label in (
            ("PACKAGED_DESKTOP_INFO", "desktop"),
            ("PACKAGED_ENGINE_INFO", "engine"),
        ):
            if code in present:
                info = load_json(present[code])
                gate.record(
                    info.get("git_commit") == candidate_sha,
                    f"PACKAGED_{label.upper()}_SHA",
                    f"packaged {label} metadata matches candidate SHA",
                )

    gate.evidence["packaged_resources"] = str(resources)
    gate.evidence["rapidocr_models"] = model_inventory
    gate.evidence["djvulibre_corresponding_source"] = {
        "file": str(source_archive),
        "sha256": sha256(source_archive) if source_archive.is_file() else None,
    }


def validate_public_approval(
    gate: ComplianceGate,
    approval_path: Path,
    *,
    candidate_sha: str | None,
) -> bool:
    if not gate.record(candidate_sha is not None, "PUBLIC_CANDIDATE_SHA_REQUIRED", "public approval requires a candidate SHA"):
        return False
    assert candidate_sha is not None
    gate.record(bool(HEX_GIT_SHA.fullmatch(candidate_sha)), "PUBLIC_CANDIDATE_SHA_FORMAT", "public candidate uses a full Git SHA")
    if gate.require_file(approval_path, "PUBLIC_APPROVAL_RECORD") is None:
        return False
    approval = load_json(approval_path)
    gate.record(approval.get("approved") is True, "PUBLIC_RELEASE_APPROVAL_REQUIRED", "license approval is explicitly granted")
    gate.record(
        approval.get("candidate_sha") == candidate_sha,
        "PUBLIC_APPROVAL_SHA_MATCH",
        "license approval is bound to the frozen candidate SHA",
    )
    gate.record(bool(str(approval.get("reviewer", "")).strip()), "PUBLIC_APPROVAL_REVIEWER", "license reviewer is recorded")
    reviewed_at = str(approval.get("reviewed_at", "")).strip()
    valid_reviewed_at = False
    if reviewed_at:
        try:
            datetime.fromisoformat(reviewed_at.replace("Z", "+00:00"))
            valid_reviewed_at = True
        except ValueError:
            valid_reviewed_at = False
    gate.record(valid_reviewed_at, "PUBLIC_APPROVAL_TIME", "license review timestamp is valid ISO-8601")
    gate.record(
        approval.get("technical_evidence_reviewed") is True,
        "PUBLIC_TECHNICAL_EVIDENCE_REVIEWED",
        "technical evidence is explicitly reviewed",
    )
    decisions = approval.get("decisions", {})
    for decision in REQUIRED_APPROVAL_DECISIONS:
        gate.record(decisions.get(decision) is True, f"PUBLIC_DECISION_{decision.upper()}", f"approved decision: {decision}")
    gate.record(approval.get("blockers") == [], "PUBLIC_LICENSE_BLOCKERS_EMPTY", "license blocker list is empty")
    return not gate.failures


def run_gate(
    *,
    mode: str,
    resources_root: Path | None = None,
    candidate_sha: str | None = None,
    require_public_approval: bool = False,
    approval_path: Path = APPROVAL_PATH,
) -> dict[str, Any]:
    candidate_sha = candidate_sha.lower() if candidate_sha else None
    gate = ComplianceGate(mode=mode)
    approval = validate_source(gate)
    if mode == "packaged":
        if resources_root is None:
            gate.record(False, "PACKAGED_RESOURCES_REQUIRED", "packaged mode requires --resources-root")
        else:
            validate_packaged(gate, resources_root, candidate_sha=candidate_sha)
    public_approval = bool(approval and approval.get("approved"))
    if require_public_approval:
        public_approval = validate_public_approval(gate, approval_path, candidate_sha=candidate_sha)
    return gate.result(public_approval=public_approval)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--mode", choices=("source", "packaged"), required=True)
    parser.add_argument("--resources-root", type=Path)
    parser.add_argument("--candidate-sha")
    parser.add_argument("--require-public-approval", action="store_true")
    parser.add_argument("--approval-path", type=Path, default=APPROVAL_PATH)
    args = parser.parse_args()
    result = run_gate(
        mode=args.mode,
        resources_root=args.resources_root,
        candidate_sha=args.candidate_sha,
        require_public_approval=args.require_public_approval,
        approval_path=args.approval_path,
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    return 0 if result["status"] == "PASS" else 1


if __name__ == "__main__":
    sys.exit(main())
