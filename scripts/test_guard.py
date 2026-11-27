"""Strict test-integrity & coverage-floor lock (`scripts/test_guard.py`).

Mechanically blocks AI agents from cheating tests:
1. Anti-tampering (vs --base ref, default main):
   - No deleting existing test files under tests/ or fixture JSONs under tests/fixtures/
   - No modifying existing historical fixture JSONs under tests/fixtures/
   - No deleting/renaming existing `def test_*` functions
   - No reducing assertion counts on existing `def test_*` functions
2. Anti-weakening (always enforced on all tests/):
   - Bans `pytest.mark.skip`, `pytest.mark.xfail`, `pytest.skip(...)`, `assert True`,
     `assert x == x`, and tests with 0 `assert` statements (or `pytest.raises`).
3. Monotonic coverage floor (reads coverage JSON vs `scripts/coverage-baseline.json`):
   - Total `src/` line coverage may NEVER drop below baseline (0.1% cross-platform tolerance).
"""

from __future__ import annotations

import argparse
import ast
import json
import subprocess
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COVERAGE_BASELINE_PATH = ROOT / "scripts" / "coverage-baseline.json"
COVERAGE_TOLERANCE = 0.1


@dataclass(frozen=True)
class TestFunctionStats:
    name: str
    assert_count: int
    has_skip_or_xfail: bool
    has_trivial_assert: bool


def _is_trivial_assert(node: ast.Assert) -> bool:
    test = node.test
    if isinstance(test, ast.Constant) and test.value is True:
        return True
    return (
        isinstance(test, ast.Compare)
        and len(test.ops) == 1
        and isinstance(test.ops[0], ast.Eq)
        and len(test.comparators) == 1
        and ast.dump(test.left) == ast.dump(test.comparators[0])
    )


def _has_skip_decorator(fn: ast.FunctionDef | ast.AsyncFunctionDef) -> bool:
    for dec in fn.decorator_list:
        dumped = ast.unparse(dec)
        if "skip" in dumped or "xfail" in dumped:
            return True
    return False


def _analyze_test_source(source: str) -> dict[str, TestFunctionStats]:
    tree = ast.parse(source)
    stats: dict[str, TestFunctionStats] = {}
    for node in ast.walk(tree):
        if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef)):
            continue
        if not node.name.startswith("test_"):
            continue
        asserts = 0
        has_trivial = False
        has_skip = _has_skip_decorator(node)
        for child in ast.walk(node):
            if isinstance(child, ast.Assert):
                asserts += 1
                if _is_trivial_assert(child):
                    has_trivial = True
            elif isinstance(child, ast.Call):
                call_text = ast.unparse(child.func)
                if call_text.endswith("pytest.raises"):
                    asserts += 1
                if call_text.endswith(("pytest.skip", "pytest.xfail")):
                    has_skip = True
        stats[node.name] = TestFunctionStats(
            name=node.name,
            assert_count=asserts,
            has_skip_or_xfail=has_skip,
            has_trivial_assert=has_trivial,
        )
    return stats


