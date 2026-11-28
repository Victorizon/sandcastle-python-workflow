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

import argparse
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
    parser = argparse.ArgumentParser(description="Run all 6 deterministic Python quality gates")
    parser.add_argument(
        "--allow-harness-edit",
        action="store_true",
        help="Forward --allow-harness-edit to test_guard.py for intentional human harness updates",
    )
    args = parser.parse_args()

    has_src = (ROOT / "src").is_dir()
    format_dirs = [d for d in ("src", "tests", "tests_tooling", "scripts") if (ROOT / d).is_dir()]

    test_guard_cmd = [sys.executable, "scripts/test_guard.py", "--base", "main"]
    if has_src:
        test_guard_cmd.extend(["--coverage-json", COVERAGE_JSON.name])
    if args.allow_harness_edit:
        test_guard_cmd.append("--allow-harness-edit")

    steps: list[tuple[str, list[str]]] = []
    if format_dirs:
        steps.append(("Format check", [_resolve_tool("ruff"), "format", "--check", *format_dirs]))
    steps.append(("Monotonic ratchet", [sys.executable, "scripts/ratchet.py", "--check"]))
    if has_src:
        steps.append(("Import boundaries", [_resolve_tool("lint-imports")]))
        steps.append(
            (
                "Replay test suite + coverage",
                [
                    _resolve_tool("pytest"),
                    "--cov=src",
                    f"--cov-report=json:{COVERAGE_JSON.name}",
                ],
            )
        )
    else:
        print("[SKIP] Import boundaries & coverage/mutation gates (no `src/` package directory)")
        if (ROOT / "tests").is_dir():
            steps.append(("Test suite", [_resolve_tool("pytest")]))
    steps.append(("Strict test guard + coverage floor", test_guard_cmd))
    if has_src:
        steps.append(
            (
                "AST mutation check",
                [sys.executable, "scripts/mutation_check.py", "--base", "main"],
            )
        )

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
