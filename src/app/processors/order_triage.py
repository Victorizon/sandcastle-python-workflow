"""Reference deep module: fail-closed order triage processor."""

from __future__ import annotations

from app.adapters.external_client import (
    Decision,
    ExternalClient,
    ExternalClientError,
    TriageResult,
    VerificationSignal,
)


def _fail_closed(order_id: str, reason: str) -> TriageResult:
    return TriageResult(
        order_id=order_id,
        decision=Decision.MANUAL_REVIEW,
        auto_execute=False,
        reason=reason,
        evidence_summary=(),
    )


def _evaluate_signals(
    order_id: str,
    partner_id: str,
    allowlisted: bool,
    signals: tuple[VerificationSignal, ...],
) -> TriageResult:
    if not signals:
        return _fail_closed(order_id, "fail_closed_missing_signals")

    all_verified = all(s.payment_verified and s.address_matched for s in signals)
    if allowlisted and all_verified and all(s.risk_tier == "low" for s in signals):
        return TriageResult(
            order_id=order_id,
            decision=Decision.AUTO_APPROVE,
            auto_execute=True,
            reason="corroborated_allowlisted_order_with_verified_signals",
            evidence_summary=(
                f"partner_id={partner_id} matched allowlist",
                f"verified {len(signals)} low-risk signal(s)",
            ),
        )

    high_risk_unverified = any(
        s.risk_tier == "high" and (not s.payment_verified or not s.address_matched) for s in signals
    )
    if high_risk_unverified and not allowlisted:
        return TriageResult(
            order_id=order_id,
            decision=Decision.REJECT,
            auto_execute=False,
            reason="high_risk_unverified_order_from_non_allowlisted_partner",
            evidence_summary=(
                f"partner_id={partner_id} not allowlisted",
                "detected high-risk signal without payment or address match",
            ),
        )

    return TriageResult(
        order_id=order_id,
        decision=Decision.MANUAL_REVIEW,
        auto_execute=False,
        reason="fail_closed_ambiguous_signals",
        evidence_summary=(f"observed {len(signals)} signal(s) requiring manual review",),
    )


def triage_order(order_id: str, client: ExternalClient) -> TriageResult:
    """Evaluate an Order using corroborated VerificationSignals.

    Fail-closed invariant (ADR-0002): missing VerificationSignals, upstream
    ExternalClientError, or ambiguous evidence returns Decision.MANUAL_REVIEW
    with auto_execute=False.
    """
    try:
        order = client.get_order(order_id)
    except ExternalClientError as exc:
        return _fail_closed(order_id, f"fail_closed_client_error: {exc}")

    if order is None:
        return _fail_closed(order_id, "fail_closed_order_not_found")

    try:
        signals = client.get_verification_signals(order.partner_id, order.order_id)
        allowlisted = client.is_allowlisted_partner(order.partner_id)
    except ExternalClientError as exc:
        return _fail_closed(order_id, f"fail_closed_signals_error: {exc}")

    return _evaluate_signals(order_id, order.partner_id, allowlisted, signals)
