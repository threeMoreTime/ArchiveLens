"""构建元数据加载。"""

from __future__ import annotations

import json
import os
import sys
from pathlib import Path
from typing import Any


def _candidate_paths() -> list[Path]:
    paths: list[Path] = []
    env_path = os.environ.get("AL_APP_INFO_PATH")
    if env_path:
        paths.append(Path(env_path))
    paths.append(Path(sys.executable).with_name("app.info.json"))
    return paths


def load_build_info() -> dict[str, Any] | None:
    for path in _candidate_paths():
        try:
            if path.exists():
                payload = json.loads(path.read_text(encoding="utf-8"))
                if isinstance(payload, dict):
                    return payload
        except (OSError, json.JSONDecodeError):
            continue
    return None


__all__ = ["load_build_info"]
