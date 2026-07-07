from __future__ import annotations

import argparse
import base64
import hashlib
import json
import os
import sqlite3
import subprocess
import textwrap
import time
import uuid
from collections import Counter, defaultdict
from dataclasses import dataclass
from datetime import datetime
from pathlib import Path
from typing import Any
from urllib.parse import quote

import pytesseract
from PIL import Image
from rapidocr_onnxruntime import RapidOCR

from .config import DEFAULT_CONFIG, EngineConfig, TARGET_CHARS
from .runtime.task_control import TaskControl
from .documents import DocumentBackendRegistry
from .ocr_core import (
    assign_occurrence_indexes,
    build_context_fields,
    classify_verification_status,
    dedupe_occurrences,
    normalize_bbox,
    split_line_bbox,
)


STATUS_LABELS = {
    "confirmed": "已确认",
    "needs_review": "待判断",
    "rejected": "排除",
}
# 原生工具路径与默认参数的单一真相源位于 .config.EngineConfig。
# 下列别名仅为兼容本模块内部既有引用而保留；新代码请直接使用 EngineConfig 实例。
TESSERACT_CMD = str(DEFAULT_CONFIG.tesseract_cmd)
DJVU_BIN_DIR = DEFAULT_CONFIG.djvu_bin_dir
DEFAULT_RENDER_DPI = DEFAULT_CONFIG.render_dpi
SCRIPT_DIR = Path(__file__).resolve().parent
TESSDATA_DIR = DEFAULT_CONFIG.tessdata_dir or (SCRIPT_DIR / "tessdata")


@dataclass
class DocumentRecord:
    document_id: str
    file_path: Path
    relative_path: str
    file_type: str
    file_size_bytes: int
    file_hash_sha256: str
    modified_time: float
    page_count: int


