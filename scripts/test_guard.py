"""Strict test-integrity, harness-lock, and coverage-floor verifier (`scripts/test_guard.py`).

Mechanically blocks AI agents from cheating tests or tampering with referees:
1. Harness Lock (vs --base ref, default main):
   - Blocks agents from modifying `scripts/check.py`, `scripts/test_guard.py`,
     `scripts/ratchet.py`, `scripts/mutation_check.py`, baseline JSONs, `pyproject.toml`,
     `tests/conftest.py`, or `tests/fakes/fake_external_client.py` unless `--allow-harness-edit`.
   - Also blocks adding, changing or deleting ANY pytest config/hook file anywhere in the repo
     (`conftest.py`, `pytest.ini`, `tox.ini`, `setup.cfg`, `sitecustomize.py`, `usercustomize.py`):
     each can deselect tests or monkeypatch production code while tests run.
2. Anti-tampering (vs --base ref; prefers `origin/<base>` so moving a local branch cannot reset it):
   - No deleting existing test files (`test_*.py` / `*_test.py`) or fixture JSONs
   - No modifying existing historical fixture JSONs under `tests/fixtures/`
   - No deleting/renaming existing `def test_*` functions
   - No reducing assertion counts on existing `def test_*` functions
   - No rewriting existing assertions (`x is REJECT` -> `x in (REJECT, APPROVE)`); adding is fine
3. Anti-weakening (always enforced on all `tests/`):
   - Bans `pytest.mark.skip`, `pytest.mark.xfail`, `pytest.skip(...)` (also as module- or
     class-level `pytestmark` / class decorators), `assert True`,
     `assert not False`, truthy-literal asserts, constant comparisons (`assert 1 != 2`),
     `assert x == x`, swallowed assertions (`try: assert ... except ...`,
     `with suppress(AssertionError): assert ...`, `with pytest.raises(AssertionError): assert ...`),
     dead assertions (`if False:` / `if not True:` branches, or after a `return`/`raise`),
     and tests with 0 `assert` statements.
4. Monotonic coverage floor (reads coverage JSON vs `scripts/coverage-baseline.json` AND base ref):
   - Total `src/` line coverage may NEVER drop below baseline (0.1% cross-platform tolerance),
     and `scripts/coverage-baseline.json` may NEVER be lowered vs `--base`.
"""

from __future__ import annotations

import argparse
import json
import subprocess
from pathlib import Path

from test_quality_ast import TestFunctionStats, analyze_test_source, module_level_skip_issues

ROOT = Path(__file__).resolve().parent.parent
COVERAGE_BASELINE_PATH = ROOT / "scripts" / "coverage-baseline.json"
COVERAGE_TOLERANCE = 0.1

HARNESS_LOCKED_FILES: tuple[str, ...] = (
    "scripts/check.py",
    "scripts/test_guard.py",
    "scripts/ratchet.py",
    "scripts/mutation_check.py",
    "scripts/adversarial_scan.py",
    "scripts/anti_bloat_guard.py",
    "scripts/coverage-baseline.json",
    "scripts/ratchet-baseline.json",
    ".sandcastle/adversarial-rules.yml",
    ".sandcastle/knip.json",
    "pyproject.toml",
    "tests/conftest.py",
    "tests/fakes/fake_external_client.py",
    "scripts/venv_run.py",
    "scripts/test_quality_ast.py",
)

# Files pytest (or Python itself) auto-loads from anywhere in the tree. Any of them can deselect
# tests or monkeypatch production code during the test run, so they are locked repo-wide.
PYTEST_HOOK_FILENAMES: frozenset[str] = frozenset(
    {"conftest.py", "pytest.ini", "tox.ini", "setup.cfg", "sitecustomize.py", "usercustomize.py"}
)


def _is_test_filename(name: str) -> bool:
    return name.endswith(".py") and (name.startswith("test_") or name.endswith("_test.py"))


def _iter_test_files(tests_dir: Path) -> list[Path]:
    return sorted(p for p in tests_dir.rglob("*.py") if _is_test_filename(p.name))


def _git_ref_exists(root: Path, ref: str) -> bool:
    proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "rev-parse", "--verify", "--quiet", ref],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.returncode == 0


