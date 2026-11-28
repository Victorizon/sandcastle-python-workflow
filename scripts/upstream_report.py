"""Anonymized upstream bug & improvement reporter (`python scripts/upstream_report.py`).

Builds a reproducible, issue-only GitHub report (NEVER exports work code or patches) for
`Victorizon/sandcastle-python-workflow` with a 4-layer privacy firewall:
  1. Harness-only scope: optional `--cmd` only allows workflow harness commands; stack frames
     outside `scripts/` or `.sandcastle/` are replaced with `<work-repo-frame>`.
  2. Deterministic anonymizer: strips usernames, hostnames, home/repo paths, emails, IPs,
     internal URLs, ticket IDs, UUIDs, tokens, and `.sandcastle/redact-terms.local.txt` terms.
  3. Post-scrub secret gate: hard-blocks publishing if any secret/private-key pattern survives.
  4. Mandatory human approval: defaults to dry-run (`.sandcastle/logs/upstream-issue-draft.md`);
     `--publish` displays the exact scrubbed report and requires typing `PUBLISH` to confirm.
"""

from __future__ import annotations

import argparse
import getpass
import json
import os
import platform
import re
import shlex
import shutil
import socket
import subprocess
import sys
from dataclasses import dataclass
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
DEFAULT_UPSTREAM_REPO = "Victorizon/sandcastle-python-workflow"
REDACT_TERMS_PATH = ROOT / ".sandcastle" / "redact-terms.local.txt"
DRAFT_OUTPUT_PATH = ROOT / ".sandcastle" / "logs" / "upstream-issue-draft.md"

ALLOWLISTED_HARNESS_PREFIXES = ("scripts/", ".sandcastle/")
SAFE_PUBLIC_HOSTS = frozenset(
    {"pypi.org", "registry.npmjs.org", "docs.python.org", "example.com", "example.test"}
)
SAFE_UPSTREAM_URL_PREFIX = f"https://github.com/{DEFAULT_UPSTREAM_REPO.lower()}"
SAFE_PYTHON_SCRIPTS = frozenset(
    {
        "scripts/check.py",
        "scripts/verify_workflow_ready.py",
        "scripts/anti_bloat_guard.py",
        "scripts/adversarial_scan.py",
        "scripts/arch_map.py",
        "scripts/ratchet.py",
        "scripts/setup.py",
    }
)
SAFE_NPM_SCRIPTS = frozenset({"diagnose", "typecheck", "test"})

_GIT_SSH_RE = re.compile(r"(?:ssh://[^\s\"'<>]+|\bgit@[A-Za-z0-9.-]+:[^\s\"'<>]+)")
_UNC_PATH_RE = re.compile(r"\\\\[A-Za-z0-9._-]+\\[^\s\"'<>]+")
_WIN_USER_PATH_RE = re.compile(r"[A-Za-z]:\\Users\\[^\\\s\"']+", re.IGNORECASE)
_WIN_DRIVE_PATH_RE = re.compile(r"\b[A-Za-z]:\\[^\s\"'<>]+")
_UNIX_HOME_PATH_RE = re.compile(r"/(?:home|Users)/[^/\s\"']+")
_EMAIL_RE = re.compile(r"\b[A-Za-z0-9._%+-]+@[A-Za-z0-9.-]+\.[A-Za-z]{2,}\b")
_IPV4_RE = re.compile(r"\b(?:\d{1,3}\.){3}\d{1,3}\b")
_IPV6_RE = re.compile(r"\b(?:[0-9a-fA-F]{1,4}:){3,7}[0-9a-fA-F]{0,4}\b")
_URL_RE = re.compile(r"https?://([A-Za-z0-9.-]+)(?::\d+)?(?:/[^\s)\"'>]*)?")
_WIN_DOMAIN_USER_RE = re.compile(r"\b[A-Z][A-Z0-9_-]{1,20}\\[A-Za-z][A-Za-z0-9._-]{1,30}\b")
_UUID_RE = re.compile(
    r"\b[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{4}-[0-9a-fA-F]{12}\b"
)
_TICKET_RE = re.compile(r"\b(?!REQ-|INV-|OUT-|ADR-|HTTP-|UTF-)[A-Z]{2,10}-\d{1,7}\b")
_SLICE_ID_RE = re.compile(r"\b[a-z][a-z0-9-]{2,}/\d{2,4}\b")
_TOKEN_RE = re.compile(
    r"(?:Bearer\s+[A-Za-z0-9._~+/=-]{12,}|gh[pousr]_[A-Za-z0-9]{20,}"
    r"|github_pat_[A-Za-z0-9_]{20,}|sk-[A-Za-z0-9_-]{16,}|AKIA[0-9A-Z]{16}"
    r"|xox[baprs]-[A-Za-z0-9-]{10,}|glpat-[A-Za-z0-9_-]{16,}|npm_[A-Za-z0-9]{20,}"
    r"|AIza[0-9A-Za-z_-]{20,}|eyJ[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,}\.[A-Za-z0-9_-]{10,})"
)
_ENV_SECRET_RE = re.compile(
    r"(?i)[A-Z0-9_]*(?:api[_-]?key|secret|password|passwd|token)\s*[:=]\s*['\"]?[^\s'\"]{6,}"
)
_RESIDUAL_SECRET_PATTERNS = (
    re.compile(r"-----BEGIN [A-Z0-9 ]*PRIVATE KEY-----"),
    _ENV_SECRET_RE,
    _TOKEN_RE,
)
_TRACEBACK_FILE_RE = re.compile(r'^(\s*File\s+")([^"]+)(".*)$')


