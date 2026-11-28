"""Full-Repo Wiring Mapper & Connected-Component Impact Reminder (`python scripts/arch_map.py`).

Scans real cross-language connections across the repository (not just static imports):
  1. Python imports (`src/`, `scripts/`)
  2. TypeScript imports (`.sandcastle/*.ts`)
  3. Cross-boundary invocations (`scripts/*.py`, `.sandcastle/*-prompt.md`, CI workflows, hooks)
  4. Shared state artifacts (`.scratch/`, `.sandcastle/logs/`, baseline JSONs)

Modes:
  python scripts/arch_map.py                 # Regenerate docs/ARCHITECTURE_MAP.md
  python scripts/arch_map.py --check         # Exit 1 if docs/ARCHITECTURE_MAP.md is stale
  python scripts/arch_map.py --impact        # Print connected components for changed files
  python scripts/arch_map.py --impact --json # Machine-readable suggestions (used by coach.ts)
"""

from __future__ import annotations

import argparse
import ast
import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MAP_PATH = ROOT / "docs" / "ARCHITECTURE_MAP.md"

_TS_IMPORT_RE = re.compile(r"""from\s+["'](\./[^"']+)["']""")
_SCRIPT_REF_RE = re.compile(r"""scripts/([a-zA-Z0-9_]+\.py)\b""")
_PROMPT_REF_RE = re.compile(r"""\.sandcastle/([a-zA-Z0-9_-]+-prompt\.md)\b""")
_ARTIFACT_REFS: tuple[tuple[str, str], ...] = (
    (".scratch/", "state:.scratch/"),
    (".sandcastle/logs", "state:.sandcastle/logs/"),
    ("coverage-baseline.json", "scripts/coverage-baseline.json"),
    ("ratchet-baseline.json", "scripts/ratchet-baseline.json"),
)


@dataclass(frozen=True)
class Edge:
    src: str
    dst: str
    kind: str  # "import" | "invokes" | "prompt" | "state"


def _iter_repo_files(root: Path) -> list[Path]:
    files: list[Path] = []
    for folder, suffix in (
        ("src", ".py"),
        ("scripts", ".py"),
        (".sandcastle", ".ts"),
        (".sandcastle", ".md"),
        (".github/workflows", ".yml"),
    ):
        base = root / folder
        if not base.exists():
            continue
        for p in sorted(base.rglob(f"*{suffix}")):
            rel = p.relative_to(root).as_posix()
            if "node_modules" in rel or "__pycache__" in rel or rel.endswith(".test.ts"):
                continue
            files.append(p)
    pre_commit = root / ".pre-commit-config.yaml"
    if pre_commit.is_file():
        files.append(pre_commit)
    return files


def _python_import_targets(path: Path, root: Path, known: set[str]) -> list[str]:
    try:
        tree = ast.parse(path.read_text(encoding="utf-8", errors="replace"))
    except SyntaxError:
        return []
    targets: list[str] = []
    for node in ast.walk(tree):
        mod_names: list[str] = []
        if isinstance(node, ast.Import):
            mod_names = [alias.name for alias in node.names]
        elif isinstance(node, ast.ImportFrom) and node.module:
            mod_names = [node.module]
        for mod in mod_names:
            for prefix in ("scripts", "src"):
                candidate = f"{prefix}/{mod.replace('.', '/')}.py"
                if candidate in known:
                    targets.append(candidate)
    return targets


def _extract_file_edges(path: Path, rel: str, known: set[str]) -> set[Edge]:
    text = path.read_text(encoding="utf-8", errors="replace")
    found: set[Edge] = set()
    if rel.endswith(".py"):
        for target in _python_import_targets(path, ROOT, known):
            if target != rel:
                found.add(Edge(rel, target, "import"))
    if rel.endswith(".ts"):
        for match in _TS_IMPORT_RE.finditer(text):
            mod = match.group(1).removeprefix("./").removesuffix(".js") + ".ts"
            target = f".sandcastle/{mod}"
            if target in known and target != rel:
                found.add(Edge(rel, target, "import"))
    for match in _SCRIPT_REF_RE.finditer(text):
        target = f"scripts/{match.group(1)}"
        if target in known and target != rel:
            found.add(Edge(rel, target, "invokes"))
    for match in _PROMPT_REF_RE.finditer(text):
        target = f".sandcastle/{match.group(1)}"
        if target in known and target != rel:
            found.add(Edge(rel, target, "prompt"))
    for needle, artifact in _ARTIFACT_REFS:
        if needle in text and artifact != rel:
            found.add(Edge(rel, artifact, "state"))
    return found


