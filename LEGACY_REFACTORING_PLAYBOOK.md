# Legacy Refactoring Playbook (Multi-Thousand-Line Python Scripts)

Refactoring a 3,000–5,000+ line script patched over years is where barebone AI chats fail hardest: invisible historical edge cases get silently deleted, huge diffs spiral out of control, and deadlines slip.

This playbook uses **Strangler-Fig Extraction + Characterization Fixtures + Expand–Contract** inside the `sandcastle-python-workflow` guardrails so `main` stays green and shippable after **every single ticket**. For the broader mindset and 90-day trajectory, see [docs/EASY_TO_CHANGE_GUIDE.md](./docs/EASY_TO_CHANGE_GUIDE.md).

---

## Core Rules (Non-Negotiable)

1. **Never refactor a huge legacy file in place.** Carve out one cohesive subsystem at a time into a new, small, strictly typed module under `src/`.
2. **Never mix "extract/refactor" and "new behavior" in the same ticket.** Prove zero behavior regression first; add improvements in the next ticket on the clean extracted module.
3. **Never touch untouched legacy lint/type debt.** Freeze it once with `python scripts/ratchet.py --init` and pay it down monotonically as modules are extracted.
4. **Hard 30-Minute Circuit Breaker:** Sandcastle stops automatically after 2 verify retries or 2 review rounds (`ready-for-human`). Apply the same rule to yourself: if a ticket stalls for > 30 minutes, stop — the slice is too large or missing a real input fixture. Split the ticket instead of grinding.

---

## The 5-Step Sequence

### Step 1: Freeze Legacy Debt Once
```bash
rm -f scripts/ratchet-baseline.json scripts/coverage-baseline.json
python scripts/ratchet.py --init
pytest --cov=src --cov-report=json:.coverage.json
python scripts/test_guard.py --base HEAD --coverage-json .coverage.json
rm -f .coverage.json
```
Existing warnings and low initial coverage are now frozen as baselines. No new warnings or coverage drops are permitted from this commit forward.

### Step 2: Ticket 01 — Pin Down Current Behavior (Characterization Fixtures)
Before changing a single line of legacy logic:
- Collect **10–20 real anonymized historical input payloads** (especially ugly edge cases that caused regressions in the past).
- Record what the **existing** legacy function outputs for each payload.
- Save `(input -> expected output)` as replay fixtures under `tests/fixtures/` and public-seam tests under `tests/`.
- Commit and merge. `scripts/test_guard.py` now **mechanically prevents any agent from deleting or weakening these historical regression tests**.

### Step 3: Ticket 02 — Expand (Extract Clean Module Alongside Legacy Code)
Use `$grill-me` → `$to-spec` → `$to-tickets` to extract **only the target subsystem** (e.g., an event parser) into a new ~150-line module under `src/app/processors/` without deleting the old code yet:
- New file meets the **zero-violation budget** (`ruff`, `pyright --strict`, zero `# noqa`/`# type: ignore`).
- Prove via `pytest` + `scripts/mutation_check.py` (`>= 85%` kill rate) that the new module matches the legacy parser 100% on every characterization fixture.

### Step 4: Ticket 03 — Improve (Add New Behavior on the Clean Module)
Now add the requested parsing improvements + new edge-case fixtures to the clean ~150-line module. Context stays tiny, diffs stay small (~100–200 lines), and `scripts/check.py` validates every edge case in seconds.

### Step 5: Ticket 04 — Switch & Contract
- Replace the old parsing block inside the legacy script with a 3-line call to the new extracted module.
- Delete the dead legacy parsing block.
- Run `python scripts/check.py` and `python scripts/ratchet.py --shrink` to permanently lower the debt baseline.
- Run `$retro` to capture any surprising legacy invariant in `docs/adr/` and `GLOSSARY.md`.

---

## Making the Workflow Unskippable (Humans + Agents)

| Enforcement Layer | How to Enable | What It Stops |
| :--- | :--- | :--- |
| **Local Git Hooks** | `pre-commit install --hook-type pre-commit --hook-type pre-push` | Blocks direct `src/` commits on `main`, blocks unformatted/ratchet-breaking commits, and runs full 6-gate `scripts/check.py` before every push. |
| **Sandcastle Outer Loop** | `npm --prefix .sandcastle run factory` | Mounts `.git/hooks` & `.git/config` read-only; runs `test_guard.py` + `check.py` from host; caps retries & review rounds; escalates tampering to `ready-for-human`. |
| **GitHub Branch Protection** *(Truly Unskippable)* | Repo Settings → Rules / Branch Protection on `main` → Require PR + Require status check `CI / verify` + **Do not allow bypassing (including admins)** | Server-side lock: neither an AI agent nor a human under deadline pressure can merge code that skipped tests, tampered with fixtures, dropped coverage, or failed mutation checks. |
