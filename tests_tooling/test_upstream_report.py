"""Unit tests for the anonymized upstream issue reporter (`scripts/upstream_report.py`)."""

from __future__ import annotations

import importlib.util
import subprocess
import sys
from pathlib import Path
from types import ModuleType

ROOT = Path(__file__).resolve().parent.parent


def _load_reporter() -> ModuleType:
    spec = importlib.util.spec_from_file_location(
        "upstream_report", ROOT / "scripts" / "upstream_report.py"
    )
    assert spec is not None and spec.loader is not None
    mod = importlib.util.module_from_spec(spec)
    sys.modules[spec.name] = mod
    spec.loader.exec_module(mod)
    return mod


reporter = _load_reporter()


def test_anonymize_text_scrubs_pii_paths_urls_tokens_and_local_terms(tmp_path: Path) -> None:
    repo = tmp_path / "secret-work-repo"
    home = tmp_path / "Users" / "jdoe"
    repo.mkdir(parents=True)
    home.mkdir(parents=True)

    raw = (
        f"User jdoe on WORKLAPTOP01 at {repo / 'scripts' / 'check.py'} "
        f"and C:\\Users\\jdoe\\docs ran against https://internal.corp.local/api "
        "from 10.24.8.15 with email jane.doe@corp.local, ticket PROJ-4821, "
        "token ghp_1234567890abcdefghijklmnop, AcmeInternalWidget, "
        "and public link https://github.com/Victorizon/sandcastle-python-workflow."
    )
    scrubbed = reporter.anonymize_text(
        raw,
        reporter.AnonymizeContext(
            repo_root=repo,
            extra_terms=("AcmeInternalWidget",),
            username="jdoe",
            hostname="WORKLAPTOP01",
            home_dir=home,
        ),
    )

    for forbidden in (
        "jdoe",
        "WORKLAPTOP01",
        "secret-work-repo",
        "internal.corp.local",
        "10.24.8.15",
        "jane.doe@corp.local",
        "PROJ-4821",
        "ghp_1234567890",
        "AcmeInternalWidget",
    ):
        assert forbidden not in scrubbed, f"Leaked sensitive string: {forbidden}"

    assert "<REPO>" in scrubbed
    assert "<EMAIL>" in scrubbed
    assert "<IP>" in scrubbed
    assert "<INTERNAL_URL>" in scrubbed
    assert "<TICKET>" in scrubbed
    assert "[REDACTED_SECRET]" in scrubbed
    assert "[REDACTED]" in scrubbed
    assert "https://github.com/Victorizon/sandcastle-python-workflow" in scrubbed


def test_sanitize_harness_output_masks_non_harness_frames(tmp_path: Path) -> None:
    repo = tmp_path / "work"
    repo.mkdir()
    tb = "\n".join(
        [
            "Traceback (most recent call last):",
            f'  File "{repo / "scripts" / "check.py"}", line 42, in main',
            "    run_step()",
            f'  File "{repo / "src" / "secret_billing" / "engine.py"}", line 99, in compute',
            "    charge_customer(secret_key)",
            "RuntimeError: failed",
        ]
    )
    cleaned = reporter.sanitize_harness_output(tb, repo_root=repo)
    assert "<REPO>/scripts/check.py" in cleaned
    assert "secret_billing" not in cleaned
    assert "charge_customer" not in cleaned
    assert "<work-repo-frame>" in cleaned
    assert "<work-repo-source-omitted>" in cleaned


def test_allowlisted_harness_commands_blocks_arbitrary_execution() -> None:
    assert reporter.is_allowlisted_harness_command("python scripts/check.py") is True
    assert reporter.is_allowlisted_harness_command("npm --prefix .sandcastle test") is True
    assert reporter.is_allowlisted_harness_command("python src/app/main.py") is False
    assert reporter.is_allowlisted_harness_command("cat .sandcastle/.env") is False
    assert reporter.is_allowlisted_harness_command("bash -c 'env'") is False


def test_find_residual_secrets_blocks_private_key_and_passwords() -> None:
    assert reporter.find_residual_secrets("clean summary text") == []
    synthetic_pem = "-----BEGIN RSA " + "PRIVATE KEY-----"
    assert reporter.find_residual_secrets(synthetic_pem) != []
    assert reporter.find_residual_secrets("api_key=supersecretvalue123") != []


