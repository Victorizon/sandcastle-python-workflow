"""Synthetic 100+ slice scale stress tests for `local_tracker.py` and Planner payload bounds."""

from __future__ import annotations

import json
import subprocess
import sys
import time
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
TRACKER = ROOT / "scripts" / "local_tracker.py"


def _seed_120_ticket_dag(repo: Path) -> None:
    issues_dir = repo / ".scratch" / "big-refactor" / "issues"
    issues_dir.mkdir(parents=True)
    long_notes = "Acceptance criteria details and edge cases. " * 25
    for idx in range(1, 121):
        # Tickets 1..20 are unblocked; 21..120 depend on an earlier ticket (acyclic 120-node DAG)
        blocker = "None" if idx <= 20 else f"{idx - 20:02d}"
        body = (
            f"# Slice {idx:03d}: Refactor module {idx}\n\n"
            "**Status:** ready-for-agent\n"
            f"**Blocked by:** {blocker}\n"
            "**Split depth:** 0\n\n"
            f"## Notes\n{long_notes}\n"
        )
        # Deliberately use 2-digit names for 1..99 and 3-digit names for 100..120
        (issues_dir / f"{idx:02d}-slice-{idx}.md").write_text(body, encoding="utf-8")


def _run_tracker(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(TRACKER), "--root", str(repo), *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def test_120_slices_numeric_ordering_cycle_speed_and_bounded_planner_payload(
    tmp_path: Path,
) -> None:
    _seed_120_ticket_dag(tmp_path)

    # 1. Cycle check across 120 interconnected tickets stays fast (< 2s) and passes
    t0 = time.monotonic()
    cyc = _run_tracker(tmp_path, "check-cycles")
    elapsed = time.monotonic() - t0
    assert cyc.returncode == 0, cyc.stderr
    assert elapsed < 2.0, f"check-cycles took too long on 120 tickets: {elapsed:.2f}s"

    # 2. Full list is sorted numerically (ticket 20 before 99 before 100, NOT lexical 100 before 20)
    full = _run_tracker(tmp_path, "list", "--status", "ready-for-agent", "--json")
    assert full.returncode == 0, full.stderr
    full_items = json.loads(full.stdout)
    assert len(full_items) == 120
    assert [item["number"] for item in full_items] == list(range(1, 121))
    assert "body" in full_items[0]

    # 3. Planner summary payload stays tiny (< 8 KB) and strictly unblocked + bounded to 15 slices
    planner = _run_tracker(
        tmp_path,
        "list",
        "--status",
        "ready-for-agent",
        "--unblocked-only",
        "--summary-only",
        "--limit",
        "15",
        "--json",
    )
    assert planner.returncode == 0, planner.stderr
    planner_items = json.loads(planner.stdout)
    assert len(planner_items) == 15
    assert [item["number"] for item in planner_items] == list(range(1, 16))
    assert all("body" not in item for item in planner_items)
    assert all(item["open_blockers"] == [] for item in planner_items)
    assert len(planner.stdout.encode("utf-8")) < 8_192
    assert len(planner.stdout) * 10 < len(full.stdout)
