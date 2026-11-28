# Deploying `sandcastle-python-workflow` (Local-First → GitHub)

This template installs the **complete, loop-proof Matt Pocock + Sandcastle workflow** for a Python automation repo using **Codex in VS Code**, **WSL2 + Docker Desktop**, **`pip` + `.venv`**, and **ChatGPT/Enterprise Codex auth (`~/.codex/auth.json`)**.

> **Critical WSL2 Rule:** Keep your git repo inside the **WSL2 Linux filesystem** (e.g., `~/code/your-repo`), **never** on `/mnt/c/...`. Docker bind-mounts, git worktrees, and file permissions are drastically faster and bug-free on WSL2 ext4.

---

## Adopt Into an Existing Repo (WSL2 Copy-Paste)

Already have an existing Python repo cloned in WSL2? Set `TARGET` and `TOOLBOX` to your two paths and run these 4 blocks in your WSL2 terminal (never overwrites your `.git/`, `src/`, or existing code):

```bash
# 1. Set your paths and create a clean adoption branch
TARGET=~/code/your-existing-repo
TOOLBOX=~/code/sandcastle-python-workflow

cd "$TARGET"
git checkout -b chore/adopt-workflow
```

```bash
# 2. Copy ONLY the workflow toolbox in (skips existing files, removes template baselines)
cp -rn "$TOOLBOX/.sandcastle" "$TOOLBOX/scripts" "$TOOLBOX/docs" "$TOOLBOX/.codex" "$TOOLBOX/.github" .
cp -n "$TOOLBOX/AGENTS.md" "$TOOLBOX/.pre-commit-config.yaml" "$TOOLBOX/requirements-dev.txt" "$TOOLBOX/pyproject.toml" .
rm -f scripts/ratchet-baseline.json scripts/bloat-baseline.json scripts/coverage-baseline.json
```

```bash
# 3. Authenticate Codex, install .venv + Docker image, and freeze Day-1 baselines
codex login
python3 scripts/setup.py --init-baselines
```

```bash
# 4. Commit the Day-1 baseline and open in VS Code (WSL2 Remote)
git add -A
git commit -m "chore: adopt sandcastle workflow with Day-1 baselines"
code .
```

> **Next in VS Code (Codex):**
> - Optional legacy onboarding: `.venv/bin/python scripts/adr_miner.py mine` → run **`$grill-me`** over `docs/adr/drafts/*.md` → approve real ADRs (`python scripts/adr_miner.py approve <draft>`).
> - Daily shipping loop: `$grill-me` → `$to-spec` → `$to-tickets` → commit tickets → `npm --prefix .sandcastle run factory`.

---

## Quick One-Command Install (Fresh Repo From Template)

Run the idempotent cross-platform installer (uses Python stdlib only — works on Windows, WSL2, macOS, and Linux before `.venv` exists):

```bash
# 1. Preflight check only (makes zero changes; prints exact fix hints for anything missing)
python scripts/setup.py --check-only

# 2. Full automated setup (.venv, pre-commit/pre-push hooks, .sandcastle npm, Docker image, readiness verifier)
python scripts/setup.py
# Useful flags:
#   --skip-docker      Skip Docker daemon check & image build
#   --skip-node        Python-only setup (skip .sandcastle npm install)
#   --init-baselines   Capture initial ratchet, bloat & coverage baselines from an existing repo
```

If you prefer manual step-by-step setup, follow Steps 1–4 below.

---

## Step 1: Clone the Template (Fresh Project in WSL2)

```bash
git clone https://github.com/<your-user>/sandcastle-python-workflow.git ~/code/my-project
cd ~/code/my-project
```

Ensure your coding agent harness uses **`mattpocock/skills` v1.3.2** (which fixes Codex subagent context forking) and has **no overlapping/competing third-party TDD or code-review skills** installed.

---

## Step 2: Set Up Python `pip` + `.venv` and Initialize Baselines

```bash
python3 -m venv .venv
source .venv/bin/activate
pip install --upgrade pip
pip install -r requirements-dev.txt
pip install -e .

# On an existing legacy repo ONLY, capture initial baseline debt ONCE:
# rm -f scripts/ratchet-baseline.json scripts/coverage-baseline.json
# python scripts/ratchet.py --init

pre-commit install --hook-type pre-commit --hook-type pre-push
```

