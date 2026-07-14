from __future__ import annotations

import unittest
from pathlib import Path

from archivelens_engine.report_pipeline import DocumentRecord, ReportPipeline


def document(relative_path: str, pages: int = 10) -> DocumentRecord:
    return DocumentRecord(
        document_id="random-id",
        file_path=Path(relative_path),
        relative_path=relative_path,
        file_type="PDF",
        file_size_bytes=1,
        file_hash_sha256="a" * 64,
        modified_time=0,
        page_count=pages,
    )


class SqliteResumePlanTests(unittest.TestCase):
    def pipeline(self, states: dict) -> ReportPipeline:
        pipeline = object.__new__(ReportPipeline)
        pipeline.resume_state_by_source = states
        pipeline.page_limit = None
        pipeline.start_page_index = None
        pipeline.end_page_index_exclusive = None
        return pipeline

    def test_sqlite_processed_pages_override_ahead_local_checkpoint(self) -> None:
        pipeline = self.pipeline({"a.pdf": {"processed_page_ids": [1, 2, 4], "next_page": 3}})
        indexes = pipeline._page_indexes_for_document(
            document("a.pdf"),
            checkpoint={"next_page_index": 9},
        )
        self.assertEqual([index + 1 for index in indexes], [3, 5, 6, 7, 8, 9, 10])

    def test_each_document_uses_its_own_resume_state(self) -> None:
        pipeline = self.pipeline(
            {
                "a.pdf": {"processed_page_ids": [1, 2, 3], "next_page": 4},
                "b.pdf": {"processed_page_ids": list(range(1, 9)), "next_page": 9},
            }
        )
        self.assertEqual([index + 1 for index in pipeline._page_indexes_for_document(document("a.pdf"))], list(range(4, 11)))
        self.assertEqual(pipeline._page_indexes_for_document(document("b.pdf", pages=8)), [])
        self.assertEqual([index + 1 for index in pipeline._page_indexes_for_document(document("c.pdf", pages=3))], [1, 2, 3])

    def test_local_checkpoint_paths_do_not_collide_for_identical_files(self) -> None:
        pipeline = self.pipeline({})
        pipeline.run_dir = Path("run")

        self.assertNotEqual(
            pipeline._checkpoint_path(document("a.pdf")),
            pipeline._checkpoint_path(document("copies/a.pdf")),
        )

    def test_explicit_file_sources_do_not_scan_siblings_and_resume_by_source_id(self) -> None:
        pipeline = object.__new__(ReportPipeline)
        pipeline.source_files = [
            {"file_path": "C:/first/a.pdf", "display_path": "first/a.pdf", "source_id": "source-a"},
            {"file_path": "D:/second/b.pdf", "display_path": "second/b.pdf", "source_id": "source-b"},
        ]
        pipeline.root_dir = Path("C:/ignored-root")
        pipeline._make_document_record = lambda path, **kwargs: (path, kwargs)  # type: ignore[method-assign]
        documents = pipeline._scan_documents()
        self.assertEqual([item[0] for item in documents], [Path("C:/first/a.pdf"), Path("D:/second/b.pdf")])
        self.assertEqual([item[1]["source_id"] for item in documents], ["source-a", "source-b"])
        resumed = document("visible-a.pdf")
        resumed.source_id = "source-a"
        state_pipeline = self.pipeline({"source-a": {"processed_page_ids": [1, 2]}})
        self.assertEqual([index + 1 for index in state_pipeline._page_indexes_for_document(resumed)], list(range(3, 11)))


if __name__ == "__main__":
    unittest.main()
