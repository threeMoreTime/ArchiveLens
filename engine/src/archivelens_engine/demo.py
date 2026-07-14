"""演示模式：内置 fixture，不依赖 Tesseract / DjVuLibre / 真实 OCR。

任务 §八：用户点击「体验示例」即进入校对工作台，复用正式 results/review/export API，
不维护第二套 demo-only UI。
"""

from __future__ import annotations

import os
from pathlib import Path
from typing import Any

from .db.store import TaskStore, now_iso

#: 演示文档（含中文 / 空格 / # / %，覆盖任务 §八.6 的特殊字符要求）。
DEMO_DOCUMENTS = [
    {
        "document_id": "demo-doc-1",
        "file_name": "道光婺源县志 卷一.pdf",
        "relative_path": "道光婺源县志 卷一.pdf",
    },
    {
        "document_id": "demo-doc-2",
        "file_name": "示例 档案#1%djvu.djvu",
        "relative_path": "示例 档案#1%djvu.djvu",
    },
]


def _occ(
    *,
    document: dict[str, str],
    page_number: int,
    page_index: int,
    page_occurrence_index: int,
    char: str,
    variant: str,
    codepoint: str,
    context_full: str,
    context_before: str,
    context_after: str,
    confidence: float,
    secondary: str,
    status: str,
    method: str,
    bbox: tuple[float, float, float, float],
    page_size: tuple[int, int],
    page_id: str,
    crop_id: str,
) -> dict[str, Any]:
    x0, y0, x1, y1 = bbox
    w, h = page_size
    return {
        "document_id": document["document_id"],
        "file_path": "",
        "relative_path": document["relative_path"],
        "file_name": document["file_name"],
        "page_number": page_number,
        "page_index": page_index,
        "page_occurrence_index": page_occurrence_index,
        "matched_character": char,
        "character_variant": variant,
        "unicode_codepoint": codepoint,
        "context_before": context_before,
        "context_after": context_after,
        "context_full": context_full,
        "ocr_confidence": confidence,
        "secondary_ocr_result": secondary,
        "verification_status": status,
        "location_method": method,
        "source_page_width": float(w),
        "source_page_height": float(h),
        "source_x0": x0,
        "source_y0": y0,
        "source_x1": x1,
        "source_y1": y1,
        "normalized_x0": x0 / w,
        "normalized_y0": y0 / h,
        "normalized_x1": x1 / w,
        "normalized_y1": y1 / h,
        "page_image_relpath": f"pages/{page_id}.png",
        "crop_image_relpath": f"crops/{crop_id}.png",
        "page_image_width": w,
        "page_image_height": h,
    }


