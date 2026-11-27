import assert from "node:assert/strict";
import test from "node:test";
import {
  type WorkspaceCoachSignals,
  buildCoachNudges,
  formatCoachOutput,
  formatEndOfRunFooter,
} from "./coach.js";

function baseSignals(overrides: Partial<WorkspaceCoachSignals> = {}): WorkspaceCoachSignals {
  return {
    currentBranch: "feat/parser-v2",
    modifiedFiles: [],
    staleWorkBranches: 0,
    openHumanTickets: 0,
    openTriageTickets: 0,
    openReadyTickets: 0,
    latestReportPath: null,
    latestReportAgeHours: null,
    latestRunId: null,
    latestRunRated: true,
    verifiedRunCount: 0,
    trust: {
      trustScore: 0,
      tier: "Supervised Only",
      runsAnalyzed: 0,
      slicesAnalyzed: 0,
      ratedRunsCount: 0,
      firstPassRate: 0,
      integrityRate: 0,
      stabilityRate: 0,
      deliveryRate: 0,
      humanApprovalRate: null,
      diagnosticLever: "Complete 10 verified runs.",
      reasons: [],
    },
    ...overrides,
  };
}

test("Shadow Guide prioritizes human blockers, branch safety, latest PM report, unrated runs, and Hypothesis deep fuzzing", () => {
  const signals = baseSignals({
    currentBranch: "main",
    modifiedFiles: ["src/app/processors/order_triage.py"],
    openHumanTickets: 1,
    openTriageTickets: 2,
    latestReportPath: ".sandcastle/logs/reports/goal-parser-2026-11-28.html",
    latestReportAgeHours: 1.2,
    latestRunId: "run-2026-11-28-abc",
    latestRunRated: false,
    verifiedRunCount: 10,
  });

  const nudges = buildCoachNudges(signals);
  const titles = nudges.map((n) => n.title);

  assert.equal(nudges[0]?.priority, "urgent");
  assert.ok(titles.some((t) => t.includes("human-escalated")));
  assert.ok(titles.some((t) => t.includes("Move uncommitted src/ edits off main")));
  assert.ok(titles.some((t) => t.includes("latest PM HTML report")));
  assert.ok(titles.some((t) => t.includes("Human Reality Check")));
  assert.ok(titles.some((t) => t.includes("Hypothesis fuzzing")));
  assert.ok(titles.some((t) => t.includes("Parameter Tuner unlocked")));

  const rendered = formatCoachOutput(signals, nudges);
  assert.ok(rendered.includes("Shadow Guide"));
  assert.ok(rendered.includes(".sandcastle/logs/reports/goal-parser-2026-11-28.html"));
});

test("Shadow Guide matches ready ticket recommendation to earned Level 2 Autonomy Tier", () => {
  const signals = baseSignals({
    openReadyTickets: 3,
    verifiedRunCount: 12,
    trust: {
      trustScore: 94,
      tier: "Goal Autonomy Ready (Level 2)",
      runsAnalyzed: 12,
      slicesAnalyzed: 18,
      ratedRunsCount: 5,
      firstPassRate: 90,
      integrityRate: 100,
      stabilityRate: 95,
      deliveryRate: 100,
      humanApprovalRate: 92,
      diagnosticLever: "All healthy.",
      reasons: [],
    },
  });

  const nudges = buildCoachNudges(signals);
  assert.ok(nudges.some((n) => n.title.includes("Level 2 Goal Autonomy unlocked")));

  const footer = formatEndOfRunFooter({
    kind: "goal",
    reportPath: ".sandcastle/logs/reports/goal-demo-2026-11-28.html",
  });
  assert.ok(footer.includes("Shadow Guide"));
  assert.ok(footer.includes("goal-demo-2026-11-28.html"));
  assert.ok(footer.includes("run rate"));
});
