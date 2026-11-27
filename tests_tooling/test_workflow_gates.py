"""Adversarial self-tests proving our mechanical anti-cheat locks actually catch cheats."""

from __future__ import annotations

import json
import shutil
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def _init_temp_git_repo(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    ignore = shutil.ignore_patterns(
        ".git",
        ".venv",
        "__pycache__",
        "*.pyc",
        ".pytest_cache",
        ".ruff_cache",
        "node_modules",
        "*.egg-info",
    )
    shutil.copytree(ROOT, repo, ignore=ignore)
    subprocess.run(["git", "init", "-b", "main"], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "config", "user.email", "ci@example.test"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    subprocess.run(
        ["git", "config", "user.name", "Workflow Test"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "initial commit"], cwd=repo, check=True, capture_output=True
    )
    return repo


def _run_test_guard(
    repo: Path, extra_args: list[str] | None = None
) -> subprocess.CompletedProcess[str]:
    cmd = [
        sys.executable,
        str(ROOT / "scripts" / "test_guard.py"),
        "--root",
        str(repo),
        "--base",
        "main",
    ]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=False)


def test_blocks_deleting_existing_test_function(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    test_file = repo / "tests" / "test_order_triage.py"
    text = test_file.read_text(encoding="utf-8")
    # Delete the last test function
    marker = "def test_high_risk_order_with_payment_only_and_unmatched_address_is_rejected"
    test_file.write_text(text.split(marker)[0], encoding="utf-8")

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "deleted or renamed" in res.stdout


def test_blocks_reducing_assertion_count_on_existing_test(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    test_file = repo / "tests" / "test_order_triage.py"
    text = test_file.read_text(encoding="utf-8")
    weakened = text.replace("    assert result.auto_execute is False\n", "", 1)
    test_file.write_text(weakened, encoding="utf-8")

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "assertion count dropped" in res.stdout


def test_blocks_trivial_assert_true_and_skip_markers(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    new_test = repo / "tests" / "test_cheat_attempt.py"
    new_test.write_text(
        "import pytest\n\n"
        "@pytest.mark.skip(reason='lazy')\n"
        "def test_skipped() -> None:\n"
        "    assert True\n",
        encoding="utf-8",
    )

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "skip/xfail is banned" in res.stdout
    assert "tautological/trivial assertion" in res.stdout


def test_blocks_modifying_existing_replay_fixture(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    fixture = repo / "tests" / "fixtures" / "order_triage" / "high_risk_unverified_reject.json"
    data = json.loads(fixture.read_text(encoding="utf-8"))
    data["signals"][0]["risk_tier"] = "low"
    fixture.write_text(json.dumps(data, indent=2), encoding="utf-8")

    res = _run_test_guard(repo)

    assert res.returncode == 1
    assert "modified existing replay fixture" in res.stdout


def test_allows_adding_brand_new_test_and_fixture(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    new_fixture = repo / "tests" / "fixtures" / "order_triage" / "brand_new_case.json"
    new_fixture.write_text('{"signals": []}\n', encoding="utf-8")
    new_test = repo / "tests" / "test_added_case.py"
    new_test.write_text(
        "def test_new_behavior() -> None:\n    result = 2 + 2\n    assert result == 4\n",
        encoding="utf-8",
    )

    res = _run_test_guard(repo)

    assert res.returncode == 0
    assert "Test Guard PASS" in res.stdout


def test_blocks_coverage_drop_below_monotonic_floor(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    cov_json = repo / "fake_cov.json"
    cov_json.write_text(json.dumps({"totals": {"percent_covered": 80.0}}), encoding="utf-8")

    res = _run_test_guard(repo, ["--coverage-json", str(cov_json)])

    assert res.returncode == 1
    assert "Coverage dropped below monotonic floor" in res.stdout


def test_mutation_checker_catches_weak_tests(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    # Replace tests with a lazy test that runs the function but barely asserts anything
    test_file = repo / "tests" / "test_order_triage.py"
    test_file.write_text(
        "from pathlib import Path\n"
        "from app.processors.order_triage import triage_order\n"
        "from tests.fakes.fake_external_client import FakeExternalClient\n\n"
        "FIXTURES = Path(__file__).parent / 'fixtures' / 'order_triage'\n\n"
        "def test_lazy_smoke() -> None:\n"
        "    client = FakeExternalClient.from_fixture_file(\n"
        "        FIXTURES / 'allowlisted_verified_auto_approve.json'\n"
        "    )\n"
        "    result = triage_order('ord-ok-002', client)\n"
        "    assert result.order_id == 'ord-ok-002'\n",
        encoding="utf-8",
    )

    proc = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "mutation_check.py"), "--root", str(repo)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )

    assert proc.returncode == 1
    assert "Mutation check FAILED" in proc.stdout


def test_local_tracker_lifecycle_roundtrip(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    tracker = str(ROOT / "scripts" / "local_tracker.py")

    listed = subprocess.run(
        [
            sys.executable,
            tracker,
            "--root",
            str(repo),
            "list",
            "--status",
            "ready-for-agent",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    items = json.loads(listed.stdout)
    assert len(items) == 1
    ticket_id = items[0]["id"]
    assert items[0]["open_blockers"] == []

    subprocess.run(
        [sys.executable, tracker, "--root", str(repo), "resolve", ticket_id, "--summary", "Done"],
        capture_output=True,
        text=True,
        check=True,
    )

    listed_after = subprocess.run(
        [
            sys.executable,
            tracker,
            "--root",
            str(repo),
            "list",
            "--status",
            "ready-for-agent",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    assert json.loads(listed_after.stdout) == []


def test_branch_guard_blocks_direct_src_commit_on_main(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    target = repo / "src" / "app" / "processors" / "order_triage.py"
    target.write_text(target.read_text(encoding="utf-8") + "\n# direct edit\n", encoding="utf-8")
    subprocess.run(["git", "add", str(target)], cwd=repo, check=True, capture_output=True)

    res = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "branch_guard.py"), "--root", str(repo)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )

    assert res.returncode == 1
    assert "direct commits modifying `src/` on `main` are blocked" in res.stdout


def test_branch_guard_allows_scratch_on_main_and_src_on_feature_branch(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    spec_file = repo / ".scratch" / "workflow-smoke-test" / "spec.md"
    spec_file.write_text(spec_file.read_text(encoding="utf-8") + "\nNote.\n", encoding="utf-8")
    subprocess.run(["git", "add", str(spec_file)], cwd=repo, check=True, capture_output=True)

    on_main = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "branch_guard.py"), "--root", str(repo)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert on_main.returncode == 0

    subprocess.run(
        ["git", "checkout", "-b", "sandcastle/feature-test"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    target = repo / "src" / "app" / "processors" / "order_triage.py"
    target.write_text(target.read_text(encoding="utf-8") + "\n# branch edit\n", encoding="utf-8")
    subprocess.run(["git", "add", str(target)], cwd=repo, check=True, capture_output=True)

    on_branch = subprocess.run(
        [sys.executable, str(ROOT / "scripts" / "branch_guard.py"), "--root", str(repo)],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert on_branch.returncode == 0


def test_local_tracker_auto_split_creates_subtickets_and_enforces_max_depth(
    tmp_path: Path,
) -> None:
    repo = _init_temp_git_repo(tmp_path)
    tracker = str(ROOT / "scripts" / "local_tracker.py")
    plan_file = tmp_path / "split_plan.json"
    plan_file.write_text(
        json.dumps(
            {
                "reason": "wall_clock_timeout after 20m",
                "subtickets": [
                    {
                        "title": "Add fixture for unknown risk_tier",
                        "what_to_build": "Add replay fixture and failing test.",
                        "acceptance_criteria": ["Fixture added"],
                        "blocked_by_indexes": [],
                    },
                    {
                        "title": "Reject unknown risk_tier in processor",
                        "what_to_build": "Implement fail-closed check in triage_order.",
                        "acceptance_criteria": ["check.py passes"],
                        "blocked_by_indexes": [0],
                    },
                ],
            }
        ),
        encoding="utf-8",
    )

    split_res = subprocess.run(
        [
            sys.executable,
            tracker,
            "--root",
            str(repo),
            "split",
            "workflow-smoke-test/01",
            "--plan-json",
            str(plan_file),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert split_res.returncode == 0
    created = json.loads(split_res.stdout)["created"]
    assert created == ["workflow-smoke-test/02", "workflow-smoke-test/03"]

    listed = subprocess.run(
        [
            sys.executable,
            tracker,
            "--root",
            str(repo),
            "list",
            "--status",
            "ready-for-agent",
            "--json",
        ],
        capture_output=True,
        text=True,
        check=True,
    )
    ready = json.loads(listed.stdout)
    assert [t["id"] for t in ready] == ["workflow-smoke-test/02", "workflow-smoke-test/03"]
    assert ready[0]["open_blockers"] == []
    assert ready[1]["open_blockers"] == ["workflow-smoke-test/02"]
    assert ready[0]["split_depth"] == 1

    # Hard cap: attempting to split a depth-1 child ticket again MUST fail
    second_split = subprocess.run(
        [
            sys.executable,
            tracker,
            "--root",
            str(repo),
            "split",
            "workflow-smoke-test/02",
            "--plan-json",
            str(plan_file),
        ],
        capture_output=True,
        text=True,
        check=False,
    )
    assert second_split.returncode == 1
    assert "split_depth=1 >= max=1" in second_split.stderr
