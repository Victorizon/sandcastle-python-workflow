"""Contract tests verifying hard enforcement of critical workflow gates in CI and run.ts."""

from __future__ import annotations

from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def test_ci_hard_enforces_check_anti_bloat_and_adversarial_scan() -> None:
    ci_text = (ROOT / ".github" / "workflows" / "ci.yml").read_text(encoding="utf-8")
    assert "scripts/check.py" in ci_text
    assert "--allow-harness-edit" not in ci_text
    assert "scripts/anti_bloat_guard.py --full" in ci_text
    assert "scripts/adversarial_scan.py" in ci_text
    assert "--report-only" not in ci_text


def test_orchestrator_hard_enforces_adversarial_scan_and_pinned_base_sha() -> None:
    run_ts = (ROOT / ".sandcastle" / "run.ts").read_text(encoding="utf-8")
    assert "python scripts/check.py && python scripts/adversarial_scan.py --base main" in run_ts
    assert '"scripts/test_guard.py", "--base", preMergeSha' in run_ts
    assert '"scripts/adversarial_scan.py", "--base", preMergeSha' in run_ts
    assert "--report-only" not in run_ts
