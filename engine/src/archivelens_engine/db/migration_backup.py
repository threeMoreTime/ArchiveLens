"""SQLite schema 迁移前的一致性备份与失败恢复。

备份只包含会被 schema 迁移修改的 SQLite 数据库；页面图片和来源文件不会复制或删除。
每份备份与最小元数据成对保存在数据库同级 ``backups`` 目录，默认保留最近三份。
"""

from __future__ import annotations

from dataclasses import dataclass
from datetime import datetime, timezone
import hashlib
import json
import os
from pathlib import Path
import shutil
import sqlite3
import stat
import uuid
from typing import Any


BACKUP_METADATA_VERSION = 1
DEFAULT_BACKUP_RETENTION = 3
FILE_ATTRIBUTE_REPARSE_POINT = 0x0400


class MigrationBackupError(RuntimeError):
    """迁移备份无法安全建立或校验。"""


class MigrationRecoveryError(RuntimeError):
    """迁移失败后无法从已校验备份恢复；调用方必须停止写入。"""


@dataclass(frozen=True)
class MigrationBackupRecord:
    backup_id: str
    database_path: Path
    metadata_path: Path
    database_name: str
    source_schema: int
    target_schema: int
    created_at: str
    size_bytes: int
    sha256: str
    integrity_check: str
    outcome: str
    error_type: str | None = None

    def to_metadata(self) -> dict[str, Any]:
        return {
            "metadata_version": BACKUP_METADATA_VERSION,
            "backup_id": self.backup_id,
            "database_file": self.database_path.name,
            "database_name": self.database_name,
            "source_schema": self.source_schema,
            "target_schema": self.target_schema,
            "created_at": self.created_at,
            "size_bytes": self.size_bytes,
            "sha256": self.sha256,
            "integrity_check": self.integrity_check,
            "outcome": self.outcome,
            "error_type": self.error_type,
        }


def _is_reparse_point(path: Path) -> bool:
    details = path.lstat()
    return stat.S_ISLNK(details.st_mode) or bool(
        getattr(details, "st_file_attributes", 0) & FILE_ATTRIBUTE_REPARSE_POINT
    )


def _sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for chunk in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(chunk)
    return digest.hexdigest()


def _fsync_file(path: Path) -> None:
    # Windows 的 CRT 对只读句柄执行 fsync 可能返回 EBADF；这里仅刷新任务拥有的
    # 临时/备份文件，使用可写二进制句柄，不改变文件内容。
    with path.open("r+b") as handle:
        os.fsync(handle.fileno())


def _inspect_database(path: Path) -> tuple[int, str]:
    connection = sqlite3.connect(path)
    try:
        connection.execute("PRAGMA query_only = ON")
        schema = int(connection.execute("PRAGMA user_version").fetchone()[0] or 0)
        rows = [str(row[0]) for row in connection.execute("PRAGMA integrity_check").fetchall()]
    finally:
        connection.close()
    integrity = "ok" if rows == ["ok"] else "; ".join(rows[:10])
    return schema, integrity


