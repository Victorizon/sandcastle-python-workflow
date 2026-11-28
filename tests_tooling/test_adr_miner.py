"""Unit tests for the Git + Jira Human-in-the-Loop ADR Miner (`scripts/adr_miner.py`)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
MINER = ROOT / "scripts" / "adr_miner.py"


def _run_miner(repo: Path, *args: str) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        [sys.executable, str(MINER), "--root", str(repo), *args],
        cwd=repo,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def _git(repo: Path, *args: str) -> None:
    subprocess.run(
        ["git", "-c", "user.email=test@example.test", "-c", "user.name=Test", *args],
        cwd=repo,
        check=True,
        capture_output=True,
    )


def test_adr_miner_mines_git_and_jira_drafts_then_approves_and_matches(tmp_path: Path) -> None:
    repo = tmp_path / "work"
    (repo / "src" / "legacy").mkdir(parents=True)
    (repo / "src" / "legacy" / "parser.py").write_text(
        "# WORKAROUND: upstream sends null timestamps on midnight rollover\nVALUE = 1\n",
        encoding="utf-8",
    )
    _git(repo, "init", "-q", "-b", "main")
    _git(repo, "add", ".")
    _git(repo, "commit", "-qm", "hotfix(PROJ-42): workaround legacy midnight rollover quirk")

    jira_json = repo / "jira_export.json"
    jira_json.write_text(
        json.dumps(
            {
                "issues": [
                    {
                        "key": "PROJ-42",
                        "fields": {"summary": "Midnight rollover produces empty timestamps"},
                    }
                ]
            }
        ),
        encoding="utf-8",
    )

    # 1. Mine -> creates draft under docs/adr/drafts/ (NOT accepted yet)
    mine = _run_miner(repo, "mine", "--jira-export", str(jira_json), "--limit", "3")
    assert mine.returncode == 0, mine.stdout + mine.stderr
    drafts = sorted((repo / "docs" / "adr" / "drafts").glob("*.md"))
    assert len(drafts) == 1
    draft_text = drafts[0].read_text(encoding="utf-8")
    assert "Status: draft (requires human review)" in draft_text
    assert "Applies-to: src/legacy/**" in draft_text
    assert "PROJ-42" in draft_text
    assert "Midnight rollover produces empty timestamps" in draft_text
    assert "WORKAROUND" in draft_text

    # 2. Drafts are NOT returned by `match` until human approves them
    pre_match = _run_miner(repo, "match", "--files", "src/legacy/parser.py", "--format", "json")
    assert pre_match.returncode == 0
    assert json.loads(pre_match.stdout) == []

    # 3. Human approves -> moves to docs/adr/, flips Status to accepted, removes review questions
    rel_draft = drafts[0].relative_to(repo).as_posix()
    app = _run_miner(repo, "approve", rel_draft)
    assert app.returncode == 0, app.stdout + app.stderr
    assert not drafts[0].exists()
    accepted = sorted((repo / "docs" / "adr").glob("*.md"))
    assert len(accepted) == 1
    acc_text = accepted[0].read_text(encoding="utf-8")
    assert "Status: accepted" in acc_text
    assert "Human Review Questions" not in acc_text

    # 4. `match` deterministically returns accepted ADR ONLY for matching files
    hit = _run_miner(repo, "match", "--files", "src/legacy/parser.py", "--format", "json")
    assert hit.returncode == 0
    matched = json.loads(hit.stdout)
    assert len(matched) == 1
    assert matched[0]["applies_to"] == ["src/legacy/**"]

    miss = _run_miner(repo, "match", "--files", "README.md", "--format", "json")
    assert miss.returncode == 0
    assert json.loads(miss.stdout) == []


def test_real_repo_applies_to_adrs_match_processors_and_adapters() -> None:
    res = _run_miner(
        ROOT, "match", "--files", "src/app/processors/order_triage.py", "--format", "json"
    )
    assert res.returncode == 0, res.stderr
    paths = [item["path"] for item in json.loads(res.stdout)]
    assert "docs/adr/0001-external-client-adapter-boundary.md" in paths
    assert "docs/adr/0002-fail-closed-decisions.md" in paths
