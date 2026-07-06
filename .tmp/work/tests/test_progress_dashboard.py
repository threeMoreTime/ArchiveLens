import json
import tempfile
import unittest
from pathlib import Path

from progress_dashboard import build_progress_html, collect_progress_snapshot


class ProgressDashboardTests(unittest.TestCase):
    def test_collect_progress_snapshot_combines_running_and_completed_workers(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "full_run_v4"
            worker_1_run = workspace / "worker_01" / "run"
            worker_2_run = workspace / "worker_02" / "run"
            worker_1_run.mkdir(parents=True)
            worker_2_run.mkdir(parents=True)

            (worker_1_run / "checkpoint-aaa.json").write_text(
                json.dumps(
                    {
                        "relative_path": "01.djvu",
                        "document_page_count": 100,
                        "next_page_index": 25,
                        "occurrences": [{"id": 1}, {"id": 2}],
                        "failures": [{"id": 1}],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (worker_2_run / "report.json").write_text(
                json.dumps(
                    {
                        "documents": [
                            {
                                "relative_path": "02.djvu",
                                "page_count": 50,
                                "file_type": "DJVU",
                            }
                        ],
                        "occurrences": [{"id": 1}],
                        "failures": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (workspace / "auto-merge.out.log").write_text("2026-07-06T15:00:00 reports=1\n", encoding="utf-8")

            snapshot = collect_progress_snapshot(workspace)
            self.assertEqual(snapshot["summary"]["worker_count"], 2)
            self.assertEqual(snapshot["summary"]["completed_workers"], 1)
            self.assertEqual(snapshot["summary"]["running_workers"], 1)
            self.assertEqual(snapshot["summary"]["total_pages"], 150)
            self.assertEqual(snapshot["summary"]["processed_pages"], 75)
            self.assertEqual(snapshot["summary"]["occurrences_found"], 3)
            self.assertEqual(snapshot["summary"]["failure_count"], 1)
            self.assertEqual(snapshot["summary"]["merge_reports_seen"], 1)
            self.assertEqual(snapshot["workers"][0]["status"], "running")
            self.assertEqual(snapshot["workers"][1]["status"], "completed")

    def test_build_progress_html_renders_refresh_and_worker_rows(self) -> None:
        snapshot = {
            "generated_at": "2026-07-06 15:10:00",
            "workspace_dir": r"E:\OCR\.tmp\full_run_v4",
            "summary": {
                "worker_count": 2,
                "completed_workers": 1,
                "running_workers": 1,
                "total_pages": 150,
                "processed_pages": 75,
                "remaining_pages": 75,
                "overall_progress_pct": 50.0,
                "occurrences_found": 3,
                "failure_count": 1,
                "merge_reports_seen": 1,
            },
            "workers": [
                {
                    "worker": "worker_01",
                    "file": "01.djvu",
                    "status": "running",
                    "processed_pages": 25,
                    "total_pages": 100,
                    "remaining_pages": 75,
                    "progress_pct": 25.0,
                    "occurrences_found": 2,
                    "failure_count": 1,
                    "updated_at": "2026-07-06 15:09:00",
                },
                {
                    "worker": "worker_02",
                    "file": "02.djvu",
                    "status": "completed",
                    "processed_pages": 50,
                    "total_pages": 50,
                    "remaining_pages": 0,
                    "progress_pct": 100.0,
                    "occurrences_found": 1,
                    "failure_count": 0,
                    "updated_at": "2026-07-06 15:08:00",
                },
            ],
            "merge_log_tail": ["2026-07-06T15:00:00 reports=1"],
        }
        html = build_progress_html(snapshot, refresh_seconds=20)
        self.assertIn('http-equiv="refresh" content="20"', html)
        self.assertIn("扫描实时进度", html)
        self.assertIn("worker_01", html)
        self.assertIn("01.djvu", html)
        self.assertIn('"overall_progress_pct":50.0', html)
        self.assertIn('${worker.progress_pct}%', html)
        self.assertIn("reports=1", html)


if __name__ == "__main__":
    unittest.main()
