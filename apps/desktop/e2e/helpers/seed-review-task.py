from __future__ import annotations

import json
import os
import sys
from pathlib import Path

from PIL import Image, ImageDraw, ImageFont

from archivelens_engine.db.store import TaskStore


def _layout_font(size: int) -> ImageFont.FreeTypeFont | ImageFont.ImageFont:
    fonts = Path(os.environ.get("WINDIR", r"C:\Windows")) / "Fonts"
    for name in ("simsun.ttc", "msyh.ttc"):
        candidate = fonts / name
        if candidate.exists():
            return ImageFont.truetype(str(candidate), size)
    return ImageFont.load_default()


def _seed_layout_context_task(store: TaskStore, root: Path) -> dict[str, object]:
    workspace = root / "tasks" / "layout-context"
    pages = workspace / "pages"
    pages.mkdir(parents=True, exist_ok=True)
    page_path = pages / "page-001.png"
    image = Image.new("RGB", (608, 764), "#fbf7ed")
    draw = ImageDraw.Draw(image)
    font = _layout_font(18)
    top_lines = [
        ("塋地已令查明給還其因獲罪草進之世職亦", [[166, 103], [190, 103], [195, 361], [171, 362]]),
        ("至其虧空錢粮已令該部查奏寬免其入官之墳", [[193, 105], [216, 105], [216, 360], [194, 360]]),
        ("即位以來軫念伊等生計艱難頻頒賞賚優卹備", [[217, 105], [239, 105], [240, 360], [219, 361]]),
    ]
    bottom_lines = [
        ("廉以贍給家口倘伊等不知痛改前非仍為覆轍", [[171, 411], [191, 411], [195, 664], [175, 664]]),
        ("權用外任上為國家効力辯公下亦可得俸祿養", [[194, 409], [216, 409], [219, 666], [198, 666]]),
        ("裕可免窘乏之虞況旗負內之老成護慎者可望", [[217, 409], [239, 409], [244, 665], [222, 665]]),
    ]
    for text, bbox in [*top_lines, *bottom_lines]:
        x = bbox[0][0]
        y = bbox[0][1]
        for character in text:
            draw.text((x, y), character, font=font, fill="#1f1812")
            y += 13.5
    image.save(page_path, format="PNG")

    task_id = store.create_task(
        name="layout context visual",
        source_dir=str(workspace),
        output_dir=str(workspace),
        workspace_dir=str(workspace),
        status="running",
        total_pages=1,
        search_terms=["虧空"],
        search_mode="exact_literal",
        layout_mode="auto",
        is_demo=True,
    )
    lines = []
    for line_index, (text, bbox) in enumerate([*top_lines, *bottom_lines]):
        lines.append({
            "line_index": line_index,
            "raw_text": text,
            "resolved_text": text,
            "confidence": 0.95,
            "bbox": bbox,
            "search_forms": {
                "simplified": text,
                "traditional": text,
                "taiwan": text,
                "hong_kong": text,
            },
        })
    occurrence_id = "occ-layout-0001"
    store.record_page_completion(
        task_id=task_id,
        source_id="source-layout.pdf",
        page_no=1,
        worker_generation=1,
        occurrences=[{
            "occurrence_id": occurrence_id,
            "document_id": "document-layout",
            "source_id": "source-layout.pdf",
            "file_name": "layout-source.pdf",
            "relative_path": "layout-source.pdf",
            "page_number": 1,
            "page_index": 0,
            "page_occurrence_index": 1,
            "matched_text": "虧空",
            "match_start": 2,
            "match_end": 4,
            "line_index": 1,
            "bbox_hash": "bbox-layout-0001",
            "context_full": "旧版错误上下文",
            "verification_status": "confirmed",
            "ocr_confidence": 0.95,
            "source_page_width": 608,
            "source_page_height": 764,
            "source_x0": 193,
            "source_y0": 132,
            "source_x1": 216,
            "source_y1": 159,
            "normalized_x0": 193 / 608,
            "normalized_y0": 132 / 764,
            "normalized_x1": 216 / 608,
            "normalized_y1": 159 / 764,
            "page_image_relpath": "pages/page-001.png",
            "page_image_width": 608,
            "page_image_height": 764,
        }],
        ocr_page={
            "document_id": "document-layout",
            "page_no": 1,
            "page_index": 0,
            "source_page_width": 608,
            "source_page_height": 764,
            "model": {
                "id": "PP-OCRv6-small",
                "source_version": "RapidOCR-3.9.1",
                "sha256": "a" * 64,
            },
            "lines": lines,
        },
    )
    store.update_task(task_id, status="completed")
    return {"taskId": task_id, "occurrenceIds": [occurrence_id]}


def main(user_data_dir: str, count_text: str) -> None:
    root = Path(user_data_dir) / "engine"
    root.mkdir(parents=True, exist_ok=True)
    store = TaskStore(root / "archivelens.db")
    try:
        if count_text == "layout":
            print(json.dumps(_seed_layout_context_task(store, root), ensure_ascii=False))
            return
        task_id = store.create_task(
            name="review completeness",
            search_terms=["档案"],
            search_mode="exact_literal",
            status="completed",
        )
        items = []
        for index in range(int(count_text)):
            items.append(
                {
                    "occurrence_id": f"occ-{index:04d}",
                    "document_id": f"document-{index // 100:02d}",
                    "source_id": f"document-{index // 100:02d}.pdf",
                    "file_name": f"document-{index // 100:02d}.pdf",
                    "relative_path": f"document-{index // 100:02d}.pdf",
                    "page_number": index // 4 + 1,
                    "page_occurrence_index": index % 4,
                    "matched_text": "档案",
                    "match_start": 0,
                    "match_end": 2,
                    "bbox_hash": f"bbox-{index:04d}",
                    "context_full": f"档案结果 {index}",
                    "verification_status": "needs_review",
                }
            )
        store.add_occurrences(task_id, items)
        print(
            json.dumps(
                {
                    "taskId": task_id,
                    "occurrenceIds": [item["occurrence_id"] for item in items],
                },
                ensure_ascii=False,
            )
        )
    finally:
        store.close()


if __name__ == "__main__":
    if len(sys.argv) != 3:
        raise SystemExit("usage: seed-review-task.py <user-data-dir> <count>")
    main(sys.argv[1], sys.argv[2])