> **Working on large legacy scripts (3,000–5,000+ lines)?** Read [LEGACY_REFACTORING_PLAYBOOK.md](./LEGACY_REFACTORING_PLAYBOOK.md) before writing your first ticket.

Verify all 6 deterministic Python gates + tooling anti-cheat self-tests immediately:
```bash
python scripts/check.py
pytest tests_tooling
```

---

## Step 3: Authenticate Codex & Build the Sandcastle Docker Image (in WSL2)

```bash
# 1. Confirm ChatGPT / Enterprise Codex login exists in WSL2:
codex login
ls -la ~/.codex/auth.json

# 2. Install Sandcastle dependencies and typecheck the orchestrator:
cd .sandcastle
npm install
npm run typecheck
cd ..

# 3. Build the Python + Codex Docker image with host UID/GID alignment:
npx --prefix .sandcastle sandcastle docker build-image -f .sandcastle/Dockerfile -t sandcastle:python-codex
```

---

## Step 4: Run the Binary Readiness Check

```bash
python scripts/verify_workflow_ready.py
```

Every layer must print **`[PASS]`**. Once all 5 layers pass, workflow setup is **complete**.

---

## Step 5: Run the 1-Ticket Local Smoke Test Through Sandcastle

```bash
python scripts/local_tracker.py board
npm --prefix .sandcastle run factory
python scripts/local_tracker.py board
```

Watch the deterministic outer loop execute:
1. **Planner** reads `.scratch/workflow-smoke-test/issues/01-fail-closed-unknown-risk-tier.md` → typed `<plan>` JSON.
2. **Implementer** (Codex `medium`) implements the fail-closed rule via TDD inside an isolated Docker worktree container (`maxIterations: 4`).
3. **Hard Anti-Tamper Lock + 6-Gate Shell Referee** runs `scripts/test_guard.py --base main` and `scripts/check.py` (including coverage floor and AST mutation check). Any test tampering escalates immediately to `ready-for-human`.
4. **Fresh-Context Adversarial Reviewer** (Codex `high` + `CODING_STANDARDS.md`) audits the diff along Standards + Spec axes (capped at 2 rounds).
5. **Merger** merges the approved branch into `main`, re-runs `scripts/check.py`, and marks the ticket `resolved`.

---

## Step 6: Daily Shipping Loop

1. **Interactive Design (Codex in VS Code):** `$grill-me` (capped at 3 batches) → `$to-spec` → `$to-tickets` → commit tickets.
2. **Deterministic Execution (Sandcastle in WSL2):** `npm --prefix .sandcastle run factory`.
3. **Human Review & Compounding:** Review PR summary via `$pr` (One-Way Door rubric), then run `$retro` to promote every bug or edge case into a new fixture in `tests/fixtures/`, a rule in `scripts/ratchet.py`, or `CODING_STANDARDS.md`.

---

## Step 7: 2-Minute Switch from Local → GitHub

1. Push your repo to GitHub (`git remote add origin <url> && git push -u origin main`).
2. Create the 5 triage labels:
   ```bash
   for lbl in needs-triage needs-info ready-for-agent ready-for-human wontfix; do
     gh label create "$lbl" --force
   done
   ```
3. Swap the tracker doc: `cp docs/agents/issue-tracker.github.md docs/agents/issue-tracker.md`
4. Export remaining open local tickets: `python scripts/local_tracker.py export-github`
5. Update `.sandcastle/*-prompt.md` from `scripts/local_tracker.py` to `gh issue` commands. `.github/workflows/ci.yml` and `.github/workflows/ratchet-shrink.yml` activate automatically on GitHub.
6. **Make the workflow server-enforced (unskippable for both humans and agents):**
   - Go to **GitHub Repo Settings → Branches / Rulesets → Protect `main`**
   - Enable **Require a pull request before merging**
   - Enable **Require status checks to pass before merging** → select **`verify`** (from `.github/workflows/ci.yml`)
   - Enable **Do not allow bypassing the above settings** (applies even to repository admins)
   - Under **Settings → Actions → General → Workflow permissions**, enable **Allow GitHub Actions to create and approve pull requests** (required for automated `ratchet-shrink.yml` PRs)
