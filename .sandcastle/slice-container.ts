/**
 * Deep module owning watched Docker container execution, DriftWatchdog enforcement,
 * 1-shot Decomposer auto-splitting, human escalation, and shared slice schemas.
 */

import { execFileSync } from "node:child_process";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import { type PMDashboard, summarizeAgentEventForPm } from "./dashboard.js";
import type { RunTracer } from "./diagnostics.js";
import { DriftDetectedError, DriftWatchdog, parseGitNumstat } from "./drift-watchdog.js";
import { commitScratchState } from "./preflight.js";
import { withTransientRetry } from "./resilience.js";

const MAX_IMPLEMENT_ITERATIONS = 4;
const MAX_AUTO_SPLITS = 1;

export const PlanSchema = z.object({
  tickets: z.array(
    z.object({
      id: z.string().min(1),
      title: z.string().min(1),
      branch: z.string().regex(/^sandcastle\/[a-z0-9/_-]+$/u),
      splitDepth: z.number().int().min(0).default(0),
    }),
  ),
});

const VerdictSchema = z.object({
  approved: z.boolean(),
  severity: z.enum(["none", "minor", "blocking"]),
  summary: z.string(),
  blockingIssues: z.array(z.string()),
});

const SplitPlanSchema = z.object({
  reason: z.string().min(1),
  subtickets: z
    .array(
      z.object({
        title: z.string().min(1),
        what_to_build: z.string().min(1),
        acceptance_criteria: z.array(z.string().min(1)).min(1),
        blocked_by_indexes: z.array(z.number().int().min(0)).default([]),
      }),
    )
    .min(2)
    .max(3),
});

export type PlannedTicket = z.infer<typeof PlanSchema>["tickets"][number];

export interface SliceRuntimeContext {
  readonly imageName: string;
  readonly pythonBin: string;
  readonly dashboard: PMDashboard;
  readonly tracer: RunTracer;
}

export function isAheadOfHead(branch: string): boolean {
  try {
    const count = execFileSync("git", ["rev-list", "--count", `HEAD..${branch}`], {
      encoding: "utf8",
    });
    return Number(count.trim()) > 0;
  } catch {
    return false;
  }
}

export function escalateTicketToHuman(
  ticketId: string,
  reason: string,
  dashboard: PMDashboard,
  pythonBin: string,
): void {
  dashboard.upsertSlice(ticketId, {
    stage: "needs_human",
    pmSummary: `Escalated to human review: ${reason}`,
  });
  dashboard.addEvent({
    sliceId: ticketId,
    level: "error",
    headline: "Escalated slice to human attention",
    detail: reason,
  });
  try {
    execFileSync(pythonBin, ["scripts/local_tracker.py", "comment", ticketId, "--body", reason], {
      stdio: "inherit",
    });
    execFileSync(pythonBin, ["scripts/local_tracker.py", "set-status", ticketId, "ready-for-human"], {
      stdio: "inherit",
    });
    commitScratchState(`chore(factory): escalate ${ticketId} to ready-for-human`);
  } catch (err) {
    console.error(`Failed to mark ${ticketId} ready-for-human:`, err);
  }
}

export function parseVerdict(stdout: string): z.infer<typeof VerdictSchema> | null {
  const match = /<verdict>([\s\S]*?)<\/verdict>/u.exec(stdout);
  if (!match?.[1]) return null;
  try {
    const parsed = VerdictSchema.safeParse(JSON.parse(match[1].trim()));
    return parsed.success ? parsed.data : null;
  } catch {
    return null;
  }
}

