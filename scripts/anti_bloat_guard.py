"""Hybrid Deterministic Anti-Bloat Guard (`scripts/anti_bloat_guard.py`).

Combines a monotonic file-size ratchet (covering what external linters omit) with
industry-standard static analyzers when invoked with `--full`:
1. Monotonic file-size caps: keeps existing large files from growing further and caps
   all new files under `scripts/*.py` and `.sandcastle/*.ts` at 450 lines.
2. `vulture` (Python dead code across `src/` and `scripts/`).
3. `knip` (TypeScript dead exports, orphan files, and unused/unlisted npm deps).
4. `jscpd` (Tokenizer-aware copy-paste clone detection across Python and TypeScript).
"""

from __future__ import annotations

import argparse
import json
import shutil
import subprocess
import sys
from dataclasses import asdict, dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MAX_LINES = 450

# Monotonic ceilings for pre-existing larger files (may only shrink over time).
GRANDFATHERED_LINE_CAPS: dict[str, int] = {
    ".sandcastle/run.ts": 920,
    ".sandcastle/confidence.ts": 740,
    ".sandcastle/e2e-synthetic.ts": 650,
    ".sandcastle/dashboard-ui.ts": 630,
    ".sandcastle/nightly-arch.ts": 480,
}


@dataclass(frozen=True)
class BloatFinding:
    category: str
    file: str
    detail: str


def _resolve_py_tool(name: str) -> str:
    for candidate_name in (name, f"{name}.exe") if sys.platform == "win32" else (name,):
        candidate = Path(sys.executable).parent / candidate_name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(f"Required tool `{name}` not found in venv or PATH.")
    return found


def _resolve_sandcastle_bin(root: Path, name: str) -> str:
    bin_dir = root / ".sandcastle" / "node_modules" / ".bin"
    candidates = (f"{name}.cmd", name) if sys.platform == "win32" else (name,)
    for candidate_name in candidates:
        candidate = bin_dir / candidate_name
        if candidate.exists():
            return str(candidate)
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(
            f"Required tool `{name}` not found in .sandcastle/node_modules/.bin or PATH."
        )
    return found


def check_oversized_files(
    root: Path = ROOT,
    max_lines: int = DEFAULT_MAX_LINES,
) -> list[BloatFinding]:
    py_dir = root / "scripts"
    ts_dir = root / ".sandcastle"
    targets: list[Path] = []
    if py_dir.exists():
        targets.extend(sorted(py_dir.glob("*.py")))
    if ts_dir.exists():
        targets.extend(sorted(p for p in ts_dir.glob("*.ts") if not p.name.endswith(".test.ts")))

    findings: list[BloatFinding] = []
    use_grandfathered = max_lines == DEFAULT_MAX_LINES
    for path in targets:
        rel = path.relative_to(root).as_posix()
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


def _run_external_gate(label: str, cmd: list[str], cwd: Path) -> BloatFinding | None:
    proc = subprocess.run(cmd, cwd=cwd, capture_output=True, text=True, check=False)
    if proc.returncode == 0:
        return None
    tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[:8])
    return BloatFinding(category=label, file=".", detail=tail or f"exited with {proc.returncode}")


def run_external_analyzers(root: Path = ROOT) -> list[BloatFinding]:
    findings: list[BloatFinding] = []
    py_targets = [d for d in ("src", "scripts") if (root / d).exists()]
    if py_targets:
        vulture_hit = _run_external_gate(
            "vulture-dead-code",
            [_resolve_py_tool("vulture"), *py_targets, "--min-confidence", "80"],
            root,
        )
        if vulture_hit:
            findings.append(vulture_hit)

    if (root / ".sandcastle" / "package.json").exists() and (
        root / ".sandcastle" / "node_modules"
    ).exists():
        knip_hit = _run_external_gate(
            "knip-ts-dead-code",
            [_resolve_sandcastle_bin(root, "knip"), "--directory", ".sandcastle"],
            root,
        )
        if knip_hit:
            findings.append(knip_hit)

    dup_targets = [d for d in ("scripts", ".sandcastle") if (root / d).exists()]
    if dup_targets and (root / ".sandcastle" / "node_modules").exists():
        jscpd_hit = _run_external_gate(
            "jscpd-duplication",
            [
                _resolve_sandcastle_bin(root, "jscpd"),
                *dup_targets,
                "--ignore",
                "**/*.test.ts,**/node_modules/**,**/logs/**",
                "--min-lines",
                "10",
                "--min-tokens",
                "80",
                "--threshold",
                "2",
                "--silent",
            ],
            root,
        )
        if jscpd_hit:
            findings.append(jscpd_hit)

    return findings


def main() -> int:
    parser = argparse.ArgumentParser(description="Hybrid deterministic Anti-Bloat Guard")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root directory")
    parser.add_argument(
        "--max-lines",
        type=int,
        default=DEFAULT_MAX_LINES,
        help=f"Maximum lines per file (default: {DEFAULT_MAX_LINES})",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Also run vulture (Python dead code), knip (TS dead code), and jscpd (clones)",
    )
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args()

    findings = check_oversized_files(root=args.root, max_lines=args.max_lines)
    if args.full:
        findings.extend(run_external_analyzers(root=args.root))

    if args.json:
        print(json.dumps([asdict(f) for f in findings], indent=2))
    elif findings:
        print(f"Anti-Bloat Guard FAILED — {len(findings)} issue(s) found:")
        for item in findings:
            print(f"  - [{item.category}] {item.file}: {item.detail}")
    else:
        mode = "full (file-size + vulture + knip + jscpd)" if args.full else "file-size ratchet"
        print(f"Anti-Bloat Guard PASS ({mode}).")

    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
