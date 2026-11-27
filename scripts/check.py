"""Single deterministic verification entry point (`python scripts/check.py`).

Runs all Brake 1 gates in order:
1. ruff format --check
2. python scripts/ratchet.py --check (ruff + pyright + disable-comments + SDK boundary + secrets)
3. lint-imports (import-linter deep module architecture contract)
4. pytest with line coverage (`--cov=src --cov-report=json:.coverage.json`)
5. python scripts/test_guard.py --coverage-json .coverage.json (anti-tampering + coverage floor)
6. python scripts/mutation_check.py (AST mutation testing)
"""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COVERAGE_JSON = ROOT / ".coverage.json"


def _resolve_tool(name: str) -> str:
    candidate = Path(sys.executable).parent / name
    if candidate.exists():
        return str(candidate)
    if sys.platform == "win32":
        exe_candidate = Path(sys.executable).parent / f"{name}.exe"
        if exe_candidate.exists():
            return str(exe_candidate)
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(f"Required tool `{name}` not found in venv or PATH.")
    return found


def _run_step(label: str, cmd: list[str]) -> bool:
    print(f"\n==> {label}: {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=ROOT, check=False)
    if proc.returncode != 0:
        print(f"[FAIL] {label} (exit {proc.returncode})")
        return False
    print(f"[PASS] {label}")
    return True


def main() -> int:
    steps: list[tuple[str, list[str]]] = [
        (
            "Format check",
            [
                _resolve_tool("ruff"),
                "format",
                "--check",
                "src",
                "tests",
                "tests_tooling",
                "scripts",
            ],
        ),
        ("Monotonic ratchet", [sys.executable, "scripts/ratchet.py", "--check"]),
        ("Import boundaries", [_resolve_tool("lint-imports")]),
        (
            "Replay test suite + coverage",
            [
                _resolve_tool("pytest"),
                "--cov=src",
                f"--cov-report=json:{COVERAGE_JSON.name}",
            ],
        ),
        (
            "Strict test guard + coverage floor",
            [
                sys.executable,
                "scripts/test_guard.py",
                "--base",
                "main",
                "--coverage-json",
                COVERAGE_JSON.name,
            ],
        ),
        ("AST mutation check", [sys.executable, "scripts/mutation_check.py"]),
    ]

    try:
        for label, cmd in steps:
            if not _run_step(label, cmd):
                return 1
    finally:
        COVERAGE_JSON.unlink(missing_ok=True)

    print("\nALL CHECKS PASSED.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