async function handleDriftRemediation(
  ticket: PlannedTicket,
  drift: DriftDetectedError,
  partialDiffStat: string,
  cycle: number,
  ctx: SliceRuntimeContext,
): Promise<boolean> {
  const tDecompose = performance.now();
  console.warn(`  [DRIFT] ${ticket.id}: ${drift.message}`);

  if (ticket.splitDepth >= MAX_AUTO_SPLITS) {
    ctx.dashboard.recordChallenge(ticket.id, {
      source: "drift_watchdog",
      finding: `${drift.message} (max split depth ${MAX_AUTO_SPLITS} reached)`,
      outcome: "escalated",
    });
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog stopped ticket (${drift.message}). Already at split depth ${ticket.splitDepth}/${MAX_AUTO_SPLITS}.`,
      ctx.dashboard,
      ctx.pythonBin,
    );
    ctx.tracer.recordSpan({
      cycle,
      sliceId: ticket.id,
      phase: "decompose",
      outcome: "escalated",
      durationMs: performance.now() - tDecompose,
      detail: `max split depth ${MAX_AUTO_SPLITS} reached`,
    });
    return false;
  }

  ctx.dashboard.recordChallenge(ticket.id, {
    source: "drift_watchdog",
    finding: `${drift.message} — waking Decomposer to split into smaller slices.`,
    outcome: "split",
  });
  ctx.dashboard.upsertSlice(ticket.id, {
    stage: "remediating",
    pmSummary: "Stopped by Drift Watchdog — Decomposer breaking ticket into 2–3 smaller vertical slices.",
  });

  try {
    const splitRun = await withTransientRetry(
      () =>
        sandcastle.run({
          sandbox: createDockerSandbox(ctx.imageName),
          name: `Decomposer ${ticket.id}`,
          agent: createAgent("medium"),
          promptFile: "./.sandcastle/decompose-prompt.md",
          promptArgs: {
            TICKET_ID: ticket.id,
            DRIFT_REASON: drift.message,
            PARTIAL_DIFF_STAT: partialDiffStat || "(no committed diff yet)",
          },
          output: Output.object({ tag: "split", schema: SplitPlanSchema, maxRetries: 2 }),
        }),
      { label: `Decomposer ${ticket.id}` },
    );

    execFileSync(
      ctx.pythonBin,
      ["scripts/local_tracker.py", "split", ticket.id, "--plan-json", "-", "--max-depth", String(MAX_AUTO_SPLITS)],
      {
        input: JSON.stringify(splitRun.output),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    commitScratchState(`chore(watchdog): auto-split drifted ticket ${ticket.id}`);
    try {
      execFileSync("git", ["branch", "-D", ticket.branch], { stdio: "ignore" });
    } catch {
      // Branch may not exist yet if drift occurred before first commit
    }

    ctx.dashboard.upsertSlice(ticket.id, {
      stage: "split",
      pmSummary: `Auto-split into ${splitRun.output.subtickets.length} smaller sub-slices after drift detection.`,
    });
    ctx.dashboard.addEvent({
      sliceId: ticket.id,
      level: "challenge",
      headline: `DriftWatchdog auto-split oversized ticket into ${splitRun.output.subtickets.length} slices`,
      detail: drift.message,
    });
    ctx.tracer.recordSpan({
      cycle,
      sliceId: ticket.id,
      phase: "decompose",
      outcome: "decomposed",
      durationMs: performance.now() - tDecompose,
      detail: `split into ${splitRun.output.subtickets.length} sub-slices`,
    });
    return true;
  } catch (err) {
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog fired (${drift.message}) and Decomposer failed (${err instanceof Error ? err.message : String(err)}).`,
      ctx.dashboard,
      ctx.pythonBin,
    );
    ctx.tracer.recordSpan({
      cycle,
      sliceId: ticket.id,
      phase: "decompose",
      outcome: "escalated",
      durationMs: performance.now() - tDecompose,
      detail: err instanceof Error ? err.message : String(err),
    });
    return false;
  }
}

