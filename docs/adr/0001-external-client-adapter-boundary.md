# Wrap Third-Party SDKs Behind a Thin Adapter Protocol

Status: accepted
Applies-to: src/app/adapters/**, src/app/processors/**

Third-party APIs and SDKs evolve outside our team's release cycle. We wrap all external network/SDK calls behind a narrow `ExternalClient` `Protocol` under `src/app/adapters/` and forbid processor modules under `src/app/processors/` from importing external SDKs directly. This keeps business logic deterministically testable via `FakeExternalClient` + anonymized JSON replay fixtures and insulates core rules from upstream breaking changes.

## Consequences

- `import-linter` and `scripts/ratchet.py` reject direct `third_party_sdk` imports outside `src/app/adapters/`.
- Upstream SDK integration quirks stay isolated in thin adapter code instead of spreading across business rules.
