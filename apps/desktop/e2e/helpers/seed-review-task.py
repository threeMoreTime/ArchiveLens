from __future__ import annotations

import json
import sys
from pathlib import Path

from archivelens_engine.db.store import TaskStore


def main(user_data_dir: str, count_text: str) -> None:
    root = Path(user_data_dir) / "engine"
    root.mkdir(parents=True, exist_ok=True)
    store = TaskStore(root / "archivelens.db")
    try:
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
