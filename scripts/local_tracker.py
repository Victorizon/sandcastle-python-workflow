"""Deterministic local markdown issue tracker over `.scratch/<feature>/issues/<NN>-<slug>.md`.

Provides a visible task board and JSON interface matching `gh issue list` so both
humans and Sandcastle's Planner/Implementer/Reviewer/Merger never lose track of work.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent

STATUS_RE = re.compile(r"^\*\*Status:\*\*\s*(.+?)\s*$", re.MULTILINE)
BLOCKED_RE = re.compile(r"^\*\*Blocked by:\*\*\s*(.+?)\s*$", re.MULTILINE)
TITLE_RE = re.compile(r"^#\s+(.+?)\s*$", re.MULTILINE)
TICKET_FILE_RE = re.compile(r"^(\d+)-(.+)\.md$")


@dataclass(frozen=True)
class Ticket:
    id: str
    feature: str
    number: int
    title: str
    status: str
    blocked_by: list[str]
    path: str
    spec_path: str | None
    body: str


def _parse_blockers(raw: str, feature: str) -> list[str]:
    lowered = raw.strip().lower()
    if not lowered or lowered.startswith("none"):
        return []
    blockers: list[str] = []
    for token in re.split(r"[,;]+", raw):
        cleaned = token.strip()
        if not cleaned:
            continue
        match = re.search(r"\b(\d+)\b", cleaned)
        if match:
            blockers.append(f"{feature}/{int(match.group(1)):02d}")
    return blockers


def discover_tickets(root: Path = ROOT) -> list[Ticket]:
    scratch_dir = root / ".scratch"
    if not scratch_dir.exists():
        return []
    tickets: list[Ticket] = []
    for feature_dir in sorted(p for p in scratch_dir.iterdir() if p.is_dir()):
        issues_dir = feature_dir / "issues"
        if not issues_dir.exists():
            continue
        spec_file = feature_dir / "spec.md"
        spec_rel = spec_file.relative_to(root).as_posix() if spec_file.exists() else None
        for md in sorted(issues_dir.glob("*.md")):
            m = TICKET_FILE_RE.match(md.name)
            if not m:
                continue
            num = int(m.group(1))
            text = md.read_text(encoding="utf-8")
            title_m = TITLE_RE.search(text)
            status_m = STATUS_RE.search(text)
            blocked_m = BLOCKED_RE.search(text)
            title = title_m.group(1).strip() if title_m else md.stem
            status = status_m.group(1).strip() if status_m else "needs-triage"
            blockers = _parse_blockers(blocked_m.group(1), feature_dir.name) if blocked_m else []
            tickets.append(
                Ticket(
                    id=f"{feature_dir.name}/{num:02d}",
                    feature=feature_dir.name,
                    number=num,
                    title=title,
                    status=status,
                    blocked_by=blockers,
                    path=md.relative_to(root).as_posix(),
                    spec_path=spec_rel,
                    body=text,
                )
            )
    return tickets


def _find_ticket(ticket_id: str, root: Path = ROOT) -> Ticket:
    all_tickets = discover_tickets(root)
    for t in all_tickets:
        if ticket_id in {t.id, t.path}:
            return t
    matches = [
        t for t in all_tickets if str(t.number) == ticket_id or f"{t.number:02d}" == ticket_id
    ]
    if len(matches) == 1:
        return matches[0]
    raise KeyError(f"Ticket `{ticket_id}` not found (or ambiguous). Run `board` to list IDs.")


def _open_blockers(ticket: Ticket, by_id: dict[str, Ticket]) -> list[str]:
    return [
        b
        for b in ticket.blocked_by
        if b not in by_id or by_id[b].status not in {"resolved", "wontfix"}
    ]


def cmd_board(root: Path = ROOT) -> int:
    tickets = discover_tickets(root)
    if not tickets:
        print("No local tickets found under `.scratch/<feature>/issues/`.")
        return 0
    by_id = {t.id: t for t in tickets}
    print(f"{'ID':<32} {'STATUS':<17} {'UNBLOCKED':<10} TITLE")
    print("-" * 92)
    for t in tickets:
        blockers = _open_blockers(t, by_id)
        unblocked = "yes" if not blockers else f"no ({','.join(blockers)})"
        print(f"{t.id:<32} {t.status:<17} {unblocked:<10} {t.title}")
    return 0


def cmd_list(status_filter: str | None, as_json: bool, root: Path = ROOT) -> int:
    tickets = discover_tickets(root)
    by_id = {t.id: t for t in tickets}
    filtered = [t for t in tickets if status_filter is None or t.status == status_filter]
    if as_json:
        payload = [
            {
                **asdict(t),
                "open_blockers": _open_blockers(t, by_id),
            }
            for t in filtered
        ]
        print(json.dumps(payload, indent=2))
        return 0
    for t in filtered:
        print(f"{t.id} [{t.status}] {t.title}")
    return 0


def cmd_view(ticket_id: str, root: Path = ROOT) -> int:
    ticket = _find_ticket(ticket_id, root)
    print(f"=== TICKET {ticket.id} ({ticket.path}) ===\n")
    print(ticket.body.rstrip())
    if ticket.spec_path:
        spec_text = (root / ticket.spec_path).read_text(encoding="utf-8")
        print(f"\n=== PARENT SPEC ({ticket.spec_path}) ===\n")
        print(spec_text.rstrip())
    return 0


def _update_status_file(ticket: Ticket, new_status: str, root: Path = ROOT) -> None:
    path = root / ticket.path
    text = path.read_text(encoding="utf-8")
    if STATUS_RE.search(text):
        updated = STATUS_RE.sub(f"**Status:** {new_status}", text, count=1)
    else:
        updated = f"**Status:** {new_status}\n\n{text}"
    path.write_text(updated, encoding="utf-8")


def _append_comment(ticket: Ticket, body: str, root: Path = ROOT) -> None:
    path = root / ticket.path
    text = path.read_text(encoding="utf-8").rstrip()
    stamp = datetime.now(UTC).strftime("%Y-%m-%d %H:%M UTC")
    if "\n## Comments\n" not in text and not text.endswith("## Comments"):
        text += "\n\n## Comments\n"
    text += f"\n- [{stamp}] {body.strip()}\n"
    path.write_text(text, encoding="utf-8")


def cmd_set_status(ticket_id: str, new_status: str, root: Path = ROOT) -> int:
    ticket = _find_ticket(ticket_id, root)
    _update_status_file(ticket, new_status, root)
    print(f"Updated {ticket.id}: {ticket.status} -> {new_status}")
    return 0


def cmd_comment(ticket_id: str, body: str, root: Path = ROOT) -> int:
    ticket = _find_ticket(ticket_id, root)
    _append_comment(ticket, body, root)
    print(f"Appended comment to {ticket.id}.")
    return 0


def cmd_resolve(ticket_id: str, summary: str, root: Path = ROOT) -> int:
    ticket = _find_ticket(ticket_id, root)
    if summary:
        _append_comment(ticket, f"Resolved: {summary}", root)
    _update_status_file(ticket, "resolved", root)
    print(f"Resolved {ticket.id}.")
    return 0


def cmd_export_github(root: Path = ROOT) -> int:
    tickets = [t for t in discover_tickets(root) if t.status != "resolved"]
    if not tickets:
        print("# No open local tickets to export.")
        return 0
    for t in tickets:
        print(f'gh issue create --title "{t.title}" --label "{t.status}" --body-file "{t.path}"')
    return 0


def main() -> int:
    parser = argparse.ArgumentParser(description="Local markdown issue tracker CLI")
    parser.add_argument("--root", type=Path, default=ROOT, help="Repository root directory")
    sub = parser.add_subparsers(dest="command", required=True)

    sub.add_parser("board", help="Print visual status table of all local tickets")

    p_list = sub.add_parser("list", help="List tickets")
    p_list.add_argument("--status", default=None, help="Filter by status label")
    p_list.add_argument("--json", action="store_true", help="Output JSON")

    p_view = sub.add_parser("view", help="View ticket and parent spec")
    p_view.add_argument("ticket_id", help="Ticket ID (e.g. workflow-smoke-test/01)")

    p_status = sub.add_parser("set-status", help="Set ticket status")
    p_status.add_argument("ticket_id")
    p_status.add_argument("status")

    p_comment = sub.add_parser("comment", help="Append comment to ticket")
    p_comment.add_argument("ticket_id")
    p_comment.add_argument("--body", required=True)

    p_resolve = sub.add_parser("resolve", help="Mark ticket resolved with summary")
    p_resolve.add_argument("ticket_id")
    p_resolve.add_argument("--summary", default="")

    sub.add_parser("export-github", help="Print gh issue create commands for migration")

    args = parser.parse_args()
    root: Path = args.root
    dispatch = {
        "board": lambda: cmd_board(root),
        "list": lambda: cmd_list(args.status, args.json, root),
        "view": lambda: cmd_view(args.ticket_id, root),
        "set-status": lambda: cmd_set_status(args.ticket_id, args.status, root),
        "comment": lambda: cmd_comment(args.ticket_id, args.body, root),
        "resolve": lambda: cmd_resolve(args.ticket_id, args.summary, root),
        "export-github": lambda: cmd_export_github(root),
    }
    try:
        return dispatch[args.command]()
    except KeyError as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
