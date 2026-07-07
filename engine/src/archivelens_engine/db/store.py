"""全局任务存储。

承载桌面级多任务管理：``tasks`` / ``occurrences`` / ``review_records`` /
``exports``。Engine 独占写；Renderer 经分页 API 查询。

设计要点（任务 §七.5）：

* 所有写入走事务；
* 状态更新与事件尽量同事务（调用方在 commit 后再发事件）；
* ``schema_meta`` + ``PRAGMA user_version`` 支持迁移；
* 校对结果持久化到 SQLite，不只 localStorage。
"""

from __future__ import annotations

import json
import sqlite3
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 1

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    source_dir TEXT NOT NULL DEFAULT '',
    output_dir TEXT NOT NULL DEFAULT '',
    workspace_dir TEXT NOT NULL DEFAULT '',
    status TEXT NOT NULL DEFAULT 'draft',
    is_demo INTEGER NOT NULL DEFAULT 0,
    file_count INTEGER NOT NULL DEFAULT 0,
    total_pages INTEGER NOT NULL DEFAULT 0,
    processed_pages INTEGER NOT NULL DEFAULT 0,
    occurrence_count INTEGER NOT NULL DEFAULT 0,
    failure_count INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL,
    started_at TEXT,
    updated_at TEXT,
    finished_at TEXT,
    error_code TEXT,
    error_message TEXT
);
CREATE TABLE IF NOT EXISTS occurrences (
    occurrence_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    document_id TEXT,
    file_path TEXT,
    relative_path TEXT,
    file_name TEXT,
    page_number INTEGER,
    page_index INTEGER,
    page_occurrence_index INTEGER,
    matched_character TEXT,
    character_variant TEXT,
    unicode_codepoint TEXT,
    context_before TEXT,
    context_after TEXT,
    context_full TEXT,
    ocr_confidence REAL,
    secondary_ocr_result TEXT,
    verification_status TEXT,
    location_method TEXT,
    source_page_width REAL,
    source_page_height REAL,
    source_x0 REAL, source_y0 REAL, source_x1 REAL, source_y1 REAL,
    normalized_x0 REAL, normalized_y0 REAL, normalized_x1 REAL, normalized_y1 REAL,
    page_image_relpath TEXT,
    crop_image_relpath TEXT,
    page_image_width INTEGER,
    page_image_height INTEGER
);
CREATE INDEX IF NOT EXISTS idx_occ_task ON occurrences(task_id);
CREATE TABLE IF NOT EXISTS review_records (
    task_id TEXT NOT NULL,
    occurrence_id TEXT NOT NULL,
    decision TEXT,
    note TEXT NOT NULL DEFAULT '',
    reviewed_at TEXT,
    updated_at TEXT,
    PRIMARY KEY (task_id, occurrence_id)
);
CREATE TABLE IF NOT EXISTS exports (
    export_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    kind TEXT NOT NULL,
    path TEXT NOT NULL,
    created_at TEXT NOT NULL
);
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
PRAGMA user_version = 1;
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex}" if prefix else uuid.uuid4().hex


