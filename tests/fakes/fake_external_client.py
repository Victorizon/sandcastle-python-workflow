"""Deterministic in-memory ExternalClient driven by anonymized JSON replay fixtures."""

from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from app.adapters.external_client import (
    ExternalClientError,
    OrderRecord,
    VerificationSignal,
)


class FakeExternalClient:
    """Replay fixture adapter implementing ExternalClient without network calls."""

    def __init__(self, fixture: dict[str, Any]) -> None:
        self._fixture = fixture

    @classmethod
    def from_fixture_file(cls, path: Path) -> FakeExternalClient:
        data = json.loads(path.read_text(encoding="utf-8"))
        return cls(data)

    def get_order(self, order_id: str) -> OrderRecord | None:
        if self._fixture.get("raise_on_order"):
            raise ExternalClientError(str(self._fixture["raise_on_order"]))
        raw = self._fixture.get("order")
        if raw is None or raw.get("order_id") != order_id:
            return None
        return OrderRecord(
            order_id=str(raw["order_id"]),
            partner_id=str(raw["partner_id"]),
            customer_email=str(raw["customer_email"]),
            channel=str(raw["channel"]),
            region=str(raw["region"]),
        )

    def get_verification_signals(
        self, partner_id: str, order_id: str
    ) -> tuple[VerificationSignal, ...]:
        if self._fixture.get("raise_on_signals"):
            raise ExternalClientError(str(self._fixture["raise_on_signals"]))
        _ = (partner_id, order_id)
        raw_signals = self._fixture.get("signals", [])
        return tuple(
            VerificationSignal(
                channel=str(sig["channel"]),
                region=str(sig["region"]),
                payment_verified=bool(sig["payment_verified"]),
                address_matched=bool(sig["address_matched"]),
                risk_tier=str(sig["risk_tier"]),
            )
            for sig in raw_signals
        )

    def is_allowlisted_partner(self, partner_id: str) -> bool:
        allowlisted = {str(pid) for pid in self._fixture.get("allowlisted_partners", [])}
        return partner_id in allowlisted
