import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PMDashboard } from "./dashboard.js";
import {
  MIN_RUNS_FOR_TUNING,
  loadVerifiedRunHistory,
  recordFactoryRun,
} from "./run-history.js";
import {
  assertMinimumRuns,
  computeAggregatedStats,
  enforceSafetyClamps,
  renderTuningReportMarkdown,
} from "./tuner.js";

function makeSyntheticFactoryState(idx: number) {
  const dash = new PMDashboard({
    mode: "factory",
    dockerImage: "sandcastle:python-codex",
    stateFilePath: null,
  });
  dash.upsertSlice(`feat/${idx}`, {
    title: `Slice ${idx}`,
    stage: "merged",
    watchdog: { elapsedSec: (6 + idx) * 60, toolCalls: 10 + idx, diffLines: 80 + idx * 10 },
  });
  dash.recordQualityMetrics(100, 92.5);
  dash.setRunStatus("complete", "Done");
  return dash.getState();
}

test("hard-blocks tuning when fewer than 10 verified local run files exist on disk", () => {
  const tmpLogs = mkdtempSync(path.join(os.tmpdir(), "sandcastle-tune-lock-"));
  try {
    // Record 11 runs, then delete 2 backing JSON artifacts -> only 9 verified runs remain!
    const created = [];
    for (let i = 1; i <= 11; i++) {
      const rec = recordFactoryRun(makeSyntheticFactoryState(i), tmpLogs);
      assert.ok(rec);
      created.push(rec);
    }
    rmSync(path.join(tmpLogs, created[0].runFile));
    rmSync(path.join(tmpLogs, created[1].runFile));

    const loaded = loadVerifiedRunHistory(tmpLogs);
    assert.equal(loaded.verifiedRuns.length, 9);
    assert.equal(loaded.skippedMissingFiles, 2);

    assert.throws(
      () => assertMinimumRuns(tmpLogs, MIN_RUNS_FOR_TUNING),
      /Tuning locked: found 9\/10 verified local factory runs on disk/u,
    );

    // Recording 1 more real run unlocks tuning at exactly 10 verified runs on disk!
    recordFactoryRun(makeSyntheticFactoryState(12), tmpLogs);
    const unlocked = assertMinimumRuns(tmpLogs, MIN_RUNS_FOR_TUNING);
    assert.equal(unlocked.length, 10);

    const stats = computeAggregatedStats(unlocked);
    assert.equal(stats.verifiedRunCount, 10);
    assert.equal(stats.mergedSlices, 10);
    assert.ok(stats.p90ElapsedMin >= stats.p50ElapsedMin);
  } finally {
    rmSync(tmpLogs, { recursive: true, force: true });
  }
});

test("enforces hard safety clamps against runaway parameter loosening", () => {
  const { safeProposal, clampedNotes } = enforceSafetyClamps({
    executiveSummary: "Test summary",
    parameterChanges: [
      {
        param: "DRIFT_MAX_MINUTES",
        currentValue: 20,
        proposedValue: 999,
        evidence: "Attempting to disable timeout",
      },
      {
        param: "DRIFT_MAX_DIFF_LINES",
        currentValue: 400,
        proposedValue: 5000,
        evidence: "Attempting to disable diff cap",
      },
    ],
    promptOrProcessSuggestions: [],
  });

  assert.equal(safeProposal.parameterChanges[0]?.proposedValue, 35);
  assert.equal(safeProposal.parameterChanges[1]?.proposedValue, 500);
  assert.equal(clampedNotes.length, 2);

  const md = renderTuningReportMarkdown(
    computeAggregatedStats([]),
    safeProposal,
    clampedNotes,
  );
  assert.ok(md.includes("Safety Clamp Interventions"));
});
