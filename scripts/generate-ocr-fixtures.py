"""生成 ArchiveLens OCR 测试 fixtures（任务 §十）。

开发工具，**不打包进 Engine**：用 Pillow + Windows 系统中文字体（simhei.ttf）
绘制包含「约/約」的页面，导出为多页图片 PDF。fixtures 本身为图片 PDF，
不含字体文件，可合法提交。

输出：tests/fixtures/ocr/*.pdf + expected.json
"""

from __future__ import annotations

import json
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

# 仅用于生成 fixture 的渲染字体（Windows 系统字体，不随包分发）。
FONT_PATH = r"C:\Windows\Fonts\simhei.ttf"
OUT = Path(__file__).resolve().parents[1] / "tests" / "fixtures" / "ocr"


def _font(size: int) -> ImageFont.FreeTypeFont:
    return ImageFont.truetype(FONT_PATH, size)


def make_pdf(name: str, pages_text: list[str], page_size=(1000, 1400)) -> Path:
    font = _font(44)
    images = []
    for text in pages_text:
        img = Image.new("RGB", page_size, "white")
        draw = ImageDraw.Draw(img)
        # 多行绘制
        y = 90
        for line in text.split("\n"):
            draw.text((90, y), line, fill="black", font=font)
            y += 70
        images.append(img)
    out = OUT / name
    images[0].save(out, "PDF", save_all=True, append_images=images[1:])
    return out


def main() -> None:
    OUT.mkdir(parents=True, exist_ok=True)

    make_pdf("simplified-horizontal.pdf", [
        "双方应按照本协议约定期限完成交付\n约定不明者从俗\n其数量大约为三百石",
    ])
    make_pdf("traditional-horizontal.pdf", [
        "立約各方應誠實守信\n契約存於檔案庫中\n歲約絹帛若干",
    ])
    make_pdf("mixed-multipage.pdf", [
        "简体：约定 纄定\n繁体：約定",
        "第二页 约 與 約 共存",
    ])
    make_pdf("rotated-page.pdf", [
        "旋转页 约 約",
    ])
    make_pdf("中文 空格 # %.pdf", [
        "中文文件名 含空格与#%\n约 約",
    ])

    expected = {
        "documents": [
            {"file": "simplified-horizontal.pdf", "expected_min_hits": 2, "expected_characters": ["约"]},
            {"file": "traditional-horizontal.pdf", "expected_min_hits": 2, "expected_characters": ["約"]},
            {"file": "mixed-multipage.pdf", "expected_min_hits": 2, "expected_characters": ["约", "約"]},
            {"file": "中文 空格 # %.pdf", "expected_min_hits": 1, "expected_characters": ["约", "約"]},
        ]
    }
    (OUT / "expected.json").write_text(json.dumps(expected, ensure_ascii=False, indent=2), encoding="utf-8")
    print(f"fixtures generated at {OUT}")


if __name__ == "__main__":
    main()
