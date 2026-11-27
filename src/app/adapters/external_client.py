"""Thin boundary protocol isolating third-party SDKs from core processing logic."""

from __future__ import annotations

from dataclasses import dataclass
from enum import StrEnum
from typing import Protocol


class Decision(StrEnum):
    AUTO_APPROVE = "AUTO_APPROVE"
    REJECT = "REJECT"
    MANUAL_REVIEW = "MANUAL_REVIEW"


class ExternalClientError(RuntimeError):
    """Raised when an upstream external service fails, times out, or returns malformed data."""


@dataclass(frozen=True)
class OrderRecord:
    order_id: str
    partner_id: str
    customer_email: str
    channel: str
    region: str


@dataclass(frozen=True)
class VerificationSignal:
    channel: str
    region: str
    payment_verified: bool
    address_matched: bool
    risk_tier: str


@dataclass(frozen=True)
class TriageResult:
    order_id: str
    decision: Decision
    auto_execute: bool
    reason: str
    evidence_summary: tuple[str, ...]


class ExternalClient(Protocol):
    """Minimal read-only seam required by order triage processors."""

    def get_order(self, order_id: str) -> OrderRecord | None:
        """Return typed OrderRecord or None when the order cannot be found."""
        ...

    def get_verification_signals(
        self, partner_id: str, order_id: str
    ) -> tuple[VerificationSignal, ...]:
        """Return corroborating VerificationSignals for an Order."""
        ...

    def is_allowlisted_partner(self, partner_id: str) -> bool:
        """Return True only when partner_id matches an explicit audited Allowlist entry."""
        ...
