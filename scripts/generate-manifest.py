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
DEFAULT_NATIVE_ROOT = ROOT / "dist" / "native" / "win-x64"


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def cmd(args: list[str]) -> str:
    return subprocess.run(args, capture_output=True, text=True, check=True).stdout.strip()


def file_manifest(root: Path) -> list[dict[str, object]]:
    return [
        {
            "path": path.relative_to(root).as_posix(),
            "sha256": sha256(path),
            "bytes": path.stat().st_size,
        }
        for path in sorted(candidate for candidate in root.rglob("*") if candidate.is_file())
    ]


def tree_sha256(root: Path) -> str:
    lines = [f"{entry['path'].lower()}\t{entry['sha256']}" for entry in file_manifest(root)]
    return hashlib.sha256(("\n".join(lines) + "\n").encode("utf-8")).hexdigest()


def notice_manifest(native_root: Path, relative_paths: tuple[str, ...]) -> list[dict[str, object]]:
    notices: list[dict[str, object]] = []
    for relative in relative_paths:
        path = resolve_existing(native_root / "licenses" / relative)
        notices.append({"path": relative, "sha256": sha256(path), "bytes": path.stat().st_size})
    return notices


def native_dependencies(native_root: Path) -> tuple[str, list[dict[str, object]]]:
    lock_path = resolve_existing(native_root / "native-dependencies.lock.json")
    lock = json.loads(lock_path.read_text(encoding="utf-8-sig"))
    components = lock["components"]
    tesseract_root = resolve_existing(native_root / "tesseract")
    djvulibre_root = resolve_existing(native_root / "djvulibre")
    tesseract_tree = tree_sha256(tesseract_root)
    djvulibre_tree = tree_sha256(djvulibre_root)
    if tesseract_tree != components["tesseract"]["runtime_tree_sha256"]:
        raise ValueError("Tesseract runtime tree does not match native dependency lock")
    if djvulibre_tree != components["djvulibre"]["runtime_tree_sha256"]:
        raise ValueError("DjVuLibre runtime tree does not match native dependency lock")

    tessdata_files: list[dict[str, object]] = []
    for locked_file in components["tessdata_fast"]["files"]:
        path = resolve_existing(tesseract_root / "tessdata" / locked_file["file_name"])
        actual = sha256(path)
        if actual != locked_file["sha256"]:
            raise ValueError(f"tessdata file does not match lock: {path.name}")
        tessdata_files.append({"path": f"tessdata/{path.name}", "sha256": actual, "bytes": path.stat().st_size})

    djvu_source = resolve_existing(native_root / "sources" / "djvulibre" / components["djvulibre"]["source"]["file_name"])
    if sha256(djvu_source) != components["djvulibre"]["source"]["sha256"]:
        raise ValueError("DjVuLibre corresponding source archive does not match lock")
    tesseract_notices = notice_manifest(
        native_root,
        (
            "Tesseract/LICENSE.txt",
            "Tesseract-Windows-Build/AUTHORS.txt",
            "Tesseract-Windows-Build/BUILD-README.md",
        ),
    )
    tessdata_notices = notice_manifest(native_root, ("tessdata_fast/LICENSE.txt",))
    djvu_notices = notice_manifest(native_root, ("DjVuLibre/COPYING.txt",))

    return sha256(lock_path), [
        {
            "name": "tesseract",
            "version": components["tesseract"]["version"],
            "license": components["tesseract"]["license"],
            "source_url": components["tesseract"]["installer"]["url"],
            "source_sha256": components["tesseract"]["installer"]["sha256"],
            "runtime_tree_sha256": tesseract_tree,
            "runtime_files": file_manifest(tesseract_root),
            "license_files": tesseract_notices,
        },
        {
            "name": "tessdata_fast",
            "version": components["tessdata_fast"]["version"],
            "license": components["tessdata_fast"]["license"],
            "source_url": components["tessdata_fast"]["base_url"],
            "runtime_files": tessdata_files,
            "license_files": tessdata_notices,
        },
        {
            "name": "djvulibre",
            "version": components["djvulibre"]["version"],
            "license": components["djvulibre"]["license"],
            "source_url": components["djvulibre"]["installer"]["url"],
            "source_sha256": components["djvulibre"]["installer"]["sha256"],
            "corresponding_source_url": components["djvulibre"]["source"]["url"],
            "corresponding_source_sha256": components["djvulibre"]["source"]["sha256"],
            "runtime_tree_sha256": djvulibre_tree,
            "runtime_files": file_manifest(djvulibre_root),
            "license_files": djvu_notices,
        },
    ]


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
    parser.add_argument("--native-root", type=Path, default=DEFAULT_NATIVE_ROOT)
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

    native_lock_sha256, bundled_native_dependencies = native_dependencies(args.native_root.resolve())
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
            "protocol_version": 4,
        },
        "test_summary": test_summary,
        "native_lock_sha256": native_lock_sha256,
        "native_dependencies": bundled_native_dependencies,
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
