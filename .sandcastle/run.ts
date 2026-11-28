/**
 * Deterministic Outer Orchestrator for Matt Pocock's Workflow (Codex + Docker + Python).
 * Thin coordinator delegating single-slice execution to `slice-runner.ts`
 * and batch merge/verification/reporting to `merge-gate.ts`.
 */

import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { createAgent, createDockerSandbox, resolveAgentKind } from "./agent-factory.js";
import { PMDashboard } from "./dashboard.js";
import { RunTracer } from "./diagnostics.js";
import { parsePositiveEnvNumber } from "./drift-watchdog.js";
import { finalizeFactoryReport, mergeAndVerifyBatch } from "./merge-gate.js";
import {
  REPO_MUTATION_LOCK,
  type TrackerTicketSnapshot,
  acquireRunLock,
  assertCleanGitWorktree,
  validatePlannedTicketsAgainstTracker,
} from "./preflight.js";
import { installGracefulShutdown, normalizeRepoCwd, resolvePythonBin, withTransientRetry } from "./resilience.js";
import {
  PlanSchema,
  type SliceRuntimeContext,
  escalateTicketToHuman,
  isAheadOfHead,
} from "./slice-container.js";
import { processTicket } from "./slice-runner.js";

// `npm --prefix .sandcastle run factory` sets cwd to `.sandcastle/`; normalize to repo root.
if (path.basename(process.cwd()) === ".sandcastle") {
  process.chdir(path.resolve(process.cwd(), ".."));
}

const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";
normalizeRepoCwd();
const PYTHON_BIN = resolvePythonBin();
const MAX_OUTER_CYCLES = Math.min(100, Math.floor(parsePositiveEnvNumber(process.env["SANDCASTLE_MAX_CYCLES"], 6)));
const MAX_PARALLEL = 2;

function preflightChecks(): void {
  if (!process.env["HOME"]) {
    throw new Error(
      "HOME is unset. Run inside WSL2 (recommended) or set HOME=$env:USERPROFILE so Sandcastle SessionStore works.",
    );
  }
  const agentKind = resolveAgentKind();
  if (agentKind === "claude") {
    const claudeCreds = path.join(process.env["HOME"], ".claude", ".credentials.json");
    if (!existsSync(claudeCreds) && !process.env["CLAUDE_CODE_OAUTH_TOKEN"] && !existsSync(".sandcastle/.env")) {
      throw new Error(
        `Missing Claude credentials at ${claudeCreds} (or CLAUDE_CODE_OAUTH_TOKEN in .sandcastle/.env).`,
      );
    }
  } else {
    const authPath = path.join(process.env["HOME"], ".codex", "auth.json");
    if (!existsSync(authPath)) {
      throw new Error(`Missing Codex auth file at ${authPath}. Run \`codex login\` in WSL2 first.`);
    }
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("Docker daemon is not reachable. Start Docker Desktop with WSL2 integration.");
  }
  assertCleanGitWorktree();
  try {
    execFileSync(PYTHON_BIN, ["scripts/local_tracker.py", "check-cycles"], { stdio: "pipe" });
  } catch (err) {
    const e = err as { stderr?: Buffer | string };
    throw new Error(`Ticket dependency cycle detected:\n${String(e.stderr ?? "")}`);
  }
}

