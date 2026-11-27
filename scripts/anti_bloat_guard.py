"""Deterministic Anti-Bloat Guard (`scripts/anti_bloat_guard.py`).

Mechanically guards against codebase bloat across `scripts/*.py` and `.sandcastle/*.ts`
with zero external dependencies:
1. Oversized files: enforces a line-count cap on every file (monotonic ceilings for
   existing larger files so they can only shrink, and a strict default cap for new files).
2. Unused / dead helpers & exports: detects top-level Python functions/classes and
   TypeScript helpers/exports that have zero call or reference sites.
3. Duplicated code blocks: detects repeated normalized logical blocks across or within
   `.sandcastle/*.ts` and `scripts/*.py`.
"""

from __future__ import annotations

import argparse
import ast
import json
import re
from collections import defaultdict
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MAX_LINES = 450
DEFAULT_DUP_WINDOW = 9
DEFAULT_DUP_MIN_CHARS = 200

# Monotonic ceilings for pre-existing larger files (may only shrink over time).
GRANDFATHERED_LINE_CAPS: dict[str, int] = {
    ".sandcastle/run.ts": 920,
    ".sandcastle/confidence.ts": 740,
    ".sandcastle/e2e-synthetic.ts": 650,
    ".sandcastle/dashboard-ui.ts": 630,
    ".sandcastle/nightly-arch.ts": 480,
}

# Pre-existing duplicated helper across locked harness files (cannot edit without harness unlock).
GRANDFATHERED_DUP_PAIRS: frozenset[tuple[str, str]] = frozenset(
    {("scripts/check.py", "scripts/ratchet.py")}
)

TS_EXPORT_RE = re.compile(
    r"^\s*export\s+(?:async\s+)?(?:function|const|class)\s+([A-Za-z_][A-Za-z0-9_]*)\b",
    re.MULTILINE,
)
TS_PRIVATE_FN_RE = re.compile(
    r"^(?:async\s+)?function\s+([A-Za-z_][A-Za-z0-9_]*)\b",
    re.MULTILINE,
)
PUNCT_ONLY_RE = re.compile(r"^[\{\}\[\]\(\),;]+$")


@dataclass(frozen=True)
class BloatFinding:
    category: str
    file: str
    detail: str


def _rel_posix(path: Path, root: Path) -> str:
    return path.relative_to(root).as_posix()


def _collect_target_files(root: Path) -> tuple[list[Path], list[Path]]:
    py_dir = root / "scripts"
    ts_dir = root / ".sandcastle"
    py_files = sorted(py_dir.glob("*.py")) if py_dir.exists() else []
    ts_files = (
        sorted(p for p in ts_dir.glob("*.ts") if not p.name.endswith(".test.ts"))
        if ts_dir.exists()
        else []
    )
    return py_files, ts_files


def _word_count(name: str, text: str) -> int:
    return len(re.findall(rf"\b{re.escape(name)}\b", text))


def check_oversized_files(
    root: Path,
    py_files: list[Path],
    ts_files: list[Path],
    max_lines: int = DEFAULT_MAX_LINES,
) -> list[BloatFinding]:
    findings: list[BloatFinding] = []
    use_grandfathered = max_lines == DEFAULT_MAX_LINES
    for path in [*py_files, *ts_files]:
        rel = _rel_posix(path, root)
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        limit = GRANDFATHERED_LINE_CAPS.get(rel, max_lines) if use_grandfathered else max_lines
        if line_count > limit:
            findings.append(
                BloatFinding(
                    category="oversized-file",
                    file=rel,
                    detail=f"{line_count} lines exceeds cap of {limit} lines",
                )
            )
    return findings


def check_dead_python_symbols(root: Path, py_files: list[Path]) -> list[BloatFinding]:
    findings: list[BloatFinding] = []
    consumer_files: list[Path] = list(py_files)
    for folder in ("tests_tooling", "src", "tests"):
        base = root / folder
        if base.exists():
            consumer_files.extend(sorted(base.rglob("*.py")))

    corpus = "\n".join(
        p.read_text(encoding="utf-8", errors="replace") for p in dict.fromkeys(consumer_files)
    )

    for py_file in py_files:
        rel = _rel_posix(py_file, root)
        source = py_file.read_text(encoding="utf-8")
        try:
            tree = ast.parse(source)
        except SyntaxError:
            continue
        for node in tree.body:
            if not isinstance(node, (ast.FunctionDef, ast.AsyncFunctionDef, ast.ClassDef)):
                continue
            name = node.name
            if name == "main" or (name.startswith("__") and name.endswith("__")):
                continue
            if _word_count(name, corpus) <= 1:
                findings.append(
                    BloatFinding(
                        category="dead-python-symbol",
                        file=rel,
                        detail=f"unused top-level symbol `{name}` (0 references)",
                    )
                )
    return findings


