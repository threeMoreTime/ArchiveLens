"""P1-10B: 生成合成验收 fixture（SYNTHETIC）。

用 Pillow 生成包含中文文字的合成图像，模拟不同版面和退化类型。
所有合成样本标注 SYNTHETIC，不声称是真实档案。

可重复生成：使用固定随机种子，每次运行产生相同 SHA。
Fail-closed：加密 PDF 和大任务 PDF 生成失败时 sys.exit(1)。

生成到 tests/fixtures/p1-10b-synthetic/
"""
from __future__ import annotations

import hashlib
import json
import os
import random
import struct
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 固定随机种子，确保噪声 fixture 可重复生成（相同 SHA）。
RNG = random.Random(42)

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
    print("错误：未找到中文字体", file=sys.stderr)
    sys.exit(1)


def make_text_image(width=800, height=1100, bg="white"):
    return Image.new("RGB", (width, height), bg)


def draw_horizontal_text(img, lines, font_size=36, color="black", start_y=80):
    draw = ImageDraw.Draw(img)
    font = ImageFont.truetype(FONT_PATH, font_size)
    y = start_y
    for line in lines:
        draw.text((80, y), line, fill=color, font=font)
        y += font_size + 20
    return img


def draw_vertical_text(img, lines, font_size=36, color="black", start_x=700):
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


def draw_multicolumn(img, columns, font_size=28, color="black"):
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


def add_noise(img, intensity=30):
    """使用固定 RNG 添加噪声，确保可重复生成。"""
    pixels = img.load()
    for y in range(img.height):
        for x in range(img.width):
            r, g, b = pixels[x, y]
            n = RNG.randint(-intensity, intensity)
            pixels[x, y] = (max(0, min(255, r + n)), max(0, min(255, g + n)), max(0, min(255, b + n)))
    return img


def rotate(img, angle):
    return img.rotate(angle, expand=False, fillcolor="white")


def save_png_deterministic(img, path):
    """保存 PNG 时去除元数据，确保可重复生成（相同 SHA）。"""
    img.save(path, "PNG", optimize=False)


def sha256_file(path):
    h = hashlib.sha256()
    with open(path, "rb") as f:
        for chunk in iter(lambda: f.read(8192), b""):
            h.update(chunk)
    return h.hexdigest()


def hits(term, min_hits, allowed_missing=0, note=None):
    """统一的 expected_hits 对象结构。"""
    obj = {"term": term, "min_hits": min_hits, "allowed_missing": allowed_missing}
    if note:
        obj["note"] = note
    return obj


def rejected_fixture(fixture_id, fmt, degradation, error_code="VALIDATION_ERROR"):
    """损坏/异常文件的统一 manifest 条目。"""
    return {
        "fixture_id": fixture_id,
        "format": fmt,
        "synthetic": True,
        "layout": "N/A",
        "degradation": degradation,
        "pages": 0,
        "expected_task_result": "rejected",
        "expected_error_code": error_code,
        "expected_hits": hits(None, 0, 0, "异常文件不产生 OCR 结果"),
    }


manifest = []

# === 1. 繁体竖排（每张不同内容）===
vertical_texts = [
    ["清朝檔案管理制度", "乾隆年間檔案彙編"],
    ["歷史文獻保存規範", "故宫博物院藏品"],
    ["四庫全書編纂紀要", "軍機處檔案整理"],
]
for idx, lines in enumerate(vertical_texts):
    img = make_text_image()
    draw_vertical_text(img, lines)
    path = OUTPUT_DIR / f"traditional-vertical-{idx+1}.png"
    save_png_deterministic(img, path)
    manifest.append({
        "fixture_id": f"traditional-vertical-{idx+1}",
        "format": "PNG", "synthetic": True, "layout": "繁体竖排", "degradation": "清晰", "pages": 1,
        "expected_task_result": "completed",
        "expected_hits": hits("檔案管理", 1, 0),
        "sha256": sha256_file(path),
    })

