"""P1-10B-B: 生成 350 页真实文字图像型 PDF。

用 Pillow 渲染中文文字为高分辨率图像（图像型 PDF，无文本层），
确保 OCR Engine 必须执行真实推理。

35 个模板按简体/繁体 × 横排/竖排分类，每模板重复 10 次组成 350 页：
  简体横排：24 模板 / 240 页
  简体竖排：6 模板 / 60 页
  繁体横排：4 模板 / 40 页
  繁体竖排：1 模板 / 10 页

每页包含对应脚本的检索词：
  简体页使用"档案管理"，繁体页使用"檔案管理"。

输出：
  tests/fixtures/p1-10b-synthetic/real-text-350-page.pdf
  tests/fixtures/p1-10b-synthetic/real-text-350-source-truth.json
"""
from __future__ import annotations

import hashlib
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

TERM_SIMPLIFIED = "档案管理"
TERM_TRADITIONAL = "檔案管理"


def build_templates():
    """构建 35 个模板，明确标注 script/layout 分类。"""
    templates = []
    for i in range(35):
        is_vertical = (i % 5 == 4)
        is_traditional = (i % 7 == 6)
        font_size = 32 + (i % 4) * 8
        template_id = f"template-{i+1:02d}"

        if is_traditional:
            script = "traditional"
            term = TERM_TRADITIONAL
            title = f"歷史檔案管理編號{i+1}"
            body_lines = [f"第{j+1}條 檔案管理規定" for j in range(3 + i % 4)]
        else:
            script = "simplified"
            term = TERM_SIMPLIFIED
            title = f"历史档案管理编号{i+1}"
            body_lines = [f"第{j+1}条 档案管理规定" for j in range(3 + i % 4)]

        # 逐字符串计算子串出现次数（不是 list.count）
        source_truth_hits = (
            title.count(term)
            + sum(line.count(term) for line in body_lines)
        )

        templates.append({
            "template_id": template_id,
            "script": script,
            "layout": "vertical" if is_vertical else "horizontal",
            "font_size": font_size,
            "title": title,
            "body_lines": body_lines,
            "search_term": term,
            "source_truth_hits": source_truth_hits,
        })
    return templates


def render_page(template: dict, page_number: int) -> Image.Image:
    """渲染单页为 PIL Image。竖排：字符固定 x 递增 y。"""
    img = Image.new("RGB", (PAGE_WIDTH, PAGE_HEIGHT), "white")
    draw = ImageDraw.Draw(img)
    font_title = ImageFont.truetype(FONT_PATH, template["font_size"] + 8)
    font_body = ImageFont.truetype(FONT_PATH, template["font_size"])

    if template["layout"] == "vertical":
        # 竖排：标题在第 1 列（最右），正文在第 2 列起向左
        # 标题：固定 x=PAGE_WIDTH-100，递增 y
        title_x = PAGE_WIDTH - 100
        y = 80
        for ch in template["title"]:
            draw.text((title_x, y), ch, fill="black", font=font_title)
            y += template["font_size"] + 12

        # 正文：每行从右到左，每行内字符固定 x 递增 y
        col_x = title_x - template["font_size"] - 30
        for line in template["body_lines"]:
            line_y = 80
            for ch in line:
                draw.text((col_x, line_y), ch, fill="black", font=font_body)
                line_y += template["font_size"] + 10
            col_x -= template["font_size"] + 20
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
    from pypdf import PdfWriter, PdfReader
    from io import BytesIO

    templates = build_templates()
    writer = PdfWriter()

    # 构建 source truth（多词 schema）
    pages = []
    simp_total_hits = 0
    trad_total_hits = 0
    simp_pages = 0
    trad_pages = 0

    for page_num in range(1, TOTAL_PAGES + 1):
        template = templates[(page_num - 1) % len(templates)]

        img = render_page(template, page_num)

        buf = BytesIO()
        img.save(buf, format="PDF", resolution=150.0)
        buf.seek(0)

        page_reader = PdfReader(buf)
        writer.add_page(page_reader.pages[0])

        term = template["search_term"]
        hits = template["source_truth_hits"]
        pages.append({
            "page_number": page_num,
            "template_id": template["template_id"],
            "layout": template["layout"],
            "script": template["script"],
            "font_size": template["font_size"],
            "terms": {term: hits},
        })

        if template["script"] == "simplified":
            simp_total_hits += hits
            simp_pages += 1
        else:
            trad_total_hits += hits
            trad_pages += 1

        img.close()

    pdf_path = OUTPUT_DIR / "real-text-350-page.pdf"
    with open(pdf_path, "wb") as f:
        writer.write(f)

    source_truth = {
        "schema_version": 1,
        "total_pages": TOTAL_PAGES,
        "template_count": len(templates),
        "search_terms": [
            {
                "term": TERM_SIMPLIFIED,
                "source_truth_hits": simp_total_hits,
                "pages_containing_term": simp_pages,
            },
            {
                "term": TERM_TRADITIONAL,
                "source_truth_hits": trad_total_hits,
                "pages_containing_term": trad_pages,
            },
        ],
        "pages": pages,
    }

    truth_path = OUTPUT_DIR / "real-text-350-source-truth.json"
    with open(truth_path, "w", encoding="utf-8") as f:
        json.dump(source_truth, f, ensure_ascii=False, indent=2)

    sha = hashlib.sha256(pdf_path.read_bytes()).hexdigest()
    truth_sha = hashlib.sha256(truth_path.read_bytes()).hexdigest()

    print(f"生成 {TOTAL_PAGES} 页真实文字 PDF: {pdf_path}")
    print(f"PDF SHA-256: {sha}")
    print(f"Source truth SHA-256: {truth_sha}")
    print(f"模板数: {len(templates)}")
    print(f"简体 {TERM_SIMPLIFIED}: {simp_total_hits} hits / {simp_pages} pages")
    print(f"繁体 {TERM_TRADITIONAL}: {trad_total_hits} hits / {trad_pages} pages")
    print(f"总计: {simp_total_hits + trad_total_hits} hits")


if __name__ == "__main__":
    main()
