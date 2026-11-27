# Coding Standards (Reviewer-Only Reference)

> **Important:** This document is read by fresh-context `$code-review` and Sandcastle Reviewer agents — **not** by implementers during feature coding. Mechanical rules belong in `scripts/check.py` and `scripts/ratchet.py`; this file captures architectural judgement calls and reliability invariants.

---

## 1. Fail-Closed & Data Safety Invariants (Blocking)

1. **Fail closed on uncertainty:** Missing **Verification Signals**, partial API responses, timeouts, or unexpected enum/string values MUST result in `Decision.MANUAL_REVIEW` with `auto_execute=False` and a clear structured reason. Never catch an exception and return `AUTO_APPROVE`.
2. **One-Way Door isolation:** Any automated state-mutating action (`auto_execute=True`) must be separated cleanly from pure signal evaluation so decisions can be audited and dry-run tested without mutating live external systems.
3. **Strict PII & secret redaction:** Never log, hardcode, or commit bearer tokens, API keys, private keys, or real customer PII. Replay fixtures in `tests/fixtures/` must use synthetic domains (`example.test`, `corp.invalid`) and RFC 5737 documentation IPs (`192.0.2.x`, `198.51.100.x`, `203.0.113.x`).
4. **No silent exception swallowing:** Bare `except:` or `except Exception: pass` is always blocking. Catch explicit boundary errors (`ExternalClientError`), record structured context, and fail closed.

---

## 2. Deep Modules & Adapter Boundary

1. **Strict boundary:** Only modules inside `src/app/adapters/` may import external vendor SDKs (enforced mechanically by `import-linter` and `scripts/ratchet.py`; see `docs/adr/0001-external-client-adapter-boundary.md`).
2. **Deep over shallow:** Prefer one cohesive processor module with a narrow public entry point (e.g., `triage_order(order_id, client) -> TriageResult`) over fragmented helper chains or pass-through wrapper classes.
3. **Typed domain models at boundaries:** Parse raw external dictionaries into frozen dataclasses inside the adapter layer. Processors operate on domain types (`OrderRecord`, `VerificationSignal`, `Decision`), never raw nested JSON dicts.
4. **Avoid speculative generality:** Do not introduce abstract base hierarchies, plugin registries, or flags for hypothetical requirements outside the ticket spec.

---

## 3. Testing Standards & Strict Mechanical Locks

1. **Test at public seams only:** Tests under `tests/` call the processor's public entry point with `FakeExternalClient` loaded from anonymized JSON replay fixtures.
2. **Never mock internal helpers:** Mock only at true system boundaries (`ExternalClient`, clock/time, external HTTP). Tests must survive internal refactors without breaking.
3. **No tautological assertions:** Expected decisions and reasons must be explicit literals derived from requirements, never recomputed using the production helper under test.
4. **Mandatory four-case coverage per processor:** Every new or modified rule must have replay tests covering:
   - Confirmed `REJECT` / high-risk case
   - Confirmed `AUTO_APPROVE` case (corroborated positive signals)
   - Missing or incomplete signals → `MANUAL_REVIEW`
   - Upstream `ExternalClientError` → `MANUAL_REVIEW`
   - At least one **Hypothesis (`@given`) property-based fuzz test** for every parser or decision rule proving random/malformed inputs never crash unhandled and never trigger `auto_execute=True` improperly.
5. **Never delete or weaken tests to satisfy checks:** Enforced mechanically by:
   - `scripts/test_guard.py` (blocks deleting/renaming existing `def test_*`, reducing assertion counts, `skip`/`xfail`/`assert True`, or modifying existing `tests/fixtures/*.json`)
   - `scripts/coverage-baseline.json` (monotonic line coverage floor over `src/`)
   - `scripts/mutation_check.py` (AST mutation kill-rate `>= 85%`)

---

## 4. Monotonic Ratchet Discipline

`python scripts/check.py` enforces `scripts/ratchet.py` (`scripts/ratchet-baseline.json`):

- **New files have zero budget:** Every new file must have 0 `ruff`, 0 `pyright --strict`, 0 disable-comment (`# noqa`, `# type: ignore`, `# pyright: ignore`), 0 forbidden SDK import, and 0 secret/token violations.
- **Baselines only shrink:** Never edit `scripts/ratchet-baseline.json` upward or add inline suppressions. For move-only refactors shifting existing debt across files, run `python scripts/ratchet.py --transfer`.
- **Keep PR diffs clean:** Fix PRs leave `scripts/ratchet-baseline.json` untouched; `.github/workflows/ratchet-shrink.yml` lowers baselines automatically after merge to `main`.

---

## 5. Readability & Maintainability

- Prefer flat control flow with early returns over deeply nested conditionals.
- Use exact vocabulary from `GLOSSARY.md` for function names, enums, variables, and test names.
- Keep functions focused (`<= 50` lines, complexity `<= 15`) and modules cohesive (`<= 300` lines).
