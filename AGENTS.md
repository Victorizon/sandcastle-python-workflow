# AGENTS.md

Lean navigation map for coding agents working in this repository. Keep this file small; put coding style judgement calls in `CODING_STANDARDS.md` (review-only) and mechanical checks in `scripts/check.py`.

## Agent skills

### Issue tracker

Local markdown tickets under `.scratch/<feature>/issues/` managed via `scripts/local_tracker.py` (switchable to GitHub Issues via `docs/agents/issue-tracker.github.md`). See `docs/agents/issue-tracker.md`.

### Triage labels

Canonical five-role triage vocabulary (`needs-triage`, `needs-info`, `ready-for-agent`, `ready-for-human`, `wontfix`). See `docs/agents/triage-labels.md`.

### Domain docs

Single-context repo (`GLOSSARY.md` + `docs/adr/`). Read `GLOSSARY.md` and relevant ADRs before exploring or writing code. See `docs/agents/domain.md`.

## Codex & Loop Guardrails

- **Fresh subagent contexts:** Always start every subagent with a fresh context window; never fork the parent conversation onto a subagent.
- **Bounded grilling:** During `$grill-me` or `$grill-with-docs`, ask at most 3 focused question batches (max 5 questions per batch). Stop as soon as design branches are resolved.
- **Explicit skill boundaries:** Do not auto-invoke `$diagnosing-bugs` for simple factual questions or code explanations; run it only when investigating an actual defect, failing test, or regression.
- **2-strike retry ceiling:** In interactive sessions, if the same verification gate (`python scripts/check.py`) fails twice after two distinct fix attempts, stop immediately, summarize the blocker, set the ticket status to `ready-for-human`, and hand control back to the human. Never loop indefinitely.
- **Effort discipline:** Default to `medium` reasoning effort. Escalate to `high` only for `$code-review`, web research, or complex debugging.
- **Review vs. implementation split:** Do **not** load `CODING_STANDARDS.md` during normal implementation; it is reserved for fresh-context `$code-review` and Sandcastle Reviewer passes.

## Verification & Navigation

- **Single verification command:** `python scripts/check.py` (format, monotonic ratchet, import boundaries, pytest + coverage floor, anti-tampering test guard, and AST mutation check).
- **Task board:** `python scripts/local_tracker.py board`
- **External SDK boundary:** All calls to third-party APIs/SDKs live strictly under `src/app/adapters/` (see `docs/adr/0001-external-client-adapter-boundary.md`).
- **Safety invariant:** Processing logic must fail closed on errors or missing signals (see `docs/adr/0002-fail-closed-decisions.md`).
- **Rejected ideas:** Check `.out-of-scope/` before proposing architectural changes.
- **Shadow Guide (workflow coach):** Run `npm --prefix .sandcastle run coach` or use the `.agents/skills/workflow-coach` skill for live state-aware next steps and latest PM HTML reports.

## Communication Style (PM-First)

- **Plain English first:** Write summaries and updates as though speaking to a Product Manager with little technical background — lead with **(1) what changed in user/business behavior, (2) what was verified, and (3) any risks or decisions needed**.
- **No vague hand-waving or unexplained jargon:** Never say *"improved robustness"* or drop dense terms without translating them; cite concrete observable behavior instead.
- **Technical depth on demand:** Keep code symbols and file paths brief at the bottom unless the user asks a technical follow-up.