def _resolve_base_ref(root: Path, base_ref: str) -> str | None:
    # Prefer the remote-tracking ref: an agent with git access can move a local branch
    # (`git branch -f main HEAD`) to make its own cheat the baseline it is compared against.
    remote_candidate = f"origin/{base_ref}"
    if _git_ref_exists(root, remote_candidate):
        return remote_candidate
    if _git_ref_exists(root, base_ref):
        return base_ref
    return None


def _git_current_files(root: Path) -> list[str]:
    """Tracked + untracked (non-ignored) files in the working tree."""
    proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "ls-files", "--cached", "--others", "--exclude-standard"],
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


def _git_list_files(root: Path, ref: str, prefix: str) -> list[str]:
    proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "ls-tree", "-r", "--name-only", ref, prefix],
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


def _git_show_file(root: Path, ref: str, rel_path: str) -> str | None:
    proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "show", f"{ref}:{rel_path}"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    return proc.stdout if proc.returncode == 0 else None


def check_static_test_quality(root: Path = ROOT) -> list[str]:
    issues: list[str] = []
    tests_dir = root / "tests"
    if not tests_dir.exists():
        return ["Missing tests/ directory."]
    for py_file in _iter_test_files(tests_dir):
        rel = py_file.relative_to(root).as_posix()
        source = py_file.read_text(encoding="utf-8")
        issues.extend(f"{rel}: {issue}" for issue in module_level_skip_issues(source))
        stats = analyze_test_source(source)
        if not stats:
            issues.append(f"{rel}: contains zero `test_*` functions.")
            continue
        for fn in stats.values():
            if fn.has_skip_or_xfail:
                issues.append(f"{rel}::{fn.name}: skip/xfail is banned.")
            if fn.has_trivial_assert:
                issues.append(f"{rel}::{fn.name}: tautological/trivial assertion detected.")
            if fn.has_swallowed_or_dead_assert:
                issues.append(
                    f"{rel}::{fn.name}: swallowed (try/except) or dead-branch (if False) assertion "
                    "(includes suppress/raises(AssertionError) and asserts after return)."
                )
            if fn.assert_count == 0:
                issues.append(f"{rel}::{fn.name}: test has zero assertions.")
    return issues


def check_harness_lock(
    base_ref: str,
    root: Path = ROOT,
    allow_harness_edit: bool = False,
) -> list[str]:
    if allow_harness_edit:
        return []
    resolved = _resolve_base_ref(root, base_ref)
    if resolved is None:
        return []

    issues: list[str] = []
    for rel in HARNESS_LOCKED_FILES:
        base_content = _git_show_file(root, resolved, rel)
        if base_content is None:
            continue
        current_path = root / rel
        if not current_path.exists():
            issues.append(f"{rel}: locked harness/referee file deleted (blocked).")
            continue
        current_content = current_path.read_text(encoding="utf-8")
        if base_content.replace("\r\n", "\n") != current_content.replace("\r\n", "\n"):
            issues.append(
                f"{rel}: locked harness/referee file modified "
                "(blocked; pass --allow-harness-edit for intentional human updates)."
            )
    issues.extend(_check_pytest_hook_files(root, resolved))
    return issues


def _check_pytest_hook_files(root: Path, resolved: str) -> list[str]:
    def is_hook(rel: str) -> bool:
        return Path(rel).name in PYTEST_HOOK_FILENAMES and rel not in HARNESS_LOCKED_FILES

    base_files = {rel for rel in _git_list_files(root, resolved, ".") if is_hook(rel)}
    current_files = {rel for rel in _git_current_files(root) if is_hook(rel)}
    issues: list[str] = []
    for rel in sorted(current_files - base_files):
        issues.append(
            f"{rel}: new pytest config/hook file (blocked; it can deselect tests or patch code "
            "during the run; pass --allow-harness-edit for intentional human updates)."
        )
    for rel in sorted(base_files - current_files):
        issues.append(f"{rel}: pytest config/hook file deleted (blocked).")
    for rel in sorted(base_files & current_files):
        base_content = _git_show_file(root, resolved, rel) or ""
        current_content = (root / rel).read_text(encoding="utf-8")
        if base_content.replace("\r\n", "\n") != current_content.replace("\r\n", "\n"):
            issues.append(
                f"{rel}: pytest config/hook file modified "
                "(blocked; pass --allow-harness-edit for intentional human updates)."
            )
    return issues


