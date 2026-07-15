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
from contextlib import contextmanager
from datetime import datetime, timezone
from pathlib import Path
from typing import Any, Iterable, Iterator

from ..search_terms import (
    EXACT_LITERAL_SEARCH_MODE,
    LEGACY_SEARCH_MODE,
    LEGACY_SEARCH_TERMS,
    unicode_sequence,
)

SCHEMA_VERSION = 6
LEGACY_TASK_REQUIRES_REVIEW = "LEGACY_TASK_REQUIRES_REVIEW"
DEFAULT_REVIEW_IMAGE_QUALITY = "maximum"
DEFAULT_CONTEXT_DIRECTION = "ltr"
DEFAULT_CONTEXT_RADIUS = 15

SCHEMA_SQL = """
CREATE TABLE IF NOT EXISTS tasks (
    task_id TEXT PRIMARY KEY,
    name TEXT NOT NULL DEFAULT '',
    source_dir TEXT NOT NULL DEFAULT '',
    source_kind TEXT NOT NULL DEFAULT 'folder',
    source_label TEXT NOT NULL DEFAULT '',
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
    error_message TEXT,
    search_terms_json TEXT NOT NULL DEFAULT '["约","約"]',
    search_mode TEXT NOT NULL DEFAULT 'legacy_fixed_pair',
    review_image_quality TEXT NOT NULL DEFAULT 'maximum',
    context_direction TEXT NOT NULL DEFAULT 'ltr',
    context_radius INTEGER NOT NULL DEFAULT 15
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
    matched_text TEXT,
    match_start INTEGER,
    match_end INTEGER,
    unicode_sequence TEXT,
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
CREATE TABLE IF NOT EXISTS task_failures (
    failure_id TEXT PRIMARY KEY,
    task_id TEXT NOT NULL,
    file_path TEXT NOT NULL DEFAULT '',
    page_number INTEGER,
    stage TEXT NOT NULL DEFAULT '',
    error_type TEXT NOT NULL DEFAULT '',
    error_message TEXT NOT NULL DEFAULT '',
    possible_missed_hits INTEGER NOT NULL DEFAULT 1,
    payload_json TEXT NOT NULL DEFAULT '{}',
    created_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS idx_task_failures_task ON task_failures(task_id);
CREATE TABLE IF NOT EXISTS task_sources (
    task_id TEXT NOT NULL,
    ordinal INTEGER NOT NULL,
    source_id TEXT NOT NULL,
    file_path TEXT NOT NULL,
    display_path TEXT NOT NULL,
    file_name TEXT NOT NULL DEFAULT '',
    created_at TEXT NOT NULL,
    PRIMARY KEY (task_id, ordinal),
    UNIQUE (task_id, source_id),
    UNIQUE (task_id, file_path)
);
CREATE INDEX IF NOT EXISTS idx_task_sources_task ON task_sources(task_id, ordinal);
CREATE TABLE IF NOT EXISTS schema_meta (
    key TEXT PRIMARY KEY,
    value TEXT NOT NULL
);
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
        current = int(self.conn.execute("PRAGMA user_version").fetchone()[0] or 0)
        if current == SCHEMA_VERSION:
            return
        if current > SCHEMA_VERSION:
            raise RuntimeError(f"unsupported schema version: {current} > {SCHEMA_VERSION}")
        try:
            self.conn.execute("BEGIN IMMEDIATE")
            self._execute_schema_sql(SCHEMA_SQL)
            if current > 0:
                self._migrate_schema(current)
            else:
                self._create_occurrence_business_indexes()
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

    def _create_occurrence_business_indexes(self) -> None:
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_occ_business_key "
            "ON occurrences(task_id, source_id, page_number, matched_character, bbox_hash) "
            "WHERE source_id <> '' AND bbox_hash <> ''"
        )
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_occ_business_key_matched_text "
            "ON occurrences(task_id, source_id, page_number, matched_text, bbox_hash) "
            "WHERE source_id <> '' AND bbox_hash <> '' AND matched_text IS NOT NULL AND matched_text <> ''"
        )

    def _migrate_schema(self, current: int) -> None:
        self._ensure_column("tasks", "source_kind", "TEXT NOT NULL DEFAULT 'folder'")
        self._ensure_column("tasks", "source_label", "TEXT NOT NULL DEFAULT ''")
        self._ensure_column("tasks", "last_event_sequence", "INTEGER NOT NULL DEFAULT 0")
        self._ensure_column("tasks", "worker_generation", "INTEGER NOT NULL DEFAULT 0")
        self._ensure_column("tasks", "search_terms_json", "TEXT NOT NULL DEFAULT '[\"约\",\"約\"]'")
        self._ensure_column("tasks", "search_mode", "TEXT NOT NULL DEFAULT 'legacy_fixed_pair'")
        # 旧任务的出处页由 144 DPI / WebP 70 生成，不能标记成新版本的“最清晰”。
        self._ensure_column("tasks", "review_image_quality", "TEXT NOT NULL DEFAULT 'standard'")
        self._ensure_column("tasks", "context_direction", "TEXT NOT NULL DEFAULT 'ltr'")
        self._ensure_column("tasks", "context_radius", "INTEGER NOT NULL DEFAULT 15")
        self._ensure_column("occurrences", "source_id", "TEXT NOT NULL DEFAULT ''")
        self._ensure_column("occurrences", "bbox_hash", "TEXT NOT NULL DEFAULT ''")
        self._ensure_column("occurrences", "matched_text", "TEXT")
        self._ensure_column("occurrences", "match_start", "INTEGER")
        self._ensure_column("occurrences", "match_end", "INTEGER")
        self._ensure_column("occurrences", "unicode_sequence", "TEXT")
        legacy_terms_json = json.dumps(list(LEGACY_SEARCH_TERMS), ensure_ascii=False, separators=(",", ":"))
        self.conn.execute(
            "UPDATE tasks SET search_terms_json=? WHERE search_terms_json IS NULL OR TRIM(search_terms_json)=''",
            (legacy_terms_json,),
        )
        self.conn.execute(
            "UPDATE tasks SET search_mode=? WHERE search_mode IS NULL OR TRIM(search_mode)=''",
            (LEGACY_SEARCH_MODE,),
        )
        self.conn.execute(
            "UPDATE tasks SET source_kind='folder' WHERE source_kind IS NULL OR TRIM(source_kind)=''",
        )
        self.conn.execute(
            "UPDATE tasks SET source_label=source_dir WHERE source_label IS NULL OR TRIM(source_label)=''",
        )
        self.conn.execute(
            "UPDATE occurrences SET matched_text=matched_character "
            "WHERE (matched_text IS NULL OR matched_text='') AND matched_character IS NOT NULL"
        )
        missing_sequences = self.conn.execute(
            "SELECT occurrence_id, matched_text FROM occurrences "
            "WHERE (unicode_sequence IS NULL OR unicode_sequence='') AND matched_text IS NOT NULL AND matched_text<>''"
        ).fetchall()
        for row in missing_sequences:
            self.conn.execute(
                "UPDATE occurrences SET unicode_sequence=? WHERE occurrence_id=?",
                (unicode_sequence(str(row["matched_text"])), row["occurrence_id"]),
            )
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_occ_business_key "
            "ON occurrences(task_id, source_id, page_number, matched_character, bbox_hash) "
            "WHERE source_id <> '' AND bbox_hash <> ''"
        )
        duplicates = self.conn.execute(
            """
            SELECT task_id, source_id, page_number, matched_text, bbox_hash, COUNT(*) AS count
            FROM occurrences
            WHERE source_id <> '' AND bbox_hash <> '' AND matched_text IS NOT NULL AND matched_text <> ''
            GROUP BY task_id, source_id, page_number, matched_text, bbox_hash
            HAVING COUNT(*) > 1
            """
        ).fetchall()
        if duplicates:
            raise RuntimeError("migration found duplicate occurrence business keys; refusing to discard evidence")
        self.conn.execute(
            "CREATE UNIQUE INDEX IF NOT EXISTS idx_occ_business_key_matched_text "
            "ON occurrences(task_id, source_id, page_number, matched_text, bbox_hash) "
            "WHERE source_id <> '' AND bbox_hash <> '' AND matched_text IS NOT NULL AND matched_text <> ''"
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
        self.conn.execute(
            """
            CREATE TABLE IF NOT EXISTS task_sources (
                task_id TEXT NOT NULL,
                ordinal INTEGER NOT NULL,
                source_id TEXT NOT NULL,
                file_path TEXT NOT NULL,
                display_path TEXT NOT NULL,
                file_name TEXT NOT NULL DEFAULT '',
                created_at TEXT NOT NULL,
                PRIMARY KEY (task_id, ordinal),
                UNIQUE (task_id, source_id),
                UNIQUE (task_id, file_path)
            )
            """
        )
        self.conn.execute("CREATE INDEX IF NOT EXISTS idx_task_sources_task ON task_sources(task_id, ordinal)")
        if current < 2:
            self._mark_untrusted_legacy_tasks_for_review()

    def _mark_untrusted_legacy_tasks_for_review(self) -> None:
        """Prevent v1 tasks from resuming without authoritative page progress."""
        rows = self.conn.execute(
            """
            SELECT task_id, search_terms_json, search_mode, worker_generation
            FROM tasks
            WHERE status IN ('queued', 'starting', 'running', 'pausing', 'paused', 'recoverable', 'stale')
            """
        ).fetchall()
        for row in rows:
            task_id = str(row["task_id"])
            self.conn.execute(
                """
                UPDATE tasks
                SET status='recoverable', error_code=?,
                    error_message='Legacy task progress cannot be verified. Review or restart the task manually.'
                WHERE task_id=?
                """,
                (LEGACY_TASK_REQUIRES_REVIEW, task_id),
            )
            terms = json.loads(row["search_terms_json"])
            self._append_task_event_locked(
                task_id=task_id,
                event_type="task.recoverable",
                payload={
                    "reason": LEGACY_TASK_REQUIRES_REVIEW,
                    "search_text": " / ".join(terms),
                    "search_terms": terms,
                    "search_mode": row["search_mode"],
                },
                worker_generation=int(row["worker_generation"] or 0),
            )
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
        source_kind: str = "folder",
        source_label: str = "",
        source_files: Iterable[dict[str, Any]] | None = None,
        output_dir: str = "",
        workspace_dir: str = "",
        name: str = "",
        is_demo: bool = False,
        file_count: int = 0,
        total_pages: int = 0,
        status: str = "draft",
        search_terms: Iterable[str] | None = None,
        search_mode: str = LEGACY_SEARCH_MODE,
        review_image_quality: str = DEFAULT_REVIEW_IMAGE_QUALITY,
        context_direction: str = DEFAULT_CONTEXT_DIRECTION,
        context_radius: int = DEFAULT_CONTEXT_RADIUS,
    ) -> str:
        task_id = new_id("task_")
        created = now_iso()
        normalized_terms = self._validate_task_search_terms(search_terms, search_mode)
        with self._lock:
            with self.conn:
                self._insert_task_locked(
                    task_id=task_id,
                    created_at=created,
                    source_dir=source_dir,
                    source_kind=source_kind,
                    source_label=source_label,
                    output_dir=output_dir,
                    workspace_dir=workspace_dir,
                    name=name,
                    is_demo=is_demo,
                    file_count=file_count,
                    total_pages=total_pages,
                    status=status,
                    search_terms=normalized_terms,
                    search_mode=search_mode,
                    review_image_quality=review_image_quality,
                    context_direction=context_direction,
                    context_radius=context_radius,
                )
                self._insert_task_sources_locked(task_id, source_files, created)
        return task_id

    def create_task_with_event(
        self,
        *,
        event_type: str,
        event_payload: dict[str, Any] | None = None,
        source_dir: str = "",
        source_kind: str = "folder",
        source_label: str = "",
        source_files: Iterable[dict[str, Any]] | None = None,
        output_dir: str = "",
        workspace_dir: str = "",
        name: str = "",
        is_demo: bool = False,
        file_count: int = 0,
        total_pages: int = 0,
        status: str = "draft",
        search_terms: Iterable[str] | None = None,
        search_mode: str = LEGACY_SEARCH_MODE,
        review_image_quality: str = DEFAULT_REVIEW_IMAGE_QUALITY,
        context_direction: str = DEFAULT_CONTEXT_DIRECTION,
        context_radius: int = DEFAULT_CONTEXT_RADIUS,
    ) -> tuple[str, dict[str, Any]]:
        task_id = new_id("task_")
        created = now_iso()
        normalized_terms = self._validate_task_search_terms(search_terms, search_mode)
        with self._lock:
            try:
                with self.conn:
                    self._insert_task_locked(
                        task_id=task_id,
                        created_at=created,
                        source_dir=source_dir,
                        source_kind=source_kind,
                        source_label=source_label,
                        output_dir=output_dir,
                        workspace_dir=workspace_dir,
                        name=name,
                        is_demo=is_demo,
                        file_count=file_count,
                        total_pages=total_pages,
                        status=status,
                        search_terms=normalized_terms,
                        search_mode=search_mode,
                        review_image_quality=review_image_quality,
                        context_direction=context_direction,
                        context_radius=context_radius,
                    )
                    self._insert_task_sources_locked(task_id, source_files, created)
                    event = self._append_task_event_locked(
                        task_id=task_id,
                        event_type=event_type,
                        payload=event_payload,
                    )
                return task_id, event
            except Exception:
                self.conn.rollback()
                raise

    @staticmethod
    def _validate_task_search_terms(
        search_terms: Iterable[str] | None,
        search_mode: str,
    ) -> list[str]:
        normalized_terms = list(search_terms) if search_terms is not None else list(LEGACY_SEARCH_TERMS)
        if not normalized_terms or any(not isinstance(term, str) or not term for term in normalized_terms):
            raise ValueError("search_terms must contain at least one non-empty term")
        if search_mode == EXACT_LITERAL_SEARCH_MODE and len(normalized_terms) != 1:
            raise ValueError("exact_literal tasks require one search term")
        return normalized_terms

    def _insert_task_locked(
        self,
        *,
        task_id: str,
        created_at: str,
        source_dir: str,
        source_kind: str,
        source_label: str,
        output_dir: str,
        workspace_dir: str,
        name: str,
        is_demo: bool,
        file_count: int,
        total_pages: int,
        status: str,
        search_terms: list[str],
        search_mode: str,
        review_image_quality: str,
        context_direction: str,
        context_radius: int,
    ) -> None:
        self.conn.execute(
            """INSERT INTO tasks
               (task_id, name, source_dir, source_kind, source_label, output_dir, workspace_dir, status,
                is_demo, file_count, total_pages, created_at, updated_at, search_terms_json, search_mode,
                review_image_quality, context_direction, context_radius)
               VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)""",
            (
                task_id, name, source_dir, source_kind, source_label or source_dir, output_dir, workspace_dir, status,
                1 if is_demo else 0, file_count, total_pages, created_at, created_at,
                json.dumps(search_terms, ensure_ascii=False, separators=(",", ":")), search_mode,
                review_image_quality, context_direction, context_radius,
            ),
        )

    def _insert_task_sources_locked(
        self,
        task_id: str,
        source_files: Iterable[dict[str, Any]] | None,
        created_at: str,
    ) -> None:
        if source_files is None:
            return
        for ordinal, source in enumerate(source_files):
            file_path = str(source["file_path"])
            source_id = str(source["source_id"])
            display_path = str(source.get("display_path") or file_path)
            self.conn.execute(
                """
                INSERT INTO task_sources(task_id, ordinal, source_id, file_path, display_path, file_name, created_at)
                VALUES (?, ?, ?, ?, ?, ?, ?)
                """,
                (task_id, ordinal, source_id, file_path, display_path, str(source.get("file_name") or Path(file_path).name), created_at),
            )

    def get_task(self, task_id: str) -> dict[str, Any] | None:
        with self._lock:
            row = self.conn.execute("SELECT * FROM tasks WHERE task_id=?", (task_id,)).fetchone()
            sources = self._list_task_sources_locked(task_id) if row else []
        return self._task_for_api(dict(row), sources=sources) if row else None

    def list_tasks(
        self,
        *,
        limit: int = 50,
        offset: int = 0,
        status: str | None = None,
        query: str | None = None,
    ) -> list[dict[str, Any]]:
        where_sql, params = self._task_list_filter(status=status, query=query)
        with self._lock:
            cur = self.conn.execute(
                f"SELECT * FROM tasks{where_sql} ORDER BY created_at DESC LIMIT ? OFFSET ?",
                (*params, limit, offset),
            )
            rows = [dict(row) for row in cur.fetchall()]
            source_map = self._list_task_sources_for_tasks_locked([str(row["task_id"]) for row in rows])
            return [self._task_for_api(row, sources=source_map.get(str(row["task_id"]), [])) for row in rows]

    def count_tasks(self, *, status: str | None = None, query: str | None = None) -> int:
        where_sql, params = self._task_list_filter(status=status, query=query)
        with self._lock:
            row = self.conn.execute(f"SELECT COUNT(*) AS count FROM tasks{where_sql}", params).fetchone()
        return int(row["count"] if row else 0)

    @staticmethod
    def _task_list_filter(*, status: str | None, query: str | None) -> tuple[str, tuple[Any, ...]]:
        clauses: list[str] = []
        params: list[Any] = []
        if status:
            clauses.append("status=?")
            params.append(status)
        normalized_query = (query or "").strip()
        if normalized_query:
            clauses.append(
                "(instr(name, ?) > 0 OR instr(source_dir, ?) > 0 OR instr(source_label, ?) > 0 "
                "OR instr(search_terms_json, ?) > 0 OR EXISTS (SELECT 1 FROM task_sources "
                "WHERE task_sources.task_id=tasks.task_id AND (instr(display_path, ?) > 0 OR instr(file_path, ?) > 0)))"
            )
            params.extend([normalized_query] * 6)
        return (f" WHERE {' AND '.join(clauses)}" if clauses else "", tuple(params))

    def _list_task_sources_locked(self, task_id: str) -> list[dict[str, Any]]:
        rows = self.conn.execute(
            "SELECT source_id, file_path, display_path, file_name, ordinal FROM task_sources WHERE task_id=? ORDER BY ordinal",
            (task_id,),
        ).fetchall()
        return [dict(row) for row in rows]

    def _list_task_sources_for_tasks_locked(self, task_ids: list[str]) -> dict[str, list[dict[str, Any]]]:
        if not task_ids:
            return {}
        placeholders = ", ".join("?" for _ in task_ids)
        rows = self.conn.execute(
            f"SELECT task_id, source_id, file_path, display_path, file_name, ordinal FROM task_sources WHERE task_id IN ({placeholders}) ORDER BY task_id, ordinal",
            task_ids,
        ).fetchall()
        result: dict[str, list[dict[str, Any]]] = {}
        for row in rows:
            source = dict(row)
            result.setdefault(str(source.pop("task_id")), []).append(source)
        return result

    def list_task_sources(self, task_id: str) -> list[dict[str, Any]]:
        with self._lock:
            return self._list_task_sources_locked(task_id)

    def _task_for_api(self, task: dict[str, Any], *, sources: list[dict[str, Any]] | None = None) -> dict[str, Any]:
        raw_terms = task.get("search_terms_json")
        try:
            search_terms = json.loads(raw_terms) if isinstance(raw_terms, str) else list(LEGACY_SEARCH_TERMS)
        except json.JSONDecodeError:
            search_terms = list(LEGACY_SEARCH_TERMS)
        if not isinstance(search_terms, list) or not all(isinstance(term, str) and term for term in search_terms):
            search_terms = list(LEGACY_SEARCH_TERMS)
        task["search_terms"] = search_terms
        task["search_mode"] = task.get("search_mode") or LEGACY_SEARCH_MODE
        task["search_text"] = search_terms[0] if len(search_terms) == 1 else " / ".join(search_terms)
        task["source_kind"] = task.get("source_kind") or "folder"
        task["source_label"] = task.get("source_label") or task.get("source_dir") or ""
        task["review_preferences"] = {
            # Legacy database column remains readable for rollback, but page
            # image rendering no longer has selectable quality tiers.
            "page_quality": "maximum",
            "context_direction": task.get("context_direction") or DEFAULT_CONTEXT_DIRECTION,
            "context_radius": int(task.get("context_radius") or DEFAULT_CONTEXT_RADIUS),
        }
        if task["source_kind"] == "files":
            task["source_files"] = [str(source["file_path"]) for source in (sources or [])]
        return task

    def update_task(self, task_id: str, **fields: Any) -> None:
        if not fields:
            return
        if {"search_terms_json", "search_mode", "search_terms", "search_text"} & set(fields):
            raise ValueError("task search terms are immutable")
        fields.setdefault("updated_at", now_iso())
        cols = ", ".join(f"{k}=?" for k in fields)
        vals = list(fields.values()) + [task_id]
        with self._lock:
            self.conn.execute(f"UPDATE tasks SET {cols} WHERE task_id=?", vals)
            self.conn.commit()

    def delete_task(self, task_id: str) -> bool:
        """删除一个任务及其全部本地派生记录；不处理任何来源文件。"""
        with self._lock:
            with self.conn:
                for table in (
                    "review_records",
                    "occurrences",
                    "task_processed_pages",
                    "task_checkpoints",
                    "task_events",
                    "exports",
                    "task_failures",
                    "task_sources",
                ):
                    self.conn.execute(f"DELETE FROM {table} WHERE task_id=?", (task_id,))
                cursor = self.conn.execute("DELETE FROM tasks WHERE task_id=?", (task_id,))
        return cursor.rowcount == 1

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
            "matched_character", "character_variant", "matched_text", "match_start", "match_end",
            "unicode_sequence", "unicode_codepoint",
            "bbox_hash",
            "context_before", "context_after", "context_full", "ocr_confidence",
            "secondary_ocr_result", "verification_status", "location_method",
            "source_page_width", "source_page_height",
            "source_x0", "source_y0", "source_x1", "source_y1",
            "normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1",
            "page_image_relpath", "crop_image_relpath",
            "page_image_width", "page_image_height",
        ]
        record = {
            "occurrence_id": occ.get("occurrence_id") or new_id("occ_"),
            "task_id": task_id,
            "source_id": "",
            "bbox_hash": "",
        }
        record.update(
            {k: v for k, v in occ.items() if k in cols and k not in ("occurrence_id", "task_id")}
        )
        record["matched_text"] = record.get("matched_text") or record.get("matched_character")
        if record.get("matched_text") and not record.get("unicode_sequence"):
            record["unicode_sequence"] = unicode_sequence(str(record["matched_text"]))
        if record.get("matched_text") and len(str(record["matched_text"])) == 1 and not record.get("matched_character"):
            record["matched_character"] = record["matched_text"]
        placeholders = ", ".join("?" for _ in cols)
        # RLock 可重入：add_occurrences 持锁时本方法同线程可再进入
        with self._lock:
            self.conn.execute(
                f"INSERT OR IGNORE INTO occurrences ({', '.join(cols)}) VALUES ({placeholders})",
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

    def list_task_resume_states(self, task_id: str) -> dict[str, dict[str, Any]]:
        """Return SQLite-authoritative resume state grouped by stable source id."""
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT source_id FROM task_checkpoints WHERE task_id=? AND source_id<>''
                UNION
                SELECT source_id FROM task_processed_pages WHERE task_id=? AND source_id<>''
                ORDER BY source_id
                """,
                (task_id, task_id),
            ).fetchall()
            states: dict[str, dict[str, Any]] = {}
            for row in rows:
                source_id = str(row["source_id"])
                processed_page_ids = self._list_processed_page_ids_locked(task_id, source_id)
                checkpoint = self.get_task_checkpoint(task_id, source_id)
                states[source_id] = {
                    "source_id": source_id,
                    "processed_page_ids": processed_page_ids,
                    "last_completed_page": max(processed_page_ids) if processed_page_ids else 0,
                    "next_page": self._first_missing_page(processed_page_ids),
                    "worker_generation": int(checkpoint["worker_generation"]) if checkpoint else 0,
                }
            return states

    @staticmethod
    def _first_missing_page(processed_page_ids: Iterable[int]) -> int:
        processed = {int(page_no) for page_no in processed_page_ids if int(page_no) > 0}
        candidate = 1
        while candidate in processed:
            candidate += 1
        return candidate

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
            existing = self.conn.execute(
                "SELECT 1 FROM task_processed_pages WHERE task_id=? AND source_id=? AND page_no=?",
                (task_id, source_id, page_no),
            ).fetchone()
            if existing is not None:
                processed_page_ids = self._list_processed_page_ids_locked(task_id, source_id)
                checkpoint = self.get_task_checkpoint(task_id, source_id)
                return {
                    "processed_page_ids": processed_page_ids,
                    "checkpoint": checkpoint,
                    "event": None,
                    "already_processed": True,
                }
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
                    next_page = self._first_missing_page(processed_page_ids)
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
                    "already_processed": False,
                }
            except Exception:
                self.conn.rollback()
                raise

    def _validate_recovery_occurrence(self, occurrence: dict[str, Any], *, source_id: str, page_no: int) -> None:
        matched = occurrence.get("matched_text") or occurrence.get("matched_character")
        if not isinstance(matched, str) or not matched:
            raise ValueError("matched_text is required")
        occurrence.setdefault("matched_text", matched)
        if len(matched) == 1:
            occurrence.setdefault("matched_character", matched)
        occurrence.setdefault("unicode_sequence", unicode_sequence(matched))
        bbox_hash = occurrence.get("bbox_hash")
        if not isinstance(bbox_hash, str) or not bbox_hash:
            raise ValueError("bbox_hash is required")
        occurrence.setdefault("source_id", source_id)
        occurrence.setdefault("page_number", page_no)

    def reconcile_incomplete_tasks(self, reason: str) -> int:
        with self._lock:
            rows = self.conn.execute(
                """
                SELECT task_id, worker_generation, search_terms_json, search_mode
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
                            payload={
                                "reason": reason,
                                "search_text": " / ".join(json.loads(row["search_terms_json"])),
                                "search_terms": json.loads(row["search_terms_json"]),
                                "search_mode": row["search_mode"],
                            },
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
        total_override: int | None = None,
    ) -> tuple[int, list[dict[str, Any]]]:
        clause, params = self._occurrence_filter_clause(
            task_id=task_id,
            document=document,
            status=status,
            character=character,
            search=search,
        )
        with self._lock:
            total = total_override
            if total is None:
                total = self.conn.execute(
                    f"SELECT COUNT(*) AS n FROM occurrences AS o LEFT JOIN review_records r "
                    f"ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id WHERE {clause}",
                    params,
                ).fetchone()["n"]
            rows = self.conn.execute(
                f"""SELECT o.*, r.decision AS review_decision, r.note AS review_note
                    FROM occurrences o
                    LEFT JOIN review_records r
                      ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id
                    WHERE {clause}
                    ORDER BY COALESCE(o.file_name, ''),
                             o.page_number, o.page_occurrence_index, o.occurrence_id
                    LIMIT ? OFFSET ?""",
                params + [limit, offset],
            ).fetchall()
        return int(total), [dict(r) for r in rows]

    @contextmanager
    def occurrence_export_snapshot(
        self,
        task_id: str,
        *,
        batch_size: int = 500,
    ) -> Iterator[tuple[int, int, Iterator[dict[str, Any]]]]:
        """以独立只读快照分批提供 HTML 导出记录。

        独立连接在 WAL 模式下不会长时间占用 Engine 的共享连接锁；显式读事务
        保证扫描或校对继续写入时，本次阶段性报告仍基于同一个时间点的数据。
        """
        if type(batch_size) is not int or batch_size < 1:
            raise ValueError("batch_size must be a positive integer")
        connection = sqlite3.connect(self.db_path)
        connection.row_factory = sqlite3.Row
        try:
            connection.execute("PRAGMA query_only = ON")
            connection.execute("PRAGMA busy_timeout = 5000")
            connection.execute("BEGIN")
            total = int(
                connection.execute(
                    "SELECT COUNT(*) FROM occurrences WHERE task_id=?",
                    (task_id,),
                ).fetchone()[0]
            )
            page_count = int(
                connection.execute(
                    """
                    SELECT COUNT(*) FROM (
                        SELECT 1
                        FROM occurrences
                        WHERE task_id=?
                        GROUP BY COALESCE(document_id, source_id, relative_path, file_name, ''),
                                 page_number, COALESCE(page_image_relpath, '')
                    )
                    """,
                    (task_id,),
                ).fetchone()[0]
            )
            cursor = connection.execute(
                """
                SELECT o.*, r.decision AS review_decision, r.note AS review_note,
                       ts.ordinal AS source_ordinal,
                       ts.display_path AS source_display_path
                FROM occurrences o
                LEFT JOIN review_records r
                  ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id
                LEFT JOIN task_sources ts
                  ON ts.task_id = o.task_id AND ts.source_id = o.source_id
                WHERE o.task_id=?
                ORDER BY CASE WHEN ts.ordinal IS NULL THEN 1 ELSE 0 END,
                         ts.ordinal,
                         COALESCE(o.relative_path, o.file_name, ''),
                         o.page_number, o.page_occurrence_index, o.occurrence_id
                """,
                (task_id,),
            )

            def rows() -> Iterator[dict[str, Any]]:
                while True:
                    batch = cursor.fetchmany(batch_size)
                    if not batch:
                        return
                    for row in batch:
                        yield dict(row)

            yield total, page_count, rows()
        finally:
            connection.rollback()
            connection.close()

    @staticmethod
    def _occurrence_filter_clause(
        *,
        task_id: str,
        document: str | None,
        status: str | None,
        character: str | None,
        search: str | None,
    ) -> tuple[str, list[Any]]:
        where = ["o.task_id=?"]
        params: list[Any] = [task_id]
        if document:
            where.append("(o.file_name=? OR o.relative_path=?)")
            params.extend([document, document])
        if status:
            if status == "unreviewed":
                where.append("r.decision IS NULL")
            else:
                where.append("r.decision=?")
                params.append(status)
        if character:
            where.append("o.character_variant=?")
            params.append(character)
        if search:
            where.append("o.context_full LIKE ?")
            params.append(f"%{search}%")
        return " AND ".join(where), params

    def get_occurrence_review_summary(
        self,
        *,
        task_id: str,
        document: str | None = None,
        status: str | None = None,
        character: str | None = None,
        search: str | None = None,
    ) -> dict[str, int]:
        """返回与结果列表使用相同筛选条件的人工校对统计。"""
        clause, params = self._occurrence_filter_clause(
            task_id=task_id,
            document=document,
            status=status,
            character=character,
            search=search,
        )
        with self._lock:
            row = self.conn.execute(
                f"""SELECT
                        COUNT(*) AS total_count,
                        SUM(CASE WHEN r.decision IS NOT NULL THEN 1 ELSE 0 END) AS reviewed_count,
                        SUM(CASE WHEN r.decision = 'confirmed' THEN 1 ELSE 0 END) AS confirmed_count,
                        SUM(CASE WHEN r.decision = 'needs_review' THEN 1 ELSE 0 END) AS needs_review_count,
                        SUM(CASE WHEN r.decision = 'rejected' THEN 1 ELSE 0 END) AS rejected_count
                    FROM occurrences o
                    LEFT JOIN review_records r
                      ON r.task_id = o.task_id AND r.occurrence_id = o.occurrence_id
                    WHERE {clause}""",
                params,
            ).fetchone()
        total = int(row["total_count"] or 0)
        reviewed = int(row["reviewed_count"] or 0)
        return {
            "reviewed_count": reviewed,
            "unreviewed_count": total - reviewed,
            "confirmed_count": int(row["confirmed_count"] or 0),
            "needs_review_count": int(row["needs_review_count"] or 0),
            "rejected_count": int(row["rejected_count"] or 0),
        }

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

    def list_exports(self, *, task_id: str, limit: int = 20, offset: int = 0) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT * FROM exports WHERE task_id=? ORDER BY rowid DESC LIMIT ? OFFSET ?",
                (task_id, limit, offset),
            ).fetchall()
        return [dict(row) for row in rows]

    # ---- task failures ----
    def replace_task_failures(self, task_id: str, failures: Iterable[dict[str, Any]]) -> int:
        rows = [dict(failure) for failure in failures]
        created_at = now_iso()
        with self._lock:
            with self.conn:
                self.conn.execute("DELETE FROM task_failures WHERE task_id=?", (task_id,))
                for failure in rows:
                    failure_id = str(failure.get("failure_id") or new_id("fail_"))
                    self.conn.execute(
                        """
                        INSERT INTO task_failures (
                            failure_id, task_id, file_path, page_number, stage, error_type,
                            error_message, possible_missed_hits, payload_json, created_at
                        ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
                        """,
                        (
                            failure_id,
                            task_id,
                            str(failure.get("file_path") or ""),
                            failure.get("page_number"),
                            str(failure.get("stage") or ""),
                            str(failure.get("error_type") or ""),
                            str(failure.get("error_message") or ""),
                            1 if failure.get("possible_missed_hits", True) else 0,
                            json.dumps({**failure, "failure_id": failure_id}, ensure_ascii=False),
                            created_at,
                        ),
                    )
        return len(rows)

    def list_task_failures(self, task_id: str, *, limit: int = 100) -> list[dict[str, Any]]:
        with self._lock:
            rows = self.conn.execute(
                "SELECT payload_json FROM task_failures WHERE task_id=? ORDER BY rowid LIMIT ?",
                (task_id, limit),
            ).fetchall()
        failures: list[dict[str, Any]] = []
        for row in rows:
            try:
                payload = json.loads(row["payload_json"])
            except (TypeError, json.JSONDecodeError):
                continue
            if isinstance(payload, dict):
                failures.append(payload)
        return failures

    # ---- lifecycle ----
    def close(self) -> None:
        with self._lock:
            try:
                self.conn.execute("PRAGMA wal_checkpoint(TRUNCATE)")
            except sqlite3.Error:
                pass
            self.conn.close()


__all__ = ["TaskStore", "SCHEMA_VERSION", "SCHEMA_SQL", "now_iso", "new_id"]
