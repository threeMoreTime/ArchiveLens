"""生成 build-manifest.json（任务 §二十五，同一候选 SHA 的证据链）。"""
from __future__ import annotations

import hashlib
import json
import platform
import subprocess
from datetime import datetime, timezone
from pathlib import Path

ROOT = Path(__file__).resolve().parents[1]
ENGINE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
RELEASE = ROOT / "apps" / "desktop" / "release"
UNPACKED = RELEASE / "win-unpacked" / "ArchiveLens.exe"


def sha256(p: Path) -> str:
    return hashlib.sha256(p.read_bytes()).hexdigest()


def cmd(c: list[str]) -> str:
    return subprocess.run(c, capture_output=True, text=True).stdout.strip()


def find(pattern: str) -> Path:
    matches = sorted(RELEASE.glob(pattern))
    if not matches:
        raise FileNotFoundError(pattern)
    return matches[0]


commit = cmd(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
manifest = {
    "version": "0.1.0-alpha.7",
    "git_commit": commit,
    "build_time": datetime.now(timezone.utc).isoformat(),
    "engine_sha256": sha256(ENGINE),
    "desktop_sha256": sha256(UNPACKED) if UNPACKED.exists() else None,
    "setup_sha256": sha256(find("*alpha.7*x64-setup.exe")),
    "portable_sha256": sha256(find("*alpha.7*x64-portable.exe")),
    "python_version": platform.python_version(),
    "node_version": cmd(["node", "--version"]),
    "electron_version": "31.4.0",
    "protocol_version": 1,
}
out = RELEASE / "build-manifest.json"
out.write_text(json.dumps(manifest, ensure_ascii=False, indent=2), encoding="utf-8")
print(json.dumps(manifest, ensure_ascii=False, indent=2))
