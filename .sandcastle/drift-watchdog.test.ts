import assert from "node:assert/strict";
import test from "node:test";
import {
  DriftDetectedError,
  DriftWatchdog,
  classifyDiffWeight,
  parseGitNumstat,
  parsePositiveEnvNumber,
} from "./drift-watchdog.js";

test("aborts when wall-clock timer expires", async () => {
  const wd = new DriftWatchdog({ maxTicketMs: 40 });
  try {
    await new Promise((resolve) => setTimeout(resolve, 90));
    assert.equal(wd.signal.aborted, true);
    assert.ok(wd.drift instanceof DriftDetectedError);
    assert.equal(wd.drift.kind, "wall_clock_timeout");
  } finally {
    wd.dispose();
  }
});

test("aborts on repeated identical tool call thrash loop", () => {
  const wd = new DriftWatchdog({ maxTicketMs: 60_000, maxRepeatedToolCalls: 3 });
  try {
    for (let i = 0; i < 3; i++) {
      wd.onEvent({
        type: "toolCall",
        name: "shell",
        formattedArgs: "pytest tests/test_order_triage.py",
        iteration: 1,
        timestamp: new Date(),
      });
    }
    assert.equal(wd.signal.aborted, true);
    assert.equal(wd.drift?.kind, "thrash_loop");
  } finally {
    wd.dispose();
  }
});

test("aborts when total tool call limit is exceeded", () => {
  const wd = new DriftWatchdog({
    maxTicketMs: 60_000,
    maxToolCalls: 4,
    maxRepeatedToolCalls: 10,
  });
  try {
    for (let i = 1; i <= 5; i++) {
      wd.onEvent({
        type: "toolCall",
        name: "shell",
        formattedArgs: `step-${i}`,
        iteration: 1,
        timestamp: new Date(),
      });
    }
    assert.equal(wd.signal.aborted, true);
    assert.equal(wd.drift?.kind, "tool_call_limit");
  } finally {
    wd.dispose();
  }
});

test("detects diff explosion, file explosion, and context rot post-run", () => {
  const wd = new DriftWatchdog({
    maxTicketMs: 60_000,
    maxDiffLines: 200,
    maxDiffFiles: 3,
    maxContextRatio: 0.75,
  });
  try {
    const clean = wd.checkPostRun({
      diffFiles: 2,
      diffLines: 80,
      contextTokens: 50_000,
      contextLimit: 200_000,
      completed: true,
    });
    assert.equal(clean, null);

    const tooManyFiles = wd.checkPostRun({ diffFiles: 5, diffLines: 50, completed: true });
    assert.equal(tooManyFiles?.kind, "diff_file_explosion");

    const tooManyLines = wd.checkPostRun({ diffFiles: 2, diffLines: 350, completed: true });
    assert.equal(tooManyLines?.kind, "diff_size_explosion");

    const contextRot = wd.checkPostRun({
      diffFiles: 1,
      diffLines: 20,
      contextTokens: 160_000,
      contextLimit: 200_000,
      completed: false,
    });
    assert.equal(contextRot?.kind, "context_rot");

    // Hard 130k absolute token cap fires EVEN when completed === true on a huge 400k window!
    const hardTokenCap = wd.checkPostRun({
      diffFiles: 1,
      diffLines: 20,
      contextTokens: 135_000,
      contextLimit: 400_000,
      completed: true,
    });
    assert.equal(hardTokenCap?.kind, "context_rot");
    assert.match(hardTokenCap?.detail ?? "", /130,000/u);
  } finally {
    wd.dispose();
  }
});

test("parseGitNumstat sums files, raw lines, and blast-radius weighted lines cleanly", () => {
  const sample =
    "12\t3\tsrc/app/processors/order_triage.py\n" +
    "100\t0\tscripts/anti_bloat_guard.py\n" +
    "45\t0\ttests/test_order_triage.py\n" +
    "-\t-\tbinary.dat\n";
  const parsed = parseGitNumstat(sample);
  assert.deepEqual(parsed, { files: 4, lines: 160, weightedLines: 75 });
  assert.equal(classifyDiffWeight("src/app/processors/order_triage.py"), 1.0);
  assert.equal(classifyDiffWeight(".sandcastle/confidence.ts"), 0.6);
  assert.equal(classifyDiffWeight(".sandcastle/review-prompt.md"), 0.6);
  assert.equal(classifyDiffWeight("AGENTS.md"), 0.6);
  assert.equal(classifyDiffWeight("tests/old.py => src/new.py"), 1.0);
  assert.equal(classifyDiffWeight(".sandcastle/confidence.test.ts"), 0);
  assert.equal(classifyDiffWeight("tests_tooling/test_anti_bloat_guard.py"), 0);
});

test("aborts on 2-step ping-pong oscillation thrash loop (edit -> pytest -> edit -> pytest)", () => {
  const wd = new DriftWatchdog({
    maxTicketMs: 60_000,
    maxToolCalls: 45,
    maxRepeatedToolCalls: 6,
    maxOscillationCycles: 3,
  });
  try {
    for (let i = 0; i < 3; i++) {
      wd.onEvent({
        type: "toolCall",
        name: "edit_file",
        formattedArgs: "src/app/processors/order_triage.py",
        iteration: 1,
        timestamp: new Date(),
      });
      wd.onEvent({
        type: "toolCall",
        name: "shell",
        formattedArgs: "pytest tests/test_order_triage.py",
        iteration: 1,
        timestamp: new Date(),
      });
    }
    assert.equal(wd.signal.aborted, true);
    assert.equal(wd.drift?.kind, "thrash_loop");
    assert.match(wd.drift?.detail ?? "", /ping-pong oscillation/u);
    assert.equal(wd.toolCallCount, 6);
  } finally {
    wd.dispose();
  }
});

test("parsePositiveEnvNumber falls back safely on blank, NaN, or non-positive values", () => {
  assert.equal(parsePositiveEnvNumber(undefined, 400), 400);
  assert.equal(parsePositiveEnvNumber("", 400), 400);
  assert.equal(parsePositiveEnvNumber("   ", 400), 400);
  assert.equal(parsePositiveEnvNumber("abc", 400), 400);
  assert.equal(parsePositiveEnvNumber("-10", 400), 400);
  assert.equal(parsePositiveEnvNumber("0", 400), 400);
  assert.equal(parsePositiveEnvNumber("0", 130_000, true), 0);
  assert.equal(parsePositiveEnvNumber("250", 400), 250);
});
