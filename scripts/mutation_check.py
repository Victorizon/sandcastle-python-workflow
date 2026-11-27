"""Fast, parallel, diff-scoped AST mutation tester (`scripts/mutation_check.py`).

Proves that tests genuinely catch logic bugs rather than merely executing lines.
Runs inside isolated per-worker temporary copies (never mutates your live workspace).

Scale optimizations for large legacy repos:
- Diff-scoped by default when `--base <ref>` has changed processor files (use `--all` for full scan)
- Parallel worker pool (`--workers`, default up to 4 concurrent temp sandboxes)
- Uses `HYPOTHESIS_PROFILE=mutation` + `pytest -x --ff` so obvious mutants die fast
"""

from __future__ import annotations

import argparse
import ast
import copy
import os
import shutil
import subprocess
import sys
import tempfile
from collections.abc import Callable
from concurrent.futures import ThreadPoolExecutor
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


@dataclass(frozen=True)
class Mutant:
    rel_file: str
    line: int
    description: str
    mutated_source: str


def _flip_bool_const(node: ast.AST) -> None:
    if isinstance(node, ast.Constant) and isinstance(node.value, bool):
        node.value = not node.value


def _flip_bool_op(node: ast.AST) -> None:
    if isinstance(node, ast.BoolOp):
        node.op = ast.Or() if isinstance(node.op, ast.And) else ast.And()


def _flip_eq_op(node: ast.AST) -> None:
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        node.ops[0] = ast.NotEq() if isinstance(node.ops[0], ast.Eq) else ast.Eq()


def _flip_decision_attr(node: ast.AST) -> None:
    if isinstance(node, ast.Attribute):
        node.attr = "AUTO_APPROVE"


def _describe_mutation(node: ast.AST) -> tuple[str, Callable[[ast.AST], None]] | None:
    if isinstance(node, ast.Constant) and isinstance(node.value, bool):
        flipped = not node.value
        return (f"bool `{node.value}` -> `{flipped}`", _flip_bool_const)
    if isinstance(node, ast.BoolOp):
        op_name = "and -> or" if isinstance(node.op, ast.And) else "or -> and"
        return (f"logic `{op_name}`", _flip_bool_op)
    if isinstance(node, ast.Compare) and len(node.ops) == 1:
        if isinstance(node.ops[0], ast.Eq):
            return ("compare `==` -> `!=`", _flip_eq_op)
        if isinstance(node.ops[0], ast.NotEq):
            return ("compare `!=` -> `==`", _flip_eq_op)
    if (
        isinstance(node, ast.Attribute)
        and isinstance(node.value, ast.Name)
        and node.value.id == "Decision"
        and node.attr in {"MANUAL_REVIEW", "REJECT"}
    ):
        return (
            f"decision `Decision.{node.attr}` -> `Decision.AUTO_APPROVE`",
            _flip_decision_attr,
        )
    return None


def _collect_mutants_for_file(root: Path, py_file: Path) -> list[Mutant]:
    source = py_file.read_text(encoding="utf-8")
    tree = ast.parse(source)
    rel = py_file.relative_to(root).as_posix()
    mutants: list[Mutant] = []

    nodes = list(ast.walk(tree))
    for idx, node in enumerate(nodes):
        mutation = _describe_mutation(node)
        if mutation is None:
            continue
        desc, mutator = mutation
        cloned = copy.deepcopy(tree)
        target = list(ast.walk(cloned))[idx]
        mutator(target)
        ast.fix_missing_locations(cloned)
        mutants.append(
            Mutant(
                rel_file=rel,
                line=getattr(node, "lineno", 0),
                description=desc,
                mutated_source=ast.unparse(cloned) + "\n",
            )
        )
    return mutants