def _build_occurrences() -> list[dict[str, Any]]:
    """6 条结果：简繁 × confirmed/needs_review/rejected × 2 文档多页。"""
    doc1, doc2 = DEMO_DOCUMENTS[0], DEMO_DOCUMENTS[1]
    page_size = (480, 640)
    return [
        _occ(
            document=doc1, page_number=1, page_index=0, page_occurrence_index=1,
            char="约", variant="simplified", codepoint="U+7EA6",
            context_full="双方应按照本协议约定的期限完成交付",
            context_before="双方应按照本协议", context_after="定的期限完成交付",
            confidence=0.94, secondary="约", status="confirmed", method="pdf_text_layer",
            bbox=(180, 240, 210, 280), page_size=page_size, page_id="doc1-p1", crop_id="crop-1",
        ),
        _occ(
            document=doc1, page_number=2, page_index=1, page_occurrence_index=1,
            char="約", variant="traditional", codepoint="U+7D04",
            context_full="立約各方應誠實守信",
            context_before="立", context_after="各方應誠實守信",
            confidence=0.78, secondary="約", status="needs_review", method="pdf_ocr",
            bbox=(120, 300, 150, 340), page_size=page_size, page_id="doc1-p2", crop_id="crop-2",
        ),
        _occ(
            document=doc1, page_number=3, page_index=2, page_occurrence_index=1,
            char="约", variant="simplified", codepoint="U+7EA6",
            context_full="其数量大约为三百石",
            context_before="其数量大", context_after="为三百石",
            confidence=0.61, secondary="多", status="rejected", method="pdf_ocr",
            bbox=(260, 180, 290, 220), page_size=page_size, page_id="doc1-p3", crop_id="crop-3",
        ),
        _occ(
            document=doc2, page_number=1, page_index=0, page_occurrence_index=1,
            char="約", variant="traditional", codepoint="U+7D04",
            context_full="契約存於檔案庫中",
            context_before="契", context_after="存於檔案庫中",
            confidence=0.91, secondary="約", status="confirmed", method="djvu_text_layer",
            bbox=(200, 200, 232, 244), page_size=page_size, page_id="doc2-p1", crop_id="crop-4",
        ),
        _occ(
            document=doc2, page_number=3, page_index=2, page_occurrence_index=1,
            char="约", variant="simplified", codepoint="U+7EA6",
            context_full="约定不明者从俗",
            context_before="", context_after="定不明者从俗",
            confidence=0.74, secondary="约", status="needs_review", method="djvu_ocr",
            bbox=(140, 420, 172, 464), page_size=page_size, page_id="doc2-p3", crop_id="crop-5",
        ),
        _occ(
            document=doc2, page_number=5, page_index=4, page_occurrence_index=1,
            char="約", variant="traditional", codepoint="U+7D04",
            context_full="歲約絹帛若干",
            context_before="歲", context_after="絹帛若干",
            confidence=0.88, secondary="約", status="confirmed", method="djvu_ocr",
            bbox=(300, 360, 332, 404), page_size=page_size, page_id="doc2-p5", crop_id="crop-6",
        ),
    ]


