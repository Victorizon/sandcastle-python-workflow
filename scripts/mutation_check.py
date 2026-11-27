"""Fast, safe AST mutation tester for processor modules (`scripts/mutation_check.py`).

Proves that tests genuinely catch logic bugs rather than merely executing lines.
Runs inside an isolated temporary copy of the project (never mutates your live workspace).

Targeted mutations in `src/app/processors/*.py`:
- Flip boolean literals (`True` <-> `False`, e.g., `auto_execute=False` -> `True`)
- Flip fail-closed decisions (`MANUAL_REVIEW` -> `AUTO_APPROVE`, `REJECT` -> `AUTO_APPROVE`)
- Flip boolean operators (`and` <-> `or`)
- Flip equality checks (`==` <-> `!=`)
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
    env = {**os.environ, "PYTHONDONTWRITEBYTECODE": "1"}
    proc = subprocess.run(
        [sys.executable, "-B", "-m", "pytest", "-x", "-q", "--no-header"],
        cwd=workdir,
        env=env,
        capture_output=True,
        text=True,
        check=False,
    )
    return proc.returncode


def _copy_project(root: Path, dest: Path) -> None:
    ignore = shutil.ignore_patterns("__pycache__", "*.pyc", ".pytest_cache")
    for item in ("src", "tests", "pyproject.toml"):
        src_path = root / item
        dst_path = dest / item
        if src_path.is_dir():
            shutil.copytree(src_path, dst_path, ignore=ignore)
        elif src_path.exists():
            shutil.copy2(src_path, dst_path)


def run_mutation_suite(min_kill_rate: float, root: Path = ROOT) -> int:
    processors_dir = root / "src" / "app" / "processors"
    if not processors_dir.exists():
        print("Mutation check skipped: no src/app/processors/ directory.")
        return 0

    targets = [p for p in sorted(processors_dir.rglob("*.py")) if p.name != "__init__.py"]
    mutants: list[Mutant] = []
    for py_file in targets:
        mutants.extend(_collect_mutants_for_file(root, py_file))

    if not mutants:
        print("Mutation check PASS: 0 applicable mutants.")
        return 0

    survived: list[Mutant] = []
    with tempfile.TemporaryDirectory(prefix="mutation-check-") as tmp:
        workdir = Path(tmp)
        _copy_project(root, workdir)
        if _run_pytest_in(workdir) != 0:
            print("Mutation check ABORTED: baseline pytest failed before mutation.")
            return 1

        for m in mutants:
            target_file = workdir / m.rel_file
            original = target_file.read_text(encoding="utf-8")
            try:
                target_file.write_text(m.mutated_source, encoding="utf-8")
                if _run_pytest_in(workdir) == 0:
                    survived.append(m)
            finally:
                target_file.write_text(original, encoding="utf-8")

    killed = len(mutants) - len(survived)
    kill_rate = (killed / len(mutants)) * 100.0
    print(f"Mutation score: {killed}/{len(mutants)} killed ({kill_rate:.1f}%).")

    if survived:
        print("Surviving mutants (tests failed to catch these injected bugs):")
        for m in survived:
            print(f"  - {m.rel_file}:{m.line}: {m.description}")

    if kill_rate < min_kill_rate:
        print(
            f"Mutation check FAILED: {kill_rate:.1f}% < required {min_kill_rate:.1f}%. "
            "Strengthen behavioral replay assertions so injected bugs fail pytest."
        )
        return 1

    print(f"Mutation check PASS: {kill_rate:.1f}% >= {min_kill_rate:.1f}%.")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Reliability AST mutation checker")
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
    args = parser.parse_args()
    return run_mutation_suite(args.min_kill_rate, args.root)


if __name__ == "__main__":
    raise SystemExit(main())