class MigrationBackupManager:
    def __init__(
        self,
        database_path: str | Path,
        *,
        retention: int = DEFAULT_BACKUP_RETENTION,
    ) -> None:
        if retention < 1:
            raise ValueError("migration backup retention must be at least one")
        self.database_path = Path(database_path)
        self.backup_dir = self.database_path.parent / "backups"
        self.retention = retention

    def create(
        self,
        source: sqlite3.Connection,
        *,
        source_schema: int,
        target_schema: int,
    ) -> MigrationBackupRecord:
        if source_schema <= 0 or source_schema >= target_schema:
            raise MigrationBackupError(
                f"invalid migration backup schema range: {source_schema} -> {target_schema}"
            )
        self._ensure_safe_backup_directory()
        backup_id = uuid.uuid4().hex
        timestamp = datetime.now(timezone.utc).strftime("%Y%m%dT%H%M%S.%fZ")
        stem = f"{self.database_path.stem}-schema-v{source_schema}-to-v{target_schema}-{timestamp}-{backup_id}"
        temporary_path = self.backup_dir / f".{stem}.tmp"
        final_path = self.backup_dir / f"{stem}.sqlite3"
        metadata_path = self.backup_dir / f"{stem}.json"
        destination: sqlite3.Connection | None = None
        try:
            destination = sqlite3.connect(temporary_path)
            source.backup(destination)
            destination.close()
            destination = None
            schema, integrity = _inspect_database(temporary_path)
            if schema != source_schema:
                raise MigrationBackupError(
                    f"backup schema mismatch: expected={source_schema} actual={schema}"
                )
            if integrity != "ok":
                raise MigrationBackupError(f"backup integrity_check failed: {integrity}")
            _fsync_file(temporary_path)
            os.replace(temporary_path, final_path)
            record = MigrationBackupRecord(
                backup_id=backup_id,
                database_path=final_path,
                metadata_path=metadata_path,
                database_name=self.database_path.name,
                source_schema=source_schema,
                target_schema=target_schema,
                created_at=datetime.now(timezone.utc).isoformat(),
                size_bytes=final_path.stat().st_size,
                sha256=_sha256(final_path),
                integrity_check="ok",
                outcome="created",
            )
            self._write_metadata(record)
            self._prune_old_backups()
            return record
        except MigrationBackupError:
            raise
        except Exception as error:
            raise MigrationBackupError(
                f"unable to create migration backup: {type(error).__name__}"
            ) from error
        finally:
            if destination is not None:
                destination.close()
            temporary_path.unlink(missing_ok=True)

    def restore(self, record: MigrationBackupRecord) -> None:
        temporary_path = self.database_path.parent / f".{self.database_path.name}.restore-{uuid.uuid4().hex}.tmp"
        try:
            self._validate_record(record)
            shutil.copyfile(record.database_path, temporary_path)
            _fsync_file(temporary_path)
            self._validate_database_copy(temporary_path, record)
            for suffix in ("-wal", "-shm"):
                Path(f"{self.database_path}{suffix}").unlink(missing_ok=True)
            os.replace(temporary_path, self.database_path)
            self._validate_database_copy(self.database_path, record)
        except Exception as error:
            if isinstance(error, MigrationRecoveryError):
                raise
            raise MigrationRecoveryError(
                f"unable to restore migration backup: {type(error).__name__}"
            ) from error
        finally:
            temporary_path.unlink(missing_ok=True)

    def mark_outcome(
        self,
        record: MigrationBackupRecord,
        outcome: str,
        *,
        error_type: str | None = None,
    ) -> MigrationBackupRecord:
        updated = MigrationBackupRecord(
            **{
                **record.__dict__,
                "outcome": outcome,
                "error_type": error_type,
            }
        )
        self._write_metadata(updated)
        return updated

    def list_records(self) -> list[MigrationBackupRecord]:
        if not self.backup_dir.exists():
            return []
        self._assert_safe_existing_path(self.database_path.parent, "database directory")
        self._assert_safe_existing_path(self.backup_dir, "backup directory")
        records: list[MigrationBackupRecord] = []
        prefix = f"{self.database_path.stem}-schema-v"
        for metadata_path in self.backup_dir.glob(f"{prefix}*.json"):
            try:
                self._assert_safe_existing_path(metadata_path, "backup metadata")
                metadata = json.loads(metadata_path.read_text(encoding="utf-8"))
                records.append(self._record_from_metadata(metadata_path, metadata))
            except (OSError, ValueError, TypeError, json.JSONDecodeError):
                continue
        return sorted(records, key=lambda item: (item.created_at, item.backup_id), reverse=True)

    def _ensure_safe_backup_directory(self) -> None:
        self._assert_safe_existing_path(self.database_path.parent, "database directory")
        if self.database_path.exists():
            self._assert_safe_existing_path(self.database_path, "database")
        if self.backup_dir.exists():
            self._assert_safe_existing_path(self.backup_dir, "backup directory")
        else:
            self.backup_dir.mkdir(parents=False, exist_ok=False)
            self._assert_safe_existing_path(self.backup_dir, "backup directory")

    @staticmethod
    def _assert_safe_existing_path(path: Path, label: str) -> None:
        if _is_reparse_point(path):
            raise MigrationBackupError(f"{label} must not be a symlink or reparse point")

    def _validate_record(self, record: MigrationBackupRecord) -> None:
        if record.database_name != self.database_path.name:
            raise MigrationRecoveryError("backup belongs to a different database")
        if record.database_path.parent != self.backup_dir:
            raise MigrationRecoveryError("backup path is outside the backup directory")
        if record.metadata_path.parent != self.backup_dir:
            raise MigrationRecoveryError("backup metadata path is outside the backup directory")
        self._assert_safe_existing_path(self.database_path.parent, "database directory")
        self._assert_safe_existing_path(self.backup_dir, "backup directory")
        self._assert_safe_existing_path(record.database_path, "backup database")
        self._assert_safe_existing_path(record.metadata_path, "backup metadata")
        self._validate_database_copy(record.database_path, record)

    @staticmethod
    def _validate_database_copy(path: Path, record: MigrationBackupRecord) -> None:
        if path.stat().st_size != record.size_bytes:
            raise MigrationRecoveryError("backup size does not match metadata")
        if _sha256(path) != record.sha256:
            raise MigrationRecoveryError("backup SHA-256 does not match metadata")
        schema, integrity = _inspect_database(path)
        if schema != record.source_schema:
            raise MigrationRecoveryError("backup schema does not match metadata")
        if integrity != "ok":
            raise MigrationRecoveryError("backup integrity_check failed")

    def _write_metadata(self, record: MigrationBackupRecord) -> None:
        temporary_path = record.metadata_path.with_name(f".{record.metadata_path.name}.{uuid.uuid4().hex}.tmp")
        try:
            temporary_path.write_text(
                json.dumps(record.to_metadata(), ensure_ascii=False, indent=2) + "\n",
                encoding="utf-8",
            )
            _fsync_file(temporary_path)
            os.replace(temporary_path, record.metadata_path)
        finally:
            temporary_path.unlink(missing_ok=True)

    def _record_from_metadata(
        self,
        metadata_path: Path,
        metadata: dict[str, Any],
    ) -> MigrationBackupRecord:
        if metadata.get("metadata_version") != BACKUP_METADATA_VERSION:
            raise ValueError("unsupported backup metadata version")
        database_file = metadata.get("database_file")
        if not isinstance(database_file, str) or Path(database_file).name != database_file:
            raise ValueError("invalid backup database filename")
        return MigrationBackupRecord(
            backup_id=str(metadata["backup_id"]),
            database_path=self.backup_dir / database_file,
            metadata_path=metadata_path,
            database_name=str(metadata["database_name"]),
            source_schema=int(metadata["source_schema"]),
            target_schema=int(metadata["target_schema"]),
            created_at=str(metadata["created_at"]),
            size_bytes=int(metadata["size_bytes"]),
            sha256=str(metadata["sha256"]),
            integrity_check=str(metadata["integrity_check"]),
            outcome=str(metadata["outcome"]),
            error_type=str(metadata["error_type"]) if metadata.get("error_type") else None,
        )

    def _prune_old_backups(self) -> None:
        for record in self.list_records()[self.retention :]:
            if record.database_path.parent != self.backup_dir or record.metadata_path.parent != self.backup_dir:
                continue
            record.database_path.unlink(missing_ok=True)
            record.metadata_path.unlink(missing_ok=True)


__all__ = [
    "BACKUP_METADATA_VERSION",
    "DEFAULT_BACKUP_RETENTION",
    "MigrationBackupError",
    "MigrationBackupManager",
    "MigrationBackupRecord",
    "MigrationRecoveryError",
]
