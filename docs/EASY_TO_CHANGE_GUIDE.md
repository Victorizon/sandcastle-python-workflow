# Making a Legacy Repo Easy to Change (ETC Guide)

> *"A good repo is one in which things are easy to change."*

You do not transform a multi-year, over-patched codebase with a risky "stop everything and rewrite it" project. You transform it by **flipping the direction of entropy** on every normal feature or maintenance ticket you already have to deliver.

---

## The 5 Shifts

### 1. Only Prefactor Where You Actually Touch (Kent Beck's Rule)
> *"Make the change easy (warning: this may be hard), then make the easy change."*

- Ignore the cold 70% of legacy code that nobody edits; leave its existing lint/type debt frozen in `scripts/ratchet-baseline.json`.
- Whenever a real ticket lands in a painful part of a large script, use [LEGACY_REFACTORING_PLAYBOOK.md](../LEGACY_REFACTORING_PLAYBOOK.md) to carve **just that subsystem** into a small, clean module first, then make the requested change on the clean module.
- Within 2–3 months, the active code you touch every week becomes clean, typed, and fast to change.

### 2. Separate "Fetching" From "Deciding" (Fast Local Test Seams)
Legacy scripts are scary to modify when business logic is glued directly to live external API calls and raw nested JSON dicts.
- Keep all external SDK/HTTP calls inside one thin adapter protocol (`src/app/adapters/`).
- Keep parsing and decision logic as pure functions over frozen dataclasses (`src/app/processors/`).
- When 20 anonymized replay fixtures run in **0.1 seconds** on your laptop without touching live systems, fear disappears — and low fear makes code easy to change.

### 3. Collapse Scattered Patches Into Deep Modules
Years of urgent patches spread one concept across many places (**Shotgun Surgery**).
- Before slicing tickets in a messy area, run **`$improve-codebase-architecture`** to identify shallow, scattered code and design **one deep module** with a small, clear public entry point.
- Build vertically by concrete anonymized fixtures — never ask an LLM for a "unified framework" up front (**Rule of Three**: write simple direct code for slices 1–3, then extract only the small helper that genuinely repeated).

### 4. Keep Quality One-Way (Ratchets Only Move Forward)
- `scripts/ratchet.py`, `scripts/test_guard.py`, `scripts/coverage-baseline.json`, `scripts/mutation_check.py`, and `.github/workflows/ratchet-shrink.yml` turn entropy into a **one-way valve**.
- Every merged PR either holds debt flat or permanently shrinks it.

### 5. Evict Tribal Memory Into Fixtures, 3-Sentence ADRs, and a Lean Glossary
Whenever you uncover a weird historical quirk buried in legacy code:
1. **Lock it in a fixture:** Save an anonymized input/output replay under `tests/fixtures/` so `pytest` + `scripts/test_guard.py` protect it forever.
2. **Record surprising trade-offs:** Write a 1-paragraph ADR in `docs/adr/` (only when hard to reverse, surprising without context, and a real trade-off).
3. **Keep `GLOSSARY.md` lean (10–40 terms):** Only include project-specific terms with real synonym collisions (`_Avoid_`) or high-stakes domain distinctions — zero implementation details, zero general programming terms. If the repo grows into multiple distinct sub-domains, split into a root `GLOSSARY-MAP.md` pointing to small per-domain glossaries.

---

## What the 90-Day Curve Feels Like

- **Weeks 1–2:** Slightly slower while freezing baselines and capturing your first 10–15 real anonymized characterization fixtures on your highest-churn script.
- **Month 1:** Your busiest parser/decision paths live in clean ~150-line typed modules verified in 0.1s; Sandcastle handles slices cleanly without looping.
- **Month 3:** Most incoming work lands inside deep modules guarded by immutable regression tests — turning a fragile legacy codebase into one that is genuinely **easy to change**.
