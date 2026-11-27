import assert from "node:assert/strict";
import test from "node:test";
import {
  DriftDetectedError,
  DriftWatchdog,
  parseGitNumstat,
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
  } finally {
    wd.dispose();
  }
});

test("parseGitNumstat sums files and added+deleted lines cleanly", () => {
  const sample = "12\t3\tsrc/app/processors/order_triage.py\n45\t0\ttests/test_order_triage.py\n-\t-\tbinary.dat\n";
  const parsed = parseGitNumstat(sample);
  assert.deepEqual(parsed, { files: 3, lines: 60 });
});