class ReportPipeline:
    def __init__(
        self,
        root_dir: Path,
        output_html: Path,
        workspace_dir: Path,
        page_limit: int | None = None,
        document_limit: int | None = None,
        include_paths: set[str] | None = None,
        start_page_index: int | None = None,
        end_page_index_exclusive: int | None = None,
        config: EngineConfig | None = None,
        task_control: TaskControl | None = None,
        ocr_engine: Any = None,
    ) -> None:
        # Phase 1 预留实例配置入口；Phase 3 起 Sidecar 将按任务注入打包内路径。
        self.config = config or DEFAULT_CONFIG
        self.task_control = task_control
        self.backend_registry = DocumentBackendRegistry(self.config)
        self.root_dir = root_dir
        self.output_html = output_html
        self.workspace_dir = workspace_dir
        self.page_limit = page_limit
        self.document_limit = document_limit
        self.include_paths = include_paths or set()
        self.start_page_index = start_page_index
        self.end_page_index_exclusive = end_page_index_exclusive
        if TESSDATA_DIR.exists():
            os.environ["TESSDATA_PREFIX"] = str(TESSDATA_DIR)
        self.run_dir = workspace_dir / "run"
        self.pages_dir = self.run_dir / "pages"
        self.crops_dir = self.run_dir / "crops"
        self.db_path = self.run_dir / "report.db"
        self.json_path = self.run_dir / "report.json"
        self.started_at = datetime.now()
        self.ocr_engine = ocr_engine or RapidOCR()
        pytesseract.pytesseract.tesseract_cmd = TESSERACT_CMD
        self._ensure_dirs()
        self.conn = sqlite3.connect(self.db_path)
        self.conn.row_factory = sqlite3.Row
        self._init_db()

    def _ensure_dirs(self) -> None:
        self.pages_dir.mkdir(parents=True, exist_ok=True)
        self.crops_dir.mkdir(parents=True, exist_ok=True)

    def _init_db(self) -> None:
        self.conn.executescript(
            """
            CREATE TABLE IF NOT EXISTS documents (
                document_id TEXT PRIMARY KEY,
                file_path TEXT UNIQUE NOT NULL,
                file_type TEXT NOT NULL,
                file_hash_sha256 TEXT NOT NULL,
                file_size_bytes INTEGER NOT NULL,
                modified_time REAL NOT NULL,
                page_count INTEGER NOT NULL,
                status TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS pages (
                page_image_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                page_number INTEGER NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS occurrences (
                occurrence_id TEXT PRIMARY KEY,
                document_id TEXT NOT NULL,
                page_image_id TEXT NOT NULL,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS failures (
                failure_id TEXT PRIMARY KEY,
                document_id TEXT,
                payload_json TEXT NOT NULL
            );
            CREATE TABLE IF NOT EXISTS schema_meta (
                key TEXT PRIMARY KEY,
                value TEXT NOT NULL
            );
            PRAGMA user_version = 1;
            """
        )
        # schema 版本双写：PRAGMA user_version + 显式 schema_meta，便于迁移与回滚备份。
        self.conn.execute(
            "INSERT OR IGNORE INTO schema_meta(key, value) VALUES (?, ?)",
            ("schema_version", "1"),
        )
        self.conn.commit()

    def close(self) -> None:
        self.conn.close()

    def run(self) -> dict[str, Any]:
        documents = self._scan_documents()
        if self.document_limit is not None:
            documents = documents[: self.document_limit]
        print(f"[run] documents={len(documents)} root={self.root_dir}", flush=True)
        for document in documents:
            print(
                f"[document:start] type={document.file_type} path={document.relative_path} pages={document.page_count}",
                flush=True,
            )
            self._process_document(document)
            print(f"[document:done] path={document.relative_path}", flush=True)
        report_data = self._collect_report_data()
        embed_assets(report_data)
        write_report_outputs(
            report=report_data,
            output_html=self.output_html,
            json_path=self.json_path,
            build_html=self._build_html,
            workspace_dir=self.workspace_dir,
        )
        return report_data

    def _scan_documents(self) -> list[DocumentRecord]:
        results: list[DocumentRecord] = []
        for path in sorted(self.root_dir.rglob("*")):
            if not path.is_file():
                continue
            if self.workspace_dir in path.parents:
                continue
            if path == self.output_html:
                continue
            suffix = path.suffix.lower()
            if suffix not in {".pdf", ".djvu", ".djv"}:
                continue
            if self.include_paths and str(path) not in self.include_paths:
                continue
            results.append(self._make_document_record(path))
        return results

    def _make_document_record(self, path: Path) -> DocumentRecord:
        page_count = self._page_count(path)
        return DocumentRecord(
            document_id=str(uuid.uuid4()),
            file_path=path,
            relative_path=str(path.relative_to(self.root_dir)),
            file_type=path.suffix.lower().lstrip(".").upper(),
            file_size_bytes=path.stat().st_size,
            file_hash_sha256=self._sha256(path),
            modified_time=path.stat().st_mtime,
            page_count=page_count,
        )

    def _checkpoint_path(self, document: DocumentRecord) -> Path:
        return self.run_dir / f"checkpoint-{document.file_hash_sha256[:16]}.json"

    def _load_checkpoint(self, document: DocumentRecord) -> dict[str, Any] | None:
        path = self._checkpoint_path(document)
        if not path.exists():
            return None
        payload = json.loads(path.read_text(encoding="utf-8"))
        if payload.get("file_hash_sha256") != document.file_hash_sha256:
            return None
        return payload

    def _save_checkpoint(
        self,
        document: DocumentRecord,
        next_page_index: int,
        pages: list[dict[str, Any]],
        occurrences: list[dict[str, Any]],
        failures: list[dict[str, Any]],
    ) -> None:
        payload = {
            "document_id": document.document_id,
            "file_path": str(document.file_path),
            "relative_path": document.relative_path,
            "file_hash_sha256": document.file_hash_sha256,
            "document_page_count": document.page_count,
            "next_page_index": next_page_index,
            "pages": pages,
            "occurrences": occurrences,
            "failures": failures,
        }
        self._checkpoint_path(document).write_text(
            json.dumps(payload, ensure_ascii=False, separators=(",", ":")),
            encoding="utf-8",
        )

    def _clear_checkpoint(self, document: DocumentRecord) -> None:
        self._checkpoint_path(document).unlink(missing_ok=True)

    def _page_count(self, path: Path) -> int:
        return self.backend_registry.page_count(path)

    def _sha256(self, path: Path) -> str:
        digest = hashlib.sha256()
        with path.open("rb") as handle:
            for chunk in iter(lambda: handle.read(1024 * 1024), b""):
                digest.update(chunk)
        return digest.hexdigest()

    def _page_range_for_document(
        self,
        document: DocumentRecord,
        checkpoint: dict[str, Any] | None = None,
    ) -> tuple[int, int]:
        checkpoint_payload = checkpoint if checkpoint is not None else self._load_checkpoint(document)
        checkpoint_start = checkpoint_payload.get("next_page_index", 0) if checkpoint_payload else 0
        start_page_index = max(checkpoint_start, self.start_page_index or 0)
        page_stop = document.page_count if self.page_limit is None else min(document.page_count, self.page_limit)
        if self.end_page_index_exclusive is not None:
            page_stop = min(page_stop, self.end_page_index_exclusive)
        return start_page_index, page_stop

    def _process_document(self, document: DocumentRecord) -> None:
        cached = self.conn.execute(
            "SELECT * FROM documents WHERE file_path = ?",
            (str(document.file_path),),
        ).fetchone()
        if (
            cached
            and cached["file_hash_sha256"] == document.file_hash_sha256
            and cached["status"] == "completed"
        ):
            return
        self._delete_document_rows(str(document.file_path))
        checkpoint = self._load_checkpoint(document)
        occurrences: list[dict[str, Any]] = checkpoint.get("occurrences", []) if checkpoint else []
        pages: list[dict[str, Any]] = checkpoint.get("pages", []) if checkpoint else []
        failures: list[dict[str, Any]] = checkpoint.get("failures", []) if checkpoint else []
        start_page_index, page_stop = self._page_range_for_document(document, checkpoint=checkpoint)
        page_indexes = range(start_page_index, page_stop)
        for page_index in page_indexes:
            if self.task_control is not None:
                if self.task_control.should_cancel():
                    print(f"[cancel] file={document.relative_path} page={page_index}", flush=True)
                    break
                self.task_control.wait_if_paused()
            if page_index % 25 == 0:
                print(
                    f"[page] file={document.relative_path} page={page_index + 1}/{document.page_count}",
                    flush=True,
                )
            try:
                page_payload, page_occurrences = self._process_page(document, page_index)
                if page_payload is not None:
                    pages.append(page_payload)
                occurrences.extend(page_occurrences)
            except Exception as exc:  # noqa: BLE001
                print(
                    f"[page:error] file={document.relative_path} page={page_index + 1} error={type(exc).__name__}: {exc}",
                    flush=True,
                )
                failures.append(
                    self._make_failure(
                        document=document,
                        stage="page_process",
                        error_type=type(exc).__name__,
                        error_message=str(exc),
                        page_number=page_index + 1,
                    )
                )
            self._save_checkpoint(document, page_index + 1, pages, occurrences, failures)
        deduped = dedupe_occurrences(occurrences)
        assign_occurrence_indexes(deduped)
        self._persist_document(document, pages, deduped, failures)
        self._clear_checkpoint(document)

    def _delete_document_rows(self, file_path: str) -> None:
        row = self.conn.execute(
            "SELECT document_id FROM documents WHERE file_path = ?",
            (file_path,),
        ).fetchone()
        if row is None:
            return
        document_id = row["document_id"]
        self.conn.execute("DELETE FROM pages WHERE document_id = ?", (document_id,))
        self.conn.execute("DELETE FROM occurrences WHERE document_id = ?", (document_id,))
        self.conn.execute("DELETE FROM failures WHERE document_id = ?", (document_id,))
        self.conn.execute("DELETE FROM documents WHERE document_id = ?", (document_id,))
        self.conn.commit()

    def _process_page(
        self,
        document: DocumentRecord,
        page_index: int,
    ) -> tuple[dict[str, Any] | None, list[dict[str, Any]]]:
        render_path = self._render_page(document, page_index)
        try:
            with Image.open(render_path) as opened_image:
                image = opened_image.copy()
            width, height = image.size
            ocr_results, _ = self.ocr_engine(str(render_path))
            if not ocr_results:
                render_path.unlink(missing_ok=True)
                return None, []
            page_occurrences: list[dict[str, Any]] = []
            page_image_id = f"{document.document_id}-p{page_index+1}"
            for line_index, line in enumerate(ocr_results):
                polygon, text, confidence = line
                if not any(ch in text for ch in TARGET_CHARS):
                    continue
                line_box = self._line_rect(polygon)
                char_boxes = split_line_bbox(text, line_box)
                for char_index, char in enumerate(text):
                    if char not in TARGET_CHARS:
                        continue
                    occurrence = self._build_occurrence(
                        document=document,
                        page_index=page_index,
                        page_image_id=page_image_id,
                        line_index=line_index,
                        line_text=text,
                        line_confidence=float(confidence),
                        image=image,
                        char_index=char_index,
                        char_box=char_boxes[char_index],
                        page_width=width,
                        page_height=height,
                    )
                    page_occurrences.append(occurrence)
            if not page_occurrences:
                render_path.unlink(missing_ok=True)
                return None, []
            page_meta = {
                "page_image_id": page_image_id,
                "document_id": document.document_id,
                "page_number": page_index + 1,
                "page_index": page_index,
                "image_path": str(self._convert_page_to_webp(render_path, page_image_id)),
                "page_width": width,
                "page_height": height,
                "occurrence_count": len(page_occurrences),
                "relative_path": document.relative_path,
                "file_name": document.file_path.name,
            }
            render_path.unlink(missing_ok=True)
            return page_meta, page_occurrences
        finally:
            if render_path.exists():
                render_path.unlink(missing_ok=True)

    def _render_page(self, document: DocumentRecord, page_index: int) -> Path:
        return self.backend_registry.render_page(
            document.file_path, page_index, DEFAULT_RENDER_DPI
        )

    def _line_rect(self, polygon: list[list[float]]) -> tuple[float, float, float, float]:
        xs = [float(point[0]) for point in polygon]
        ys = [float(point[1]) for point in polygon]
        return min(xs), min(ys), max(xs), max(ys)

    def _build_occurrence(
        self,
        document: DocumentRecord,
        page_index: int,
        page_image_id: str,
        line_index: int,
        line_text: str,
        line_confidence: float,
        image: Image.Image,
        char_index: int,
        char_box: tuple[float, float, float, float],
        page_width: int,
        page_height: int,
    ) -> dict[str, Any]:
        matched_character = line_text[char_index]
        character_variant, unicode_codepoint = TARGET_CHARS[matched_character]
        context_fields = build_context_fields(line_text, char_index)
        box_fields = normalize_bbox(*char_box, page_width, page_height)
        crop_image, crop_bounds = self._crop_with_padding(image, char_box)
        secondary_result, secondary_confidence = self._secondary_verify(crop_image, matched_character)
        verification_status, review_reason = classify_verification_status(
            matched_character,
            line_confidence,
            secondary_result,
        )
        occurrence_id = str(uuid.uuid4())
        crop_image_id = f"crop-{occurrence_id}"
        crop_path = self.crops_dir / f"{crop_image_id}.webp"
        crop_image.save(crop_path, format="WEBP", quality=80)
        page_rotation = 0
        return {
            "occurrence_id": occurrence_id,
            "global_occurrence_index": 0,
            "document_id": document.document_id,
            "file_path": str(document.file_path),
            "relative_path": document.relative_path,
            "file_name": document.file_path.name,
            "file_extension": document.file_path.suffix.lower(),
            "file_size_bytes": document.file_size_bytes,
            "file_hash_sha256": document.file_hash_sha256,
            "document_page_count": document.page_count,
            "page_number": page_index + 1,
            "page_index": page_index,
            "page_occurrence_index": 0,
            "document_occurrence_index": 0,
            "matched_character": matched_character,
            "character_variant": character_variant,
            "unicode_codepoint": unicode_codepoint,
            "context_before": context_fields["context_before"],
            "context_after": context_fields["context_after"],
            "context_full": context_fields["context_full"],
            "text_line": context_fields["text_line"],
            "text_block": context_fields["text_block"],
            "location_method": "pdf_ocr" if document.file_type == "PDF" else "djvu_ocr",
            "detection_sources": ["ocr"],
            "ocr_engine": "rapidocr-onnxruntime",
            "ocr_confidence": round(line_confidence, 6),
            "secondary_ocr_result": secondary_result,
            "secondary_ocr_confidence": secondary_confidence,
            "verification_method": "rapidocr_full_page_plus_tesseract_single_char",
            "verification_status": verification_status,
            "review_reason": review_reason,
            "source_x0": box_fields["source_x0"],
            "source_y0": box_fields["source_y0"],
            "source_x1": box_fields["source_x1"],
            "source_y1": box_fields["source_y1"],
            "source_page_width": float(page_width),
            "source_page_height": float(page_height),
            "source_coordinate_unit": "pixel",
            "source_coordinate_origin": "top_left",
            "normalized_x0": box_fields["normalized_x0"],
            "normalized_y0": box_fields["normalized_y0"],
            "normalized_x1": box_fields["normalized_x1"],
            "normalized_y1": box_fields["normalized_y1"],
            "page_rotation": page_rotation,
            "render_dpi": DEFAULT_RENDER_DPI,
            "page_image_id": page_image_id,
            "crop_image_id": crop_image_id,
            "crop_image_path": str(crop_path),
            "line_index": line_index,
            "crop_bounds": crop_bounds,
            "error_message": "",
        }

    def _crop_with_padding(
        self,
        image: Image.Image,
        char_box: tuple[float, float, float, float],
        padding: int = 12,
    ) -> tuple[Image.Image, tuple[int, int, int, int]]:
        x0, y0, x1, y1 = [int(round(v)) for v in char_box]
        left = max(0, x0 - padding)
        top = max(0, y0 - padding)
        right = min(image.width, x1 + padding)
        bottom = min(image.height, y1 + padding)
        crop = image.crop((left, top, right, bottom))
        enlarged = crop.resize((max(1, crop.width * 4), max(1, crop.height * 4)))
        return enlarged, (left, top, right, bottom)

    def _secondary_verify(self, crop_image: Image.Image, matched_character: str) -> tuple[str, float]:
        # Tesseract 可选（任务 §4.2）：缺失时不阻断主 OCR，二次复核记为 skipped。
        if not self.config.has_tesseract:
            return "", 0.0
        language = "chi_sim+chi_sim_vert" if matched_character == "约" else "chi_tra+chi_tra_vert"
        try:
            data = pytesseract.image_to_data(
                crop_image,
                lang=language,
                config="--psm 10",
                output_type=pytesseract.Output.DICT,
            )
        except Exception:
            return "", 0.0
        best_text = ""
        best_conf = 0.0
        for text, conf in zip(data["text"], data["conf"], strict=False):
            stripped = text.strip()
            if not stripped:
                continue
            try:
                conf_value = max(0.0, float(conf)) / 100.0
            except ValueError:
                conf_value = 0.0
            if conf_value >= best_conf:
                best_conf = conf_value
                best_text = stripped[:1]
        return best_text, round(best_conf, 6)

    def _convert_page_to_webp(self, render_path: Path, page_image_id: str) -> Path:
        out_path = self.pages_dir / f"{page_image_id}.webp"
        with Image.open(render_path) as image:
            image.save(out_path, format="WEBP", quality=70, method=6)
        return out_path

    def _make_failure(
        self,
        document: DocumentRecord,
        stage: str,
        error_type: str,
        error_message: str,
        page_number: int | None = None,
    ) -> dict[str, Any]:
        return {
            "failure_id": str(uuid.uuid4()),
            "document_id": document.document_id,
            "file_path": str(document.file_path),
            "file_type": document.file_type,
            "file_size_bytes": document.file_size_bytes,
            "stage": stage,
            "error_type": error_type,
            "error_message": error_message,
            "page_number": page_number,
            "fallback_action": "continue_next_page_or_file",
            "possible_missed_hits": True,
        }

    def _persist_document(
        self,
        document: DocumentRecord,
        pages: list[dict[str, Any]],
        occurrences: list[dict[str, Any]],
        failures: list[dict[str, Any]],
    ) -> None:
        payload = {
            "document_id": document.document_id,
            "file_path": str(document.file_path),
            "relative_path": document.relative_path,
            "file_type": document.file_type,
            "page_count": document.page_count,
            "occurrence_count": len(occurrences),
            "failure_count": len(failures),
        }
        self.conn.execute(
            """
            INSERT INTO documents (
                document_id, file_path, file_type, file_hash_sha256, file_size_bytes,
                modified_time, page_count, status, payload_json
            ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)
            """,
            (
                document.document_id,
                str(document.file_path),
                document.file_type,
                document.file_hash_sha256,
                document.file_size_bytes,
                document.modified_time,
                document.page_count,
                "completed",
                json.dumps(payload, ensure_ascii=False),
            ),
        )
        for page in pages:
            self.conn.execute(
                "INSERT INTO pages (page_image_id, document_id, page_number, payload_json) VALUES (?, ?, ?, ?)",
                (
                    page["page_image_id"],
                    document.document_id,
                    page["page_number"],
                    json.dumps(page, ensure_ascii=False),
                ),
            )
        for occurrence in occurrences:
            self.conn.execute(
                "INSERT INTO occurrences (occurrence_id, document_id, page_image_id, payload_json) VALUES (?, ?, ?, ?)",
                (
                    occurrence["occurrence_id"],
                    document.document_id,
                    occurrence["page_image_id"],
                    json.dumps(occurrence, ensure_ascii=False),
                ),
            )
        for failure in failures:
            self.conn.execute(
                "INSERT INTO failures (failure_id, document_id, payload_json) VALUES (?, ?, ?)",
                (
                    failure["failure_id"],
                    document.document_id,
                    json.dumps(failure, ensure_ascii=False),
                ),
            )
        self.conn.commit()

    def _collect_report_data(self) -> dict[str, Any]:
        documents = [json.loads(row["payload_json"]) for row in self.conn.execute("SELECT payload_json FROM documents")]
        pages = [json.loads(row["payload_json"]) for row in self.conn.execute("SELECT payload_json FROM pages")]
        occurrences = [json.loads(row["payload_json"]) for row in self.conn.execute("SELECT payload_json FROM occurrences")]
        failures = [json.loads(row["payload_json"]) for row in self.conn.execute("SELECT payload_json FROM failures")]
        stats = self._compute_stats(documents, pages, occurrences, failures)
        self._validate_occurrences(occurrences, pages)
        report = {
            "root_dir": str(self.root_dir),
            "output_html": str(self.output_html),
            "started_at": self.started_at.isoformat(timespec="seconds"),
            "finished_at": datetime.now().isoformat(timespec="seconds"),
            "documents": documents,
            "pages": pages,
            "occurrences": occurrences,
            "failures": failures,
            "stats": stats,
            "validation": default_browser_validation(),
        }
        return report

    def _compute_stats(
        self,
        documents: list[dict[str, Any]],
        pages: list[dict[str, Any]],
        occurrences: list[dict[str, Any]],
        failures: list[dict[str, Any]],
    ) -> dict[str, Any]:
        char_counter = Counter(item["matched_character"] for item in occurrences)
        status_counter = Counter((item["matched_character"], item["verification_status"]) for item in occurrences)
        file_types = Counter(item["file_type"] for item in documents)
        methods = Counter(item["location_method"] for item in occurrences)
        per_file_char = defaultdict(set)
        for item in occurrences:
            per_file_char[item["file_path"]].add(item["matched_character"])
        only_simplified = sum(chars == {"约"} for chars in per_file_char.values())
        only_traditional = sum(chars == {"約"} for chars in per_file_char.values())
        both_variants = sum(chars == {"约", "約"} for chars in per_file_char.values())
        return {
            "scan_dir": str(self.root_dir),
            "generated_at": datetime.now().isoformat(timespec="seconds"),
            "pdf_file_count": file_types.get("PDF", 0),
            "djvu_file_count": file_types.get("DJVU", 0),
            "djv_file_count": file_types.get("DJV", 0),
            "success_file_count": len(documents),
            "failure_file_count": len(failures),
            "document_total_pages": sum(item["page_count"] for item in documents),
            "hit_file_count": len({item["file_path"] for item in occurrences}),
            "hit_page_count": len({(item["file_path"], item["page_number"]) for item in occurrences}),
            "simplified_total": char_counter.get("约", 0),
            "traditional_total": char_counter.get("約", 0),
            "combined_total": char_counter.get("约", 0) + char_counter.get("約", 0),
            "simplified_confirmed": status_counter.get(("约", "confirmed"), 0),
            "traditional_confirmed": status_counter.get(("約", "confirmed"), 0),
            "simplified_needs_review": status_counter.get(("约", "needs_review"), 0),
            "traditional_needs_review": status_counter.get(("約", "needs_review"), 0),
            "rejected_total": sum(1 for item in occurrences if item["verification_status"] == "rejected"),
            "text_layer_hits": methods.get("pdf_text_layer", 0) + methods.get("djvu_text_layer", 0),
            "ocr_hits": methods.get("pdf_ocr", 0) + methods.get("djvu_ocr", 0),
            "pdf_ocr_hits": methods.get("pdf_ocr", 0),
            "djvu_ocr_hits": methods.get("djvu_ocr", 0),
            "only_simplified_files": only_simplified,
            "only_traditional_files": only_traditional,
            "both_variant_files": both_variants,
            "embedded_page_count": len(pages),
        }

    def _validate_occurrences(self, occurrences: list[dict[str, Any]], pages: list[dict[str, Any]]) -> None:
        page_ids = {page["page_image_id"] for page in pages}
        seen_ids: set[str] = set()
        for item in occurrences:
            if item["occurrence_id"] in seen_ids:
                raise ValueError(f"duplicate occurrence_id: {item['occurrence_id']}")
            seen_ids.add(item["occurrence_id"])
            if item["matched_character"] not in TARGET_CHARS:
                raise ValueError(f"invalid matched_character: {item['matched_character']}")
            if item["matched_character"] == "约" and item["unicode_codepoint"] != "U+7EA6":
                raise ValueError("simplified unicode mismatch")
            if item["matched_character"] == "約" and item["unicode_codepoint"] != "U+7D04":
                raise ValueError("traditional unicode mismatch")
            if item["normalized_x0"] < 0 or item["normalized_y0"] < 0:
                raise ValueError("normalized coordinate below zero")
            if item["normalized_x1"] > 1 or item["normalized_y1"] > 1:
                raise ValueError("normalized coordinate above one")
            if item["source_x1"] <= item["source_x0"] or item["source_y1"] <= item["source_y0"]:
                raise ValueError("invalid bbox dimensions")
            if item["page_image_id"] not in page_ids:
                raise ValueError(f"missing page image for {item['occurrence_id']}")

    def _browser_validation_stub(self) -> dict[str, str]:
        return default_browser_validation()

    def _build_html(self, report: dict[str, Any]) -> str:
        data_json = json.dumps(report, ensure_ascii=False, separators=(",", ":"))
        status_labels_json = json.dumps(STATUS_LABELS, ensure_ascii=False, separators=(",", ":"))
        stats = report.get("stats", {})
        html_size_note = (
            "从结果清单进入，同屏查看出处页与截取小图，并直接完成校对。"
            f" 当前文件大小：{stats.get('html_file_size_human', '计算中')}。"
        )
        template = """
            <!doctype html>
            <html lang="zh-CN">
            <head>
              <meta charset="utf-8">
              <meta name="viewport" content="width=device-width, initial-scale=1">
              <title>约字检索报告</title>
              <style>
                :root {
                  --bg: #efe1c4;
                  --panel: #fff8ed;
                  --panel-strong: #fffdf8;
                  --line: #d6bb8e;
                  --line-soft: #eadbc0;
                  --ink: #2c2318;
                  --muted: #71593d;
                  --accent: #9f3f10;
                  --accent-soft: #f3ddbb;
                  --ok: #1e6b45;
                  --warn: #9b5a18;
                  --bad: #8f2e2a;
                }
                * { box-sizing: border-box; }
                body {
                  margin: 0;
                  font-family: "Microsoft YaHei", "PingFang SC", sans-serif;
                  color: var(--ink);
                  background:
                    radial-gradient(circle at top left, rgba(255,255,255,0.52), transparent 28%),
                    linear-gradient(180deg, #ebd8ad 0%, #f8f0df 100%);
                }
                .shell {
                  max-width: 1540px;
                  margin: 0 auto;
                  padding: 18px;
                }
                .hero, .toolbar, .workspace, .workspace-shell {
                  background: rgba(255, 250, 240, 0.9);
                  border: 1px solid var(--line);
                  border-radius: 22px;
                  box-shadow: 0 16px 48px rgba(90, 57, 16, 0.08);
                }
                .hero {
                  padding: 20px 22px;
                  display: grid;
                  grid-template-columns: 1.3fr 1fr;
                  gap: 18px;
                  align-items: start;
                }
                .eyebrow {
                  margin: 0 0 8px;
                  color: var(--accent);
                  font-size: 13px;
                  font-weight: 700;
                  letter-spacing: 0.08em;
                }
                h1 {
                  margin: 0 0 8px;
                  font-size: 34px;
                  line-height: 1.1;
                }
                h2, h3 {
                  margin: 0;
                }
                p {
                  margin: 0;
                  color: var(--muted);
                  line-height: 1.6;
                }
                .stats {
                  display: grid;
                  grid-template-columns: repeat(2, minmax(0, 1fr));
                  gap: 10px;
                }
                .stat {
                  padding: 14px;
                  border-radius: 16px;
                  border: 1px solid var(--line-soft);
                  background: linear-gradient(180deg, #fffdf8 0%, #f6ebd4 100%);
                }
                .stat strong {
                  display: block;
                  margin-bottom: 8px;
                  color: var(--muted);
                  font-size: 12px;
                }
                .stat span {
                  font-size: 24px;
                  font-weight: 700;
                }
                .toolbar {
                  margin-top: 16px;
                  padding: 18px;
                }
                .toolbar-head {
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  gap: 12px;
                  margin-bottom: 12px;
                }
                .filters {
                  display: grid;
                  grid-template-columns: 1.8fr 0.8fr 0.8fr 1fr 1fr auto auto;
                  gap: 10px;
                  align-items: end;
                }
                label {
                  display: block;
                  font-size: 13px;
                  color: var(--muted);
                  margin-bottom: 6px;
                }
                select, input, button, textarea {
                  width: 100%;
                  padding: 10px 12px;
                  border-radius: 14px;
                  border: 1px solid var(--line);
                  background: #fff;
                  color: var(--ink);
                  font: inherit;
                }
                button {
                  cursor: pointer;
                }
                .toggle {
                  display: flex;
                  align-items: center;
                  gap: 8px;
                  min-height: 44px;
                  padding: 10px 12px;
                  border-radius: 14px;
                  border: 1px solid var(--line);
                  background: var(--panel-strong);
                  color: var(--ink);
                }
                .toggle input {
                  width: auto;
                  margin: 0;
                }
                .action-button {
                  background: var(--panel-strong);
                }
                .primary-button {
                  background: #f7e3c1;
                  border-color: #d5a266;
                  color: #6d2d04;
                  font-weight: 700;
                }
                .workspace-shell {
                  margin-top: 16px;
                  padding: 16px;
                  height: calc(100vh - 210px);
                  min-height: 720px;
                }
                .workspace {
                  height: 100%;
                  min-height: 0;
                  display: grid;
                  grid-template-columns: minmax(320px, 0.92fr) minmax(0, 1.28fr);
                  gap: 16px;
                }
                .results-pane,
                .detail-pane {
                  min-height: 0;
                  height: 100%;
                }
                .results-pane {
                  border-right: 1px solid var(--line-soft);
                  padding-right: 14px;
                  min-width: 0;
                  display: grid;
                  grid-template-rows: auto auto 1fr;
                  gap: 12px;
                }
                .detail-pane.detail-pane-b2 {
                  position: relative;
                  min-width: 0;
                }
                .detail-scroll {
                  height: 100%;
                  min-height: 0;
                  padding: 16px;
                  border: 1px solid var(--line-soft);
                  border-radius: 20px;
                  background: rgba(255, 253, 248, 0.78);
                  display: grid;
                  grid-template-rows: auto auto auto auto auto;
                  gap: 12px;
                  overflow: auto;
                }
                .pane-head {
                  display: flex;
                  align-items: start;
                  justify-content: space-between;
                  gap: 12px;
                  margin-bottom: 12px;
                }
                .pane-head small, .helper, .context-line, .detail-text, .note-line {
                  color: var(--muted);
                  line-height: 1.6;
                }
                .scope-switches {
                  display: flex;
                  gap: 8px;
                  flex-wrap: wrap;
                  margin-bottom: 12px;
                }
                .scope-switch {
                  display: inline-flex;
                  align-items: center;
                  justify-content: center;
                  padding: 8px 12px;
                  border-radius: 999px;
                  border: 1px solid var(--line);
                  background: #fff;
                  color: var(--muted);
                  font-size: 13px;
                  cursor: pointer;
                }
                .scope-switch.active {
                  background: var(--accent-soft);
                  border-color: #d4a069;
                  color: #6d2d04;
                  font-weight: 700;
                }
                .results-list {
                  display: grid;
                  gap: 10px;
                  min-height: 0;
                  overflow: auto;
                  padding-right: 4px;
                }
                .result-card {
                  padding: 12px;
                  border-radius: 18px;
                  border: 1px solid var(--line-soft);
                  background: var(--panel);
                  cursor: pointer;
                }
                .result-card.active {
                  border-color: #d08d50;
                  background: linear-gradient(180deg, #fff8ef 0%, #fbe8c9 100%);
                  box-shadow: inset 0 0 0 1px rgba(208, 141, 80, 0.18);
                }
                .result-card h3 {
                  margin: 0;
                  font-size: 15px;
                  line-height: 1.45;
                }
                .status-row, .chip-row, .action-row, .decision-row, .nav-row, .result-meta-row, .toolbar-row {
                  display: flex;
                  gap: 8px;
                  flex-wrap: wrap;
                }
                .status-row {
                  align-items: center;
                  justify-content: space-between;
                }
                .result-meta-row {
                  align-items: center;
                  justify-content: space-between;
                  margin: 8px 0 6px;
                  color: var(--muted);
                  font-size: 12px;
                }
                .result-context-line {
                  margin-top: 6px;
                  color: var(--muted);
                  font-size: 13px;
                  line-height: 1.55;
                }
                .status-badge, .evidence-chip, .count-chip {
                  display: inline-flex;
                  align-items: center;
                  padding: 4px 10px;
                  border-radius: 999px;
                  border: 1px solid var(--line);
                  background: #fff;
                  font-size: 12px;
                  font-weight: 700;
                }
                .status-confirmed { color: var(--ok); }
                .status-needs_review { color: var(--warn); }
                .status-rejected { color: var(--bad); }
                .detail-block, details {
                  border: 1px solid var(--line-soft);
                  border-radius: 18px;
                  background: var(--panel);
                  padding: 16px;
                }
                .detail-strip {
                  display: grid;
                  gap: 10px;
                }
                .detail-summary {
                  display: flex;
                  align-items: start;
                  justify-content: space-between;
                  gap: 14px;
                }
                .detail-summary h2 {
                  font-size: 24px;
                }
                .detail-block-head {
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  gap: 12px;
                  margin-bottom: 12px;
                }
                .detail-kicker {
                  display: flex;
                  gap: 8px;
                  flex-wrap: wrap;
                }
                .detail-main-line {
                  display: flex;
                  align-items: start;
                  justify-content: space-between;
                  gap: 12px;
                }
                .detail-title-group {
                  display: grid;
                  gap: 6px;
                  min-width: 0;
                }
                .detail-title-group h2 {
                  font-size: 24px;
                  line-height: 1.2;
                }
                .detail-subline {
                  color: var(--muted);
                  font-size: 13px;
                  line-height: 1.55;
                }
                .viewer-grid {
                  display: grid;
                  gap: 12px;
                }
                .viewer-grid-b2 {
                  grid-template-columns: minmax(0, 1.18fr) minmax(280px, 0.82fr);
                }
                .viewer-shell {
                  display: grid;
                  grid-template-rows: auto 1fr;
                  min-height: 0;
                }
                .view-toolbar {
                  display: flex;
                  align-items: center;
                  justify-content: space-between;
                  gap: 10px;
                  margin-bottom: 10px;
                }
                .toolbar-row {
                  align-items: center;
                }
                .toolbar-row button {
                  width: auto;
                  min-width: 42px;
                }
                .viewer-stage {
                  position: relative;
                  min-height: 420px;
                  overflow: hidden;
                  border-radius: 14px;
                  background: linear-gradient(180deg, #fffef9 0%, #f7ecd6 100%);
                  border: 1px solid rgba(124, 93, 53, 0.14);
                  cursor: grab;
                }
                .viewer-stage.is-dragging {
                  cursor: grabbing;
                }
                .viewer-stage crop-stage {
                  min-height: 320px;
                }
                .viewer-canvas {
                  position: absolute;
                  inset: 0;
                  overflow: hidden;
                }
                .viewer-asset {
                  position: absolute;
                  left: 0;
                  top: 0;
                  transform-origin: top left;
                  will-change: transform;
                }
                .viewer-image {
                  display: block;
                  width: 100%;
                  height: auto;
                  user-select: none;
                  -webkit-user-drag: none;
                }
                .hit-box {
                  position: absolute;
                  border: 3px solid #d24e16;
                  background: rgba(255, 220, 86, 0.28);
                  box-shadow: 0 0 0 6px rgba(255, 203, 0, 0.1);
                }
                .viewer-caption {
                  color: var(--muted);
                  font-size: 12px;
                  line-height: 1.5;
                }
                .detail-bottom-bar {
                  display: grid;
                  gap: 12px;
                }
                .decision-row button,
                .nav-row button {
                  width: auto;
                }
                .note-editor[hidden] {
                  display: none;
                }
                .note-editor {
                  display: grid;
                  gap: 8px;
                }
                .more-grid {
                  display: grid;
                  gap: 8px;
                  margin-top: 12px;
                }
                .more-grid div {
                  color: var(--muted);
                  line-height: 1.6;
                }
                .viewer-empty {
                  height: 100%;
                  display: grid;
                  place-items: center;
                  color: var(--muted);
                  text-align: center;
                  padding: 24px;
                }
                .empty-image {
                  color: var(--muted);
                  text-align: center;
                  padding: 24px;
                }
                .detail-text {
                  white-space: pre-wrap;
                }
                textarea {
                  min-height: 110px;
                  resize: vertical;
                }
                details summary {
                  cursor: pointer;
                  font-weight: 700;
                }
                .immersive-preview {
                  position: fixed;
                  inset: 0;
                  z-index: 30;
                  padding: 28px;
                  background: rgba(32, 21, 12, 0.82);
                  display: none;
                }
                .immersive-preview.open {
                  display: block;
                }
                .immersive-dialog {
                  height: 100%;
                  display: grid;
                  grid-template-rows: auto 1fr;
                  gap: 12px;
                  padding: 16px;
                  border-radius: 24px;
                  background: rgba(255, 249, 239, 0.98);
                  border: 1px solid rgba(214, 187, 142, 0.88);
                }
                .immersive-stage {
                  min-height: 0;
                  height: 100%;
                }
                .immersive-stage .viewer-shell {
                  height: 100%;
                  grid-template-rows: 1fr;
                }
                .immersive-stage .viewer-stage {
                  height: 100%;
                  min-height: 100%;
                }
                .empty-state {
                  border: 1px dashed var(--line);
                  border-radius: 18px;
                  background: var(--panel-strong);
                  padding: 28px;
                  color: var(--muted);
                  text-align: center;
                }
                @media (max-width: 1200px) {
                  .hero, .workspace, .filters, .viewer-grid-b2 {
                    grid-template-columns: 1fr;
                  }
                  .results-pane {
                    border-right: 0;
                    border-bottom: 1px solid var(--line-soft);
                    padding-right: 0;
                    padding-bottom: 14px;
                  }
                  .workspace-shell {
                    height: auto;
                    min-height: auto;
                  }
                  .detail-scroll {
                    padding: 0;
                    border: 0;
                    background: transparent;
                  }
                  .viewer-stage {
                    min-height: 320px;
                  }
                }
              </style>
            </head>
            <body>
              <div class="shell">
                <header class="hero">
                  <div>
                    <p class="eyebrow">档案校对工作台</p>
                    <h1>约字检索报告</h1>
                    <p>__HTML_SIZE_NOTE__</p>
                  </div>
                  <div id="stats" class="stats"></div>
                </header>
                <section class="toolbar">
                  <div class="toolbar-head">
                    <div>
                      <h2>筛选</h2>
                      <p class="helper">先选文档和页码范围，再从左侧清单进入具体条目。</p>
                    </div>
                  </div>
                  <div class="filters">
                    <div>
                      <label for="doc-filter">按文档</label>
                      <select id="doc-filter"></select>
                    </div>
                    <div>
                      <label for="page-range-start">起始页</label>
                      <input id="page-range-start" inputmode="numeric" placeholder="例如 300">
                    </div>
                    <div>
                      <label for="page-range-end">结束页</label>
                      <input id="page-range-end" inputmode="numeric" placeholder="例如 340">
                    </div>
                    <label class="toggle"><input id="with-images-only" type="checkbox">只看有出处图片</label>
                    <label class="toggle"><input id="pending-only" type="checkbox">只看待处理</label>
                    <button id="reset" class="action-button">清空筛选</button>
                    <button id="export-review" class="primary-button">导出校对记录</button>
                  </div>
                </section>
                <section class="workspace-shell">
                  <section class="workspace">
                    <aside class="results-pane">
                      <div class="pane-head">
                        <div>
                          <h2>结果清单</h2>
                          <small>按文档顺序与页码顺序排列，适合连续校对。</small>
                        </div>
                        <div id="result-count" class="count-chip"></div>
                      </div>
                      <div class="scope-switches">
                        <button class="scope-switch active" data-scope="all">全部结果</button>
                        <button class="scope-switch" data-scope="pending">只看待处理</button>
                        <button class="scope-switch" data-scope="confirmed">只看已确认</button>
                      </div>
                      <div id="results-list" class="results-list"></div>
                    </aside>
                    <main class="detail-pane detail-pane-b2">
                      <div id="detail-scroll" class="detail-scroll">
                        <section id="detail-summary" class="detail-block detail-strip"></section>
                        <section class="viewer-grid viewer-grid-b2">
                          <section id="detail-page" class="detail-block viewer-shell"></section>
                          <section id="detail-crop" class="detail-block viewer-shell"></section>
                        </section>
                        <section id="detail-context" class="detail-block"></section>
                        <section id="detail-actions" class="detail-block detail-bottom-bar"></section>
                        <details id="detail-more">
                          <summary>查看来源详情</summary>
                          <div id="detail-more-body" class="more-grid"></div>
                        </details>
                      </div>
                    </main>
                  </section>
                </section>
              </div>
              <div id="immersive-preview" class="immersive-preview" aria-hidden="true">
                <div class="immersive-dialog">
                  <div class="view-toolbar">
                    <div>
                      <h2 id="immersive-title">预览</h2>
                      <p class="viewer-caption">滚轮缩放，拖动平移，双击重置，按 Esc 关闭。</p>
                    </div>
                    <div class="toolbar-row">
                      <button class="action-button" data-zoom="immersive:-1">-</button>
                      <button class="action-button" data-reset-viewer="immersive">100%</button>
                      <button class="action-button" data-zoom="immersive:1">+</button>
                      <button class="primary-button" data-close-preview="immersive">关闭</button>
                    </div>
                  </div>
                  <section id="immersive-stage" class="immersive-stage"></section>
                </div>
              </div>
              <script>
                window.REPORT_DATA = __DATA_JSON__;
              </script>
              <script>
                const data = window.REPORT_DATA;
                const statusLabels = __STATUS_LABELS__;
                const pageMap = Object.fromEntries((data.pages || []).map(page => [page.page_image_id, page]));
                const occurrenceMap = Object.fromEntries((data.occurrences || []).map(item => [item.occurrence_id, item]));
                const documentOrder = Object.fromEntries((data.documents || []).map((doc, index) => [
                  doc.relative_path || doc.file_path || `doc-${index}`,
                  index,
                ]));
                const STORAGE_KEY = "ocr-report-review-state-v1";
                let reviewState = { decisions: {}, notes: {} };
                let filtered = [];
                let currentOccurrenceId = null;
                let scopeMode = "all";
                let activeDetailItem = null;
                let detailUiState = { noteOpen: false };
                const viewerState = {
                  page: { scale: 1, panX: null, panY: null, minScale: 1, maxScale: 6, targetX: 0.5, targetY: 0.5, dragging: null },
                  crop: { scale: 1, panX: null, panY: null, minScale: 1, maxScale: 6, targetX: 0.5, targetY: 0.5, dragging: null },
                  immersive: { scale: 1, panX: null, panY: null, minScale: 1, maxScale: 8, targetX: 0.5, targetY: 0.5, dragging: null, source: null },
                };

                function escapeHtml(value) {
                  return String(value ?? "").replace(/[&<>"']/g, char => ({
                    "&": "&amp;",
                    "<": "&lt;",
                    ">": "&gt;",
                    '"': "&quot;",
                    "'": "&#39;",
                  }[char]));
                }

                window.__assetCache = Object.create(null);
                function loadAsset(assetKey) {
                  if (!assetKey || !data.assets || !data.assets[assetKey]) return "";
                  if (window.__assetCache[assetKey]) return window.__assetCache[assetKey];
                  const raw = atob(data.assets[assetKey]);
                  const arr = new Uint8Array(raw.length);
                  for (let i = 0; i < raw.length; i += 1) arr[i] = raw.charCodeAt(i);
                  const mimeType = assetKey.toLowerCase().endsWith(".png") ? "image/png" : "image/webp";
                  const blob = new Blob([arr], { type: mimeType });
                  const url = URL.createObjectURL(blob);
                  window.__assetCache[assetKey] = url;
                  return url;
                }

                function clamp(value, min, max) {
                  return Math.min(Math.max(value, min), max);
                }

                function getHitTarget(item) {
                  if (!item) return { x: 0.5, y: 0.5 };
                  const x = (Number(item.normalized_x0) + Number(item.normalized_x1)) / 2;
                  const y = (Number(item.normalized_y0) + Number(item.normalized_y1)) / 2;
                  return {
                    x: Number.isFinite(x) ? x : 0.5,
                    y: Number.isFinite(y) ? y : 0.5,
                  };
                }

                function getViewerConfig(kind) {
                  if (kind === "page" && activeDetailItem) {
                    const page = pageMap[activeDetailItem.page_image_id];
                    return {
                      stage: document.getElementById("page-stage"),
                      asset: document.getElementById("page-asset"),
                      width: Number(page?.page_width || activeDetailItem.source_page_width || 0),
                      height: Number(page?.page_height || activeDetailItem.source_page_height || 0),
                    };
                  }
                  if (kind === "crop") {
                    return {
                      stage: document.getElementById("crop-stage"),
                      asset: document.getElementById("crop-asset"),
                    };
                  }
                  if (kind === "immersive") {
                    return {
                      stage: document.getElementById("immersive-viewer-stage"),
                      asset: document.getElementById("immersive-asset"),
                    };
                  }
                  return { stage: null, asset: null };
                }

                function getViewerDimensions(kind) {
                  const config = getViewerConfig(kind);
                  const stage = config.stage;
                  const asset = config.asset;
                  if (!stage || !asset) return null;
                  const stageWidth = Math.max(stage.clientWidth, 1);
                  const stageHeight = Math.max(stage.clientHeight, 1);
                  let contentWidth = Number(config.width || asset.dataset.width || asset.querySelector("img")?.naturalWidth || 0);
                  let contentHeight = Number(config.height || asset.dataset.height || asset.querySelector("img")?.naturalHeight || 0);
                  if (!contentWidth || !contentHeight) {
                    return null;
                  }
                  return { stage, asset, stageWidth, stageHeight, contentWidth, contentHeight };
                }

                function updateViewerTargetFromPan(kind) {
                  const dims = getViewerDimensions(kind);
                  if (!dims) return;
                  const state = viewerState[kind];
                  const fitScale = Math.min(dims.stageWidth / dims.contentWidth, dims.stageHeight / dims.contentHeight);
                  const totalScale = fitScale * state.scale;
                  state.targetX = clamp((dims.stageWidth / 2 - state.panX) / (dims.contentWidth * totalScale), 0, 1);
                  state.targetY = clamp((dims.stageHeight / 2 - state.panY) / (dims.contentHeight * totalScale), 0, 1);
                }

                function applyViewerTransform(kind) {
                  const dims = getViewerDimensions(kind);
                  if (!dims) return;
                  const state = viewerState[kind];
                  const fitScale = Math.min(dims.stageWidth / dims.contentWidth, dims.stageHeight / dims.contentHeight);
                  const totalScale = fitScale * state.scale;
                  const renderedWidth = dims.contentWidth * totalScale;
                  const renderedHeight = dims.contentHeight * totalScale;
                  const centeredX = dims.stageWidth / 2 - state.targetX * renderedWidth;
                  const centeredY = dims.stageHeight / 2 - state.targetY * renderedHeight;
                  const minX = renderedWidth <= dims.stageWidth ? (dims.stageWidth - renderedWidth) / 2 : dims.stageWidth - renderedWidth;
                  const maxX = renderedWidth <= dims.stageWidth ? minX : 0;
                  const minY = renderedHeight <= dims.stageHeight ? (dims.stageHeight - renderedHeight) / 2 : dims.stageHeight - renderedHeight;
                  const maxY = renderedHeight <= dims.stageHeight ? minY : 0;
                  const desiredPanX = Number.isFinite(state.panX) ? state.panX : centeredX;
                  const desiredPanY = Number.isFinite(state.panY) ? state.panY : centeredY;
                  state.panX = clamp(desiredPanX, minX, maxX);
                  state.panY = clamp(desiredPanY, minY, maxY);
                  dims.asset.style.width = `${dims.contentWidth}px`;
                  dims.asset.style.height = `${dims.contentHeight}px`;
                  dims.asset.style.transform = `translate(${state.panX}px, ${state.panY}px) scale(${totalScale})`;
                }

                function syncViewersFromPrimary(kind) {
                  if (kind === "page" && activeDetailItem) {
                    const hit = getHitTarget(activeDetailItem);
                    viewerState.page.targetX = hit.x;
                    viewerState.page.targetY = hit.y;
                  }
                  if (kind === "page" || kind === "crop") {
                    viewerState.crop.targetX = 0.5;
                    viewerState.crop.targetY = 0.5;
                  }
                  applyViewerTransform("page");
                  applyViewerTransform("crop");
                }

                function resetViewer(kind) {
                  const state = viewerState[kind];
                  state.scale = 1;
                  state.panX = null;
                  state.panY = null;
                  state.dragging = null;
                  if (kind === "page" && activeDetailItem) {
                    const hit = getHitTarget(activeDetailItem);
                    state.targetX = hit.x;
                    state.targetY = hit.y;
                  } else {
                    state.targetX = 0.5;
                    state.targetY = 0.5;
                  }
                  if (kind === "immersive") {
                    applyViewerTransform("immersive");
                    return;
                  }
                  syncViewersFromPrimary(kind);
                }

                function zoomViewer(kind, delta) {
                  const state = viewerState[kind];
                  state.scale = clamp(state.scale * (delta > 0 ? 1.18 : 1 / 1.18), state.minScale, state.maxScale);
                  applyViewerTransform(kind);
                }

                function recenterHit() {
                  resetViewer("page");
                }

                function openImmersivePreview(kind) {
                  const sourceHtml = kind === "page" ? document.getElementById("detail-page").innerHTML : document.getElementById("detail-crop").innerHTML;
                  const stage = document.getElementById("immersive-stage");
                  const overlay = document.getElementById("immersive-preview");
                  const title = document.getElementById("immersive-title");
                  if (!stage || !overlay || !sourceHtml) return;
                  title.textContent = kind === "page" ? "出处页预览" : "截取小图预览";
                  stage.innerHTML = `
                    <section class="viewer-shell">
                      <div class="viewer-stage" id="immersive-viewer-stage"></div>
                    </section>
                  `;
                  const originalAsset = document.getElementById(kind === "page" ? "page-asset" : "crop-asset");
                  if (!originalAsset) return;
                  const clone = originalAsset.cloneNode(true);
                  clone.id = "immersive-asset";
                  document.getElementById("immersive-viewer-stage").appendChild(clone);
                  viewerState.immersive.source = kind;
                  overlay.classList.add("open");
                  overlay.setAttribute("aria-hidden", "false");
                  resetViewer("immersive");
                }

                function closeImmersivePreview() {
                  const overlay = document.getElementById("immersive-preview");
                  if (!overlay.classList.contains("open")) return;
                  overlay.classList.remove("open");
                  overlay.setAttribute("aria-hidden", "true");
                  document.getElementById("immersive-stage").innerHTML = "";
                }

                function getDecision(item) {
                  return reviewState.decisions[item.occurrence_id] || item.verification_status;
                }

                function getDecisionLabel(item) {
                  return statusLabels[getDecision(item)] || getDecision(item) || "待判断";
                }

                function getNote(item) {
                  return reviewState.notes[item.occurrence_id] || "";
                }

                function itemHasImages(item) {
                  const page = pageMap[item.page_image_id];
                  return Boolean(page && page.image_asset_key) || Boolean(item.crop_asset_key);
                }

                function readFilterState() {
                  return {
                    document: document.getElementById("doc-filter").value,
                    start: document.getElementById("page-range-start").value,
                    end: document.getElementById("page-range-end").value,
                    withImagesOnly: document.getElementById("with-images-only").checked,
                    pendingOnly: document.getElementById("pending-only").checked,
                    scopeMode,
                  };
                }

                function restoreFilterState(saved) {
                  document.getElementById("doc-filter").value = saved.document || "";
                  document.getElementById("page-range-start").value = saved.start || "";
                  document.getElementById("page-range-end").value = saved.end || "";
                  document.getElementById("with-images-only").checked = Boolean(saved.withImagesOnly);
                  document.getElementById("pending-only").checked = Boolean(saved.pendingOnly);
                  scopeMode = saved.scopeMode || "all";
                  document.querySelectorAll("[data-scope]").forEach(button => {
                    button.classList.toggle("active", button.getAttribute("data-scope") === scopeMode);
                  });
                }

                function saveReviewState() {
                  const payload = {
                    filters: readFilterState(),
                    currentOccurrenceId,
                    decisions: reviewState.decisions,
                    notes: reviewState.notes,
                  };
                  try {
                    localStorage.setItem(STORAGE_KEY, JSON.stringify(payload));
                  } catch (error) {
                    console.warn("saveReviewState failed", error);
                  }
                }

                function loadReviewState() {
                  try {
                    const raw = localStorage.getItem(STORAGE_KEY);
                    if (!raw) return;
                    const saved = JSON.parse(raw);
                    reviewState = {
                      decisions: saved.decisions || {},
                      notes: saved.notes || {},
                    };
                    restoreFilterState(saved.filters || {});
                    currentOccurrenceId = saved.currentOccurrenceId || null;
                  } catch (error) {
                    console.warn("loadReviewState failed", error);
                  }
                }

                function downloadBlob(blob, fileName) {
                  const href = URL.createObjectURL(blob);
                  const link = document.createElement("a");
                  link.href = href;
                  link.download = fileName;
                  document.body.appendChild(link);
                  link.click();
                  link.remove();
                  URL.revokeObjectURL(href);
                }

                function exportReviewData() {
                  const records = (data.occurrences || []).map(item => ({
                    occurrence_id: item.occurrence_id,
                    file_name: item.file_name,
                    file_path: item.file_path,
                    relative_path: item.relative_path,
                    page_number: item.page_number,
                    page_occurrence_index: item.page_occurrence_index,
                    context_full: item.context_full,
                    location_method: item.location_method,
                    unicode_codepoint: item.unicode_codepoint,
                    verification_status: getDecision(item),
                    verification_label: getDecisionLabel(item),
                    note: getNote(item),
                  }));
                  const blob = new Blob(
                    [JSON.stringify({ exported_at: new Date().toISOString(), records }, null, 2)],
                    { type: "application/json" },
                  );
                  downloadBlob(blob, "约字检索报告-校对记录.json");
                }

                function renderStats() {
                  const occurrences = data.occurrences || [];
                  const pending = occurrences.filter(item => getDecision(item) === "needs_review").length;
                  const confirmed = occurrences.filter(item => getDecision(item) === "confirmed").length;
                  const rejected = occurrences.filter(item => getDecision(item) === "rejected").length;
                  const entries = [
                    ["当前结果", filtered.length],
                    ["待判断", pending],
                    ["已确认", confirmed],
                    ["排除", rejected],
                  ];
                  document.getElementById("stats").innerHTML = entries
                    .map(([label, value]) => `<div class="stat"><strong>${label}</strong><span>${value}</span></div>`)
                    .join("");
                }

                function renderDocumentOptions() {
                  const select = document.getElementById("doc-filter");
                  const documents = [...new Set((data.occurrences || []).map(item => item.relative_path))];
                  select.innerHTML = [
                    '<option value="">全部文档</option>',
                    ...documents.map(path => `<option value="${escapeHtml(path)}">${escapeHtml(path)}</option>`),
                  ].join("");
                }

                function getClosestActionValue(event, attributeName) {
                  if (!(event.target instanceof Element)) return null;
                  return event.target.closest(`[${attributeName}]`)?.getAttribute(attributeName) || null;
                }

                function applyFilters() {
                  try {
                    const documentValue = document.getElementById("doc-filter").value;
                    const startValue = Number.parseInt(document.getElementById("page-range-start").value, 10);
                    const endValue = Number.parseInt(document.getElementById("page-range-end").value, 10);
                    const withImagesOnly = document.getElementById("with-images-only").checked;
                    const pendingOnly = document.getElementById("pending-only").checked;
                    filtered = (data.occurrences || []).filter(item => {
                      if (documentValue && item.relative_path !== documentValue) return false;
                      if (Number.isFinite(startValue) && item.page_number < startValue) return false;
                      if (Number.isFinite(endValue) && item.page_number > endValue) return false;
                      if (withImagesOnly && !itemHasImages(item)) return false;
                      if (pendingOnly && getDecision(item) !== "needs_review") return false;
                      if (scopeMode === "pending" && getDecision(item) !== "needs_review") return false;
                      if (scopeMode === "confirmed" && getDecision(item) !== "confirmed") return false;
                      return true;
                    });
                    filtered.sort((left, right) => {
                      const docOrderDelta =
                        (documentOrder[left.relative_path] ?? Number.MAX_SAFE_INTEGER) -
                        (documentOrder[right.relative_path] ?? Number.MAX_SAFE_INTEGER);
                      if (docOrderDelta !== 0) return docOrderDelta;
                      if (left.page_number !== right.page_number) return left.page_number - right.page_number;
                      return left.page_occurrence_index - right.page_occurrence_index;
                    });
                    if (!filtered.some(item => item.occurrence_id === currentOccurrenceId)) {
                      currentOccurrenceId = filtered[0]?.occurrence_id || null;
                    }
                    document.getElementById("result-count").textContent = `${filtered.length} 条`;
                    renderStats();
                    renderResultsList();
                    if (currentOccurrenceId) {
                      renderDetailPane(occurrenceMap[currentOccurrenceId]);
                    } else {
                      renderEmptyDetail();
                    }
                  } catch (error) {
                    console.error("applyFilters failed", error);
                    renderEmptyDetail();
                  } finally {
                    saveReviewState();
                  }
                }

                function renderResultsList() {
                  const host = document.getElementById("results-list");
                  if (!filtered.length) {
                    host.innerHTML = '<div class="empty-state">当前筛选下没有结果。</div>';
                    return;
                  }
                  host.innerHTML = filtered.map(item => `
                    <article class="result-card ${item.occurrence_id === currentOccurrenceId ? "active" : ""}" data-select="${item.occurrence_id}">
                      <div class="status-row">
                        <span class="status-badge status-${getDecision(item)}">${escapeHtml(getDecisionLabel(item))}</span>
                        <span class="count-chip">${escapeHtml(item.matched_character || "命中")} · 第 ${item.page_occurrence_index} 处</span>
                      </div>
                      <h3>${escapeHtml(item.result_title)}</h3>
                      <div class="result-meta-row">
                        <span>${escapeHtml(item.relative_path || item.file_name || "")}</span>
                        <span>第 ${item.page_number} 页</span>
                      </div>
                      <p class="result-context-line">${escapeHtml(item.context_preview || item.context_full || "")}</p>
                      <div class="chip-row">
                        ${(item.evidence_badges || []).map(label => `<span class="evidence-chip">${escapeHtml(label)}</span>`).join("")}
                      </div>
                    </article>
                  `).join("");
                }

                function renderEmptyDetail() {
                  activeDetailItem = null;
                  const emptyHtml = '<div class="empty-state">从左侧结果清单选择一条记录后，这里会显示出处页、截取小图和校对动作。</div>';
                  ["detail-summary", "detail-page", "detail-crop", "detail-context", "detail-actions"].forEach(id => {
                    document.getElementById(id).innerHTML = emptyHtml;
                  });
                  document.getElementById("detail-more-body").innerHTML = "";
                }

                function renderDetailSummary(item) {
                  document.getElementById("detail-summary").innerHTML = `
                    <div class="detail-kicker">
                      <span class="status-badge status-${getDecision(item)}">${escapeHtml(getDecisionLabel(item))}</span>
                      <span class="evidence-chip">第 ${item.page_number} 页</span>
                      <span class="evidence-chip">${escapeHtml(item.location_method || "来源未标注")}</span>
                      ${(item.evidence_badges || []).map(label => `<span class="evidence-chip">${escapeHtml(label)}</span>`).join("")}
                    </div>
                    <div class="detail-main-line">
                      <div class="detail-title-group">
                        <h2>${escapeHtml(item.result_title)}</h2>
                        <div class="detail-subline">${escapeHtml(item.relative_path || item.file_name || "")}</div>
                        <div class="detail-subline">${escapeHtml(item.context_preview || item.context_full || "")}</div>
                      </div>
                      <div class="action-row">
                        <button class="action-button" data-copy-path="${item.occurrence_id}">复制路径</button>
                        <button class="action-button" data-open-file="${item.occurrence_id}">打开原文件</button>
                      </div>
                    </div>
                  `;
                }

                function renderDetailPage(item) {
                  const page = pageMap[item.page_image_id];
                  const assetUrl = page ? loadAsset(page.image_asset_key) : "";
                  const pageHtml = assetUrl
                    ? `
                      <div class="view-toolbar">
                        <div>
                          <h2>出处页预览</h2>
                          <p class="viewer-caption">滚轮缩放，拖动平移，双击重置。</p>
                        </div>
                        <div class="toolbar-row">
                          <button class="action-button" data-zoom="page:-1">-</button>
                          <button class="action-button" data-reset-viewer="page">100%</button>
                          <button class="action-button" id="recenter-hit">重新居中</button>
                          <button class="action-button" data-zoom="page:1">+</button>
                          <button class="action-button" data-preview="page">预览</button>
                        </div>
                      </div>
                      <div class="viewer-stage" id="page-stage" data-viewer-kind="page">
                        <div class="viewer-canvas">
                          <div class="viewer-asset" id="page-asset" data-width="${Number(page?.page_width || item.source_page_width || 0)}" data-height="${Number(page?.page_height || item.source_page_height || 0)}">
                            <img class="viewer-image" src="${assetUrl}" alt="出处页">
                            <div id="current-hit" class="hit-box" style="
                              left:${item.normalized_x0 * 100}%;
                              top:${item.normalized_y0 * 100}%;
                              width:${(item.normalized_x1 - item.normalized_x0) * 100}%;
                              height:${(item.normalized_y1 - item.normalized_y0) * 100}%;
                            "></div>
                          </div>
                        </div>
                      </div>
                    `
                    : '<div class="viewer-empty">这条记录没有可显示的出处页图片。</div>';
                  document.getElementById("detail-page").innerHTML = `
                    ${pageHtml}
                    <div class="toolbar-row" style="margin-top: 10px;">
                      <button class="action-button" data-focus-page="${item.occurrence_id}">在本页定位</button>
                      <button class="action-button" data-open-page="${item.occurrence_id}">单独查看出处页</button>
                    </div>
                  `;
                }

                function renderDetailCrop(item) {
                  const assetUrl = loadAsset(item.crop_asset_key);
                  document.getElementById("detail-crop").innerHTML = `
                    <div class="view-toolbar">
                      <div>
                        <h2>截取小图</h2>
                        <p class="viewer-caption">可单独放大查看字符细节。</p>
                      </div>
                      <div class="toolbar-row">
                        <button class="action-button" data-zoom="crop:-1">-</button>
                        <button class="action-button" data-reset-viewer="crop">100%</button>
                        <button class="action-button" data-zoom="crop:1">+</button>
                        <button class="action-button" data-preview="crop">预览</button>
                      </div>
                    </div>
                    <div class="viewer-stage" id="crop-stage" data-viewer-kind="crop">
                      <div class="viewer-canvas">
                        ${assetUrl ? `
                          <div class="viewer-asset" id="crop-asset">
                            <img class="viewer-image" src="${assetUrl}" alt="截取小图">
                          </div>
                        ` : '<div class="viewer-empty">这条记录没有可显示的截取小图。</div>'}
                      </div>
                    </div>
                  `;
                }

                function renderDetailContext(item) {
                  document.getElementById("detail-context").innerHTML = `
                    <div class="detail-block-head">
                      <h2>上下文与判断参考</h2>
                      <span class="count-chip">识别把握 ${escapeHtml(item.ocr_confidence ?? "未提供")}</span>
                    </div>
                    <div class="detail-text">${escapeHtml(item.context_full || "")}</div>
                  `;
                }

                function renderDetailActions(item) {
                  const note = getNote(item);
                  const noteHidden = !detailUiState.noteOpen && !note;
                  document.getElementById("detail-actions").innerHTML = `
                    <div class="decision-row">
                      <button class="primary-button" data-decision="confirmed">已确认</button>
                      <button class="action-button" data-decision="needs_review">待判断</button>
                      <button class="action-button" data-decision="rejected">排除</button>
                      <button class="action-button" id="toggle-note-editor">备注</button>
                    </div>
                    <div class="nav-row">
                      <button class="action-button" data-nav="prev">上一条</button>
                      <button class="action-button" data-nav="next">下一条</button>
                      <button class="primary-button" data-nav="pending">下一条待处理</button>
                    </div>
                    <div id="note-editor" class="note-editor" ${noteHidden ? "hidden" : ""}>
                      <label for="note-input">备注</label>
                      <textarea id="note-input" placeholder="写下你的判断依据或后续线索。">${escapeHtml(note)}</textarea>
                    </div>
                  `;
                }

                function renderMoreInfoPanel(item) {
                  document.getElementById("detail-more-body").innerHTML = [
                    `<div>文档路径：${escapeHtml(item.file_path)}</div>`,
                    `<div>来源页码：第 ${item.page_number} 页</div>`,
                    `<div>识别把握：${escapeHtml(item.ocr_confidence ?? "未提供")}</div>`,
                    `<div>来源方式：${escapeHtml(item.location_method || "未提供")}</div>`,
                    `<div>原始代码点：${escapeHtml(item.unicode_codepoint || "未提供")}</div>`,
                  ].join("");
                }

                function renderDetailPane(item) {
                  if (!item) {
                    renderEmptyDetail();
                    return;
                  }
                  activeDetailItem = item;
                  renderDetailSummary(item);
                  renderDetailPage(item);
                  renderDetailCrop(item);
                  renderDetailContext(item);
                  renderDetailActions(item);
                  renderMoreInfoPanel(item);
                  requestAnimationFrame(() => {
                    resetViewer("page");
                    resetViewer("crop");
                  });
                }

                function selectOccurrence(occurrenceId) {
                  currentOccurrenceId = occurrenceId;
                  detailUiState.noteOpen = false;
                  renderResultsList();
                  try {
                    renderDetailPane(occurrenceMap[occurrenceId]);
                  } catch (error) {
                    console.error("selectOccurrence failed", error);
                    renderEmptyDetail();
                  } finally {
                    saveReviewState();
                  }
                }

                function moveSelection(direction) {
                  if (!currentOccurrenceId) return;
                  const index = filtered.findIndex(item => item.occurrence_id === currentOccurrenceId);
                  if (index < 0) return;
                  const nextIndex = direction === "prev" ? index - 1 : index + 1;
                  if (nextIndex >= 0 && nextIndex < filtered.length) {
                    selectOccurrence(filtered[nextIndex].occurrence_id);
                  }
                }

                function goToNextPending() {
                  const pending = filtered.filter(item => getDecision(item) === "needs_review");
                  const index = pending.findIndex(item => item.occurrence_id === currentOccurrenceId);
                  if (index >= 0 && index < pending.length - 1) {
                    selectOccurrence(pending[index + 1].occurrence_id);
                    return;
                  }
                  if (index === -1 && pending.length) {
                    selectOccurrence(pending[0].occurrence_id);
                  }
                }

                function applyDecision(status) {
                  if (!currentOccurrenceId) return;
                  reviewState.decisions[currentOccurrenceId] = status;
                  saveReviewState();
                  applyFilters();
                }

                function updateNote(value) {
                  if (!currentOccurrenceId) return;
                  reviewState.notes[currentOccurrenceId] = value;
                  saveReviewState();
                }

                function openOriginalFile(occurrenceId) {
                  const item = occurrenceMap[occurrenceId];
                  if (!item) return;
                  window.open(item.open_file_url, "_blank", "noopener,noreferrer");
                }

                function openCurrentPage(occurrenceId) {
                  const item = occurrenceMap[occurrenceId];
                  if (!item) return;
                  const page = pageMap[item.page_image_id];
                  const assetUrl = page ? loadAsset(page.image_asset_key) : "";
                  if (assetUrl) {
                    window.open(assetUrl, "_blank", "noopener,noreferrer");
                  }
                }

                function focusCurrentPage() {
                  recenterHit();
                }

                document.addEventListener("click", event => {
                  const selectId = getClosestActionValue(event, "data-select");
                  const decision = getClosestActionValue(event, "data-decision");
                  const nav = getClosestActionValue(event, "data-nav");
                  const copyPath = getClosestActionValue(event, "data-copy-path");
                  const openFile = getClosestActionValue(event, "data-open-file");
                  const openPage = getClosestActionValue(event, "data-open-page");
                  const focusPage = getClosestActionValue(event, "data-focus-page");
                  const scope = getClosestActionValue(event, "data-scope");
                  const zoom = getClosestActionValue(event, "data-zoom");
                  const resetViewerTarget = getClosestActionValue(event, "data-reset-viewer");
                  const preview = getClosestActionValue(event, "data-preview");
                  const closePreview = getClosestActionValue(event, "data-close-preview");
                  if (selectId) selectOccurrence(selectId);
                  if (decision) applyDecision(decision);
                  if (nav === "prev") moveSelection("prev");
                  if (nav === "next") moveSelection("next");
                  if (nav === "pending") goToNextPending();
                  if (copyPath) {
                    const item = occurrenceMap[copyPath];
                    if (item) navigator.clipboard.writeText(item.file_path);
                  }
                  if (openFile) openOriginalFile(openFile);
                  if (openPage) openCurrentPage(openPage);
                  if (focusPage) focusCurrentPage();
                  if (zoom) {
                    const [kind, delta] = zoom.split(":");
                    zoomViewer(kind, Number(delta));
                  }
                  if (resetViewerTarget) resetViewer(resetViewerTarget);
                  if (event.target.id === "toggle-note-editor") {
                    detailUiState.noteOpen = !detailUiState.noteOpen;
                    renderDetailActions(activeDetailItem);
                  }
                  if (event.target.id === "recenter-hit") recenterHit();
                  if (preview) openImmersivePreview(preview);
                  if (closePreview) closeImmersivePreview();
                  if (event.target.id === "immersive-preview") closeImmersivePreview();
                  if (scope) {
                    scopeMode = scope;
                    document.querySelectorAll("[data-scope]").forEach(button => {
                      button.classList.toggle("active", button.getAttribute("data-scope") === scopeMode);
                    });
                    applyFilters();
                  }
                });

                document.addEventListener("input", event => {
                  if (event.target.id === "note-input") {
                    updateNote(event.target.value);
                  }
                });

                document.addEventListener("load", event => {
                  if (!(event.target instanceof HTMLImageElement)) return;
                  const asset = event.target.closest(".viewer-asset");
                  if (asset && !asset.dataset.width) asset.dataset.width = String(event.target.naturalWidth || 0);
                  if (asset && !asset.dataset.height) asset.dataset.height = String(event.target.naturalHeight || 0);
                  requestAnimationFrame(() => {
                    if (asset?.id === "page-asset") applyViewerTransform("page");
                    if (asset?.id === "crop-asset") applyViewerTransform("crop");
                    if (asset?.id === "immersive-asset") applyViewerTransform("immersive");
                  });
                }, true);

                document.addEventListener("wheel", event => {
                  if (!(event.target instanceof Element)) return;
                  const stage = event.target.closest("[data-viewer-kind]");
                  if (!stage) return;
                  event.preventDefault();
                  zoomViewer(stage.getAttribute("data-viewer-kind"), event.deltaY < 0 ? 1 : -1);
                }, { passive: false });

                document.addEventListener("dblclick", event => {
                  if (!(event.target instanceof Element)) return;
                  const stage = event.target.closest("[data-viewer-kind]");
                  if (!stage) return;
                  resetViewer(stage.getAttribute("data-viewer-kind"));
                });

                document.addEventListener("pointerdown", event => {
                  if (!(event.target instanceof Element)) return;
                  const stage = event.target.closest("[data-viewer-kind]");
                  if (!stage) return;
                  const kind = stage.getAttribute("data-viewer-kind");
                  const state = viewerState[kind];
                  state.dragging = { x: event.clientX, y: event.clientY, panX: state.panX, panY: state.panY };
                  stage.classList.add("is-dragging");
                });

                document.addEventListener("pointermove", event => {
                  ["page", "crop", "immersive"].forEach(kind => {
                    const state = viewerState[kind];
                    if (!state.dragging) return;
                    state.panX = state.dragging.panX + (event.clientX - state.dragging.x);
                    state.panY = state.dragging.panY + (event.clientY - state.dragging.y);
                    applyViewerTransform(kind);
                    updateViewerTargetFromPan(kind);
                  });
                });

                document.addEventListener("pointerup", () => {
                  ["page", "crop", "immersive"].forEach(kind => {
                    const state = viewerState[kind];
                    state.dragging = null;
                  });
                  document.querySelectorAll(".viewer-stage").forEach(stage => stage.classList.remove("is-dragging"));
                });

                document.addEventListener("keydown", event => {
                  if (event.key === "Escape") closeImmersivePreview();
                });

                window.addEventListener("resize", () => {
                  ["page", "crop", "immersive"].forEach(applyViewerTransform);
                });

                ["doc-filter", "page-range-start", "page-range-end"].forEach(id => {
                  document.getElementById(id).addEventListener("input", applyFilters);
                  document.getElementById(id).addEventListener("change", applyFilters);
                });
                document.getElementById("with-images-only").addEventListener("change", applyFilters);
                document.getElementById("pending-only").addEventListener("change", applyFilters);
                document.getElementById("reset").addEventListener("click", () => {
                  restoreFilterState({
                    document: "",
                    start: "",
                    end: "",
                    withImagesOnly: false,
                    pendingOnly: false,
                    scopeMode: "all",
                  });
                  applyFilters();
                });
                document.getElementById("export-review").addEventListener("click", exportReviewData);

                renderDocumentOptions();
                loadReviewState();
                applyFilters();
              </script>
            </body>
            </html>
        """
        return textwrap.dedent(
            template
            .replace("__DATA_JSON__", data_json)
            .replace("__STATUS_LABELS__", status_labels_json)
            .replace("__HTML_SIZE_NOTE__", html_size_note)
        )


