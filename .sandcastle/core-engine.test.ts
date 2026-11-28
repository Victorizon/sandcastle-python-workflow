import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { PMDashboard } from "./dashboard.js";
import { type PhaseSpan, RunTracer } from "./diagnostics.js";
import { type MergeGateOps, mergeAndVerifyBatch } from "./merge-gate.js";
import { type PlannedTicket, type SliceRuntimeContext, parseVerdict } from "./slice-container.js";
import { type SliceRunnerOps, processTicket } from "./slice-runner.js";

function makeTempContext(): { ctx: SliceRuntimeContext; cleanup: () => void; readSpans: () => PhaseSpan[] } {
  const dir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-core-test-"));
  const tracer = new RunTracer(dir, false);
  const dashboard = new PMDashboard({ mode: "factory", dockerImage: "test-img", maxCycles: 2 });
  return {
    ctx: { imageName: "test-img", pythonBin: "python", dashboard, tracer },
    cleanup: () => rmSync(dir, { recursive: true, force: true }),
    readSpans: () =>
      readFileSync(tracer.traceFile, "utf8")
        .trim()
        .split("\n")
        .filter(Boolean)
        .map((line) => JSON.parse(line) as PhaseSpan),
  };
}

const TICKET_A: PlannedTicket = {
  id: "SLICE-1",
  title: "Add parser validation",
  branch: "sandcastle/slice-1",
  splitDepth: 0,
};

const TICKET_B: PlannedTicket = {
  id: "SLICE-2",
  title: "Add structured logging",
  branch: "sandcastle/slice-2",
  splitDepth: 0,
};

const APPROVE_VERDICT =
  'Reviewed diff.\n<verdict>{"approved":true,"severity":"none","summary":"Clean slice","blockingIssues":[]}</verdict>';
const REJECT_VERDICT =
  '<verdict>{"approved":false,"severity":"blocking","summary":"Missing edge case","blockingIssues":["Empty input crashes parser"]}</verdict>';

test("parseVerdict handles valid verdicts, surrounding prose, malformed JSON, and missing tags", () => {
  const ok = parseVerdict(APPROVE_VERDICT);
  assert.equal(ok?.approved, true);
  assert.equal(ok?.summary, "Clean slice");

  const rej = parseVerdict(REJECT_VERDICT);
  assert.equal(rej?.approved, false);
  assert.deepEqual(rej?.blockingIssues, ["Empty input crashes parser"]);

  assert.equal(parseVerdict("No verdict tag at all"), null);
  assert.equal(parseVerdict("<verdict>{broken json</verdict>"), null);
  assert.equal(
    parseVerdict('<verdict>{"approved":true,"severity":"invalid","summary":"x","blockingIssues":[]}</verdict>'),
    null,
  );
});

test("processTicket approves happy path and records review trace span + quality metrics", async () => {
  const { ctx, cleanup, readSpans } = makeTempContext();
  try {
    const ops: SliceRunnerOps = {
      runWatched: async () => ({ ok: true, decomposed: false }),
      runVerify: async () => ({
        guardExit: 0,
        guardOut: "",
        checkExit: 0,
        checkOut: "Coverage floor PASS: 100.00% >= 100.00%.\nMutation score: 19/19 killed (100.0%).",
      }),
      runPow: async () => null,
      runReview: async () => ({
        reviewStdout: APPROVE_VERDICT,
        postCheckExit: 0,
        postCheckOut: "Coverage floor PASS: 100.00% >= 100.00%.\nMutation score: 19/19 killed (100.0%).",
      }),
      isAhead: () => true,
      escalate: () => {
        throw new Error("Should not escalate on happy path");
      },
    };

    const res = await processTicket(TICKET_A, 1, ctx, ops);
    assert.deepEqual(res, { approved: true, decomposed: false });
    assert.equal(ctx.dashboard.getState().slices[0]?.stage, "merging");
    const spans = readSpans();
    assert.ok(spans.some((s) => s.phase === "review" && s.outcome === "pass" && s.sliceId === "SLICE-1"));
  } finally {
    cleanup();
  }
});