def build_wiring_graph(root: Path = ROOT) -> tuple[list[str], list[Edge]]:
    files = _iter_repo_files(root)
    rel_paths = [p.relative_to(root).as_posix() for p in files]
    known = set(rel_paths)
    edge_set: set[Edge] = set()
    for path, rel in zip(files, rel_paths, strict=True):
        edge_set.update(_extract_file_edges(path, rel, known))
    nodes = sorted(known | {e.dst for e in edge_set})
    edges = sorted(edge_set, key=lambda e: (e.src, e.dst, e.kind))
    return nodes, edges


def _node_id(name: str) -> str:
    return "n_" + re.sub(r"[^a-zA-Z0-9]+", "_", name).strip("_")


def _group_for(node: str) -> str:
    if node.startswith((".github/", ".pre-commit")):
        return "CI_and_Hooks"
    if node.startswith(".sandcastle/") and node.endswith(".ts"):
        return "Sandcastle_Orchestrator"
    if node.startswith(".sandcastle/") and node.endswith(".md"):
        return "Agent_Prompts"
    if node.startswith("scripts/"):
        return "Python_Gates_and_Tools"
    if node.startswith("src/"):
        return "Domain_Source"
    return "Shared_State"


def render_architecture_markdown(nodes: list[str], edges: list[Edge]) -> str:
    groups: dict[str, list[str]] = defaultdict(list)
    for node in nodes:
        groups[_group_for(node)].append(node)

    mermaid_lines = ["flowchart LR"]
    for group_name in (
        "CI_and_Hooks",
        "Sandcastle_Orchestrator",
        "Agent_Prompts",
        "Python_Gates_and_Tools",
        "Domain_Source",
        "Shared_State",
    ):
        members = sorted(groups.get(group_name, []))
        if not members:
            continue
        label = group_name.replace("_", " ")
        mermaid_lines.append(f'  subgraph {group_name}["{label}"]')
        for m in members:
            short = m.removeprefix("state:")
            mermaid_lines.append(f'    {_node_id(m)}["{short}"]')
        mermaid_lines.append("  end")

    for edge in edges:
        if edge.kind == "state":
            mermaid_lines.append(f"  {_node_id(edge.src)} -.-> {_node_id(edge.dst)}")
        else:
            mermaid_lines.append(f"  {_node_id(edge.src)} --> {_node_id(edge.dst)}")

    callers: dict[str, list[str]] = defaultdict(list)
    for edge in edges:
        if not edge.dst.startswith("state:"):
            callers[edge.dst].append(edge.src)

    hotspots = sorted(callers.items(), key=lambda kv: (-len(kv[1]), kv[0]))[:12]
    table_lines = [
        "| Component | Referenced / Invoked By (Count) | Connected Callers |",
        "| --- | ---: | --- |",
    ]
    for target, srcs in hotspots:
        preview = ", ".join(f"`{s}`" for s in sorted(set(srcs))[:5])
        extra = f" (+{len(set(srcs)) - 5} more)" if len(set(srcs)) > 5 else ""
        table_lines.append(f"| `{target}` | {len(set(srcs))} | {preview}{extra} |")

    return "\n".join(
        [
            "# Repository Wiring & Architecture Map",
            "",
            "> Auto-generated by `python scripts/arch_map.py`. "
            "Maps **Python imports, TypeScript imports, cross-language script invocations, "
            "prompt templates, CI workflows, pre-commit hooks, and shared state artifacts**.",
            "> Run `python scripts/arch_map.py --impact` to see connected components to check "
            "for your current edits.",
            "",
            "```mermaid",
            *mermaid_lines,
            "```",
            "",
            "## Highest-Connected Components (Check These When Editing)",
            "",
            *table_lines,
            "",
        ]
    )


