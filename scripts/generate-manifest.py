"""生成 release manifest / SHA256SUMS。"""

from __future__ import annotations

import argparse
import hashlib
import json
import platform
import subprocess
from pathlib import Path


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_RELEASE_DIR = ROOT / "apps" / "desktop" / "release"
DEFAULT_ENGINE = ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe"
DEFAULT_DESKTOP = DEFAULT_RELEASE_DIR / "win-unpacked" / "ArchiveLens.exe"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cmd(args: list[str]) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()


def resolve_existing(path: Path) -> Path:
    if not path.exists():
        raise FileNotFoundError(path)
    return path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--version", required=True)
    parser.add_argument("--candidate-sha")
    parser.add_argument("--release-dir", type=Path, default=DEFAULT_RELEASE_DIR)
    parser.add_argument("--engine", type=Path, default=DEFAULT_ENGINE)
    parser.add_argument("--desktop", type=Path, default=DEFAULT_DESKTOP)
    parser.add_argument("--setup", type=Path)
    parser.add_argument("--portable", type=Path)
    parser.add_argument("--allow-partial", action="store_true")
    parser.add_argument("--output", type=Path, default=DEFAULT_RELEASE_DIR / "release-manifest.json")
    parser.add_argument("--sha256sums", type=Path, default=DEFAULT_RELEASE_DIR / "SHA256SUMS.txt")
    parser.add_argument("--test-summary-json", type=Path)
    args = parser.parse_args()

    candidate_sha = args.candidate_sha or cmd(["git", "-C", str(ROOT), "rev-parse", "HEAD"])
    release_dir = args.release_dir.resolve()
    engine = resolve_existing(args.engine.resolve())
    desktop = resolve_existing(args.desktop.resolve())

    def resolve_optional(path: Path) -> Path | None:
        return path.resolve() if path.exists() else None

    default_setup = (args.setup or (release_dir / f"ArchiveLens-{args.version}-x64-setup.exe")).resolve()
    default_portable = (args.portable or (release_dir / f"ArchiveLens-{args.version}-x64-portable.exe")).resolve()
    setup = resolve_optional(default_setup)
    portable = resolve_optional(default_portable)
    if not args.allow_partial:
        if setup is None:
            raise FileNotFoundError(default_setup)
        if portable is None:
            raise FileNotFoundError(default_portable)

    test_summary: dict[str, object] = {}
    if args.test_summary_json and args.test_summary_json.exists():
        test_summary = json.loads(args.test_summary_json.read_text(encoding="utf-8"))

    manifest = {
        "version": args.version,
        "git_commit": candidate_sha,
        "engine_sha256": sha256(engine),
        "desktop_sha256": sha256(desktop),
        "build_environment": {
            "platform": platform.platform(),
            "python_version": platform.python_version(),
            "node_version": cmd(["node", "--version"]),
            "electron_version": json.loads((ROOT / "apps" / "desktop" / "package.json").read_text(encoding="utf-8"))[
                "devDependencies"
            ]["electron"].lstrip("^"),
            "protocol_version": 1,
        },
        "test_summary": test_summary,
    }
    if setup is not None:
        manifest["setup_sha256"] = sha256(setup)
    if portable is not None:
        manifest["portable_sha256"] = sha256(portable)

    args.output.parent.mkdir(parents=True, exist_ok=True)
    args.output.write_text(json.dumps(manifest, ensure_ascii=False, indent=2) + "\n", encoding="utf-8")

    sha_lines = [
        f"{manifest['engine_sha256']}  {engine.name}",
        f"{manifest['desktop_sha256']}  {desktop.name}",
    ]
    if setup is not None:
        sha_lines.append(f"{manifest['setup_sha256']}  {setup.name}")
    if portable is not None:
        sha_lines.append(f"{manifest['portable_sha256']}  {portable.name}")
    args.sha256sums.write_text("\n".join(sha_lines) + "\n", encoding="utf-8")

    print(json.dumps({"manifest": str(args.output), "sha256sums": str(args.sha256sums), "data": manifest}, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