def _git_ref_exists(root: Path, ref: str) -> bool:
    proc = subprocess.run(
        ["git", "rev-parse", "--verify", "--quiet", ref],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode == 0


def _git_list_files(root: Path, ref: str, prefix: str) -> list[str]:
    proc = subprocess.run(
        ["git", "ls-tree", "-r", "--name-only", ref, prefix],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def _git_show_file(root: Path, ref: str, rel_path: str) -> str | None:
    proc = subprocess.run(
        ["git", "show", f"{ref}:{rel_path}"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.stdout if proc.returncode == 0 else None


def check_static_test_quality(root: Path = ROOT) -> list[str]:
    issues: list[str] = []
    tests_dir = root / "tests"
    if not tests_dir.exists():
        return ["Missing tests/ directory."]
    for py_file in sorted(tests_dir.rglob("test_*.py")):
        rel = py_file.relative_to(root).as_posix()
        stats = _analyze_test_source(py_file.read_text(encoding="utf-8"))
        if not stats:
            issues.append(f"{rel}: contains zero `test_*` functions.")
            continue
        for fn in stats.values():
            if fn.has_skip_or_xfail:
                issues.append(f"{rel}::{fn.name}: skip/xfail is banned.")
            if fn.has_trivial_assert:
                issues.append(f"{rel}::{fn.name}: tautological/trivial assertion detected.")
            if fn.assert_count == 0:
                issues.append(f"{rel}::{fn.name}: test has zero assertions.")
    return issues


def check_anti_tampering(base_ref: str, root: Path = ROOT) -> list[str]:
    if not _git_ref_exists(root, base_ref):
        return []
    issues: list[str] = []

    for rel in _git_list_files(root, base_ref, "tests/fixtures"):
        if not rel.endswith(".json"):
            continue
        current_path = root / rel
        if not current_path.exists():
            issues.append(f"{rel}: deleted existing replay fixture (blocked; human approval only).")
            continue
        base_content = _git_show_file(root, base_ref, rel)
        current_content = current_path.read_text(encoding="utf-8")
        if base_content is not None and base_content.strip() != current_content.strip():
            issues.append(
                f"{rel}: modified existing replay fixture (add a new fixture instead of editing)."
            )

    for rel in _git_list_files(root, base_ref, "tests"):
        if not Path(rel).name.startswith("test_") or not rel.endswith(".py"):
            continue
        current_path = root / rel
        if not current_path.exists():
            issues.append(f"{rel}: deleted existing test file (blocked; human approval only).")
            continue
        base_src = _git_show_file(root, base_ref, rel)
        if base_src is None:
            continue
        base_stats = _analyze_test_source(base_src)
        curr_stats = _analyze_test_source(current_path.read_text(encoding="utf-8"))
        for fn_name, base_fn in base_stats.items():
            if fn_name not in curr_stats:
                issues.append(f"{rel}::{fn_name}: existing test was deleted or renamed.")
            elif curr_stats[fn_name].assert_count < base_fn.assert_count:
                issues.append(
                    f"{rel}::{fn_name}: assertion count dropped "
                    f"({base_fn.assert_count} -> {curr_stats[fn_name].assert_count})."
                )
    return issues


def check_coverage_floor(coverage_json: Path, shrink: bool, root: Path = ROOT) -> list[str]:
    baseline_path = root / "scripts" / "coverage-baseline.json"
    if not coverage_json.exists():
        return [f"Missing coverage report at {coverage_json}."]
    data = json.loads(coverage_json.read_text(encoding="utf-8"))
    percent = round(float(data["totals"]["percent_covered"]), 2)

    if not baseline_path.exists():
        baseline_path.write_text(
            json.dumps({"min_percent": percent}, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Initialized coverage floor at {percent:.2f}%.")
        return []

    baseline = json.loads(baseline_path.read_text(encoding="utf-8"))
    floor = float(baseline["min_percent"])

    if shrink and percent > floor:
        baseline_path.write_text(
            json.dumps({"min_percent": percent}, indent=2) + "\n", encoding="utf-8"
        )
        print(f"Raised coverage floor: {floor:.2f}% -> {percent:.2f}%.")
        return []

    if percent + COVERAGE_TOLERANCE < floor:
        return [
            f"Coverage dropped below monotonic floor: {percent:.2f}% < {floor:.2f}% "
            "(add tests; never lower scripts/coverage-baseline.json)."
        ]
    print(f"Coverage floor PASS: {percent:.2f}% >= {floor:.2f}%.")
    return []


def main() -> int:
    parser = argparse.ArgumentParser(description="Strict test-integrity and coverage lock")
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root directory (default: current repo)",
    )
    parser.add_argument(
        "--base",
        default="main",
        help="Git base ref for anti-tampering diff (default: main)",
    )
    parser.add_argument(
        "--coverage-json",
        type=Path,
        default=None,
        help="Path to pytest-cov JSON report to enforce monotonic coverage floor",
    )
    parser.add_argument(
        "--shrink-coverage",
        action="store_true",
        help="Ratchet scripts/coverage-baseline.json upward if coverage improved",
    )
    args = parser.parse_args()

    issues = [
        *check_static_test_quality(args.root),
        *check_anti_tampering(args.base, args.root),
    ]
    if args.coverage_json is not None:
        issues.extend(check_coverage_floor(args.coverage_json, args.shrink_coverage, args.root))

    if issues:
        print("Test Guard FAILED — suspected test weakening, tampering, or coverage drop:")
        for item in issues:
            print(f"  - {item}")
        return 1

    print("Test Guard PASS: zero test tampering, zero weak assertions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
