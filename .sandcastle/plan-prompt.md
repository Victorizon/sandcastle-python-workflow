# TICKETS

Here are the open `ready-for-agent` tickets from the local tracker:

<tickets-json>

!`python scripts/local_tracker.py list --status ready-for-agent --json`

</tickets-json>

<!-- When switching to GitHub later, replace the shell block above with:
!`gh issue list --state open --label ready-for-agent --limit 100 --json number,title,body,labels,comments`
-->

# TASK

Analyze the open `ready-for-agent` tickets and select ONLY tickets that:
1. Have zero open blockers (`open_blockers` is empty).
2. Do not modify overlapping files with another selected ticket in the same batch.

Assign each selected ticket a deterministic branch name formatted as `sandcastle/<id>` (for example, `workflow-smoke-test/01` -> `sandcastle/workflow-smoke-test/01`), and preserve each ticket's `split_depth` integer as `splitDepth`.

# OUTPUT

Return ONLY a JSON object inside `<plan>` tags matching:

<plan>
{"tickets": [{"id": "workflow-smoke-test/01", "title": "Fail closed on unknown risk_tier", "branch": "sandcastle/workflow-smoke-test/01", "splitDepth": 0}]}
</plan>

If no unblocked tickets exist, return `{"tickets": []}` inside `<plan>` tags.
