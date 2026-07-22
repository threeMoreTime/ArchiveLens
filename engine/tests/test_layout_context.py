from __future__ import annotations

import unittest
from unittest.mock import patch

import archivelens_engine.layout_context as layout_context_module
from archivelens_engine.layout_context import (
    LAYOUT_CONTEXT_VERSION,
    MAX_LAYOUT_CANDIDATE_BLOCKS,
    MAX_LAYOUT_PARTITION_LINES,
    build_layout_context,
    build_occurrence_layout_context,
)


class LayoutContextTests(unittest.TestCase):
    def test_vertical_context_keeps_only_neighbouring_columns_in_same_block(self) -> None:
        lines = [
            {
                "ocr_line_id": "line-left-top",
                "line_index": 6,
                "raw_text": "塋地已令查明給還其因獲罪草進之世職亦",
                "bbox": [[166, 103], [190, 103], [195, 361], [171, 362]],
            },
            {
                "ocr_line_id": "line-target-top",
                "line_index": 7,
                "raw_text": "至其虧空錢粮已令該部查奏寬免其入官之墳",
                "bbox": [[193, 105], [216, 105], [216, 360], [194, 360]],
            },
            {
                "ocr_line_id": "line-right-top",
                "line_index": 8,
                "raw_text": "即位以來軫念伊等生計艱難頻頒賞賚優卹備",
                "bbox": [[217, 105], [239, 105], [240, 360], [219, 361]],
            },
            {
                "ocr_line_id": "line-left-bottom",
                "line_index": 22,
                "raw_text": "廉以贍給家口倘伊等不知痛改前非仍為覆轍",
                "bbox": [[171, 411], [191, 411], [195, 664], [175, 664]],
            },
            {
                "ocr_line_id": "line-target-bottom",
                "line_index": 23,
                "raw_text": "權用外任上為國家効力辯公下亦可得俸祿養",
                "bbox": [[194, 409], [216, 409], [219, 666], [198, 666]],
            },
            {
                "ocr_line_id": "line-right-bottom",
                "line_index": 24,
                "raw_text": "裕可免窘乏之虞況旗負內之老成護慎者可望",
                "bbox": [[217, 409], [239, 409], [244, 665], [222, 665]],
            },
        ]

        context = build_layout_context(
            lines,
            target_line_index=7,
            match_start=2,
            match_end=4,
            layout_mode="auto",
            page_width=608,
            page_height=764,
        )

        self.assertEqual(context["version"], LAYOUT_CONTEXT_VERSION)
        self.assertEqual(context["status"], "ready")
        self.assertEqual(context["orientation"], "vertical")
        self.assertEqual(
            [item["ocr_line_id"] for item in context["items"]],
            ["line-right-top", "line-target-top", "line-left-top"],
        )
        self.assertEqual(context["items"][1]["text"][2:4], "虧空")
        self.assertEqual(context["items"][1]["role"], "target")
        self.assertNotIn("權用外任", context["plain_text"])
        self.assertEqual(len(context["candidate_blocks"]), 2)
        self.assertAlmostEqual(context["items"][0]["normalized_bbox"]["x0"], 217 / 608)

    def test_horizontal_context_selects_previous_target_and_next_rows(self) -> None:
        lines = [
            {"line_index": 0, "raw_text": "第一行文字", "bbox": (20, 20, 220, 42)},
            {"line_index": 1, "raw_text": "第二行命中文字", "bbox": (20, 46, 240, 68)},
            {"line_index": 2, "raw_text": "第三行文字", "bbox": (20, 72, 220, 94)},
            {"line_index": 3, "raw_text": "另一版块", "bbox": (20, 220, 220, 242)},
        ]
        context = build_layout_context(
            lines,
            target_line_index=1,
            match_start=3,
            match_end=5,
            page_width=300,
            page_height=300,
        )
        self.assertEqual(context["orientation"], "horizontal")
        self.assertEqual([item["line_index"] for item in context["items"]], [0, 1, 2])
        self.assertNotIn("另一版块", context["plain_text"])

    def test_uncertain_single_line_never_invents_neighbours(self) -> None:
        context = build_layout_context(
            [{"line_index": 4, "raw_text": "方形文字", "bbox": (10, 10, 50, 50)}],
            target_line_index=4,
            match_start=0,
            match_end=1,
            page_width=100,
            page_height=100,
        )
        self.assertEqual(context["status"], "uncertain")
        self.assertEqual(context["reason"], "orientation_uncertain")
        self.assertEqual(len(context["items"]), 1)

    def test_existing_occurrence_is_located_from_match_and_source_bbox(self) -> None:
        lines = [
            {
                "ocr_line_id": "line-7",
                "line_index": 7,
                "raw_text": "至其虧空錢粮已令該部查奏",
                "bbox": [[193, 105], [216, 105], [216, 360], [194, 360]],
            },
            {
                "ocr_line_id": "line-8",
                "line_index": 8,
                "raw_text": "即位以來軫念伊等生計艱難",
                "bbox": [[217, 105], [239, 105], [240, 360], [219, 361]],
            },
        ]
        occurrence = {
            "matched_text": "虧空",
            "match_start": 2,
            "match_end": 4,
            "source_x0": 193,
            "source_y0": 131.8,
            "source_x1": 216,
            "source_y1": 158.7,
            "source_page_width": 608,
            "source_page_height": 764,
        }
        context = build_occurrence_layout_context(lines, occurrence)
        self.assertEqual(context["target_line_index"], 7)
        self.assertEqual(context["target_ocr_line_id"], "line-7")

    def test_pathological_pages_bound_partition_work_and_candidate_payload(self) -> None:
        lines = [
            {
                "ocr_line_id": f"line-{index}",
                "line_index": index,
                "raw_text": "档案",
                "bbox": (10, index * 40, 210, index * 40 + 10),
            }
            for index in range(MAX_LAYOUT_PARTITION_LINES * 2)
        ]
        with patch(
            "archivelens_engine.layout_context._partition_blocks",
            wraps=layout_context_module._partition_blocks,
        ) as partition:
            context = build_layout_context(
                lines,
                target_line_index=len(lines) - 1,
                match_start=0,
                match_end=1,
                layout_mode="horizontal",
                page_width=300,
                page_height=len(lines) * 40,
            )

        partitioned_lines = partition.call_args.args[0]
        self.assertLessEqual(len(partitioned_lines), MAX_LAYOUT_PARTITION_LINES)
        self.assertLessEqual(len(context["candidate_blocks"]), MAX_LAYOUT_CANDIDATE_BLOCKS)
        self.assertTrue(any(block["contains_target"] for block in context["candidate_blocks"]))


if __name__ == "__main__":
    unittest.main()
