"""Deterministic Adversarial Scan Runner (`scripts/adversarial_scan.py`).

Auto-injected into `.sandcastle/review-prompt.md` so the Adversarial Reviewer wakes up
with hard mechanical findings before judging a diff:
1. `gitleaks` — 150+ secret formats + entropy scanning (when installed, e.g. in Docker).
2. `diff-cover` — enforces 100% test coverage on newly added/modified `src/` lines.
3. `opengrep` — runs offline custom adversarial SAST rules (`.sandcastle/adversarial-rules.yml`).
"""

from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
COVERAGE_XML = ".coverage.xml"


def _resolve_py_tool(name: str) -> str | None:
    for candidate_name in (name, f"{name}.exe") if sys.platform == "win32" else (name,):
        candidate = Path(sys.executable).parent / candidate_name
        if candidate.exists():
            return str(candidate)
    return shutil.which(name)


def _run_gitleaks(root: Path) -> tuple[str, bool, str]:
    gitleaks = shutil.which("gitleaks")
    if gitleaks is None:
        return ("gitleaks", True, "skipped (binary not installed on host; pre-baked in Docker)")
    proc = subprocess.run(
        [gitleaks, "detect", "--no-banner", "--redact", "--source", str(root)],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        return ("gitleaks", True, "0 secrets detected")
    tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[:8])
    return ("gitleaks", False, tail or f"exited {proc.returncode}")


def _resolve_base_ref(root: Path, base_ref: str) -> str | None:
    for candidate in (base_ref, f"origin/{base_ref}"):
        proc = subprocess.run(
            ["git", "rev-parse", "--verify", "--quiet", candidate],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if proc.returncode == 0:
            return candidate
    return None


def _run_diff_cover(root: Path, base_ref: str) -> tuple[str, bool, str]:
    pytest_bin = _resolve_py_tool("pytest")
    diff_cover_bin = _resolve_py_tool("diff-cover")
    if pytest_bin is None or diff_cover_bin is None:
        return ("diff-cover", True, "skipped (pytest or diff-cover not installed)")
    resolved_base = _resolve_base_ref(root, base_ref)
    if resolved_base is None:
        return ("diff-cover", True, f"skipped (git base ref `{base_ref}` not found)")

    cov_path = root / COVERAGE_XML
    try:
        test_proc = subprocess.run(
            [pytest_bin, "--cov=src", f"--cov-report=xml:{COVERAGE_XML}", "-q"],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if test_proc.returncode != 0:
            return (
                "diff-cover",
                False,
                f"pytest failed before diff-cover ({test_proc.returncode})",
            )

        dc_proc = subprocess.run(
            [
                diff_cover_bin,
                COVERAGE_XML,
                f"--compare-branch={resolved_base}",
                "--fail-under=100",
            ],
            cwd=root,
            capture_output=True,
            text=True,
            check=False,
        )
        if dc_proc.returncode == 0:
            return ("diff-cover", True, f"100% coverage on changed src/ lines vs {resolved_base}")
        tail = "\n".join((dc_proc.stdout + "\n" + dc_proc.stderr).strip().splitlines()[:10])
        return ("diff-cover", False, tail or f"exited {dc_proc.returncode}")
    finally:
        cov_path.unlink(missing_ok=True)


def _run_opengrep(root: Path) -> tuple[str, bool, str]:
    opengrep = shutil.which("opengrep")
    rules = root / ".sandcastle" / "adversarial-rules.yml"
    if opengrep is None or not rules.exists():
        return ("opengrep", True, "skipped (binary not installed on host; pre-baked in Docker)")
    targets = [d for d in ("src", "scripts", ".sandcastle") if (root / d).exists()]
    if not targets:
        return ("opengrep", True, "no targets")
    proc = subprocess.run(
        [
            opengrep,
            "scan",
            "--config",
            str(rules),
            "--error",
            "--quiet",
            "--exclude",
            "node_modules",
            *targets,
        ],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        return ("opengrep", True, "0 adversarial SAST rule violations")
    tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[:10])
    return ("opengrep", False, tail or f"exited {proc.returncode}")


def _run_crosshair(root: Path) -> tuple[str, bool, str]:
    crosshair_bin = _resolve_py_tool("crosshair")
    src_dir = root / "src"
    if crosshair_bin is None or not src_dir.exists():
        return ("crosshair", True, "skipped (crosshair not installed or src/ missing)")
    proc = subprocess.run(
        [
            crosshair_bin,
            "check",
            str(src_dir),
            "--analysis_kind=asserts,PEP316",
            "--per_condition_timeout=3",
            "--per_path_timeout=1",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode == 0:
        return ("crosshair", True, "0 symbolic counterexamples found in src/")
    tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[:10])
    return ("crosshair", False, tail or f"exited {proc.returncode}")


def main() -> int:
    parser = argparse.ArgumentParser(description="Deterministic Adversarial Scan Runner")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root directory")
    parser.add_argument(
        "--base", default="main", help="Git base ref for diff-cover (default: main)"
    )
    args = parser.parse_args()

    results = [
        _run_gitleaks(args.root),
        _run_diff_cover(args.root, args.base),
        _run_opengrep(args.root),
        _run_crosshair(args.root),
    ]

    failed = False
    print("=== Deterministic Adversarial Scan ===")
    for name, ok, detail in results:
        tag = "[PASS]" if ok else "[FAIL]"
        print(f"{tag} {name}: {detail}")
        if not ok:
            failed = True
    return 1 if failed else 0


if __name__ == "__main__":
    raise SystemExit(main())
