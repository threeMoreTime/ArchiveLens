"""Server handlers 纵向闭环测试（demo → results → review → export → events）。"""

from __future__ import annotations

import io
import json
import shutil
import tempfile
import unittest
from contextlib import redirect_stdout
from pathlib import Path

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
            self.server.handlers["tasks.create"](self.server, {"source_dir": "Z:/no/such/dir/x"})
        self.assertEqual(cm.exception.code, ErrorCode.PATH_NOT_FOUND)

    def test_tasks_create_counts_files(self) -> None:
        src = Path(self.tmp) / "src"
        src.mkdir()
        (src / "a.pdf").write_bytes(b"%PDF-1.4")
        (src / "b.djvu").write_bytes(b"AT&T")
        (src / "ignore.txt").write_text("x")
        result = self.server.handlers["tasks.create"](self.server, {"source_dir": str(src)})
        self.assertEqual(result["file_count"], 2)
        self.assertEqual(result["status"], "draft")

    def test_export_json_and_html(self) -> None:
        demo = self.server.handlers["demo.create"](self.server, {})
        tid = demo["task_id"]
        j = self.server.handlers["export.json"](self.server, {"task_id": tid})
        self.assertTrue(Path(j["path"]).exists())
        h = self.server.handlers["export.html"](self.server, {"task_id": tid})
        self.assertTrue(Path(h["path"]).exists())
        content = Path(h["path"]).read_text(encoding="utf-8")
        self.assertIn("ArchiveLens", content)
        self.assertIn("约", content)

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


if __name__ == "__main__":
    unittest.main()
