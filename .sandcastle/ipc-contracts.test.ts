/**
 * Real TS <-> Python IPC Contract Tests (`.sandcastle/ipc-contracts.test.ts`).
 *
 * Executes the exact Python CLI commands invoked by `run.ts`, `slice-container.ts`,
 * `slice-runner.ts`, and `merge-gate.ts` against the real Python scripts (no mocked stdout),
 * verifying JSON schemas, stdin payloads, exit codes, regex parsers, and real git rollback.
 */

import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { copyFileSync, existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PMDashboard, parseCheckMetrics } from "./dashboard.js";
import { RunTracer } from "./diagnostics.js";
import { mergeAndVerifyBatch } from "./merge-gate.js";
import {
  type TrackerTicketSnapshot,
  rollbackToCommitClean,
  validatePlannedTicketsAgainstTracker,
} from "./preflight.js";
import { resolvePythonBin } from "./resilience.js";
import type { PlannedTicket, SliceRuntimeContext } from "./slice-container.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const PYTHON_BIN = resolvePythonBin(REPO_ROOT);

function initTempTrackerWorkspace(): { dir: string; cleanup: () => void } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-ipc-test-"));
  mkdirSync(path.join(dir, "scripts"), { recursive: true });
  mkdirSync(path.join(dir, ".scratch", "demo", "issues"), { recursive: true });
  copyFileSync(
    path.join(REPO_ROOT, "scripts", "local_tracker.py"),
    path.join(dir, "scripts", "local_tracker.py"),
  );
  writeFileSync(
    path.join(dir, ".scratch", "demo", "issues", "01-parser.md"),
    [
      "# Harden parser edge cases",
      "",
      "**Status:** ready-for-agent",
      "**Blocked by:** None",
      "**Split depth:** 0",
      "",
      "## Acceptance Criteria",
      "- Reject empty payloads cleanly.",
    ].join("\n"),
    "utf8",
  );
  return { dir, cleanup: () => rmSync(dir, { recursive: true, force: true }) };
}

test("local_tracker.py IPC contract: check-cycles, list --json, comment, set-status, and stdin split", () => {
  const { dir, cleanup } = initTempTrackerWorkspace();
  try {
    // 1. check-cycles passes on valid DAG
    execFileSync(PYTHON_BIN, ["scripts/local_tracker.py", "check-cycles"], {
      cwd: dir,
      stdio: "pipe",
    });

    // 2. list --status ready-for-agent --json matches TrackerTicketSnapshot + preflight validator
    const listOut = execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "list", "--status", "ready-for-agent", "--json"],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const snapshots = JSON.parse(listOut) as TrackerTicketSnapshot[];
    assert.equal(snapshots.length, 1);
    assert.equal(snapshots[0]?.id, "demo/01");
    assert.equal(snapshots[0]?.split_depth, 0);

    const validated = validatePlannedTicketsAgainstTracker(
      [{ id: "demo/01", title: "Harden parser edge cases", branch: "sandcastle/demo-1", splitDepth: 99 }],
      snapshots,
    );
    assert.equal(validated.droppedReasons.length, 0);
    assert.equal(validated.valid.length, 1);
    assert.equal(validated.valid[0]?.splitDepth, 0);

    // 3. split --plan-json - accepts SplitPlanSchema JSON shape via stdin
    const splitPayload = {
      reason: "Too many files touched in one slice",
      subtickets: [
        {
          title: "Validate parser input headers",
          what_to_build: "Reject empty and malformed headers",
          acceptance_criteria: ["Empty input returns structured error"],
          blocked_by_indexes: [],
        },
        {
          title: "Normalize parser output records",
          what_to_build: "Emit canonical dict schema",
          acceptance_criteria: ["Normalized keys match schema"],
          blocked_by_indexes: [0],
        },
      ],
    };
    execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "split", "demo/01", "--plan-json", "-", "--max-depth", "1"],
      { cwd: dir, input: JSON.stringify(splitPayload), stdio: ["pipe", "pipe", "pipe"] },
    );

    const afterSplitOut = execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "list", "--status", "ready-for-agent", "--json"],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const afterSplit = JSON.parse(afterSplitOut) as TrackerTicketSnapshot[];
    assert.equal(afterSplit.length, 2);
    assert.ok(afterSplit.every((t) => t.split_depth === 1));
    assert.deepEqual(afterSplit[1]?.open_blockers, [afterSplit[0]!.id]);

    // Verify preflight blocks the dependent second sub-slice until the first is resolved
    const blockedCheck = validatePlannedTicketsAgainstTracker(
      [{ id: afterSplit[1]!.id, title: "Dependent", branch: "sandcastle/demo-3", splitDepth: 1 }],
      afterSplit,
    );
    assert.equal(blockedCheck.valid.length, 0);
    assert.equal(blockedCheck.droppedReasons.length, 1);

    // 4. comment + set-status ready-for-human (exact escalation commands)
    const targetId = afterSplit[0]!.id;
    execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "comment", targetId, "--body", "Escalated by contract test"],
      { cwd: dir, stdio: "pipe" },
    );
    execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "set-status", targetId, "ready-for-human"],
      { cwd: dir, stdio: "pipe" },
    );
    const humanOut = execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "list", "--status", "ready-for-human", "--json"],
      { cwd: dir, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const humanTickets = JSON.parse(humanOut) as TrackerTicketSnapshot[];
    assert.equal(humanTickets.length, 1);
    assert.equal(humanTickets[0]?.id, targetId);
  } finally {
    cleanup();
  }
});

