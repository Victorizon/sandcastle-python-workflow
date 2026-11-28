"""Adversarial self-tests proving our mechanical anti-cheat locks actually catch cheats."""

from __future__ import annotations

import json
import os
import shutil
import subprocess
import sys
import time
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


def test_gauntlet_blocks_tampering_with_harness_and_coverage_baseline(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)

    # Cheat 1: Agent lowers scripts/coverage-baseline.json from 100.0 -> 10.0
    cov_base = repo / "scripts" / "coverage-baseline.json"
    cov_base.write_text('{"min_percent": 10.0}\n', encoding="utf-8")
    cov_json = repo / "fake_cov.json"
    cov_json.write_text(json.dumps({"totals": {"percent_covered": 50.0}}), encoding="utf-8")

    res_cov = _run_test_guard(repo, ["--coverage-json", str(cov_json)])
    assert res_cov.returncode == 1
    assert "locked harness/referee file modified" in res_cov.stdout
    assert "was lowered vs main" in res_cov.stdout

    # Even with --allow-harness-edit, lowering coverage-baseline.json below main MUST stay blocked!
    res_cov_override = _run_test_guard(
        repo, ["--coverage-json", str(cov_json), "--allow-harness-edit"]
    )
    assert res_cov_override.returncode == 1
    assert "was lowered vs main" in res_cov_override.stdout

    # Cheat 2: Agent weakens tests/conftest.py Hypothesis max_examples=50 -> 1
    repo2 = _init_temp_git_repo(tmp_path / "r2")
    conftest = repo2 / "tests" / "conftest.py"
    conftest.write_text(
        conftest.read_text(encoding="utf-8").replace("max_examples=50", "max_examples=1"),
        encoding="utf-8",
    )
    res_conf = _run_test_guard(repo2)
    assert res_conf.returncode == 1
    assert "tests/conftest.py: locked harness/referee file modified" in res_conf.stdout