# === 2. 双栏/多栏（每张不同列数/内容）===
multicolumn_sets = [
    [["档案管理制度", "第一条"], ["历史文献保存", "第二条"]],
    [["档案管理", "第一条"], ["历史文献", "第二条"], ["附录条款", "补充"]],
    [["档案管理制度规定", "实施细则"], ["保存管理办法", "附则"]],
]
for idx, cols in enumerate(multicolumn_sets):
    img = make_text_image()
    draw_multicolumn(img, cols, font_size=28)
    path = OUTPUT_DIR / f"multicolumn-{idx+1}.png"
    save_png_deterministic(img, path)
    manifest.append({
        "fixture_id": f"multicolumn-{idx+1}",
        "format": "PNG", "synthetic": True, "layout": "双栏或多栏", "degradation": "清晰", "pages": 1,
        "expected_task_result": "completed",
        "expected_hits": hits("档案管理", 1, 0),
        "sha256": sha256_file(path),
    })

# === 3. 低对比度（每张不同对比度/文字）===
contrast_sets = [
    (["档案管理低对比度", "历史文献"], 0.25),
    (["模糊扫描测试样本", "文献保存"], 0.35),
]
for idx, (lines, factor) in enumerate(contrast_sets):
    img = make_text_image()
    draw_horizontal_text(img, lines, color="gray")
    img = img.point(lambda v: 128 + (v - 128) * factor)
    path = OUTPUT_DIR / f"low-contrast-{idx+1}.png"
    save_png_deterministic(img, path)
    manifest.append({
        "fixture_id": f"low-contrast-{idx+1}",
        "format": "PNG", "synthetic": True, "layout": "简体横排",
        "degradation": f"低对比度(factor={factor})", "pages": 1,
        "expected_task_result": "completed",
        "expected_hits": hits("档案管理", 0, 1, f"低对比度 factor={factor} 可能 OCR 失败"),
        "sha256": sha256_file(path),
    })

# === 4. 倾斜/旋转 ===
rotated_sets = [
    (["档案管理倾斜测试", "历史文献"], 5.0),
    (["文献保存旋转样本", "管理制度"], 10.0),
    (["档案整理工作规范", "清点检查"], -8.0),
]
for idx, (lines, angle) in enumerate(rotated_sets):
    img = make_text_image()
    draw_horizontal_text(img, lines)
    img = rotate(img, angle)
    path = OUTPUT_DIR / f"rotated-synthetic-{idx+1}.png"
    save_png_deterministic(img, path)
    manifest.append({
        "fixture_id": f"rotated-synthetic-{idx+1}",
        "format": "PNG", "synthetic": True, "layout": "简体横排",
        "degradation": f"倾斜{angle}度", "pages": 1,
        "expected_task_result": "completed",
        "expected_hits": hits("档案管理", 0, 1, f"倾斜{angle}度可能影响 OCR"),
        "sha256": sha256_file(path),
    })

# === 5. 污渍/噪声 ===
noise_sets = [
    (["档案管理噪声测试", "历史文献"], 30),
    (["文献保存污渍扫描", "管理制度"], 50),
]
for idx, (lines, intensity) in enumerate(noise_sets):
    img = make_text_image()
    draw_horizontal_text(img, lines)
    img = add_noise(img, intensity=intensity)
    path = OUTPUT_DIR / f"noise-{idx+1}.png"
    save_png_deterministic(img, path)
    manifest.append({
        "fixture_id": f"noise-{idx+1}",
        "format": "PNG", "synthetic": True, "layout": "简体横排",
        "degradation": f"污渍/噪声(intensity={intensity})", "pages": 1,
        "expected_task_result": "completed",
        "expected_hits": hits("档案管理", 0, 1, f"噪声强度{intensity}可能影响 OCR"),
        "sha256": sha256_file(path),
    })

# === 6. 超长 Unicode 路径 ===
long_name = "档案管理" * 20 + ".png"
img = make_text_image()
draw_horizontal_text(img, ["档案管理超长路径测试"])
path = OUTPUT_DIR / long_name
save_png_deterministic(img, path)
manifest.append({
    "fixture_id": "long-unicode-path-1",
    "format": "PNG", "synthetic": True, "layout": "简体横排", "degradation": "清晰", "pages": 1,
    "expected_task_result": "completed",
    "expected_hits": hits("档案管理", 1, 0),
    "sha256": sha256_file(path),
    "special_filename": long_name,
})

