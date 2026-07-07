import json
import tempfile
import unittest
from pathlib import Path

from archivelens_engine.progress_dashboard import build_progress_html, collect_progress_snapshot


class ProgressDashboardTests(unittest.TestCase):
    def test_collect_progress_snapshot_classifies_running_completed_stale(self) -> None:
        import os
        from archivelens_engine.runtime.worker_state import WorkerState, now_iso, save_worker_state

        with tempfile.TemporaryDirectory() as tmp:
            workspace = Path(tmp) / "full_run_v4"

            # worker_01：显式 worker-state(running + 存活 pid + 新鲜 heartbeat) → running
            worker_1_run = workspace / "worker_01" / "run"
            worker_1_run.mkdir(parents=True)
            save_worker_state(
                workspace / "worker_01" / "worker-state.json",
                WorkerState(
                    worker_id="worker_01",
                    status="running",
                    pid=os.getpid(),
                    heartbeat_at=now_iso(),
                    input_file="01.djvu",
                    processed_pages=25,
                    total_pages=100,
                    occurrences_found=2,
                    failure_count=1,
                ),
            )

            # worker_02：report.json → completed
            worker_2_run = workspace / "worker_02" / "run"
            worker_2_run.mkdir(parents=True)
            (worker_2_run / "report.json").write_text(
                json.dumps(
                    {
                        "documents": [
                            {"relative_path": "02.djvu", "page_count": 50, "file_type": "DJVU"}
                        ],
                        "occurrences": [{"id": 1}],
                        "failures": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )

            # worker_03：残留 checkpoint 无 worker-state → stale（任务 §十二 核心回归）
            worker_3_run = workspace / "worker_03" / "run"
            worker_3_run.mkdir(parents=True)
            (worker_3_run / "checkpoint-bbb.json").write_text(
                json.dumps(
                    {
                        "relative_path": "03.djvu",
                        "document_page_count": 200,
                        "next_page_index": 60,
                        "occurrences": [{"id": 1}],
                        "failures": [],
                    },
                    ensure_ascii=False,
                ),
                encoding="utf-8",
            )
            (workspace / "auto-merge.out.log").write_text("reports=1\n", encoding="utf-8")

            snapshot = collect_progress_snapshot(workspace)
            self.assertEqual(snapshot["summary"]["worker_count"], 3)
            self.assertEqual(snapshot["summary"]["completed_workers"], 1)
            self.assertEqual(snapshot["summary"]["running_workers"], 1)
            self.assertEqual(snapshot["summary"]["stale_workers"], 1)
            self.assertEqual(
                [w["status"] for w in snapshot["workers"]],
                ["running", "completed", "stale"],
            )
            self.assertEqual(snapshot["summary"]["merge_reports_seen"], 1)

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
