# Spec Contract: <Goal Title>

> Freeze this short contract right after `/grill-me` (10–25 lines max) and point `goal.json`'s `"specFile"` to it.
> At the end of a Level 2 Goal run, Sandcastle audits every numbered ID below against the combined git diff and cross-checks every cited test against real `pytest -v` output.

## Requirements (What Must Be Built)
- **REQ-1:** <One observable behavior in plain language.>
- **REQ-2:** <Another concrete behavior or output format.>

## Safety Invariants (Must Always Hold)
- **INV-1:** <Fail-closed rule, e.g., never auto-execute when required verification signals are missing or errored.>
- **INV-2:** <Parser/boundary rule, e.g., never crash on malformed input and never import third-party SDKs outside `src/app/adapters/`.>

## Explicit Non-Goals (Out of Scope — Do Not Touch)
- **OUT-1:** <Behavior or subsystem intentionally excluded from this goal.>

## Prior-Art Research Gate (Mandatory Post-Grill)
- **Recommended Depth:** `standard` *(choices: `fast | standard | deep | deep-synthesis | skip` — user may override)*
- **Skip Justification (only if `skip`):** <Must be bug fix, repo-context-only domain rule, or small internal refactor.>
- **Prior-Art Verdict:** <`ADOPT | BORROW | BUILD` + 1-line summary; full `<= 30`-line card saved in `.sandcastle/logs/prior-art-<slug>.md`>
