"""P1-10B: 生成合成验收 fixture（SYNTHETIC）。

用 Pillow 生成包含中文文字的合成图像，模拟不同版面和退化类型。
所有合成样本标注 SYNTHETIC，不声称是真实档案。

生成到 tests/fixtures/p1-10b-synthetic/
"""
from __future__ import annotations

import hashlib
import json
import os
import struct
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT_DIR = Path("tests/fixtures/p1-10b-synthetic")
OUTPUT_DIR.mkdir(parents=True, exist_ok=True)

# 尝试加载中文字体
FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",       # 微软雅黑
    "C:/Windows/Fonts/simsun.ttc",     # 宋体
    "C:/Windows/Fonts/simhei.ttf",     # 黑体
    "C:/Windows/Fonts/DFKai-SB.ttf",   # 楷体
]
FONT_PATH = None
for f in FONT_CANDIDATES:
    if os.path.exists(f):
        FONT_PATH = f
        break

if not FONT_PATH:
    raise RuntimeError("未找到中文字体")

# 预期检索词
SEARCH_TERMS = {
    "simplified": "档案管理",
    "traditional": "檔案管理",
}


def make_text_image(
    width: int = 800,
    height: int = 1100,
    bg: str = "white",
    text_color: str = "black",
    font_size: int = 36,
) -> Image.Image:
    """创建白底文字图像。"""
    img = Image.new("RGB", (width, height), bg)
    return img


def draw_horizontal_text(img: Image.Image, lines: list[str], font_size: int = 36, color: str = "black", start_y: int = 80):
    """横排文字。"""
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, font_size)
    y = start_y
    for line in lines:
        draw.text((80, y), line, fill=color, font=font)
        y += font_size + 20
    return img


def draw_vertical_text(img: Image.Image, lines: list[str], font_size: int = 36, color: str = "black", start_x: int = 700):
    """竖排文字（从右到左）。"""
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, font_size)
    x = start_x
    for line in lines:
        y = 80
        for ch in line:
            draw.text((x, y), ch, fill=color, font=font)
            y += font_size + 10
        x -= font_size + 30
    return img


def draw_multicolumn(img: Image.Image, columns: list[list[str]], font_size: int = 28, color: str = "black"):
    """双栏/多栏文字。"""
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, font_size)
    col_width = img.width // (len(columns) + 1)
    for i, col in enumerate(columns):
        x = col_width * (i + 1) - col_width // 2
        y = 80
        for line in col:
            draw.text((x, y), line, fill=color, font=font)
            y += font_size + 15
    return img


