# TASK: READ-ONLY PARAMETER & WORKFLOW TUNING PROPOSAL

You are analyzing verified historical Sandcastle factory runs (minimum 10 completed runs on disk) to recommend data-backed parameter adjustments.

**STRICT RULES:**
1. Do NOT edit any repository files or run destructive commands.
2. NEVER propose weakening `scripts/test_guard.py`, `scripts/coverage-baseline.json`, or `scripts/mutation_check.py`.
3. Every proposed numeric value MUST stay inside the safety clamps below.
4. Prefer tightening noisy thresholds over loosening guardrails unless data proves repeated false positives on otherwise-clean slices.

# AGGREGATED RUN STATS

```json
{{AGGREGATED_STATS_JSON}}
```

# HARD SAFETY CLAMPS

```json
{{SAFETY_CLAMPS_JSON}}
```

# OUTPUT

Return ONLY a JSON object inside `<tuning>` tags matching:

<tuning>
{
  "executiveSummary": "Concise 2-sentence PM summary of trends across the verified runs.",
  "parameterChanges": [
    {
      "param": "DRIFT_MAX_DIFF_LINES",
      "currentValue": 400,
      "proposedValue": 300,
      "evidence": "p90 clean diff was 185 lines while diffs > 300 triggered 2 review rounds."
    }
  ],
  "promptOrProcessSuggestions": [
    {
      "targetFile": ".sandcastle/implement-prompt.md",
      "suggestion": "Remind implementers to extract helpers before hitting 6 return statements.",
      "evidence": "Recurring ruff/PLR0911 failures across recent runs."
    }
  ]
}
</tuning>
