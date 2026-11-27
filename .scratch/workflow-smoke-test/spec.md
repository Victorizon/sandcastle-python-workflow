# Workflow Smoke Test: Explicit Fail-Closed Handling for Unknown Risk Tiers

## Goal

Validate the full end-to-end Matt Pocock + Sandcastle local workflow (Plan → Implement via TDD → Deterministic 6-Gate `scripts/check.py` → Fresh-Context Adversarial Review → Merge → Ticket Resolution) on a small, real vertical slice before pointing the pipeline at production modules.

## Behavior

In `triage_order`, if any `VerificationSignal` reports an unrecognized or empty `risk_tier` (anything other than `"low"`, `"medium"`, or `"high"`), the triage run must immediately return `Decision.MANUAL_REVIEW` with `auto_execute=False` and reason `"fail_closed_unknown_risk_tier"`.

## Out of Scope

- No changes to `ExternalClient` protocol methods.
- No live external network calls.
