"""诊断 dev ReportPipeline 扫 1 fixture（主线程 RapidOCR run）。"""
import shutil
import tempfile
from pathlib import Path

from archivelens_engine.report_pipeline import ReportPipeline

ROOT = Path(__file__).resolve().parents[1]
FIXTURE = ROOT / "tests" / "fixtures" / "ocr" / "simplified-horizontal.pdf"

src = Path(tempfile.mkdtemp())
shutil.copy(FIXTURE, src)
ws = Path(tempfile.mkdtemp())
p = ReportPipeline(root_dir=src, output_html=ws / "o.html", workspace_dir=ws)
report = p.run()
print("documents:", len(report.get("documents", [])))
print("occurrences:", len(report.get("occurrences", [])))
print("chars:", [o.get("matched_character") for o in report.get("occurrences", [])])
print("failures:", len(report.get("failures", [])))
for f in report.get("failures", [])[:3]:
    print("failure:", f.get("error_type"), f.get("error_message"))
p.close()
