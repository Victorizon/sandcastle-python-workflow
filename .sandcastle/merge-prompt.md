# TASK

Merge the reviewed and approved branches into the current branch:

{{BRANCHES}}

# STEPS

1. For each branch, run `git merge <branch> --no-edit`.
2. If any merge conflict occurs, resolve it carefully preserving both sides' intent.
3. Run `python scripts/check.py` after merging. Fix any regression before proceeding.
4. Resolve each merged ticket in the local tracker:
   `python scripts/local_tracker.py resolve <ticket-id> --summary "Merged <branch> and verified via scripts/check.py"`
5. Commit the resolved ticket status updates with message `RALPH: Merge and resolve batch`.

Tickets in this batch:

{{TICKETS}}

Once all branches are merged, `python scripts/check.py` passes, and tickets are resolved, output `<promise>COMPLETE</promise>`.
