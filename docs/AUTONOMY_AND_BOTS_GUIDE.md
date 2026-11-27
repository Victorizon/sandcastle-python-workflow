# Sandcastle Autonomy Modes, Overnight Bots & Prototype Bake-Off Guide

`sandcastle-python-workflow` provides **6 distinct commands** under `.sandcastle/`, each designed for a specific stage of engineering work:

| Command | When to Use It | Touches `main`? |
| :--- | :--- | :---: |
| `npm --prefix .sandcastle run factory` | Standard ticket-queue execution (Level 1 autonomy) + live PM Dashboard | Merges reviewed slices |
| `npm --prefix .sandcastle run goal` | **Level 2 autonomy:** run until a machine-verifiable `.sandcastle/goal.json` passes | Merges reviewed slices + writes Goal Receipt |
| `npm --prefix .sandcastle run nightly-arch` | **Overnight Architecture Bot:** proposes 1–2 hot-spot deepening refactors per night | **Never** (`needs-triage` tickets or isolated draft branches) |
| `npm --prefix .sandcastle run bakeoff` | **Design It Twice Bake-Off:** forks 3 parallel prototypes + Adversarial Judge ranking | **Never** (throwaway `prototype/*` branches only) |
| `npm --prefix .sandcastle run tune` | **Read-Only Parameter Tuner:** analyzes `>= 10` verified local runs & proposes clamped tuning | **Never** (proposal markdown report only) |
| `npm --prefix .sandcastle run e2e` | Real-Docker synthetic end-to-end smoke test with live PM Mission Control Dashboard | **Never** (runs in isolated temp clone) |

---

## 1. Level 2 Goal-Driven Autonomy (`npm --prefix .sandcastle run goal`)

Use Level 2 autonomy when you have a **machine-verifiable destination** (all tickets resolved **plus** explicit passing shell checks like `python scripts/check.py` or a module coverage/parity test).

### Step 1: Create `.sandcastle/goal.json`
Copy `.sandcastle/goal.example.json` to `.sandcastle/goal.json` and customize `verifyCommands`:

```json
{
  "name": "Extract and verify clean signal parser",
  "slug": "signal-parser-goal",
  "requireAllTicketsResolved": true,
  "verifyCommands": [
    "python scripts/check.py",
    "pytest tests/test_order_triage.py --cov=src/app/processors/order_triage --cov-fail-under=95"
  ],
  "maxTotalMinutes": 240,
  "maxStalledCycles": 2,
  "maxGapPlanRounds": 2
}
```

### Step 2: Run With Your Preferred Time Cap
> **Best Practice:** Create a dedicated integration branch (`git checkout -b feat/signal-parser-goal`) before starting an overnight run so `main` stays untouched until your morning review.

```bash
# Use the maxTotalMinutes in goal.json:
npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json

# Override wall-clock time cap for this run (e.g., 6 hours):
npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json --max-minutes 360

# Unlimited wall-clock time (relies on maxStalledCycles + maxGapPlanRounds):
npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json --max-minutes 0
```

### What Happens Automatically
1. Runs `factory` cycles on all unblocked `ready-for-agent` tickets (with full Drift Watchdog + 6-gate checks + Fresh Reviewer).
2. After every cycle, evaluates every command in `verifyCommands` on the host.
3. If all tickets finish but a verification command is still red, wakes a fresh **Gap-Planner** (up to `maxGapPlanRounds`) to create 1–2 surgical gap-closing tickets and continues automatically.
4. Stops immediately and writes **`.sandcastle/logs/goal-receipt-<slug>.json`** when either:
   - **`GOAL_MET`** — all tickets resolved and every `verifyCommand` exited `0`, OR
   - **`STOPPED_CIRCUIT_BREAKER`** — wall-clock budget hit, `maxStalledCycles` consecutive cycles made zero commit progress, or a `ready-for-human` ticket blocks the frontier.

---

## 2. Overnight Architecture Bot (`npm --prefix .sandcastle run nightly-arch`)

Implements Matt Pocock's `$improve-codebase-architecture` discipline automatically on a schedule. It scans **recent git churn (`git log -n 40`)** so it only proposes high-leverage deepening refactors on files you actually change — never cold, untouched files — and respects `GLOSSARY.md`, `docs/adr/`, and `.out-of-scope/`.

### Mode A: Morning Triage Tickets (Recommended Default)
Produces a markdown report in `.sandcastle/logs/nightly-arch-YYYY-MM-DD.md` and creates 1–2 **`needs-triage`** tickets under `.scratch/nightly-arch/issues/`:

```bash
npm --prefix .sandcastle run nightly-arch -- --max 2 --mode tickets
```
Over morning coffee, run `python scripts/local_tracker.py board`. If you like a proposal, flip it to `ready-for-agent`; otherwise mark it `wontfix` (or add to `.out-of-scope/` so the bot never suggests it again).

### Mode B: Verified Draft Branches (and Optional GitHub Draft PRs)
Implements each of the 1–2 proposals inside Docker on an isolated `arch/nightly-<date>-<slug>` branch, runs `test_guard.py` + `scripts/check.py`, **discards any failed attempt automatically**, and keeps only 100%-green branches:

```bash
# Keep verified local branches only:
npm --prefix .sandcastle run nightly-arch -- --max 2 --mode draft-branch

# Or also push & open GitHub Draft PRs (once connected to GitHub):
npm --prefix .sandcastle run nightly-arch -- --max 2 --mode draft-branch --open-prs
```

### Scheduling Overnight in WSL2 (`crontab -e`)
```cron
# Run every weekday at 02:00 AM inside your WSL2 repo:
0 2 * * 1-5 cd ~/code/your-repo && npm --prefix .sandcastle run nightly-arch -- --max 2 --mode tickets >> .sandcastle/logs/cron-arch.log 2>&1
```

---

## 3. Parallel `Design It Twice` Prototype Bake-Off (`npm --prefix .sandcastle run bakeoff`)

Use this whenever you hit *"I'm not sure which design/architecture feels cleanest — let's try 3 structurally different approaches and compare them with real tests."*

```bash
npm --prefix .sandcastle run bakeoff -- \
  --slug signal-parser \
  --brief "Design a clean parser for multi-format verification signals with fail-closed defaults and lightweight parse warnings."
```

### What Happens Automatically
1. **Shared Exploration:** One container explores the repo, `GLOSSARY.md`, ADRs, and fixtures once.
2. **Parallel Fork (`parent.fork()`):** Spawns **3 radically different variants** in parallel on throwaway branches:
   - `prototype/<slug>-a` — **Minimal Deep Module** (1–2 entry points max, smallest line count, zero abstractions)
   - `prototype/<slug>-b` — **Declarative Rule Table** (table-driven predicates, trivial to add new cases)
   - `prototype/<slug>-c` — **Strict Ports & Typed States** (immutable boundary dataclasses & explicit failure modes)
3. **Deterministic 6-Gate Referee:** Runs `python scripts/check.py` and `git diff --numstat` on all 3 branches (measuring pass/fail, diff lines, coverage %, and **AST mutation kill rate**).
4. **Fresh Adversarial Judge (`high` effort):** Compares all 3 variants against `CODING_STANDARDS.md` and Ousterhout's depth/locality rubric, writing **`.sandcastle/logs/bakeoff-<slug>-YYYY-MM-DD.md`** with a ranked Winner and Hybrid Synthesis Recommendation.
5. **Human Pick:** Nothing is auto-merged to `main`. Inspect `git diff main..prototype/<slug>-a` (or `-b` / `-c`) and either cherry-pick or reimplement cleanly onto your real feature branch.

---

## 4. Read-Only Parameter Tuner (`npm --prefix .sandcastle run tune`)

Every real `factory` run saves an immutable artifact to `.sandcastle/logs/runs/run-*.json` and appends a line to `.sandcastle/logs/run-history.jsonl`.

```bash
# Full read-only LLM proposal (hard-locked until >= 10 verified local runs exist on disk):
npm --prefix .sandcastle run tune

# Deterministic p50/p90 stats report without calling an LLM:
npm --prefix .sandcastle run tune -- --stats-only
```

- **Hard 10-run local-existence floor:** Refuses to run until at least 10 real factory run files exist and validate on disk.
- **Proposal-only + hard safety clamps:** Writes `.sandcastle/logs/tuning-report-YYYY-MM-DD.md` and clamps all suggested values inside safe bounds — never auto-edits `.env` or test locks.

---

## 5. Automatic Styled PM HTML Reports & 1-Click Jira Copy

Every `factory`, `goal`, `nightly-arch`, `bakeoff`, and `tune` run automatically generates a clean, offline-viewable, print-ready executive HTML report in **`.sandcastle/logs/reports/<kind>-<slug>-YYYY-MM-DD.html`** — using zero extra LLM tokens (100% grounded in verified run data):

- **Double-click to open** in any browser to share with colleagues or save as PDF (`Print / PDF` button).
- **1-Click `Copy Jira Markup` button** copies ready-to-paste Jira wiki syntax (`h2.`, `{panel}`, metrics, and tables) straight to your clipboard.
