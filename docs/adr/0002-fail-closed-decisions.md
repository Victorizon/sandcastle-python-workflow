# Fail-Closed Decisions on Missing Signals or Upstream Errors

Status: accepted
Applies-to: src/app/processors/**

Automatically approving an invalid **Order** or triggering an irreversible action on partial data is a high-blast-radius failure. Every **Triage Run** must return `Decision.MANUAL_REVIEW` with `auto_execute=False` whenever required **Verification Signals** are missing, an **External Client** raises an error or times out, or signals are ambiguous. Only explicit, corroborated positive evidence may set `auto_execute=True`.

## Consequences

- Catching an exception and defaulting to `AUTO_APPROVE` is a blocking defect.
- Every processor test suite must include explicit fail-closed replay fixtures for both missing signals and upstream adapter errors.
