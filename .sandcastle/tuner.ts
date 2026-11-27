/**
 * Read-Only Sandcastle Parameter Tuner (`npm --prefix .sandcastle run tune`).
 *
 * Enforces TWO hard safety invariants:
 *   1. Minimum 10 verified local factory runs on disk (`MIN_RUNS_FOR_TUNING = 10`).
 *   2. Proposal-only with strict numeric safety clamps — NEVER auto-edits `.env`,
 *      `run.ts`, `test_guard.py`, `coverage-baseline.json`, or `mutation_check.py`.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import { formatEndOfRunFooter } from "./coach.js";
import {
  computeAgentTrustScore,
  loadHumanRatings,
} from "./confidence.js";
import {
  type FactoryRunRecord,
  MIN_RUNS_FOR_TUNING,
  loadVerifiedRunHistory,
} from "./run-history.js";
import { writePmHtmlReport } from "./pm-report.js";

export type TunableParam =
  | "DRIFT_MAX_MINUTES"
  | "DRIFT_MAX_TOOL_CALLS"
  | "DRIFT_MAX_REPEATED_TOOLS"
  | "DRIFT_MAX_DIFF_LINES"
  | "DRIFT_MAX_DIFF_FILES"
  | "DRIFT_MAX_CONTEXT_RATIO"
  | "DRIFT_MAX_CONTEXT_TOKENS";

export const SAFETY_CLAMPS: Record<TunableParam, { readonly min: number; readonly max: number }> = {
  DRIFT_MAX_MINUTES: { min: 10, max: 35 },
  DRIFT_MAX_TOOL_CALLS: { min: 25, max: 80 },
  DRIFT_MAX_REPEATED_TOOLS: { min: 4, max: 10 },
  DRIFT_MAX_DIFF_LINES: { min: 150, max: 500 },
  DRIFT_MAX_DIFF_FILES: { min: 3, max: 10 },
  DRIFT_MAX_CONTEXT_RATIO: { min: 0.65, max: 0.85 },
  DRIFT_MAX_CONTEXT_TOKENS: { min: 80_000, max: 160_000 },
};

export const TuningProposalSchema = z.object({
  executiveSummary: z.string().min(1),
  parameterChanges: z.array(
    z.object({
      param: z.enum([
        "DRIFT_MAX_MINUTES",
        "DRIFT_MAX_TOOL_CALLS",
        "DRIFT_MAX_REPEATED_TOOLS",
        "DRIFT_MAX_DIFF_LINES",
        "DRIFT_MAX_DIFF_FILES",
        "DRIFT_MAX_CONTEXT_RATIO",
        "DRIFT_MAX_CONTEXT_TOKENS",
      ]),
      currentValue: z.number(),
      proposedValue: z.number(),
      evidence: z.string().min(1),
    }),
  ),
  promptOrProcessSuggestions: z.array(
    z.object({
      targetFile: z.string().min(1),
      suggestion: z.string().min(1),
      evidence: z.string().min(1),
    }),
  ),
});

export type TuningProposal = z.infer<typeof TuningProposalSchema>;

export interface AggregatedRunStats {
  readonly verifiedRunCount: number;
  readonly totalSlicesObserved: number;
  readonly mergedSlices: number;
  readonly escalatedSlices: number;
  readonly driftAutoSplits: number;
  readonly testTamperBlocks: number;
  readonly adversarialChallengesRaised: number;
  readonly adversarialChallengesResolved: number;
  readonly p50ElapsedMin: number;
  readonly p90ElapsedMin: number;
  readonly p50ToolCalls: number;
  readonly p90ToolCalls: number;
  readonly p50DiffLines: number;
  readonly p90DiffLines: number;
  readonly p90ContextPercent: number;
}

export function percentile(values: readonly number[], p: number): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const idx = Math.min(sorted.length - 1, Math.max(0, Math.ceil((p / 100) * sorted.length) - 1));
  return Number((sorted[idx] ?? 0).toFixed(2));
}

export function computeAggregatedStats(runs: readonly FactoryRunRecord[]): AggregatedRunStats {
  const allSlices = runs.flatMap((r) => r.slices);
  const elapsedMins = allSlices.map((s) => s.elapsedSec / 60);
  const toolCalls = allSlices.map((s) => s.toolCalls);
  const diffLines = allSlices.map((s) => s.diffLines);
  const ctxPcts = allSlices.map((s) => s.contextPercent);

  return {
    verifiedRunCount: runs.length,
    totalSlicesObserved: allSlices.length,
    mergedSlices: allSlices.filter((s) => s.stage === "merged").length,
    escalatedSlices: allSlices.filter((s) => s.stage === "needs_human").length,
    driftAutoSplits: runs.reduce((acc, r) => acc + r.driftAutoSplits, 0),
    testTamperBlocks: runs.reduce((acc, r) => acc + r.testTamperBlocks, 0),
    adversarialChallengesRaised: runs.reduce((acc, r) => acc + r.adversarialChallengesRaised, 0),
    adversarialChallengesResolved: runs.reduce(
      (acc, r) => acc + r.adversarialChallengesResolved,
      0,
    ),
    p50ElapsedMin: percentile(elapsedMins, 50),
    p90ElapsedMin: percentile(elapsedMins, 90),
    p50ToolCalls: percentile(toolCalls, 50),
    p90ToolCalls: percentile(toolCalls, 90),
    p50DiffLines: percentile(diffLines, 50),
    p90DiffLines: percentile(diffLines, 90),
    p90ContextPercent: percentile(ctxPcts, 90),
  };
}

export function enforceSafetyClamps(proposal: TuningProposal): {
  readonly safeProposal: TuningProposal;
  readonly clampedNotes: readonly string[];
} {
  const clampedNotes: string[] = [];
  const safeChanges = proposal.parameterChanges.map((item) => {
    const bounds = SAFETY_CLAMPS[item.param];
    if (item.proposedValue < bounds.min || item.proposedValue > bounds.max) {
      const clamped = Math.min(bounds.max, Math.max(bounds.min, item.proposedValue));
      clampedNotes.push(
        `${item.param}: proposed ${item.proposedValue} exceeded safety bounds [${bounds.min}, ${bounds.max}] -> clamped to ${clamped}.`,
      );
      return { ...item, proposedValue: clamped };
    }
    return item;
  });

  return {
    safeProposal: { ...proposal, parameterChanges: safeChanges },
    clampedNotes,
  };
}

export function renderTuningReportMarkdown(
  stats: AggregatedRunStats,
  proposal: TuningProposal | null,
  clampedNotes: readonly string[],
): string {
  const lines: string[] = [
    "# Sandcastle Parameter Tuning Proposal (Human-Approval Required)",
    "",
    `> Generated from **${stats.verifiedRunCount}** verified local factory runs (${stats.totalSlicesObserved} slices).`,
    "> **Read-only proposal:** Nothing was auto-modified. Review and apply chosen values to `.sandcastle/.env` manually.",
    "",
    "## Aggregated Run Metrics",
    "",
    "| Metric | Value |",
    "| :--- | :--- |",
    `| Verified local runs | ${stats.verifiedRunCount} (minimum ${MIN_RUNS_FOR_TUNING}) |`,
    `| Slices merged / escalated | ${stats.mergedSlices} merged / ${stats.escalatedSlices} escalated |`,
    `| Elapsed time (p50 / p90) | ${stats.p50ElapsedMin}m / ${stats.p90ElapsedMin}m |`,
    `| Tool calls (p50 / p90) | ${stats.p50ToolCalls} / ${stats.p90ToolCalls} |`,
    `| Diff lines (p50 / p90) | ${stats.p50DiffLines} / ${stats.p90DiffLines} |`,
    `| Context window (p90) | ${stats.p90ContextPercent}% |`,
    `| Adversarial challenges (resolved / raised) | ${stats.adversarialChallengesResolved} / ${stats.adversarialChallengesRaised} |`,
    `| Drift auto-splits / Test-tamper blocks | ${stats.driftAutoSplits} / ${stats.testTamperBlocks} |`,
    "",
  ];

  if (!proposal) {
    lines.push("_(Stats-only mode — re-run without `--stats-only` to generate LLM tuning recommendations.)_");
    return lines.join("\n") + "\n";
  }

  lines.push("## Executive Summary", "", proposal.executiveSummary, "");
  lines.push("## Proposed Parameter Changes (Safety-Clamped)", "");
  if (proposal.parameterChanges.length === 0) {
    lines.push("- No parameter changes recommended; current thresholds are well calibrated.", "");
  } else {
    for (const c of proposal.parameterChanges) {
      lines.push(`- **\`${c.param}\`:** \`${c.currentValue}\` → \`${c.proposedValue}\` — ${c.evidence}`);
    }
    lines.push("");
  }

  if (clampedNotes.length > 0) {
    lines.push("## Safety Clamp Interventions", "");
    for (const note of clampedNotes) {
      lines.push(`- ${note}`);
    }
    lines.push("");
  }

  lines.push("## Prompt & Process Improvements", "");
  if (proposal.promptOrProcessSuggestions.length === 0) {
    lines.push("- None.", "");
  } else {
    for (const s of proposal.promptOrProcessSuggestions) {
      lines.push(`- **\`${s.targetFile}\`:** ${s.suggestion} _(Evidence: ${s.evidence})_`);
    }
    lines.push("");
  }

  return lines.join("\n");
}

export function assertMinimumRuns(
  logsDir = path.join(".sandcastle", "logs"),
  minRuns = MIN_RUNS_FOR_TUNING,
): readonly FactoryRunRecord[] {
  const { verifiedRuns, skippedMissingFiles, skippedInvalidLines } =
    loadVerifiedRunHistory(logsDir);
  if (verifiedRuns.length < minRuns) {
    const remaining = minRuns - verifiedRuns.length;
    const extra =
      skippedMissingFiles > 0 || skippedInvalidLines > 0
        ? ` (ignored ${skippedMissingFiles} missing local run file(s), ${skippedInvalidLines} invalid line(s))`
        : "";
    throw new Error(
      `Tuning locked: found ${verifiedRuns.length}/${minRuns} verified local factory runs on disk${extra}. ` +
        `Complete ${remaining} more real factory run(s) before running parameter analysis.`,
    );
  }
  return verifiedRuns;
}

async function main(): Promise<void> {
  const statsOnly = process.argv.includes("--stats-only");
  const logsDir = path.join(".sandcastle", "logs");
  const verifiedRuns = assertMinimumRuns(logsDir, MIN_RUNS_FOR_TUNING);
  const stats = computeAggregatedStats(verifiedRuns);
  const humanRatings = loadHumanRatings(logsDir);
  const trust = computeAgentTrustScore(verifiedRuns, humanRatings);

  let proposal: TuningProposal | null = null;
  let clampedNotes: readonly string[] = [];

  if (!statsOnly) {
    const model = process.env["CODEX_MODEL"] ?? "gpt-5.4";
    const imageName = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";
    const tuneRun = await sandcastle.run({
      sandbox: docker({
        imageName,
        mounts: [
          {
            hostPath: "~/.codex/auth.json",
            sandboxPath: "/home/agent/.codex/auth.json",
            readonly: true,
          },
        ],
      }),
      name: "Parameter Tuner (Read-Only)",
      agent: sandcastle.codex(model, {
        effort: "medium",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/tune-prompt.md",
      promptArgs: {
        AGGREGATED_STATS_JSON: JSON.stringify(
          {
            stats,
            agentTrust: trust,
            recentHumanFeedback: humanRatings.slice(-10),
          },
          null,
          2,
        ),
        SAFETY_CLAMPS_JSON: JSON.stringify(SAFETY_CLAMPS, null, 2),
      },
      output: Output.object({
        tag: "tuning",
        schema: TuningProposalSchema,
        maxRetries: 2,
      }),
    });

    const clamped = enforceSafetyClamps(tuneRun.output);
    proposal = clamped.safeProposal;
    clampedNotes = clamped.clampedNotes;
  }

  mkdirSync(logsDir, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(logsDir, `tuning-report-${dateTag}.md`);
  writeFileSync(reportPath, renderTuningReportMarkdown(stats, proposal, clampedNotes), "utf8");
  const htmlPath = writePmHtmlReport({
    kind: "tuning",
    slug: "parameters",
    title: `Sandcastle Parameter Tuning Report (${dateTag})`,
    status: "proposal",
    statusLabel: `${stats.verifiedRunCount} Runs Analyzed`,
    executiveSummary:
      proposal?.executiveSummary ??
      `Aggregated deterministic p50/p90 metrics across ${stats.verifiedRunCount} verified local factory runs.`,
    metrics: [
      { label: "Verified Runs", value: String(stats.verifiedRunCount) },
      { label: "Agent Trust", value: `${trust.trustScore}/100`, note: trust.tier },
      { label: "p90 Elapsed", value: `${stats.p90ElapsedMin}m` },
      { label: "p90 Diff Lines", value: String(stats.p90DiffLines) },
    ],
    sections: [
      {
        heading: "Proposed Clamped Parameter Changes",
        bullets:
          proposal && proposal.parameterChanges.length > 0
            ? proposal.parameterChanges.map(
                (c) => `${c.param}: ${c.currentValue} -> ${c.proposedValue} (${c.evidence})`,
              )
            : ["No parameter adjustments proposed."],
      },
    ],
  });
  console.log(
    `Tuning proposal written to: ${reportPath}\nPM HTML report: ${htmlPath}` +
      formatEndOfRunFooter({ kind: "tuning", reportPath: htmlPath }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
