# TASK: DESIGN-IT-TWICE PROTOTYPE VARIANT ({{VARIANT_LABEL}})

You are implementing **Prototype Variant {{VARIANT_LABEL}}** on throwaway branch `{{BRANCH}}`.

## PROBLEM BRIEF
{{PROBLEM_BRIEF}}

## YOUR DESIGN CONSTRAINT (MAKE THIS STRUCTURALLY DISTINCT)
{{DESIGN_CONSTRAINT}}

## EXECUTION RULES
1. Follow `GLOSSARY.md` and `docs/adr/` (preserve all fail-closed invariants and adapter boundaries).
2. Add anonymized replay tests under `tests/` proving your variant works. NEVER delete or weaken existing tests or fixtures.
3. Run `python scripts/check.py` before committing with message `PROTOTYPE({{VARIANT_LABEL}}): {{SLUG}}`.
4. Keep your implementation concise, idiomatic, and faithful to your assigned design constraint.

Once committed and `python scripts/check.py` passes, output `<promise>COMPLETE</promise>`.
