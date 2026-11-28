"""Monotonic lint, typecheck, boundary, and secret ratchet (Python port of Matt Pocock's ratchet).

Commands:
    python scripts/ratchet.py --init      Create baseline once (never overwrites existing)
    python scripts/ratchet.py --check     Fail on new/grown violations or baseline growth
    python scripts/ratchet.py --shrink    Lower baseline counts to min(baseline, live)
    python scripts/ratchet.py --transfer  Move counts across touched files (zero net growth)
    python scripts/ratchet.py --report    Print live counts beside baseline counts
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
BASELINE_PATH = ROOT / "scripts" / "ratchet-baseline.json"
SCAN_DIRS = ("src", "tests", "tests_tooling", "scripts")

# Files permitted to reference inline disable patterns (kept strictly minimal).
DISABLE_ALLOWLIST: frozenset[str] = frozenset(
    {"scripts/ratchet.py", "tests_tooling/test_workflow_gates.py"}
)

# Forbidden third-party SDK modules outside src/app/adapters/ (direct or dynamic import)
FORBIDDEN_SDK_RE = re.compile(r"^\s*(?:from|import)\s+third_party_sdk\b")
FORBIDDEN_DYNAMIC_SDK_RE = re.compile(
    r"""(?:import_module|__import__)\s*\(\s*["']third_party_sdk(?:\.[^"']*)?["']"""
)
EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@([A-Za-z0-9.-]+\.[A-Za-z]{2,})\b")
IPV4_RE = re.compile(r"\b(\d{1,3})\.(\d{1,3})\.(\d{1,3})\.(\d{1,3})\b")
SAFE_EMAIL_SUFFIXES: tuple[str, ...] = (
    ".test",
    ".example",
    ".invalid",
    "example.com",
    "example.org",
    "example.net",
)
DISABLE_COMMENT_RE = re.compile(
    r"#\s*(?:noqa|type:\s*ignore|pyright:\s*ignore|pylint:\s*disable)\b",
    re.IGNORECASE,
)
SECRET_PATTERNS: tuple[tuple[str, re.Pattern[str]], ...] = (
    ("ratchet/secret-bearer-token", re.compile(r"Bearer\s+[A-Za-z0-9\-._~+/]{24,}=*")),
    ("ratchet/secret-api-key", re.compile(r"\bsk-[A-Za-z0-9]{20,}\b")),
    ("ratchet/secret-aws-key", re.compile(r"\bAKIA[0-9A-Z]{16}\b")),
    (
        "ratchet/secret-private-key",
        re.compile(r"-----BEGIN (?:RSA |EC |OPENSSH )?PRIVATE KEY-----"),
    ),
)

Counts = dict[str, dict[str, int]]


@dataclass(frozen=True)
class Violation:
    file: str
    rule: str


def _normalize_rel(file_path: str | Path) -> str:
    p = Path(file_path)
    if p.is_absolute():
        try:
            p = p.resolve().relative_to(ROOT)
        except ValueError:
            return p.as_posix()
    return p.as_posix().lstrip("./")


def _iter_python_files() -> list[Path]:
    files: list[Path] = []
    for folder in SCAN_DIRS:
        base = ROOT / folder
        if not base.exists():
            continue
        files.extend(sorted(base.rglob("*.py")))
    return files


def _resolve_tool(name: str) -> str:
    candidate = Path(sys.executable).parent / name
    if candidate.exists():
        return str(candidate)
    if sys.platform == "win32":
        exe_candidate = Path(sys.executable).parent / f"{name}.exe"
        if exe_candidate.exists():
            return str(exe_candidate)
    found = shutil.which(name)
    if found is None:
        raise RuntimeError(f"Required tool `{name}` not found in venv or PATH.")
    return found


def _collect_ruff() -> list[Violation]:
    ruff_bin = _resolve_tool("ruff")
    existing = [d for d in SCAN_DIRS if (ROOT / d).exists()]
    if not existing:
        return []
    proc = subprocess.run(
        [ruff_bin, "check", "--output-format", "json", *existing],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode not in (0, 1):
        raise RuntimeError(f"ruff failed ({proc.returncode}): {proc.stderr.strip()}")
    if not proc.stdout.strip():
        return []
    raw_items = json.loads(proc.stdout)
    violations: list[Violation] = []
    for item in raw_items:
        code = str(item.get("code") or "unknown")
        filename = _normalize_rel(str(item.get("filename", "")))
        violations.append(Violation(file=filename, rule=f"ruff/{code}"))
    return violations


def _collect_pyright() -> list[Violation]:
    pyright_bin = _resolve_tool("pyright")
    proc = subprocess.run(
        [pyright_bin, "--pythonpath", sys.executable, "--outputjson"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if not proc.stdout.strip():
        if proc.returncode != 0:
            raise RuntimeError(f"pyright failed ({proc.returncode}): {proc.stderr.strip()}")
        return []
    payload = json.loads(proc.stdout)
    diagnostics = payload.get("generalDiagnostics", [])
    violations: list[Violation] = []
    for diag in diagnostics:
        if diag.get("severity") != "error":
            continue
        rule = str(diag.get("rule") or "general")
        filename = _normalize_rel(str(diag.get("file", "")))
        violations.append(Violation(file=filename, rule=f"pyright/{rule}"))
    return violations


def _is_safe_doc_or_private_ipv4(octets: tuple[int, int, int, int]) -> bool:
    a, b, c, _d = octets
    if any(o > 255 for o in octets):
        return True
    if a in (0, 10, 127) or (a == 192 and b == 168) or (a == 172 and 16 <= b <= 31):
        return True
    return (a, b, c) in {(192, 0, 2), (198, 51, 100), (203, 0, 113)}


def _collect_fixture_pii_rules() -> list[Violation]:
    fixtures_dir = ROOT / "tests" / "fixtures"
    if not fixtures_dir.exists():
        return []
    violations: list[Violation] = []
    for json_file in sorted(fixtures_dir.rglob("*.json")):
        rel = _normalize_rel(json_file)
        text = json_file.read_text(encoding="utf-8", errors="replace")
        for match in EMAIL_RE.finditer(text):
            domain = match.group(1).lower()
            if not any(domain == s or domain.endswith(s) for s in SAFE_EMAIL_SUFFIXES):
                violations.append(Violation(file=rel, rule="ratchet/fixture-real-email"))
        for match in IPV4_RE.finditer(text):
            octets = (
                int(match.group(1)),
                int(match.group(2)),
                int(match.group(3)),
                int(match.group(4)),
            )
            if not _is_safe_doc_or_private_ipv4(octets):
                violations.append(Violation(file=rel, rule="ratchet/fixture-public-ip"))
    return violations


def _collect_custom_rules() -> list[Violation]:
    violations: list[Violation] = []
    for py_file in _iter_python_files():
        rel = _normalize_rel(py_file)
        text = py_file.read_text(encoding="utf-8", errors="replace")
        is_adapter = rel.startswith("src/app/adapters/")
        for line in text.splitlines():
            if rel not in DISABLE_ALLOWLIST and DISABLE_COMMENT_RE.search(line):
                violations.append(Violation(file=rel, rule="ratchet/disable-comment"))
            if (
                not is_adapter
                and rel not in DISABLE_ALLOWLIST
                and (FORBIDDEN_SDK_RE.match(line) or FORBIDDEN_DYNAMIC_SDK_RE.search(line))
            ):
                violations.append(Violation(file=rel, rule="ratchet/direct-sdk-import"))
            for rule_name, pattern in SECRET_PATTERNS:
                if pattern.search(line):
                    violations.append(Violation(file=rel, rule=rule_name))
    violations.extend(_collect_fixture_pii_rules())
    return violations


def collect_counts() -> Counts:
    all_violations = [
        *_collect_ruff(),
        *_collect_pyright(),
        *_collect_custom_rules(),
    ]
    grouped: dict[str, dict[str, int]] = defaultdict(lambda: defaultdict(int))
    for v in all_violations:
        grouped[v.file][v.rule] += 1
    return {file_key: dict(sorted(rules.items())) for file_key, rules in sorted(grouped.items())}


def read_baseline() -> Counts:
    if not BASELINE_PATH.exists():
        rel = BASELINE_PATH.relative_to(ROOT)
        raise FileNotFoundError(f"Missing {rel}. Run `python scripts/ratchet.py --init` once.")
    raw = json.loads(BASELINE_PATH.read_text(encoding="utf-8"))
    return {str(f): {str(r): int(c) for r, c in rules.items()} for f, rules in raw.items()}


def write_baseline(counts: Counts) -> None:
    cleaned = {
        file_key: {r: c for r, c in sorted(rules.items()) if c > 0}
        for file_key, rules in sorted(counts.items())
    }
    cleaned = {f: rules for f, rules in cleaned.items() if rules}
    BASELINE_PATH.write_text(json.dumps(cleaned, indent=2) + "\n", encoding="utf-8")


def read_origin_main_baseline() -> Counts | None:
    rel = BASELINE_PATH.relative_to(ROOT).as_posix()
    proc = subprocess.run(
        ["git", "show", f"origin/main:{rel}"],
        cwd=ROOT,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0 or not proc.stdout.strip():
        return None
    raw = json.loads(proc.stdout)
    return {str(f): {str(r): int(c) for r, c in rules.items()} for f, rules in raw.items()}


def compare_growth(found: Counts, baseline: Counts) -> list[str]:
    grown: list[str] = []
    for file_key, rules in sorted(found.items()):
        base_rules = baseline.get(file_key, {})
        for rule, count in sorted(rules.items()):
            base_count = base_rules.get(rule, 0)
            if count > base_count:
                grown.append(f"{file_key}: {rule} ({base_count} -> {count})")
    return grown


def shrink_counts(found: Counts, baseline: Counts) -> Counts:
    shrunk: Counts = {}
    for file_key, base_rules in sorted(baseline.items()):
        live_rules = found.get(file_key, {})
        next_rules: dict[str, int] = {}
        for rule, base_count in sorted(base_rules.items()):
            low = min(base_count, live_rules.get(rule, 0))
            if low > 0:
                next_rules[rule] = low
        if next_rules:
            shrunk[file_key] = next_rules
    return shrunk


def _rule_totals(counts: Counts) -> dict[str, int]:
    totals: dict[str, int] = defaultdict(int)
    for rules in counts.values():
        for rule, count in rules.items():
            totals[rule] += count
    return dict(totals)


def transfer_counts(found: Counts, baseline: Counts) -> Counts:
    live_totals = _rule_totals(found)
    base_totals = _rule_totals(baseline)
    for rule, live_total in live_totals.items():
        base_total = base_totals.get(rule, 0)
        if live_total > base_total:
            raise RuntimeError(
                f"Cannot transfer: `{rule}` total grew ({base_total} -> {live_total})."
            )
    return found


def total_violations(counts: Counts) -> int:
    return sum(sum(rules.values()) for rules in counts.values())


def _run_init() -> int:
    rel = BASELINE_PATH.relative_to(ROOT)
    if BASELINE_PATH.exists():
        print(f"{rel} already exists; skipped (baselines only shrink).")
        return 0
    live = collect_counts()
    write_baseline(live)
    print(f"Initialized {rel} with {total_violations(live)} baseline violation(s).")
    return 0


def _run_check(live: Counts, baseline: Counts) -> int:
    grown = compare_growth(live, baseline)
    origin_base = read_origin_main_baseline()
    baseline_grown = compare_growth(baseline, origin_base) if origin_base is not None else []
    if grown or baseline_grown:
        if grown:
            print("Ratchet FAILED — new or increased violations (fix them; never raise baseline):")
            for line in grown:
                print(f"  {line}")
        if baseline_grown:
            print("Ratchet FAILED — scripts/ratchet-baseline.json grew vs origin/main:")
            for line in baseline_grown:
                print(f"  {line}")
        return 1
    live_total = total_violations(live)
    base_total = total_violations(baseline)
    print(f"Ratchet PASS: live={live_total} / baseline={base_total} (0 new).")
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Monotonic Python ratchet")
    group = parser.add_mutually_exclusive_group()
    group.add_argument("--init", action="store_true", help="Create initial baseline if missing")
    group.add_argument("--check", action="store_true", help="Verify no violations grew")
    group.add_argument(
        "--shrink", action="store_true", help="Lower baseline to min(baseline, live)"
    )
    group.add_argument("--transfer", action="store_true", help="Rebalance debt on move-only split")
    group.add_argument("--report", action="store_true", help="Show live vs baseline summary")
    args = parser.parse_args()

    if args.init:
        return _run_init()

    live = collect_counts()
    baseline = read_baseline()

    if args.report:
        live_total = total_violations(live)
        base_total = total_violations(baseline)
        print(f"Ratchet report: live={live_total} / baseline={base_total}")
        for rule, count in sorted(_rule_totals(live).items(), key=lambda kv: -kv[1])[:10]:
            print(f"  {rule}: {count} (baseline {_rule_totals(baseline).get(rule, 0)})")
        return 0

    if args.shrink:
        shrunk = shrink_counts(live, baseline)
        write_baseline(shrunk)
        before = total_violations(baseline)
        after = total_violations(shrunk)
        print(f"Shrunk baseline: {before} -> {after} violation(s).")
        return 0

    if args.transfer:
        transferred = transfer_counts(live, baseline)
        write_baseline(transferred)
        print("Transferred baseline counts across refactored files with zero net growth.")
        return 0

    return _run_check(live, baseline)


if __name__ == "__main__":
    raise SystemExit(main())
