from __future__ import annotations

import base64
import hashlib
import html
import io
import json
import re
import tempfile
import unittest
from pathlib import Path
from unittest import mock

from PIL import Image

from archivelens_engine.html_export import (
    _format_file_size,
    build_offline_review_report,
    write_offline_review_report,
)


def integrity(*, complete: bool = False) -> dict[str, object]:
    return {
        "reviewed_count": 1,
        "unreviewed_count": 1,
        "confirmed_count": 1,
        "needs_review_count": 0,
        "rejected_count": 0,
        "scan_complete": complete,
        "review_complete": complete,
        "fully_verified": complete,
    }


def occurrence(
    *,
    occurrence_id: str,
    page_relpath: str,
    matched_text: str,
    x0: float,
    global_sequence: int = 1,
) -> dict[str, object]:
    return {
        "occurrence_id": occurrence_id,
        "global_sequence": global_sequence,
        "document_id": "document-1",
        "file_name": "档案一.pdf",
        "relative_path": "卷一/档案一.pdf",
        "page_number": 12,
        "page_occurrence_index": 1,
        "matched_text": matched_text,
        "context_before": "双方应按照本协议",
        "context_after": "定的期限完成交付",
        "context_full": f"双方应按照本协议{matched_text}定的期限完成交付",
        "ocr_confidence": 0.84,
        "review_decision": "confirmed" if occurrence_id == "hit-1" else None,
        "review_note": "已核对原文" if occurrence_id == "hit-1" else "",
        "page_image_relpath": page_relpath,
        "normalized_x0": x0,
        "normalized_y0": 0.2,
        "normalized_x1": x0 + 0.1,
        "normalized_y1": 0.3,
    }


class HtmlExportTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temp = tempfile.TemporaryDirectory()
        self.root = Path(self.temp.name)
        pages = self.root / "pages"
        pages.mkdir()
        Image.new("RGB", (3000, 1200), "white").save(pages / "page-12.png")
        self.items = [
            occurrence(
                occurrence_id="hit-1",
                page_relpath="pages/page-12.png",
                matched_text="约",
                x0=0.1,
                global_sequence=1,
            ),
            occurrence(
                occurrence_id="hit-2",
                page_relpath="pages/page-12.png",
                matched_text="約",
                x0=0.5,
                global_sequence=2,
            ),
        ]
        self.task = {"name": "档案检索", "search_text": "约 / 約", "workspace_dir": str(self.root)}

    def tearDown(self) -> None:
        self.temp.cleanup()

    def build(self, *, items: list[dict[str, object]] | None = None, complete: bool = False) -> str:
        return build_offline_review_report(
            task=self.task,
            items=items if items is not None else self.items,
            integrity=integrity(complete=complete),
            workspace_dir=self.root,
            exported_at="2026-07-14T12:00:00+00:00",
        )

    def test_groups_same_page_and_embeds_one_original_image(self) -> None:
        progress: list[tuple[str, int, int]] = []
        with mock.patch("archivelens_engine.html_export.Image.open", wraps=Image.open) as open_image:
            report = build_offline_review_report(
                task=self.task,
                items=self.items,
                integrity=integrity(),
                workspace_dir=self.root,
                exported_at="2026-07-14T12:00:00+00:00",
                progress=lambda stage, completed, total: progress.append((stage, completed, total)),
            )

        self.assertEqual(open_image.call_count, 1)
        self.assertEqual(progress, [("images", 1, 1), ("building", 1, 1), ("writing", 2, 2)])
        self.assertEqual(report.count("data:image/png;base64,"), 1)
        encoded = re.search(r"data:image/png;base64,([A-Za-z0-9+/=]+)", report)
        self.assertIsNotNone(encoded)
        embedded_bytes = base64.b64decode(encoded.group(1))
        self.assertEqual(embedded_bytes, (self.root / "pages" / "page-12.png").read_bytes())
        with Image.open(io.BytesIO(embedded_bytes)) as image:
            self.assertEqual(image.format, "PNG")
            self.assertEqual(image.size, (3000, 1200))
        self.assertIn('"pageCount":1', report)
        self.assertIn('"hitCount":2', report)
        self.assertIn('"x0":0.1', report)
        self.assertIn('"x0":0.5', report)

    def test_deduplicates_same_page_when_permanent_sequences_are_not_contiguous(self) -> None:
        Image.new("RGB", (1200, 1600), "white").save(self.root / "pages" / "page-13.png")
        first_page_late_hit = occurrence(
            occurrence_id="hit-3",
            page_relpath="pages/page-12.png",
            matched_text="约",
            x0=0.7,
            global_sequence=3,
        )
        second_page_hit = occurrence(
            occurrence_id="hit-page-13",
            page_relpath="pages/page-13.png",
            matched_text="約",
            x0=0.3,
            global_sequence=2,
        )
        second_page_hit["page_number"] = 13

        output = self.root / "non-contiguous-report.html"
        resolver = mock.Mock(side_effect=lambda item: {
            "asset_relpath": item["page_image_relpath"],
            "pixel_width": 1200,
            "pixel_height": 1600,
        })
        write_offline_review_report(
            output_path=output,
            task=self.task,
            items=iter([self.items[0], second_page_hit, first_page_late_hit]),
            integrity=integrity(),
            workspace_dir=self.root,
            exported_at="2026-07-14T12:00:00+00:00",
            expected_page_count=2,
            page_image_resolver=resolver,
        )
        report = output.read_text(encoding="utf-8")

        script_match = re.search(r"const DATA=(.*?);\nconst STATUS_RANK=", report, re.DOTALL)
        self.assertIsNotNone(script_match)
        data = json.loads(script_match.group(1))
        self.assertEqual(data["pageCount"], 2)
        self.assertEqual(len(data["pages"]), 2)
        self.assertEqual(resolver.call_count, 2)
        self.assertEqual(report.count("data:image/png;base64,"), 2)
        self.assertEqual(
            [record["hit"]["globalSequence"] for record in data["records"]],
            [1, 2, 3],
        )

    def test_includes_filters_paging_modal_and_a4_print_contract(self) -> None:
        report = self.build()

        for value in ("10", "20", "50", "100"):
            self.assertIn(f'<option value="{value}"', report)
        self.assertIn('id="file-filter"', report)
        self.assertIn('id="status-filter"', report)
        self.assertIn('id="report-search"', report)
        self.assertIn('id="sort-order"', report)
        self.assertIn('<option value="sequence" selected>序号升序</option>', report)
        self.assertIn('id="record-nav"', report)
        self.assertIn('id="record-nav-toggle"', report)
        self.assertIn('id="record-nav-reveal"', report)
        self.assertIn('id="record-nav-mobile-toggle"', report)
        self.assertIn('id="record-nav-count"', report)
        self.assertIn('id="record-nav-reveal-count"', report)
        self.assertIn('id="record-nav-mobile-count"', report)
        self.assertIn('aria-label="全部筛选结果导航"', report)
        self.assertIn('id="image-modal"', report)
        self.assertIn('id="back-top"', report)
        self.assertIn("@page{size:A4 portrait", report)
        self.assertIn("beforeprint", report)
        self.assertIn('state.file="";state.status="";state.query=""', report)
        self.assertIn("Object.assign(state,saved)", report)
        self.assertIn("当前筛选条件不会影响打印内容", report)
        self.assertNotIn("contenteditable", report.lower())

    def test_uses_permanent_sequence_and_occurrence_first_card_contract(self) -> None:
        report = self.build()
        script_match = re.search(r"const DATA=(.*?);\nconst STATUS_RANK=", report, re.DOTALL)
        self.assertIsNotNone(script_match)
        data = json.loads(script_match.group(1))

        self.assertEqual(
            [record["hit"]["globalSequence"] for record in data["records"]],
            [1, 2],
        )
        self.assertIn('sort:"sequence"', report)
        self.assertIn('sequenceLabel=(value)=>`#${String(value).padStart(4,"0")}`', report)
        self.assertIn('card.append(head,hitNode(hit),button)', report)
        self.assertIn('button.append(imageStage(page,[hit]))', report)
        self.assertIn('state.filtered.forEach((record)=>host.append(recordNavItem(record)))', report)
        self.assertIn('target.scrollIntoView', report)
        self.assertIn('button.title=record.page.relativePath', report)
        self.assertIn('.occurrence-card.print-break{break-before:page}', report)

    def test_navigation_fully_releases_desktop_width_and_tracks_current_record(self) -> None:
        report = self.build()

        self.assertIn(
            '.review-layout.nav-collapsed{grid-template-columns:0 minmax(0,1fr);gap:0}',
            report,
        )
        self.assertIn('.nav-collapsed .record-nav-reveal{display:inline-grid}', report)
        self.assertIn('@media(max-width:900px)', report)
        self.assertIn('.record-nav-mobile-toggle{display:flex}', report)
        self.assertIn('@media(prefers-reduced-motion:reduce)', report)
        self.assertIn('.nav-collapsed .record-nav{transition:none}', report)
        self.assertIn('button.setAttribute("aria-current","location")', report)
        self.assertIn('scheduleActiveSync()', report)
        self.assertIn('setCountBadge("record-nav-reveal-count",count)', report)
        self.assertIn(
            'state={file:"",status:"",query:"",sort:"sequence",pageSize:20,page:1,'
            'printMode:false,printSnapshot:null,filtered:[],modalIndex:-1,navCollapsed:false',
            report,
        )
        self.assertNotIn('localStorage', report)

    def test_uses_hashed_csp_and_serializes_untrusted_content_without_dom_html_injection(self) -> None:
        self.task["name"] = '<script>alert("task")</script>'
        self.items[0]["review_note"] = '<img src=x onerror=alert("note")>'

        report = self.build()

        script = re.search(r"<script>(.*)</script>", report, re.DOTALL)
        self.assertIsNotNone(script)
        script_hash = base64.b64encode(hashlib.sha256(script.group(1).encode("utf-8")).digest()).decode("ascii")
        csp_match = re.search(r'Content-Security-Policy" content="([^"]+)"', report)
        self.assertIsNotNone(csp_match)
        csp = html.unescape(csp_match.group(1))
        self.assertIn(f"script-src 'sha256-{script_hash}'", csp)
        self.assertIn("default-src 'none'", csp)
        self.assertIn("connect-src 'none'", csp)
        self.assertNotIn('<script>alert("task")</script>', report)
        self.assertNotIn('<img src=x onerror=alert("note")>', report)
        self.assertIn("\\u003cscript\\u003e", report)
        self.assertNotIn(".innerHTML", script.group(1))
        self.assertNotRegex(report, r"<[^>]+\son[a-z]+=")

    def test_does_not_expose_workspace_path_and_rejects_asset_path_escape(self) -> None:
        outside = self.root.parent / "outside-report-image.png"
        Image.new("RGB", (20, 20), "red").save(outside)
        try:
            escaped = occurrence(
                occurrence_id="hit-outside",
                page_relpath="../outside-report-image.png",
                matched_text="约",
                x0=0.2,
            )
            escaped["file_name"] = r"F:\private\档案一.pdf"
            escaped["relative_path"] = r"F:\private\卷一\档案一.pdf"

            report = self.build(items=[escaped])

            self.assertNotIn(str(self.root), report)
            self.assertNotIn(str(outside), report)
            self.assertNotIn(r"F:\private", report)
            self.assertIn("档案一.pdf", report)
            self.assertNotIn("data:image/jpeg;base64,", report)
            self.assertIn("页面图片未生成或当前不可用", report)
        finally:
            outside.unlink(missing_ok=True)

    def test_reports_exact_utf8_file_size_and_stage_or_final_status(self) -> None:
        stage = self.build()
        final = self.build(complete=True)

        self.assertIn(_format_file_size(len(stage.encode("utf-8"))), stage)
        self.assertIn("阶段性报告", stage)
        self.assertIn("最终报告", final)
        self.assertIn("扫描和校对均已完成", final)

    def test_keeps_cross_directory_same_name_sources_distinct_and_ordered(self) -> None:
        first = occurrence(
            occurrence_id="first",
            page_relpath="",
            matched_text="约",
            x0=0.1,
        )
        first.update({
            "document_id": "document-z",
            "source_id": "source-z",
            "source_ordinal": 0,
            "source_display_path": r"F:\\甲\\同名\\档案.pdf",
            "relative_path": r"F:\\甲\\同名\\档案.pdf",
            "file_name": "档案.pdf",
        })
        second = occurrence(
            occurrence_id="second",
            page_relpath="",
            matched_text="約",
            x0=0.2,
        )
        second.update({
            "document_id": "document-a",
            "source_id": "source-a",
            "source_ordinal": 1,
            "source_display_path": r"G:\\乙\\同名\\档案.pdf",
            "relative_path": r"G:\\乙\\同名\\档案.pdf",
            "file_name": "档案.pdf",
        })

        report = self.build(items=[first, second])
        script_match = re.search(r"const DATA=(.*?);\nconst STATUS_RANK=", report, re.DOTALL)
        self.assertIsNotNone(script_match)
        data = json.loads(script_match.group(1))

        self.assertEqual(data["sourceCount"], 2)
        self.assertEqual(len({file["value"] for file in data["files"]}), 2)
        self.assertTrue(all(file["value"].startswith("source-") for file in data["files"]))
        self.assertEqual([page["sourceOrder"] for page in data["pages"]], [0, 1])
        self.assertEqual(len({page["relativePath"] for page in data["pages"]}), 2)
        self.assertNotIn(r"F:\\甲", report)
        self.assertNotIn(r"G:\\乙", report)
        self.assertIn("page.sourceId!==state.file", report)

    def test_stream_writer_consumes_one_shot_items_and_atomically_replaces_output(self) -> None:
        output = self.root / "exports" / "report.html"
        output.parent.mkdir()
        output.write_text("old report", encoding="utf-8")

        def one_shot_items():
            yield from self.items

        result = write_offline_review_report(
            output_path=output,
            task=self.task,
            items=one_shot_items(),
            integrity=integrity(),
            workspace_dir=self.root,
            exported_at="2026-07-14T12:00:00+00:00",
            expected_page_count=1,
        )

        self.assertEqual(result["hit_count"], 2)
        self.assertEqual(result["page_count"], 1)
        self.assertEqual(result["file_size_bytes"], output.stat().st_size)
        self.assertTrue(output.read_text(encoding="utf-8").startswith("<!doctype html>"))
        self.assertEqual(list(output.parent.glob(".archivelens-export-*")), [])

    def test_verified_page_resolver_runs_once_per_page_and_records_pixel_size(self) -> None:
        evidence = self.root / "pages" / "verified-page.png"
        Image.new("RGBA", (4096, 2048), (255, 255, 255, 0)).save(evidence, "PNG")
        output = self.root / "verified-report.html"
        resolver = mock.Mock(return_value={
            "asset_relpath": "pages/verified-page.png",
            "pixel_width": 4096,
            "pixel_height": 2048,
        })

        write_offline_review_report(
            output_path=output,
            task=self.task,
            items=iter(self.items),
            integrity=integrity(),
            workspace_dir=self.root,
            exported_at="2026-07-14T12:00:00+00:00",
            expected_page_count=1,
            page_image_resolver=resolver,
        )

        resolver.assert_called_once_with(self.items[0])
        report = output.read_text(encoding="utf-8")
        self.assertIn('"pixelWidth":4096', report)
        self.assertIn('"pixelHeight":2048', report)
        self.assertEqual(report.count("data:image/png;base64,"), 1)

    def test_verified_page_failure_does_not_overwrite_existing_report(self) -> None:
        output = self.root / "existing-report.html"
        output.write_text("previous verified report", encoding="utf-8")

        with self.assertRaises(RuntimeError):
            write_offline_review_report(
                output_path=output,
                task=self.task,
                items=iter(self.items),
                integrity=integrity(),
                workspace_dir=self.root,
                exported_at="2026-07-14T12:00:00+00:00",
                expected_page_count=1,
                page_image_resolver=mock.Mock(side_effect=RuntimeError("source changed")),
            )

        self.assertEqual(output.read_text(encoding="utf-8"), "previous verified report")


if __name__ == "__main__":
    unittest.main()
