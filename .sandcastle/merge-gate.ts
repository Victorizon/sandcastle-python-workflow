/**
 * Deep module owning post-slice batch merging, host-side deterministic verification,
 * multi-branch cross-slice auditing, atomic rollback on failure, and end-of-run PM reporting.
 */

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import { formatEndOfRunFooter } from "./coach.js";
import { computeAgentTrustScore, loadHumanRatings, scoreFactoryRunConfidence } from "./confidence.js";
import type { PMDashboard } from "./dashboard.js";
import { writePmHtmlReport } from "./pm-report.js";
import { formatPowEvidenceForReviewer, runMergeProofOfWork } from "./pow-verifier.js";
import { rollbackToCommitClean } from "./preflight.js";
import { withTransientRetry } from "./resilience.js";
import { loadVerifiedRunHistory, recordFactoryRun } from "./run-history.js";
import {
  type PlannedTicket,
  type SliceRuntimeContext,
  escalateTicketToHuman,
  parseVerdict,
} from "./slice-container.js";

export interface MergeGateOps {
  readonly getHeadSha: () => string;
  readonly runMerger: (readyToMerge: readonly PlannedTicket[], cycle: number, ctx: SliceRuntimeContext) => Promise<void>;
  readonly runHostChecks: (preMergeSha: string, pythonBin: string) => boolean;
  readonly runMergePow: typeof runMergeProofOfWork;
  readonly runCrossSliceAudit: (
    preMergeSha: string,
    readyToMerge: readonly PlannedTicket[],
    powEvidence: string,
    cycle: number,
    ctx: SliceRuntimeContext,
  ) => Promise<string>;
  readonly rollback: (sha: string) => void;
  readonly escalate: typeof escalateTicketToHuman;
}

const DEFAULT_MERGE_OPS: MergeGateOps = {
  getHeadSha: () => execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim(),
  runMerger: async (readyToMerge, cycle, ctx) => {
    await sandcastle.run({
      sandbox: createDockerSandbox(ctx.imageName),
      name: "Merger",
      branchStrategy: { type: "head" },
      maxIterations: 4,
      agent: createAgent("medium"),
      logging: ctx.tracer.sandboxLogging(cycle, "merge"),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        BRANCHES: readyToMerge.map((t) => `- ${t.branch}`).join("\n"),
        TICKETS: readyToMerge.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
      },
    });
  },
  runHostChecks: (preMergeSha, pythonBin) => {
    try {
      execFileSync(pythonBin, ["scripts/check.py"], { stdio: "inherit" });
      execFileSync(pythonBin, ["scripts/test_guard.py", "--base", preMergeSha], { stdio: "inherit" });
      execFileSync(pythonBin, ["scripts/adversarial_scan.py", "--base", preMergeSha], { stdio: "inherit" });
      return true;
    } catch {
      return false;
    }
  },
  runMergePow: runMergeProofOfWork,
  runCrossSliceAudit: async (preMergeSha, readyToMerge, powEvidence, cycle, ctx) => {
    const mergeReview = await withTransientRetry(
      () =>
        sandcastle.run({
          sandbox: createDockerSandbox(ctx.imageName),
          name: "Post-Merge Cross-Slice Auditor",
          agent: createAgent("high"),
          logging: ctx.tracer.sandboxLogging(cycle, "post_merge_audit"),
          prompt: [
            `Inspect the combined multi-branch merge diff (\`git diff ${preMergeSha}..HEAD\`) for tickets:`,
            ...readyToMerge.map((t) => `- ${t.id}: ${t.title}`),
            `Cross-Slice Proof-of-Work Evidence:\n${powEvidence}`,
            `Check ONLY whether merging these branches dropped, contradicted, or weakened any behavior from either ticket.`,
            `Do NOT edit files. Output JSON inside <verdict> tags: {"approved": true|false, "severity": "none"|"minor"|"blocking", "summary": "...", "blockingIssues": []}`,
            `Then output <promise>COMPLETE</promise>.`,
          ].join("\n"),
          maxIterations: 1,
        }),
      { label: "Post-Merge Cross-Slice Auditor" },
    );
    return mergeReview.stdout;
  },
  rollback: rollbackToCommitClean,
  escalate: escalateTicketToHuman,
};

