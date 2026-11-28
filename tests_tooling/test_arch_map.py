"""Unit tests for the full-repo wiring mapper & impact reminder (`scripts/arch_map.py`)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ARCH_MAP = ROOT / "scripts" / "arch_map.py"


def _run_arch_map(*args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(ARCH_MAP), *args],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def test_arch_map_check_passes_and_includes_cross_language_wiring() -> None:
    res = _run_arch_map("--check")
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Architecture Map PASS" in res.stdout

    map_text = (ROOT / "docs" / "ARCHITECTURE_MAP.md").read_text(encoding="utf-8")
    assert "```mermaid" in map_text
    assert "ci.yml" in map_text
    assert "scripts/check.py" in map_text
    assert ".sandcastle/run.ts" in map_text


def test_arch_map_impact_flags_cross_language_callers() -> None:
    res = _run_arch_map("--impact", "--json", "--files", "scripts/check.py")
    assert res.returncode == 0, res.stdout + res.stderr
    data = json.loads(res.stdout)
    assert len(data["suggestions"]) == 1
    callers = data["suggestions"][0]["check_callers"]
    assert ".github/workflows/ci.yml" in callers
    assert ".sandcastle/slice-runner.ts" in callers
    assert ".sandcastle/merge-gate.ts" in callers
    assert ".pre-commit-config.yaml" in callers
