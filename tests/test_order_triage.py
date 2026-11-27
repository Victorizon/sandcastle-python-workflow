"""Behavioral public-seam tests for order triage processor."""

from __future__ import annotations

from pathlib import Path

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