def embed_assets(report: dict[str, Any]) -> None:
    assets: dict[str, str] = dict(report.get("assets", {}))
    for page in report["pages"]:
        asset_key = page.get("image_asset_key", page["page_image_id"])
        if asset_key in assets:
            continue
        path = Path(page["image_path"])
        assets[asset_key] = base64.b64encode(path.read_bytes()).decode("ascii")
    for occurrence in report["occurrences"]:
        asset_key = occurrence.get("crop_asset_key", occurrence["crop_image_id"])
        if asset_key in assets:
            continue
        path = Path(occurrence["crop_image_path"])
        assets[asset_key] = base64.b64encode(path.read_bytes()).decode("ascii")
    report["assets"] = assets


def default_browser_validation() -> dict[str, str]:
    return {
        "html_direct_open": "NOT_RUN",
        "offline_usage": "NOT_RUN",
        "no_external_requests": "NOT_RUN",
        "search": "NOT_RUN",
        "simplified_filter": "NOT_RUN",
        "traditional_filter": "NOT_RUN",
        "simplified_jump": "NOT_RUN",
        "traditional_jump": "NOT_RUN",
        "auto_zoom": "NOT_RUN",
        "auto_center": "NOT_RUN",
        "single_char_highlight": "NOT_RUN",
        "zoom_coordinate_accuracy": "NOT_RUN",
        "prev_next": "NOT_RUN",
        "chinese_path": "NOT_RUN",
        "open_original_file": "NOT_RUN",
        "no_javascript_error": "NOT_RUN",
    }


