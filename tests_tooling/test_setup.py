"""Unit tests for the cross-platform installer (`scripts/setup.py`) and readiness verifier."""

from __future__ import annotations

import importlib.util
import json
import subprocess
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parent.parent


def _load_setup_module() -> ModuleType:
    spec = importlib.util.spec_from_file_location("setup_script", ROOT / "scripts" / "setup.py")
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


setup_mod = _load_setup_module()


def test_parse_semver_major() -> None:
    assert setup_mod.parse_semver_major("v22.14.0\n") == 22
    assert setup_mod.parse_semver_major("20.11.1") == 20
    assert setup_mod.parse_semver_major("not-a-version") is None


def test_wsl_mounted_windows_path_detection() -> None:
    assert setup_mod.is_wsl_mounted_windows_path(Path("/mnt/c/Users/dev/repo"), "linux") is True
    assert setup_mod.is_wsl_mounted_windows_path(Path("/home/dev/repo"), "linux") is False
    assert setup_mod.is_wsl_mounted_windows_path(Path("/mnt/c/Users/dev/repo"), "win32") is False


def test_detect_agent_auth_recognizes_codex_and_claude(tmp_path: Path) -> None:
    home = tmp_path / "home"
    repo = tmp_path / "repo"
    home.mkdir()
    repo.mkdir()

    ok, detail = setup_mod.detect_agent_auth(env={}, home_dir=home, repo_root=repo)
    assert ok is False
    assert "no Codex" in detail

    # Codex auth file
    (home / ".codex").mkdir()
    (home / ".codex" / "auth.json").write_text("{}", encoding="utf-8")
    ok_codex, detail_codex = setup_mod.detect_agent_auth(env={}, home_dir=home, repo_root=repo)
    assert ok_codex is True
    assert "Codex" in detail_codex

    # Claude env token (without Codex)
    (home / ".codex" / "auth.json").unlink()
    ok_claude, detail_claude = setup_mod.detect_agent_auth(
        env={"CLAUDE_CODE_OAUTH_TOKEN": "tok"}, home_dir=home, repo_root=repo
    )
    assert ok_claude is True
    assert "Claude Code" in detail_claude


def test_setup_check_only_runs_cleanly_without_mutating_repo() -> None:
    res = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "setup.py"),
            "--check-only",
            "--skip-docker",
            "--skip-node",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Preflight PASS." in res.stdout


def test_verify_workflow_ready_offline_json() -> None:
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "verify_workflow_ready.py"), "--offline", "--json"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    data = json.loads(res.stdout)
    assert data["ready"] is True
    assert len(data["layers"]) == 5
    assert all(layer["passed"] is True for layer in data["layers"])


def test_setup_detects_broken_partial_venv_as_missing_python(tmp_path: Path) -> None:
    (tmp_path / ".venv").mkdir()
    assert setup_mod._venv_python(tmp_path).is_file() is False
