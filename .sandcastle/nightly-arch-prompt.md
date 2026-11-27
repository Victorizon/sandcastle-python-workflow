# TASK: OVERNIGHT ARCHITECTURE SCOUT (HOT-SPOT DEEPENING)

Scan this repository for **at most {{MAX_PROPOSALS}} high-leverage deepening opportunities** (turning shallow, scattered code into deep, testable modules with clean seams).

# SCOPE FIRST (YAGNI BY GIT CHURN)

Focus primarily on the high-churn hot spots below — do NOT suggest cosmetic refactors on cold, untouched files.

<hotspots>
{{HOTSPOTS_SUMMARY}}
</hotspots>

<ratchet-report>
!`python scripts/ratchet.py --report`
</ratchet-report>

# RULES

1. Read `GLOSSARY.md`, `docs/adr/`, and `.out-of-scope/` first. Never re-propose anything ruled out in `.out-of-scope/` or settled by an ADR (unless friction is severe — if so, flag it explicitly).
2. Use exact architecture vocabulary: **module**, **interface**, **depth**, **seam**, **adapter**, **leverage**, **locality**.
3. Apply the **deletion test**: propose a refactor ONLY if it genuinely consolidates complexity behind a simpler seam rather than moving code around.
4. Keep every proposal small enough to land safely in a single vertical ticket (`<= 300` lines).
5. Write `title`, `problem`, `solution`, and `benefits` in **plain English for a Product Manager** so a non-technical reader immediately understands why this makes future changes safer or faster (no dense jargon).

# OUTPUT

Return ONLY a JSON object inside `<proposals>` tags matching:

<proposals>
{
  "proposals": [
    {
      "slug": "deepen-signal-validator",
      "title": "Deepen signal validation into one cohesive processor seam",
      "strength": "strong",
      "files": ["src/app/processors/order_triage.py"],
      "problem": "Validation checks are scattered across multiple call sites with poor locality.",
      "solution": "Consolidate signal validation behind one pure helper returning typed failure reasons.",
      "benefits": "Higher leverage at the public seam and simpler replay tests.",
      "acceptance_criteria": [
        "All existing replay fixtures remain untouched and green",
        "python scripts/check.py passes with >= 85% mutation kill rate"
      ]
    }
  ]
}
</proposals>

If no genuinely high-leverage deepening opportunity exists right now, return `{"proposals": []}`.