def load_browser_validation(workspace_dir: Path) -> dict[str, str]:
    validation = default_browser_validation()
    path = workspace_dir / "browser_validation.json"
    if not path.exists():
        return validation
    payload = json.loads(path.read_text(encoding="utf-8"))
    for key, value in payload.items():
        if key in validation and isinstance(value, str):
            validation[key] = value
    return validation


def build_file_url(path: str) -> str:
    normalized = path.replace("\\", "/")
    if not normalized.startswith("/"):
        normalized = "/" + normalized
    return f"file://{quote(normalized, safe='/:')}"


def format_file_size(size_bytes: int) -> str:
    units = ["B", "KB", "MB", "GB"]
    value = float(size_bytes)
    unit = units[0]
    for unit in units:
        if value < 1024 or unit == units[-1]:
            break
        value /= 1024
    if unit == "B":
        return f"{int(value)} {unit}"
    return f"{value:.2f} {unit}"


def build_occurrence_user_fields(occurrence: dict[str, Any], page_map: dict[str, dict[str, Any]]) -> None:
    page = page_map.get(occurrence["page_image_id"], {})
    evidence_badges: list[str] = []
    if page.get("image_asset_key"):
        evidence_badges.append("有出处页")
    if occurrence.get("crop_asset_key"):
        evidence_badges.append("有截取小图")
    occurrence["user_verification_label"] = STATUS_LABELS.get(
        occurrence["verification_status"],
        occurrence["verification_status"],
    )
    occurrence["result_title"] = (
        f'{occurrence["file_name"]} · 第 {occurrence["page_number"]} 页 · '
        f'第 {occurrence["page_occurrence_index"]} 处'
    )
    occurrence["evidence_badges"] = evidence_badges
    occurrence["context_preview"] = occurrence.get("context_full", "")[:80]