function loadLiveTrackerReadyTickets(): TrackerTicketSnapshot[] {
  const out = execFileSync(
    PYTHON_BIN,
    ["scripts/local_tracker.py", "list", "--status", "ready-for-agent", "--json"],
    { encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
  );
  return JSON.parse(out) as TrackerTicketSnapshot[];
}

async function runWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  worker: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> {
  let active = 0;
  const queue: (() => void)[] = [];
  const acquire = async () =>
    active < limit ? (active++, Promise.resolve()) : new Promise<void>((resolve) => queue.push(resolve));
  const release = () => {
    active--;
    const next = queue.shift();
    if (next) {
      active++;
      next();
    }
  };
  return Promise.allSettled(
    items.map(async (item) => {
      await acquire();
      try {
        return await worker(item);
      } finally {
        release();
      }
    }),
  );
}

async function main(): Promise<void> {
  preflightChecks();
  const releaseLock = acquireRunLock(REPO_MUTATION_LOCK, "factory");
  const tracer = new RunTracer();
  const dashboard = new PMDashboard({ mode: "factory", dockerImage: IMAGE_NAME, maxCycles: MAX_OUTER_CYCLES });
  const ctx: SliceRuntimeContext = { imageName: IMAGE_NAME, pythonBin: PYTHON_BIN, dashboard, tracer };
  const dashUrl = await dashboard.start();
  console.log(`\nPM Mission Control Dashboard LIVE at: ${dashUrl}\n`);
  const uninstallShutdown = installGracefulShutdown(async () => {
    await dashboard.close();
    releaseLock();
  });

  try {
    for (let cycle = 1; cycle <= MAX_OUTER_CYCLES; cycle++) {
      dashboard.setCycle(cycle, `Cycle ${cycle}/${MAX_OUTER_CYCLES}: Planner analyzing unblocked slices...`);

      const tPlan = performance.now();
      const planRun = await withTransientRetry(
        () =>
          sandcastle.run({
            sandbox: createDockerSandbox(IMAGE_NAME),
            name: "Planner",
            agent: createAgent("medium"),
            logging: tracer.sandboxLogging(cycle, "planner"),
            promptFile: "./.sandcastle/plan-prompt.md",
            output: Output.object({ tag: "plan", schema: PlanSchema, maxRetries: 2 }),
          }),
        { label: `Planner cycle ${cycle}` },
      );
      const { valid: tickets, droppedReasons } = validatePlannedTicketsAgainstTracker(
        planRun.output.tickets,
        loadLiveTrackerReadyTickets(),
      );
      tracer.recordSpan({
        cycle,
        phase: "planner",
        outcome: droppedReasons.length ? "fail" : "pass",
        durationMs: performance.now() - tPlan,
        detail: `picked=${tickets.length} dropped=${droppedReasons.length}${droppedReasons.length ? ` (${droppedReasons.join("; ")})` : ""}`,
      });
      if (droppedReasons.length > 0) {
        console.warn("  [PREFLIGHT] Dropped invalid Planner selections:", droppedReasons.join("; "));
      }
      if (tickets.length === 0) {
        dashboard.setRunStatus("complete", "All planned slices complete — no ready-for-agent work remaining.");
        break;
      }

      for (const t of tickets) {
        dashboard.upsertSlice(t.id, {
          title: t.title,
          branch: t.branch,
          splitDepth: t.splitDepth,
          stage: "queued",
          pmSummary: "Scheduled by Planner — waiting for worker container slot.",
        });
      }
      dashboard.setCycle(cycle, `Running ${tickets.length} unblocked slice(s) in isolated Docker containers...`);

      const outcomes = await runWithConcurrency(tickets, MAX_PARALLEL, (ticket) =>
        processTicket(ticket, cycle, ctx),
      );
      outcomes.forEach((outcome, idx) => {
        if (outcome.status === "rejected" && tickets[idx]) {
          const reason = outcome.reason instanceof Error ? outcome.reason.message : String(outcome.reason);
          console.error(`  [CRASH] Worker failed for ${tickets[idx].id}: ${reason}`);
          escalateTicketToHuman(tickets[idx].id, `Worker crashed unexpectedly: ${reason}`, dashboard, PYTHON_BIN);
        }
      });

      const readyToMerge = tickets.filter((t, idx) => {
        const outcome = outcomes[idx];
        return outcome?.status === "fulfilled" && outcome.value.approved && isAheadOfHead(t.branch);
      });
      const anyDecomposed = outcomes.some((o) => o.status === "fulfilled" && o.value.decomposed);

      if (readyToMerge.length === 0) {
        if (anyDecomposed) continue;
        dashboard.setRunStatus("blocked", "Cycle stopped — remaining slices escalated for human review.");
        break;
      }

      const mergedOk = await mergeAndVerifyBatch(readyToMerge, cycle, ctx);
      if (!mergedOk) break;
    }
  } finally {
    finalizeFactoryReport(dashboard);
    uninstallShutdown();
    await dashboard.close();
    releaseLock();
  }
}

await main();
