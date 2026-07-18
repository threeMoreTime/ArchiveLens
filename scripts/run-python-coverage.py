from __future__ import annotations

import json
import os
from pathlib import Path
import subprocess
import sys
from typing import Any


REPO_ROOT = Path(__file__).resolve().parents[1]
COVERAGE_ROOT = REPO_ROOT / "coverage" / "python"
COVERAGE_JSON = COVERAGE_ROOT / "coverage.json"
BUDGET_RESULT = COVERAGE_ROOT / "budget-summary.json"


def run_coverage() -> None:
    COVERAGE_ROOT.mkdir(parents=True, exist_ok=True)
    environment = os.environ.copy()
    environment["PYTHONPATH"] = os.pathsep.join(
        [str(REPO_ROOT / "engine" / "src"), str(REPO_ROOT / "engine")]
    )
    environment["COVERAGE_FILE"] = str(COVERAGE_ROOT / ".coverage")
    commands = [
        [sys.executable, "-m", "coverage", "erase"],
        [
            sys.executable,
            "-m",
            "coverage",
            "run",
            "--branch",
            "--source=archivelens_engine",
            "-m",
            "unittest",
            "discover",
            "-s",
            "engine/tests",
            "-t",
            "engine",
            "-v",
        ],
        [sys.executable, "-m", "coverage", "json", "-o", str(COVERAGE_JSON)],
        [sys.executable, "-m", "coverage", "report"],
    ]
    for command in commands:
        subprocess.run(command, cwd=REPO_ROOT, env=environment, check=True)


def normalized(value: str) -> str:
    return value.replace("\\", "/").lower()


def percentage(summary: dict[str, Any], metric: str) -> float:
    key = "percent_covered" if metric == "lines" else "percent_branches_covered"
    value = summary.get(key)
    if not isinstance(value, (int, float)):
        raise ValueError(f"missing {metric} coverage value")
    return float(value)


def check_budgets() -> None:
    coverage = json.loads(COVERAGE_JSON.read_text(encoding="utf-8"))
    budgets = json.loads(
        (REPO_ROOT / "scripts" / "quality-budgets.json").read_text(encoding="utf-8")
    )["pythonCoverage"]
    failures: list[str] = []

    def check(label: str, summary: dict[str, Any], expected: dict[str, float]) -> None:
        for metric, floor in expected.items():
            try:
                actual = percentage(summary, metric)
            except ValueError as error:
                failures.append(f"{label}: {error}")
                continue
            if actual < floor:
                failures.append(f"{label}: {metric} {actual:.2f}% < {floor}%")

    check("python total", coverage["totals"], budgets["total"])
    files = coverage["files"]
    for relative_path, expected in budgets["files"].items():
        suffix = normalized(relative_path)
        entry = next(
            (value for path, value in files.items() if normalized(path).endswith(suffix)),
            None,
        )
        if entry is None:
            failures.append(f"{relative_path}: coverage entry is missing")
        else:
            check(relative_path, entry["summary"], expected)

    result = {
        "schema_version": 1,
        "status": "PASS" if not failures else "FAIL",
        "source": "coverage/python/coverage.json",
        "measured_total": coverage["totals"],
        "budgets": budgets,
        "failures": failures,
    }
    BUDGET_RESULT.write_text(
        json.dumps(result, ensure_ascii=False, indent=2) + "\n", encoding="utf-8"
    )
    print(json.dumps(result, ensure_ascii=False, indent=2))
    if failures:
        raise SystemExit(1)


if __name__ == "__main__":
    if "--check-only" not in sys.argv[1:]:
        run_coverage()
    check_budgets()
