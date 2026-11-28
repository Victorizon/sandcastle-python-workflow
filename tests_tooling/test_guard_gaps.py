"""Self-tests for cheats that used to slip past the guards (found by an adversarial test run)."""

from __future__ import annotations

import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
REJECT_PAIR = (
    "    assert result.decision is Decision.REJECT\n    assert result.auto_execute is False\n"
)
COPY_IGNORE = shutil.ignore_patterns(
    ".git", ".venv", "__pycache__", "*.pyc", ".pytest_cache", ".ruff_cache", "node_modules"
)


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=ci@example.test", "-c", "user.name=Workflow Test", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def _init_temp_git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    shutil.copytree(ROOT, repo, ignore=COPY_IGNORE)
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "initial commit")
    return repo


def _run_test_guard(
    repo: Path, extra_args: list[str] | None = None
) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(ROOT / "scripts" / "test_guard.py"), "--root", str(repo)]
    cmd += ["--base", "main", *(extra_args or [])]
    return subprocess.run(
        cmd, cwd=repo, capture_output=True, text=True, encoding="utf-8", check=False
    )


def _edit_tests(repo: Path, old: str, new: str) -> None:
    test_file = repo / "tests" / "test_order_triage.py"
    text = test_file.read_text(encoding="utf-8")
    assert old in text
    test_file.write_text(text.replace(old, new, 1), encoding="utf-8")


def test_blocks_new_root_conftest_that_patches_code(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    (repo / "conftest.py").write_text("import pytest\n", encoding="utf-8")
    (repo / "pytest.ini").write_text("[pytest]\naddopts = -k 'not rejected'\n", encoding="utf-8")
    (repo / "tests" / "sub").mkdir()
    (repo / "tests" / "sub" / "conftest.py").write_text("x = 1\n", encoding="utf-8")

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "conftest.py: new pytest config/hook file" in res.stdout
    assert "pytest.ini: new pytest config/hook file" in res.stdout
    assert "tests/sub/conftest.py: new pytest config/hook file" in res.stdout


def test_allow_harness_edit_permits_intentional_conftest(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    (repo / "conftest.py").write_text("import pytest\n", encoding="utf-8")

    res = _run_test_guard(repo, ["--allow-harness-edit"])

    assert res.returncode == 0, res.stdout


def test_blocks_weakened_assertion_with_same_count(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    _edit_tests(
        repo,
        REJECT_PAIR,
        "    assert result.decision in (Decision.REJECT, Decision.AUTO_APPROVE)\n"
        "    assert result.auto_execute in (False, True)\n",
    )

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "existing assertion rewritten or removed" in res.stdout
    assert "result.decision is Decision.REJECT" in res.stdout


def test_allows_adding_assertions_to_existing_test(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    _edit_tests(repo, REJECT_PAIR, REJECT_PAIR + "    assert result.reason\n")

    res = _run_test_guard(repo)

    assert res.returncode == 0, res.stdout


def test_blocks_suppressed_raised_and_dead_assertions(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    (repo / "tests" / "test_sneaky_more.py").write_text(
        "import contextlib\n"
        "import pytest\n\n"
        "def test_suppressed() -> None:\n"
        "    with contextlib.suppress(AssertionError):\n"
        "        assert 1 + 1 == 3\n\n"
        "def test_inverted_with_raises() -> None:\n"
        "    with pytest.raises(AssertionError):\n"
        "        assert 1 + 1 == 3\n\n"
        "def test_after_return() -> None:\n"
        "    value = 2\n"
        "    return\n"
        "    assert value == 3\n\n"
        "def test_not_true_branch() -> None:\n"
        "    value = 2\n"
        "    if not True:\n"
        "        assert value == 3\n",
        encoding="utf-8",
    )

    res = _run_test_guard(repo)

    assert res.returncode == 1
    for name in (
        "test_suppressed",
        "test_inverted_with_raises",
        "test_after_return",
        "test_not_true_branch",
    ):
        assert f"test_sneaky_more.py::{name}: swallowed" in res.stdout


def test_blocks_module_and_class_level_skips(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    (repo / "tests" / "test_skipped_module.py").write_text(
        "import pytest\n\n"
        "pytestmark = pytest.mark.skip\n\n"
        "@pytest.mark.xfail\n"
        "class TestThings:\n"
        "    def test_value(self) -> None:\n"
        "        value = 2\n"
        "        assert value == 2\n",
        encoding="utf-8",
    )

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "test_skipped_module.py: `pytestmark` with skip/xfail is banned." in res.stdout
    assert "class TestThings: skip/xfail class decorator is banned." in res.stdout


def test_moving_local_main_does_not_reset_the_baseline(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    _git(repo, "update-ref", "refs/remotes/origin/main", "HEAD")
    test_file = repo / "tests" / "test_order_triage.py"
    marker = "def test_high_risk_order_with_payment_only_and_unmatched_address_is_rejected"
    test_file.write_text(test_file.read_text(encoding="utf-8").split(marker)[0], encoding="utf-8")
    _git(repo, "commit", "-qam", "drop a test and commit it to local main")

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "deleted or renamed" in res.stdout


def test_mutation_sandbox_mirrors_root_conftest(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    (repo / "conftest.py").write_text(
        "def pytest_collection_modifyitems(config, items):\n    items[:] = []\n",
        encoding="utf-8",
    )

    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "mutation_check.py"), "--root", str(repo), "--all"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert res.returncode == 1
    assert "baseline pytest failed" in res.stdout


def test_anti_bloat_full_reports_skipped_node_analyzers(tmp_path: Path) -> None:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / "scripts" / "ok.py").write_text("VALUE = 1\n", encoding="utf-8")

    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "anti_bloat_guard.py"), "--root", str(repo)]
        + ["--full"],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert res.returncode == 0, res.stdout + res.stderr
    assert "skipped knip + jscpd" in res.stderr
    assert "PASS (full (file-size + vulture))" in res.stdout


def test_venv_run_reports_missing_tool(tmp_path: Path) -> None:
    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "venv_run.py"), "definitely-not-a-tool"],
        cwd=tmp_path,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )

    assert res.returncode == 127
    assert "not found in .venv" in res.stderr