def prepare_report_for_output(report: dict[str, Any], workspace_dir: Path) -> None:
    report["validation"] = load_browser_validation(workspace_dir)
    stats = report.setdefault("stats", {})
    stats.setdefault("pdf_text_layer_hits", 0)
    stats.setdefault("pdf_ocr_hits", 0)
    stats.setdefault("djvu_text_layer_hits", 0)
    stats.setdefault("djvu_ocr_hits", 0)
    stats.setdefault("only_simplified_files", 0)
    stats.setdefault("only_traditional_files", 0)
    stats.setdefault("both_variant_files", 0)
    stats.setdefault("html_file_size_bytes", 0)
    stats.setdefault("html_file_size_human", "计算中")
    page_map: dict[str, dict[str, Any]] = {}
    for page in report.get("pages", []):
        page["image_asset_key"] = page.get("image_asset_key", page["page_image_id"])
        page["user_page_label"] = f'第 {page["page_number"]} 页'
        page_map[page["page_image_id"]] = page
        page.pop("image_path", None)
    for occurrence in report.get("occurrences", []):
        occurrence["open_file_url"] = build_file_url(occurrence["file_path"])
        occurrence["crop_asset_key"] = occurrence.get("crop_asset_key", occurrence["crop_image_id"])
        build_occurrence_user_fields(occurrence, page_map)
        occurrence.pop("crop_image_path", None)
    for failure in report.get("failures", []):
        failure["open_file_url"] = build_file_url(failure["file_path"])


