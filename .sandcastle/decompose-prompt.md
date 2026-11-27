# TASK: RE-SLICE DRIFTED TICKET

Worker execution on ticket `{{TICKET_ID}}` was stopped automatically by the deterministic Drift Watchdog.

- **Drift trigger:** {{DRIFT_REASON}}
- **Observed partial diff stat:**
```text
{{PARTIAL_DIFF_STAT}}
```

Your job is to break this oversized or ambiguous ticket into **2 or 3 smaller, strictly scoped vertical-slice sub-tickets** that each fit comfortably inside a single 10–15 minute TDD run (< 200 lines changed).

Do NOT edit any files or run commands. Read the ticket below and emit ONLY the `<split>` JSON block.

# ORIGINAL TICKET & SPEC

<ticket>

!`python scripts/local_tracker.py view {{TICKET_ID}}`

</ticket>

# DECOMPOSITION RULES

1. Each sub-ticket must deliver one verifiable vertical slice (e.g., slice 1: fixture + contract test; slice 2: core logic; slice 3: wiring/edge case).
2. Use `blocked_by_indexes` (0-based indices into `subtickets`, strictly earlier indices only) when sub-ticket B genuinely depends on sub-ticket A.
3. Keep each sub-ticket focused on <= 3 files and <= 200 lines of diff.
4. Preserve all fail-closed invariants from the original ticket and ADRs.

# OUTPUT

Return ONLY a JSON object inside `<split>` tags matching:

<split>
{
  "reason": "{{DRIFT_REASON}}",
  "subtickets": [
    {
      "title": "Short imperative slice 1 title",
      "what_to_build": "End-to-end verifiable behavior for slice 1",
      "acceptance_criteria": ["Criterion 1", "python scripts/check.py passes"],
      "blocked_by_indexes": []
    },
    {
      "title": "Short imperative slice 2 title",
      "what_to_build": "End-to-end verifiable behavior for slice 2",
      "acceptance_criteria": ["Criterion 1", "python scripts/check.py passes"],
      "blocked_by_indexes": [0]
    }
  ]
}
</split>