def load_local_redact_terms(terms_file: Path = REDACT_TERMS_PATH) -> list[str]:
    if not terms_file.is_file():
        return []
    raw_lines = terms_file.read_text(encoding="utf-8", errors="replace").splitlines()
    terms = {
        line.strip() for line in raw_lines if line.strip() and not line.strip().startswith("#")
    }
    return sorted(terms, key=len, reverse=True)


def _replace_literal_ci(text: str, needle: str, replacement: str) -> str:
    if not needle or len(needle) < 2:
        return text
    return re.sub(re.escape(needle), replacement, text, flags=re.IGNORECASE)


def sanitize_harness_output(raw_output: str, repo_root: Path = ROOT) -> str:
    """Keep traceback frames only for allowlisted harness files; mask all work-repo frames."""
    root_posix = repo_root.resolve().as_posix().rstrip("/")
    sanitized_lines: list[str] = []
    skip_next_code_line = False

    for line in raw_output.splitlines():
        if skip_next_code_line:
            skip_next_code_line = False
            sanitized_lines.append("    <work-repo-source-omitted>")
            continue
        match = _TRACEBACK_FILE_RE.match(line)
        if match:
            prefix, file_path, suffix = match.groups()
            norm = file_path.replace("\\", "/")
            rel = norm.removeprefix(root_posix + "/") if norm.startswith(root_posix + "/") else norm
            if any(rel.startswith(p) for p in ALLOWLISTED_HARNESS_PREFIXES):
                sanitized_lines.append(f"{prefix}<REPO>/{rel}{suffix}")
            else:
                sanitized_lines.append(f"{prefix}<work-repo-frame>{suffix}")
                skip_next_code_line = True
            continue
        sanitized_lines.append(line)

    return "\n".join(sanitized_lines)


@dataclass(frozen=True)
class AnonymizeContext:
    repo_root: Path = ROOT
    extra_terms: tuple[str, ...] = ()
    username: str | None = None
    hostname: str | None = None
    home_dir: Path | None = None


@dataclass(frozen=True)
class IssueDraftInput:
    kind: str
    title: str
    summary: str
    repro: str
    env_info: dict[str, str]
    cmd_str: str | None = None
    cmd_exit: int | None = None
    cmd_output: str | None = None
    trace_summary: str | None = None