def test_cli_dry_run_and_command_block() -> None:
    blocked = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "upstream_report.py"),
            "--kind",
            "bug",
            "--title",
            "Test",
            "--summary",
            "Test",
            "--cmd",
            "cat .env",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert blocked.returncode == 2
    assert "[BLOCKED]" in blocked.stderr

    dry = subprocess.run(
        [
            sys.executable,
            str(ROOT / "scripts" / "upstream_report.py"),
            "--kind",
            "improvement",
            "--title",
            "Clarify error hint for jdoe@corp.local",
            "--summary",
            "Improve error hint when Docker is stopped on 10.0.0.5.",
        ],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    assert dry.returncode == 0, dry.stdout + dry.stderr
    assert "[DRY-RUN]" in dry.stdout
    assert "jdoe@corp.local" not in dry.stdout
    assert "10.0.0.5" not in dry.stdout
    assert "contains no downstream source code or patches" in dry.stdout


def test_trace_summary_is_anonymized_before_inclusion(tmp_path: Path) -> None:
    runs_dir = tmp_path / ".sandcastle" / "logs" / "runs"
    runs_dir.mkdir(parents=True)
    trace_file = runs_dir / "trace-demo.jsonl"
    trace_file.write_text(
        '{"cycle":1,"phase":"post_merge_audit","outcome":"rollback","durationMs":1500,'
        '"detail":"conflict on https://internal.corp.local/repo for jdoe@corp.local"}\n',
        encoding="utf-8",
    )
    (runs_dir / "latest-trace.txt").write_text(f"{trace_file}\n", encoding="utf-8")

    raw_summary = reporter.summarize_latest_trace(tmp_path)
    assert raw_summary is not None
    _, body = reporter.build_issue_markdown(
        reporter.IssueDraftInput(
            kind="bug",
            title="Merge audit rollback",
            summary="Audit rolled back.",
            repro="",
            env_info={"os": "Windows 11"},
            trace_summary=raw_summary,
        ),
        reporter.AnonymizeContext(repo_root=tmp_path, username="jdoe"),
    )
    assert "## Phase Trace Summary (Anonymized)" in body
    assert "post_merge_audit" in body
    assert "internal.corp.local" not in body
    assert "jdoe@corp.local" not in body


def test_privacy_redteam_blocks_enterprise_leaks_and_unsafe_commands(tmp_path: Path) -> None:
    ctx = reporter.AnonymizeContext(repo_root=tmp_path, username="jdoe", hostname="CORP-LAPTOP-9")
    enterprise_probes = [
        ("git@git.internal.corp:sec-team/secret-autoinvest.git", "secret-autoinvest"),
        (r"\\fileserver01.corp.local\finance\exports\q4.csv", "fileserver01"),
        ("2001:0db8:85a3:0000:0000:8a2e:0370:7334", "2001:0db8"),
        ("xox" + "b-123456789012-123456789012-AbCdEfGhIjKlMnOpQrStUvWx", "xox" + "b-"),
        ("https://github.com/AcmeCorp/secret-internal-repo/pull/42", "AcmeCorp"),
        ("AZURE_CLIENT_SECRET=MySuperSecretValue999!", "MySuperSecretValue999"),
        (r"D:\Work\ClientAlpha\secrets\config.yaml", "ClientAlpha"),
    ]
    for payload, forbidden in enterprise_probes:
        scrubbed = reporter.anonymize_text(payload, ctx)
        assert forbidden.lower() not in scrubbed.lower(), f"Leaked {forbidden} in: {scrubbed}"

    # Strict allowlist blocks arbitrary execution & work-ticket dumps
    assert (
        reporter.is_allowlisted_harness_command("python scripts/local_tracker.py view x/01")
        is False
    )
    assert (
        reporter.is_allowlisted_harness_command("python scripts/venv_run.py python -c '1'") is False
    )
    assert (
        reporter.is_allowlisted_harness_command("python scripts/upstream_report.py --publish")
        is False
    )
    assert reporter.is_allowlisted_harness_command("python scripts/setup.py") is False
    assert reporter.is_allowlisted_harness_command("python scripts/setup.py --check-only") is True
    assert reporter.is_allowlisted_harness_command("npm --prefix .sandcastle run diagnose") is True

    # Trace summarizer scrubs work feature slugs (<slug>/<NN> -> <SLICE_ID>)
    runs_dir = tmp_path / ".sandcastle" / "logs" / "runs"
    runs_dir.mkdir(parents=True, exist_ok=True)
    trace_file = runs_dir / "trace-slug.jsonl"
    trace_file.write_text(
        '{"cycle":1,"phase":"planner","outcome":"fail","durationMs":900,'
        '"detail":"dropped acme-billing-migration/01"}\n',
        encoding="utf-8",
    )
    (runs_dir / "latest-trace.txt").write_text(f"{trace_file}\n", encoding="utf-8")
    summary = reporter.summarize_latest_trace(tmp_path)
    assert summary is not None
    assert "acme-billing-migration" not in summary
    assert "<SLICE_ID>" in summary
