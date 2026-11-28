"""Idempotent cross-platform installer & environment doctor (`python scripts/setup.py`).

Uses Python stdlib only so it runs cleanly *before* `.venv` exists on Windows, WSL2, macOS,
and Linux. Validates prerequisites upfront, installs Python/Node/hooks/Docker layers idempotently,
and finishes by running `scripts/verify_workflow_ready.py`.

Usage:
  python scripts/setup.py                 # Full idempotent setup + verification
  python scripts/setup.py --check-only    # Doctor-only preflight check (zero changes)
  python scripts/setup.py --skip-docker   # Python + Node setup without Docker image build
  python scripts/setup.py --skip-node     # Python-only setup (no Node/Sandcastle)
  python scripts/setup.py --init-baselines  # Capture fresh ratchet baseline on an existing repo
"""

from __future__ import annotations

import argparse
import os
import re
import shutil
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MIN_PYTHON = (3, 11)
MIN_NODE_MAJOR = 20
DEFAULT_DOCKER_IMAGE = os.environ.get("SANDCASTLE_IMAGE", "sandcastle:python-codex")


@dataclass(frozen=True)
class CheckResult:
    name: str
    status: str  # "PASS" | "WARN" | "FAIL"
    detail: str
    hint: str = ""


def parse_semver_major(version_output: str) -> int | None:
    match = re.search(r"v?(\d+)\.\d+", version_output.strip())
    return int(match.group(1)) if match else None


def is_wsl_mounted_windows_path(repo_root: Path, platform_name: str = sys.platform) -> bool:
    if not platform_name.startswith("linux"):
        return False
    return repo_root.as_posix().startswith("/mnt/")


def detect_agent_auth(
    env: dict[str, str] | None = None,
    home_dir: Path | None = None,
    repo_root: Path = ROOT,
) -> tuple[bool, str]:
    active_env = env if env is not None else dict(os.environ)
    resolved_home = home_dir
    if resolved_home is None:
        raw_home = active_env.get("HOME") or active_env.get("USERPROFILE")
        resolved_home = Path(raw_home) if raw_home else Path.home()

    codex_auth = resolved_home / ".codex" / "auth.json"
    claude_creds = resolved_home / ".claude" / ".credentials.json"
    sandcastle_env = repo_root / ".sandcastle" / ".env"

    found: list[str] = []
    if codex_auth.is_file():
        found.append(f"Codex ({codex_auth})")
    if (
        claude_creds.is_file()
        or bool(active_env.get("CLAUDE_CODE_OAUTH_TOKEN"))
        or sandcastle_env.is_file()
    ):
        found.append("Claude Code")
    if found:
        return True, f"authenticated: {', '.join(found)}"
    return (
        False,
        "no Codex (~/.codex/auth.json) or Claude credentials found "
        "(run `codex login` or configure Claude before running Sandcastle containers)",
    )


