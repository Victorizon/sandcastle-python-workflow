"""Git History + Jira ADR Miner & `Applies-to` Enforcer (`scripts/adr_miner.py`).

Extracts Chesterton's Fence anomaly clues from git history, inline `# HACK`/`# WORKAROUND`
comments, and optional offline Jira JSON/CSV exports into `docs/adr/drafts/` for human approval.
Once approved (`approve`), ADRs live under `docs/adr/` with an `Applies-to:` glob header so
`match` deterministically injects ONLY relevant accepted ADRs into Implementer & Reviewer prompts.

Usage:
  python scripts/adr_miner.py mine [--max-commits 200] [--jira-export jira.json] [--limit 5]
  python scripts/adr_miner.py list-drafts
  python scripts/adr_miner.py approve docs/adr/drafts/0003-example.md
  python scripts/adr_miner.py reject  docs/adr/drafts/0003-example.md
  python scripts/adr_miner.py match --base main --format prompt
"""

from __future__ import annotations

import argparse
import csv
import fnmatch
import json
import re
import subprocess
import sys
from collections import defaultdict
from dataclasses import dataclass
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parent.parent
ANOMALY_RE = re.compile(
    r"\b(workaround|hack|hotfix|revert|quirk|legacy|do not remove|must not"
    r"|race|retry|timeout|fail[- ]closed)\b",
    re.IGNORECASE,
)
JIRA_KEY_RE = re.compile(r"\b(?!REQ-|INV-|OUT-|ADR-|HTTP-|UTF-)[A-Z]{2,10}-\d{1,7}\b")
INLINE_MARKER_RE = re.compile(r"#\s*(HACK|WORKAROUND|FIXME|NOTE)\s*:\s*(.+)$", re.IGNORECASE)
APPLIES_TO_RE = re.compile(r"^Applies-to:\s*(.+)$", re.MULTILINE)
STATUS_RE = re.compile(r"^Status:\s*(.+)$", re.MULTILINE)
ADR_NUM_RE = re.compile(r"^(\d+)-(.+)\.md$")


@dataclass(frozen=True)
class CommitEvidence:
    sha: str
    subject: str
    files: tuple[str, ...]
    jira_keys: tuple[str, ...]


@dataclass(frozen=True)
class AcceptedAdr:
    path: str
    title: str
    applies_to: tuple[str, ...]
    body: str


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:42].rstrip("-")) or "mined-anomaly"


def load_jira_export(export_path: Path | None) -> dict[str, str]:
    """Load offline Jira JSON or CSV export into `{KEY: 'Summary — snippet'}`."""
    if export_path is None or not export_path.is_file():
        return {}
    mapping: dict[str, str] = {}
    if export_path.suffix.lower() == ".csv":
        with export_path.open("r", encoding="utf-8", errors="replace", newline="") as fh:
            for row in csv.DictReader(fh):
                key = (row.get("Issue key") or row.get("key") or row.get("Key") or "").strip()
                summary = (row.get("Summary") or row.get("summary") or "").strip()
                if key and summary:
                    mapping[key.upper()] = summary[:160]
        return mapping

    raw: Any = json.loads(export_path.read_text(encoding="utf-8", errors="replace"))
    raw_items: Any = cast(dict[str, Any], raw).get("issues", []) if isinstance(raw, dict) else raw
    if isinstance(raw_items, list):
        for entry in cast(list[Any], raw_items):
            if not isinstance(entry, dict):
                continue
            item = cast(dict[str, Any], entry)
            key = str(item.get("key", "")).strip().upper()
            raw_fields = item.get("fields")
            fields = cast(dict[str, Any], raw_fields) if isinstance(raw_fields, dict) else item
            summary = str(fields.get("summary", "")).strip()
            if key and summary:
                mapping[key] = summary[:160]
    return mapping


