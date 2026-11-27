import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  computeAgentTrustScore,
  loadHumanRatings,
  parsePassingPytestNames,
  parseSpecContract,
  saveHumanRating,
  scoreFactoryRunConfidence,
  scoreGoalConfidence,
  scoreSliceConfidence,
  verifySpecAuditAgainstTests,
} from "./confidence.js";
import type { FactoryRunRecord } from "./run-history.js";

function makeRun(
  idx: number,
  overrides: Partial<FactoryRunRecord["slices"][number]> = {},
): FactoryRunRecord {
  return {
    runId: `run-${idx}`,
    mode: "factory",
    startedAt: "2026-11-27T00:00:00.000Z",
    finishedAt: "2026-11-27T00:10:00.000Z",
    runStatus: "complete",
    dockerImage: "sandcastle:python-codex",
    cyclesRun: 1,
    runFile: `runs/run-${idx}.json`,
    totalSlices: 1,
    completedSlices: 1,
    adversarialChallengesRaised: overrides.challengeCount ?? 0,
    adversarialChallengesResolved: overrides.challengeCount ?? 0,
    testTamperBlocks: overrides.tamperBlocks ?? 0,
    driftAutoSplits: overrides.driftSplits ?? 0,
    coveragePercent: 100,
    mutationScore: 93,
    slices: [
      {
        id: `slice-${idx}`,
        stage: overrides.stage ?? "merged",
        splitDepth: 0,
        elapsedSec: 300,
        toolCalls: 18,
        diffLines: 120,
        contextPercent: 40,
        challengeCount: 0,
        tamperBlocks: 0,
        driftSplits: 0,
        ...overrides,
      },
    ],
  };
}

test("scoreSliceConfidence assigns Spot-Check Ready cleanly and enforces hard caps on tampering & missing spec", () => {
  const clean = scoreSliceConfidence({
    stage: "merged",
    checkPassed: true,
    coveragePercent: 100,
    mutationScore: 93,
    tamperBlocks: 0,
    driftSplits: 0,
    challengeCount: 0,
    diffLines: 140,
    contextPercent: 42,
  });
  assert.equal(clean.score, 100);
  assert.equal(clean.badge, "Spot-Check Ready");

  // Recovered tamper attempt MUST cap confidence at Review Carefully (<= 65)
  const tampered = scoreSliceConfidence({
    stage: "merged",
    checkPassed: true,
    coveragePercent: 100,
    mutationScore: 95,
    tamperBlocks: 1,
    driftSplits: 0,
    challengeCount: 0,
    diffLines: 100,
    contextPercent: 30,
  });
  assert.ok(tampered.score <= 65);
  assert.equal(tampered.badge, "Review Carefully");

  // Missing spec item MUST hard-block regardless of passing tests
  const missingSpec = scoreSliceConfidence({
    stage: "merged",
    checkPassed: true,
    coveragePercent: 100,
    mutationScore: 95,
    tamperBlocks: 0,
    driftSplits: 0,
    challengeCount: 0,
    diffLines: 80,
    contextPercent: 30,
    missingSpecItems: 1,
  });
  assert.equal(missingSpec.badge, "Blocked — Do Not Ship");
  assert.equal(missingSpec.status, "blocked");
});