def _run_capture(cmd: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def _venv_python(root: Path = ROOT) -> Path:
    win_py = root / ".venv" / "Scripts" / "python.exe"
    if win_py.is_file():
        return win_py
    unix_py = root / ".venv" / "bin" / "python"
    if unix_py.is_file():
        return unix_py
    return win_py if sys.platform == "win32" else unix_py


def _venv_tool(name: str, root: Path = ROOT) -> Path | None:
    for candidate in (
        root / ".venv" / "Scripts" / f"{name}.exe",
        root / ".venv" / "Scripts" / name,
        root / ".venv" / "bin" / name,
    ):
        if candidate.is_file():
            return candidate
    return None


def _check_node_prereq(repo_root: Path) -> CheckResult:
    if shutil.which("node") is None or shutil.which("npm") is None:
        return CheckResult(
            "Node.js + npm",
            "FAIL",
            "node or npm not found in PATH",
            f"Install Node.js >= {MIN_NODE_MAJOR} (or pass --skip-node for Python-only).",
        )
    node_out = _run_capture(["node", "--version"], cwd=repo_root)
    major = parse_semver_major(node_out.stdout)
    if major is not None and major >= MIN_NODE_MAJOR:
        return CheckResult("Node.js + npm", "PASS", node_out.stdout.strip())
    return CheckResult(
        "Node.js + npm",
        "FAIL",
        f"Node {node_out.stdout.strip() or 'unknown'} < v{MIN_NODE_MAJOR}",
        f"Upgrade to Node.js >= {MIN_NODE_MAJOR} (or pass --skip-node).",
    )


def _check_docker_prereq(repo_root: Path) -> list[CheckResult]:
    if shutil.which("docker") is None:
        docker_res = CheckResult(
            "Docker",
            "FAIL",
            "docker CLI not found in PATH",
            "Install Docker Desktop (or pass --skip-docker for local Python/Node only).",
        )
    else:
        info = _run_capture(["docker", "info"], cwd=repo_root)
        docker_res = (
            CheckResult("Docker", "PASS", "daemon reachable")
            if info.returncode == 0
            else CheckResult(
                "Docker",
                "FAIL",
                "Docker daemon not reachable",
                "Start Docker Desktop (with WSL2 integration) or pass --skip-docker.",
            )
        )
    auth_ok, auth_detail = detect_agent_auth(repo_root=repo_root)
    auth_res = CheckResult(
        "Agent Auth",
        "PASS" if auth_ok else "WARN",
        auth_detail,
        "" if auth_ok else "Run `codex login` (or set CLAUDE_CODE_OAUTH_TOKEN).",
    )
    return [docker_res, auth_res]


def run_preflight_checks(
    *,
    skip_node: bool,
    skip_docker: bool,
    repo_root: Path = ROOT,
) -> list[CheckResult]:
    results: list[CheckResult] = []

    py_ver = sys.version_info[:2]
    if py_ver >= MIN_PYTHON:
        results.append(CheckResult("Python", "PASS", f"{py_ver[0]}.{py_ver[1]} ({sys.executable})"))
    else:
        results.append(
            CheckResult(
                "Python",
                "FAIL",
                f"{py_ver[0]}.{py_ver[1]} is below {MIN_PYTHON[0]}.{MIN_PYTHON[1]}",
                f"Install Python >= {MIN_PYTHON[0]}.{MIN_PYTHON[1]} and re-run.",
            )
        )

    git_bin = shutil.which("git")
    if git_bin is None:
        results.append(CheckResult("Git", "FAIL", "git not found in PATH", "Install git first."))
    else:
        in_repo = _run_capture(["git", "rev-parse", "--is-inside-work-tree"], cwd=repo_root)
        if in_repo.returncode == 0 and in_repo.stdout.strip() == "true":
            results.append(CheckResult("Git", "PASS", f"repo detected ({git_bin})"))
        else:
            results.append(
                CheckResult(
                    "Git",
                    "FAIL",
                    f"{repo_root} is not a git repository",
                    "Run `git init` and make an initial commit first.",
                )
            )

    if is_wsl_mounted_windows_path(repo_root):
        results.append(
            CheckResult(
                "WSL2 Filesystem",
                "WARN",
                f"Repo is on {repo_root} (/mnt/* is slow for Docker mounts and git worktrees)",
                "Move repo to Linux ext4 (e.g. ~/code/<repo>) for best performance.",
            )
        )

    if not skip_node:
        results.append(_check_node_prereq(repo_root))
    if not skip_docker:
        results.extend(_check_docker_prereq(repo_root))

    return results


def _run_step(label: str, cmd: list[str], cwd: Path = ROOT) -> bool:
    print(f"\n==> {label}")
    print(f"    $ {' '.join(cmd)}")
    proc = subprocess.run(cmd, cwd=cwd, check=False)
    if proc.returncode != 0:
        print(f"[FAIL] {label} (exit {proc.returncode})", file=sys.stderr)
        return False
    print(f"[PASS] {label}")
    return True


def _setup_python_venv(repo_root: Path) -> bool:
    uv_bin = shutil.which("uv")
    venv_dir = repo_root / ".venv"
    if not venv_dir.exists():
        cmd = [uv_bin, "venv", ".venv"] if uv_bin else [sys.executable, "-m", "venv", ".venv"]
        if not _run_step("Create Python .venv", cmd, cwd=repo_root):
            return False
    else:
        print("\n==> Create Python .venv\n[PASS] Already exists (.venv)")

    py_bin = _venv_python(repo_root)
    if uv_bin:
        return _run_step(
            "Install Python dev dependencies (uv)",
            [
                uv_bin,
                "pip",
                "install",
                "--python",
                str(py_bin),
                "-r",
                "requirements-dev.txt",
                "-e",
                ".",
            ],
            cwd=repo_root,
        )
    if not _run_step(
        "Upgrade pip", [str(py_bin), "-m", "pip", "install", "--upgrade", "pip"], cwd=repo_root
    ):
        return False
    return _run_step(
        "Install Python dev dependencies (pip)",
        [str(py_bin), "-m", "pip", "install", "-r", "requirements-dev.txt", "-e", "."],
        cwd=repo_root,
    )


def _setup_hooks(repo_root: Path) -> bool:
    pre_commit = _venv_tool("pre-commit", repo_root)
    if pre_commit is None:
        print(
            "[WARN] pre-commit not found in .venv; skipping git hook installation.", file=sys.stderr
        )
        return True
    return _run_step(
        "Install git pre-commit & pre-push hooks",
        [str(pre_commit), "install", "--hook-type", "pre-commit", "--hook-type", "pre-push"],
        cwd=repo_root,
    )


def _setup_node(repo_root: Path) -> bool:
    npm_cmd = "npm.cmd" if sys.platform == "win32" else "npm"
    if not _run_step(
        "Install Sandcastle Node dependencies",
        [npm_cmd, "--prefix", ".sandcastle", "ci"],
        cwd=repo_root,
    ):
        return False
    return _run_step(
        "Typecheck Sandcastle orchestrator",
        [npm_cmd, "--prefix", ".sandcastle", "run", "typecheck"],
        cwd=repo_root,
    )


def _setup_docker(repo_root: Path, rebuild: bool) -> bool:
    if not rebuild:
        inspect = _run_capture(["docker", "image", "inspect", DEFAULT_DOCKER_IMAGE], cwd=repo_root)
        if inspect.returncode == 0:
            print(
                f"\n==> Build Docker image ({DEFAULT_DOCKER_IMAGE})\n"
                "[PASS] Image already built (use --rebuild-docker to force rebuild)"
            )
            return True
    return _run_step(
        f"Build Docker image ({DEFAULT_DOCKER_IMAGE})",
        ["docker", "build", "-f", ".sandcastle/Dockerfile", "-t", DEFAULT_DOCKER_IMAGE, "."],
        cwd=repo_root,
    )


def _print_preflight(results: list[CheckResult]) -> bool:
    print("=== Preflight Environment Check ===\n")
    has_fail = False
    for item in results:
        print(f"[{item.status}] {item.name}: {item.detail}")
        if item.hint:
            print(f"       Fix: {item.hint}")
        if item.status == "FAIL":
            has_fail = True
    return not has_fail


def _run_install_pipeline(args: argparse.Namespace) -> bool:
    if not (
        _setup_python_venv(ROOT)
        and (args.skip_hooks or _setup_hooks(ROOT))
        and (args.skip_node or _setup_node(ROOT))
        and (args.skip_docker or _setup_docker(ROOT, rebuild=args.rebuild_docker))
    ):
        return False

    py_bin = _venv_python(ROOT)
    if args.init_baselines and not _run_step(
        "Initialize ratchet baseline", [str(py_bin), "scripts/ratchet.py", "--init"], cwd=ROOT
    ):
        return False

    verify_cmd = [str(py_bin), "scripts/verify_workflow_ready.py"]
    if args.skip_docker:
        verify_cmd.append("--offline")
    return _run_step("Verify workflow readiness", verify_cmd, cwd=ROOT)


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(
        description="Idempotent installer & doctor for sandcastle-python-workflow"
    )
    parser.add_argument(
        "--check-only", action="store_true", help="Run preflight checks only without making changes"
    )
    parser.add_argument(
        "--skip-node", action="store_true", help="Skip Node.js / .sandcastle npm install"
    )
    parser.add_argument(
        "--skip-docker", action="store_true", help="Skip Docker daemon check & image build"
    )
    parser.add_argument(
        "--skip-hooks", action="store_true", help="Skip installing git pre-commit/pre-push hooks"
    )
    parser.add_argument(
        "--rebuild-docker", action="store_true", help="Force rebuild the Sandcastle Docker image"
    )
    parser.add_argument(
        "--init-baselines",
        action="store_true",
        help="Capture initial ratchet baseline from current repo state (for existing repos)",
    )
    args = parser.parse_args(argv)

    checks = run_preflight_checks(skip_node=args.skip_node, skip_docker=args.skip_docker)
    preflight_ok = _print_preflight(checks)
    if args.check_only:
        print(
            "\nPreflight PASS."
            if preflight_ok
            else "\nPreflight FAILED — resolve [FAIL] items above."
        )
        return 0 if preflight_ok else 1
    if not preflight_ok:
        print(
            "\nSetup aborted — fix the [FAIL] prerequisites above and re-run setup.py.",
            file=sys.stderr,
        )
        return 1
    if not _run_install_pipeline(args):
        return 1

    print("\nSETUP COMPLETE. Next steps:")
    print("  1. Inspect tickets:  python scripts/local_tracker.py board")
    print("  2. Run Sandcastle:   npm --prefix .sandcastle run factory")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
