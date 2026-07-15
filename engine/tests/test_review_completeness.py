"""校对工作台分页、统计和导出完整性的回归测试。"""

from __future__ import annotations

import json
import shutil
import tempfile
import unittest
from pathlib import Path

from PIL import Image

from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import Server


class ReviewCompletenessTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.server = Server(workspace_root=self.tmp)

    def tearDown(self) -> None:
        self.server.store.close()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def _seed_task(self, count: int, *, status: str = "completed") -> str:
        task_id = self.server.store.create_task(
            name="large-review-set",
            search_terms=["档案"],
            search_mode="exact_literal",
            status=status,
        )
        items = [
            {
                "occurrence_id": f"{task_id}-occ-{index:04d}",
                "source_id": "seed.pdf",
                "file_name": f"document-{index // 100:02d}.pdf",
                "relative_path": f"document-{index // 100:02d}.pdf",
                "page_number": (index // 4) + 1,
                "page_occurrence_index": index % 4,
                "matched_text": "档案",
                "match_start": 0,
                "match_end": 2,
                "bbox_hash": f"seed-bbox-{index:04d}",
                "context_full": f"档案结果 {index}",
                "verification_status": "needs_review",
            }
            for index in range(count)
        ]
        self.server.store.add_occurrences(task_id, items)
        return task_id

    def test_results_query_reports_complete_page_contract_and_review_summary(self) -> None:
        task_id = self._seed_task(201)
        first = self.server.handlers["results.query"](
            self.server, {"task_id": task_id, "limit": 100, "offset": 0}
        )
        self.assertEqual(first["total"], 201)
        self.assertEqual(first["limit"], 100)
        self.assertEqual(first["offset"], 0)
        self.assertTrue(first["has_more"])
        self.assertEqual(first["review_summary"], {
            "reviewed_count": 0,
            "unreviewed_count": 201,
            "confirmed_count": 0,
            "needs_review_count": 0,
            "rejected_count": 0,
        })
        self.assertTrue(first["scan_complete"])
        self.assertFalse(first["review_complete"])

        for item, decision in zip(first["items"][:3], ("confirmed", "needs_review", "rejected"), strict=True):
            self.server.handlers["review.updateDecision"](
                self.server,
                {"task_id": task_id, "occurrence_id": item["occurrence_id"], "decision": decision},
            )
        refreshed = self.server.handlers["results.query"](
            self.server, {"task_id": task_id, "limit": 100, "offset": 0}
        )
        self.assertEqual(refreshed["review_summary"], {
            "reviewed_count": 3,
            "unreviewed_count": 198,
            "confirmed_count": 1,
            "needs_review_count": 1,
            "rejected_count": 1,
        })

    def test_page_walk_over_1000_results_is_stable_without_duplicates_or_omissions(self) -> None:
        task_id = self._seed_task(1000)
        collected: list[str] = []
        for offset in range(0, 1000, 100):
            page = self.server.handlers["results.query"](
                self.server, {"task_id": task_id, "limit": 100, "offset": offset}
            )
            self.assertEqual(page["offset"], offset)
            self.assertEqual(page["limit"], 100)
            self.assertEqual(page["has_more"], offset < 900)
            collected.extend(item["occurrence_id"] for item in page["items"])

        database_total, database_items = self.server.store.query_occurrences(
            task_id=task_id, limit=1000, offset=0
        )
        database_ids = [item["occurrence_id"] for item in database_items]
        self.assertEqual(database_total, 1000)
        self.assertEqual(collected, database_ids)
        self.assertEqual(len(collected), len(set(collected)))

    def test_results_query_rejects_invalid_page_parameters(self) -> None:
        task_id = self._seed_task(1)
        for params in (
            {"limit": 0, "offset": 0},
            {"limit": -1, "offset": 0},
            {"limit": 201, "offset": 0},
            {"limit": 100, "offset": -1},
            {"limit": "100", "offset": 0},
        ):
            with self.subTest(params=params):
                with self.assertRaises(ProtocolError) as raised:
                    self.server.handlers["results.query"](self.server, {"task_id": task_id, **params})
                self.assertEqual(raised.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_page_boundaries_and_review_filters_keep_total_and_summary_aligned(self) -> None:
        for count in (0, 1, 99, 100, 199, 200, 201, 401, 1000):
            with self.subTest(count=count):
                task_id = self._seed_task(count)
                total, items = self.server.store.query_occurrences(
                    task_id=task_id, limit=100, offset=max(0, count - 1)
                )
                self.assertEqual(total, count)
                self.assertEqual(len(items), 0 if count == 0 else 1)

        task_id = self._seed_task(4)
        _total, items = self.server.store.query_occurrences(task_id=task_id, limit=4, offset=0)
        for item, decision in zip(items[:3], ("confirmed", "needs_review", "rejected"), strict=True):
            self.server.store.upsert_review(task_id=task_id, occurrence_id=item["occurrence_id"], decision=decision)
        for status, expected_total in (("confirmed", 1), ("needs_review", 1), ("rejected", 1), ("unreviewed", 1)):
            with self.subTest(status=status):
                result = self.server.handlers["results.query"](
                    self.server, {"task_id": task_id, "limit": 100, "offset": 0, "status": status}
                )
                self.assertEqual(result["total"], expected_total)
                self.assertEqual(result["review_summary"]["reviewed_count"], 0 if status == "unreviewed" else 1)

    def test_export_uses_all_database_ids_and_marks_incomplete_review(self) -> None:
        task_id = self._seed_task(201)
        first_page = self.server.handlers["results.query"](
            self.server, {"task_id": task_id, "limit": 100, "offset": 0}
        )
        self.server.handlers["review.updateDecision"](
            self.server,
            {"task_id": task_id, "occurrence_id": first_page["items"][0]["occurrence_id"], "decision": "confirmed"},
        )
        exported = self.server.handlers["export.json"](self.server, {"task_id": task_id})
        payload = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
        database_total, database_items = self.server.store.query_occurrences(
            task_id=task_id, limit=1000, offset=0
        )
        self.assertEqual(exported["occurrence_count"], database_total)
        self.assertEqual(
            [item["occurrence_id"] for item in payload["occurrences"]],
            [item["occurrence_id"] for item in database_items],
        )
        self.assertEqual(payload["integrity"]["total_occurrences"], 201)
        self.assertEqual(payload["integrity"]["exported_occurrences"], 201)
        self.assertEqual(payload["integrity"]["reviewed_count"], 1)
        self.assertEqual(payload["integrity"]["unreviewed_count"], 200)
        self.assertFalse(payload["integrity"]["review_complete"])
        self.assertTrue(payload["integrity"]["export_complete"])
        self.assertFalse(payload["integrity"]["fully_verified"])

    def test_running_task_never_reports_review_complete(self) -> None:
        task_id = self._seed_task(1, status="running")
        item = self.server.store.query_occurrences(task_id=task_id, limit=1, offset=0)[1][0]
        self.server.store.upsert_review(
            task_id=task_id, occurrence_id=item["occurrence_id"], decision="confirmed"
        )
        result = self.server.handlers["results.query"](
            self.server, {"task_id": task_id, "limit": 100, "offset": 0}
        )
        self.assertEqual(result["review_summary"]["unreviewed_count"], 0)
        self.assertFalse(result["scan_complete"])
        self.assertFalse(result["review_complete"])

    def test_completed_fully_reviewed_export_is_marked_fully_verified_in_json_and_html(self) -> None:
        task_id = self._seed_task(1)
        workspace = Path(self.tmp) / "review-completeness-assets"
        (workspace / "pages").mkdir(parents=True)
        Image.new("RGB", (80, 60), "white").save(workspace / "pages" / "page.png")
        self.server.store.update_task(task_id, workspace_dir=str(workspace), is_demo=1)
        self.server.store.conn.execute(
            "UPDATE occurrences SET page_image_relpath=?, page_image_width=?, page_image_height=? WHERE task_id=?",
            ("pages/page.png", 80, 60, task_id),
        )
        self.server.store.conn.commit()
        item = self.server.store.query_occurrences(task_id=task_id, limit=1, offset=0)[1][0]
        self.server.store.upsert_review(
            task_id=task_id, occurrence_id=item["occurrence_id"], decision="confirmed", note="已核验"
        )
        json_result = self.server.handlers["export.json"](self.server, {"task_id": task_id})
        html_result = self.server.handlers["export.html"](self.server, {"task_id": task_id})
        payload = json.loads(Path(json_result["path"]).read_text(encoding="utf-8"))
        html = Path(html_result["path"]).read_text(encoding="utf-8")
        self.assertTrue(payload["integrity"]["scan_complete"])
        self.assertTrue(payload["integrity"]["review_complete"])
        self.assertTrue(payload["integrity"]["export_complete"])
        self.assertTrue(payload["integrity"]["fully_verified"])
        self.assertIn("扫描和校对均已完成，报告结果已完整核验", html)
        self.assertIn("已核验", html)


if __name__ == "__main__":
    unittest.main()