def detect_changed_files(root: Path = ROOT, base_ref: str | None = None) -> list[str]:
    changed: set[str] = set()
    porcelain = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if porcelain.returncode == 0:
        for line in porcelain.stdout.splitlines():
            if len(line) > 3:
                changed.add(line[3:].strip().replace("\\", "/"))
    if base_ref:
        diff = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        if diff.returncode == 0:
            for line in diff.stdout.splitlines():
                if line.strip():
                    changed.add(line.strip().replace("\\", "/"))
    return sorted(changed)


@dataclass(frozen=True)
class ImpactSuggestion:
    file: str
    check_callers: list[str]
    check_dependencies: list[str]


def compute_impact_suggestions(
    changed_files: list[str],
    edges: list[Edge],
) -> list[ImpactSuggestion]:
    upstream_of: dict[str, set[str]] = defaultdict(set)
    downstream_of: dict[str, set[str]] = defaultdict(set)
    for e in edges:
        if e.dst.startswith("state:"):
            continue
        upstream_of[e.dst].add(e.src)
        downstream_of[e.src].add(e.dst)

    changed_set = set(changed_files)
    suggestions: list[ImpactSuggestion] = []
    for path in sorted(changed_set):
        callers = sorted(upstream_of.get(path, set()) - changed_set)
        deps = sorted(downstream_of.get(path, set()) - changed_set)
        if callers or deps:
            suggestions.append(ImpactSuggestion(path, callers, deps))
    return suggestions


def _run_impact_mode(args: argparse.Namespace, edges: list[Edge]) -> int:
    changed = args.files if args.files is not None else detect_changed_files(args.root, args.base)
    suggestions = compute_impact_suggestions(changed, edges)
    if args.json:
        payload = {"changed": changed, "suggestions": [asdict(s) for s in suggestions]}
        print(json.dumps(payload, indent=2))
        return 0
    if not suggestions:
        print("Impact Reminder: no untouched connected components flagged for current edits.")
        return 0
    print("=== Connected-Component Impact Reminders ===")
    for item in suggestions:
        print(f"\nModified: {item.file}")
        if item.check_callers:
            print(f"  Check callers/consumers: {', '.join(item.check_callers[:8])}")
        if item.check_dependencies:
            print(f"  Check dependencies:      {', '.join(item.check_dependencies[:8])}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Repo wiring mapper & impact reminder")
    parser.add_argument("--root", type=Path, default=ROOT)
    parser.add_argument("--output", type=Path, default=None)
    parser.add_argument("--check", action="store_true", help="Fail if ARCHITECTURE_MAP.md is stale")
    parser.add_argument("--impact", action="store_true", help="Show connected-component reminders")
    parser.add_argument("--base", default=None, help="Optional git base ref for --impact")
    parser.add_argument("--files", nargs="*", default=None, help="Explicit file list for --impact")
    parser.add_argument("--json", action="store_true", help="JSON output for --impact")
    args = parser.parse_args(argv)

    root: Path = args.root
    nodes, edges = build_wiring_graph(root)
    if args.impact:
        return _run_impact_mode(args, edges)

    rendered = render_architecture_markdown(nodes, edges)
    out_path = args.output or (root / "docs" / "ARCHITECTURE_MAP.md")
    if args.check:
        if not out_path.is_file() or out_path.read_text(encoding="utf-8") != rendered:
            print(
                f"{out_path.relative_to(root).as_posix()} is out of date. "
                "Run `python scripts/arch_map.py` to refresh it.",
                file=sys.stderr,
            )
            return 1
        print(f"Architecture Map PASS ({len(nodes)} nodes, {len(edges)} edges).")
        return 0

    out_path.parent.mkdir(parents=True, exist_ok=True)
    out_path.write_text(rendered, encoding="utf-8")
    print(f"Wrote {out_path} ({len(nodes)} nodes, {len(edges)} edges).")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