def _render_images(pages_dir: Path, crops_dir: Path, occurrences: list[dict[str, Any]]) -> None:
    """用 Pillow 生成完整档案页，并将命中框定位到正文中的实际文字。"""
    from PIL import Image, ImageDraw, ImageFont  # 延迟导入，避免 demo 模块强依赖

    def load_font(size: int) -> Any:
        candidates = [
            Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts" / "msyh.ttc",
            Path(os.environ.get("WINDIR", r"C:\\Windows")) / "Fonts" / "simhei.ttf",
            Path("/usr/share/fonts/opentype/noto/NotoSansCJK-Regular.ttc"),
            Path("/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf"),
        ]
        for candidate in candidates:
            if candidate.exists():
                try:
                    return ImageFont.truetype(str(candidate), size)
                except OSError:
                    continue
        return ImageFont.load_default()

    title_font = load_font(20)
    meta_font = load_font(14)
    body_font = load_font(16)

    def document_lines(occurrence: dict[str, Any]) -> list[str]:
        """构造一页可供校对的完整档案正文，命中上下文保留为其中一行。"""
        return [
            "兹将本卷所载事由，依原件顺序录列如下。",
            "本案所涉往来文书、收讫日期，均已核对存档。",
            "经办人员应按既定章程办理，不得擅改原始记载。",
            "凡需交付之物，应具明细并由双方留存凭据。",
            "如遇字迹漫漶，仍以卷内原文及旁注为准。",
            str(occurrence["context_full"]),
            "其余条款照前页办理，相关附件随卷备查。",
            "本页所列事项，经复核后归入本案档案库。",
            "谨此载明，以便日后检索、校勘与追溯。",
            "立卷日期、卷宗编号及保管信息详见卷首。",
            "以上文字均为本页完整内容的演示性摘录。",
        ]

    def update_bbox_from_body_text(
        occurrence: dict[str, Any], draw: Any, body_x: int, body_y: int
    ) -> tuple[int, int, int, int]:
        """返回正文中命中字符的像素框，同时同步 occurrence 的坐标字段。"""
        before = str(occurrence["context_before"])
        character = str(occurrence["matched_character"])
        char_x = body_x + round(draw.textlength(before, font=body_font))
        raw_x0, raw_y0, raw_x1, raw_y1 = draw.textbbox(
            (char_x, body_y), character, font=body_font
        )
        x0, y0 = max(0, raw_x0 - 2), max(0, raw_y0 - 2)
        x1, y1 = min(int(occurrence["page_image_width"]), raw_x1 + 2), min(
            int(occurrence["page_image_height"]), raw_y1 + 2
        )
        width = float(occurrence["page_image_width"])
        height = float(occurrence["page_image_height"])
        occurrence.update(
            {
                "source_x0": float(x0),
                "source_y0": float(y0),
                "source_x1": float(x1),
                "source_y1": float(y1),
                "normalized_x0": x0 / width,
                "normalized_y0": y0 / height,
                "normalized_x1": x1 / width,
                "normalized_y1": y1 / height,
            }
        )
        return x0, y0, x1, y1

    seen_pages: set[str] = set()
    for occ in occurrences:
        page_id = Path(occ["page_image_relpath"]).stem
        if page_id not in seen_pages:
            seen_pages.add(page_id)
            w = int(occ["page_image_width"])
            h = int(occ["page_image_height"])
            img = Image.new("RGB", (w, h), (250, 246, 238))
            draw = ImageDraw.Draw(img)
            draw.rectangle([40, 40, w - 40, h - 40], outline=(190, 180, 160), width=2)
            draw.text((64, 68), "ArchiveLens 档案校对副本", fill=(65, 54, 40), font=title_font)
            draw.text(
                (64, 102),
                f"{occ['file_name']} · 第 {occ['page_number']} 页 · 演示全文页",
                fill=(90, 78, 60),
                font=meta_font,
            )
            draw.line([64, 132, w - 64, 132], fill=(205, 196, 181), width=1)
            body_x, body_y, line_height = 68, 158, 34
            for line_index, line in enumerate(document_lines(occ)):
                line_y = body_y + line_index * line_height
                draw.text((body_x, line_y), line, fill=(55, 48, 38), font=body_font)
                if line == str(occ["context_full"]):
                    update_bbox_from_body_text(occ, draw, body_x, line_y)
            img.save(pages_dir / f"{page_id}.png")
        # 详情页由前端叠加命中框；截取图单独保留边框，避免整页出现双重高亮。
        w = int(occ["page_image_width"])
        h = int(occ["page_image_height"])
        page_img = Image.open(pages_dir / f"{page_id}.png").convert("RGB")
        # 字符截取图（bbox 区域，加内边距）
        pad = 16
        cx0 = max(0, int(occ["source_x0"]) - pad)
        cy0 = max(0, int(occ["source_y0"]) - pad)
        cx1 = min(w, int(occ["source_x1"]) + pad)
        cy1 = min(h, int(occ["source_y1"]) + pad)
        crop = page_img.crop((cx0, cy0, cx1, cy1))
        crop_draw = ImageDraw.Draw(crop)
        crop_draw.rectangle([1, 1, crop.width - 2, crop.height - 2], outline=(196, 69, 22), width=2)
        crop_id = Path(occ["crop_image_relpath"]).stem
        crop.save(crops_dir / f"{crop_id}.png")


def create_demo(store: TaskStore, workspace_root: Path) -> dict[str, Any]:
    """创建演示任务：写正式 schema + 生成图片 + 标记 completed。"""
    real_task_id = store.create_task(
        source_dir="<演示数据>",
        output_dir="",
        workspace_dir="",
        name="演示任务",
        is_demo=True,
        file_count=len(DEMO_DOCUMENTS),
        total_pages=5,
        status="running",
    )
    task_dir = workspace_root / real_task_id
    pages_dir = task_dir / "pages"
    crops_dir = task_dir / "crops"
    pages_dir.mkdir(parents=True, exist_ok=True)
    crops_dir.mkdir(parents=True, exist_ok=True)

    occurrences = _build_occurrences()
    _render_images(pages_dir, crops_dir, occurrences)

    count = store.add_occurrences(real_task_id, occurrences)
    store.update_task(
        real_task_id,
        status="completed",
        processed_pages=5,
        total_pages=5,
        occurrence_count=count,
        finished_at=now_iso(),
        output_dir=str(task_dir),
        workspace_dir=str(task_dir),
    )

    return {
        "task_id": real_task_id,
        "workspace_dir": str(task_dir),
        "status": "completed",
        "occurrence_count": count,
        "is_demo": True,
    }


__all__ = ["create_demo", "DEMO_DOCUMENTS"]
