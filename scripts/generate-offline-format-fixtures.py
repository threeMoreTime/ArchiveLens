"""Generate redistributable synthetic fixtures for the offline native runtime smoke test."""

from __future__ import annotations

import argparse
import hashlib
import io
import json
import os
import platform
import shutil
import subprocess
import tempfile
from pathlib import Path

import PIL
from PIL import Image, ImageDraw, ImageFont


ROOT = Path(__file__).resolve().parents[1]
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "offline-formats"
DEFAULT_FONT = Path(os.environ.get("ARCHIVELENS_FIXTURE_FONT", r"C:\Windows\Fonts\simhei.ttf"))
FONT_SHA256 = "9b1959db3b3abeb7efdaec26edf7dfe871a6039de8d614af7248575207be629e"
PAGE_SIZE = (1240, 1754)
PAGE_DPI = (150, 150)
FONT_SIZE = 82
HEADER_FONT_SIZE = 44
FOOTER_FONT_SIZE = 38
HORIZONTAL_SIMPLIFIED = "本馆清册卷宗依次编号"
HORIZONTAL_TRADITIONAL = "本館清冊卷宗依次編號"
VERTICAL_TRADITIONAL = "本館清冊卷宗依次編號"


def sha256(path: Path) -> str:
    return hashlib.sha256(path.read_bytes()).hexdigest()


def check_font(path: Path) -> None:
    if not path.is_file():
        raise FileNotFoundError(f"fixture font is missing: {path}")
    actual = sha256(path)
    if actual != FONT_SHA256:
        raise RuntimeError(f"fixture font hash mismatch: actual={actual} expected={FONT_SHA256}")


def draw_page(
    body_font: ImageFont.FreeTypeFont,
    header_font: ImageFont.FreeTypeFont,
    footer_font: ImageFont.FreeTypeFont,
    text: str,
    *,
    vertical: bool = False,
) -> Image.Image:
    image = Image.new("RGB", PAGE_SIZE, "#f8f1df")
    draw = ImageDraw.Draw(image)
    draw.rectangle((70, 70, PAGE_SIZE[0] - 70, PAGE_SIZE[1] - 70), outline="#92754c", width=4)
    draw.text((120, 130), "ArchiveLens 匿名仿古档案样本", fill="#4b3825", font=header_font)
    if vertical:
        x, y = 930, 350
        for character in text:
            draw.text((x, y), character, fill="#17120d", font=body_font)
            y += 105
    else:
        draw.text((150, 620), text, fill="#17120d", font=body_font)
    draw.text((120, 1510), "仅用于离线格式与中文识别测试", fill="#59462e", font=footer_font)
    return image


def write_image_formats(output: Path, pages: list[Image.Image]) -> None:
    pages[0].save(output / "simplified-horizontal.png", "PNG", dpi=PAGE_DPI)
    pages[1].save(output / "traditional-horizontal.jpg", "JPEG", quality=94, subsampling=0, dpi=PAGE_DPI)
    pages[0].save(
        output / "multipage.tiff",
        "TIFF",
        save_all=True,
        append_images=[pages[2]],
        compression="tiff_lzw",
        dpi=PAGE_DPI,
    )


