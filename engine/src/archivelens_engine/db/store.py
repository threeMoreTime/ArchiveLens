"""全局任务存储（并发安全版，任务 §九）。

承载桌面级多任务管理：``tasks`` / ``occurrences`` / ``review_records`` /
``exports``。Engine 独占写；Renderer 经分页 API 查询。

并发模型：

* 扫描线程（写 occurrence/progress）与 IPC handler 线程（查询/校对）共用
  同一 :class:`TaskStore`；
* ``check_same_thread=False`` 允许跨线程，但**不代表 connection 可无锁并发**；
* 因此统一用 :class:`threading.RLock` 串行化所有 cursor/commit/rollback，
  避免并发写竞争与 ``database is locked``；
* 配合 ``PRAGMA journal_mode=WAL`` + ``busy_timeout=5000`` 提升并发与容错。

设计要点（任务 §七.5）：写入走短事务；异常 rollback；状态更新与事件同事务
（调用方 commit 后再 emit）；schema_meta + user_version 支持迁移。
"""

from __future__ import annotations

import json
import sqlite3
import threading
import uuid
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable

SCHEMA_VERSION = 2

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
    last_event_sequence INTEGER NOT NULL DEFAULT 0,
    worker_generation INTEGER NOT NULL DEFAULT 0,
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
    source_id TEXT NOT NULL DEFAULT '',
    matched_character TEXT,
    character_variant TEXT,
    bbox_hash TEXT NOT NULL DEFAULT '',
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
CREATE TABLE IF NOT EXISTS task_processed_pages (
    task_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    page_no INTEGER NOT NULL,
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, source_id, page_no)
);
CREATE TABLE IF NOT EXISTS task_checkpoints (
    task_id TEXT NOT NULL,
    source_id TEXT NOT NULL,
    last_completed_page INTEGER NOT NULL DEFAULT 0,
    next_page INTEGER NOT NULL DEFAULT 1,
    processed_page_ids_json TEXT NOT NULL DEFAULT '[]',
    worker_generation INTEGER NOT NULL DEFAULT 0,
    updated_at TEXT NOT NULL,
    PRIMARY KEY (task_id, source_id)
);
CREATE TABLE IF NOT EXISTS task_events (
    event_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    source_id TEXT NOT NULL DEFAULT '',
    sequence INTEGER NOT NULL,
    event_type TEXT NOT NULL,
    payload_json TEXT NOT NULL DEFAULT '{}',
    worker_generation INTEGER NOT NULL DEFAULT 0,
    created_at TEXT NOT NULL
);
CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_sequence ON task_events(task_id, sequence);
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
PRAGMA user_version = 2;
"""


def now_iso() -> str:
    return datetime.now(timezone.utc).isoformat()


def new_id(prefix: str = "") -> str:
    return f"{prefix}{uuid.uuid4().hex}" if prefix else uuid.uuid4().hex


class TaskStore:
    """全局任务/结果/校对/导出 的 SQLite 存储（线程安全）。"""

    def __init__(self, db_path: str | Path) -> None:
        self.db_path = Path(db_path)
        self.db_path.parent.mkdir(parents=True, exist_ok=True)
        # check_same_thread=False 允许跨线程；所有访问仍经 _lock 串行化（见各方法）。
        self.conn = sqlite3.connect(self.db_path, check_same_thread=False)
        self.conn.row_factory = sqlite3.Row
        self._lock = threading.RLock()
        with self._lock:
            self.conn.execute("PRAGMA journal_mode = WAL")
            self.conn.execute("PRAGMA busy_timeout = 5000")
            self.conn.execute("PRAGMA foreign_keys = ON")
            self._init_schema()

    def _init_schema(self) -> None:
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            self._execute_schema_sql(SCHEMA_SQL)
            self._migrate_schema()
            self.conn.execute(
                "INSERT INTO schema_meta(key, value) VALUES (?, ?) ON CONFLICT(key) DO UPDATE SET value=excluded.value",
                ("schema_version", str(SCHEMA_VERSION)),
            )
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")
            self.conn.commit()
        except Exception:
            self.conn.rollback()
            raise

    def _execute_schema_sql(self, script: str) -> None:
        statement_lines: list[str] = []
        for line in script.splitlines():
            if not line.strip():
                continue
            statement_lines.append(line)
            candidate = "\n".join(statement_lines).strip()
            if sqlite3.complete_statement(candidate):
                self.conn.execute(candidate)
                statement_lines.clear()
        if statement_lines:
            candidate = "\n".join(statement_lines).strip()
            if candidate:
                self.conn.execute(candidate)

    def _migrate_schema(self) -> None:
        current = int(
            self.conn.execute("PRAGMA user_version").fetchone()[0] or 0
        )
        self._ensure_column("tasks", "last_event_sequence", "INTEGER NOT NULL DEFAULT 0")
        self._ensure_column("tasks", "worker_generation", "INTEGER NOT NULL DEFAULT 0")
        self._ensure_column("occurrences", "source_id", "TEXT NOT NULL DEFAULT ''")
        self._ensure_column("occurrences", "bbox_hash", "TEXT NOT NULL DEFAULT ''")
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_occ_business_key "
            "ON occurrences(task_id, source_id, page_number, matched_character, bbox_hash) "
            "WHERE source_id <> '' AND bbox_hash <> ''"
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_processed_pages (
                task_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                page_no INTEGER NOT NULL,
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, source_id, page_no)
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_checkpoints (
                task_id TEXT NOT NULL,
                source_id TEXT NOT NULL,
                last_completed_page INTEGER NOT NULL DEFAULT 0,
                next_page INTEGER NOT NULL DEFAULT 1,
                processed_page_ids_json TEXT NOT NULL DEFAULT '[]',
                worker_generation INTEGER NOT NULL DEFAULT 0,
                updated_at TEXT NOT NULL,
                PRIMARY KEY (task_id, source_id)
            )
            """
        )
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_events (
                event_id TEXT PRIMARY KEY,
                task_id TEXT NOT NULL,
                source_id TEXT NOT NULL DEFAULT '',
                sequence INTEGER NOT NULL,
                event_type TEXT NOT NULL,
                payload_json TEXT NOT NULL DEFAULT '{}',
                worker_generation INTEGER NOT NULL DEFAULT 0,
                created_at TEXT NOT NULL
            )
            """
        )
        self.conn.execute("CREATE UNIQUE INDEX IF NOT EXISTS idx_task_events_sequence ON task_events(task_id, sequence)")
        if current < SCHEMA_VERSION:
            self.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION}")

    def _ensure_column(self, table: str, column: str, ddl: str) -> None:
        cols = {
            row["name"] if isinstance(row, sqlite3.Row) else row[1]
            for row in self.conn.execute(f"PRAGMA table_info({table})").fetchall()
        }
        if column not in cols:
            self.conn.execute(f"ALTER TABLE {table} ADD COLUMN {column} {ddl}")

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
        with self._lock:
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
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
        return dict(row) if row else None

    def list_tasks(
        self, *, limit: int = 50, offset: int = 0, status: str | None = None
    ) -> list[dict[str, Any]]:
        with self._lock:
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
        with self._lock:
            self.conn.execute(f"UPDATE tasks SET {cols} WHERE task_id=?", vals)
            self.conn.commit()

    def allocate_worker_generation(self, task_id: str) -> int:
        with self._lock:
            row = self.conn.execute(
                "SELECT worker_generation FROM tasks WHERE task_id=?",
                (task_id,),
            ).fetchone()
            if row is None:
                raise KeyError(task_id)
            next_generation = int(row["worker_generation"] or 0) + 1
            self.conn.execute(
                "UPDATE tasks SET worker_generation=?, updated_at=? WHERE task_id=?",
                (next_generation, now_iso(), task_id),
            )
            self.conn.commit()
            return next_generation

    # ---- occurrences ----
    def add_occurrence(self, task_id: str, occ: dict[str, Any]) -> None:
        cols = [
            "occurrence_id", "task_id", "document_id", "file_path", "relative_path",
            "file_name", "page_number", "page_index", "page_occurrence_index",
            "source_id",
            "matched_character", "character_variant", "unicode_codepoint",
            "bbox_hash",
            "context_before", "context_after", "context_full", "ocr_confidence",
            "secondary_ocr_result", "verification_status", "location_method",
            "source_page_width", "source_page_height",
            "source_x0", "source_y0", "source_x1", "source_y1",
            "normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1",
            "page_image_relpath", "crop_image_relpath",
            "page_image_width", "page_image_height",
        ]
        record = {"occurrence_id": new_id("occ_"), "task_id": task_id}
        record.update(
            {k: v for k, v in occ.items() if k in cols and k not in ("occurrence_id", "task_id")}
        )
        placeholders = ", ".join("?" for _ in cols)
        # RLock 可重入：add_occurrences 持锁时本方法同线程可再进入
        with self._lock:
            self.conn.execute(
                f"INSERT OR REPLACE INTO occurrences ({', '.join(cols)}) VALUES ({placeholders})",
                [record.get(c) for c in cols],
            )

    def list_processed_page_ids(self, task_id: str, source_id: str) -> list[int]:
        with self._lock:
            return self._list_processed_page_ids_locked(task_id, source_id)

    def _list_processed_page_ids_locked(self, task_id: str, source_id: str) -> list[int]:
        rows = self.conn.execute(
            "SELECT page_no FROM task_processed_pages WHERE task_id=? AND source_id=? ORDER BY page_no ASC",
            (task_id, source_id),
        ).fetchall()
        return [int(row["page_no"]) for row in rows]

    def get_task_checkpoint(self, task_id: str, source_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute(
                """
                SELECT task_id, source_id, last_completed_page, next_page,
                       processed_page_ids_json, worker_generation, updated_at
                FROM task_checkpoints
                WHERE task_id=? AND source_id=?
                """,
                (task_id, source_id),
            ).fetchone()
            if row is None:
                return None
            return {
                "task_id": row["task_id"],
                "source_id": row["source_id"],
                "last_completed_page": int(row["last_completed_page"]),
                "next_page": int(row["next_page"]),
                "processed_page_ids": json.loads(row["processed_page_ids_json"]),
                "worker_generation": int(row["worker_generation"]),
                "updated_at": row["updated_at"],
            }

    def resolve_task_source_id(self, task_id: str) -> str:
        with self._lock:
            queries = [
                (
                    """
                    SELECT source_id
                    FROM task_checkpoints
                    WHERE task_id=? AND source_id <> ''
                    ORDER BY last_completed_page DESC, worker_generation DESC, updated_at DESC, source_id ASC
                    LIMIT 1
                    """,
                    (task_id,),
                ),
                (
                    """
                    SELECT source_id
                    FROM task_processed_pages
                    WHERE task_id=? AND source_id <> ''
                    GROUP BY source_id
                    ORDER BY MAX(page_no) DESC, MAX(created_at) DESC, source_id ASC
                    LIMIT 1
                    """,
                    (task_id,),
                ),
                (
                    """
                    SELECT source_id
                    FROM occurrences
                    WHERE task_id=? AND source_id <> ''
                    GROUP BY source_id
                    ORDER BY MAX(page_number) DESC, COUNT(*) DESC, source_id ASC
                    LIMIT 1
                    """,
                    (task_id,),
                ),
                (
                    """
                    SELECT source_id
                    FROM task_events
                    WHERE task_id=? AND source_id <> ''
                    ORDER BY worker_generation DESC, sequence DESC
                    LIMIT 1
                    """,
                    (task_id,),
                ),
            ]
            for sql, params in queries:
                row = self.conn.execute(sql, params).fetchone()
                if row is not None and row["source_id"]:
                    return str(row["source_id"])
            return ""

    def list_task_events(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT event_id, task_id, source_id, sequence, event_type, payload_json,
                       worker_generation, created_at
                FROM task_events
                WHERE task_id=?
                ORDER BY sequence ASC
                """,
                (task_id,),
            ).fetchall()
            return [
                {
                    "event_id": row["event_id"],
                    "task_id": row["task_id"],
                    "source_id": row["source_id"],
                    "sequence": int(row["sequence"]),
                    "event_type": row["event_type"],
                    "payload": json.loads(row["payload_json"]),
                    "worker_generation": int(row["worker_generation"]),
                    "created_at": row["created_at"],
                }
                for row in rows
            ]

    def append_task_event(
        self,
        *,
        task_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        source_id: str = "",
        worker_generation: int = 0,
    ) -> dict[str, Any]:
        with self._lock:
            try:
                with self.conn:
                    return self._append_task_event_locked(
                        task_id=task_id,
                        event_type=event_type,
                        payload=payload,
                        source_id=source_id,
                        worker_generation=worker_generation,
                    )
            except Exception:
                self.conn.rollback()
                raise

    def _append_task_event_locked(
        self,
        *,
        task_id: str,
        event_type: str,
        payload: dict[str, Any] | None = None,
        source_id: str = "",
        worker_generation: int = 0,
    ) -> dict[str, Any]:
        task = self.conn.execute(
            "SELECT last_event_sequence, worker_generation FROM tasks WHERE task_id=?",
            (task_id,),
        ).fetchone()
        if task is None:
            raise KeyError(task_id)
        sequence = int(task["last_event_sequence"] or 0) + 1
        generation = max(int(task["worker_generation"] or 0), int(worker_generation or 0))
        created_at = now_iso()
        event_id = new_id("evt_")
        self.conn.execute(
            """
            INSERT INTO task_events
                (event_id, task_id, source_id, sequence, event_type, payload_json, worker_generation, created_at)
            VALUES (?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                event_id,
                task_id,
                source_id,
                sequence,
                event_type,
                json.dumps(payload or {}, ensure_ascii=False, separators=(",", ":")),
                generation,
                created_at,
            ),
        )
        self.conn.execute(
            "UPDATE tasks SET last_event_sequence=?, worker_generation=?, updated_at=? WHERE task_id=?",
            (sequence, generation, created_at, task_id),
        )
        return {
            "event_id": event_id,
            "task_id": task_id,
            "source_id": source_id,
            "sequence": sequence,
            "event_type": event_type,
            "payload": payload or {},
            "worker_generation": generation,
            "created_at": created_at,
        }

    def record_page_completion(
        self,
        *,
        task_id: str,
        source_id: str,
        page_no: int,
        worker_generation: int,
        occurrences: Iterable[dict[str, Any]],
    ) -> dict[str, Any]:
        if page_no < 1:
            raise ValueError("page_no must be >= 1")
        occurrence_items = [dict(item) for item in occurrences]
        for item in occurrence_items:
            self._validate_recovery_occurrence(item, source_id=source_id, page_no=page_no)
        with self._lock:
            try:
                with self.conn:
                    for item in occurrence_items:
                        self.add_occurrence(task_id, item)
                    created_at = now_iso()
                    self.conn.execute(
                        """
                        INSERT OR IGNORE INTO task_processed_pages(task_id, source_id, page_no, created_at)
                        VALUES (?, ?, ?, ?)
                        """,
                        (task_id, source_id, page_no, created_at),
                    )
                    processed_page_ids = self._list_processed_page_ids_locked(task_id, source_id)
                    last_completed_page = max(processed_page_ids) if processed_page_ids else 0
                    next_page = last_completed_page + 1
                    self.conn.execute(
                        """
                        INSERT INTO task_checkpoints
                            (task_id, source_id, last_completed_page, next_page, processed_page_ids_json,
                             worker_generation, updated_at)
                        VALUES (?, ?, ?, ?, ?, ?, ?)
                        ON CONFLICT(task_id, source_id) DO UPDATE SET
                            last_completed_page=excluded.last_completed_page,
                            next_page=excluded.next_page,
                            processed_page_ids_json=excluded.processed_page_ids_json,
                            worker_generation=excluded.worker_generation,
                            updated_at=excluded.updated_at
                        """,
                        (
                            task_id,
                            source_id,
                            last_completed_page,
                            next_page,
                            json.dumps(processed_page_ids, ensure_ascii=False, separators=(",", ":")),
                            worker_generation,
                            created_at,
                        ),
                    )
                    self.conn.execute(
                        """
                        UPDATE tasks
                        SET processed_pages=(
                                SELECT COUNT(*) FROM task_processed_pages WHERE task_id=?
                            ),
                            occurrence_count=(
                                SELECT COUNT(*) FROM occurrences WHERE task_id=?
                            ),
                            worker_generation=?,
                            updated_at=?
                        WHERE task_id=?
                        """,
                        (task_id, task_id, worker_generation, created_at, task_id),
                    )
                    event = self._append_task_event_locked(
                        task_id=task_id,
                        event_type="task.progress",
                        payload={
                            "page_no": page_no,
                            "processed_pages": len(processed_page_ids),
                            "source_id": source_id,
                        },
                        source_id=source_id,
                        worker_generation=worker_generation,
                    )
                checkpoint = self.get_task_checkpoint(task_id, source_id)
                assert checkpoint is not None
                return {
                    "processed_page_ids": processed_page_ids,
                    "checkpoint": checkpoint,
                    "event": event,
                }
            except Exception:
                self.conn.rollback()
                raise

    def _validate_recovery_occurrence(self, occurrence: dict[str, Any], *, source_id: str, page_no: int) -> None:
        matched = occurrence.get("matched_character")
        if not isinstance(matched, str) or not matched:
            raise ValueError("matched_character is required")
        bbox_hash = occurrence.get("bbox_hash")
        if not isinstance(bbox_hash, str) or not bbox_hash:
            raise ValueError("bbox_hash is required")
        occurrence.setdefault("source_id", source_id)
        occurrence.setdefault("page_number", page_no)

    def reconcile_incomplete_tasks(self, reason: str) -> int:
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT task_id, worker_generation
                FROM tasks
                WHERE status IN ('starting', 'running', 'pausing', 'stopping')
                """
            ).fetchall()
            changed = 0
            try:
                with self.conn:
                    for row in rows:
                        task_id = row["task_id"]
                        changed += 1
                        updated_at = now_iso()
                        self.conn.execute(
                            """
                            UPDATE tasks
                            SET status='recoverable', error_code=?, error_message=?, updated_at=?
                            WHERE task_id=?
                            """,
                            (reason, f"task interrupted: {reason}", updated_at, task_id),
                        )
                        self._append_task_event_locked(
                            task_id=task_id,
                            event_type="task.recoverable",
                            payload={"reason": reason},
                            worker_generation=int(row["worker_generation"] or 0),
                        )
            except Exception:
                self.conn.rollback()
                raise
            return changed

    def add_occurrences(self, task_id: str, items: Iterable[dict[str, Any]]) -> int:
        count = 0
        with self._lock:
            try:
                with self.conn:  # 显式事务
                    for occ in items:
                        self.add_occurrence(task_id, occ)
                        count += 1
                self.conn.execute(
                    "UPDATE tasks SET occurrence_count=?, updated_at=? WHERE task_id=?",
                    (self._count_occurrences(task_id), now_iso(), task_id),
                )
                self.conn.commit()
            except Exception:
                self.conn.rollback()
                raise
        return count

    def _count_occurrences(self, task_id: str) -> int:
        # 调用方持锁；不再单独 with（RLock 可重入也行，但避免重复）
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
        with self._lock:
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
        with self._lock:
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
        with self._lock:
            try:
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
            except Exception:
                self.conn.rollback()
                raise
        return updated

    def list_reviews(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM review_records WHERE task_id=? ORDER BY updated_at DESC",
                (task_id,),
            ).fetchall()
        return [dict(r) for r in rows]

    # ---- exports ----
    def add_export(self, *, task_id: str, kind: str, path: str) -> str:
        export_id = new_id("exp_")
        with self._lock:
            self.conn.execute(
                "INSERT INTO exports (export_id, task_id, kind, path, created_at) VALUES (?,?,?,?,?)",
                (export_id, task_id, kind, path, now_iso()),
            )
            self.conn.commit()
        return export_id

    # ---- lifecycle ----
    def close(self) -> None:
        with self._lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()


__all__ = ["TaskStore", "SCHEMA_VERSION", "SCHEMA_SQL", "now_iso", "new_id"]