def write_report_outputs(
    report: dict[str, Any],
    output_html: Path,
    json_path: Path,
    build_html: Any,
    workspace_dir: Path,
) -> None:
    prepare_report_for_output(report, workspace_dir)
    output_html.write_text(build_html(report), encoding="utf-8")
    html_size = output_html.stat().st_size
    report["stats"]["html_file_size_bytes"] = html_size
    report["stats"]["html_file_size_human"] = format_file_size(html_size)
    final_html = build_html(report)
    output_html.write_text(final_html, encoding="utf-8")
    json_path.write_text(json.dumps(report, ensure_ascii=False, separators=(",", ":")), encoding="utf-8")


def discover_worker_report_paths(workspace_dir: Path, worker_names: set[str] | None = None) -> list[Path]:
    paths: list[Path] = []
    for worker in sorted([p for p in workspace_dir.iterdir() if p.is_dir() and p.name.startswith("worker_")]):
        if worker_names is not None and worker.name not in worker_names:
            continue
        report_path = worker / "run" / "report.json"
        if report_path.exists():
            paths.append(report_path)
    return paths


def run_parallel_documents(args: argparse.Namespace) -> dict[str, Any]:
    root_dir = Path(args.root_dir)
    workspace_dir = Path(args.workspace_dir)
    output_html = Path(args.output_html)
    coordinator = ReportPipeline(
        root_dir=root_dir,
        output_html=output_html,
        workspace_dir=workspace_dir,
        page_limit=args.page_limit,
        document_limit=args.document_limit,
        include_paths={str(Path(p)) for p in args.include_path} if args.include_path else None,
        start_page_index=args.start_page_index,
        end_page_index_exclusive=args.end_page_index_exclusive,
    )
    try:
        documents = coordinator._scan_documents()
        if args.document_limit is not None:
            documents = documents[: args.document_limit]
        print(f"[parallel] documents={len(documents)} workers={args.parallel_docs}", flush=True)
        worker_count = max(1, min(args.parallel_docs, len(documents) or 1))
        worker_outputs = _run_workers(args, documents, worker_count)
        merged = _merge_worker_reports(coordinator, worker_outputs)
        embed_assets(merged)
        write_report_outputs(
            report=merged,
            output_html=output_html,
            json_path=coordinator.json_path,
            build_html=coordinator._build_html,
            workspace_dir=workspace_dir,
        )
        return merged
    finally:
        coordinator.close()


