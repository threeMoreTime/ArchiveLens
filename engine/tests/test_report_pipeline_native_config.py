from __future__ import annotations

import os
from pathlib import Path
from unittest.mock import patch

import pytesseract
from PIL import Image

from archivelens_engine.config import EngineConfig
from archivelens_engine.report_pipeline import ReportPipeline


def test_secondary_verify_scopes_native_paths_to_task_config(tmp_path: Path) -> None:
    tesseract = tmp_path / "native" / "tesseract.exe"
    tessdata = tmp_path / "native" / "tessdata"
    tesseract.parent.mkdir(parents=True)
    tessdata.mkdir()
    tesseract.write_bytes(b"test")
    (tessdata / "chi_sim.traineddata").write_bytes(b"test")
    config = EngineConfig(tesseract_cmd=tesseract, tessdata_dir=tessdata)
    pipeline = ReportPipeline.__new__(ReportPipeline)
    pipeline.config = config
    original_cmd = pytesseract.pytesseract.tesseract_cmd
    original_prefix = os.environ.get("TESSDATA_PREFIX")
    pytesseract.pytesseract.tesseract_cmd = "previous-tesseract"
    os.environ["TESSDATA_PREFIX"] = "previous-tessdata"
    captured: dict[str, str] = {}

    def fake_image_to_data(*_args: object, **_kwargs: object) -> dict[str, list[object]]:
        captured["cmd"] = pytesseract.pytesseract.tesseract_cmd
        captured["tessdata"] = os.environ["TESSDATA_PREFIX"]
        return {"text": ["约"], "conf": ["96.5"]}

    try:
        with patch("archivelens_engine.report_pipeline.pytesseract.image_to_data", side_effect=fake_image_to_data):
            text, confidence = pipeline._secondary_verify(Image.new("RGB", (20, 20), "white"), "约")
        assert pytesseract.pytesseract.tesseract_cmd == "previous-tesseract"
        assert os.environ.get("TESSDATA_PREFIX") == "previous-tessdata"
    finally:
        pytesseract.pytesseract.tesseract_cmd = original_cmd
        if original_prefix is None:
            os.environ.pop("TESSDATA_PREFIX", None)
        else:
            os.environ["TESSDATA_PREFIX"] = original_prefix

    assert text == "约"
    assert confidence == 0.965
    assert captured == {"cmd": str(tesseract), "tessdata": str(tessdata)}
