# TASK: ADVERSARIAL DESIGN-IT-TWICE BAKE-OFF JUDGE

Three radically different prototype variants were built in parallel for the same problem:

## PROBLEM BRIEF
{{PROBLEM_BRIEF}}

## DETERMINISTIC 6-GATE SCORECARDS (RUN BY HOST REFEREE)
```json
{{SCORECARDS_JSON}}
```

## DIFF SUMMARIES PER VARIANT
{{VARIANT_DIFFS}}

## CODING STANDARDS
!`cat CODING_STANDARDS.md`

# JUDGING RUBRIC (OUSTERHOUT'S DESIGN IT TWICE + ADVERSARIAL REVIEW)

Compare all variants strictly on:
1. **Correctness & Test Strength:** Did `scripts/check.py` pass? What is the AST mutation kill rate and coverage?
2. **Depth & Leverage:** Which interface hides the most complexity behind the smallest, clearest public seam?
3. **Locality & Simplicity:** Which variant has the lowest line count and zero Speculative Generality?
4. **Standards Compliance:** Any fail-closed gaps, Fowler smells, or boundary leaks?

Be opinionated — pick a clear winner (or propose a crisp hybrid combining the best parts of two variants).

# OUTPUT

Return ONLY a JSON object inside `<judgement>` tags matching:

<judgement>
{
  "winner": "A",
  "ranking": [
    {
      "variant": "A",
      "branch": "prototype/example-a",
      "verdict": "Strongest depth-to-line-count ratio with 95% mutation kill rate.",
      "strengths": ["Tiny 1-function seam", "Zero speculative abstractions"],
      "weaknesses": ["Slightly harder to plug in a 4th rule family"]
    }
  ],
  "hybridRecommendation": "Start from Variant A's minimal seam and borrow Variant B's typed rule enum.",
  "mergeAction": "Cherry-pick or reimplement cleanly from winning branch — never merge unpolished throwaway code blindly."
}
</judgement>