class TaskStore:
    """全局任务/结果/校对/导出 的 SQLite 存储。"""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self.conn.execute("PRAGMA foreign_keys = ON")
        self._init_schema()

    def _init_schema(self) -> None:
        self.conn.executescript(SCHEMA_SQL)
        self.conn.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)",
            ("schema_version", str(SCHEMA_VERSION)),
        )
        self.conn.commit()

    # ---- tasks ----
    def create_task(
        self,
        *,
        source_dir: str = "",
        output_dir: str = "",
        workspace_dir: str = "",
        name: str = "",
        is_demo: bool = False,
        file_count: int = 0,
        total_pages: int = 0,
        status: str = "draft",
    ) -> str:
        task_id = new_id("task_")
        created = now_iso()
        self.conn.execute(
            """INSERT INTO tasks
               (task_id, name, source_dir, output_dir, workspace_dir, status,
                is_demo, file_count, total_pages, created_at, updated_at)
               VALUES (?,?,?,?,?,?,?,?,?,?,?)""",
            (
                task_id, name, source_dir, output_dir, workspace_dir, status,
                1 if is_demo else 0, file_count, total_pages, created, created,
            ),
        )
        self.conn.commit()
        return task_id

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        row = self.conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def list_tasks(
        self, *, limit: int = 50, offset: int = 0, status: str | None = None
    ) -> list[dict[str, Any]]:
        if status:
            cur = self.conn.execute(
                "SELECT * FROM tasks WHERE status=? ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (status, limit, offset),
            )
        else:
            cur = self.conn.execute(
                "SELECT * FROM tasks ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (limit, offset),
            )
        return [dict(r) for r in cur.fetchall()]

    def update_task(self, task_id: str, **fields: Any) -> None:
        if not fields:
            return
        fields.setdefault("updated_at", now_iso())
        cols = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [task_id]
        self.conn.execute(f"UPDATE tasks SET {cols} WHERE task_id=?", vals)
        self.conn.commit()

    # ---- occurrences ----
    def add_occurrence(self, task_id: str, occ: dict[str, Any]) -> None:
        cols = [
            "occurrence_id", "task_id", "document_id", "file_path", "relative_path",
            "file_name", "page_number", "page_index", "page_occurrence_index",
            "matched_character", "character_variant", "unicode_codepoint",
            "context_before", "context_after", "context_full", "ocr_confidence",
            "secondary_ocr_result", "verification_status", "location_method",
            "source_page_width", "source_page_height",
            "source_x0", "source_y0", "source_x1", "source_y1",
            "normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1",
            "page_image_relpath", "crop_image_relpath",
            "page_image_width", "page_image_height",
        ]
        record = {"occurrence_id": new_id("occ_"), "task_id": task_id}
        # 只用 occ 提供的字段覆盖；task_id / occurrence_id 由本方法保证，不被 None 覆盖。
        record.update(
            {k: v for k, v in occ.items() if k in cols and k not in ("occurrence_id", "task_id")}
        )
        placeholders = ", ".join("?" for _ in cols)
        self.conn.execute(
            f"INSERT OR REPLACE INTO occurrences ({', '.join(cols)}) VALUES ({placeholders})",
            [record.get(c) for c in cols],
        )

    def add_occurrences(self, task_id: str, items: Iterable[dict[str, Any]]) -> int:
        count = 0
        with self.conn:
            for occ in items:
                self.add_occurrence(task_id, occ)
                count += 1
        self.update_task(task_id, occurrence_count=self._count_occurrences(task_id))
        return count

    def _count_occurrences(self, task_id: str) -> int:
        row = self.conn.execute(
            "SELECT COUNT(*) AS n FROM occurrences WHERE task_id=?", (task_id,)
        ).fetchone()
        return int(row["n"]) if row else 0

    def query_occurrences(
        self,
        *,
        task_id: str,
        limit: int = 100,
        offset: int = 0,
        document: str | None = None,
        status: str | None = None,
        character: str | None = None,
        search: str | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        where = ["o.task_id=?"]
        params: list[Any] = [task_id]
        if document:
            where.append("(o.file_name=? OR o.relative_path=?)")
            params.extend([document, document])
        if status:
            where.append("o.verification_status=?")
            params.append(status)
        if character:
            where.append("o.character_variant=?")
            params.append(character)
        if search:
            where.append("o.context_full LIKE ?")
            params.append(f"%{search}%")
        clause = " AND ".join(where)
        total = self.conn.execute(
            f"SELECT COUNT(*) AS n FROM occurrences AS o WHERE {clause}", params
        ).fetchone()["n"]
        rows = self.conn.execute(
            f"""SELECT o.*, r.decision AS review_decision, r.note AS review_note
                FROM occurrences o
                LEFT JOIN review_records r
                  ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id
                WHERE {clause}
                ORDER BY o.file_name, o.page_number, o.page_occurrence_index
                LIMIT ? OFFSET ?""",
            params + [limit, offset],
        ).fetchall()
        return int(total), [dict(r) for r in rows]

    def get_occurrence_detail(self, task_id: str, occurrence_id: str) -> dict[str, Any] | None:
        row = self.conn.execute(
            """SELECT o.*, r.decision AS review_decision, r.note AS review_note,
                      r.updated_at AS review_updated_at
               FROM occurrences o
               LEFT JOIN review_records r
                 ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id
               WHERE o.task_id=? AND o.occurrence_id=?""",
            (task_id, occurrence_id),
        ).fetchone()
        return dict(row) if row else None

    # ---- review ----
    def upsert_review(
        self,
        *,
        task_id: str,
        occurrence_id: str,
        decision: str | None = None,
        note: str | None = None,
    ) -> str:
        updated = now_iso()
        existing = self.conn.execute(
            "SELECT 1 FROM review_records WHERE task_id=? AND occurrence_id=?",
            (task_id, occurrence_id),
        ).fetchone()
        if existing:
            sets: list[str] = ["updated_at=?"]
            vals: list[Any] = [updated]
            if decision is not None:
                sets.append("decision=?")
                vals.append(decision)
            if note is not None:
                sets.append("note=?")
                vals.append(note)
            vals.extend([task_id, occurrence_id])
            self.conn.execute(
                f"UPDATE review_records SET {', '.join(sets)} WHERE task_id=? AND occurrence_id=?",
                vals,
            )
        else:
            self.conn.execute(
                """INSERT INTO review_records
                   (task_id, occurrence_id, decision, note, reviewed_at, updated_at)
                   VALUES (?,?,?,?,?,?)""",
                (task_id, occurrence_id, decision, note or "", updated, updated),
            )
        self.conn.commit()
        return updated

    def list_reviews(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT * FROM review_records WHERE task_id=? ORDER BY updated_at DESC",
            (task_id,),
        ).fetchall()
        return [dict(r) for r in rows]

    # ---- exports ----
    def add_export(self, *, task_id: str, kind: str, path: str) -> str:
        export_id = new_id("exp_")
        self.conn.execute(
            "INSERT INTO exports (export_id, task_id, kind, path, created_at) VALUES (?,?,?,?,?)",
            (export_id, task_id, kind, path, now_iso()),
        )
        self.conn.commit()
        return export_id

    # ---- lifecycle ----
    def close(self) -> None:
        try:
            self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
        except sqlite3.Error:
            pass
        self.conn.close()


__all__ = ["TaskStore", "SCHEMA_VERSION", "SCHEMA_SQL", "now_iso", "new_id"]
