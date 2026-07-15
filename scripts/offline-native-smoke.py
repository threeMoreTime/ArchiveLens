"""Validate bundled native tools and every supported document format without host tools."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import subprocess
import sys
import tempfile
from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
ENGINE_SRC = ROOT / "engine" / "src"
if str(ENGINE_SRC) not in sys.path:
    sys.path.insert(0, str(ENGINE_SRC))

from archivelens_engine.config import EngineConfig  # noqa: E402
from archivelens_engine.diagnostics import CHECK_PASS, detect_all  # noqa: E402
from archivelens_engine.documents.backends import DocumentBackendRegistry  # noqa: E402


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def run_checked(command: list[str], env: dict[str, str]) -> str:
    result = subprocess.run(
        command,
        check=True,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        timeout=120,
        env=env,
        shell=False,
    )
    return (result.stdout or result.stderr).strip()


def run_packaged_diagnostics(resources: Path, env: dict[str, str]) -> dict[str, object] | None:
    engine = resources / "engine" / "win-x64" / "archivelens-engine.exe"
    if not engine.is_file():
        return None
    request = json.dumps(
        {"protocol_version": 2, "request_id": "offline-native-diagnostics", "method": "diagnostics.run", "params": {}},
        ensure_ascii=False,
    )
    with tempfile.TemporaryDirectory(prefix="archivelens-offline-diagnostics-") as workspace:
        engine_env = {
            **env,
            "AL_TESSERACT_CMD": str(resources / "native" / "tesseract" / "tesseract.exe"),
            "AL_TESSDATA_DIR": str(resources / "native" / "tesseract" / "tessdata"),
            "AL_DJVU_BIN_DIR": str(resources / "native" / "djvulibre"),
            "AL_NATIVE_SOURCE": "bundled",
            "AL_WORKSPACE_ROOT": workspace,
            "PYTHONIOENCODING": "utf-8",
            "PYTHONUNBUFFERED": "1",
        }
        result = subprocess.run(
            [str(engine), "serve"],
            input=request + "\n",
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            timeout=120,
            env=engine_env,
            shell=False,
        )
    messages = []
    for line in result.stdout.splitlines():
        try:
            messages.append(json.loads(line))
        except json.JSONDecodeError:
            continue
    response = next((message for message in messages if message.get("request_id") == "offline-native-diagnostics"), None)
    if response is None or not response.get("ok"):
        raise RuntimeError(f"packaged diagnostics failed: response={response} stderr={result.stderr[-1000:]}")
    diagnostics = response["result"]
    checks = {entry["key"]: entry for entry in diagnostics["checks"]}
    for key in ("tesseract", "djvulibre", "lang_simplified", "lang_traditional", "raster_formats"):
        if checks[key]["status"] != CHECK_PASS:
            raise RuntimeError(f"packaged diagnostic failed: {key}={checks[key]}")
        if key != "raster_formats" and checks[key]["extra"].get("source") != "bundled":
            raise RuntimeError(f"packaged diagnostic source mismatch: {key}={checks[key]}")
    return diagnostics


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--resources-root",
        type=Path,
        default=ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "resources",
    )
    parser.add_argument("--fixtures", type=Path, default=ROOT / "tests" / "fixtures" / "offline-formats")
    args = parser.parse_args()
    resources = args.resources_root.resolve()
    fixtures = args.fixtures.resolve()
    native = resources / "native" if (resources / "native").is_dir() else resources
    tesseract = native / "tesseract" / "tesseract.exe"
    tessdata = native / "tesseract" / "tessdata"
    djvu = native / "djvulibre"
    for required in (
        tesseract,
        tessdata / "chi_sim.traineddata",
        tessdata / "chi_tra.traineddata",
        tessdata / "chi_sim_vert.traineddata",
        tessdata / "chi_tra_vert.traineddata",
        djvu / "ddjvu.exe",
        djvu / "djvused.exe",
    ):
        if not required.is_file():
            raise FileNotFoundError(required)

    manifest = json.loads((fixtures / "expected.json").read_text(encoding="utf-8"))
    expected_pages: dict[str, int] = {}
    for entry in manifest["files"]:
        fixture = fixtures / entry["file"]
        if sha256(fixture) != entry["sha256"]:
            raise RuntimeError(f"fixture hash mismatch: {fixture.name}")
        expected_pages[entry["file"]] = int(entry["pages"])

    system_root = os.environ.get("SystemRoot", r"C:\Windows")
    isolated_env = {
        "SystemRoot": system_root,
        "WINDIR": system_root,
        "PATH": str(Path(system_root) / "System32"),
        "TESSDATA_PREFIX": str(tessdata),
    }
    version = run_checked([str(tesseract), "--version"], isolated_env).splitlines()[0]
    languages = set(run_checked([str(tesseract), "--tessdata-dir", str(tessdata), "--list-langs"], isolated_env).splitlines())
    required_languages = {"chi_sim", "chi_tra", "chi_sim_vert", "chi_tra_vert"}
    if not required_languages.issubset(languages):
        raise RuntimeError(f"bundled Tesseract languages missing: {sorted(required_languages - languages)}")

    config = EngineConfig(
        tesseract_cmd=tesseract,
        tessdata_dir=tessdata,
        djvu_bin_dir=djvu,
        native_source="bundled",
    )
    diagnostics = detect_all(config=config)
    checks = {entry["key"]: entry for entry in diagnostics["checks"]}
    for key in ("tesseract", "djvulibre", "lang_simplified", "lang_traditional", "raster_formats"):
        if checks[key]["status"] != CHECK_PASS:
            raise RuntimeError(f"bundled diagnostic failed: {key}={checks[key]}")

    registry = DocumentBackendRegistry(config)
    rendered_pages = 0
    for name, page_count in expected_pages.items():
        fixture = fixtures / name
        actual_pages = registry.page_count(fixture)
        if actual_pages != page_count:
            raise RuntimeError(f"page count mismatch: {name} actual={actual_pages} expected={page_count}")
        for page_index in range(page_count):
            rendered = registry.render_page(fixture, page_index, 150)
            try:
                with Image.open(rendered) as image:
                    image.load()
                    if image.width < 1 or image.height < 1:
                        raise RuntimeError(f"empty rendered page: {name}#{page_index + 1}")
            finally:
                rendered.unlink(missing_ok=True)
            rendered_pages += 1

    ocr_cases = (
        (fixtures / "simplified-horizontal.png", "chi_sim", "编号"),
        (fixtures / "traditional-horizontal.jpg", "chi_tra", "編號"),
    )
    ocr_results: dict[str, str] = {}
    for fixture, language, expected_text in ocr_cases:
        output = run_checked(
            [str(tesseract), str(fixture), "stdout", "--tessdata-dir", str(tessdata), "-l", language, "--psm", "6"],
            isolated_env,
        )
        compact = "".join(output.split())
        if expected_text not in compact:
            raise RuntimeError(f"Tesseract {language} did not recognize {expected_text!r}: {output!r}")
        ocr_results[language] = compact

    packaged_diagnostics = run_packaged_diagnostics(resources, isolated_env)

    print(
        json.dumps(
            {
                "status": "PASS",
                "resources_root": str(resources),
                "tesseract_version": version,
                "languages": sorted(required_languages),
                "documents": len(expected_pages),
                "rendered_pages": rendered_pages,
                "ocr_results": ocr_results,
                "host_path_isolated": True,
                "packaged_engine_diagnostics": "PASS" if packaged_diagnostics is not None else "NOT_APPLICABLE",
            },
            ensure_ascii=False,
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
