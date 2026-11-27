# sandcastle-python-workflow

A complete, loop-proof **Matt Pocock + Sandcastle (`@ai-hero/sandcastle`)** engineering workflow template for Python automation repos using **Codex in VS Code**, **WSL2 + Docker Desktop**, **`pip` + `.venv`**, and **local-first → GitHub** issue tracking.

## Why This Repo Exists

Unconstrained LLM chats often get stuck in endless loops, weaken existing tests, silence linters, or lose track of tasks. This template moves control out of the LLM's head and into deterministic code across **6 layers**:

1. **Harness & Codex Loop Guards (`AGENTS.md`, `docs/agents/*`)** — Lean navigation map configured for `mattpocock/skills` v1.3.2 (fresh subagent contexts, bounded grilling, 2-strike retry ceiling, default `medium` effort).
2. **Persistent Domain & Governance Docs** — `GLOSSARY.md`, Chesterton's Fence ADRs (`docs/adr/`), `.out-of-scope/`, and reviewer-only `CODING_STANDARDS.md` (withheld from implementers to keep context clean).
3. **Brake 1 — 6-Gate Deterministic Python Verification (`python scripts/check.py`)**:
   - `ruff format --check`
   - Monotonic ratchet (`scripts/ratchet.py`): `ruff`, `pyright --strict`, banned `# noqa` / `# type: ignore` disables, external SDK import boundaries, and secret/token scanning
   - Deep-module architecture contract (`import-linter`)
   - Behavioral public-seam replay tests (`pytest --cov=src`)
   - **Strict Anti-Tampering & Coverage Floor (`scripts/test_guard.py`)**: AST-verified lock preventing agents from deleting/renaming existing tests, reducing assertions, adding `skip`/`xfail`/`assert True`, editing historical fixture JSONs, or dropping coverage
   - **AST Mutation Checker (`scripts/mutation_check.py`)**: Injects real logic/fail-closed bugs into an isolated temp copy and verifies tests actually kill them (`>= 85%` kill rate)
4. **Visible Local Tracker + GitHub Switchover** — `scripts/local_tracker.py` (`board`, `list --json`, `view`, `comment`, `set-status`, `resolve`, `export-github`) plus `.github/PULL_REQUEST_TEMPLATE.md`, `ci.yml`, and automated `ratchet-shrink.yml`.
5. **Loop-Proof Sandcastle Orchestrator + Deterministic Drift Watchdog (`.sandcastle/`)** — TypeScript state machine (`run.ts` + `drift-watchdog.ts`) running Codex inside isolated Docker worktree containers with pre-baked `/opt/venv` tooling, read-only `~/.codex/auth.json` mount, live `AbortController` drift tripwires (wall-clock timeout, tool-call thrash, diff blast radius, context rot), 1-shot Decomposer auto-splitting (`decompose-prompt.md`, max depth 1), deterministic `sandbox.exec()` gates, and fresh-context adversarial review (`high` effort). Any cap or test-tamper triggers an automatic `ready-for-human` escalation.
6. **Binary Readiness Verifier (`python scripts/verify_workflow_ready.py`)** — Confirms all layers pass before shipping real code.

## Quickstart (WSL2 + Docker Desktop)

See [DEPLOY_WORKFLOW.md](./DEPLOY_WORKFLOW.md) for the exact step-by-step setup, local smoke test, daily shipping loop, local `pre-commit`/`pre-push` branch locks (`scripts/branch_guard.py`), and 2-minute switch to server-enforced GitHub Issues & Actions. For multi-thousand-line legacy scripts, see [LEGACY_REFACTORING_PLAYBOOK.md](./LEGACY_REFACTORING_PLAYBOOK.md) and [docs/EASY_TO_CHANGE_GUIDE.md](./docs/EASY_TO_CHANGE_GUIDE.md). For Level 2 Goal Autonomy, Overnight Architecture Bots, Parallel Prototype Bake-Offs, and Parameter Tuning, see [docs/AUTONOMY_AND_BOTS_GUIDE.md](./docs/AUTONOMY_AND_BOTS_GUIDE.md).

```bash
# 1. Python venv + dev tooling
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements-dev.txt -e .

# 2. Verify all 6 deterministic Python gates + adversarial anti-cheat self-tests
python scripts/check.py
pytest tests_tooling

# 3. Verify all workflow layers
python scripts/verify_workflow_ready.py

# 4. Run the real-Docker synthetic E2E test with live PM Mission Control Dashboard (http://127.0.0.1:4311)
docker build -f .sandcastle/Dockerfile -t sandcastle:python-codex .
npm --prefix .sandcastle ci
DASHBOARD_KEEP_OPEN_SEC=60 npm --prefix .sandcastle run e2e
```
