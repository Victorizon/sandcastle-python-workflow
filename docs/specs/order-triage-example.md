# Spec Contract: Order Triage Signal Rules

> Example frozen `/grill-me` Spec Contract referenced by `.sandcastle/goal.example.json`.

## Requirements (What Must Be Built)
- **REQ-1:** Auto-approve orders only when the partner is allowlisted, payment is verified, address is matched, and risk tier is `low`.
- **REQ-2:** Reject high-risk orders that lack full payment and address verification without auto-executing.
- **REQ-3:** Route ambiguous or missing-signal orders to `MANUAL_REVIEW` with `auto_execute=False`.

## Safety Invariants (Must Always Hold)
- **INV-1:** Fail closed to `MANUAL_REVIEW` with `auto_execute=False` on any upstream lookup error or missing order record.
- **INV-2:** Property-based Hypothesis fuzzing confirms `auto_execute=True` is impossible unless every positive invariant holds simultaneously.

## Explicit Non-Goals (Out of Scope — Do Not Touch)
- **OUT-1:** Do not add database persistence or live HTTP calls inside `src/app/processors/`.