# === 7. 特殊字符文件名 ===
special_name = "档案【特殊】#%&@测试.png"
img = make_text_image()
draw_horizontal_text(img, ["档案管理特殊字符文件名"])
path = OUTPUT_DIR / special_name
save_png_deterministic(img, path)
manifest.append({
    "fixture_id": "special-chars-filename-1",
    "format": "PNG", "synthetic": True, "layout": "简体横排", "degradation": "清晰", "pages": 1,
    "expected_task_result": "completed",
    "expected_hits": hits("档案管理", 1, 0),
    "sha256": sha256_file(path),
    "special_filename": special_name,
})

# === 8. 损坏文件 ===
corrupt_path = OUTPUT_DIR / "corrupt-truncated.png"
with open(corrupt_path, "wb") as f:
    f.write(b"\x89PNG\r\n\x1a\n")
    f.write(b"\x00\x00\x00\rIHDR")
    f.write(struct.pack(">II", 100, 100))
    f.write(b"\x08\x02")
    f.write(b"\x00")
m = rejected_fixture("corrupt-truncated-1", "PNG", "损坏文件（截断 PNG）")
m["sha256"] = sha256_file(corrupt_path)
manifest.append(m)

zero_path = OUTPUT_DIR / "corrupt-zero-byte.png"
with open(zero_path, "wb") as f:
    pass
m = rejected_fixture("corrupt-zero-byte-1", "PNG", "损坏文件（零字节）")
m["sha256"] = sha256_file(zero_path)
manifest.append(m)

# === 9. 加密 PDF（fail-closed：生成失败则退出） ===
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
        "format": "PDF", "synthetic": True, "layout": "空白页",
        "degradation": "加密 PDF（密码 test123）", "pages": 1,
        "expected_task_result": "rejected",
        "expected_error_code": "UNSUPPORTED_FILE",
        "expected_hits": hits(None, 0, 0, "加密 PDF 无 OCR 内容"),
        "sha256": sha256_file(encrypted_path),
    })
except Exception as e:
    print(f"错误：加密 PDF 生成失败: {e}", file=sys.stderr)
    sys.exit(1)

# === 10. 大任务合成 PDF（fail-closed） ===
try:
    from pypdf import PdfWriter
    writer = PdfWriter()
    for i in range(350):
        writer.add_blank_page(width=612, height=792)
    large_path = OUTPUT_DIR / "large-350-page.pdf"
    with open(large_path, "wb") as f:
        writer.write(f)
    manifest.append({
        "fixture_id": "large-350-page",
        "format": "PDF", "synthetic": True, "layout": "空白页",
        "degradation": "大任务（350 页空白 PDF）", "pages": 350,
        "expected_task_result": "completed",
        "expected_hits": hits(None, 0, 0, "空白页无 OCR 内容，用于性能/恢复验收"),
        "sha256": sha256_file(large_path),
    })
except Exception as e:
    print(f"错误：大任务 PDF 生成失败: {e}", file=sys.stderr)
    sys.exit(1)

# === 写入 manifest ===
EXPECTED_FIXTURE_COUNT = 19
if len(manifest) != EXPECTED_FIXTURE_COUNT:
    print(f"错误：生成 {len(manifest)} 个 fixture，预期 {EXPECTED_FIXTURE_COUNT}", file=sys.stderr)
    sys.exit(1)

manifest_path = OUTPUT_DIR / "fixture-manifest.json"
with open(manifest_path, "w", encoding="utf-8") as f:
    json.dump({
        "schema_version": 1,
        "synthetic": True,
        "description": "P1-10B 合成验收 fixture。所有样本为 SYNTHETIC，不声称是真实档案。固定随机种子确保可重复生成。",
        "font": FONT_PATH,
        "random_seed": 42,
        "fixture_count": EXPECTED_FIXTURE_COUNT,
        "fixtures": manifest,
    }, f, ensure_ascii=False, indent=2)

print(f"生成 {len(manifest)} 个合成 fixture")
print(f"Manifest: {manifest_path}")
for m in manifest:
    print(f"  {m['fixture_id']}: {m['format']} / {m['layout']} / {m['degradation']}")