def add_noise(img: Image.Image, intensity: int = 30) -> Image.Image:
    """添加随机噪声（模拟污渍/扫描噪声）。"""
    import random
    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = pixels[x, y]
            n = random.randint(-intensity, intensity)
            pixels[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img


def add_low_contrast(img: Image.Image) -> Image.Image:
    """降低对比度。"""
    return img.point(lambda v: 128 + (v - 128) * 0.3)


def rotate(img: Image.Image, angle: float) -> Image.Image:
    """旋转图像。"""
    return img.rotate(angle, expand=False, fillcolor="white")


def sha256_file(path: Path) -> str:
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


manifest = []

# === 1. 繁体竖排 ===
for idx in range(3):
    img = make_text_image()
    lines = ["清朝檔案管理制度", "乾隆年間檔案彙編", "歷史文獻保存規範"]
    draw_vertical_text(img, lines)
    path = OUTPUT_DIR / f"traditional-vertical-{idx+1}.png"
    img.save(path, "PNG")
    manifest.append({
        "fixture_id": f"traditional-vertical-{idx+1}",
        "format": "PNG",
        "synthetic": True,
        "layout": "繁体竖排",
        "degradation": "清晰",
        "pages": 1,
        "expected_search_term": "檔案管理",
        "expected_hits": ">=1",
        "sha256": sha256_file(path),
    })

# === 2. 双栏/多栏 ===
for idx in range(3):
    img = make_text_image()
    cols = [["档案管理制度", "第一条规定"], ["历史文献保存", "第二条规定"]]
    if idx >= 1:
        cols.append(["附录条款", "补充说明"])
    draw_multicolumn(img, cols, font_size=28)
    path = OUTPUT_DIR / f"multicolumn-{idx+1}.png"
    img.save(path, "PNG")
    manifest.append({
        "fixture_id": f"multicolumn-{idx+1}",
        "format": "PNG",
        "synthetic": True,
        "layout": "双栏或多栏",
        "degradation": "清晰",
        "pages": 1,
        "expected_search_term": "档案管理",
        "expected_hits": ">=1",
        "sha256": sha256_file(path),
    })

# === 3. 低对比度 ===
for idx in range(2):
    img = make_text_image()
    draw_horizontal_text(img, ["档案管理低对比度测试", "历史文献模糊扫描"], color="gray")
    img = add_low_contrast(img)
    path = OUTPUT_DIR / f"low-contrast-{idx+1}.png"
    img.save(path, "PNG")
    manifest.append({
        "fixture_id": f"low-contrast-{idx+1}",
        "format": "PNG",
        "synthetic": True,
        "layout": "简体横排",
        "degradation": "低对比度",
        "pages": 1,
        "expected_search_term": "档案管理",
        "expected_hits": ">=0（低对比度可能 OCR 失败）",
        "sha256": sha256_file(path),
    })

# === 4. 倾斜/旋转 ===
for idx, angle in enumerate([5.0, 10.0, -8.0]):
    img = make_text_image()
    draw_horizontal_text(img, ["档案管理倾斜测试", "历史文献旋转扫描"])
    img = rotate(img, angle)
    path = OUTPUT_DIR / f"rotated-synthetic-{idx+1}.png"
    img.save(path, "PNG")
    manifest.append({
        "fixture_id": f"rotated-synthetic-{idx+1}",
        "format": "PNG",
        "synthetic": True,
        "layout": "简体横排",
        "degradation": f"倾斜{angle}度",
        "pages": 1,
        "expected_search_term": "档案管理",
        "expected_hits": ">=0（倾斜可能影响 OCR）",
        "sha256": sha256_file(path),
    })

# === 5. 污渍/噪声 ===
for idx in range(2):
    img = make_text_image()
    draw_horizontal_text(img, ["档案管理噪声测试", "历史文献污渍扫描"])
    img = add_noise(img, intensity=40)
    path = OUTPUT_DIR / f"noise-{idx+1}.png"
    img.save(path, "PNG")
    manifest.append({
        "fixture_id": f"noise-{idx+1}",
        "format": "PNG",
        "synthetic": True,
        "layout": "简体横排",
        "degradation": "污渍/噪声",
        "pages": 1,
        "expected_search_term": "档案管理",
        "expected_hits": ">=0（噪声可能影响 OCR）",
        "sha256": sha256_file(path),
    })

# === 6. 超长 Unicode 路径 ===
long_name = "档案管理" * 20 + ".png"  # 约 80+ 字符
img = make_text_image()
draw_horizontal_text(img, ["档案管理超长路径测试"])
path = OUTPUT_DIR / long_name
img.save(path, "PNG")
manifest.append({
    "fixture_id": "long-unicode-path-1",
    "format": "PNG",
    "synthetic": True,
    "layout": "简体横排",
    "degradation": "清晰",
    "pages": 1,
    "expected_search_term": "档案管理",
    "expected_hits": ">=1",
    "sha256": sha256_file(path),
    "special_filename": long_name,
})

# === 7. 特殊字符文件名 ===
special_name = "档案【特殊】#%&@测试.png"
img = make_text_image()
draw_horizontal_text(img, ["档案管理特殊字符文件名"])
path = OUTPUT_DIR / special_name
img.save(path, "PNG")
manifest.append({
    "fixture_id": "special-chars-filename-1",
    "format": "PNG",
    "synthetic": True,
    "layout": "简体横排",
    "degradation": "清晰",
    "pages": 1,
    "expected_search_term": "档案管理",
    "expected_hits": ">=1",
    "sha256": sha256_file(path),
    "special_filename": special_name,
})

# === 8. 损坏文件 ===
# 生成一个截断的 PNG（损坏）
corrupt_path = OUTPUT_DIR / "corrupt-truncated.png"
with open(corrupt_path, "wb") as f:
    # PNG header + partial IHDR（截断）
    f.write(b"\x89PNG\r\n\x1a\n")
    f.write(b"\x00\x00\x00\rIHDR")  # IHDR chunk header
    f.write(struct.pack(">II", 100, 100))  # width, height
    f.write(b"\x08\x02")  # bit depth, color type
    f.write(b"\x00")  # 截断 - 缺少剩余 IHDR + 数据
manifest.append({
    "fixture_id": "corrupt-truncated-1",
    "format": "PNG",
    "synthetic": True,
    "layout": "N/A",
    "degradation": "损坏文件（截断 PNG）",
    "pages": 0,
    "expected_search_term": "N/A",
    "expected_hits": "0（损坏文件应失败）",
    "sha256": sha256_file(corrupt_path),
})

# 生成一个零字节文件（损坏）
zero_path = OUTPUT_DIR / "corrupt-zero-byte.png"
with open(zero_path, "wb") as f:
    pass  # 零字节
manifest.append({
    "fixture_id": "corrupt-zero-byte-1",
    "format": "PNG",
    "synthetic": True,
    "layout": "N/A",
    "degradation": "损坏文件（零字节）",
    "pages": 0,
    "expected_search_term": "N/A",
    "expected_hits": "0（损坏文件应失败）",
    "sha256": sha256_file(zero_path),
})

# === 9. 加密 PDF（占位：需 pypdf） ===
# 尝试用 pypdf 生成加密 PDF
try:
    from pypdf import PdfWriter
    writer = PdfWriter()
    writer.add_blank_page(width=200, height=300)
    encrypted_path = OUTPUT_DIR / "encrypted-blank.pdf"
    with open(encrypted_path, "wb") as f:
        writer.encrypt("test123")
        writer.write(f)
    manifest.append({
        "fixture_id": "encrypted-pdf-1",
        "format": "PDF",
        "synthetic": True,
        "layout": "空白页",
        "degradation": "加密 PDF（密码 test123）",
        "pages": 1,
        "expected_search_term": "N/A",
        "expected_hits": "0（加密 PDF 无 OCR 内容）",
        "sha256": sha256_file(encrypted_path),
    })
except Exception as e:
    print(f"加密 PDF 生成跳过: {e}")

# === 10. 大任务合成 PDF（300+ 页） ===
try:
    from pypdf import PdfWriter
    writer = PdfWriter()
    for i in range(350):
        writer.add_blank_page(width=612, height=792)  # US Letter
    large_path = OUTPUT_DIR / "large-350-page.pdf"
    with open(large_path, "wb") as f:
        writer.write(f)
    manifest.append({
        "fixture_id": "large-350-page",
        "format": "PDF",
        "synthetic": True,
        "layout": "空白页",
        "degradation": "大任务（350 页空白 PDF）",
        "pages": 350,
        "expected_search_term": "N/A（空白页无 OCR 内容，用于性能/恢复验收）",
        "expected_hits": "0",
        "sha256": sha256_file(large_path),
    })
except Exception as e:
    print(f"大任务 PDF 生成跳过: {e}")

# 写入 manifest
manifest_path = OUTPUT_DIR / "fixture-manifest.json"
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump({
        "schema_version": 1,
        "generated_at": "2026-07-30",
        "synthetic": True,
        "description": "P1-10B 合成验收 fixture。所有样本为 SYNTHETIC，不声称是真实档案。",
        "font": FONT_PATH,
        "fixtures": manifest,
    }, f, ensure_ascii=False, indent=2)

print(f"生成 {len(manifest)} 个合成 fixture")
print(f"Manifest: {manifest_path}")
for m in manifest:
    print(f"  {m['fixture_id']}: {m['format']} / {m['layout']} / {m['degradation']}")