def check_anti_tampering(base_ref: str, root: Path = ROOT) -> list[str]:
    resolved = _resolve_base_ref(root, base_ref)
    if resolved is None:
        return []
    issues: list[str] = []

    for rel in _git_list_files(root, resolved, "tests/fixtures"):
        if not rel.endswith(".json"):
            continue
        current_path = root / rel
        if not current_path.exists():
            issues.append(f"{rel}: deleted existing replay fixture (blocked; human approval only).")
            continue
        base_content = _git_show_file(root, resolved, rel)
        current_content = current_path.read_text(encoding="utf-8")
        if base_content is not None and base_content.strip() != current_content.strip():
            issues.append(
                f"{rel}: modified existing replay fixture (add a new fixture instead of editing)."
            )

    for rel in _git_list_files(root, resolved, "tests"):
        if not _is_test_filename(Path(rel).name):
            continue
        current_path = root / rel
        if not current_path.exists():
            issues.append(f"{rel}: deleted existing test file (blocked; human approval only).")
            continue
        base_src = _git_show_file(root, resolved, rel)
        if base_src is None:
            continue
        base_stats = analyze_test_source(base_src)
        curr_stats = analyze_test_source(current_path.read_text(encoding="utf-8"))
        issues.extend(_compare_existing_tests(rel, base_stats, curr_stats))
    return issues


def _compare_existing_tests(
    rel: str,
    base_stats: dict[str, TestFunctionStats],
    curr_stats: dict[str, TestFunctionStats],
) -> list[str]:
    issues: list[str] = []
    for fn_name, base_fn in base_stats.items():
        curr_fn = curr_stats.get(fn_name)
        if curr_fn is None:
            issues.append(f"{rel}::{fn_name}: existing test was deleted or renamed.")
            continue
        if curr_fn.assert_count < base_fn.assert_count:
            issues.append(
                f"{rel}::{fn_name}: assertion count dropped "
                f"({base_fn.assert_count} -> {curr_fn.assert_count})."
            )
            continue
        remaining = list(curr_fn.assertions)
        for assertion in base_fn.assertions:
            if assertion in remaining:
                remaining.remove(assertion)
            else:
                issues.append(
                    f"{rel}::{fn_name}: existing assertion rewritten or removed: "
                    f"`{assertion}` (add new assertions instead of editing old ones)."
                )
    return issues


def check_coverage_floor(
    coverage_json: Path,
    shrink: bool,
    root: Path = ROOT,
    base_ref: str = "main",
) -> list[str]:
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

    # Never allow scripts/coverage-baseline.json itself to be lowered vs base_ref
    resolved = _resolve_base_ref(root, base_ref)
    if resolved is not None:
        base_raw = _git_show_file(root, resolved, "scripts/coverage-baseline.json")
        if base_raw is not None:
            base_floor = float(json.loads(base_raw)["min_percent"])
            if floor < base_floor:
                return [
                    f"scripts/coverage-baseline.json was lowered vs {resolved}: "
                    f"{base_floor:.2f}% -> {floor:.2f}% (monotonic floor may only rise)."
                ]

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
    parser.add_argument(
        "--allow-harness-edit",
        action="store_true",
        help="Permit intentional human edits to locked harness/referee files",
    )
    args = parser.parse_args()

    issues = [
        *check_static_test_quality(args.root),
        *check_harness_lock(args.base, args.root, args.allow_harness_edit),
        *check_anti_tampering(args.base, args.root),
    ]
    if args.coverage_json is not None:
        issues.extend(
            check_coverage_floor(args.coverage_json, args.shrink_coverage, args.root, args.base)
        )

    if issues:
        print("Test Guard FAILED — suspected test weakening, tampering, or coverage drop:")
        for item in issues:
            print(f"  - {item}")
        return 1

    print("Test Guard PASS: zero test tampering, zero weak assertions.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