def _run_workers(args: argparse.Namespace, documents: list[DocumentRecord], worker_count: int) -> list[Path]:
    output_paths: list[Path] = []
    running: list[dict[str, Any]] = []
    for index, document in enumerate(documents, start=1):
        worker_dir = Path(args.workspace_dir) / f"worker_{index:02d}"
        worker_dir.mkdir(parents=True, exist_ok=True)
        worker_output = worker_dir / "partial.html"
        output_paths.append(worker_dir / "run" / "report.json")
        out_log = worker_dir / "worker.out.log"
        err_log = worker_dir / "worker.err.log"
        cmd = [
            "python",
            "report_pipeline.py",
            "--root-dir",
            args.root_dir,
            "--output-html",
            str(worker_output),
            "--workspace-dir",
            str(worker_dir),
            "--include-path",
            str(document.file_path),
        ]
        if args.page_limit is not None:
            cmd += ["--page-limit", str(args.page_limit)]
        out_handle = out_log.open("w", encoding="utf-8")
        err_handle = err_log.open("w", encoding="utf-8")
        proc = subprocess.Popen(
            cmd,
            cwd=str(SCRIPT_DIR),
            stdout=out_handle,
            stderr=err_handle,
            text=True,
        )
        running.append(
            {
                "proc": proc,
                "relative_path": document.relative_path,
                "worker_dir": worker_dir,
                "out_handle": out_handle,
                "err_handle": err_handle,
                "reported": False,
            }
        )
        if len(running) >= worker_count:
            _drain_workers(running)
    _drain_workers(running, wait_all=True)
    return output_paths


