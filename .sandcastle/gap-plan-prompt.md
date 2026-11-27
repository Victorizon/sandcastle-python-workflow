# TASK: GAP-PLANNER (CLOSE REMAINING GOAL CHECK FAILURES)

All planned `ready-for-agent` tickets finished, but the machine-verifiable Goal Contract `{{GOAL_NAME}}` is still not fully met.

Do NOT edit code directly. Analyze the failing verification output below and propose **1 or 2 minimal, strictly scoped vertical-slice tickets** that close the exact remaining gap.

# FAILING GOAL CHECK OUTPUT

```text
{{FAILED_CHECKS}}
```

# RULES

1. Target ONLY the exact failures shown above — zero unrelated refactoring or scope creep.
2. Preserve all fail-closed invariants, ADRs, and existing tests.
3. Return ONLY a JSON object inside `<gap-tickets>` tags matching:

<gap-tickets>
{
  "diagnosis": "Short root-cause summary of what is still missing.",
  "tickets": [
    {
      "title": "Short imperative gap-closing slice title",
      "what_to_build": "Exact verifiable behavior needed to make the failing check pass",
      "acceptance_criteria": ["Criterion 1", "python scripts/check.py passes"]
    }
  ]
}
</gap-tickets>