test("parseCheckMetrics parses real stdout from live python scripts/check.py", () => {
  const out = execFileSync(PYTHON_BIN, ["scripts/check.py"], {
    cwd: REPO_ROOT,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  });
  const metrics = parseCheckMetrics(out);
  assert.equal(metrics.coveragePercent, 100);
  assert.equal(metrics.mutationScore, 100);
});

test("mergeAndVerifyBatch real git rollback restores HEAD and deletes untracked files", async () => {
  const repoDir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-git-rollback-"));
  const logsDir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-git-logs-"));
  try {
    execFileSync("git", ["init", "-b", "main"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.email", "test@example.com"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["config", "user.name", "Test Bot"], { cwd: repoDir, stdio: "pipe" });
    writeFileSync(path.join(repoDir, "app.py"), "VALUE = 1\n", "utf8");
    execFileSync("git", ["add", "app.py"], { cwd: repoDir, stdio: "pipe" });
    execFileSync("git", ["commit", "-m", "init"], { cwd: repoDir, stdio: "pipe" });

    const preMergeSha = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();

    const dashboard = new PMDashboard({ mode: "factory", dockerImage: "test", maxCycles: 1 });
    const tracer = new RunTracer(logsDir, false);
    const ctx: SliceRuntimeContext = { imageName: "test", pythonBin: PYTHON_BIN, dashboard, tracer };
    const ticket: PlannedTicket = {
      id: "demo#1",
      title: "Bad merge",
      branch: "sandcastle/demo-1",
      splitDepth: 0,
    };

    const ok = await mergeAndVerifyBatch([ticket], 1, ctx, {
      getHeadSha: () => preMergeSha,
      runMerger: async () => {
        // Simulate Merger creating a broken commit AND leaving a stray untracked file
        writeFileSync(path.join(repoDir, "app.py"), "VALUE = 999\n", "utf8");
        execFileSync("git", ["add", "app.py"], { cwd: repoDir, stdio: "pipe" });
        execFileSync("git", ["commit", "-m", "bad merge"], { cwd: repoDir, stdio: "pipe" });
        writeFileSync(path.join(repoDir, "stray_debug.tmp"), "junk\n", "utf8");
      },
      runHostChecks: () => false,
      runMergePow: async () => null,
      runCrossSliceAudit: async () => "",
      rollback: (sha) => rollbackToCommitClean(sha, repoDir),
      escalate: () => {},
    });

    assert.equal(ok, false);
    const headAfter = execFileSync("git", ["rev-parse", "HEAD"], {
      cwd: repoDir,
      encoding: "utf8",
    }).trim();
    assert.equal(headAfter, preMergeSha);
    assert.equal(existsSync(path.join(repoDir, "stray_debug.tmp")), false);
  } finally {
    rmSync(repoDir, { recursive: true, force: true });
    rmSync(logsDir, { recursive: true, force: true });
  }
});
