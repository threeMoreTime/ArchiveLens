"""Server handlers 纵向闭环测试（demo → results → review → export → events）。"""

from __future__ import annotations

import io
import json
import shutil
import sys
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path
from unittest import mock

from PIL import Image

from archivelens_engine.protocol import ErrorCode, ProtocolError
from archivelens_engine.server import Server


class HandlersTests(unittest.TestCase):
    def setUp(self) -> None:
        self.tmp = tempfile.mkdtemp()
        self.server = Server(workspace_root=self.tmp)

    def tearDown(self) -> None:
        try:
            self.server.store.close()
        except Exception:
            pass
        import gc

        gc.collect()
        shutil.rmtree(self.tmp, ignore_errors=True)

    def test_demo_create_handler(self) -> None:
        result = self.server.handlers["demo.create"](self.server, {})
        self.assertEqual(result["occurrence_count"], 6)

    def test_results_query_and_review_persistence(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        tid = demo["task_id"]
        q = self.server.handlers["results.query"](self.server, {"task_id": tid})
        self.assertEqual(q["total"], 6)
        occ_id = q["items"][0]["occurrence_id"]
        r = self.server.handlers["review.updateDecision"](
            self.server, {"task_id": tid, "occurrence_id": occ_id, "decision": "rejected"}
        )
        self.assertEqual(r["decision"], "rejected")
        detail = self.server.handlers["results.getDetail"](
            self.server, {"task_id": tid, "occurrence_id": occ_id}
        )
        self.assertEqual(detail["review_decision"], "rejected")

    def test_review_prepare_page_image_returns_versioned_demo_asset(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        query = self.server.handlers["results.query"](self.server, {"task_id": demo["task_id"]})
        result = self.server.handlers["review.preparePageImage"](
            self.server,
            {
                "task_id": demo["task_id"],
                "occurrence_id": query["items"][0]["occurrence_id"],
                "target_css_width": 800,
                "target_css_height": 600,
                "device_pixel_ratio": 2,
            },
        )
        self.assertEqual(result["source_kind"], "demo")
        self.assertEqual(result["fidelity"], "generated_demo")
        self.assertTrue(result["asset_version"])
        self.assertGreater(result["pixel_width"], 0)

    def test_review_prepare_page_image_rejects_non_finite_dimensions(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        query = self.server.handlers["results.query"](self.server, {"task_id": demo["task_id"]})
        with self.assertRaises(ProtocolError) as raised:
            self.server.handlers["review.preparePageImage"](
                self.server,
                {
                    "task_id": demo["task_id"],
                    "occurrence_id": query["items"][0]["occurrence_id"],
                    "target_css_width": float("nan"),
                    "target_css_height": 600,
                    "device_pixel_ratio": 1,
                },
            )
        self.assertEqual(raised.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_completed_task_with_failures_is_reported_as_incomplete_snapshot(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        task_id = demo["task_id"]
        self.server.store.update_task(task_id, failure_count=1, error_code="PARTIAL_FAILURE")
        result = self.server.handlers["results.query"](self.server, {"task_id": task_id})
        self.assertFalse(result["scan_complete"])
        exported = self.server.handlers["export.json"](self.server, {"task_id": task_id})
        payload = json.loads(Path(exported["path"]).read_text(encoding="utf-8"))
        self.assertFalse(payload["integrity"]["scan_complete"])

    def test_review_invalid_decision_raises(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        tid = demo["task_id"]
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["review.updateDecision"](
                self.server, {"task_id": tid, "occurrence_id": "x", "decision": "bogus"}
            )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_get_not_found(self) -> None:
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.get"](self.server, {"task_id": "nope"})
        self.assertEqual(cm.exception.code, ErrorCode.TASK_NOT_FOUND)

    def test_tasks_create_validates_source_dir(self) -> None:
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](
                self.server, {"source_dir": "Z:/no/such/dir/x", "search_text": "档案"}
            )
        self.assertEqual(cm.exception.code, ErrorCode.PATH_NOT_FOUND)

    def test_tasks_create_requires_a_valid_search_text(self) -> None:
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](self.server, {"source_dir": self.tmp})
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_create_counts_files(self) -> None:
        src = Path(self.tmp) / "src"
        src.mkdir()
        (src / "a.pdf").write_bytes(b"%PDF-1.4")
        (src / "b.djvu").write_bytes(b"AT&TFORM")
        Image.new("RGB", (8, 8), color="white").save(src / "c.tiff")
        Image.new("RGB", (8, 8), color="white").save(src / "d.jpg")
        Image.new("RGB", (8, 8), color="white").save(src / "e.png")
        (src / "ignore.txt").write_text("x")
        with mock.patch("archivelens_engine.source_preflight.DocumentBackendRegistry.page_count", return_value=1):
            result = self.server.handlers["tasks.create"](
                self.server, {"source_dir": str(src), "search_text": "  档案  "}
            )
        self.assertEqual(result["file_count"], 5)
        self.assertEqual(result["counts"]["tiff"], 1)
        self.assertEqual(result["counts"]["jpeg"], 1)
        self.assertEqual(result["counts"]["png"], 1)
        self.assertEqual(result["status"], "draft")
        self.assertEqual(result["search_text"], "档案")
        self.assertEqual(
            result["review_preferences"],
            {"page_quality": "maximum", "context_direction": "ltr", "context_radius": 15},
        )

    def test_tasks_create_persists_review_preferences(self) -> None:
        src = Path(self.tmp) / "preferences"
        src.mkdir()
        Image.new("RGB", (8, 8), color="white").save(src / "a.png")
        preferences = {"page_quality": "high", "context_direction": "ttb", "context_radius": 28}
        result = self.server.handlers["tasks.create"](
            self.server,
            {"source_dir": str(src), "search_text": "档案", "review_preferences": preferences},
        )
        self.assertEqual(result["review_preferences"], {**preferences, "page_quality": "maximum"})
        task = self.server.store.get_task(result["task_id"])
        assert task is not None
        self.assertEqual(task["review_preferences"], {**preferences, "page_quality": "maximum"})

    def test_tasks_create_rejects_invalid_review_preferences(self) -> None:
        src = Path(self.tmp) / "invalid-preferences"
        src.mkdir()
        (src / "a.pdf").write_bytes(b"%PDF-1.4")
        invalid_values = [
            {"page_quality": "lossless", "context_direction": "ltr", "context_radius": 15},
            {"page_quality": "maximum", "context_direction": "diagonal", "context_radius": 15},
            {"page_quality": "maximum", "context_direction": "ltr", "context_radius": 0},
            {"page_quality": "maximum", "context_direction": "ltr", "context_radius": 51},
        ]
        for preferences in invalid_values:
            with self.subTest(preferences=preferences), self.assertRaises(ProtocolError) as cm:
                self.server.handlers["tasks.create"](
                    self.server,
                    {"source_dir": str(src), "search_text": "档案", "review_preferences": preferences},
                )
            self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_create_accepts_single_and_cross_directory_file_list(self) -> None:
        first_dir = Path(self.tmp) / "first"
        second_dir = Path(self.tmp) / "second"
        first_dir.mkdir()
        second_dir.mkdir()
        first = first_dir / "same.pdf"
        second = second_dir / "same.pdf"
        first.write_bytes(b"%PDF-1.4")
        second.write_bytes(b"%PDF-1.4")
        result = self.server.handlers["tasks.create"](
            self.server,
            {"source_type": "files", "source_files": [str(first), str(second), str(first)], "search_text": "档案"},
        )
        self.assertEqual(result["source_kind"], "files")
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(result["source_files"], [str(first.resolve()), str(second.resolve())])
        task = self.server.store.get_task(result["task_id"])
        assert task is not None
        self.assertEqual(task["source_files"], [str(first.resolve()), str(second.resolve())])
        self.assertEqual(len(self.server.store.list_task_sources(result["task_id"])), 2)

    def test_tasks_create_rejects_invalid_file_list_without_creating_task(self) -> None:
        source = Path(self.tmp) / "valid.pdf"
        source.write_bytes(b"%PDF-1.4")
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](
                self.server,
                {"source_type": "files", "source_files": [str(source), str(Path(self.tmp) / "missing.pdf")], "search_text": "档案"},
            )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)
        self.assertEqual(self.server.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_tasks_create_rejects_empty_and_unreadable_file_lists(self) -> None:
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](
                self.server,
                {"source_type": "files", "source_files": [], "search_text": "档案"},
            )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)
        source = Path(self.tmp) / "unreadable.pdf"
        source.write_bytes(b"%PDF-1.4")
        with mock.patch.object(Path, "open", side_effect=PermissionError("denied")):
            with self.assertRaises(ProtocolError) as cm:
                self.server.handlers["tasks.create"](
                    self.server,
                    {"source_type": "files", "source_files": [str(source)], "search_text": "档案"},
                )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)
        self.assertEqual(self.server.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)

    def test_tasks_create_rejects_unsupported_and_over_limit_file_lists(self) -> None:
        unsupported = Path(self.tmp) / "plain.txt"
        unsupported.write_text("x", encoding="utf-8")
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](
                self.server,
                {"source_type": "files", "source_files": [str(unsupported)], "search_text": "档案"},
            )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_create_accepts_valid_images_and_rejects_corrupt_or_spoofed_images(self) -> None:
        valid = Path(self.tmp) / "valid.png"
        Image.new("RGB", (8, 8), color="white").save(valid)
        result = self.server.handlers["tasks.create"](
            self.server,
            {"source_type": "files", "source_files": [str(valid)], "search_text": "档案"},
        )
        self.assertEqual(result["file_count"], 1)
        self.assertEqual(result["counts"]["png"], 1)

        corrupt = Path(self.tmp) / "corrupt.tiff"
        corrupt.write_bytes(b"not-a-tiff")
        spoofed = Path(self.tmp) / "spoofed.png"
        Image.new("RGB", (8, 8), color="white").save(spoofed, format="JPEG")
        for invalid in (corrupt, spoofed):
            with self.assertRaises(ProtocolError) as cm:
                self.server.handlers["tasks.create"](
                    self.server,
                    {"source_type": "files", "source_files": [str(invalid)], "search_text": "档案"},
                )
            self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)
        many_dir = Path(self.tmp) / "many"
        many_dir.mkdir()
        files = []
        for index in range(201):
            path = many_dir / f"{index}.pdf"
            path.write_bytes(b"%PDF-1.4")
            files.append(str(path))
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.create"](
                self.server,
                {"source_type": "files", "source_files": files, "search_text": "档案"},
            )
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_list_returns_total_and_supports_search(self) -> None:
        self.server.store.create_task(name="县志检索", source_dir="县志目录", search_terms=["契约"], search_mode="exact_literal")
        self.server.store.create_task(name="报纸检索", source_dir="报纸目录", search_terms=["新闻"], search_mode="exact_literal")
        result = self.server.handlers["tasks.list"](self.server, {"query": "契约", "limit": 20, "offset": 0})
        self.assertEqual(result["total"], 1)
        self.assertEqual(result["items"][0]["name"], "县志检索")
        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.list"](self.server, {"limit": 101})
        self.assertEqual(cm.exception.code, ErrorCode.VALIDATION_ERROR)

    def test_tasks_delete_removes_local_task_data_but_keeps_source_file(self) -> None:
        source_dir = Path(self.tmp) / "source"
        source_dir.mkdir()
        original_file = source_dir / "original.pdf"
        original_file.write_bytes(b"%PDF-1.4 original")
        task_id = self.server.store.create_task(
            source_dir=str(source_dir),
            name="待删除任务",
            status="completed",
            search_terms=["档案"],
            search_mode="exact_literal",
        )
        task_dir = Path(self.tmp) / "tasks" / task_id
        generated_page = task_dir / "scan" / "pages" / "page-1.png"
        generated_page.parent.mkdir(parents=True)
        generated_page.write_bytes(b"generated page")
        generated_export = task_dir / "export.json"
        generated_export.write_text("{}", encoding="utf-8")
        self.server.store.update_task(task_id, workspace_dir=str(task_dir / "scan"))
        self.server.store.add_occurrences(task_id, [{
            "occurrence_id": "occ-delete", "file_name": original_file.name,
            "page_number": 1, "matched_text": "档案", "bbox_hash": "delete-bbox",
        }])
        self.server.store.upsert_review(task_id=task_id, occurrence_id="occ-delete", decision="confirmed")
        self.server.store.add_export(task_id=task_id, kind="json", path=str(generated_export))
        self.server.store.append_task_event(task_id=task_id, event_type="task.completed", payload={})

        result = self.server.handlers["tasks.delete"](self.server, {"task_id": task_id})

        self.assertEqual(result, {"task_id": task_id, "deleted": True})
        self.assertTrue(original_file.exists())
        self.assertFalse(task_dir.exists())
        self.assertIsNone(self.server.store.get_task(task_id))
        for table in ("occurrences", "review_records", "exports", "task_events"):
            with self.subTest(table=table):
                row = self.server.store.conn.execute(
                    f"SELECT COUNT(*) FROM {table} WHERE task_id=?", (task_id,)
                ).fetchone()
                self.assertEqual(row[0], 0)

    def test_tasks_delete_requires_cancelling_nonterminal_task_first(self) -> None:
        task_id = self.server.store.create_task(
            source_dir=str(Path(self.tmp) / "source"),
            name="草稿任务",
            status="draft",
            search_terms=["档案"],
            search_mode="exact_literal",
        )

        with self.assertRaises(ProtocolError) as cm:
            self.server.handlers["tasks.delete"](self.server, {"task_id": task_id})

        self.assertEqual(cm.exception.code, ErrorCode.TASK_STATE_CONFLICT)
        self.assertIsNotNone(self.server.store.get_task(task_id))

    def test_tasks_create_rolls_back_task_when_initial_event_fails(self) -> None:
        src = Path(self.tmp) / "atomic-src"
        src.mkdir()
        Image.new("RGB", (8, 8), color="white").save(src / "page.png")
        self.server.store.conn.execute(
            "CREATE TRIGGER fail_created_event BEFORE INSERT ON task_events BEGIN SELECT RAISE(FAIL, 'injected create event failure'); END"
        )
        self.server.store.conn.commit()
        output = io.StringIO()
        with self.assertRaisesRegex(Exception, "injected create event failure"), redirect_stdout(output):
            self.server.handlers["tasks.create"](
                self.server,
                {"source_dir": str(src), "search_text": "档案"},
            )
        self.assertEqual(self.server.store.conn.execute("SELECT COUNT(*) FROM tasks").fetchone()[0], 0)
        self.assertEqual(self.server.store.conn.execute("SELECT COUNT(*) FROM task_events").fetchone()[0], 0)
        self.assertEqual(output.getvalue(), "")

    def test_export_json_and_html(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        tid = demo["task_id"]
        j = self.server.handlers["export.json"](self.server, {"task_id": tid})
        self.assertTrue(Path(j["path"]).exists())
        json_payload = json.loads(Path(j["path"]).read_text(encoding="utf-8"))
        self.assertEqual(json_payload["task"]["search_mode"], "legacy_fixed_pair")
        self.assertEqual(json_payload["task"]["search_terms"], ["约", "約"])
        self.assertIn("matched_text", json_payload["occurrences"][0])
        progress_output = io.StringIO()
        with redirect_stdout(progress_output):
            h = self.server.handlers["export.html"](self.server, {"task_id": tid})
        self.assertTrue(Path(h["path"]).exists())
        content = Path(h["path"]).read_text(encoding="utf-8")
        self.assertIn("ArchiveLens", content)
        self.assertIn("约", content)
        progress_events = [json.loads(line) for line in progress_output.getvalue().splitlines()]
        progress_stages = [event["payload"]["stage"] for event in progress_events]
        self.assertEqual(progress_stages[0], "preparing")
        self.assertEqual(progress_stages[-3:], ["building", "writing", "completed"])
        self.assertEqual(
            progress_stages.count("images"),
            len({item["page_image_relpath"] for item in json_payload["occurrences"]}),
        )
        history = self.server.handlers["exports.list"](self.server, {"task_id": tid})
        self.assertEqual([item["kind"] for item in history["items"]], ["html", "json"])

    def test_html_export_escapes_user_search_text_and_review_content(self) -> None:
        workspace = Path(self.tmp) / "escape-assets"
        (workspace / "pages").mkdir(parents=True)
        Image.new("RGB", (80, 60), "white").save(workspace / "pages" / "page.png")
        tid = self.server.store.create_task(
            name="<script>alert(1)</script> \"quoted\" 'single'",
            search_terms=["A&B < > \" '"],
            search_mode="exact_literal",
            workspace_dir=str(workspace),
            is_demo=True,
        )
        self.server.store.add_occurrences(
            tid,
            [{
                "occurrence_id": "occ-escape",
                "matched_text": "A&B < > \" '",
                "bbox_hash": "escape-bbox",
                "context_full": "<img src=x onerror=alert(1)> & \" '",
                "file_name": "<unsafe>.pdf",
                "page_number": 1,
                "page_image_relpath": "pages/page.png",
                "page_image_width": 80,
                "page_image_height": 60,
            }],
        )
        self.server.store.upsert_review(task_id=tid, occurrence_id="occ-escape", note="<b>note</b>")
        result = self.server.handlers["export.html"](self.server, {"task_id": tid})
        content = Path(result["path"]).read_text(encoding="utf-8")
        self.assertIn("A&amp;B &lt; &gt; &quot; &#x27;", content)
        self.assertIn("\\u003cscript\\u003ealert(1)\\u003c/script\\u003e", content)
        self.assertNotIn("<img src=x onerror=alert(1)>", content)
        self.assertIn("\\u003cimg src=x onerror=alert(1)\\u003e", content)
        self.assertIn("&quot;quoted&quot; &#x27;single&#x27;", content)
        self.assertIn("\\u003cb\\u003enote\\u003c/b\\u003e", content)

    def test_export_review_records(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        tid = demo["task_id"]
        q = self.server.handlers["results.query"](self.server, {"task_id": tid})
        occ_id = q["items"][0]["occurrence_id"]
        self.server.handlers["review.updateNote"](
            self.server, {"task_id": tid, "occurrence_id": occ_id, "note": "备注"}
        )
        r = self.server.handlers["export.review"](self.server, {"task_id": tid})
        self.assertGreaterEqual(r["record_count"], 1)
        data = json.loads(Path(r["path"]).read_text(encoding="utf-8"))
        self.assertEqual(data["task_id"], tid)
        self.assertGreaterEqual(len(data["records"]), 1)

    def test_emit_task_event_has_sequence_and_timestamp(self) -> None:
        task_id = self.server.store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="emit")
        buf = io.StringIO()
        with redirect_stdout(buf):
            self.server.emit_task_event("task.progress", task_id, {"x": 1})
            self.server.emit_task_event("task.progress", task_id, {"x": 2})
        lines = [json.loads(line) for line in buf.getvalue().splitlines() if line.strip()]
        self.assertEqual(lines[0]["sequence"], 1)
        self.assertEqual(lines[1]["sequence"], 2)
        self.assertIn("timestamp", lines[0])
        self.assertEqual(lines[0]["task_id"], task_id)

    def test_emit_task_event_writes_utf8_when_stdout_encoding_cannot_encode_payload(self) -> None:
        class StrictCp1252Stdout:
            def __init__(self) -> None:
                self.buffer = io.BytesIO()

            def write(self, message: str) -> int:
                message.encode("cp1252", errors="strict")
                return self.buffer.write(message.encode("cp1252"))

            def flush(self) -> None:
                return None

        task_id = self.server.store.create_task(source_dir="X", output_dir="Y", workspace_dir="Z", name="emit")
        fake_stdout = StrictCp1252Stdout()
        original_stdout = sys.stdout
        try:
            sys.stdout = fake_stdout
            self.server.emit_task_event(
                "task.progress",
                task_id,
                {"source_id": "中文 空格 # %.pdf", "processed_pages": 1},
            )
        finally:
            sys.stdout = original_stdout

        line = fake_stdout.buffer.getvalue().decode("utf-8").strip()
        payload = json.loads(line)
        self.assertEqual(payload["event"], "task.progress")
        self.assertEqual(payload["payload"]["source_id"], "中文 空格 # %.pdf")


if __name__ == "__main__":
    unittest.main()