def anonymize_text(text: str, ctx: AnonymizeContext | None = None) -> str:
    """Deterministically scrub PII, paths, hostnames, internal URLs, tokens, and local terms."""
    active = ctx or AnonymizeContext()
    out = text
    resolved_root = active.repo_root.resolve()
    resolved_home = (active.home_dir or Path.home()).resolve()

    for root_variant in (str(resolved_root), resolved_root.as_posix()):
        out = _replace_literal_ci(out, root_variant, "<REPO>")
    for home_variant in (str(resolved_home), resolved_home.as_posix()):
        out = _replace_literal_ci(out, home_variant, "<HOME>")

    out = _UNC_PATH_RE.sub("<UNC_PATH>", out)
    out = _WIN_USER_PATH_RE.sub("<HOME>", out)
    out = _WIN_DRIVE_PATH_RE.sub("<WIN_PATH>", out)
    out = _UNIX_HOME_PATH_RE.sub("<HOME>", out)
    out = _GIT_SSH_RE.sub("<GIT_SSH_URL>", out)
    out = _TOKEN_RE.sub("[REDACTED_SECRET]", out)
    out = _ENV_SECRET_RE.sub("[REDACTED_SECRET]", out)
    out = _EMAIL_RE.sub("<EMAIL>", out)
    out = _IPV4_RE.sub("<IP>", out)
    out = _IPV6_RE.sub("<IP>", out)

    def _scrub_url(m: re.Match[str]) -> str:
        full = m.group(0)
        host = m.group(1).lower()
        if full.lower().startswith(SAFE_UPSTREAM_URL_PREFIX):
            return full
        if host == "github.com":
            return "<GITHUB_URL>"
        return full if host in SAFE_PUBLIC_HOSTS else "<INTERNAL_URL>"

    out = _URL_RE.sub(_scrub_url, out)
    out = _WIN_DOMAIN_USER_RE.sub("<DOMAIN_USER>", out)
    out = _UUID_RE.sub("<UUID>", out)
    out = _TICKET_RE.sub("<TICKET>", out)

    active_user = active.username if active.username is not None else _safe_username()
    active_host = active.hostname if active.hostname is not None else _safe_hostname()
    if active_user and len(active_user) >= 3:
        out = re.sub(rf"\b{re.escape(active_user)}\b", "<USER>", out, flags=re.IGNORECASE)
    if active_host and len(active_host) >= 3:
        out = re.sub(rf"\b{re.escape(active_host)}\b", "<HOST>", out, flags=re.IGNORECASE)

    for term in active.extra_terms:
        out = _replace_literal_ci(out, term, "[REDACTED]")
    return out


def find_residual_secrets(text: str) -> list[str]:
    return [pat.pattern for pat in _RESIDUAL_SECRET_PATTERNS if pat.search(text)]


def is_allowlisted_harness_command(cmd_str: str) -> bool:
    """Only allow strict read-only workflow diagnostic commands — never arbitrary scripts."""
    try:
        tokens = shlex.split(cmd_str, posix=(os.name != "nt"))
    except ValueError:
        return False
    if len(tokens) < 2:
        return False
    head = Path(tokens[0]).name.lower()
    if head in {"python", "python3", "python.exe"}:
        script = tokens[1].replace("\\", "/")
        return script in SAFE_PYTHON_SCRIPTS and (
            script != "scripts/setup.py" or "--check-only" in tokens[2:]
        )
    if head in {"npm", "npm.cmd"} and len(tokens) >= 4:
        return (
            tokens[1] == "--prefix"
            and tokens[2] == ".sandcastle"
            and (
                tokens[3] == "test"
                or (tokens[3] == "run" and len(tokens) >= 5 and tokens[4] in SAFE_NPM_SCRIPTS)
            )
        )
    return False


def _safe_username() -> str:
    try:
        return getpass.getuser()
    except Exception:
        return os.environ.get("USERNAME") or os.environ.get("USER") or ""


def _safe_hostname() -> str:
    try:
        return socket.gethostname()
    except Exception:
        return ""


def _run_capture(cmd: list[str], cwd: Path = ROOT) -> subprocess.CompletedProcess[str]:
    return subprocess.run(
        cmd,
        cwd=cwd,
        capture_output=True,
        text=True,
        encoding="utf-8",
        errors="replace",
        check=False,
    )


