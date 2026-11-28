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
from typing import cast

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_MAX_LINES = 450
BASELINE_REL_PATH = Path("scripts") / "bloat-baseline.json"

# Fallback ceilings when `scripts/bloat-baseline.json` has not been initialized yet.
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


@dataclass(frozen=True)
class BloatBaseline:
    max_lines: int
    file_line_caps: dict[str, int]
    vulture_findings: int


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


def _iter_size_targets(root: Path) -> list[Path]:
    targets: list[Path] = []
    src_dir = root / "src"
    py_dir = root / "scripts"
    ts_dir = root / ".sandcastle"
    if src_dir.exists():
        targets.extend(sorted(src_dir.rglob("*.py")))
    if py_dir.exists():
        targets.extend(sorted(py_dir.glob("*.py")))
    if ts_dir.exists():
        targets.extend(sorted(p for p in ts_dir.glob("*.ts") if not p.name.endswith(".test.ts")))
    return targets


def load_bloat_baseline(root: Path = ROOT) -> BloatBaseline | None:
    path = root / BASELINE_REL_PATH
    if not path.is_file():
        return None
    raw: object = json.loads(path.read_text(encoding="utf-8"))
    if not isinstance(raw, dict):
        return None
    data = cast("dict[str, object]", raw)
    caps: dict[str, int] = {}
    caps_raw = data.get("file_line_caps", {})
    if isinstance(caps_raw, dict):
        for k, v in cast("dict[object, object]", caps_raw).items():
            if isinstance(k, str) and isinstance(v, int):
                caps[k] = v
    max_lines_raw = data.get("max_lines", DEFAULT_MAX_LINES)
    vulture_raw = data.get("vulture_findings", 0)
    return BloatBaseline(
        max_lines=max_lines_raw if isinstance(max_lines_raw, int) else DEFAULT_MAX_LINES,
        file_line_caps=caps,
        vulture_findings=vulture_raw if isinstance(vulture_raw, int) else 0,
    )


def _run_vulture_lines(root: Path) -> list[str]:
    py_targets = [d for d in ("src", "scripts") if (root / d).exists()]
    if not py_targets:
        return []
    proc = subprocess.run(
        [_resolve_py_tool("vulture"), *py_targets, "--min-confidence", "80"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode == 0:
        return []
    return [line.strip() for line in proc.stdout.splitlines() if line.strip()]


def init_bloat_baseline(root: Path = ROOT, max_lines: int = DEFAULT_MAX_LINES) -> BloatBaseline:
    file_line_caps: dict[str, int] = {}
    for path in _iter_size_targets(root):
        rel = path.relative_to(root).as_posix()
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        if line_count > max_lines:
            file_line_caps[rel] = line_count

    vulture_count = len(_run_vulture_lines(root))
    baseline = BloatBaseline(
        max_lines=max_lines,
        file_line_caps=file_line_caps,
        vulture_findings=vulture_count,
    )
    baseline_path = root / BASELINE_REL_PATH
    baseline_path.parent.mkdir(parents=True, exist_ok=True)
    baseline_path.write_text(json.dumps(asdict(baseline), indent=2) + "\n", encoding="utf-8")
    return baseline


def check_oversized_files(
    root: Path = ROOT,
    max_lines: int = DEFAULT_MAX_LINES,
    baseline: BloatBaseline | None = None,
) -> list[BloatFinding]:
    active_baseline = baseline if baseline is not None else load_bloat_baseline(root)
    if active_baseline is not None:
        caps = active_baseline.file_line_caps
        use_caps = max_lines == active_baseline.max_lines
    else:
        caps = GRANDFATHERED_LINE_CAPS
        use_caps = max_lines == DEFAULT_MAX_LINES

    findings: list[BloatFinding] = []
    for path in _iter_size_targets(root):
        rel = path.relative_to(root).as_posix()
        line_count = len(path.read_text(encoding="utf-8").splitlines())
        limit = caps.get(rel, max_lines) if use_caps else max_lines
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
    proc = subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode == 0:
        return None
    tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[:8])
    return BloatFinding(category=label, file=".", detail=tail or f"exited with {proc.returncode}")


def skipped_node_analyzers(root: Path = ROOT) -> list[str]:
    """Node analyzers `--full` cannot run because `.sandcastle/node_modules` is missing."""
    if (root / ".sandcastle" / "node_modules").exists():
        return []
    return ["knip", "jscpd"]


def run_external_analyzers(
    root: Path = ROOT,
    baseline: BloatBaseline | None = None,
) -> list[BloatFinding]:
    active_baseline = baseline if baseline is not None else load_bloat_baseline(root)
    vulture_cap = active_baseline.vulture_findings if active_baseline is not None else 0

    findings: list[BloatFinding] = []
    vulture_lines = _run_vulture_lines(root)
    if len(vulture_lines) > vulture_cap:
        preview = "\n".join(vulture_lines[:8])
        findings.append(
            BloatFinding(
                category="vulture-dead-code",
                file=".",
                detail=(
                    f"{len(vulture_lines)} finding(s) exceeds baseline of {vulture_cap}:\n{preview}"
                ),
            )
        )

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
        "--init",
        action="store_true",
        help="Snapshot existing oversized files and vulture count into scripts/bloat-baseline.json",
    )
    parser.add_argument(
        "--full",
        action="store_true",
        help="Also run vulture (Python dead code), knip (TS dead code), and jscpd (clones)",
    )
    parser.add_argument("--json", action="store_true", help="Emit findings as JSON")
    args = parser.parse_args()

    if args.init:
        baseline = init_bloat_baseline(root=args.root, max_lines=args.max_lines)
        print(
            f"Initialized {BASELINE_REL_PATH.as_posix()}: "
            f"{len(baseline.file_line_caps)} grandfathered file(s), "
            f"{baseline.vulture_findings} baseline vulture finding(s)."
        )
        return 0

    baseline = load_bloat_baseline(args.root)
    findings = check_oversized_files(root=args.root, max_lines=args.max_lines, baseline=baseline)
    if args.full:
        findings.extend(run_external_analyzers(root=args.root, baseline=baseline))
    skipped = skipped_node_analyzers(args.root) if args.full else []
    if skipped:
        print(
            f"Anti-Bloat Guard WARNING: skipped {' + '.join(skipped)} "
            "(.sandcastle/node_modules missing; run `npm --prefix .sandcastle ci`).",
            file=sys.stderr,
        )

    if args.json:
        print(json.dumps([asdict(f) for f in findings], indent=2))
    elif findings:
        print(f"Anti-Bloat Guard FAILED — {len(findings)} issue(s) found:")
        for item in findings:
            print(f"  - [{item.category}] {item.file}: {item.detail}")
    else:
        ran = ["file-size", "vulture", *(t for t in ("knip", "jscpd") if t not in skipped)]
        mode = f"full ({' + '.join(ran)})" if args.full else "file-size ratchet"
        print(f"Anti-Bloat Guard PASS ({mode}).")

    return 1 if findings else 0


if __name__ == "__main__":
    raise SystemExit(main())
