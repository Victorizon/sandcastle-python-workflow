# Multi-Round SDK Enrichment & "Case Cassette" Testing Pattern

Many real-world Python automation scripts follow a **multi-round lookup loop**:

1. Pull an origin record via a third-party SDK.
2. Parse key entities (account ID, hostname, region, timestamp).
3. Run **Round 1** searches for related records and events.
4. Analyze Round 1 results to decide whether **Round 2** follow-up searches are needed.
5. Correlate everything into a final fail-closed decision.

If live SDK calls are mixed into the parsing and correlation code, Sandcastle cannot refactor, fuzz, or mutation-test your logic inside an offline Docker container.

---

## The Architecture: Thin Adapter Seam + Recorded Case Cassette

Separate your script cleanly into two layers (enforced automatically by `import-linter` and `scripts/ratchet.py`):

1. **`src/app/adapters/<sdk>_client.py` (Thin I/O Adapter):** Wraps the 4–5 real SDK functions behind a typed `Protocol`.
2. **`src/app/processors/<workflow>.py` (Pure Investigation Brain):** Parses the origin record, chooses Round 1 / Round 2 queries, correlates results, and fails closed on missing data or errors.

### 1. Define a Small Typed Protocol

```python
from typing import Any, Protocol


class EnrichmentClient(Protocol):
    def get_origin_record(self, record_id: str) -> dict[str, Any] | None: ...
    def search_related_records(self, entity: str, window_hours: int) -> list[dict[str, Any]]: ...
    def search_events(
        self, query_kind: str, entity: str, window_hours: int
    ) -> list[dict[str, Any]]: ...
```

### 2. Record Anonymized Multi-Round "Case Cassettes" (`tests/fixtures/cases/*.json`)

Capture real multi-round inputs **once** outside Docker, scrub all PII (verified by `ratchet.py`'s fixture email/IP guard), and save as a single self-contained JSON cassette:

```json
{
  "case_id": "case-042-multi-round",
  "origin_record": {
    "record_id": "rec-042",
    "account_email": "member.demo@example.test",
    "device_name": "workstation-01"
  },
  "related_records": {
    "member.demo@example.test": [
      { "record_id": "rec-041", "severity": "high" }
    ]
  },
  "events": {
    "device_activity|workstation-01": [
      { "action": "privilege_change", "ok": true }
    ],
    "followup_audit|member.demo@example.test": [
      { "action": "policy_override", "verified": false }
    ]
  }
}
```

### 3. Replay & Verify Issued Queries With a Stateful Fake (`tests/fakes/`)

```python
from dataclasses import dataclass, field
from typing import Any


@dataclass
class FakeCassetteClient:
    cassette: dict[str, Any]
    issued_queries: list[tuple[str, str, int]] = field(default_factory=list)

    def get_origin_record(self, record_id: str) -> dict[str, Any] | None:
        if "raise_on_origin" in self.cassette:
            raise RuntimeError(self.cassette["raise_on_origin"])
        rec = self.cassette.get("origin_record")
        return rec if rec and rec.get("record_id") == record_id else None

    def search_related_records(self, entity: str, window_hours: int) -> list[dict[str, Any]]:
        self.issued_queries.append(("related_records", entity, window_hours))
        return list(self.cassette.get("related_records", {}).get(entity, []))

    def search_events(
        self, query_kind: str, entity: str, window_hours: int
    ) -> list[dict[str, Any]]:
        self.issued_queries.append((query_kind, entity, window_hours))
        key = f"{query_kind}|{entity}"
        return list(self.cassette.get("events", {}).get(key, []))
```

### 4. Assert BOTH the Verdict AND the Multi-Round Queries

```python
def test_multi_round_enrichment_triggers_followup_query() -> None:
    client = FakeCassetteClient(load_cassette("case-042-multi-round.json"))

    result = evaluate_case("rec-042", client)

    assert result.decision is Decision.MANUAL_REVIEW
    assert result.auto_execute is False
    # Prove Round 1 parsed the right entities AND Round 2 follow-up fired
    assert ("related_records", "member.demo@example.test", 24) in client.issued_queries
    assert ("followup_audit", "member.demo@example.test", 24) in client.issued_queries
```

### 5. Combine With Hypothesis Fuzzing & One Final Live Dry-Run

- **Inside Sandcastle Docker (zero credentials, millisecond runs):** Refactor parsers, add Round 2/3 rules, run `HYPOTHESIS_PROFILE=deep python scripts/check.py` (fuzzing missing entity fields, empty Round 2 lists, malformed strings, and SDK exceptions), and pass mutation + adversarial review.
- **On your host machine (2-minute live check):** Only after Sandcastle hands you a `Spot-Check Ready` branch, run **one read-only dry-run** against a live record to confirm real SDK query syntax matches your adapter.
