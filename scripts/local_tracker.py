"""Deterministic local markdown issue tracker over `.scratch/<feature>/issues/<NN>-<slug>.md`.

Provides a visible task board, JSON interface matching `gh issue list`, and bounded
1-shot ticket splitting (`split`) for Sandcastle's Drift Watchdog + Decomposer.
"""

from __future__ import annotations

import argparse
import json
import re
import sys
from dataclasses import asdict, dataclass
from datetime import UTC, datetime
from pathlib import Path
from typing import Any, cast

ROOT = Path(__file__).resolve().parent.parent

STATUS_RE = re.compile(r"^\*\*Status:\*\*\s*(.+?)\s*$", re.MULTILINE)
BLOCKED_RE = re.compile(r"^\*\*Blocked by:\*\*\s*(.+?)\s*$", re.MULTILINE)
SPLIT_DEPTH_RE = re.compile(r"^\*\*Split depth:\*\*\s*(\d+)\s*$", re.MULTILINE)
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
    split_depth: int
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


def _slugify(text: str) -> str:
    slug = re.sub(r"[^a-z0-9]+", "-", text.lower()).strip("-")
    return (slug[:48].rstrip("-")) or "subticket"


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
            depth_m = SPLIT_DEPTH_RE.search(text)
            title = title_m.group(1).strip() if title_m else md.stem
            status = status_m.group(1).strip() if status_m else "needs-triage"
            blockers = _parse_blockers(blocked_m.group(1), feature_dir.name) if blocked_m else []
            split_depth = int(depth_m.group(1)) if depth_m else 0
            tickets.append(
                Ticket(
                    id=f"{feature_dir.name}/{num:02d}",
                    feature=feature_dir.name,
                    number=num,
                    title=title,
                    status=status,
                    blocked_by=blockers,
                    split_depth=split_depth,
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
        if b not in by_id or by_id[b].status not in {"resolved", "wontfix", "split"}
    ]


def detect_blocker_cycles(tickets: list[Ticket]) -> list[list[str]]:
    by_id = {t.id: t for t in tickets}
    active_ids = {t.id for t in tickets if t.status not in {"resolved", "wontfix", "split"}}
    visited: set[str] = set()
    in_stack: set[str] = set()
    stack: list[str] = []
    cycles: list[list[str]] = []

    def _dfs(node: str) -> None:
        visited.add(node)
        in_stack.add(node)
        stack.append(node)
        ticket = by_id.get(node)
        if ticket is not None:
            for dep in ticket.blocked_by:
                if dep not in active_ids:
                    continue
                if dep in in_stack:
                    start = stack.index(dep)
                    cycles.append([*stack[start:], dep])
                elif dep not in visited:
                    _dfs(dep)
        stack.pop()
        in_stack.remove(node)

    for tid in sorted(active_ids):
        if tid not in visited:
            _dfs(tid)
    return cycles


def _repoint_downstream_blockers(
    parent: Ticket, child_nums: list[int], root: Path = ROOT
) -> list[str]:
    repointed: list[str] = []
    for candidate in discover_tickets(root):
        if candidate.feature != parent.feature or candidate.id == parent.id:
            continue
        if parent.id not in candidate.blocked_by:
            continue
        next_nums = [int(b.split("/")[-1]) for b in candidate.blocked_by if b != parent.id]
        next_nums.extend(child_nums)
        blocked_str = ", ".join(f"{n:02d}" for n in sorted(set(next_nums)))
        path = root / candidate.path
        text = path.read_text(encoding="utf-8")
        updated = BLOCKED_RE.sub(f"**Blocked by:** {blocked_str}", text, count=1)
        path.write_text(updated, encoding="utf-8")
        repointed.append(candidate.id)
    return repointed


def cmd_check_cycles(root: Path = ROOT) -> int:
    cycles = detect_blocker_cycles(discover_tickets(root))
    if cycles:
        print("Circular ticket dependency detected:", file=sys.stderr)
        for cycle in cycles:
            print(f"  - {' -> '.join(cycle)}", file=sys.stderr)
        return 1
    print("OK: zero circular ticket dependencies.")
    return 0


def cmd_board(root: Path = ROOT) -> int:
    tickets = discover_tickets(root)
    if not tickets:
        print("No local tickets found under `.scratch/<feature>/issues/`.")
        return 0
    by_id = {t.id: t for t in tickets}
    print(f"{'ID':<32} {'STATUS':<17} {'DEPTH':<6} {'UNBLOCKED':<10} TITLE")
    print("-" * 98)
    for t in tickets:
        blockers = _open_blockers(t, by_id)
        unblocked = "yes" if not blockers else f"no ({','.join(blockers)})"
        print(f"{t.id:<32} {t.status:<17} {t.split_depth:<6} {unblocked:<10} {t.title}")
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
        print(f"{t.id} [{t.status}] (depth={t.split_depth}) {t.title}")
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


def _load_plan_payload(plan_json_arg: str) -> dict[str, Any]:
    raw = sys.stdin.read() if plan_json_arg == "-" else Path(plan_json_arg).read_text("utf-8")
    data: Any = json.loads(raw)
    if not isinstance(data, dict):
        raise ValueError("Split plan JSON must be an object.")
    return cast(dict[str, Any], data)


def _extract_subtickets(plan: dict[str, Any]) -> list[dict[str, Any]]:
    raw_items: Any = plan.get("subtickets")
    if not isinstance(raw_items, list):
        return []
    raw_list = cast(list[Any], raw_items)
    return [cast(dict[str, Any], item) for item in raw_list if isinstance(item, dict)]


def cmd_split(ticket_id: str, plan_json_arg: str, max_depth: int, root: Path = ROOT) -> int:
    parent = _find_ticket(ticket_id, root)
    if parent.split_depth >= max_depth:
        print(
            f"Refused split for {parent.id}: split_depth={parent.split_depth} >= max={max_depth}. "
            "Escalate to ready-for-human instead of splitting infinitely.",
            file=sys.stderr,
        )
        return 1

    plan = _load_plan_payload(plan_json_arg)
    subtickets = _extract_subtickets(plan)
    if len(subtickets) < 2:
        print("Split plan must contain at least 2 subtickets.", file=sys.stderr)
        return 1

    feature_tickets = [t for t in discover_tickets(root) if t.feature == parent.feature]
    next_num = max((t.number for t in feature_tickets), default=0) + 1
    issues_dir = root / ".scratch" / parent.feature / "issues"
    child_depth = parent.split_depth + 1

    allocated_nums = [next_num + i for i in range(len(subtickets))]
    created_ids: list[str] = []
    for idx, sub in enumerate(subtickets):
        num = allocated_nums[idx]
        title = str(sub.get("title", "")).strip()
        what = str(sub.get("what_to_build", "")).strip()
        raw_criteria: Any = sub.get("acceptance_criteria", [])
        criteria_list = cast(list[Any], raw_criteria) if isinstance(raw_criteria, list) else []
        criteria = [str(c).strip() for c in criteria_list if str(c).strip()]
        raw_deps: Any = sub.get("blocked_by_indexes", [])
        deps_list = cast(list[Any], raw_deps) if isinstance(raw_deps, list) else []
        dep_indexes = [int(i) for i in deps_list if 0 <= int(i) < idx]

        blocker_nums = [int(b.split("/")[-1]) for b in parent.blocked_by]
        blocker_nums.extend(allocated_nums[i] for i in dep_indexes)
        blocked_str = (
            ", ".join(f"{n:02d}" for n in sorted(set(blocker_nums)))
            if blocker_nums
            else "None (can start immediately)"
        )
        checklist = "\n".join(f"- [ ] {item}" for item in criteria) or "- [ ] Passes check.py"
        md_body = (
            f"# {num:02d}: {title}\n\n"
            f"**What to build:** {what}\n\n"
            f"**Parent ticket:** {parent.id}\n\n"
            f"**Blocked by:** {blocked_str}\n\n"
            f"**Status:** ready-for-agent\n\n"
            f"**Split depth:** {child_depth}\n\n"
            f"{checklist}\n"
        )
        filename = f"{num:02d}-{_slugify(title)}.md"
        (issues_dir / filename).write_text(md_body, encoding="utf-8")
        created_ids.append(f"{parent.feature}/{num:02d}")

    repointed = _repoint_downstream_blockers(parent, allocated_nums, root)
    reason = str(plan.get("reason", "Drift watchdog auto-split")).strip()
    _append_comment(
        parent,
        f"Auto-split ({reason}) -> created {', '.join(created_ids)} (depth={child_depth}).",
        root,
    )
    _update_status_file(parent, "split", root)
    print(
        json.dumps(
            {
                "parent": parent.id,
                "created": created_ids,
                "depth": child_depth,
                "repointed_downstream": repointed,
            }
        )
    )
    return 0


def cmd_export_github(root: Path = ROOT) -> int:
    tickets = [t for t in discover_tickets(root) if t.status not in {"resolved", "split"}]
    if not tickets:
        print("# No open local tickets to export.")
        return 0
    for t in tickets:
        print(f'gh issue create --title "{t.title}" --label "{t.status}" --body-file "{t.path}"')
    return 0


def _build_parser() -> argparse.ArgumentParser:
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

    p_split = sub.add_parser("split", help="Auto-split a drifted ticket into smaller sub-tickets")
    p_split.add_argument("ticket_id")
    p_split.add_argument("--plan-json", required=True, help="Path to split JSON or `-` for stdin")
    p_split.add_argument("--max-depth", type=int, default=1, help="Max allowed split depth")

    sub.add_parser("check-cycles", help="Fail if any circular blocker dependencies exist")
    sub.add_parser("export-github", help="Print gh issue create commands for migration")
    return parser


def main() -> int:
    args = _build_parser().parse_args()
    root: Path = args.root
    dispatch = {
        "board": lambda: cmd_board(root),
        "list": lambda: cmd_list(args.status, args.json, root),
        "view": lambda: cmd_view(args.ticket_id, root),
        "set-status": lambda: cmd_set_status(args.ticket_id, args.status, root),
        "comment": lambda: cmd_comment(args.ticket_id, args.body, root),
        "resolve": lambda: cmd_resolve(args.ticket_id, args.summary, root),
        "split": lambda: cmd_split(args.ticket_id, args.plan_json, args.max_depth, root),
        "check-cycles": lambda: cmd_check_cycles(root),
        "export-github": lambda: cmd_export_github(root),
    }
    try:
        return dispatch[args.command]()
    except (KeyError, ValueError) as exc:
        print(str(exc), file=sys.stderr)
        return 1


if __name__ == "__main__":
    raise SystemExit(main())
