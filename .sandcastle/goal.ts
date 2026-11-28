/**
 * Level 2 Goal-Driven Autonomous Runner (`npm --prefix .sandcastle run goal`).
 *
 * Runs Sandcastle factory cycles autonomously until EVERY deterministic check in
 * `.sandcastle/goal.json` passes, waking a bounded Gap-Planner if tickets empty out
 * before the goal metrics turn green, and writing `.sandcastle/logs/goal-receipt-<slug>.json`.
 *
 * Usage:
 *   npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json --max-minutes 240
 *   npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json --max-minutes 0   # unlimited wall-clock
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import { formatEndOfRunFooter } from "./coach.js";
import {
  SpecAuditOutputSchema,
  type VerifiedSpecAudit,
  parsePassingPytestNames,
  parseSpecContract,
  scoreGoalConfidence,
  verifySpecAuditAgainstTests,
} from "./confidence.js";
import {
  GapPlanSchema,
  type GoalContract,
  type GoalReceipt,
  checkCircuitBreaker,
  evaluateGoalContract,
  loadGoalContract,
  parseGoalCliArgs,
  writeGoalReceipt,
} from "./goal-core.js";
import { type ReportSection, writePmHtmlReport } from "./pm-report.js";
import { runPreflightPriorArtResearch } from "./prior-art.js";
import { acquireRunLock, assertCleanGitWorktree } from "./preflight.js";
import { installGracefulShutdown, resolvePythonBin, withTransientRetry } from "./resilience.js";

const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";
const NPM_BIN = process.platform === "win32" ? "npm.cmd" : "npm";

function currentHeadSha(): string {
  try {
    return execFileSync("git", ["rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
}

function writeGapTickets(slug: string, plan: { diagnosis: string; tickets: { title: string; what_to_build: string; acceptance_criteria: string[] }[] }): number {
  const issuesDir = path.join(".scratch", slug, "issues");
  mkdirSync(issuesDir, { recursive: true });
  const existing = readdirSync(issuesDir).filter((f) => /^\d+-.*\.md$/u.test(f));
  let nextNum =
    existing.reduce((max, name) => Math.max(max, Number.parseInt(name.split("-")[0] ?? "0", 10)), 0) +
    1;

  for (const t of plan.tickets) {
    const fileSlug = t.title.toLowerCase().replaceAll(/[^a-z0-9]+/gu, "-").replaceAll(/^-|-$/gu, "").slice(0, 42) || "gap";
    const numStr = String(nextNum).padStart(2, "0");
    const checklist = t.acceptance_criteria.map((c) => `- [ ] ${c}`).join("\n");
    const content = [
      `# ${numStr}: ${t.title}`,
      "",
      `**What to build:** ${t.what_to_build}`,
      "",
      "**Blocked by:** None (can start immediately)",
      "",
      "**Status:** ready-for-agent",
      "",
      `**Gap diagnosis:** ${plan.diagnosis}`,
      "",
      checklist,
      "",
    ].join("\n");
    writeFileSync(path.join(issuesDir, `${numStr}-${fileSlug}.md`), content, "utf8");
    nextNum += 1;
  }

  execFileSync("git", ["add", ".scratch/"], { stdio: "ignore" });
  execFileSync("git", ["commit", "-m", `chore(goal): add ${plan.tickets.length} gap-closing ticket(s) for ${slug}`], {
    stdio: "ignore",
  });
  return plan.tickets.length;
}

function collectPassingPytestNames(): Set<string> {
  try {
    const out = execFileSync(resolvePythonBin(), ["-m", "pytest", "-v"], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return parsePassingPytestNames(out);
  } catch (err) {
    console.warn("[WARN] collectPassingPytestNames failed:", err instanceof Error ? err.message : String(err));
    return new Set<string>();
  }
}

function writeStoppedGoalReport(contract: GoalContract, receipt: GoalReceipt): string {
  const confidence = scoreGoalConfidence({
    goalMet: false,
    commandResults: receipt.lastEvaluation.commandResults,
    gapPlanRoundsUsed: receipt.gapPlanRoundsUsed,
  });
  return writePmHtmlReport({
    kind: "goal",
    slug: contract.slug,
    title: `Goal Stopped: ${contract.name} (${confidence.score}/100)`,
    status: "blocked",
    statusLabel: `${confidence.score}/100 · ${confidence.badge}`,
    executiveSummary: `${receipt.reason} ${confidence.reasons.join(" ")}`,
    metrics: [
      { label: "Goal Confidence", value: `${confidence.score}/100`, note: confidence.badge },
      { label: "Elapsed Time", value: `${receipt.elapsedMinutes}m`, note: `${receipt.cyclesRun} cycle(s)` },
      { label: "Open Ready Tickets", value: String(receipt.lastEvaluation.openReadyTickets) },
      { label: "Human Escalations", value: String(receipt.lastEvaluation.openHumanTickets) },
    ],
    sections: [
      {
        heading: "Last Goal Command Checks",
        table: {
          headers: ["Command", "Status", "Exit Code"],
          rows: receipt.lastEvaluation.commandResults.map((r) => [
            r.command,
            r.passed ? "PASS" : "FAIL",
            String(r.exitCode),
          ]),
        },
      },
      {
        heading: "Why Autonomy Stopped",
        bullets: [receipt.reason, ...confidence.reasons],
      },
    ],
  });
}

async function runDeterministicSpecAudit(
  contract: GoalContract,
  startCommit: string,
): Promise<VerifiedSpecAudit | null> {
  if (!contract.specFile || !existsSync(contract.specFile)) {
    return null;
  }
  const specItems = parseSpecContract(readFileSync(contract.specFile, "utf8"));
  if (specItems.length === 0) {
    return null;
  }

  const passingTests = collectPassingPytestNames();
  console.log(
    `\n--> Running fresh-context End-of-Goal Spec Audit against ${contract.specFile} (${specItems.length} items)...`,
  );
  const specFile = contract.specFile;
  const auditRun = await withTransientRetry(
    () =>
      sandcastle.run({
        sandbox: createDockerSandbox(IMAGE_NAME),
        name: `Spec Auditor (${contract.slug})`,
        agent: createAgent("high"),
        promptFile: "./.sandcastle/spec-audit-prompt.md",
        promptArgs: {
          START_COMMIT: startCommit,
          SPEC_FILE: specFile,
          PASSING_TESTS: [...passingTests].filter((t) => t.includes("::")).join("\n") || "(none)",
        },
        output: Output.object({
          tag: "spec-audit",
          schema: SpecAuditOutputSchema,
          maxRetries: 2,
        }),
      }),
    { label: `Spec Auditor (${contract.slug})` },
  );

  return verifySpecAuditAgainstTests({
    specItems,
    audit: auditRun.output,
    passingPytestNames: passingTests,
    repoRoot: process.cwd(),
  });
}

async function main(): Promise<void> {
  assertCleanGitWorktree();
  const releaseGoalLock = acquireRunLock(".goal.lock", "goal");
  const uninstallShutdown = installGracefulShutdown(() => {
    releaseGoalLock();
  });
  try {
    await runGoalLoop();
  } finally {
    uninstallShutdown();
    releaseGoalLock();
  }
}

async function runGoalLoop(): Promise<void> {
  const { goalFile, maxMinutes } = parseGoalCliArgs(process.argv.slice(2));
  const contract = loadGoalContract(goalFile, maxMinutes);
  const startedAt = new Date();
  const startedMs = startedAt.getTime();
  const startCommit = currentHeadSha();

  console.log(`\n=== Level 2 Goal Autonomy: ${contract.name} ===`);
  console.log(
    `Time cap: ${contract.maxTotalMinutes === 0 ? "UNLIMITED" : `${contract.maxTotalMinutes} min`} | ` +
      `Max stalled cycles: ${contract.maxStalledCycles} | Max gap-plan rounds: ${contract.maxGapPlanRounds}`,
  );

  const preflight = await runPreflightPriorArtResearch({
    name: contract.name,
    slug: contract.slug,
    specFile: contract.specFile,
    researchDepth: contract.researchDepth,
    skipResearchReason: contract.skipResearchReason,
    imageName: IMAGE_NAME,
  });
  if (preflight.pausedForApproval) {
    process.exitCode = 2;
    return;
  }

  let cyclesRun = 0;
  let stalledCycles = 0;
  let gapPlanRoundsUsed = 0;
  let lastEval = evaluateGoalContract(contract);

  const stopGoalWithReceipt = (reason: string, elapsedMinutes: number): void => {
    const receipt: GoalReceipt = {
      goalName: contract.name,
      slug: contract.slug,
      status: "STOPPED_CIRCUIT_BREAKER",
      reason,
      startedAt: startedAt.toISOString(),
      finishedAt: new Date().toISOString(),
      elapsedMinutes: Number(elapsedMinutes.toFixed(2)),
      cyclesRun,
      gapPlanRoundsUsed,
      headCommit: currentHeadSha(),
      lastEvaluation: lastEval,
    };
    const receiptPath = writeGoalReceipt(receipt);
    const htmlPath = writeStoppedGoalReport(contract, receipt);
    console.error(`\n[STOP] ${reason}\nReceipt saved: ${receiptPath}\nPM HTML report: ${htmlPath}`);
    process.exitCode = 1;
  };

  while (!lastEval.met) {
    const elapsedMinutes = (Date.now() - startedMs) / 60_000;
    const stopReason = checkCircuitBreaker({
      elapsedMinutes,
      maxTotalMinutes: contract.maxTotalMinutes,
      stalledCycles,
      maxStalledCycles: contract.maxStalledCycles,
      openReadyTickets: lastEval.openReadyTickets,
      openHumanTickets: lastEval.openHumanTickets,
    });
    if (stopReason) {
      stopGoalWithReceipt(stopReason, elapsedMinutes);
      return;
    }

    // If tickets are empty but goal checks still fail, wake bounded Gap-Planner
    if (lastEval.openReadyTickets === 0) {
      if (gapPlanRoundsUsed >= contract.maxGapPlanRounds) {
        stopGoalWithReceipt(
          `Goal checks still failing after ${gapPlanRoundsUsed}/${contract.maxGapPlanRounds} gap-planning rounds.`,
          (Date.now() - startedMs) / 60_000,
        );
        return;
      }

      gapPlanRoundsUsed += 1;
      const failedSummary = lastEval.commandResults
        .filter((r) => !r.passed)
        .map((r) => `Command: ${r.command} (exit ${r.exitCode})\n${r.outputTail}`)
        .join("\n\n---\n\n");

      console.log(`\n--> Gap-Planner round ${gapPlanRoundsUsed}/${contract.maxGapPlanRounds}...`);
      const gapRun = await withTransientRetry(
        () =>
          sandcastle.run({
            sandbox: createDockerSandbox(IMAGE_NAME),
            name: `Gap-Planner (${gapPlanRoundsUsed})`,
            agent: createAgent("medium"),
            promptFile: "./.sandcastle/gap-plan-prompt.md",
            promptArgs: {
              GOAL_NAME: contract.name,
              FAILED_CHECKS: failedSummary || "Ticket checks incomplete.",
            },
            output: Output.object({
              tag: "gap-tickets",
              schema: GapPlanSchema,
              maxRetries: 2,
            }),
          }),
        { label: `Gap-Planner (${gapPlanRoundsUsed})` },
      );
      writeGapTickets(contract.slug, gapRun.output);
    }

    // Run one Sandcastle factory pass (catch crashes cleanly so stopped receipt/HTML report is always written)
    cyclesRun += 1;
    const shaBefore = currentHeadSha();
    console.log(`\n--> Launching factory cycle #${cyclesRun}...`);
    try {
      execFileSync(NPM_BIN, ["--prefix", ".sandcastle", "run", "factory"], { stdio: "inherit" });
    } catch (err) {
      stopGoalWithReceipt(
        `Factory cycle #${cyclesRun} exited with error: ${err instanceof Error ? err.message : String(err)}`,
        (Date.now() - startedMs) / 60_000,
      );
      return;
    }
    const shaAfter = currentHeadSha();

    stalledCycles = shaAfter === shaBefore ? stalledCycles + 1 : 0;
    lastEval = evaluateGoalContract(contract);
  }

  const verifiedAudit = await runDeterministicSpecAudit(contract, startCommit);
  const confidence = scoreGoalConfidence({
    goalMet: true,
    commandResults: lastEval.commandResults,
    verifiedAudit,
    gapPlanRoundsUsed,
  });

  const receipt: GoalReceipt = {
    goalName: contract.name,
    slug: contract.slug,
    status: "GOAL_MET",
    reason: "All tickets resolved and every deterministic verifyCommand exited 0.",
    startedAt: startedAt.toISOString(),
    finishedAt: new Date().toISOString(),
    elapsedMinutes: Number(((Date.now() - startedMs) / 60_000).toFixed(2)),
    cyclesRun,
    gapPlanRoundsUsed,
    headCommit: currentHeadSha(),
    lastEvaluation: lastEval,
    confidence: {
      score: confidence.score,
      badge: confidence.badge,
      reasons: confidence.reasons,
      specVerified: verifiedAudit
        ? `${verifiedAudit.verifiedCount}/${verifiedAudit.totalSpecItems}`
        : undefined,
    },
  };
  const receiptPath = writeGoalReceipt(receipt);

  const reportSections: ReportSection[] = [
    {
      heading: "Verified Goal Checks",
      table: {
        headers: ["Command", "Status", "Exit Code"],
        rows: receipt.lastEvaluation.commandResults.map((r) => [
          r.command,
          r.passed ? "PASS" : "FAIL",
          String(r.exitCode),
        ]),
      },
    },
  ];
  if (verifiedAudit) {
    reportSections.push({
      heading: `Grilling Spec Traceability (${verifiedAudit.verifiedCount}/${verifiedAudit.totalSpecItems} verified)`,
      table: {
        headers: ["Spec ID", "Requirement / Rule", "Status", "Evidence & Pytest Proof"],
        rows: verifiedAudit.rows.map((r) => [
          r.id,
          r.requirement,
          r.status,
          [r.evidenceFile, r.citedTest, r.note].filter(Boolean).join(" · ") || "--",
        ]),
      },
    });
  }
  reportSections.push({
    heading: "Deterministic Confidence Factors",
    bullets: [...confidence.reasons],
  });

  const htmlPath = writePmHtmlReport({
    kind: "goal",
    slug: contract.slug,
    title: `Goal Achieved: ${contract.name} (${confidence.score}/100)`,
    status: confidence.status,
    statusLabel: `${confidence.score}/100 · ${confidence.badge}`,
    executiveSummary: `${receipt.reason} ${confidence.reasons.join(" ")}`,
    metrics: [
      { label: "Goal Confidence", value: `${confidence.score}/100`, note: confidence.badge },
      {
        label: "Grilling Spec",
        value: verifiedAudit
          ? `${verifiedAudit.verifiedCount}/${verifiedAudit.totalSpecItems}`
          : "No specFile",
        note: verifiedAudit ? "Cross-checked vs pytest" : "Add specFile in goal.json",
      },
      { label: "Elapsed Time", value: `${receipt.elapsedMinutes}m`, note: `${receipt.cyclesRun} cycle(s)` },
      { label: "HEAD Commit", value: receipt.headCommit, note: `${receipt.gapPlanRoundsUsed} gap round(s)` },
    ],
    sections: reportSections,
  });
  console.log(
    `\n=== GOAL MET (${confidence.score}/100 · ${confidence.badge}) ===\nReceipt saved: ${receiptPath}\nPM HTML report: ${htmlPath}` +
      formatEndOfRunFooter({ kind: "goal", reportPath: htmlPath }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