def _run_pytest_in(workdir: Path) -> int:
    env = {
        **os.environ,
        "PYTHONDONTWRITEBYTECODE": "1",
        "HYPOTHESIS_PROFILE": "mutation",
    }
    proc = subprocess.run(
        [sys.executable, "-B", "-m", "pytest", "-x", "-q", "--ff", "--no-header"],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode


def _copy_project(root: Path, dest: Path) -> None:
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache", ".hypothesis")
    for item in ("src", "tests", "pyproject.toml"):
        src_path = root / item
        dst_path = dest / item
        if src_path.is_dir():
            shutil.copytree(src_path, dst_path, ignore=ignore)
        elif src_path.exists():
            shutil.copy2(src_path, dst_path)


def _changed_processor_files(root: Path, base_ref: str) -> list[Path]:
    changed: set[str] = set()
    diff_proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "diff", "--name-only", base_ref],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if diff_proc.returncode == 0:
        changed.update(line.strip() for line in diff_proc.stdout.splitlines() if line.strip())

    status_proc = subprocess.run(
        ["git", "-c", "safe.directory=*", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if status_proc.returncode == 0:
        for line in status_proc.stdout.splitlines():
            if len(line) > 3:
                changed.add(line[3:].strip())

    targets: list[Path] = []
    for rel in sorted(changed):
        if rel.startswith("src/app/processors/") and rel.endswith(".py"):
            candidate = root / rel
            if candidate.exists() and candidate.name != "__init__.py":
                targets.append(candidate)
    return targets


def _select_targets(root: Path, base_ref: str | None, scan_all: bool) -> tuple[list[Path], str]:
    processors_dir = root / "src" / "app" / "processors"
    if not processors_dir.exists():
        return ([], "none")

    if not scan_all and base_ref:
        changed = _changed_processor_files(root, base_ref)
        if changed:
            return (changed, f"diff-scoped vs {base_ref} ({len(changed)} file(s))")

    all_targets = [p for p in sorted(processors_dir.rglob("*.py")) if p.name != "__init__.py"]
    return (all_targets, f"full scan ({len(all_targets)} file(s))")


def _run_chunk(root: Path, chunk: list[Mutant]) -> list[Mutant]:
    survived: list[Mutant] = []
    with tempfile.TemporaryDirectory(prefix="mutation-worker-") as tmp:
        workdir = Path(tmp)
        _copy_project(root, workdir)
        for m in chunk:
            target_file = workdir / m.rel_file
            original = target_file.read_text(encoding="utf-8")
            try:
                target_file.write_text(m.mutated_source, encoding="utf-8")
                if _run_pytest_in(workdir) == 0:
                    survived.append(m)
            finally:
                target_file.write_text(original, encoding="utf-8")
    return survived


def _evaluate_mutants_parallel(root: Path, mutants: list[Mutant], workers: int) -> list[Mutant]:
    worker_count = max(1, min(workers, len(mutants)))
    if worker_count == 1:
        return _run_chunk(root, mutants)

    chunks: list[list[Mutant]] = [[] for _ in range(worker_count)]
    for idx, mutant in enumerate(mutants):
        chunks[idx % worker_count].append(mutant)

    survived: list[Mutant] = []
    with ThreadPoolExecutor(max_workers=worker_count) as pool:
        futures = [pool.submit(_run_chunk, root, chunk) for chunk in chunks if chunk]
        for fut in futures:
            survived.extend(fut.result())
    return survived


@dataclass(frozen=True)
class MutationConfig:
    min_kill_rate: float = 85.0
    root: Path = ROOT
    base_ref: str | None = None
    scan_all: bool = False
    workers: int = 4
    skip_baseline: bool = False


def run_mutation_suite(config: MutationConfig) -> int:
    targets, scope_label = _select_targets(config.root, config.base_ref, config.scan_all)
    if not targets:
        print("Mutation check skipped: no src/app/processors/ targets found.")
        return 0

    mutants: list[Mutant] = []
    for py_file in targets:
        mutants.extend(_collect_mutants_for_file(config.root, py_file))

    if not mutants:
        print("Mutation check PASS: 0 applicable mutants.")
        return 0

    if not config.skip_baseline:
        with tempfile.TemporaryDirectory(prefix="mutation-baseline-") as tmp:
            workdir = Path(tmp)
            _copy_project(config.root, workdir)
            if _run_pytest_in(workdir) != 0:
                print("Mutation check ABORTED: baseline pytest failed before mutation.")
                return 1

    survived = _evaluate_mutants_parallel(config.root, mutants, config.workers)
    killed = len(mutants) - len(survived)
    kill_rate = (killed / len(mutants)) * 100.0
    print(f"Mutation scope: {scope_label} | workers={min(config.workers, len(mutants))}")
    print(f"Mutation score: {killed}/{len(mutants)} killed ({kill_rate:.1f}%).")

    if survived:
        print("Surviving mutants (tests failed to catch these injected bugs):")
        for m in survived:
            print(f"  - {m.rel_file}:{m.line}: {m.description}")

    if kill_rate < config.min_kill_rate:
        print(
            f"Mutation check FAILED: {kill_rate:.1f}% < required {config.min_kill_rate:.1f}%. "
            "Strengthen behavioral replay assertions so injected bugs fail pytest."
        )
        return 1

    print(f"Mutation check PASS: {kill_rate:.1f}% >= {config.min_kill_rate:.1f}%.")
    return 0


def main() -> int:
    env_workers = os.environ.get("MUTATION_WORKERS")
    default_workers = (
        max(1, int(env_workers))
        if env_workers and env_workers.isdigit()
        else max(1, min(4, os.cpu_count() or 2))
    )
    parser = argparse.ArgumentParser(description="Fast parallel AST mutation checker")
    parser.add_argument(
        "--root",
        type=Path,
        default=ROOT,
        help="Repository root directory (default: current repo)",
    )
    parser.add_argument(
        "--min-kill-rate",
        type=float,
        default=85.0,
        help="Minimum percentage of mutants tests must kill (default: 85.0)",
    )
    parser.add_argument(
        "--base",
        default=None,
        help="Git base ref for diff-scoped mutation (mutates only changed processor files if any)",
    )
    parser.add_argument(
        "--all",
        action="store_true",
        help="Force full-repo mutation scan across all processor modules",
    )
    parser.add_argument(
        "--workers",
        type=int,
        default=default_workers,
        help=f"Parallel worker sandboxes (default: {default_workers})",
    )
    parser.add_argument(
        "--skip-baseline",
        action="store_true",
        help="Skip pre-mutation pytest run when caller already verified pytest",
    )
    args = parser.parse_args()
    return run_mutation_suite(
        MutationConfig(
            min_kill_rate=args.min_kill_rate,
            root=args.root,
            base_ref=args.base,
            scan_all=args.all,
            workers=args.workers,
            skip_baseline=args.skip_baseline,
        )
    )


if __name__ == "__main__":
    raise SystemExit(main())