export async function mergeAndVerifyBatch(
  readyToMerge: readonly PlannedTicket[],
  cycle: number,
  ctx: SliceRuntimeContext,
  ops: MergeGateOps = DEFAULT_MERGE_OPS,
): Promise<boolean> {
  const preMergeSha = ops.getHeadSha();
  ctx.dashboard.setCycle(cycle, `Merger combining ${readyToMerge.length} approved branch(es) into main...`);
  const tMerge = performance.now();
  try {
    await ops.runMerger(readyToMerge, cycle, ctx);
  } catch (mergeErr) {
    ops.rollback(preMergeSha);
    ctx.tracer.recordSpan({
      cycle,
      phase: "merge",
      outcome: "rollback",
      durationMs: performance.now() - tMerge,
      detail: `Merger crashed; rolled back to ${preMergeSha.slice(0, 7)}`,
    });
    throw mergeErr;
  }
  ctx.tracer.recordSpan({
    cycle,
    phase: "merge",
    outcome: "pass",
    durationMs: performance.now() - tMerge,
    detail: readyToMerge.map((t) => t.id).join(", "),
  });

  // Deterministic host-side verification after Merger
  const tHost = performance.now();
  const hostCheckPassed = ops.runHostChecks(preMergeSha, ctx.pythonBin);
  ctx.tracer.recordSpan({
    cycle,
    phase: "host_check",
    outcome: hostCheckPassed ? "pass" : "rollback",
    durationMs: performance.now() - tHost,
    detail: hostCheckPassed
      ? "check.py + test_guard + adversarial_scan PASS"
      : "host post-merge gate FAILED",
  });

  // Optional multi-branch cross-slice PoW + Auditor
  let multiMergeConflictIssue: string | null = null;
  if (hostCheckPassed && readyToMerge.length >= 2) {
    const mergePow = await ops.runMergePow({
      imageName: ctx.imageName,
      preMergeSha,
      tickets: [...readyToMerge],
      cycle,
      tracer: ctx.tracer,
    });
    const tAudit = performance.now();
    const auditStdout = await ops.runCrossSliceAudit(
      preMergeSha,
      readyToMerge,
      formatPowEvidenceForReviewer(mergePow),
      cycle,
      ctx,
    );
    const mergeVerdict = parseVerdict(auditStdout);
    if (!mergeVerdict?.approved) {
      multiMergeConflictIssue =
        mergeVerdict?.blockingIssues.join("; ") ||
        "Post-merge cross-slice auditor flagged a conflict or dropped requirement.";
    }
    ctx.tracer.recordSpan({
      cycle,
      phase: "post_merge_audit",
      outcome: multiMergeConflictIssue ? "rollback" : "pass",
      durationMs: performance.now() - tAudit,
      detail: multiMergeConflictIssue ?? mergeVerdict?.summary ?? "approved",
    });
  }

  if (!hostCheckPassed || multiMergeConflictIssue !== null) {
    try {
      ops.rollback(preMergeSha);
    } catch (err) {
      console.error(`Failed to roll back main to ${preMergeSha}:`, err);
    }
    const reason = multiMergeConflictIssue
      ? `Post-merge cross-slice audit blocked batch (main atomically rolled back to ${preMergeSha.slice(0, 7)}): ${multiMergeConflictIssue}`
      : `Host post-merge \`python scripts/check.py\` FAILED (main atomically rolled back to ${preMergeSha.slice(0, 7)}).`;
    for (const t of readyToMerge) {
      ops.escalate(t.id, reason, ctx.dashboard, ctx.pythonBin);
    }
    ctx.dashboard.setRunStatus(
      "blocked",
      `Post-merge verification failed — main atomically rolled back to ${preMergeSha.slice(0, 7)}.`,
    );
    return false;
  }

  for (const merged of readyToMerge) {
    ctx.dashboard.upsertSlice(merged.id, {
      stage: "merged",
      pmSummary: "Merged into main, re-verified on host via check.py, and marked resolved.",
    });
  }
  return true;
}

export function finalizeFactoryReport(dashboard: PMDashboard): void {
  const finalState = dashboard.getState();
  const recorded = recordFactoryRun(finalState);
  const { verifiedRuns } = loadVerifiedRunHistory();
  const trust = computeAgentTrustScore(verifiedRuns, loadHumanRatings());
  const conf = recorded
    ? scoreFactoryRunConfidence(recorded)
    : {
        overall: {
          score: finalState.runStatus === "complete" ? 100 : 40,
          badge:
            finalState.runStatus === "complete"
              ? ("Spot-Check Ready" as const)
              : ("Blocked — Do Not Ship" as const),
          status:
            finalState.runStatus === "complete"
              ? ("success" as const)
              : ("blocked" as const),
          reasons: [finalState.headline],
        },
        bySlice: new Map(),
      };

  const htmlPath = writePmHtmlReport({
    kind: "factory",
    slug: "session",
    title: `Sandcastle Factory Run Summary (${conf.overall.score}/100)`,
    status: conf.overall.status,
    statusLabel: `${conf.overall.score}/100 · ${conf.overall.badge}`,
    executiveSummary: `${finalState.headline} Confidence assessment: ${conf.overall.reasons.join(" ")}`,
    metrics: [
      { label: "Run Confidence", value: `${conf.overall.score}/100`, note: conf.overall.badge },
      {
        label: "Slices Shipped",
        value: `${finalState.metrics.completedSlices} / ${finalState.metrics.totalSlices}`,
        note: `${finalState.metrics.progressPercent}% complete`,
      },
      {
        label: "Test Strength",
        value:
          finalState.metrics.latestMutationScore !== null
            ? `${finalState.metrics.latestMutationScore}%`
            : "--",
        note:
          finalState.metrics.latestCoveragePercent !== null
            ? `Coverage ${finalState.metrics.latestCoveragePercent}%`
            : "Coverage --",
      },
      { label: "Agent Trust", value: `${trust.trustScore}/100`, note: trust.tier },
    ],
    sections: [
      {
        heading: "Slice Outcomes & Deterministic Confidence",
        table: {
          headers: ["Slice", "Title", "Stage", "Confidence", "Diff Lines", "Summary"],
          rows: finalState.slices.map((s) => {
            const sc = conf.bySlice.get(s.id);
            return [
              s.id,
              s.title,
              s.stage,
              sc ? `${sc.score}/100 · ${sc.badge}` : "--",
              String(s.watchdog.diffLines),
              s.pmSummary,
            ];
          }),
        },
      },
      {
        heading: "Confidence Factors & Human Reality Check",
        bullets: [
          ...conf.overall.reasons,
          `Rolling Agent Trust across ${trust.runsAnalyzed} verified run(s): ${trust.trustScore}/100 (${trust.tier}).`,
          `Optional post-review feedback: run \`npm --prefix .sandcastle run rate -- --latest --verdict good|tweak|rework\`.`,
        ],
      },
    ],
  });
  console.log(
    `Confidence: ${conf.overall.score}/100 (${conf.overall.badge})\nPM HTML report saved to: ${htmlPath}` +
      formatEndOfRunFooter({ kind: "factory", reportPath: htmlPath }),
  );
}
