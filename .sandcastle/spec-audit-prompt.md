# TASK

Perform a **read-only, fresh-context End-of-Goal Spec Audit** comparing the combined code changes since `{{START_COMMIT}}` against the frozen `/grill-me` Spec Contract in `{{SPEC_FILE}}`.

Do **NOT** modify any files. Do **NOT** invent a numerical score or confidence grade — deterministic orchestration code computes the score after cross-checking every cited test name against real `pytest -v` output.

# CONTEXT

<frozen-grilling-spec>

!`cat {{SPEC_FILE}}`

</frozen-grilling-spec>

<coding-standards>

!`cat CODING_STANDARDS.md`

</coding-standards>

<combined-diff>

!`git diff {{START_COMMIT}}..HEAD`

</combined-diff>

<available-passing-tests>

{{PASSING_TESTS}}

</available-passing-tests>

# AUDIT RULES

1. **Every single `REQ-*`, `INV-*`, and `OUT-*` ID** in `<frozen-grilling-spec>` MUST appear in your `items` array. Never omit an ID.
2. For `REQ-*` and `INV-*`:
   - Use `VERIFIED` **ONLY** if the behavior is genuinely implemented AND proven by a specific test name copied verbatim from `<available-passing-tests>`.
   - Use `IMPLEMENTED_UNTESTED` if the behavior exists in code but lacks a direct passing test.
   - Use `MISSING` if the requirement is absent, partial, or semantically wrong.
3. For `OUT-*` (explicit Non-Goals):
   - Use `RESPECTED` if the diff stayed away from that out-of-scope area.
   - Use `VIOLATED` if the diff touched or implemented that out-of-scope behavior.
4. Keep **Standards** separate from **Spec**:
   - List any hard violations of `CODING_STANDARDS.md` in `standardsViolations`.
   - List any behavior added in `<combined-diff>` that was NOT asked for in `<frozen-grilling-spec>` in `scopeCreepItems`.

# OUTPUT FORMAT

Write `summary` and each item's `note` in **plain English for a Product Manager** (concrete behavior and proof, zero unexplained jargon).

Output ONLY the structured JSON object wrapped in `<spec-audit>` tags:

<spec-audit>
{
  "summary": "Short factual summary of spec alignment and standards compliance.",
  "items": [
    {
      "id": "REQ-1",
      "status": "VERIFIED",
      "evidenceFile": "src/app/processors/order_triage.py",
      "citedTest": "tests/test_order_triage.py::test_example",
      "note": "Verified by public-seam fixture test."
    }
  ],
  "standardsViolations": [],
  "scopeCreepItems": []
}
</spec-audit>
