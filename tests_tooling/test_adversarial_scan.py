"""Unit tests for the deterministic Adversarial Scan Runner (`scripts/adversarial_scan.py`)."""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
SCAN = ROOT / "scripts" / "adversarial_scan.py"


def test_adversarial_scan_passes_on_real_repo() -> None:
    res = subprocess.run(
        [sys.executable, str(SCAN), "--root", str(ROOT), "--base", "main"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Deterministic Adversarial Scan" in res.stdout
    assert "[PASS] diff-cover:" in res.stdout
