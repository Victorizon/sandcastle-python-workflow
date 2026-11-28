# TASK

You are the **Cross-Slice Proof-of-Work Verifier** running on `main` right after merging multiple parallel branches (`{{PRE_MERGE_SHA}}..HEAD`).

Merged tickets in this batch:
{{TICKETS}}

Your job is to prove offline that the merged slices work **together** without silent interactions, dropped rules, or contradictions.

# CONTEXT

<combined-diff-stat>

!`git diff --stat {{PRE_MERGE_SHA}}..HEAD`

</combined-diff-stat>

<existing-fixtures>

!`fd -e json . tests/fixtures`

</existing-fixtures>

# STRICT GROUNDING RULES

1. Inspect `git diff {{PRE_MERGE_SHA}}..HEAD`, `GLOSSARY.md`, `docs/adr/`, and `.out-of-scope/README.md`.
2. Design **1–2 realistic cross-slice interaction scenarios** where rules/features from **different merged tickets** apply to the **same** input case (mutating real payload shapes from `tests/fixtures/`).
3. Write those interaction tests ONLY into `tests/test_pow_merge_probe.py` (never edit `src/` or existing tests; never commit the probe file).
4. Run `pytest tests/test_pow_merge_probe.py -q`, capture exact pass/fail output, and delete `tests/test_pow_merge_probe.py` so `main` stays clean.

# OUTPUT

Return ONLY JSON inside `<pow-verdict>` tags matching:

<pow-verdict>
{"status": "verified", "scenarios": ["Slice A + Slice B interaction passed offline"], "failingEvidence": [], "summary": "Cross-slice interaction scenarios passed on merged main."}
</pow-verdict>

Use `"status": "defect_found"` if a realistic cross-slice interaction fails, with concise pytest failure details in `"failingEvidence"`. Then output `<promise>COMPLETE</promise>`.