export async function runWatchedContainer(params: {
  readonly ticket: PlannedTicket;
  readonly cycle: number;
  readonly phase: "implement" | "fix";
  readonly name: string;
  readonly promptFile: string;
  readonly promptArgs: Record<string, string>;
  readonly startedAtMs: number;
  readonly logPath: string;
  readonly recordPostMetrics: boolean;
  readonly ctx: SliceRuntimeContext;
}): Promise<{ readonly ok: boolean; readonly decomposed: boolean }> {
  const tPhase = performance.now();
  await using sandbox = await sandcastle.createSandbox({
    sandbox: createDockerSandbox(params.ctx.imageName),
    branch: params.ticket.branch,
  });
  const watchdog = new DriftWatchdog();
  try {
    const runResult = await sandbox.run({
      name: params.name,
      agent: createAgent("medium"),
      promptFile: params.promptFile,
      promptArgs: params.promptArgs,
      maxIterations: MAX_IMPLEMENT_ITERATIONS,
      signal: watchdog.signal,
      logging: {
        type: "file",
        path: params.logPath,
        onAgentStreamEvent: (ev) => {
          watchdog.onEvent(ev);
          const pmNote = summarizeAgentEventForPm(ev);
          if (pmNote) {
            params.ctx.dashboard.upsertSlice(params.ticket.id, {
              pmSummary: pmNote,
              watchdog: {
                elapsedSec: Math.round((Date.now() - params.startedAtMs) / 1000),
                toolCalls: watchdog.toolCallCount,
              },
            });
          }
        },
      },
    });

    const numstat = await sandbox.exec("git diff --numstat main..HEAD");
    const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
    const lastCtx = runResult.iterations.at(-1)?.contextWindow;
    if (params.recordPostMetrics) {
      const ctxPct =
        lastCtx?.limit && lastCtx.limit > 0 ? Math.round((lastCtx.tokens / lastCtx.limit) * 100) : 0;
      params.ctx.dashboard.upsertSlice(params.ticket.id, {
        watchdog: {
          elapsedSec: Math.round((Date.now() - params.startedAtMs) / 1000),
          toolCalls: watchdog.toolCallCount,
          diffLines,
          contextPercent: ctxPct,
        },
      });
    }

    const postDrift = watchdog.checkPostRun({
      diffFiles,
      diffLines,
      contextTokens: lastCtx?.tokens,
      contextLimit: lastCtx?.limit,
      completed: runResult.completionSignal !== undefined,
    });
    if (postDrift) {
      const stat = await sandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(
        params.ticket,
        postDrift,
        stat.stdout.trim(),
        params.cycle,
        params.ctx,
      );
      params.ctx.tracer.recordSpan({
        cycle: params.cycle,
        sliceId: params.ticket.id,
        phase: params.phase,
        outcome: decomposed ? "decomposed" : "escalated",
        durationMs: performance.now() - tPhase,
        detail: postDrift.message,
      });
      return { ok: false, decomposed };
    }
    params.ctx.tracer.recordSpan({
      cycle: params.cycle,
      sliceId: params.ticket.id,
      phase: params.phase,
      outcome: "pass",
      durationMs: performance.now() - tPhase,
      detail: `${diffFiles} file(s), ${diffLines} line(s)`,
    });
    return { ok: true, decomposed: false };
  } catch (err) {
    watchdog.dispose();
    const drift = watchdog.drift ?? (err instanceof DriftDetectedError ? err : null);
    if (drift) {
      const stat = await sandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(
        params.ticket,
        drift,
        stat.stdout.trim(),
        params.cycle,
        params.ctx,
      );
      params.ctx.tracer.recordSpan({
        cycle: params.cycle,
        sliceId: params.ticket.id,
        phase: params.phase,
        outcome: decomposed ? "decomposed" : "escalated",
        durationMs: performance.now() - tPhase,
        detail: drift.message,
      });
      return { ok: false, decomposed };
    }
    params.ctx.tracer.recordSpan({
      cycle: params.cycle,
      sliceId: params.ticket.id,
      phase: params.phase,
      outcome: "fail",
      durationMs: performance.now() - tPhase,
      detail: err instanceof Error ? err.message : String(err),
    });
    throw err;
  } finally {
    watchdog.dispose();
  }
}
