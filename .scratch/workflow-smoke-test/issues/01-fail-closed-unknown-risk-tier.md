# 01: Fail closed on unknown VerificationSignal risk_tier values

**What to build:** Ensure `triage_order` returns `Decision.MANUAL_REVIEW` (`auto_execute=False`, `reason="fail_closed_unknown_risk_tier"`) whenever any verification signal contains an unrecognized `risk_tier`, even if the partner is allowlisted.

**Blocked by:** None (can start immediately)

**Status:** ready-for-agent

- [ ] Add an anonymized replay fixture under `tests/fixtures/order_triage/` with an unknown `risk_tier` (e.g. `"unexpectedTier"`) on an allowlisted partner
- [ ] Add a public-seam test in `tests/test_order_triage.py` asserting `Decision.MANUAL_REVIEW`, `auto_execute is False`, and `reason == "fail_closed_unknown_risk_tier"`
- [ ] Implement the fail-closed check in `src/app/processors/order_triage.py` following TDD (red → green)
- [ ] `python scripts/check.py` passes all 6 gates with zero new ratchet violations and `>= 85%` AST mutation kill rate
