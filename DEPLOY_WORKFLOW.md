# Deploying `sandcastle-python-workflow` (Local-First → GitHub)

This template installs the **complete, loop-proof Matt Pocock + Sandcastle workflow** for a Python automation repo using **Codex in VS Code**, **WSL2 + Docker Desktop**, **`pip` + `.venv`**, and **ChatGPT/Enterprise Codex auth (`~/.codex/auth.json`)**.

> **Critical WSL2 Rule:** Keep your git repo inside the **WSL2 Linux filesystem** (e.g., `~/code/your-repo`), **never** on `/mnt/c/...`. Docker bind-mounts, git worktrees, and file permissions are drastically faster and bug-free on WSL2 ext4.

---

## Step 1: Clone or Copy Into Your Repo (in WSL2)

```bash
# Option A: Start fresh from this template
git clone https://github.com/<your-user>/sandcastle-python-workflow.git ~/code/my-project
cd ~/code/my-project

# Option B: Overlay onto an existing Python repo (never overwrites existing files)
cp -rn /path/to/sandcastle-python-workflow/. .
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
