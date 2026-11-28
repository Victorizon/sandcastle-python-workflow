"""Unit tests for the hybrid Anti-Bloat Guard (`scripts/anti_bloat_guard.py`)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUARD = ROOT / "scripts" / "anti_bloat_guard.py"


def _run_guard(repo: Path, extra_args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(GUARD), "--root", str(repo)]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=False)


def test_anti_bloat_guard_full_passes_on_real_repo() -> None:
    res = _run_guard(ROOT, ["--full"])
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Anti-Bloat Guard PASS" in res.stdout


def test_anti_bloat_guard_flags_oversized_files(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    big_file = repo / "scripts" / "bloated.py"
    big_file.write_text("\n".join(f"VAL_{i} = {i}" for i in range(60)) + "\n", encoding="utf-8")

    res = _run_guard(repo, ["--max-lines", "40", "--json"])
    assert res.returncode == 1
    findings = json.loads(res.stdout)
    assert any(
        f["category"] == "oversized-file" and f["file"] == "scripts/bloated.py" for f in findings
    )


def test_anti_bloat_guard_vulture_flags_dead_python_code(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts" / "dead_sample.py").write_text(
        "import os\n\n"
        "def sample() -> int:\n"
        "    return 1\n"
        "    unreachable = 2\n"
        "    return unreachable\n",
        encoding="utf-8",
    )

    res = _run_guard(repo, ["--full", "--json"])
    assert res.returncode == 1
    findings = json.loads(res.stdout)
    assert any(f["category"] == "vulture-dead-code" for f in findings)
