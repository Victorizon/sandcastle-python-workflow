# Order Triage Automation

Reference domain for this workflow template: automated Python order-triage processing that evaluates incoming orders against external verification signals and returns deterministic decisions.

## Language

### Core Concepts

**Order**:
A single customer purchase request submitted for a **Triage Run**.
_Avoid_: Record, item, payload, job

**Triage Run**:
An automated end-to-end evaluation of one **Order** that gathers **Verification Signals** and emits a **Decision**.
_Avoid_: Script run, pipeline execution, check

**Verification Signal**:
Corroborating data fetched from an **External Client** (such as payment verification, address match, or risk tier) used to evaluate an **Order**.
_Avoid_: Metadata, raw response, log

**External Client**:
A thin adapter boundary wrapping third-party APIs or SDKs that this repository does not own.
_Avoid_: Integration, wrapper, helper

### Outcomes

**Decision**:
The canonical outcome produced by a **Triage Run**: `AUTO_APPROVE`, `REJECT`, or `MANUAL_REVIEW`.
_Avoid_: Status, verdict, action, result

**Fail-Closed Review**:
Returning `MANUAL_REVIEW` with `auto_execute=False` whenever **Verification Signals** are missing, an **External Client** raises an error, or evidence is ambiguous.
_Avoid_: Soft fail, fallback approve, default pass

**Allowlist**:
An explicit, audited partner or account rule permitting **Auto-Approve** when all required **Verification Signals** also pass.
_Avoid_: Whitelist, override, bypass

**Auto-Approve**:
Approving an **Order** automatically without human intervention; permitted only when strong positive signals corroborate eligibility and no **Fail-Closed Review** condition holds.
_Avoid_: Auto-close, instant pass
