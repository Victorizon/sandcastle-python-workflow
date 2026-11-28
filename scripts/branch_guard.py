"""Local pre-commit branch guard (`scripts/branch_guard.py`).

Blocks direct commits that modify `src/` while checked out on `main` or `master`,
unless a git merge is in progress (`.git/MERGE_HEAD` exists).

Allows committing specs/tickets in `.scratch/` or docs on `main` so planning
stays frictionless while production code changes always go through branches + checks.
"""

from __future__ import annotations

import argparse
import subprocess
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
PROTECTED_BRANCHES = frozenset({"main", "master"})


def _current_branch(root: Path) -> str:
    proc = subprocess.run(
        ["git", "symbolic-ref", "--short", "HEAD"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.stdout.strip() if proc.returncode == 0 else ""


def _git_dir(root: Path) -> Path:
    proc = subprocess.run(
        ["git", "rev-parse", "--git-dir"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    raw = proc.stdout.strip() if proc.returncode == 0 else ".git"
    p = Path(raw)
    return p if p.is_absolute() else (root / p)


def _staged_files(root: Path) -> list[str]:
    proc = subprocess.run(
        ["git", "diff", "--cached", "--name-only"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def check_branch_guard(root: Path = ROOT) -> tuple[bool, str]:
    branch = _current_branch(root)
    if branch not in PROTECTED_BRANCHES:
        return True, f"Branch Guard PASS: on branch `{branch or 'detached'}`."

    if (_git_dir(root) / "MERGE_HEAD").exists():
        return True, f"Branch Guard PASS: merge commit in progress on `{branch}`."

    staged = _staged_files(root)
    blocked = [f for f in staged if f.startswith("src/")]
    if blocked:
        files_list = ", ".join(blocked)
        return (
            False,
            f"Branch Guard FAILED: direct commits modifying `src/` on `{branch}` are blocked "
            f"({files_list}). Create a ticket and work on a feature/Sandcastle branch instead.",
        )

    return True, f"Branch Guard PASS: no direct `src/` changes staged on `{branch}`."


def main() -> int:
    parser = argparse.ArgumentParser(description="Block direct src/ commits on main")
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root directory (default: current repo)",
    )
    args = parser.parse_args()
    passed, message = check_branch_guard(args.root)
    print(message)
    return 0 if passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