def check_dead_ts_symbols(root: Path, ts_files: list[Path]) -> list[BloatFinding]:
    findings: list[BloatFinding] = []
    ts_dir = root / ".sandcastle"
    all_ts_files = sorted(ts_dir.glob("*.ts")) if ts_dir.exists() else []
    texts = {p: p.read_text(encoding="utf-8", errors="replace") for p in all_ts_files}
    full_corpus = "\n".join(texts.values())

    for ts_file in ts_files:
        rel = _rel_posix(ts_file, root)
        src = texts.get(ts_file, "")

        for match in TS_EXPORT_RE.finditer(src):
            name = match.group(1)
            if _word_count(name, full_corpus) <= 1:
                findings.append(
                    BloatFinding(
                        category="dead-ts-export",
                        file=rel,
                        detail=f"unused exported symbol `{name}` (0 references in .sandcastle/)",
                    )
                )

        for match in TS_PRIVATE_FN_RE.finditer(src):
            name = match.group(1)
            if name == "main":
                continue
            if _word_count(name, src) <= 1:
                findings.append(
                    BloatFinding(
                        category="dead-ts-helper",
                        file=rel,
                        detail=f"unused private helper `{name}` (0 references in file)",
                    )
                )
    return findings


def _normalize_code_lines(text: str) -> list[tuple[int, str]]:
    normalized: list[tuple[int, str]] = []
    for line_no, raw in enumerate(text.splitlines(), 1):
        compact = re.sub(r"\s+", " ", raw.strip())
        if not compact:
            continue
        if compact.startswith(("#", "//", "/*", "*", "import ", "from ")):
            continue
        if PUNCT_ONLY_RE.match(compact):
            continue
        normalized.append((line_no, compact))
    return normalized


def check_duplicated_blocks(
    root: Path,
    py_files: list[Path],
    ts_files: list[Path],
    window: int = DEFAULT_DUP_WINDOW,
    min_chars: int = DEFAULT_DUP_MIN_CHARS,
) -> list[BloatFinding]:
    if window < 2:
        return []

    buckets: dict[tuple[str, ...], list[tuple[str, int]]] = defaultdict(list)
    for path in [*py_files, *ts_files]:
        rel = _rel_posix(path, root)
        norm = _normalize_code_lines(path.read_text(encoding="utf-8", errors="replace"))
        for idx in range(len(norm) - window + 1):
            chunk = tuple(line for _, line in norm[idx : idx + window])
            if sum(len(line) for line in chunk) < min_chars:
                continue
            buckets[chunk].append((rel, norm[idx][0]))

    findings: list[BloatFinding] = []
    seen_pairs: set[tuple[str, str, int]] = set()
    for locs in buckets.values():
        if len(locs) < 2:
            continue
        first_file, first_line = locs[0]
        second_file, _ = locs[1]
        if (first_file, second_file) in GRANDFATHERED_DUP_PAIRS:
            continue
        pair_key = (first_file, second_file, first_line // window)
        if pair_key in seen_pairs:
            continue
        seen_pairs.add(pair_key)
        preview = ", ".join(f"{f}:{ln}" for f, ln in locs[:3])
        findings.append(
            BloatFinding(
                category="duplicated-block",
                file=first_file,
                detail=f"{window}+ identical logical lines duplicated at {preview}",
            )
        )
    return sorted(findings, key=lambda item: (item.category, item.file, item.detail))


def run_anti_bloat_guard(
    root: Path = ROOT,
    max_lines: int = DEFAULT_MAX_LINES,
    dup_window: int = DEFAULT_DUP_WINDOW,
    dup_min_chars: int = DEFAULT_DUP_MIN_CHARS,
) -> list[BloatFinding]:
    py_files, ts_files = _collect_target_files(root)
    return [
        *check_oversized_files(root, py_files, ts_files, max_lines=max_lines),
        *check_dead_python_symbols(root, py_files),
        *check_dead_ts_symbols(root, ts_files),
        *check_duplicated_blocks(
            root, py_files, ts_files, window=dup_window, min_chars=dup_min_chars
        ),
    ]


def main() -> int:
    parser = argparse.ArgumentParser(description="Deterministic Anti-Bloat Guard")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root directory")
    parser.add_argument(
        "--max-lines",
        type=int,
        default=DEFAULT_MAX_LINES,
        help=f"Maximum lines per file (default: {DEFAULT_MAX_LINES})",
    )
    parser.add_argument(
        "--dup-window",
        type=int,
        default=DEFAULT_DUP_WINDOW,
        help=f"Normalized line window for duplicate detection (default: {DEFAULT_DUP_WINDOW})",
    )
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args()

    findings = run_anti_bloat_guard(
        root=args.root,
        max_lines=args.max_lines,
        dup_window=args.dup_window,
    )

    if args.json:
        print(json.dumps([asdict(f) for f in findings], indent=2))
    elif findings:
        print(f"Anti-Bloat Guard FAILED — {len(findings)} issue(s) found:")
        for item in findings:
            print(f"  - [{item.category}] {item.file}: {item.detail}")
    else:
        print("Anti-Bloat Guard PASS: zero oversized files, dead symbols, or duplicated blocks.")

    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
