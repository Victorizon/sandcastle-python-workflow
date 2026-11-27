# Issue tracker: Local Markdown

Issues and specs for this repo live as markdown files in `.scratch/` and are inspected or updated via `python scripts/local_tracker.py`.

> **Switching to GitHub later:** Copy `docs/agents/issue-tracker.github.md` over this file, set `TRACKER_MODE=github` in `.sandcastle/.env`, and run `python scripts/local_tracker.py export-github` to migrate any remaining local tickets.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md`
- Implementation issues are one file per ticket at `.scratch/<feature-slug>/issues/<NN>-<slug>.md`, numbered from `01`, never a single combined tickets file
- Triage state is recorded as a `**Status:** <label>` line near the top of each issue file (see `docs/agents/triage-labels.md` for the five role strings, plus `in-progress` and `resolved`)
- Blocking dependencies are recorded as `**Blocked by:** 01, 02` (or `None (can start immediately)`) near the top of each issue file
- Comments and conversation history append to the bottom of the file under a `## Comments` heading

## CLI Operations (`scripts/local_tracker.py`)

- **Show visual task board:** `python scripts/local_tracker.py board`
- **List tickets as JSON (for Sandcastle Planner):** `python scripts/local_tracker.py list --status ready-for-agent --json`
- **Read a ticket + parent spec:** `python scripts/local_tracker.py view <id>`
- **Comment on a ticket:** `python scripts/local_tracker.py comment <id> --body "..."`
- **Update ticket status:** `python scripts/local_tracker.py set-status <id> <status>`
- **Resolve/close a ticket:** `python scripts/local_tracker.py resolve <id> --summary "..."`

## When a skill says "publish to the issue tracker"

Create one file per ticket under `.scratch/<feature-slug>/issues/<NN>-<slug>.md` (creating the directory if needed).

## When a skill says "fetch the relevant ticket"

Run `python scripts/local_tracker.py view <id>` or read the file at the referenced path.

## Wayfinding operations

Used by `/wayfinder`. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `**Type:**` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `**Status:**` line records `claimed`/`resolved`.
- **Blocking**: a `**Blocked by:** NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `**Status:** claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `**Status:** resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
