"""P1-10B-B: 生成 350 页真实文字图像型 PDF。

用 Pillow 渲染中文文字为高分辨率图像（图像型 PDF，无文本层），
确保 OCR Engine 必须执行真实推理。

每页包含可核验检索词"档案管理"，使用 35 个不同模板（简体/繁体、
横排/竖排、不同字号），每模板重复 ≤10 次组成 350 页。

固定随机种子 + 确定性保存，确保可重复生成（相同 SHA）。

输出：
  tests/fixtures/p1-10b-synthetic/real-text-350-page.pdf
  tests/fixtures/p1-10b-synthetic/real-text-350-source-truth.json
"""
from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

OUTPUT_DIR = Path("tests/fixtures/p1-10b-synthetic")
TOTAL_PAGES = 350
PAGE_WIDTH = 1240   # ~A4 @ 150 DPI
PAGE_HEIGHT = 1754

FONT_CANDIDATES = [
    "C:/Windows/Fonts/msyh.ttc",
    "C:/Windows/Fonts/simsun.ttc",
    "C:/Windows/Fonts/simhei.ttf",
]
FONT_PATH = None
for f in FONT_CANDIDATES:
    if os.path.exists(f):
        FONT_PATH = f
        break
if not FONT_PATH:
    print("错误：未找到中文字体", file=sys.stderr)
    sys.exit(1)

SEARCH_TERM = "档案管理"

# 35 个页面模板：每个定义布局/字号/文字内容/检索词出现次数
TEMPLATES = []
for i in range(35):
    is_vertical = (i % 5 == 4)  # 每 5 个有 1 个竖排
    is_traditional = (i % 7 == 6)  # 每 7 个有 1 个繁体
    font_size = 32 + (i % 4) * 8  # 32/40/48/56 轮换
    template_id = f"template-{i+1:02d}"

    if is_traditional:
        title = f"歷史檔案管理編號{i+1}"
        body_lines = [f"第{j+1}條 檔案管理規定" for j in range(3 + i % 4)]
        term = "檔案管理"
    else:
        title = f"历史档案管理编号{i+1}"
        body_lines = [f"第{j+1}条 档案管理规定" for j in range(3 + i % 4)]
        term = SEARCH_TERM

    TEMPLATES.append({
        "template_id": template_id,
        "vertical": is_vertical,
        "traditional": is_traditional,
        "font_size": font_size,
        "title": title,
        "body_lines": body_lines,
        "search_term": term,
    })


def render_page(template: dict, page_number: int) -> Image.Image:
    """渲染单页为 PIL Image。"""
    img = Image.new("RGB", (PAGE_WIDTH, PAGE_HEIGHT), "white")
    draw = ImageDraw.Draw(img)
    font_title = ImageFont.truetype(FONT_PATH, template["font_size"] + 8)
    font_body = ImageFont.truetype(FONT_PATH, template["font_size"])

    if template["vertical"]:
        # 竖排：从右到左
        x = PAGE_WIDTH - 100
        # 标题
        for ch in template["title"]:
            draw.text((x, 80), ch, fill="black", font=font_title)
            x -= template["font_size"] + 12
        # 正文（从右到左每列）
        x = PAGE_WIDTH - 100
        for line in template["body_lines"]:
            col_x = x
            y = 80
            for ch in line:
                draw.text((col_x, y), ch, fill="black", font=font_body)
                y += template["font_size"] + 10
            x -= template["font_size"] + 20
    else:
        # 横排
        y = 80
        draw.text((80, y), template["title"], fill="black", font=font_title)
        y += template["font_size"] + 30
        for line in template["body_lines"]:
            draw.text((80, y), line, fill="black", font=font_body)
            y += template["font_size"] + 20

    # 页码
    draw.text((PAGE_WIDTH - 150, PAGE_HEIGHT - 60), f"第{page_number}页",
              fill="gray", font=font_body)
    return img


def main():
    from pypdf import PdfWriter
    from io import BytesIO

    writer = PdfWriter()
    source_truth = {"total_pages": TOTAL_PAGES, "search_term": SEARCH_TERM, "pages": []}

    for page_num in range(1, TOTAL_PAGES + 1):
        template_idx = (page_num - 1) % len(TEMPLATES)
        template = TEMPLATES[template_idx]

        img = render_page(template, page_num)

        # 将 PIL Image 转为 PDF 页
        buf = BytesIO()
        img.save(buf, format="PDF", resolution=150.0)
        buf.seek(0)

        from pypdf import PdfReader
        page_reader = PdfReader(buf)
        writer.add_page(page_reader.pages[0])

        source_truth["pages"].append({
            "page_number": page_num,
            "template_id": template["template_id"],
            "terms": {template["search_term"]: template["body_lines"].count(
                template["search_term"] if template["search_term"] in template["body_lines"][0]
                else template["search_term"]
            ) + (1 if template["search_term"] in template["title"] else 0)},
        })

        img.close()

    pdf_path = OUTPUT_DIR / "real-text-350-page.pdf"
    with open(pdf_path, "wb") as f:
        writer.write(f)

    truth_path = OUTPUT_DIR / "real-text-350-source-truth.json"
    with open(truth_path, "w", encoding="utf-8") as f:
        json.dump(source_truth, f, ensure_ascii=False, indent=2)

    import hashlib
    sha = hashlib.sha256(pdf_path.read_bytes()).hexdigest()

    print(f"生成 350 页真实文字 PDF: {pdf_path}")
    print(f"SHA-256: {sha}")
    print(f"Source truth: {truth_path}")
    print(f"模板数: {len(TEMPLATES)}")
    print(f"检索词: {SEARCH_TERM}")


if __name__ == "__main__":
    main()
