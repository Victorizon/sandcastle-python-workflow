"""Run a tool from the project's `.venv` on any OS (`python scripts/venv_run.py <tool> [args...]`).

Git hooks call this instead of hardcoding `.venv/bin/<tool>`, which does not exist on Windows
(where virtualenvs put executables under `.venv\\Scripts\\` with an `.exe` suffix).
"""

from __future__ import annotations

import subprocess
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent


def resolve_venv_tool(name: str, root: Path = ROOT) -> Path | None:
    venv = root / ".venv"
    candidates = (
        venv / "Scripts" / f"{name}.exe",
        venv / "Scripts" / name,
        venv / "bin" / name,
    )
    for candidate in candidates:
        if candidate.is_file():
            return candidate
    return None


def main(argv: list[str]) -> int:
    if not argv:
        print("usage: python scripts/venv_run.py <tool> [args...]", file=sys.stderr)
        return 2
    tool = resolve_venv_tool(argv[0])
    if tool is None:
        print(
            f"`{argv[0]}` not found in .venv (looked in .venv/Scripts and .venv/bin). "
            "Create it with: python -m venv .venv && pip install -r requirements-dev.txt -e .",
            file=sys.stderr,
        )
        return 127
    return subprocess.run([str(tool), *argv[1:]], cwd=ROOT, check=False).returncode


if __name__ == "__main__":
    raise SystemExit(main(sys.argv[1:]))
