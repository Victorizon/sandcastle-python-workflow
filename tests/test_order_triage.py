"""Behavioral public-seam tests for order triage processor."""

from __future__ import annotations

from dataclasses import dataclass
from pathlib import Path

from hypothesis import given
from hypothesis import strategies as st

from app.adapters.external_client import Decision
from app.processors.order_triage import triage_order
from tests.fakes.fake_external_client import FakeExternalClient

FIXTURES = Path(__file__).parent / "fixtures" / "order_triage"


def test_high_risk_unverified_order_is_rejected() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "high_risk_unverified_reject.json")

    result = triage_order("ord-rej-001", client)

    assert result.decision is Decision.REJECT
    assert result.auto_execute is False


def test_allowlisted_verified_low_risk_order_auto_approves() -> None:
    client = FakeExternalClient.from_fixture_file(
        FIXTURES / "allowlisted_verified_auto_approve.json"
    )

    result = triage_order("ord-ok-002", client)

    assert result.decision is Decision.AUTO_APPROVE
    assert result.auto_execute is True


def test_missing_verification_signals_fail_closed_to_manual_review() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "missing_signals_fail_closed.json")

    result = triage_order("ord-missing-003", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False


def test_signals_api_error_fails_closed_to_manual_review() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "signals_api_error_fail_closed.json")

    result = triage_order("ord-err-004", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    assert "fail_closed_signals_error" in result.reason


def test_missing_order_fails_closed_to_manual_review() -> None:
    client = FakeExternalClient.from_fixture_file(
        FIXTURES / "allowlisted_verified_auto_approve.json"
    )

    result = triage_order("ord-does-not-exist", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    assert result.reason == "fail_closed_order_not_found"


def test_order_lookup_error_fails_closed_to_manual_review() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "order_lookup_error_fail_closed.json")

    result = triage_order("ord-lookup-err", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    assert "fail_closed_client_error" in result.reason


def test_non_allowlisted_low_risk_order_is_ambiguous_and_fails_closed() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "ambiguous_non_allowlisted_order.json")

    result = triage_order("ord-ambig-005", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    assert result.reason == "fail_closed_ambiguous_signals"


def test_allowlisted_order_with_unmatched_address_must_not_auto_approve() -> None:
    client = FakeExternalClient.from_fixture_file(
        FIXTURES / "allowlisted_unmatched_address_fail_closed.json"
    )

    result = triage_order("ord-partial-006", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False


def test_high_risk_order_with_payment_only_and_unmatched_address_is_rejected() -> None:
    client = FakeExternalClient.from_fixture_file(FIXTURES / "high_risk_partial_match_reject.json")

    result = triage_order("ord-rej-partial-007", client)

    assert result.decision is Decision.REJECT
    assert result.auto_execute is False


def test_non_allowlisted_low_risk_unverified_order_fails_closed_not_rejected() -> None:
    client = FakeExternalClient.from_fixture_file(
        FIXTURES / "non_allowlisted_low_risk_unverified_fail_closed.json"
    )

    result = triage_order("ord-low-unverif-008", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    assert result.reason == "fail_closed_ambiguous_signals"


@dataclass(frozen=True)
class FuzzedOrderCase:
    allowlisted: bool
    payment_verified: bool
    address_matched: bool
    risk_tier: str
    channel: str
    region: str


@given(
    case=st.builds(
        FuzzedOrderCase,
        allowlisted=st.booleans(),
        payment_verified=st.booleans(),
        address_matched=st.booleans(),
        risk_tier=st.text(max_size=30),
        channel=st.text(max_size=20),
        region=st.text(max_size=10),
    )
)
def test_property_never_auto_executes_without_all_positive_invariants(
    case: FuzzedOrderCase,
) -> None:
    partner = "partner-trusted-01"
    client = FakeExternalClient(
        {
            "order": {
                "order_id": "ord-prop-001",
                "partner_id": partner,
                "customer_email": "fuzz.demo@example.test",
                "channel": case.channel,
                "region": case.region,
            },
            "allowlisted_partners": [partner] if case.allowlisted else [],
            "signals": [
                {
                    "channel": case.channel,
                    "region": case.region,
                    "payment_verified": case.payment_verified,
                    "address_matched": case.address_matched,
                    "risk_tier": case.risk_tier,
                }
            ],
        }
    )

    result = triage_order("ord-prop-001", client)

    assert isinstance(result.decision, Decision)
    if result.auto_execute:
        assert case.allowlisted is True
        assert case.payment_verified is True
        assert case.address_matched is True
        assert case.risk_tier == "low"
        assert result.decision is Decision.AUTO_APPROVE