def collect_safe_environment(repo_root: Path = ROOT) -> dict[str, str]:
    """Collect ONLY non-identifying tool versions (never hostnames, users, or work repo URLs)."""
    env_info: dict[str, str] = {
        "os": f"{platform.system()} {platform.release()}",
        "python": platform.python_version(),
    }
    for label, cmd in (
        ("node", ["node", "--version"]),
        ("docker", ["docker", "--version"]),
        ("git", ["git", "--version"]),
    ):
        if shutil.which(cmd[0]) is None:
            env_info[label] = "not installed"
        else:
            proc = _run_capture(cmd, cwd=repo_root)
            env_info[label] = (proc.stdout.strip().splitlines()[:1] or ["unknown"])[0]
    sha_proc = _run_capture(["git", "rev-parse", "--short", "HEAD"], cwd=repo_root)
    env_info["harness_commit"] = sha_proc.stdout.strip() if sha_proc.returncode == 0 else "unknown"
    return env_info


def summarize_latest_trace(repo_root: Path = ROOT) -> str | None:
    """Load the latest `.sandcastle/logs/runs/trace-*.jsonl` as a compact phase-timing summary."""
    pointer = repo_root / ".sandcastle" / "logs" / "runs" / "latest-trace.txt"
    if not pointer.is_file():
        return None
    trace_path = Path(pointer.read_text(encoding="utf-8", errors="replace").strip())
    if not trace_path.is_file():
        return None
    lines: list[str] = []
    for raw in trace_path.read_text(encoding="utf-8", errors="replace").splitlines()[-30:]:
        if not raw.strip():
            continue
        try:
            span = json.loads(raw)
        except json.JSONDecodeError:
            continue
        phase = str(span.get("phase", "unknown"))
        outcome = str(span.get("outcome", "unknown"))
        dur_s = float(span.get("durationMs", 0)) / 1000.0
        detail = _SLICE_ID_RE.sub("<SLICE_ID>", str(span.get("detail", "")).strip())
        lines.append(
            f"- c{span.get('cycle', '?')} `{phase}` -> `{outcome}` ({dur_s:.1f}s) {detail}"
        )
    return "\n".join(lines) if lines else None


def build_issue_markdown(
    draft: IssueDraftInput,
    ctx: AnonymizeContext | None = None,
) -> tuple[str, str]:
    active_ctx = ctx or AnonymizeContext()

    def scrub(value: str) -> str:
        return anonymize_text(value, active_ctx)

    tag = "[Bug]" if draft.kind == "bug" else "[Improvement]"
    clean_title = f"{tag} {scrub(draft.title).strip()}"

    env_lines = "\n".join(f"- **{k}:** `{scrub(v)}`" for k, v in draft.env_info.items())
    sections = [
        f"## Summary\n\n{scrub(draft.summary).strip()}",
        f"## Environment (Anonymized)\n\n{env_lines}",
    ]
    if draft.repro.strip():
        sections.append(f"## Reproduction Steps\n\n{scrub(draft.repro).strip()}")
    if draft.trace_summary:
        sections.append(f"## Phase Trace Summary (Anonymized)\n\n{scrub(draft.trace_summary)}")
    if draft.cmd_str and draft.cmd_output is not None:
        safe_out = scrub(sanitize_harness_output(draft.cmd_output, repo_root=active_ctx.repo_root))
        tail = "\n".join(safe_out.splitlines()[-40:])
        sections.append(
            f"## Harness Command Output\n\n"
            f"- **Command:** `{scrub(draft.cmd_str)}`\n"
            f"- **Exit code:** `{draft.cmd_exit}`\n\n"
            f"```text\n{tail}\n```"
        )
    sections.append(
        "---\n"
        "_Generated by `scripts/upstream_report.py` (issue description only — "
        "contains no downstream source code or patches; reviewed and approved by a human)._"
    )
    return clean_title, "\n\n".join(sections) + "\n"