def write_pdf(output: Path, pages: list[Image.Image]) -> None:
    pdf_path = output / "synthetic-archive.pdf"
    page_width = PAGE_SIZE[0] * 72 / PAGE_DPI[0]
    page_height = PAGE_SIZE[1] * 72 / PAGE_DPI[1]
    objects: list[bytes] = []

    objects.append(b"<< /Type /Catalog /Pages 2 0 R >>")
    page_refs = " ".join(f"{3 + index * 3} 0 R" for index in range(2))
    objects.append(f"<< /Type /Pages /Kids [{page_refs}] /Count 2 >>".encode("ascii"))

    for index, image in enumerate(pages[:2]):
        page_object = 3 + index * 3
        image_object = page_object + 1
        content_object = page_object + 2
        objects.append(
            (
                f"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 {page_width:.2f} {page_height:.2f}] "
                f"/Resources << /ProcSet [/PDF /ImageC] /XObject << /Im0 {image_object} 0 R >> >> "
                f"/Contents {content_object} 0 R >>"
            ).encode("ascii")
        )
        encoded = io.BytesIO()
        image.save(encoded, "JPEG", quality=94, subsampling=0, optimize=False)
        image_bytes = encoded.getvalue()
        objects.append(
            (
                f"<< /Type /XObject /Subtype /Image /Width {image.width} /Height {image.height} "
                f"/ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /DCTDecode /Length {len(image_bytes)} >>\n"
                "stream\n"
            ).encode("ascii")
            + image_bytes
            + b"\nendstream"
        )
        content = f"q {page_width:.2f} 0 0 {page_height:.2f} 0 0 cm /Im0 Do Q\n".encode("ascii")
        objects.append(f"<< /Length {len(content)} >>\nstream\n".encode("ascii") + content + b"endstream")

    objects.append(
        b"<< /Title (ArchiveLens synthetic offline fixture) /Author (ArchiveLens) "
        b"/Subject (Synthetic offline format and Chinese OCR fixture) "
        b"/Creator (scripts/generate-offline-format-fixtures.py) "
        b"/CreationDate (D:19700101000000Z) /ModDate (D:19700101000000Z) >>"
    )

    result = bytearray(b"%PDF-1.4\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for number, body in enumerate(objects, start=1):
        offsets.append(len(result))
        result.extend(f"{number} 0 obj\n".encode("ascii"))
        result.extend(body)
        result.extend(b"\nendobj\n")
    xref_offset = len(result)
    result.extend(f"xref\n0 {len(objects) + 1}\n".encode("ascii"))
    result.extend(b"0000000000 65535 f \n")
    for offset in offsets[1:]:
        result.extend(f"{offset:010d} 00000 n \n".encode("ascii"))
    result.extend(
        (
            f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R /Info {len(objects)} 0 R >>\n"
            f"startxref\n{xref_offset}\n%%EOF\n"
        ).encode("ascii")
    )
    pdf_path.write_bytes(result)


def resolve_djvu_tools(explicit: Path | None, installer: Path) -> Path:
    if explicit is not None:
        tools = explicit.resolve()
    else:
        seven_zip = ROOT / "apps" / "desktop" / "node_modules" / "7zip-bin-full" / "win" / "x64" / "7z.exe"
        if not seven_zip.is_file():
            raise FileNotFoundError("7zip-bin-full is missing; run pnpm install --frozen-lockfile")
        tools = ROOT / ".tmp" / "offline-fixture-djvu-tools"
        if tools.exists():
            shutil.rmtree(tools)
        tools.mkdir(parents=True)
        subprocess.run(
            [str(seven_zip), "x", "-y", f"-o{tools}", str(installer)],
            check=True,
            stdout=subprocess.DEVNULL,
        )
    for name in ("c44.exe", "djvm.exe"):
        if not (tools / name).is_file():
            raise FileNotFoundError(f"DjVu fixture encoder is missing: {tools / name}")
    return tools


def write_djvu(output: Path, pages: list[Image.Image], tools: Path) -> None:
    with tempfile.TemporaryDirectory(prefix="archivelens-djvu-fixture-") as temp_value:
        temp = Path(temp_value)
        encoded_pages: list[Path] = []
        for index, image in enumerate(pages, start=1):
            ppm = temp / f"page-{index}.ppm"
            encoded = temp / f"page-{index}.djvu"
            image.save(ppm, "PPM")
            subprocess.run(
                [str(tools / "c44.exe"), "-dpi", str(PAGE_DPI[0]), str(ppm), str(encoded)],
                check=True,
                capture_output=True,
            )
            encoded_pages.append(encoded)
        subprocess.run(
            [str(tools / "djvm.exe"), "-create", str(output / "synthetic-three-page.djvu"), *map(str, encoded_pages)],
            check=True,
            capture_output=True,
        )


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument("--font-path", type=Path, default=DEFAULT_FONT)
    parser.add_argument("--djvu-tools", type=Path)
    parser.add_argument(
        "--djvu-installer",
        type=Path,
        default=ROOT / ".tmp" / "native-downloads" / "DjVuLibre-3.5.29_DjView-4.12_Setup.exe",
    )
    args = parser.parse_args()
    check_font(args.font_path)
    if not args.djvu_installer.is_file() and args.djvu_tools is None:
        raise FileNotFoundError("verified DjVuLibre installer cache is missing; run pnpm prepare:native first")
    if args.djvu_tools is None:
        lock = json.loads((ROOT / "scripts" / "native-dependencies.lock.json").read_text(encoding="utf-8"))
        expected_installer_hash = lock["components"]["djvulibre"]["installer"]["sha256"]
        actual_installer_hash = sha256(args.djvu_installer)
        if actual_installer_hash != expected_installer_hash:
            raise RuntimeError(
                "DjVuLibre fixture encoder installer hash mismatch: "
                f"actual={actual_installer_hash} expected={expected_installer_hash}"
            )

    output = args.output_dir.resolve()
    output.mkdir(parents=True, exist_ok=True)
    body_font = ImageFont.truetype(str(args.font_path), FONT_SIZE)
    header_font = ImageFont.truetype(str(args.font_path), HEADER_FONT_SIZE)
    footer_font = ImageFont.truetype(str(args.font_path), FOOTER_FONT_SIZE)
    pages = [
        draw_page(body_font, header_font, footer_font, HORIZONTAL_SIMPLIFIED),
        draw_page(body_font, header_font, footer_font, HORIZONTAL_TRADITIONAL),
        draw_page(body_font, header_font, footer_font, VERTICAL_TRADITIONAL, vertical=True),
    ]
    try:
        write_image_formats(output, pages)
        write_pdf(output, pages)
        tools = resolve_djvu_tools(args.djvu_tools, args.djvu_installer)
        write_djvu(output, pages, tools)
    finally:
        for image in pages:
            image.close()

    expected_pages = {
        "simplified-horizontal.png": 1,
        "traditional-horizontal.jpg": 1,
        "multipage.tiff": 2,
        "synthetic-archive.pdf": 2,
        "synthetic-three-page.djvu": 3,
    }
    manifest = {
        "schema_version": 1,
        "generator": {
            "script": "scripts/generate-offline-format-fixtures.py",
            "python_version": platform.python_version(),
            "pillow_version": PIL.__version__,
            "font_file": args.font_path.name,
            "font_sha256": FONT_SHA256,
            "font_redistributed": False,
            "content_classification": "synthetic",
        },
        "search_terms": ["编号", "編號"],
        "files": [
            {
                "file": name,
                "pages": pages_count,
                "bytes": (output / name).stat().st_size,
                "sha256": sha256(output / name),
            }
            for name, pages_count in expected_pages.items()
        ],
    }
    (output / "expected.json").write_text(
        json.dumps(manifest, ensure_ascii=False, indent=2) + "\n",
        encoding="utf-8",
    )
    print(f"[PASS] offline format fixtures generated: {output}")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
