"""全局任务存储（SQLite）。"""

from .store import SCHEMA_VERSION, SCHEMA_SQL, TaskStore, new_id, now_iso
from .migration_backup import (
    MigrationBackupError,
    MigrationBackupManager,
    MigrationBackupRecord,
    MigrationRecoveryError,
)

__all__ = [
    "TaskStore",
    "SCHEMA_VERSION",
    "SCHEMA_SQL",
    "MigrationBackupError",
    "MigrationBackupManager",
    "MigrationBackupRecord",
    "MigrationRecoveryError",
    "new_id",
    "now_iso",
]