test("spec contract parser & deterministic pytest cross-check catch omitted IDs and hallucinated test names", () => {
  const specMd = [
    "# Spec Contract",
    "- **REQ-1:** Auto-approve allowlisted verified orders.",
    "- **INV-1:** Never auto-execute on upstream errors.",
    "- **OUT-1:** Do not add database writes.",
  ].join("\n");

  const items = parseSpecContract(specMd);
  assert.equal(items.length, 3);
  assert.deepEqual(
    items.map((i) => i.id),
    ["REQ-1", "INV-1", "OUT-1"],
  );

  const pytestOut = [
    "tests/test_order_triage.py::test_allowlisted_verified_low_risk_order_auto_approves PASSED",
    "tests/test_order_triage.py::test_signals_api_error_fails_closed_to_manual_review PASSED",
  ].join("\n");
  const passing = parsePassingPytestNames(pytestOut);

  // Valid audit -> high confidence Spot-Check Ready
  const verifiedClean = verifySpecAuditAgainstTests({
    specItems: items,
    audit: {
      summary: "All spec rules verified.",
      items: [
        {
          id: "REQ-1",
          status: "VERIFIED",
          evidenceFile: "src/app/processors/order_triage.py",
          citedTest: "tests/test_order_triage.py::test_allowlisted_verified_low_risk_order_auto_approves",
          note: "ok",
        },
        {
          id: "INV-1",
          status: "VERIFIED",
          evidenceFile: "src/app/processors/order_triage.py",
          citedTest: "test_signals_api_error_fails_closed_to_manual_review",
          note: "ok",
        },
        {
          id: "OUT-1",
          status: "RESPECTED",
          evidenceFile: "",
          citedTest: "",
          note: "no db writes",
        },
      ],
      standardsViolations: [],
      scopeCreepItems: [],
    },
    passingPytestNames: passing,
  });
  assert.equal(verifiedClean.verifiedCount, 3);
  assert.equal(verifiedClean.hallucinatedTestsDowngraded, 0);

  const cleanGoal = scoreGoalConfidence({
    goalMet: true,
    commandResults: [{ command: "python scripts/check.py", passed: true, exitCode: 0, outputTail: "" }],
    verifiedAudit: verifiedClean,
  });
  assert.equal(cleanGoal.score, 100);
  assert.equal(cleanGoal.badge, "Spot-Check Ready");

  // Hallucinated test name + omitted OUT-1 -> deterministically downgraded and blocked!
  const verifiedBad = verifySpecAuditAgainstTests({
    specItems: items,
    audit: {
      summary: "Claimed verified with fake test.",
      items: [
        {
          id: "REQ-1",
          status: "VERIFIED",
          evidenceFile: "src/app/processors/order_triage.py",
          citedTest: "tests/test_order_triage.py::test_that_does_not_exist",
          note: "",
        },
        {
          id: "INV-1",
          status: "VERIFIED",
          evidenceFile: "src/app/processors/order_triage.py",
          citedTest: "test_signals_api_error_fails_closed_to_manual_review",
          note: "",
        },
      ],
      standardsViolations: [],
      scopeCreepItems: [],
    },
    passingPytestNames: passing,
  });
  assert.equal(verifiedBad.hallucinatedTestsDowngraded, 1);
  assert.equal(verifiedBad.missingCount, 1);

  const badGoal = scoreGoalConfidence({
    goalMet: true,
    commandResults: [{ command: "python scripts/check.py", passed: true, exitCode: 0, outputTail: "" }],
    verifiedAudit: verifiedBad,
  });
  assert.equal(badGoal.badge, "Blocked — Do Not Ship");
});

test("Agent Trust Score enforces 10-run floor, responds to human reality-check ratings, and unlocks Level 2 cleanly", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-trust-"));
  try {
    // Under 10 runs -> always Supervised Only
    const fiveClean = Array.from({ length: 5 }, (_, i) => makeRun(i + 1));
    const earlyTrust = computeAgentTrustScore(fiveClean, []);
    assert.equal(earlyTrust.tier, "Supervised Only");

    // 10 clean runs -> Goal Autonomy Ready (Level 2)
    const tenClean = Array.from({ length: 10 }, (_, i) => makeRun(i + 1));
    const strongTrust = computeAgentTrustScore(tenClean, []);
    assert.equal(strongTrust.trustScore, 100);
    assert.equal(strongTrust.tier, "Goal Autonomy Ready (Level 2)");

    // Human reality check flags rework on 3 runs -> drops trust & advises fixture/invariant hardening
    saveHumanRating({ runId: "run-8", verdict: "rework", note: "missed nested JSON" }, tmp);
    saveHumanRating({ runId: "run-9", verdict: "rework", note: "wrong default" }, tmp);
    saveHumanRating({ runId: "run-10", verdict: "tweak", note: "minor naming" }, tmp);
    const ratings = loadHumanRatings(tmp);
    assert.equal(ratings.length, 3);

    const realityChecked = computeAgentTrustScore(tenClean, ratings);
    assert.ok(realityChecked.humanApprovalRate !== null && realityChecked.humanApprovalRate < 50);
    assert.notEqual(realityChecked.tier, "Goal Autonomy Ready (Level 2)");
    assert.match(realityChecked.diagnosticLever, /Human review approval is lowest/u);

    // Factory run confidence helper scores cleanly
    const runConf = scoreFactoryRunConfidence(tenClean[0]!);
    assert.equal(runConf.overall.badge, "Spot-Check Ready");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});
