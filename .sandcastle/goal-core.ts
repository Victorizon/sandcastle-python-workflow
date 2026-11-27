/**
 * Pure, unit-testable core for Level 2 Goal-Driven Autonomy (`.sandcastle/goal-core.ts`).
 *
 * Evaluates machine-verifiable Goal Contracts deterministically (shell exit codes + tracker state),
 * enforces configurable wall-clock & stall circuit breakers (0 = unlimited time), and writes
 * verifiable Goal Receipts.
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";

export const GoalContractSchema = z.object({
  name: z.string().min(1),
  slug: z.string().regex(/^[a-z0-9-]+$/u),
  /** Optional frozen `/grill-me` Spec Contract markdown file with REQ-*, INV-*, OUT-* items. */
  specFile: z.string().min(1).optional(),
  requireAllTicketsResolved: z.boolean().default(true),
  verifyCommands: z.array(z.string().min(1)).min(1),
  /** Maximum total wall-clock minutes. Set to 0 for unlimited wall-clock time. */
  maxTotalMinutes: z.number().min(0).default(180),
  maxStalledCycles: z.number().int().min(1).default(2),
  maxGapPlanRounds: z.number().int().min(0).default(2),
});

export type GoalContract = z.infer<typeof GoalContractSchema>;

export const GapPlanSchema = z.object({
  diagnosis: z.string().min(1),
  tickets: z
    .array(
      z.object({
        title: z.string().min(1),
        what_to_build: z.string().min(1),
        acceptance_criteria: z.array(z.string().min(1)).min(1),
      }),
    )
    .min(1)
    .max(2),
});

export type GapPlan = z.infer<typeof GapPlanSchema>;

export interface CommandCheckResult {
  readonly command: string;
  readonly passed: boolean;
  readonly exitCode: number;
  readonly outputTail: string;
}

export interface GoalEvaluation {
  readonly met: boolean;
  readonly openReadyTickets: number;
  readonly openHumanTickets: number;
  readonly commandResults: readonly CommandCheckResult[];
}

export interface GoalReceipt {
  readonly goalName: string;
  readonly slug: string;
  readonly status: "GOAL_MET" | "STOPPED_CIRCUIT_BREAKER";
  readonly reason: string;
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly elapsedMinutes: number;
  readonly cyclesRun: number;
  readonly gapPlanRoundsUsed: number;
  readonly headCommit: string;
  readonly lastEvaluation: GoalEvaluation;
  readonly confidence?: {
    readonly score: number;
    readonly badge: string;
    readonly reasons: readonly string[];
    readonly specVerified?: string;
  };
}

export function loadGoalContract(filePath: string, overrideMaxMinutes?: number): GoalContract {
  const raw = JSON.parse(readFileSync(filePath, "utf8")) as unknown;
  const parsed = GoalContractSchema.parse(raw);
  if (overrideMaxMinutes !== undefined && Number.isFinite(overrideMaxMinutes) && overrideMaxMinutes >= 0) {
    return { ...parsed, maxTotalMinutes: overrideMaxMinutes };
  }
  return parsed;
}

export function parseGoalCliArgs(argv: readonly string[]): {
  readonly goalFile: string;
  readonly maxMinutes?: number;
} {
  let goalFile = ".sandcastle/goal.json";
  let maxMinutes: number | undefined;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if ((arg === "--goal" || arg === "-g") && next) {
      goalFile = next;
      i += 1;
    } else if (arg === "--max-minutes" && next) {
      maxMinutes = Number(next);
      i += 1;
    }
  }
  if (maxMinutes === undefined && process.env["GOAL_MAX_MINUTES"] !== undefined) {
    maxMinutes = Number(process.env["GOAL_MAX_MINUTES"]);
  }
  return { goalFile, maxMinutes };
}

export function checkCircuitBreaker(params: {
  readonly elapsedMinutes: number;
  readonly maxTotalMinutes: number;
  readonly stalledCycles: number;
  readonly maxStalledCycles: number;
  readonly openReadyTickets: number;
  readonly openHumanTickets: number;
}): string | null {
  if (params.maxTotalMinutes > 0 && params.elapsedMinutes >= params.maxTotalMinutes) {
    return `Wall-clock budget reached (${params.elapsedMinutes.toFixed(1)}m >= ${params.maxTotalMinutes}m).`;
  }
  if (params.stalledCycles >= params.maxStalledCycles) {
    return `Zero-progress stall breaker triggered (${params.stalledCycles} consecutive stalled cycles).`;
  }
  if (params.openReadyTickets === 0 && params.openHumanTickets > 0) {
    return `Remaining frontier is blocked by ${params.openHumanTickets} ready-for-human ticket(s).`;
  }
  return null;
}

export function runVerifyCommand(command: string, cwd = process.cwd()): CommandCheckResult {
  try {
    const out = execFileSync(command, {
      cwd,
      shell: true,
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return {
      command,
      passed: true,
      exitCode: 0,
      outputTail: out.trim().slice(-600),
    };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    const combined = `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim();
    return {
      command,
      passed: false,
      exitCode: e.status ?? 1,
      outputTail: combined.slice(-900),
    };
  }
}

const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

export function countLocalTicketsByStatus(status: string, cwd = process.cwd()): number {
  try {
    const out = execFileSync(
      PYTHON_BIN,
      ["scripts/local_tracker.py", "list", "--status", status, "--json"],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const items = JSON.parse(out) as unknown[];
    return Array.isArray(items) ? items.length : 0;
  } catch {
    return 0;
  }
}

export function evaluateGoalContract(contract: GoalContract, cwd = process.cwd()): GoalEvaluation {
  const openReadyTickets = countLocalTicketsByStatus("ready-for-agent", cwd);
  const openHumanTickets = countLocalTicketsByStatus("ready-for-human", cwd);
  const commandResults = contract.verifyCommands.map((cmd) => runVerifyCommand(cmd, cwd));
  const allCommandsPassed = commandResults.every((r) => r.passed);
  const ticketsSatisfied = !contract.requireAllTicketsResolved || (openReadyTickets === 0 && openHumanTickets === 0);

  return {
    met: allCommandsPassed && ticketsSatisfied,
    openReadyTickets,
    openHumanTickets,
    commandResults,
  };
}

export function writeGoalReceipt(
  receipt: GoalReceipt,
  logsDir = path.join(".sandcastle", "logs"),
): string {
  mkdirSync(logsDir, { recursive: true });
  const filePath = path.join(logsDir, `goal-receipt-${receipt.slug}.json`);
  writeFileSync(filePath, JSON.stringify(receipt, null, 2) + "\n", "utf8");
  return filePath;
}
