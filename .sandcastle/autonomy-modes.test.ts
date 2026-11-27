import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { createAgent, createDockerSandbox, resolveAgentKind } from "./agent-factory.js";
import {
  computeDeterministicScore,
  renderBakeoffReport,
} from "./bakeoff.js";
import {
  checkCircuitBreaker,
  loadGoalContract,
  parseGoalCliArgs,
  writeGoalReceipt,
} from "./goal-core.js";
import {
  rankChurnHotspots,
  renderNightlyArchReport,
  writeProposalsAsNeedsTriageTickets,
} from "./nightly-arch.js";
import {
  buildJiraMarkup,
  renderPmHtmlReport,
  writePmHtmlReport,
} from "./pm-report.js";
import {
  acquireRunLock,
  validatePlannedTicketsAgainstTracker,
} from "./preflight.js";

test("goal-core supports configurable wall-clock cap including 0 (unlimited) and stall breakers", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-goal-"));
  try {
    const goalPath = path.join(tmp, "goal.json");
    writeFileSync(
      goalPath,
      JSON.stringify({
        name: "Test Goal",
        slug: "test-goal",
        verifyCommands: ["python scripts/check.py"],
        maxTotalMinutes: 120,
      }),
      "utf8",
    );

    const parsedArgs = parseGoalCliArgs(["--goal", goalPath, "--max-minutes", "0"]);
    const contract = loadGoalContract(parsedArgs.goalFile, parsedArgs.maxMinutes);
    assert.equal(contract.maxTotalMinutes, 0);

    // Unlimited time (0) does NOT trip wall-clock breaker even at 500 minutes
    assert.equal(
      checkCircuitBreaker({
        elapsedMinutes: 500,
        maxTotalMinutes: 0,
        stalledCycles: 0,
        maxStalledCycles: 2,
        openReadyTickets: 1,
        openHumanTickets: 0,
      }),
      null,
    );

    // Explicit time cap DOES trip when reached
    const timeTrip = checkCircuitBreaker({
      elapsedMinutes: 95,
      maxTotalMinutes: 90,
      stalledCycles: 0,
      maxStalledCycles: 2,
      openReadyTickets: 1,
      openHumanTickets: 0,
    });
    assert.match(timeTrip ?? "", /Wall-clock budget reached/u);

    // Zero-progress stall breaker trips at maxStalledCycles
    const stallTrip = checkCircuitBreaker({
      elapsedMinutes: 10,
      maxTotalMinutes: 0,
      stalledCycles: 2,
      maxStalledCycles: 2,
      openReadyTickets: 1,
      openHumanTickets: 0,
    });
    assert.match(stallTrip ?? "", /Zero-progress stall breaker/u);

    const receiptPath = writeGoalReceipt(
      {
        goalName: contract.name,
        slug: contract.slug,
        status: "GOAL_MET",
        reason: "All checks passed",
        startedAt: new Date().toISOString(),
        finishedAt: new Date().toISOString(),
        elapsedMinutes: 12.5,
        cyclesRun: 2,
        gapPlanRoundsUsed: 0,
        headCommit: "abc1234",
        lastEvaluation: {
          met: true,
          openReadyTickets: 0,
          openHumanTickets: 0,
          commandResults: [],
        },
      },
      tmp,
    );
    const saved = JSON.parse(readFileSync(receiptPath, "utf8")) as { status: string };
    assert.equal(saved.status, "GOAL_MET");
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("nightly-arch ranks Python churn hotspots and writes needs-triage tickets cleanly", () => {
  const hotspots = rankChurnHotspots(
    [
      "src/app/processors/order_triage.py",
      "README.md",
      "src/app/processors/order_triage.py",
      "src/app/adapters/external_client.py",
      "tests_tooling/test_workflow_gates.py",
    ].join("\n"),
  );
  assert.deepEqual(hotspots, [
    { file: "src/app/processors/order_triage.py", touches: 2 },
    { file: "src/app/adapters/external_client.py", touches: 1 },
  ]);

  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-arch-"));
  try {
    const proposals = [
      {
        slug: "deepen-signal-check",
        title: "Deepen signal validation seam",
        strength: "strong" as const,
        files: ["src/app/processors/order_triage.py"],
        problem: "Scattered conditionals",
        solution: "One pure validator helper",
        benefits: "Higher locality and simpler tests",
        acceptance_criteria: ["python scripts/check.py passes"],
      },
    ];
    const files = writeProposalsAsNeedsTriageTickets(proposals, tmp);
    assert.equal(files.length, 1);
    const body = readFileSync(path.join(tmp, files[0] ?? ""), "utf8");
    assert.ok(body.includes("**Status:** needs-triage"));

    const report = renderNightlyArchReport("2026-11-27", hotspots, proposals, []);
    assert.ok(report.includes("Deepen signal validation seam"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("bakeoff deterministic scorer rewards passing gates, high mutation score, and brevity", () => {
  const conciseWinner = computeDeterministicScore({
    checkPassed: true,
    coveragePercent: 100,
    mutationScore: 95,
    diffLines: 140,
  });
  const bloatedPass = computeDeterministicScore({
    checkPassed: true,
    coveragePercent: 90,
    mutationScore: 86,
    diffLines: 480,
  });
  const failedVariant = computeDeterministicScore({
    checkPassed: false,
    coveragePercent: 100,
    mutationScore: 100,
    diffLines: 100,
  });

  assert.ok(conciseWinner > bloatedPass);
  assert.ok(bloatedPass > failedVariant);

  const md = renderBakeoffReport(
    "signal-parser",
    "Compare 3 signal parser architectures",
    [
      {
        variant: "A",
        name: "Minimal Deep Module",
        branch: "prototype/signal-parser-a",
        checkPassed: true,
        diffFiles: 2,
        diffLines: 140,
        coveragePercent: 100,
        mutationScore: 95,
        deterministicRankScore: conciseWinner,
      },
    ],
    {
      winner: "A",
      ranking: [
        {
          variant: "A",
          branch: "prototype/signal-parser-a",
          verdict: "Cleanest interface and strongest mutation kill score.",
          strengths: ["Tiny seam"],
          weaknesses: ["Less extensible"],
        },
      ],
      hybridRecommendation: "Use Variant A directly.",
      mergeAction: "Inspect diff and reimplement cleanly on feature branch.",
    },
  );
  assert.ok(md.includes("Adversarial Judge Winner:** **Variant A**"));
});

test("pm-report generates styled offline HTML with 1-click Jira markup", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-pm-report-"));
  try {
    const input = {
      kind: "goal" as const,
      slug: "parser-upgrade",
      title: "Goal Achieved: Signal Parser Upgrade",
      status: "success" as const,
      statusLabel: "GOAL MET",
      executiveSummary: "All 4 slices passed 6 gates and Hypothesis property fuzzing.",
      metrics: [
        { label: "Slices", value: "4 / 4" },
        { label: "Mutation Kill", value: "93.3%" },
      ],
      sections: [
        {
          heading: "Deliverables",
          bullets: ["Extracted clean signal parser", "Added 50-case Hypothesis fuzzing"],
        },
      ],
    };
    const jira = buildJiraMarkup(input);
    assert.ok(jira.includes("h2. Goal Achieved: Signal Parser Upgrade"));
    assert.ok(jira.includes("{panel:title=Executive Summary (GOAL MET)"));

    const html = renderPmHtmlReport(input);
    assert.ok(html.includes("Copy Jira Markup"));
    assert.ok(html.includes("Print / PDF"));

    const saved = writePmHtmlReport(input, tmp);
    assert.ok(readFileSync(saved, "utf8").includes("Signal Parser Upgrade"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("preflight lock blocks concurrent active runs and auto-recovers stale dead-PID locks", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-lock-"));
  try {
    const release = acquireRunLock(".run.lock", "factory", tmp);
    assert.throws(() => acquireRunLock(".run.lock", "factory", tmp), /Another Sandcastle factory/u);
    release();

    // Simulate a crashed process leaving a dead PID lockfile -> must auto-recover
    writeFileSync(
      path.join(tmp, ".run.lock"),
      JSON.stringify({ pid: 99999999, label: "crashed-run", startedAt: "2026-01-01T00:00:00Z" }),
      "utf8",
    );
    const releaseRecovered = acquireRunLock(".run.lock", "factory", tmp);
    releaseRecovered();
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("validatePlannedTicketsAgainstTracker drops blocked/unknown tickets and enforces ground-truth splitDepth", () => {
  const tracker = [
    { id: "feat/01", status: "ready-for-agent", split_depth: 1, open_blockers: [] },
    { id: "feat/02", status: "ready-for-agent", split_depth: 0, open_blockers: ["feat/01"] },
  ];
  const planned = [
    // Planner lied splitDepth: 0 on a depth-1 child!
    { id: "feat/01", title: "Child slice", branch: "sandcastle/feat/01", splitDepth: 0 },
    // Planner picked a still-blocked ticket!
    { id: "feat/02", title: "Blocked slice", branch: "sandcastle/feat/02", splitDepth: 0 },
    // Planner hallucinated a nonexistent ticket!
    { id: "feat/99", title: "Ghost slice", branch: "sandcastle/feat/99", splitDepth: 0 },
  ];

  const { valid, droppedReasons } = validatePlannedTicketsAgainstTracker(planned, tracker);
  assert.equal(valid.length, 1);
  assert.equal(valid[0]?.id, "feat/01");
  assert.equal(valid[0]?.splitDepth, 1);
  assert.equal(droppedReasons.length, 2);
});

test("agent-factory defaults to codex, honors SANDCASTLE_AGENT env var, and switches cleanly to claude", () => {
  const prev = process.env["SANDCASTLE_AGENT"];
  try {
    delete process.env["SANDCASTLE_AGENT"];
    assert.equal(resolveAgentKind(undefined), "codex");
    assert.equal(resolveAgentKind("claude"), "claude");
    assert.equal(resolveAgentKind(" CLAUDE-CODE "), "claude");
    assert.equal(resolveAgentKind("codex"), "codex");

    process.env["SANDCASTLE_AGENT"] = "claude";
    assert.equal(resolveAgentKind(undefined), "claude");
    assert.ok(createAgent("medium", "claude"));
    assert.ok(createAgent("high", "codex"));
    assert.ok(createDockerSandbox("sandcastle:python-codex", "claude"));
    assert.ok(createDockerSandbox("sandcastle:python-codex", "codex"));
  } finally {
    if (prev === undefined) delete process.env["SANDCASTLE_AGENT"];
    else process.env["SANDCASTLE_AGENT"] = prev;
  }
});