test("processTicket recovers from tamper strike 1 via Fixer, and escalates on strike 2", async () => {
  const { ctx, cleanup } = makeTempContext();
  try {
    let verifyCalls = 0;
    let fixCalls = 0;
    const escalated: string[] = [];

    // Strike 1 -> Fixer -> Pass
    const recoverOps: SliceRunnerOps = {
      runWatched: async (p) => {
        if (p.phase === "fix") fixCalls += 1;
        return { ok: true, decomposed: false };
      },
      runVerify: async () => {
        verifyCalls += 1;
        return verifyCalls === 1
          ? { guardExit: 1, guardOut: "Modified locked test_guard.py", checkExit: 1, checkOut: "" }
          : { guardExit: 0, guardOut: "", checkExit: 0, checkOut: "" };
      },
      runPow: async () => null,
      runReview: async () => ({ reviewStdout: APPROVE_VERDICT, postCheckExit: 0, postCheckOut: "" }),
      isAhead: () => true,
      escalate: (id) => escalated.push(id),
    };
    const res1 = await processTicket(TICKET_A, 1, ctx, recoverOps);
    assert.equal(res1.approved, true);
    assert.equal(fixCalls, 1);
    assert.equal(escalated.length, 0);

    // Strike 1 -> Fixer -> Strike 2 -> Escalate immediately
    const strike2Ops: SliceRunnerOps = {
      ...recoverOps,
      runVerify: async () => ({
        guardExit: 1,
        guardOut: "Repeated tampering attempt",
        checkExit: 1,
        checkOut: "",
      }),
    };
    const res2 = await processTicket(TICKET_B, 1, ctx, strike2Ops);
    assert.deepEqual(res2, { approved: false, decomposed: false });
    assert.deepEqual(escalated, ["SLICE-2"]);
  } finally {
    cleanup();
  }
});

test("processTicket escalates when Reviewer rejects all rounds and records escalated review span", async () => {
  const { ctx, cleanup, readSpans } = makeTempContext();
  try {
    let reviewRounds = 0;
    let fixCalls = 0;
    const escalated: Array<{ id: string; reason: string }> = [];

    const ops: SliceRunnerOps = {
      runWatched: async (p) => {
        if (p.phase === "fix") fixCalls += 1;
        return { ok: true, decomposed: false };
      },
      runVerify: async () => ({ guardExit: 0, guardOut: "", checkExit: 0, checkOut: "" }),
      runPow: async () => null,
      runReview: async () => {
        reviewRounds += 1;
        return { reviewStdout: REJECT_VERDICT, postCheckExit: 0, postCheckOut: "" };
      },
      isAhead: () => true,
      escalate: (id, reason) => escalated.push({ id, reason }),
    };

    const res = await processTicket(TICKET_A, 1, ctx, ops);
    assert.deepEqual(res, { approved: false, decomposed: false });
    assert.equal(reviewRounds, 2);
    assert.equal(fixCalls, 1);
    assert.equal(escalated.length, 1);
    assert.match(escalated[0]!.reason, /Empty input crashes parser/u);

    const reviewSpans = readSpans().filter((s) => s.phase === "review");
    assert.deepEqual(
      reviewSpans.map((s) => s.outcome),
      ["fail", "escalated"],
    );
  } finally {
    cleanup();
  }
});

test("mergeAndVerifyBatch rolls back atomically on Merger crash, host gate failure, and cross-slice audit reject", async () => {
  const { ctx, cleanup, readSpans } = makeTempContext();
  try {
    const rollbacks: string[] = [];
    const escalations: string[] = [];

    const baseOps: MergeGateOps = {
      getHeadSha: () => "abc1234deadbeef",
      runMerger: async () => {},
      runHostChecks: () => true,
      runMergePow: async () => null,
      runCrossSliceAudit: async () => APPROVE_VERDICT,
      rollback: (sha) => rollbacks.push(sha),
      escalate: (id) => escalations.push(id),
    };

    // 1. Merger crash -> atomic rollback + rethrow
    await assert.rejects(
      () =>
        mergeAndVerifyBatch([TICKET_A], 1, ctx, {
          ...baseOps,
          runMerger: async () => {
            throw new Error("Docker OOM killed Merger");
          },
        }),
      /Docker OOM killed Merger/u,
    );
    assert.deepEqual(rollbacks, ["abc1234deadbeef"]);

    // 2. Host check failure -> atomic rollback + escalate all slices + return false
    rollbacks.length = 0;
    escalations.length = 0;
    const hostFailOk = await mergeAndVerifyBatch([TICKET_A], 2, ctx, {
      ...baseOps,
      runHostChecks: () => false,
    });
    assert.equal(hostFailOk, false);
    assert.deepEqual(rollbacks, ["abc1234deadbeef"]);
    assert.deepEqual(escalations, ["SLICE-1"]);

    // 3. Multi-branch Cross-Slice Auditor rejects -> atomic rollback + escalate both slices
    rollbacks.length = 0;
    escalations.length = 0;
    const auditFailOk = await mergeAndVerifyBatch([TICKET_A, TICKET_B], 3, ctx, {
      ...baseOps,
      runCrossSliceAudit: async () => REJECT_VERDICT,
    });
    assert.equal(auditFailOk, false);
    assert.deepEqual(rollbacks, ["abc1234deadbeef"]);
    assert.deepEqual(escalations, ["SLICE-1", "SLICE-2"]);

    const spans = readSpans();
    assert.ok(spans.some((s) => s.phase === "merge" && s.outcome === "rollback"));
    assert.ok(spans.some((s) => s.phase === "host_check" && s.outcome === "rollback"));
    assert.ok(spans.some((s) => s.phase === "post_merge_audit" && s.outcome === "rollback"));
  } finally {
    cleanup();
  }
});