def _drain_workers(running: list[dict[str, Any]], wait_all: bool = False) -> None:
    while running:
        finished_any = False
        for item in list(running):
            proc = item["proc"]
            returncode = proc.poll()
            if returncode is None and not wait_all:
                continue
            if returncode is None:
                returncode = proc.wait()
            item["out_handle"].close()
            item["err_handle"].close()
            if returncode != 0:
                err_log = (item["worker_dir"] / "worker.err.log").read_text(encoding="utf-8", errors="ignore")
                raise RuntimeError(f"worker failed for {item['relative_path']}: {err_log}")
            print(f"[parallel:done] {item['relative_path']}", flush=True)
            running.remove(item)
            finished_any = True
        if finished_any and not wait_all:
            return
        if running:
            time.sleep(1)


def _merge_worker_reports(coordinator: ReportPipeline, report_paths: list[Path]) -> dict[str, Any]:
    documents: list[dict[str, Any]] = []
    pages: list[dict[str, Any]] = []
    occurrences: list[dict[str, Any]] = []
    failures: list[dict[str, Any]] = []
    assets: dict[str, str] = {}
    started_at: list[str] = []
    finished_at: list[str] = []
    for path in report_paths:
        report = json.loads(path.read_text(encoding="utf-8"))
        documents.extend(report["documents"])
        pages.extend(report["pages"])
        occurrences.extend(report["occurrences"])
        failures.extend(report["failures"])
        assets.update(report.get("assets", {}))
        started_at.append(report["started_at"])
        finished_at.append(report["finished_at"])
    documents = _aggregate_merged_documents(documents)
    assign_occurrence_indexes(occurrences)
    stats = coordinator._compute_stats(documents, pages, occurrences, failures)
    coordinator._validate_occurrences(occurrences, pages)
    return {
        "root_dir": str(coordinator.root_dir),
        "output_html": str(coordinator.output_html),
        "started_at": min(started_at) if started_at else datetime.now().isoformat(timespec="seconds"),
        "finished_at": max(finished_at) if finished_at else datetime.now().isoformat(timespec="seconds"),
        "documents": documents,
        "pages": pages,
        "occurrences": occurrences,
        "failures": failures,
        "assets": assets,
        "stats": stats,
        "validation": coordinator._browser_validation_stub(),
    }


def _aggregate_merged_documents(documents: list[dict[str, Any]]) -> list[dict[str, Any]]:
    aggregated: dict[tuple[str, str], dict[str, Any]] = {}
    for document in documents:
        key = (
            document["file_path"],
            str(document.get("file_hash_sha256", "")),
        )
        current = aggregated.get(key)
        if current is None:
            aggregated[key] = dict(document)
            continue
        current["page_count"] = max(current.get("page_count", 0), document.get("page_count", 0))
        current["occurrence_count"] = current.get("occurrence_count", 0) + document.get("occurrence_count", 0)
        current["failure_count"] = current.get("failure_count", 0) + document.get("failure_count", 0)
    return sorted(aggregated.values(), key=lambda item: item.get("relative_path", item["file_path"]))


def merge_existing_reports(
    root_dir: Path,
    workspace_dir: Path,
    output_html: Path,
    output_json: Path | None = None,
    worker_names: set[str] | None = None,
) -> dict[str, Any]:
    coordinator = ReportPipeline(
        root_dir=root_dir,
        output_html=output_html,
        workspace_dir=workspace_dir,
    )
    try:
        report_paths = discover_worker_report_paths(workspace_dir, worker_names=worker_names)
        merged = _merge_worker_reports(coordinator, report_paths)
        embed_assets(merged)
        write_report_outputs(
            report=merged,
            output_html=output_html,
            json_path=output_json or coordinator.json_path,
            build_html=coordinator._build_html,
            workspace_dir=workspace_dir,
        )
        return merged
    finally:
        coordinator.close()


def main() -> None:
    parser = argparse.ArgumentParser()
    parser.add_argument("--root-dir", default=r"F:\OCR")
    parser.add_argument("--output-html", default=r"F:\OCR\约字检索报告.html")
    parser.add_argument("--workspace-dir", default=r"F:\OCR\.tmp\work")
    parser.add_argument("--page-limit", type=int, default=None)
    parser.add_argument("--document-limit", type=int, default=None)
    parser.add_argument("--include-path", action="append", default=[])
    parser.add_argument("--parallel-docs", type=int, default=1)
    parser.add_argument("--merge-workers", nargs="*", default=None)
    parser.add_argument("--output-json", default=None)
    parser.add_argument("--start-page-index", type=int, default=None)
    parser.add_argument("--end-page-index-exclusive", type=int, default=None)
    parser.add_argument("--merge-only", action="store_true")
    args = parser.parse_args()

    if args.merge_only:
        report = merge_existing_reports(
            root_dir=Path(args.root_dir),
            workspace_dir=Path(args.workspace_dir),
            output_html=Path(args.output_html),
            output_json=Path(args.output_json) if args.output_json else None,
            worker_names=set(args.merge_workers) if args.merge_workers else None,
        )
        print(json.dumps(report["stats"], ensure_ascii=False, indent=2))
        return

    if args.parallel_docs > 1 and not args.include_path:
        report = run_parallel_documents(args)
        print(json.dumps(report["stats"], ensure_ascii=False, indent=2))
        return

    pipeline = ReportPipeline(
        root_dir=Path(args.root_dir),
        output_html=Path(args.output_html),
        workspace_dir=Path(args.workspace_dir),
        page_limit=args.page_limit,
        document_limit=args.document_limit,
        include_paths={str(Path(p)) for p in args.include_path} if args.include_path else None,
        start_page_index=args.start_page_index,
        end_page_index_exclusive=args.end_page_index_exclusive,
    )
    try:
        report = pipeline.run()
        print(json.dumps(report["stats"], ensure_ascii=False, indent=2))
    finally:
        pipeline.close()


if __name__ == "__main__":
    main()
