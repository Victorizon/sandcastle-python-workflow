"""Unit tests for the deterministic Anti-Bloat Guard (`scripts/anti_bloat_guard.py`)."""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
GUARD = ROOT / "scripts" / "anti_bloat_guard.py"


def _run_guard(repo: Path, extra_args: list[str] | None = None) -> subprocess.CompletedProcess[str]:
    cmd = [sys.executable, str(GUARD), "--root", str(repo)]
    if extra_args:
        cmd.extend(extra_args)
    return subprocess.run(cmd, cwd=repo, capture_output=True, text=True, check=False)


def _seed_clean_workspace(tmp_path: Path) -> Path:
    repo = tmp_path / "repo"
    (repo / "scripts").mkdir(parents=True)
    (repo / ".sandcastle").mkdir(parents=True)
    (repo / "scripts" / "helper.py").write_text(
        "def compute_total(x: int, y: int) -> int:\n"
        "    return x + y\n\n"
        "def main() -> int:\n"
        "    print(compute_total(1, 2))\n"
        "    return 0\n",
        encoding="utf-8",
    )
    (repo / ".sandcastle" / "runner.ts").write_text(
        "function formatLabel(name: string): string {\n"
        "  return name.trim().toUpperCase();\n"
        "}\n"
        "export function runTask(name: string): string {\n"
        "  return formatLabel(name);\n"
        "}\n",
        encoding="utf-8",
    )
    (repo / ".sandcastle" / "runner.test.ts").write_text(
        'import { runTask } from "./runner.js";\nconsole.log(runTask("ok"));\n',
        encoding="utf-8",
    )
    return repo


def test_anti_bloat_guard_passes_on_real_repo() -> None:
    res = _run_guard(ROOT)
    assert res.returncode == 0, res.stdout + res.stderr
    assert "Anti-Bloat Guard PASS" in res.stdout


def test_anti_bloat_guard_flags_oversized_files(tmp_path: Path) -> None:
    repo = _seed_clean_workspace(tmp_path)
    big_file = repo / "scripts" / "bloated.py"
    big_file.write_text("\n".join(f"VAL_{i} = {i}" for i in range(60)) + "\n", encoding="utf-8")

    res = _run_guard(repo, ["--max-lines", "40", "--json"])
    assert res.returncode == 1
    findings = json.loads(res.stdout)
    assert any(
        f["category"] == "oversized-file" and f["file"] == "scripts/bloated.py" for f in findings
    )


def test_anti_bloat_guard_flags_dead_python_and_ts_symbols(tmp_path: Path) -> None:
    repo = _seed_clean_workspace(tmp_path)
    (repo / "scripts" / "helper.py").write_text(
        "def compute_total(x: int, y: int) -> int:\n"
        "    return x + y\n\n"
        "def orphan_python_helper() -> int:\n"
        "    return 42\n\n"
        "def main() -> int:\n"
        "    print(compute_total(1, 2))\n"
        "    return 0\n",
        encoding="utf-8",
    )
    (repo / ".sandcastle" / "runner.ts").write_text(
        "function unusedPrivateHelper(): number {\n"
        "  return 99;\n"
        "}\n"
        "export function unusedExportedHelper(): string {\n"
        '  return "never-called";\n'
        "}\n"
        "export function runTask(name: string): string {\n"
        "  return name.trim();\n"
        "}\n",
        encoding="utf-8",
    )

    res = _run_guard(repo, ["--json"])
    assert res.returncode == 1
    findings = json.loads(res.stdout)
    categories = {(f["category"], f["file"]) for f in findings}
    assert ("dead-python-symbol", "scripts/helper.py") in categories
    assert ("dead-ts-helper", ".sandcastle/runner.ts") in categories
    assert ("dead-ts-export", ".sandcastle/runner.ts") in categories


def test_anti_bloat_guard_flags_duplicated_blocks_across_files(tmp_path: Path) -> None:
    repo = _seed_clean_workspace(tmp_path)
    repeated_block = "\n".join(
        [
            "export function processBatchAlpha(items: readonly string[]): string[] {",
            "  const cleanedItems = items.map((entry) => entry.trim().toLowerCase());",
            "  const nonEmptyEntries = cleanedItems.filter((entry) => entry.length > 0);",
            "  const deduplicatedEntries = [...new Set(nonEmptyEntries)];",
            "  const sortedEntries = deduplicatedEntries.sort((a, b) => a.localeCompare(b));",
            "  return sortedEntries.map((entry, idx) => `${idx + 1}:${entry}`);",
            "}",
        ]
    )
    (repo / ".sandcastle" / "alpha.ts").write_text(repeated_block + "\n", encoding="utf-8")
    (repo / ".sandcastle" / "beta.ts").write_text(
        repeated_block.replace("processBatchAlpha", "processBatchBeta") + "\n",
        encoding="utf-8",
    )
    (repo / ".sandcastle" / "use.test.ts").write_text(
        'import { processBatchAlpha } from "./alpha.js";\n'
        'import { processBatchBeta } from "./beta.js";\n'
        "console.log(processBatchAlpha([]), processBatchBeta([]));\n",
        encoding="utf-8",
    )

    res = _run_guard(repo, ["--dup-window", "5", "--json"])
    assert res.returncode == 1
    findings = json.loads(res.stdout)
    assert any(f["category"] == "duplicated-block" for f in findings)
