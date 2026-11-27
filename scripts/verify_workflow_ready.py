"""Binary workflow readiness verifier (`python scripts/verify_workflow_ready.py`).

Checks all 5 structural & runtime layers of the Matt Pocock + Sandcastle workflow
deterministically so you know with 100% certainty when setup is ready to ship code.
"""

from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _exists_all(paths: list[str]) -> tuple[bool, str]:
    missing = [p for p in paths if not (ROOT / p).exists()]
    if missing:
        return False, f"missing: {', '.join(missing)}"
    return True, f"all {len(paths)} required file(s) present"


def check_layer_1() -> tuple[bool, str]:
    ok, msg = _exists_all(
        [
            "AGENTS.md",
            "docs/agents/issue-tracker.md",
            "docs/agents/triage-labels.md",
            "docs/agents/domain.md",
        ]
    )
    if not ok:
        return False, msg
    agents_text = (ROOT / "AGENTS.md").read_text(encoding="utf-8")
    lines = len(agents_text.splitlines())
    if lines > 120:
        return False, f"AGENTS.md too large ({lines} lines; keep <= 120 lines)"
    required_markers = ["## Agent skills", "2-strike retry ceiling", "Fresh subagent contexts"]
    missing_markers = [m for m in required_markers if m not in agents_text]
    if missing_markers:
        return False, f"AGENTS.md missing guardrails: {', '.join(missing_markers)}"
    return True, f"AGENTS.md lean ({lines} lines) + Codex guardrails + docs/agents/* configured"


def check_layer_2() -> tuple[bool, str]:
    return _exists_all(
        [
            "GLOSSARY.md",
            "CODING_STANDARDS.md",
            ".out-of-scope/README.md",
            "docs/adr/0001-external-client-adapter-boundary.md",
            "docs/adr/0002-fail-closed-decisions.md",
        ]
    )


def check_layer_3() -> tuple[bool, str]:
    ok, msg = _exists_all(
        [
            "pyproject.toml",
            "requirements-dev.txt",
            ".pre-commit-config.yaml",
            "scripts/ratchet.py",
            "scripts/ratchet-baseline.json",
            "scripts/branch_guard.py",
            "scripts/test_guard.py",
            "scripts/coverage-baseline.json",
            "scripts/mutation_check.py",
            "scripts/check.py",
            "LEGACY_REFACTORING_PLAYBOOK.md",
        ]
    )
    if not ok:
        return False, msg
    proc = subprocess.run(
        [sys.executable, "scripts/check.py"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        tail = "\n".join((proc.stdout + "\n" + proc.stderr).strip().splitlines()[-8:])
        return False, f"`python scripts/check.py` failed:\n{tail}"
    return True, "`python scripts/check.py` (all 6 Python gates) PASSED"


def check_layer_4() -> tuple[bool, str]:
    ok, msg = _exists_all(
        [
            "scripts/local_tracker.py",
            ".github/PULL_REQUEST_TEMPLATE.md",
            ".github/workflows/ci.yml",
            ".github/workflows/ratchet-shrink.yml",
            "docs/agents/issue-tracker.github.md",
        ]
    )
    if not ok:
        return False, msg
    proc = subprocess.run(
        [
            sys.executable,
            "scripts/local_tracker.py",
            "list",
            "--status",
            "ready-for-agent",
            "--json",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        check=False,
    )
    if proc.returncode != 0:
        return False, f"local_tracker.py failed: {proc.stderr.strip()}"
    return True, "local tracker CLI + PR rubric + GitHub CI/ratchet-shrink switchover files ready"


def _check_sandcastle_runtime() -> tuple[bool, str]:
    home = os.environ.get("HOME")
    if not home:
        return False, "HOME env var unset (run inside WSL2 or set HOME=$env:USERPROFILE)"
    auth_json = Path(home) / ".codex" / "auth.json"
    if not auth_json.exists():
        return False, f"missing {auth_json} (run `codex login` in WSL2)"
    if shutil.which("docker") is None:
        return False, "docker CLI not found in PATH"
    docker_info = subprocess.run(["docker", "info"], capture_output=True, text=True, check=False)
    if docker_info.returncode != 0:
        return False, "Docker daemon not reachable (enable WSL2 integration in Docker Desktop)"
    return True, "Sandcastle files + HOME + ~/.codex/auth.json + Docker daemon READY"


def check_layer_5(skip_runtime: bool) -> tuple[bool, str]:
    ok, msg = _exists_all(
        [
            ".sandcastle/Dockerfile",
            ".sandcastle/package.json",
            ".sandcastle/tsconfig.json",
            ".sandcastle/run.ts",
            ".sandcastle/drift-watchdog.ts",
            ".sandcastle/drift-watchdog.test.ts",
            ".sandcastle/dashboard.ts",
            ".sandcastle/dashboard-ui.ts",
            ".sandcastle/dashboard.test.ts",
            ".sandcastle/run-history.ts",
            ".sandcastle/tuner.ts",
            ".sandcastle/tuner.test.ts",
            ".sandcastle/tune-prompt.md",
            ".sandcastle/goal-core.ts",
            ".sandcastle/goal.ts",
            ".sandcastle/goal.example.json",
            ".sandcastle/gap-plan-prompt.md",
            ".sandcastle/nightly-arch.ts",
            ".sandcastle/nightly-arch-prompt.md",
            ".sandcastle/bakeoff.ts",
            ".sandcastle/bakeoff-variant-prompt.md",
            ".sandcastle/bakeoff-judge-prompt.md",
            ".sandcastle/autonomy-modes.test.ts",
            ".sandcastle/e2e-synthetic.ts",
            "docs/AUTONOMY_AND_BOTS_GUIDE.md",
            ".sandcastle/plan-prompt.md",
            ".sandcastle/implement-prompt.md",
            ".sandcastle/review-prompt.md",
            ".sandcastle/decompose-prompt.md",
            ".sandcastle/merge-prompt.md",
        ]
    )
    if not ok:
        return False, msg
    if skip_runtime:
        return True, "Sandcastle files present (runtime Docker/auth check skipped via --offline)"
    return _check_sandcastle_runtime()


def main() -> int:
    parser = argparse.ArgumentParser(description="Verify Matt Pocock workflow readiness")
    parser.add_argument(
        "--offline",
        action="store_true",
        help="Skip live Docker daemon & ~/.codex/auth.json runtime checks",
    )
    args = parser.parse_args()

    checks = [
        ("Layer 1 — Harness & Loop Guards", check_layer_1()),
        ("Layer 2 — Domain & Standards Docs", check_layer_2()),
        ("Layer 3 — Brake 1 (6-Gate Python Verification)", check_layer_3()),
        ("Layer 4 — Tracker, PR Rubric & GitHub CI Templates", check_layer_4()),
        ("Layer 5 — Sandcastle Codex Orchestrator", check_layer_5(args.offline)),
    ]

    all_passed = True
    print("=== Workflow Readiness Report ===\n")
    for name, (passed, detail) in checks:
        tag = "[PASS]" if passed else "[FAIL]"
        print(f"{tag} {name}\n       {detail}")
        if not passed:
            all_passed = False

    status_line = (
        "WORKFLOW READY — start shipping code."
        if all_passed
        else "WORKFLOW NOT READY — fix [FAIL] items above."
    )
    print(f"\n{status_line}")
    return 0 if all_passed else 1


if __name__ == "__main__":
    raise SystemExit(main())
