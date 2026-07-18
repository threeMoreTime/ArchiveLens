from __future__ import annotations

from dataclasses import replace
import hashlib
import json
from pathlib import Path
import sqlite3
import tempfile
import unittest
from unittest import mock

from archivelens_engine.db.migration_backup import (
    MigrationBackupError,
    MigrationBackupManager,
    MigrationRecoveryError,
)
from archivelens_engine.db.store import SCHEMA_VERSION, TaskStore


class MigrationBackupTests(unittest.TestCase):
    def setUp(self) -> None:
        self.temporary_directory = tempfile.TemporaryDirectory()
        self.root = Path(self.temporary_directory.name)
        self.database_path = self.root / "archivelens.db"

    def tearDown(self) -> None:
        self.temporary_directory.cleanup()

    def _mark_previous_schema(self, marker: str = "keep") -> None:
        store = TaskStore(self.database_path)
        store.conn.execute("CREATE TABLE IF NOT EXISTS migration_test_marker(value TEXT NOT NULL)")
        store.conn.execute("DELETE FROM migration_test_marker")
        store.conn.execute("INSERT INTO migration_test_marker(value) VALUES (?)", (marker,))
        store.conn.execute(
            "INSERT INTO schema_meta(key, value) VALUES ('schema_version', ?) "
            "ON CONFLICT(key) DO UPDATE SET value=excluded.value",
            (str(SCHEMA_VERSION - 1),),
        )
        store.conn.execute(f"PRAGMA user_version = {SCHEMA_VERSION - 1}")
        store.conn.commit()
        store.close()

    @staticmethod
    def _sha256(path: Path) -> str:
        return hashlib.sha256(path.read_bytes()).hexdigest()

    def test_successful_migration_keeps_verified_backup_and_metadata(self) -> None:
        self._mark_previous_schema("success")

        store = TaskStore(self.database_path)
        record = store.last_migration_backup
        self.assertIsNotNone(record)
        assert record is not None
        self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
        self.assertEqual(
            store.conn.execute("SELECT value FROM migration_test_marker").fetchone()[0],
            "success",
        )
        store.close()

        self.assertEqual(record.outcome, "migration_completed")
        self.assertTrue(record.database_path.is_file())
        self.assertTrue(record.metadata_path.is_file())
        self.assertEqual(record.sha256, self._sha256(record.database_path))
        backup = sqlite3.connect(record.database_path)
        try:
            self.assertEqual(backup.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION - 1)
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(
                backup.execute("SELECT value FROM migration_test_marker").fetchone()[0],
                "success",
            )
        finally:
            backup.close()
        metadata_text = record.metadata_path.read_text(encoding="utf-8")
        metadata = json.loads(metadata_text)
        self.assertEqual(metadata["database_name"], self.database_path.name)
        self.assertEqual(metadata["source_schema"], SCHEMA_VERSION - 1)
        self.assertEqual(metadata["target_schema"], SCHEMA_VERSION)
        self.assertEqual(metadata["outcome"], "migration_completed")
        self.assertNotIn(str(self.root), metadata_text)

    def test_migration_failure_restores_verified_backup_before_raising(self) -> None:
        self._mark_previous_schema("restore")

        def fail_after_write(store: TaskStore, _current: int) -> None:
            store.conn.execute("CREATE TABLE migration_partial(value TEXT)")
            store.conn.execute("UPDATE migration_test_marker SET value='changed'")
            raise RuntimeError("injected migration failure")

        with mock.patch.object(TaskStore, "_migrate_schema", new=fail_after_write):
            with self.assertRaisesRegex(RuntimeError, "injected migration failure"):
                TaskStore(self.database_path)

        records = MigrationBackupManager(self.database_path).list_records()
        self.assertEqual(len(records), 1)
        record = records[0]
        self.assertEqual(record.outcome, "migration_failed_restored")
        self.assertEqual(record.error_type, "RuntimeError")
        self.assertEqual(self._sha256(self.database_path), record.sha256)
        connection = sqlite3.connect(self.database_path)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION - 1)
            self.assertEqual(connection.execute("PRAGMA integrity_check").fetchone()[0], "ok")
            self.assertEqual(
                connection.execute("SELECT value FROM migration_test_marker").fetchone()[0],
                "restore",
            )
            self.assertIsNone(
                connection.execute(
                    "SELECT name FROM sqlite_master WHERE name='migration_partial'"
                ).fetchone()
            )
        finally:
            connection.close()
        self.assertFalse(Path(f"{self.database_path}-wal").exists())
        self.assertFalse(Path(f"{self.database_path}-shm").exists())

    def test_backup_creation_failure_prevents_migration(self) -> None:
        self._mark_previous_schema("backup-failed")
        with mock.patch.object(
            MigrationBackupManager,
            "create",
            side_effect=MigrationBackupError("disk full"),
        ), mock.patch.object(TaskStore, "_migrate_schema") as migrate:
            with self.assertRaisesRegex(MigrationBackupError, "disk full"):
                TaskStore(self.database_path)
        migrate.assert_not_called()
        connection = sqlite3.connect(self.database_path)
        try:
            self.assertEqual(connection.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION - 1)
            self.assertEqual(
                connection.execute("SELECT value FROM migration_test_marker").fetchone()[0],
                "backup-failed",
            )
        finally:
            connection.close()

    def test_invalid_retention_and_schema_range_are_rejected(self) -> None:
        with self.assertRaisesRegex(ValueError, "retention"):
            MigrationBackupManager(self.database_path, retention=0)

        connection = sqlite3.connect(":memory:")
        try:
            manager = MigrationBackupManager(self.database_path)
            with self.assertRaisesRegex(MigrationBackupError, "invalid migration backup schema range"):
                manager.create(connection, source_schema=0, target_schema=SCHEMA_VERSION)
            with self.assertRaisesRegex(MigrationBackupError, "invalid migration backup schema range"):
                manager.create(
                    connection,
                    source_schema=SCHEMA_VERSION,
                    target_schema=SCHEMA_VERSION,
                )
        finally:
            connection.close()

    def test_backup_rejects_wrong_schema_and_failed_integrity(self) -> None:
        self._mark_previous_schema("validation")
        connection = sqlite3.connect(self.database_path)
        try:
            manager = MigrationBackupManager(self.database_path)
            with mock.patch(
                "archivelens_engine.db.migration_backup._inspect_database",
                return_value=(SCHEMA_VERSION, "ok"),
            ):
                with self.assertRaisesRegex(MigrationBackupError, "schema mismatch"):
                    manager.create(
                        connection,
                        source_schema=SCHEMA_VERSION - 1,
                        target_schema=SCHEMA_VERSION,
                    )
            with mock.patch(
                "archivelens_engine.db.migration_backup._inspect_database",
                return_value=(SCHEMA_VERSION - 1, "corrupt"),
            ):
                with self.assertRaisesRegex(MigrationBackupError, "integrity_check failed"):
                    manager.create(
                        connection,
                        source_schema=SCHEMA_VERSION - 1,
                        target_schema=SCHEMA_VERSION,
                    )
        finally:
            connection.close()
        self.assertEqual(list((self.root / "backups").glob("*.sqlite3")), [])
        self.assertEqual(list((self.root / "backups").glob("*.tmp")), [])

    def test_unexpected_backup_and_restore_io_errors_are_structured(self) -> None:
        source = mock.Mock()
        source.backup.side_effect = OSError("write failed")
        manager = MigrationBackupManager(self.database_path)
        with self.assertRaisesRegex(MigrationBackupError, "unable to create migration backup: OSError"):
            manager.create(
                source,
                source_schema=SCHEMA_VERSION - 1,
                target_schema=SCHEMA_VERSION,
            )

        self._mark_previous_schema("restore-io")
        store = TaskStore(self.database_path)
        record = store.last_migration_backup
        store.close()
        assert record is not None
        with mock.patch(
            "archivelens_engine.db.migration_backup.shutil.copyfile",
            side_effect=OSError("copy failed"),
        ):
            with self.assertRaisesRegex(MigrationRecoveryError, "unable to restore migration backup: OSError"):
                manager.restore(record)

    def test_restore_failure_fails_closed_and_keeps_backup(self) -> None:
        self._mark_previous_schema("restore-failed")
        with mock.patch.object(
            TaskStore,
            "_migrate_schema",
            side_effect=RuntimeError("migration failed"),
        ), mock.patch.object(
            MigrationBackupManager,
            "restore",
            side_effect=MigrationRecoveryError("restore unavailable"),
        ):
            with self.assertRaisesRegex(MigrationRecoveryError, "could not be verified"):
                TaskStore(self.database_path)

        records = MigrationBackupManager(self.database_path).list_records()
        self.assertEqual(len(records), 1)
        self.assertEqual(records[0].outcome, "migration_failed_restore_failed")
        self.assertTrue(records[0].database_path.is_file())

    def test_tampered_backup_is_refused(self) -> None:
        self._mark_previous_schema("tamper")
        store = TaskStore(self.database_path)
        record = store.last_migration_backup
        store.close()
        assert record is not None
        with record.database_path.open("ab") as handle:
            handle.write(b"tamper")
        with self.assertRaisesRegex(MigrationRecoveryError, "size does not match"):
            MigrationBackupManager(self.database_path).restore(record)

    def test_record_identity_hash_schema_and_integrity_mismatches_are_refused(self) -> None:
        self._mark_previous_schema("identity")
        store = TaskStore(self.database_path)
        record = store.last_migration_backup
        store.close()
        assert record is not None
        manager = MigrationBackupManager(self.database_path)

        outside = self.root / "outside.sqlite3"
        outside.write_bytes(record.database_path.read_bytes())
        outside_metadata = self.root / "outside.json"
        outside_metadata.write_text("{}", encoding="utf-8")
        mismatches = [
            (replace(record, database_name="other.db"), "different database"),
            (replace(record, database_path=outside), "outside the backup directory"),
            (replace(record, metadata_path=outside_metadata), "metadata path is outside"),
            (replace(record, sha256="0" * 64), "SHA-256"),
            (replace(record, source_schema=record.source_schema + 1), "schema does not match"),
        ]
        for changed, expected in mismatches:
            with self.subTest(expected=expected):
                with self.assertRaisesRegex(MigrationRecoveryError, expected):
                    manager.restore(changed)

        with mock.patch(
            "archivelens_engine.db.migration_backup._inspect_database",
            return_value=(record.source_schema, "corrupt"),
        ):
            with self.assertRaisesRegex(MigrationRecoveryError, "integrity_check failed"):
                manager.restore(record)

    def test_registry_ignores_malformed_metadata_and_reparse_points_fail_closed(self) -> None:
        manager = MigrationBackupManager(self.database_path)
        self.assertEqual(manager.list_records(), [])
        manager.backup_dir.mkdir()
        malformed = manager.backup_dir / "archivelens-schema-v1-invalid.json"
        malformed.write_text("{not-json", encoding="utf-8")
        self.assertEqual(manager.list_records(), [])

        with self.assertRaisesRegex(ValueError, "unsupported backup metadata version"):
            manager._record_from_metadata(malformed, {"metadata_version": 999})
        with self.assertRaisesRegex(ValueError, "invalid backup database filename"):
            manager._record_from_metadata(
                malformed,
                {"metadata_version": 1, "database_file": "../outside.sqlite3"},
            )
        with mock.patch(
            "archivelens_engine.db.migration_backup._is_reparse_point",
            return_value=True,
        ):
            with self.assertRaisesRegex(MigrationBackupError, "reparse point"):
                manager._assert_safe_existing_path(manager.backup_dir, "backup directory")

    def test_database_directory_reparse_point_is_refused_before_backup(self) -> None:
        self._mark_previous_schema("linked-parent")
        original = MigrationBackupManager._assert_safe_existing_path

        def reject_database_directory(path: Path, label: str) -> None:
            if label == "database directory":
                raise MigrationBackupError("database directory must not be a symlink or reparse point")
            original(path, label)

        with mock.patch.object(
            MigrationBackupManager,
            "_assert_safe_existing_path",
            side_effect=reject_database_directory,
        ), mock.patch.object(TaskStore, "_migrate_schema") as migrate:
            with self.assertRaisesRegex(MigrationBackupError, "database directory"):
                TaskStore(self.database_path)
        migrate.assert_not_called()

    def test_online_backup_contains_committed_wal_content(self) -> None:
        self._mark_previous_schema("before-wal")
        connection = sqlite3.connect(self.database_path)
        try:
            connection.execute("PRAGMA journal_mode = WAL")
            connection.execute("UPDATE migration_test_marker SET value='committed-wal'")
            connection.commit()
            self.assertTrue(Path(f"{self.database_path}-wal").exists())

            manager = MigrationBackupManager(self.database_path)
            record = manager.create(
                connection,
                source_schema=SCHEMA_VERSION - 1,
                target_schema=SCHEMA_VERSION,
            )
        finally:
            connection.close()

        backup = sqlite3.connect(record.database_path)
        try:
            self.assertEqual(
                backup.execute("SELECT value FROM migration_test_marker").fetchone()[0],
                "committed-wal",
            )
            self.assertEqual(backup.execute("PRAGMA integrity_check").fetchone()[0], "ok")
        finally:
            backup.close()

    def test_current_new_and_future_databases_do_not_create_migration_backup(self) -> None:
        current = TaskStore(self.database_path)
        self.assertIsNone(current.last_migration_backup)
        current.close()
        reopened = TaskStore(self.database_path)
        self.assertIsNone(reopened.last_migration_backup)
        reopened.close()
        self.assertFalse((self.root / "backups").exists())

        future_path = self.root / "future.db"
        connection = sqlite3.connect(future_path)
        connection.execute("CREATE TABLE marker(value TEXT)")
        connection.execute("INSERT INTO marker VALUES ('future')")
        connection.execute(f"PRAGMA user_version = {SCHEMA_VERSION + 1}")
        connection.commit()
        connection.close()
        with self.assertRaisesRegex(RuntimeError, "unsupported schema version"):
            TaskStore(future_path)
        self.assertFalse((self.root / "backups").exists())

    def test_retention_keeps_latest_three_complete_backup_pairs(self) -> None:
        for index in range(4):
            self._mark_previous_schema(f"round-{index}")
            TaskStore(self.database_path).close()

        manager = MigrationBackupManager(self.database_path)
        records = manager.list_records()
        self.assertEqual(len(records), 3)
        self.assertEqual(len(list(manager.backup_dir.glob("*.sqlite3"))), 3)
        self.assertEqual(len(list(manager.backup_dir.glob("*.json"))), 3)
        self.assertTrue(all(record.database_path.is_file() for record in records))
        self.assertTrue(all(record.metadata_path.is_file() for record in records))

    def test_outcome_metadata_failure_does_not_invalidate_committed_migration(self) -> None:
        self._mark_previous_schema("metadata")
        with mock.patch.object(
            MigrationBackupManager,
            "mark_outcome",
            side_effect=OSError("metadata unavailable"),
        ):
            store = TaskStore(self.database_path)
        try:
            self.assertEqual(store.conn.execute("PRAGMA user_version").fetchone()[0], SCHEMA_VERSION)
            self.assertIsNotNone(store.last_migration_backup)
            assert store.last_migration_backup is not None
            self.assertEqual(store.last_migration_backup.outcome, "created")
        finally:
            store.close()


if __name__ == "__main__":
    unittest.main()
