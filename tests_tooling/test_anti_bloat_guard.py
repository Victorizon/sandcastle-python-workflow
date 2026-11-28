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


def test_legacy_6000_line_script_baseline_only_blocks_outgoing_bloat(tmp_path: Path) -> None:
    """Day-1 legacy 6,000-line script + pre-existing dead code passes after --init;
    only outgoing growth, oversized new files, or newly introduced dead code fail.
    """
    repo = tmp_path / "legacy_repo"
    (repo / "src").mkdir(parents=True)
    legacy = repo / "src" / "identity_security.py"

    # Simulate a 6,000-line pre-existing script with pre-existing unreachable dead code
    header = [
        "def legacy_helper() -> int:",
        "    return 1",
        "    preexisting_dead = 2",
        "    return preexisting_dead",
        "",
    ]
    body = [f"RULE_{i} = {i}" for i in range(6000 - len(header))]
    legacy.write_text("\n".join(header + body) + "\n", encoding="utf-8")

    # 1. Day-1 onboarding: --init snapshots existing file size and dead-code count
    init_res = _run_guard(repo, ["--init"])
    assert init_res.returncode == 0, init_res.stdout + init_res.stderr
    baseline = json.loads((repo / "scripts" / "bloat-baseline.json").read_text(encoding="utf-8"))
    assert baseline["file_line_caps"]["src/identity_security.py"] == 6000
    assert baseline["vulture_findings"] >= 1

    # Day-1 full check passes immediately
    day1_res = _run_guard(repo, ["--full"])
    assert day1_res.returncode == 0, day1_res.stdout + day1_res.stderr

    # 2. Growing the 6,000-line legacy script by 1 line is BLOCKED
    legacy.write_text(legacy.read_text(encoding="utf-8") + "EXTRA_LINE = 1\n", encoding="utf-8")
    grow_res = _run_guard(repo, ["--json"])
    assert grow_res.returncode == 1
    grow_findings = json.loads(grow_res.stdout)
    assert any(
        f["category"] == "oversized-file" and f["file"] == "src/identity_security.py"
        for f in grow_findings
    )

    # 3. Shrinking the legacy script + extracting a clean 120-line module PASSES
    legacy.write_text("\n".join(header + body[:-200]) + "\n", encoding="utf-8")
    extracted = repo / "src" / "alert_fork.py"
    extracted.write_text(
        "\n".join(f"ALERT_CONST_{i} = {i}" for i in range(120)) + "\n", encoding="utf-8"
    )
    refactor_res = _run_guard(repo, ["--full"])
    assert refactor_res.returncode == 0, refactor_res.stdout + refactor_res.stderr

    # 4. Creating a brand-new 500-line monolith file is BLOCKED (> 450 cap)
    monolith = repo / "src" / "new_monolith.py"
    monolith.write_text("\n".join(f"NEW_{i} = {i}" for i in range(500)) + "\n", encoding="utf-8")
    mono_res = _run_guard(repo, ["--json"])
    assert mono_res.returncode == 1
    mono_findings = json.loads(mono_res.stdout)
    assert any(
        f["category"] == "oversized-file" and f["file"] == "src/new_monolith.py"
        for f in mono_findings
    )
    monolith.unlink()

    # 5. Introducing NEW dead code beyond baseline is BLOCKED
    extracted.write_text(
        "def new_fn() -> int:\n    return 1\n    brand_new_dead = 99\n    return brand_new_dead\n",
        encoding="utf-8",
    )
    dead_res = _run_guard(repo, ["--full", "--json"])
    assert dead_res.returncode == 1
    dead_findings = json.loads(dead_res.stdout)
    assert any(f["category"] == "vulture-dead-code" for f in dead_findings)