def test_gauntlet_blocks_sneaky_test_weakening_tricks(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    sneaky = repo / "tests" / "sneaky_cheat_test.py"
    sneaky.write_text(
        "def test_swallowed_assert() -> None:\n"
        "    try:\n"
        "        assert 1 == 2\n"
        "    except AssertionError:\n"
        "        pass\n\n"
        "def test_dead_branch_assert() -> None:\n"
        "    if False:\n"
        "        assert False\n\n"
        "def test_not_false_and_const_compare() -> None:\n"
        "    assert not False\n"
        "    assert 1 != 2\n",
        encoding="utf-8",
    )

    res = _run_test_guard(repo)
    assert res.returncode == 1
    assert "sneaky_cheat_test.py::test_swallowed_assert" in res.stdout
    assert "swallowed (try/except) or dead-branch" in res.stdout
    assert "sneaky_cheat_test.py::test_dead_branch_assert" in res.stdout
    assert "sneaky_cheat_test.py::test_not_false_and_const_compare" in res.stdout
    assert "tautological/trivial assertion" in res.stdout


def test_gauntlet_blocks_dynamic_sdk_import_and_fixture_pii_leak(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)

    # Cheat 1: Dynamic SDK import inside processor
    proc_file = repo / "src" / "app" / "processors" / "order_triage.py"
    proc_file.write_text(
        proc_file.read_text(encoding="utf-8")
        + '\nimport importlib\n_SDK = importlib.import_module("third_party_sdk")\n',
        encoding="utf-8",
    )
    # Cheat 2: Real-looking corporate email + public IPv4 inside replay fixture JSON
    leaky_fixture = repo / "tests" / "fixtures" / "order_triage" / "leaky_case.json"
    leaky_fixture.write_text(
        json.dumps({"customer_email": "alice@realcompany.io", "source_ip": "8.8.8.8"}),
        encoding="utf-8",
    )

    res = subprocess.run(
        [sys.executable, str(repo / "scripts" / "ratchet.py"), "--check"],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    assert res.returncode == 1
    assert "ratchet/direct-sdk-import" in res.stdout
    assert "ratchet/fixture-real-email" in res.stdout
    assert "ratchet/fixture-public-ip" in res.stdout


def test_gauntlet_scale_benchmark_diff_scoped_parallel_mutation(tmp_path: Path) -> None:
    repo = _init_temp_git_repo(tmp_path)
    processors_dir = repo / "src" / "app" / "processors"

    # Simulate a 20-module legacy repo with 19 untouched processor modules (100+ extra mutants)
    for i in range(1, 20):
        mod = processors_dir / f"legacy_module_{i:02d}.py"
        mod.write_text(
            f"def rule_{i:02d}(flag_a: bool, flag_b: bool, code: str) -> bool:\n"
            "    if flag_a and flag_b and code == 'ok':\n"
            "        return True\n"
            "    return False\n",
            encoding="utf-8",
        )
    subprocess.run(["git", "add", "."], cwd=repo, check=True, capture_output=True)
    subprocess.run(
        ["git", "commit", "-m", "add 19 legacy processor modules"],
        cwd=repo,
        check=True,
        capture_output=True,
    )

    # Create a feature branch modifying ONLY 1 processor file
    subprocess.run(
        ["git", "checkout", "-b", "sandcastle/perf-bench"],
        cwd=repo,
        check=True,
        capture_output=True,
    )
    target = processors_dir / "order_triage.py"
    target.write_text(target.read_text(encoding="utf-8") + "\n# touch\n", encoding="utf-8")

    started = time.perf_counter()
    proc = subprocess.run(
        [
            sys.executable,
            str(repo / "scripts" / "mutation_check.py"),
            "--root",
            str(repo),
            "--base",
            "main",
            "--skip-baseline",
        ],
        cwd=repo,
        capture_output=True,
        text=True,
        check=False,
    )
    elapsed = time.perf_counter() - started

    assert proc.returncode == 0, proc.stdout + proc.stderr
    assert "diff-scoped vs main (1 file(s))" in proc.stdout
    assert elapsed < 25.0, f"Diff-scoped parallel mutation took too long: {elapsed:.2f}s"


def test_local_tracker_split_repoints_downstream_blockers_and_detects_cycles(
    tmp_path: Path,
) -> None:
    repo = _init_temp_git_repo(tmp_path)
    tracker = str(repo / "scripts" / "local_tracker.py")
    issues_dir = repo / ".scratch" / "workflow-smoke-test" / "issues"

    # Add Ticket 02 blocked by Ticket 01
    t2 = issues_dir / "02-downstream-task.md"
    t2.write_text(
        "# 02: Downstream task\n\n"
        "**What to build:** Runs only after 01 completes.\n\n"
        "**Blocked by:** 01\n\n"
        "**Status:** ready-for-agent\n",
        encoding="utf-8",
    )

    plan_file = tmp_path / "split.json"
    plan_file.write_text(
        json.dumps(
            {
                "reason": "oversized slice",
                "subtickets": [
                    {
                        "title": "Part A",
                        "what_to_build": "Build A",
                        "acceptance_criteria": ["Passes"],
                        "blocked_by_indexes": [],
                    },
                    {
                        "title": "Part B",
                        "what_to_build": "Build B",
                        "acceptance_criteria": ["Passes"],
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
        check=True,
    )
    payload = json.loads(split_res.stdout)
    assert payload["created"] == ["workflow-smoke-test/03", "workflow-smoke-test/04"]
    assert payload["repointed_downstream"] == ["workflow-smoke-test/02"]

    # Ticket 02 MUST now be blocked by 03 and 04 (NOT unblocked prematurely!)
    listed = subprocess.run(
        [sys.executable, tracker, "--root", str(repo), "list", "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    by_id = {item["id"]: item for item in json.loads(listed.stdout)}
    assert by_id["workflow-smoke-test/02"]["open_blockers"] == [
        "workflow-smoke-test/03",
        "workflow-smoke-test/04",
    ]

    # Introduce a circular dependency (03 blocked by 02, while 02 is blocked by 03) -> MUST fail
    t3 = next(issues_dir.glob("03-*.md"))
    t3.write_text(
        t3.read_text(encoding="utf-8").replace(
            "**Blocked by:** None (can start immediately)", "**Blocked by:** 02"
        ),
        encoding="utf-8",
    )
    cycle_res = subprocess.run(
        [sys.executable, tracker, "--root", str(repo), "check-cycles"],
        capture_output=True,
        text=True,
        check=False,
    )
    assert cycle_res.returncode == 1
    assert "Circular ticket dependency detected" in cycle_res.stderr


def test_local_tracker_parses_numeric_feature_slug_and_cross_feature_blockers(
    tmp_path: Path,
) -> None:
    repo = _init_temp_git_repo(tmp_path)
    tracker = str(repo / "scripts" / "local_tracker.py")
    q4_dir = repo / ".scratch" / "2026-q4-rollout" / "issues"
    q4_dir.mkdir(parents=True)
    (q4_dir / "01-foundation.md").write_text(
        "# 01: Foundation\n\n**Blocked by:** None\n\n**Status:** ready-for-agent\n",
        encoding="utf-8",
    )
    (q4_dir / "02-dependent.md").write_text(
        "# 02: Dependent\n\n"
        "**Blocked by:** 2026-q4-rollout/01, workflow-smoke-test/01\n\n"
        "**Status:** ready-for-agent\n",
        encoding="utf-8",
    )

    listed = subprocess.run(
        [sys.executable, tracker, "--root", str(repo), "list", "--json"],
        capture_output=True,
        text=True,
        check=True,
    )
    by_id = {item["id"]: item for item in json.loads(listed.stdout)}
    assert by_id["2026-q4-rollout/02"]["open_blockers"] == [
        "2026-q4-rollout/01",
        "workflow-smoke-test/01",
    ]


def test_test_guard_reads_utf8_locked_files_without_locale_false_positives(
    tmp_path: Path,
) -> None:
    repo = _init_temp_git_repo(tmp_path)
    # Run test_guard with PYTHONUTF8=0 on a clean clone containing UTF-8 em-dashes
    env = {**os.environ, "PYTHONUTF8": "0"}
    res = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "test_guard.py"),
            "--root",
            str(repo),
            "--base",
            "main",
        ],
        cwd=repo,
        env=env,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Test Guard PASS" in res.stdout
