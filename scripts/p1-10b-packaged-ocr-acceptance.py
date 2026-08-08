"""P1-10B-B packaged OCR acceptance for the 350-page synthetic source truth.

This is deliberately separate from ``packaged-ocr-smoke.py``.  The existing
smoke covers small fixtures and intentionally samples the first result page;
this acceptance must consume every occurrence and compare page-level truth.

The fixture is synthetic and does not represent real user documents.  The
acceptance proves the frozen Engine path, not a source-Python development run.
Artifact resolution requires current Git/version/protocol provenance.  A dirty
worktree requires ``--allow-dirty`` and is reported as functional evidence only,
not release-grade evidence.
"""

from __future__ import annotations

import argparse
from collections import Counter
from dataclasses import dataclass, replace
import hashlib
import json
import os
from pathlib import Path
import queue
import re
import shutil
import sqlite3
import subprocess
import sys
import tempfile
import threading
import time
from typing import Any, Iterable

from smoke_output import configure_console, log_status


ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "p1-10b-synthetic" / "real-text-350-page.pdf"
SOURCE_TRUTH = ROOT / "tests" / "fixtures" / "p1-10b-synthetic" / "real-text-350-source-truth.json"
FIXTURE_MANIFEST = ROOT / "tests" / "fixtures" / "p1-10b-synthetic" / "fixture-manifest.json"
DEFAULT_ENGINE_CANDIDATES = (
    ROOT / "apps" / "desktop" / "release" / "win-unpacked" / "resources" / "engine" / "win-x64" / "archivelens-engine.exe",
    ROOT / "dist" / "engine" / "win-x64" / "archivelens-engine.exe",
)
PROTOCOL_VERSION = 4
RESULT_PAGE_SIZE = 200
ENGINE_READY_TIMEOUT_SEC = 120
TASK_COMPLETION_TIMEOUT_SEC = int(os.environ.get("ARCHIVELENS_P1_10B_TIMEOUT_SEC", "1800"))
PROGRESS_LOG_INTERVAL_SEC = 30.0
STRICT_SCOPE_BY_TERM = {
    "档案管理": "simplified",
    "檔案管理": "traditional",
}


class AcceptanceError(RuntimeError):
    """A deterministic acceptance failure with a user-facing summary."""


@dataclass(frozen=True)
class EngineArtifact:
    executable: Path
    app_info: Path
    metadata: dict[str, Any]
    sha256: str
    release_grade: bool = False
    resolution_notes: tuple[str, ...] = ()


def strict_scope_for_term(term: str) -> str:
    try:
        return STRICT_SCOPE_BY_TERM[term]
    except KeyError as exc:
        raise AcceptanceError(f"P1-10B has no strict script scope for term: {term!r}") from exc


def sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as handle:
        for block in iter(lambda: handle.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def current_git_head() -> str:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "rev-parse", "HEAD"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AcceptanceError("unable to resolve the current Git HEAD") from exc
    commit = result.stdout.strip()
    if not re.fullmatch(r"[0-9a-f]{40}", commit):
        raise AcceptanceError("current Git HEAD is not a full commit SHA")
    return commit


def worktree_is_dirty() -> bool:
    try:
        result = subprocess.run(
            ["git", "-C", str(ROOT), "status", "--porcelain", "--untracked-files=all"],
            check=True,
            capture_output=True,
            text=True,
            encoding="utf-8",
        )
    except (OSError, subprocess.CalledProcessError) as exc:
        raise AcceptanceError("unable to inspect the Git worktree") from exc
    return bool(result.stdout.strip())


def expected_engine_version() -> str:
    init_path = ROOT / "engine" / "src" / "archivelens_engine" / "__init__.py"
    try:
        source = init_path.read_text(encoding="utf-8")
    except OSError as exc:
        raise AcceptanceError(f"engine version source is unavailable: {init_path}") from exc
    match = re.search(r'__version__\s*=\s*"([^"]+)"', source)
    if not match:
        raise AcceptanceError("unable to resolve the expected Engine version")
    return match.group(1)


def inspect_engine_candidate(
    candidate: Path,
    *,
    expected_commit: str,
    expected_version: str,
) -> EngineArtifact:
    executable = candidate.expanduser().resolve()
    if not executable.is_file():
        raise AcceptanceError(f"Engine executable is missing: {executable}")
    app_info = executable.parent / "app.info.json"
    if not app_info.is_file():
        raise AcceptanceError(f"Engine app.info.json is missing: {app_info}")
    try:
        metadata = json.loads(app_info.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError) as exc:
        raise AcceptanceError(f"Engine app.info.json is invalid: {app_info}") from exc
    if not isinstance(metadata, dict):
        raise AcceptanceError(f"Engine app.info.json must contain an object: {app_info}")
    if str(metadata.get("git_commit")) != expected_commit:
        raise AcceptanceError(
            f"Engine Git SHA mismatch for {executable}: "
            f"actual={metadata.get('git_commit')!r} expected={expected_commit!r}"
        )
    if str(metadata.get("version")) != expected_version:
        raise AcceptanceError(
            f"Engine version mismatch for {executable}: "
            f"actual={metadata.get('version')!r} expected={expected_version!r}"
        )
    try:
        protocol_version = int(metadata.get("protocol_version"))
    except (TypeError, ValueError) as exc:
        raise AcceptanceError(f"Engine protocol version is invalid: {app_info}") from exc
    if protocol_version != PROTOCOL_VERSION:
        raise AcceptanceError(
            f"Engine protocol mismatch for {executable}: "
            f"actual={protocol_version} expected={PROTOCOL_VERSION}"
        )
    return EngineArtifact(
        executable=executable,
        app_info=app_info,
        metadata=metadata,
        sha256=sha256(executable),
    )


def load_truth(term: str) -> tuple[dict[int, int], int, dict[str, Any]]:
    truth = json.loads(SOURCE_TRUTH.read_text(encoding="utf-8"))
    if int(truth.get("schema_version", 0)) != 1 or int(truth.get("total_pages", 0)) != 350:
        raise AcceptanceError("source truth schema or page count is not the expected P1-10B fixture")
    term_summary = next((item for item in truth.get("search_terms", []) if item.get("term") == term), None)
    if not isinstance(term_summary, dict):
        raise AcceptanceError(f"source truth has no expected term: {term!r}")
    expected_by_page = {
        int(page["page_number"]): int((page.get("terms") or {}).get(term, 0))
        for page in truth.get("pages", [])
    }
    if len(expected_by_page) != 350 or set(expected_by_page) != set(range(1, 351)):
        raise AcceptanceError("source truth does not contain exactly pages 1..350")
    expected_total = sum(expected_by_page.values())
    declared_total = int(term_summary["source_truth_hits"])
    if expected_total != declared_total:
        raise AcceptanceError(
            f"source truth total mismatch for {term!r}: pages={expected_total} declared={declared_total}"
        )
    expected_pages = sum(1 for count in expected_by_page.values() if count > 0)
    if expected_pages != int(term_summary["pages_containing_term"]):
        raise AcceptanceError(
            f"source truth page-count mismatch for {term!r}: pages={expected_pages} "
            f"declared={term_summary['pages_containing_term']}"
        )
    return expected_by_page, expected_total, term_summary


def verify_fixture() -> str:
    if not FIXTURE.is_file() or not SOURCE_TRUTH.is_file() or not FIXTURE_MANIFEST.is_file():
        raise AcceptanceError("P1-10B real-text fixture, source truth, or manifest is missing")
    manifest = json.loads(FIXTURE_MANIFEST.read_text(encoding="utf-8"))
    entry = next((item for item in manifest.get("fixtures", []) if item.get("relative_path") == FIXTURE.name), None)
    if not isinstance(entry, dict):
        raise AcceptanceError("fixture manifest has no real-text-350-page entry")
    actual_sha = sha256(FIXTURE)
    if actual_sha != str(entry.get("sha256")):
        raise AcceptanceError(
            f"fixture SHA-256 mismatch: actual={actual_sha} manifest={entry.get('sha256')}"
        )
    return actual_sha


def _matches(msg: dict[str, Any], *, request_id: str | None, events: set[str] | None) -> bool:
    if request_id is not None and msg.get("request_id") == request_id:
        return True
    return events is not None and msg.get("event") in events


class JsonlEngineClient:
    def __init__(self, executable: Path, workspace_root: Path) -> None:
        env = {**os.environ, "AL_WORKSPACE_ROOT": str(workspace_root)}
        self.process = subprocess.Popen(
            [str(executable), "serve"],
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
            text=True,
            encoding="utf-8",
            env=env,
        )
        self.stdout_queue: queue.Queue[str | None] = queue.Queue()
        self.stderr_tail: list[str] = []
        self.pending: list[dict[str, Any]] = []
        self.request_counter = 0
        self.active_task_id: str | None = None
        self.last_progress_log_at = 0.0
        threading.Thread(target=self._pump_stdout, daemon=True).start()
        threading.Thread(target=self._pump_stderr, daemon=True).start()

    def _pump_stdout(self) -> None:
        assert self.process.stdout is not None
        for line in self.process.stdout:
            self.stdout_queue.put(line)
        self.stdout_queue.put(None)

    def _pump_stderr(self) -> None:
        assert self.process.stderr is not None
        for line in self.process.stderr:
            self.stderr_tail.append(line.rstrip())
            if len(self.stderr_tail) > 50:
                del self.stderr_tail[:-50]

    def send(self, method: str, params: dict[str, Any] | None = None) -> str:
        self.request_counter += 1
        request_id = f"p1-10b-{self.request_counter}"
        message = json.dumps(
            {
                "protocol_version": PROTOCOL_VERSION,
                "request_id": request_id,
                "method": method,
                "params": params or {},
            },
            ensure_ascii=False,
        )
        if self.process.stdin is None:
            raise AcceptanceError("engine stdin is unavailable")
        self.process.stdin.write(message + "\n")
        self.process.stdin.flush()
        return request_id

    def _read_message(self, timeout: float) -> dict[str, Any] | None:
        try:
            line = self.stdout_queue.get(timeout=max(0.1, timeout))
        except queue.Empty:
            if self.process.poll() is not None:
                return None
            return {}
        if line is None:
            return None
        try:
            message = json.loads(line)
        except json.JSONDecodeError:
            return {}
        return message if isinstance(message, dict) else {}

    def _report_progress(self, message: dict[str, Any]) -> None:
        if message.get("event") != "task.progress" or message.get("task_id") != self.active_task_id:
            return
        now = time.monotonic()
        if now - self.last_progress_log_at < PROGRESS_LOG_INTERVAL_SEC:
            return
        payload = message.get("payload") or {}
        log_status(
            "INFO",
            json.dumps(
                {
                    "term_task": self.active_task_id,
                    "page_no": payload.get("page_no"),
                    "processed_pages": payload.get("processed_pages"),
                    "total_pages": payload.get("total_pages"),
                },
                ensure_ascii=True,
            ),
        )
        self.last_progress_log_at = now

    def read_until(
        self,
        *,
        request_id: str | None = None,
        events: Iterable[str] = (),
        timeout: float,
    ) -> dict[str, Any] | None:
        wanted_events = set(events)
        deadline = time.monotonic() + timeout
        while time.monotonic() < deadline:
            for index, pending in enumerate(self.pending):
                if _matches(pending, request_id=request_id, events=wanted_events):
                    return self.pending.pop(index)
            message = self._read_message(min(1.0, deadline - time.monotonic()))
            if message is None:
                return None
            if not message:
                continue
            self._report_progress(message)
            if _matches(message, request_id=request_id, events=wanted_events):
                return message
            if message.get("event") != "task.progress":
                self.pending.append(message)
        return None

    def request(self, method: str, params: dict[str, Any] | None = None, timeout: float = 60) -> dict[str, Any]:
        request_id = self.send(method, params)
        response = self.read_until(request_id=request_id, timeout=timeout)
        if response is None:
            raise AcceptanceError(f"{method} response timeout; stderr={self.stderr_tail[-5:]}")
        if not response.get("ok"):
            raise AcceptanceError(f"{method} failed: {json.dumps(response, ensure_ascii=True)}")
        return response

    def close(self) -> None:
        if self.process.poll() is None and self.process.stdin is not None:
            try:
                self.request("app.shutdown", timeout=60)
            except (AcceptanceError, BrokenPipeError, OSError):
                # The process may already have exited while the acceptance body
                # is unwinding.  The wait below remains the source of truth.
                pass
        try:
            if self.process.stdin is not None:
                self.process.stdin.close()
        except OSError:
            pass
        try:
            self.process.wait(timeout=60)
        except subprocess.TimeoutExpired:
            self.process.kill()
            self.process.wait(timeout=60)


def cleanup_run_context(context: tempfile.TemporaryDirectory[str], *, retries: int = 20) -> None:
    """Remove the run-owned directory, tolerating short Windows handle races."""
    last_error: OSError | None = None
    for attempt in range(retries):
        try:
            context.cleanup()
            return
        except OSError as exc:
            last_error = exc
            if attempt + 1 == retries:
                break
            time.sleep(0.25)
    assert last_error is not None
    raise last_error


def query_all(client: JsonlEngineClient, task_id: str) -> list[dict[str, Any]]:
    items: list[dict[str, Any]] = []
    offset = 0
    total: int | None = None
    while True:
        result = client.request(
            "results.query",
            {"task_id": task_id, "limit": RESULT_PAGE_SIZE, "offset": offset},
            timeout=60,
        )["result"]
        page_items = result.get("items") or []
        if not isinstance(page_items, list):
            raise AcceptanceError("results.query returned a non-list items value")
        if total is None:
            total = int(result.get("total", 0))
        elif int(result.get("total", -1)) != total:
            raise AcceptanceError("results.query total changed during pagination")
        items.extend(item for item in page_items if isinstance(item, dict))
        if not result.get("has_more"):
            break
        if not page_items:
            raise AcceptanceError("results.query reported has_more with an empty page")
        offset += len(page_items)
    if total is None or len(items) != total:
        raise AcceptanceError(f"results pagination incomplete: total={total} items={len(items)}")
    return items


def validate_task_outputs(
    client: JsonlEngineClient,
    task_id: str,
    term: str,
    expected_script_scope: str,
    expected_by_page: dict[int, int],
    expected_total: int,
    source_sha_before: str,
    source_copy: Path,
    workspace_root: Path,
) -> dict[str, Any]:
    task = client.request("tasks.get", {"task_id": task_id})["result"]
    if task.get("status") != "completed":
        raise AcceptanceError(f"task status is not completed: {task.get('status')!r}")
    if task.get("search_script_scope") != expected_script_scope:
        raise AcceptanceError(
            "task search_script_scope mismatch: "
            f"actual={task.get('search_script_scope')!r}, expected={expected_script_scope!r}"
        )
    if int(task.get("processed_pages", 0) or 0) != 350:
        raise AcceptanceError(f"processed_pages={task.get('processed_pages')!r}, expected 350")
    if int(task.get("failure_count", 0) or 0) != 0:
        raise AcceptanceError(f"failure_count={task.get('failure_count')!r}, expected 0")

    items = query_all(client, task_id)
    actual_by_page = Counter(int(item.get("page_number", 0) or 0) for item in items)
    actual_by_page = {page: count for page, count in actual_by_page.items() if page > 0}
    if actual_by_page != {page: count for page, count in expected_by_page.items() if count > 0}:
        expected_nonzero = {page: count for page, count in expected_by_page.items() if count > 0}
        missing = sorted(set(expected_nonzero) - set(actual_by_page))
        unexpected = sorted(set(actual_by_page) - set(expected_nonzero))
        mismatched = {
            str(page): {"expected": expected_nonzero.get(page, 0), "actual": actual_by_page.get(page, 0)}
            for page in sorted(set(expected_nonzero) | set(actual_by_page))
            if expected_nonzero.get(page, 0) != actual_by_page.get(page, 0)
        }
        raise AcceptanceError(
            "page-level OCR truth mismatch: "
            + json.dumps({"missing": missing[:20], "unexpected": unexpected[:20], "mismatched": dict(list(mismatched.items())[:20])}, ensure_ascii=True)
        )
    if len(items) != expected_total:
        raise AcceptanceError(f"results total={len(items)}, expected={expected_total}")

    for item in items:
        matched_text = str(item.get("matched_text") or item.get("matched_character") or "")
        if matched_text != term:
            raise AcceptanceError(f"unexpected matched_text={matched_text!r}, expected={term!r}")
        context = str(item.get("context_full") or item.get("layout_context_text") or "")
        if term not in context:
            raise AcceptanceError("an occurrence context does not contain its matched term")
        coordinates = [item.get(key) for key in ("normalized_x0", "normalized_y0", "normalized_x1", "normalized_y1")]
        if any(value is None or not 0 <= float(value) <= 1 for value in coordinates):
            raise AcceptanceError(f"invalid normalized bbox: {coordinates!r}")
        if float(coordinates[2]) <= float(coordinates[0]) or float(coordinates[3]) <= float(coordinates[1]):
            raise AcceptanceError(f"empty normalized bbox: {coordinates!r}")
        crop_relpath = str(item.get("crop_image_relpath") or "")
        crop_path = Path(str(task.get("workspace_dir") or "")) / crop_relpath
        if not crop_relpath or not crop_path.is_file():
            raise AcceptanceError(f"crop image missing: {crop_path}")

    exported_json = client.request("export.json", {"task_id": task_id}, timeout=180)["result"]
    json_path = Path(str(exported_json.get("path") or ""))
    if not json_path.is_file():
        raise AcceptanceError(f"export.json missing: {json_path}")
    exported = json.loads(json_path.read_text(encoding="utf-8"))
    exported_occurrences = exported.get("occurrences") or []
    if exported.get("task", {}).get("search_text") != term or len(exported_occurrences) != expected_total:
        raise AcceptanceError(
            "export.json mismatch: "
            + json.dumps(
                {
                    "search_text": exported.get("task", {}).get("search_text"),
                    "occurrences": len(exported_occurrences),
                    "expected": expected_total,
                },
                ensure_ascii=True,
            )
        )

    exported_html = client.request("export.html", {"task_id": task_id}, timeout=300)["result"]
    html_path = Path(str(exported_html.get("path") or ""))
    if not html_path.is_file():
        raise AcceptanceError(f"export.html missing: {html_path}")
    html = html_path.read_text(encoding="utf-8")
    if term not in html or "http://" in html or "https://" in html:
        raise AcceptanceError("export.html is missing the term or contains a remote URL")

    db_path = workspace_root / "archivelens.db"
    if not db_path.is_file():
        raise AcceptanceError(f"SQLite database missing: {db_path}")
    connection = sqlite3.connect(db_path)
    try:
        integrity = str(connection.execute("PRAGMA integrity_check").fetchone()[0])
        occurrence_count = int(
            connection.execute("SELECT COUNT(*) FROM occurrences WHERE task_id=?", (task_id,)).fetchone()[0]
        )
    finally:
        connection.close()
    if integrity != "ok" or occurrence_count != expected_total:
        raise AcceptanceError(
            f"database check mismatch: integrity={integrity!r}, occurrences={occurrence_count}, expected={expected_total}"
        )

    source_sha_after = sha256(source_copy)
    original_sha_after = sha256(FIXTURE)
    if source_sha_after != source_sha_before or original_sha_after != source_sha_before:
        raise AcceptanceError("copied source PDF SHA-256 changed during OCR")
    return {
        "task_id": task_id,
        "term": term,
        "expected_hits": expected_total,
        "actual_hits": len(items),
        "pages_with_hits": len(actual_by_page),
        "export_json_occurrences": len(exported_occurrences),
        "database_integrity": integrity,
        "source_sha256": source_sha_after,
    }


def resolve_engine(explicit: str | None, *, allow_dirty: bool = False) -> EngineArtifact:
    dirty = worktree_is_dirty()
    if dirty and not allow_dirty:
        raise AcceptanceError(
            "Git worktree is dirty; pass --allow-dirty for functional acceptance "
            "(the result will not be release-grade)"
        )

    expected_commit = current_git_head()
    expected_version = expected_engine_version()
    candidates = (Path(explicit),) if explicit else DEFAULT_ENGINE_CANDIDATES
    valid: list[EngineArtifact] = []
    rejected: list[str] = []
    for candidate in candidates:
        if not candidate.is_file():
            continue
        try:
            valid.append(
                inspect_engine_candidate(
                    candidate,
                    expected_commit=expected_commit,
                    expected_version=expected_version,
                )
            )
        except AcceptanceError as exc:
            rejected.append(f"{candidate}: {exc}")

    if len(valid) > 1:
        paths = ", ".join(str(item.executable) for item in valid)
        raise AcceptanceError(
            f"multiple packaged Engine artifacts match current provenance; "
            f"pass --engine-exe to select one explicitly: {paths}"
        )
    if not valid:
        details = f"; rejected={rejected}" if rejected else ""
        raise AcceptanceError(
            "no packaged Engine executable matched current Git/version/protocol provenance; "
            "build the Engine/Desktop package first" + details
        )

    return replace(
        valid[0],
        release_grade=not dirty,
        resolution_notes=tuple(rejected),
    )


def run_acceptance(artifact: EngineArtifact, terms: list[str]) -> dict[str, Any]:
    engine = artifact.executable
    source_sha = verify_fixture()
    expectations = {term: load_truth(term) for term in terms}
    run_context = tempfile.TemporaryDirectory(prefix="archivelens-p1-10b-packaged-")
    run_root = Path(run_context.name)
    (run_root / ".archivelens-test-owned").write_text("p1-10b-packaged-ocr\n", encoding="utf-8")
    source_dir = run_root / "source"
    source_dir.mkdir()
    source_copy = source_dir / FIXTURE.name
    shutil.copy2(FIXTURE, source_copy)
    client = JsonlEngineClient(engine, run_root / "workspace")
    started_at = time.perf_counter()
    summaries: list[dict[str, Any]] = []
    try:
        if client.read_until(events={"engine.ready"}, timeout=ENGINE_READY_TIMEOUT_SEC) is None:
            raise AcceptanceError(f"engine.ready timeout; stderr={client.stderr_tail[-5:]}")
        log_status(
            "INFO",
            json.dumps(
                {
                    "engine_ready": True,
                    "executable": str(engine),
                    "engine_sha256": artifact.sha256,
                    "source_commit": artifact.metadata.get("git_commit"),
                    "release_grade": artifact.release_grade,
                },
                ensure_ascii=True,
                sort_keys=True,
            ),
        )
        for term in terms:
            expected_by_page, expected_total, term_summary = expectations[term]
            script_scope = strict_scope_for_term(term)
            created = client.request(
                "tasks.create",
                {
                    "source_type": "files",
                    "source_files": [str(source_copy)],
                    "search_text": term,
                    "search_script_scope": script_scope,
                    "name": f"P1-10B packaged OCR {term}",
                },
                timeout=120,
            )["result"]
            task_id = str(created["task_id"])
            client.active_task_id = task_id
            log_status(
                "INFO",
                json.dumps(
                    {
                        "task_id": task_id,
                        "term": term,
                        "search_script_scope": script_scope,
                        "expected_hits": expected_total,
                        "expected_pages": term_summary["pages_containing_term"],
                    },
                    ensure_ascii=True,
                ),
            )
            task_started_at = time.perf_counter()
            client.request("tasks.start", {"task_id": task_id}, timeout=60)
            terminal = client.read_until(
                events={"task.completed", "task.failed"},
                timeout=TASK_COMPLETION_TIMEOUT_SEC,
            )
            if terminal is None:
                raise AcceptanceError(f"task terminal event timeout for {term!r}; stderr={client.stderr_tail[-5:]}")
            if terminal.get("event") != "task.completed":
                raise AcceptanceError(f"task failed for {term!r}: {json.dumps(terminal, ensure_ascii=True)}")
            elapsed = time.perf_counter() - task_started_at
            summary = validate_task_outputs(
                client,
                task_id,
                term,
                script_scope,
                expected_by_page,
                expected_total,
                source_sha,
                source_copy,
                run_root / "workspace",
            )
            summary.update({"search_script_scope": script_scope, "ocr_elapsed_sec": round(elapsed, 3), "ocr_ms_per_page": round(elapsed * 1000 / 350, 2)})
            summaries.append(summary)
            log_status("PASS", json.dumps(summary, ensure_ascii=True, sort_keys=True))
        return {
            "engine": str(engine),
            "engine_app_info": str(artifact.app_info),
            "engine_sha256": artifact.sha256,
            "engine_metadata": {
                "version": artifact.metadata.get("version"),
                "git_commit": artifact.metadata.get("git_commit"),
                "protocol_version": artifact.metadata.get("protocol_version"),
                "build_time": artifact.metadata.get("build_time"),
            },
            "release_grade": artifact.release_grade,
            "artifact_resolution_notes": list(artifact.resolution_notes),
            "fixture": str(FIXTURE),
            "fixture_sha256": source_sha,
            "terms": summaries,
            "total_elapsed_sec": round(time.perf_counter() - started_at, 3),
            "cpu_memory_measurement": "not measured by this acceptance script",
        }
    finally:
        client.close()
        cleanup_run_context(run_context)


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--engine-exe", help="override the packaged archivelens-engine.exe path")
    parser.add_argument(
        "--allow-dirty",
        action="store_true",
        help="allow functional acceptance from a dirty worktree; result is not release-grade",
    )
    parser.add_argument(
        "--term",
        action="append",
        choices=["档案管理", "檔案管理"],
        help="run only one term; repeat to select multiple terms (default: both)",
    )
    args = parser.parse_args()
    configure_console()
    terms = args.term or ["档案管理", "檔案管理"]
    try:
        result = run_acceptance(
            resolve_engine(args.engine_exe, allow_dirty=args.allow_dirty),
            terms,
        )
    except (AcceptanceError, OSError, ValueError, json.JSONDecodeError) as exc:
        log_status("FAIL", str(exc))
        return 1
    log_status("PASS", json.dumps(result, ensure_ascii=True, sort_keys=True))
    return 0


if __name__ == "__main__":
    sys.exit(main())