def mine_git_anomalies(root: Path, max_commits: int = 200) -> list[CommitEvidence]:
    proc = subprocess.run(
        [
            "git",
            "log",
            f"-n{max_commits}",
            "--pretty=format:===COMMIT===%h|%s",
            "--name-only",
        ],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    if proc.returncode != 0:
        return []

    findings: list[CommitEvidence] = []
    for block in proc.stdout.split("===COMMIT==="):
        lines = [ln.strip() for ln in block.splitlines() if ln.strip()]
        if not lines or "|" not in lines[0]:
            continue
        sha, subject = lines[0].split("|", 1)
        files = tuple(ln.replace("\\", "/") for ln in lines[1:] if ln.endswith((".py", ".ts")))
        jira_keys = tuple(sorted(set(JIRA_KEY_RE.findall(subject))))
        if files and (ANOMALY_RE.search(subject) or jira_keys):
            findings.append(
                CommitEvidence(sha=sha, subject=subject, files=files, jira_keys=jira_keys)
            )
    return findings


def mine_inline_markers(root: Path) -> dict[str, list[str]]:
    markers: dict[str, list[str]] = defaultdict(list)
    for folder in ("src", "scripts"):
        base = root / folder
        if not base.exists():
            continue
        for py in sorted(base.rglob("*.py")):
            rel = py.relative_to(root).as_posix()
            for lineno, line in enumerate(
                py.read_text(encoding="utf-8", errors="replace").splitlines(), start=1
            ):
                m = INLINE_MARKER_RE.search(line)
                if m:
                    markers[rel].append(
                        f"L{lineno} ({m.group(1).upper()}): {m.group(2).strip()[:120]}"
                    )
    return dict(markers)


def _next_adr_number(adr_dir: Path) -> int:
    highest = 0
    for search_dir in (adr_dir, adr_dir / "drafts"):
        if not search_dir.exists():
            continue
        for md in search_dir.glob("*.md"):
            m = ADR_NUM_RE.match(md.name)
            if m:
                highest = max(highest, int(m.group(1)))
    return highest + 1


def _glob_for_path(rel_path: str) -> str:
    parent = Path(rel_path).parent.as_posix()
    return f"{parent}/**" if parent and parent != "." else rel_path


def cmd_mine(args: argparse.Namespace) -> int:
    root: Path = args.root
    adr_dir = root / "docs" / "adr"
    drafts_dir = adr_dir / "drafts"
    drafts_dir.mkdir(parents=True, exist_ok=True)

    jira_map = load_jira_export(args.jira_export)
    commits = mine_git_anomalies(root, max_commits=args.max_commits)
    inline = mine_inline_markers(root)

    by_scope: dict[str, list[CommitEvidence]] = defaultdict(list)
    for ev in commits:
        scope = _glob_for_path(ev.files[0])
        by_scope[scope].append(ev)
    for rel_file in inline:
        by_scope.setdefault(_glob_for_path(rel_file), [])

    ranked = sorted(
        by_scope.items(),
        key=lambda kv: (
            -(len(kv[1]) + sum(1 for f in inline if _glob_for_path(f) == kv[0])),
            kv[0],
        ),
    )[: args.limit]

    if not ranked:
        print("ADR Miner: no anomaly clues found in git history or inline markers.")
        return 0

    created: list[str] = []
    next_num = _next_adr_number(adr_dir)
    for scope, evs in ranked:
        scope_markers = [
            f"- `{f}` {note}"
            for f, notes in inline.items()
            if _glob_for_path(f) == scope
            for note in notes[:3]
        ]
        jira_keys = sorted({k for ev in evs for k in ev.jira_keys})
        title = f"Document Anomaly Constraints in {scope}"
        slug = _slugify(scope.replace("/**", "").replace("/", "-"))
        draft_path = drafts_dir / f"{next_num:04d}-{slug}.md"
        next_num += 1

        ev_lines = [f"- `{ev.sha}` {ev.subject} ({', '.join(ev.files[:3])})" for ev in evs[:5]]
        jira_lines = [
            f"- **{k}:** {jira_map.get(k, '(no local Jira export summary provided)')}"
            for k in jira_keys
        ]
        body_parts = [
            f"# {title}",
            "",
            "Status: draft (requires human review)",
            f"Applies-to: {scope}",
            "",
            "## Mined Evidence",
            "",
            *(ev_lines or ["- (Mined from inline code markers)"]),
        ]
        if scope_markers:
            body_parts.extend(["", "### Inline Code Markers", "", *scope_markers[:6]])
        if jira_lines:
            body_parts.extend(["", "### Referenced Jira Tickets", "", *jira_lines])
        body_parts.extend(
            [
                "",
                "## Human Review Questions (Edit Before Approving)",
                "",
                "- Why does this constraint/workaround exist in production?",
                "- Is it still required, and what breaks if an agent removes or simplifies it?",
                "",
                "## Consequences",
                "",
                "- (Summarize the invariant agents must preserve here before running `approve`.)",
                "",
            ]
        )
        draft_path.write_text("\n".join(body_parts), encoding="utf-8")
        created.append(draft_path.relative_to(root).as_posix())

    print(f"ADR Miner wrote {len(created)} draft(s) for human review:")
    for item in created:
        print(f"  - {item}")
    print(
        "Review/edit each draft, then run `python scripts/adr_miner.py approve <draft>` "
        "or `reject <draft>`."
    )
    return 0


def cmd_list_drafts(root: Path) -> int:
    drafts_dir = root / "docs" / "adr" / "drafts"
    drafts = sorted(drafts_dir.glob("*.md")) if drafts_dir.exists() else []
    if not drafts:
        print("No pending ADR drafts under docs/adr/drafts/.")
        return 0
    for d in drafts:
        text = d.read_text(encoding="utf-8", errors="replace")
        applies = APPLIES_TO_RE.search(text)
        scope = applies.group(1).strip() if applies else "(global)"
        print(f"- {d.relative_to(root).as_posix()}  [Applies-to: {scope}]")
    return 0


def cmd_approve_or_reject(root: Path, draft_arg: str, approve: bool) -> int:
    draft_path = Path(draft_arg)
    if not draft_path.is_absolute():
        draft_path = root / draft_path
    if not draft_path.is_file():
        print(f"Draft not found: {draft_arg}", file=sys.stderr)
        return 1
    if not approve:
        draft_path.unlink()
        print(f"Rejected and removed draft: {draft_arg}")
        return 0

    adr_dir = root / "docs" / "adr"
    text = draft_path.read_text(encoding="utf-8")
    updated = STATUS_RE.sub("Status: accepted", text, count=1)
    updated = re.sub(
        r"\n## Human Review Questions[^\n]*\n[\s\S]*?(?=\n## |\Z)", "", updated, count=1
    )
    m = ADR_NUM_RE.match(draft_path.name)
    slug = m.group(2) if m else _slugify(draft_path.stem)
    next_num = _next_adr_number(adr_dir)
    dest = adr_dir / f"{next_num:04d}-{slug}.md"
    dest.write_text(updated.rstrip() + "\n", encoding="utf-8")
    draft_path.unlink()
    print(f"Approved ADR -> {dest.relative_to(root).as_posix()}")
    return 0


def load_accepted_adrs(root: Path = ROOT) -> list[AcceptedAdr]:
    adr_dir = root / "docs" / "adr"
    if not adr_dir.exists():
        return []
    adrs: list[AcceptedAdr] = []
    for md in sorted(adr_dir.glob("*.md")):
        text = md.read_text(encoding="utf-8", errors="replace")
        status_m = STATUS_RE.search(text)
        if status_m and status_m.group(1).strip().lower() != "accepted":
            continue
        title = next((ln[2:].strip() for ln in text.splitlines() if ln.startswith("# ")), md.stem)
        applies_m = APPLIES_TO_RE.search(text)
        globs = (
            tuple(g.strip() for g in applies_m.group(1).split(",") if g.strip())
            if applies_m
            else ("**",)
        )
        adrs.append(AcceptedAdr(md.relative_to(root).as_posix(), title, globs, text.strip()))
    return adrs


def _glob_matches(rel_path: str, pattern: str) -> bool:
    norm = rel_path.replace("\\", "/")
    pat = pattern.strip().replace("\\", "/")
    if pat in {"**", "*"}:
        return True
    if pat.endswith("/**"):
        prefix = pat[:-3].rstrip("/")
        return norm == prefix or norm.startswith(prefix + "/")
    return fnmatch.fnmatch(norm, pat)


def match_adrs_for_files(files: list[str], adrs: list[AcceptedAdr]) -> list[AcceptedAdr]:
    if not files:
        return []
    matched: list[AcceptedAdr] = []
    for adr in adrs:
        if any(_glob_matches(f, g) for f in files for g in adr.applies_to):
            matched.append(adr)
    return matched


def _detect_changed(root: Path, base_ref: str | None) -> list[str]:
    changed: set[str] = set()
    porcelain = subprocess.run(
        ["git", "status", "--porcelain"],
        cwd=root,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )
    for ln in porcelain.stdout.splitlines():
        if len(ln) > 3:
            changed.add(ln[3:].strip().replace("\\", "/"))
    if base_ref:
        diff = subprocess.run(
            ["git", "diff", "--name-only", f"{base_ref}...HEAD"],
            cwd=root,
            capture_output=True,
            text=True,
            encoding="utf-8",
            errors="replace",
            check=False,
        )
        for ln in diff.stdout.splitlines():
            if ln.strip():
                changed.add(ln.strip().replace("\\", "/"))
    return sorted(changed)


def cmd_match(args: argparse.Namespace) -> int:
    root: Path = args.root
    files = args.files if args.files is not None else _detect_changed(root, args.base)
    matched = match_adrs_for_files(files, load_accepted_adrs(root))
    if args.format == "json":
        print(
            json.dumps(
                [
                    {"path": a.path, "title": a.title, "applies_to": list(a.applies_to)}
                    for a in matched
                ],
                indent=2,
            )
        )
        return 0
    if not matched:
        print("(No scope-matched accepted ADRs for modified files.)")
        return 0
    for adr in matched:
        print(f"### {adr.path} — {adr.title} (Applies-to: {', '.join(adr.applies_to)})")
        print(adr.body)
        print()
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Git+Jira ADR Miner & Applies-to Enforcer")
    parser.add_argument("--root", type=Path, default=ROOT)
    sub = parser.add_subparsers(dest="cmd", required=True)

    p_mine = sub.add_parser("mine", help="Mine git history & optional Jira export into draft ADRs")
    p_mine.add_argument("--max-commits", type=int, default=200)
    p_mine.add_argument("--jira-export", type=Path, default=None)
    p_mine.add_argument("--limit", type=int, default=5)

    sub.add_parser("list-drafts", help="List pending ADR drafts under docs/adr/drafts/")

    p_app = sub.add_parser("approve", help="Promote a human-reviewed draft ADR to accepted")
    p_app.add_argument("draft")

    p_rej = sub.add_parser("reject", help="Delete an unneeded ADR draft")
    p_rej.add_argument("draft")

    p_match = sub.add_parser("match", help="Return accepted ADRs matching changed/target files")
    p_match.add_argument("--base", default="main")
    p_match.add_argument("--files", nargs="*", default=None)
    p_match.add_argument("--format", choices=("prompt", "json"), default="prompt")

    args = parser.parse_args(argv)
    if args.cmd == "mine":
        return cmd_mine(args)
    if args.cmd == "list-drafts":
        return cmd_list_drafts(args.root)
    if args.cmd in {"approve", "reject"}:
        return cmd_approve_or_reject(args.root, args.draft, approve=(args.cmd == "approve"))
    return cmd_match(args)


if __name__ == "__main__":
    raise SystemExit(main())
