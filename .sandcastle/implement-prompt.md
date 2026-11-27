# TASK

Implement ticket `{{TICKET_ID}}`: {{TICKET_TITLE}} on branch `{{BRANCH}}`.

Only work on this single ticket. Do not touch unrelated files or close the ticket (the Merger closes it after review).

# TICKET & PARENT SPEC

<ticket>

!`python scripts/local_tracker.py view {{TICKET_ID}}`

</ticket>

# RECENT COMMITS

<recent-commits>

!`git log -n 8 --format="%h %ad %s" --date=short`

</recent-commits>

# EXECUTION RULES

1. Read `GLOSSARY.md` and `docs/adr/` first so domain terms and invariants match.
2. Follow vertical-slice TDD:
   - RED: add a public-seam behavioral test + anonymized JSON replay fixture under `tests/fixtures/`
   - GREEN: write minimal implementation under `src/` to pass the test
   - Do NOT mock internal helpers; only use `FakeExternalClient` at the system boundary
   - For parser or decision-rule changes, include a Hypothesis `@given(...)` invariant test proving malformed inputs fail closed and never crash unhandled
   - NEVER delete, rename, or weaken existing tests or existing fixture JSONs
3. Keep fail-closed invariants intact: return `Decision.MANUAL_REVIEW` (`auto_execute=False`) on errors, missing signals, or unknown states.
4. Run `python scripts/check.py` before committing. Fix every failure cleanly without adding `# noqa` or `# type: ignore`.
5. Commit your work with a concise message starting with `RALPH: {{TICKET_ID}} - `.

Once committed and `python scripts/check.py` passes, output `<promise>COMPLETE</promise>`.
