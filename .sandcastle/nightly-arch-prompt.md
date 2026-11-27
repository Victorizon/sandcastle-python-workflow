# TASK: OVERNIGHT NO-BLOAT ARCHITECTURE & RELIABILITY SCOUT

Scan this repository for **at most {{MAX_PROPOSALS}} high-impact, low-bloat improvements**.

# STRICT NO-BLOAT CHARTER

You may ONLY propose improvements in these **4 high-ROI buckets**:
1. **Real bug fixes & edge-case hardening** (verified failure modes, crash paths, subtle logic bugs)
2. **Simplification & de-duplication** (turning scattered/duplicated logic into one deeper, smaller, cleaner seam — net-negative or minimal line count)
3. **Performance & reliability** (faster tests/checks, cleaner error handling, tighter resource bounds)
4. **High-value missing test coverage** (closing real untested failure modes without trivial filler)

**EXPLICITLY FORBIDDEN:**
- NEVER invent new CLI commands, new modes, or speculative abstractions.
- NEVER modify locked referee/governance files (`scripts/check.py`, `scripts/test_guard.py`, `scripts/ratchet.py`, `scripts/mutation_check.py`, `scripts/coverage-baseline.json`, `pyproject.toml`, `tests/conftest.py`).
- NEVER delete or weaken existing tests or replay fixtures.

# SCOPE FIRST (YAGNI BY GIT CHURN)

Focus primarily on the high-churn hot spots below — do NOT suggest cosmetic refactors on cold, untouched files.

<hotspots>
{{HOTSPOTS_SUMMARY}}
</hotspots>

<ratchet-report>
!`python scripts/ratchet.py --report`
</ratchet-report>

# RULES

1. Read `GLOSSARY.md`, `docs/adr/`, and `.out-of-scope/` first. Never re-propose anything ruled out in `.out-of-scope/` or settled by an ADR.
2. Apply the **deletion test**: propose a change ONLY if it genuinely fixes a bug, cuts duplication, improves reliability/speed, or closes a real test gap.
3. Keep every proposal small enough to land safely in a single focused PR (`<= 250` diff lines).
4. Write `title`, `problem`, `solution`, and `benefits` in **plain English for a Product Manager** so a non-technical reader immediately understands what improved and why it matters (zero unexplained jargon).

# OUTPUT

Return ONLY a JSON object inside `<proposals>` tags matching:

<proposals>
{
  "proposals": [
    {
      "slug": "dedupe-branch-cleanup",
      "title": "Remove duplicated branch cleanup logic across runners",
      "strength": "strong",
      "files": [".sandcastle/preflight.ts", ".sandcastle/run.ts"],
      "problem": "Three runner scripts repeat slightly different git cleanup commands, making fixes easy to miss.",
      "solution": "Consolidate safe branch cleanup into one small shared helper with unit tests.",
      "benefits": "Fewer lines to maintain and consistent cleanup behavior across all autonomous modes.",
      "acceptance_criteria": [
        "python scripts/check.py passes",
        "npm --prefix .sandcastle run typecheck && npm --prefix .sandcastle test passes"
      ]
    }
  ]
}
</proposals>

If no genuinely high-impact improvement exists right now, return `{"proposals": []}`.
