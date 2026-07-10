"""Generate deterministic image-only PDF fixtures for real OCR validation."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import platform
from pathlib import Path
from typing import Any

import PIL
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUT = ROOT / "tests" / "fixtures" / "ocr"
DEFAULT_FONT = Path(os.environ.get("ARCHIVELENS_FIXTURE_FONT", r"C:\Windows\Fonts\simhei.ttf"))
FONT_SHA256 = "9b1959db3b3abeb7efdaec26edf7dfe871a6039de8d614af7248575207be629e"
FONT_NAME = "SimHei"
FONT_VERSION = "5.05"
FONT_LICENSE_NOTE = "Windows system font; the font program is not redistributed. Fixtures contain rasterized glyph images only."
PAGE_SIZE = (1200, 1600)
FONT_SIZE = 96
PAGE_DPI = 144.0
TEXT_ORIGIN = (120, 180)
LINE_SPACING = 150
FIXED_PDF_DATE = "D:20260710000000Z"


LEGACY_DOCUMENTS: list[tuple[str, list[list[str]]]] = [
    (
        "simplified-horizontal.pdf",
        [["双方应按照本协议约定期限完成交付", "约定不明者从俗", "其数量大约为三百石"]],
    ),
    (
        "traditional-horizontal.pdf",
        [["立約各方應誠實守信", "契約存於檔案庫中", "歲約絹帛若干"]],
    ),
    (
        "mixed-multipage.pdf",
        [["简体：约定 纄定", "繁体：約定"], ["第二页 约 與 約 共存"]],
    ),
    ("rotated-page.pdf", [["旋转页 约 約"]]),
    ("中文 空格 # %.pdf", [["中文文件名 含空格与#%", "约 約"]]),
]


CASES: list[dict[str, Any]] = [
    {
        "id": "custom-single",
        "file": "custom-single.pdf",
        "pages": [["档"]],
        "search_text": "档",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "档", "page_number": 1, "match_start": 0, "match_end": 1}],
    },
    {
        "id": "custom-double",
        "file": "custom-double.pdf",
        "pages": [["档案"]],
        "search_text": "档案",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "档案", "page_number": 1, "match_start": 0, "match_end": 2}],
    },
    {
        "id": "custom-multi",
        "file": "custom-multi.pdf",
        "pages": [["档案管理"]],
        "search_text": "档案管理",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "档案管理", "page_number": 1, "match_start": 0, "match_end": 4}],
    },
    {
        "id": "custom-repeat",
        "file": "custom-repeat.pdf",
        "pages": [["档案档案"]],
        "search_text": "档案",
        "expected_count": 2,
        "expected_matches": [
            {"matched_text": "档案", "page_number": 1, "match_start": 0, "match_end": 2},
            {"matched_text": "档案", "page_number": 1, "match_start": 2, "match_end": 4},
        ],
    },
    {
        "id": "custom-english",
        "file": "custom-english.pdf",
        "pages": [["ArchiveLens"]],
        "search_text": "ArchiveLens",
        "expected_count": 1,
        "expected_matches": [
            {"matched_text": "ArchiveLens", "page_number": 1, "match_start": 0, "match_end": 11}
        ],
    },
    {
        "id": "custom-special",
        "file": "custom-special.pdf",
        "pages": [["A&B"]],
        "search_text": "A&B",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "A&B", "page_number": 1, "match_start": 0, "match_end": 3}],
    },
    {
        "id": "custom-english-case-sensitive",
        "file": "custom-english.pdf",
        "pages": [["ArchiveLens"]],
        "search_text": "archivelens",
        "expected_count": 0,
        "expected_matches": [],
    },
    {
        "id": "custom-no-hit",
        "file": "custom-no-hit.pdf",
        "pages": [["档案管理"]],
        "search_text": "不存在",
        "expected_count": 0,
        "expected_matches": [],
    },
    {
        "id": "custom-cross-line",
        "file": "custom-cross-line.pdf",
        "pages": [["档", "", "", "", "案"]],
        "search_text": "档案",
        "expected_count": 0,
        "expected_matches": [],
    },
    {
        "id": "legacy-pair-simplified",
        "file": "legacy-pair.pdf",
        "pages": [["约 約"]],
        "search_text": "约",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "约", "page_number": 1, "match_start": 0, "match_end": 1}],
    },
    {
        "id": "legacy-pair-traditional",
        "file": "legacy-pair.pdf",
        "pages": [["约 約"]],
        "search_text": "約",
        "expected_count": 1,
        "expected_matches": [{"matched_text": "約", "page_number": 1, "match_start": 1, "match_end": 2}],
    },
]


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def validate_font(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"fixture font missing: {path}")
    actual = sha256(path)
    if actual != FONT_SHA256:
        raise RuntimeError(f"fixture font hash mismatch: expected={FONT_SHA256} actual={actual} path={path}")


def make_pdf(out_dir: Path, font: ImageFont.FreeTypeFont, name: str, pages: list[list[str]]) -> Path:
    images: list[Image.Image] = []
    for lines in pages:
        image = Image.new("RGB", PAGE_SIZE, "white")
        draw = ImageDraw.Draw(image)
        x, y = TEXT_ORIGIN
        for line in lines:
            draw.text((x, y), line, fill="black", font=font)
            y += LINE_SPACING
        images.append(image)
    output = out_dir / name
    images[0].save(
        output,
        "PDF",
        save_all=True,
        append_images=images[1:],
        resolution=PAGE_DPI,
        title=Path(name).stem,
        author="ArchiveLens",
        creator="ArchiveLens deterministic OCR fixture generator",
        producer=f"Pillow {PIL.__version__}",
        creationDate=FIXED_PDF_DATE,
        modDate=FIXED_PDF_DATE,
    )
    return output


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUT)
    parser.add_argument("--font-path", type=Path, default=DEFAULT_FONT)
    args = parser.parse_args()

    validate_font(args.font_path)
    args.output_dir.mkdir(parents=True, exist_ok=True)
    font = ImageFont.truetype(str(args.font_path), FONT_SIZE)

    for name, pages in LEGACY_DOCUMENTS:
        make_pdf(args.output_dir, font, name, pages)

    generated: dict[str, Path] = {}
    for case in CASES:
        if case["file"] not in generated:
            generated[case["file"]] = make_pdf(args.output_dir, font, case["file"], case["pages"])

    cases = []
    for case in CASES:
        public_case = {key: value for key, value in case.items() if key != "pages"}
        public_case["source_lines"] = case["pages"]
        public_case["sha256"] = sha256(generated[case["file"]])
        cases.append(public_case)

    manifest = {
        "schema_version": 2,
        "generator": {
            "script": "scripts/generate-ocr-fixtures.py",
            "python_version": platform.python_version(),
            "pillow_version": PIL.__version__,
            "font": {
                "name": FONT_NAME,
                "version": FONT_VERSION,
                "file_name": args.font_path.name,
                "sha256": FONT_SHA256,
                "license_note": FONT_LICENSE_NOTE,
                "redistributed": False,
            },
            "page_size": list(PAGE_SIZE),
            "page_dpi": PAGE_DPI,
            "font_size": FONT_SIZE,
            "text_origin": list(TEXT_ORIGIN),
            "line_spacing": LINE_SPACING,
            "pdf_date": FIXED_PDF_DATE,
        },
        "legacy_documents": [
            {"file": name, "sha256": sha256(args.output_dir / name)} for name, _pages in LEGACY_DOCUMENTS
        ],
        "cases": cases,
    }
    (args.output_dir / "expected.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[PASS] fixtures generated: {args.output_dir}")


if __name__ == "__main__":
    main()
