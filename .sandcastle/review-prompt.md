# TASK

Perform a fresh-context two-axis adversarial code review of branch `{{BRANCH}}` for ticket `{{TICKET_ID}}`: {{TICKET_TITLE}}.

# CONTEXT

<ticket>

!`python scripts/local_tracker.py view {{TICKET_ID}}`

</ticket>

<coding-standards>

!`cat CODING_STANDARDS.md`

</coding-standards>

<diff-to-main>

!`git diff main..HEAD`

</diff-to-main>

# REVIEW AXES

1. **Standards axis:** Check every hunk against `CODING_STANDARDS.md` (fail-closed invariants, PII/secret redaction, external adapter boundary, public-seam testing, no deleted/weakened tests, and Fowler smells).
2. **Spec axis:** Check every acceptance criterion in `<ticket>` for missing behavior, wrong behavior, or unrequested scope creep.

# EXECUTION

- If you find small, unambiguous cleanliness fixes, apply them directly, run `python scripts/check.py`, and commit with `RALPH: Review - {{TICKET_ID}}`.
- If you find blocking reliability/spec defects you should not silently guess past, set `approved: false` and list each blocking issue clearly.
- Output a JSON verdict inside `<verdict>` tags matching:

<verdict>
{"approved": true, "severity": "none", "summary": "All spec criteria and fail-closed standards verified.", "blockingIssues": []}
</verdict>

Then output `<promise>COMPLETE</promise>`.
