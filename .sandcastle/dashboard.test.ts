import assert from "node:assert/strict";
import test from "node:test";
import {
  PMDashboard,
  parseCheckMetrics,
  summarizeAgentEventForPm,
} from "./dashboard.js";

test("computes accurate PM progress, adversarial challenge counts, and quality scores", () => {
  const dash = new PMDashboard({
    mode: "synthetic-e2e",
    dockerImage: "sandcastle:python-codex",
    stateFilePath: null,
  });

  // Parent slice split into 2 child slices — split parents should NOT inflate denominator
  dash.upsertSlice("demo/01", { title: "Oversized task", stage: "split", splitDepth: 0 });
  dash.recordChallenge("demo/01", {
    source: "drift_watchdog",
    finding: "Diff grew beyond 400 lines; auto-split into 2 slices",
    outcome: "split",
  });

  dash.upsertSlice("demo/02", { title: "Child slice A", stage: "merged", splitDepth: 1, parentId: "demo/01" });
  dash.recordChallenge("demo/02", {
    source: "reviewer",
    finding: "Missing fail-closed reason check — fixed on round 2",
    outcome: "fixed",
  });

  dash.upsertSlice("demo/03", { title: "Child slice B", stage: "verifying", splitDepth: 1, parentId: "demo/01" });
  dash.recordChallenge("demo/03", {
    source: "test_guard",
    finding: "Blocked attempt to weaken existing assertion",
    outcome: "blocked",
  });

  dash.recordQualityMetrics(100.0, 93.3);

  const state = dash.getState();
  assert.equal(state.metrics.totalSlices, 2);
  assert.equal(state.metrics.completedSlices, 1);
  assert.equal(state.metrics.progressPercent, 50);
  assert.equal(state.metrics.adversarialChallengesRaised, 3);
  assert.equal(state.metrics.adversarialChallengesResolved, 1);
  assert.equal(state.metrics.testTamperBlocks, 1);
  assert.equal(state.metrics.driftAutoSplits, 1);
  assert.equal(state.metrics.latestCoveragePercent, 100.0);
  assert.equal(state.metrics.latestMutationScore, 93.3);
});

test("translates technical tool calls into concise PM summaries and parses check.py metrics", () => {
  const summary = summarizeAgentEventForPm({
    type: "toolCall",
    name: "shell",
    formattedArgs: "python scripts/mutation_check.py",
    iteration: 1,
    timestamp: new Date(),
  });
  assert.equal(summary, "Running AST mutation test suite to prove test strength");

  const parsed = parseCheckMetrics(
    "Coverage floor PASS: 100.00% >= 100.00%.\nMutation score: 14/15 killed (93.3%).",
  );
  assert.deepEqual(parsed, { coveragePercent: 100, mutationScore: 93.3 });
});

test("serves live HTML and JSON state over HTTP", async () => {
  const dash = new PMDashboard({
    mode: "factory",
    dockerImage: "sandcastle:python-codex",
    stateFilePath: null,
  });
  const url = await dash.start(0);
  try {
    dash.upsertSlice("smoke/01", { title: "Smoke slice", stage: "implementing" });
    const res = await fetch(`${url}/api/state`);
    assert.equal(res.status, 200);
    const body = (await res.json()) as { metrics: { totalSlices: number } };
    assert.equal(body.metrics.totalSlices, 1);

    const htmlRes = await fetch(url);
    assert.equal(htmlRes.status, 200);
    const html = await htmlRes.text();
    assert.ok(html.includes("PM Mission Control"));
  } finally {
    await dash.close();
  }
});