def _publish_github_issue(repo: str, title: str, body: str, kind: str) -> int:
    if shutil.which("gh") is None:
        print("[FAIL] `gh` CLI not found in PATH. Install GitHub CLI to publish.", file=sys.stderr)
        return 1
    print(f"\nTarget repo: {repo}")
    print("Review EVERY line above carefully before publishing.")
    confirm = input(f"Type PUBLISH to open this GitHub issue on {repo}: ").strip()
    if confirm != "PUBLISH":
        print("Publish cancelled by user (draft kept locally).")
        return 0
    label = "bug" if kind == "bug" else "enhancement"
    DRAFT_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    DRAFT_OUTPUT_PATH.write_text(body, encoding="utf-8")
    base_cmd = [
        "gh",
        "issue",
        "create",
        "--repo",
        repo,
        "--title",
        title,
        "--body-file",
        str(DRAFT_OUTPUT_PATH),
    ]
    proc = _run_capture([*base_cmd, "--label", label])
    if proc.returncode != 0:
        proc = _run_capture(base_cmd)
    if proc.returncode != 0:
        print(f"[FAIL] gh issue create failed:\n{proc.stderr.strip()}", file=sys.stderr)
        return 1
    print(f"[PUBLISHED] {proc.stdout.strip()}")
    return 0


def main(argv: list[str] | None = None) -> int:
    parser = argparse.ArgumentParser(description="Anonymized upstream issue reporter.")
    parser.add_argument("--kind", choices=("bug", "improvement"), default="bug")
    parser.add_argument("--title", required=True, help="Short issue title (auto-anonymized)")
    parser.add_argument("--summary", required=True, help="Plain-English description (no work code)")
    parser.add_argument("--repro", default="", help="Optional reproduction steps")
    parser.add_argument("--cmd", default="", help="Optional allowlisted diagnostic command")
    parser.add_argument("--include-latest-trace", action="store_true", help="Attach latest trace")
    parser.add_argument("--repo", default=DEFAULT_UPSTREAM_REPO, help="Upstream GitHub owner/repo")
    parser.add_argument("--publish", action="store_true", help="Confirm PUBLISH and open issue")
    args = parser.parse_args(argv)

    cmd_exit: int | None = None
    cmd_output: str | None = None
    if args.cmd:
        if not is_allowlisted_harness_command(args.cmd):
            print(
                "[BLOCKED] `--cmd` only permits allowlisted harness commands "
                "(`python scripts/<name>.py ...` or `npm --prefix .sandcastle ...`).",
                file=sys.stderr,
            )
            return 2
        tokens = shlex.split(args.cmd, posix=(os.name != "nt"))
        proc = _run_capture(tokens, cwd=ROOT)
        cmd_exit = proc.returncode
        cmd_output = (proc.stdout + "\n" + proc.stderr).strip()

    extra_terms = load_local_redact_terms()
    env_info = collect_safe_environment(ROOT)
    trace_summary = summarize_latest_trace(ROOT) if args.include_latest_trace else None
    clean_title, clean_body = build_issue_markdown(
        IssueDraftInput(
            kind=args.kind,
            title=args.title,
            summary=args.summary,
            repro=args.repro,
            env_info=env_info,
            cmd_str=args.cmd or None,
            cmd_exit=cmd_exit,
            cmd_output=cmd_output,
            trace_summary=trace_summary,
        ),
        AnonymizeContext(repo_root=ROOT, extra_terms=tuple(extra_terms)),
    )

    residual = find_residual_secrets(clean_title + "\n" + clean_body)
    if residual:
        print(
            "[BLOCKED] Residual secret/credential pattern detected in draft. "
            "Refusing to save or publish.",
            file=sys.stderr,
        )
        return 3

    DRAFT_OUTPUT_PATH.parent.mkdir(parents=True, exist_ok=True)
    DRAFT_OUTPUT_PATH.write_text(f"# {clean_title}\n\n{clean_body}", encoding="utf-8")

    print("=== Anonymized Upstream Issue Preview ===\n")
    print(f"Title: {clean_title}\n")
    print(clean_body)
    print(f"Draft saved to: {DRAFT_OUTPUT_PATH}")
    if not extra_terms:
        print(
            "Tip: Add company/internal terms (one per line) to "
            ".sandcastle/redact-terms.local.txt (gitignored) for extra scrubbing."
        )

    if not args.publish:
        print("\n[DRY-RUN] Nothing was published. Re-run with `--publish` after reviewing above.")
        return 0
    return _publish_github_issue(args.repo, clean_title, clean_body, args.kind)


if __name__ == "__main__":
    raise SystemExit(main())
