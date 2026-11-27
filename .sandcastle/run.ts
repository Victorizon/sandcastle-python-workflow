/**
 * Deterministic Outer Orchestrator for Matt Pocock's Workflow (Codex + Docker + Python)
 * with Built-In Deterministic Drift Watchdog & 1-Shot Re-Slicer (Decomposer).
 *
 * The LLM NEVER owns the outer loop. TypeScript owns every phase transition and hard cap:
 *   1. Planner (Output.object Zod schema) -> picks unblocked ready-for-agent tickets
 *   2. Bounded-concurrency warm containers (createSandbox):
 *      - DriftWatchdog monitors wall-clock timeout, tool-call thrash, diff blast radius, & context rot
 *      - Implementer (Codex medium, maxIterations=4, cancellable via AbortSignal)
 *      - On drift: kills worker cleanly; if splitDepth < MAX_AUTO_SPLITS (1), wakes fresh Decomposer
 *        to re-slice into 2-3 smaller tickets; otherwise escalates directly to `ready-for-human`
 *      - Hard anti-tampering lock: `python scripts/test_guard.py --base main` (immediate escalation)
 *      - Deterministic 6-gate shell check: `python scripts/check.py` (capped resume-fix max 2)
 *      - Fresh-context Adversarial Reviewer (Codex high + CODING_STANDARDS.md, capped max 2 rounds)
 *   3. Merger (host head mode) -> merges reviewed branches, runs check.py, resolves tickets
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import {
  DriftDetectedError,
  DriftWatchdog,
  parseGitNumstat,
} from "./drift-watchdog.js";

const MODEL = process.env["CODEX_MODEL"] ?? "gpt-5.4";
const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";

// Hard numeric caps — guarantees the pipeline can NEVER enter an endless loop.
const MAX_OUTER_CYCLES = 6;
const MAX_PARALLEL = 2;
const MAX_IMPLEMENT_ITERATIONS = 4;
const MAX_VERIFY_RETRIES = 2;
const MAX_REVIEW_ROUNDS = 2;
const MAX_AUTO_SPLITS = 1;

const PlanSchema = z.object({
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

type PlannedTicket = z.infer<typeof PlanSchema>["tickets"][number];

function preflightChecks(): void {
  if (!process.env["HOME"]) {
    throw new Error(
      "HOME is unset. Run inside WSL2 (recommended) or set HOME=$env:USERPROFILE so Sandcastle SessionStore works.",
    );
  }
  const authPath = path.join(process.env["HOME"], ".codex", "auth.json");
  if (!existsSync(authPath)) {
    throw new Error(`Missing Codex auth file at ${authPath}. Run \`codex login\` in WSL2 first.`);
  }
  try {
    execFileSync("docker", ["info"], { stdio: "ignore" });
  } catch {
    throw new Error("Docker daemon is not reachable. Start Docker Desktop with WSL2 integration.");
  }
}

function makeDocker() {
  return docker({
    imageName: IMAGE_NAME,
    mounts: [
      {
        hostPath: "~/.codex/auth.json",
        sandboxPath: "/home/agent/.codex/auth.json",
        readonly: true,
      },
    ],
  });
}

function isAheadOfHead(branch: string): boolean {
  try {
    const count = execFileSync("git", ["rev-list", "--count", `HEAD..${branch}`], {
      encoding: "utf8",
    });
    return Number(count.trim()) > 0;
  } catch {
    return false;
  }
}

function escalateTicketToHuman(ticketId: string, reason: string): void {
  try {
    execFileSync("python3", ["scripts/local_tracker.py", "comment", ticketId, "--body", reason], {
      stdio: "inherit",
    });
    execFileSync("python3", ["scripts/local_tracker.py", "set-status", ticketId, "ready-for-human"], {
      stdio: "inherit",
    });
  } catch (err) {
    console.error(`Failed to mark ${ticketId} ready-for-human:`, err);
  }
}

function parseVerdict(stdout: string): z.infer<typeof VerdictSchema> | null {
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
): Promise<boolean> {
  console.warn(`  [DRIFT] ${ticket.id}: ${drift.message}`);

  if (ticket.splitDepth >= MAX_AUTO_SPLITS) {
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog stopped ticket (${drift.message}). Already at split depth ${ticket.splitDepth}/${MAX_AUTO_SPLITS} — escalating to human instead of splitting again.`,
    );
    return false;
  }

  console.log(`  [DECOMPOSE] Waking fresh Decomposer to split ${ticket.id} into smaller slices...`);
  try {
    const splitRun = await sandcastle.run({
      sandbox: makeDocker(),
      name: `Decomposer ${ticket.id}`,
      agent: sandcastle.codex(MODEL, {
        effort: "medium",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/decompose-prompt.md",
      promptArgs: {
        TICKET_ID: ticket.id,
        DRIFT_REASON: drift.message,
        PARTIAL_DIFF_STAT: partialDiffStat || "(no committed diff yet)",
      },
      output: Output.object({
        tag: "split",
        schema: SplitPlanSchema,
        maxRetries: 2,
      }),
    });

    execFileSync(
      "python3",
      ["scripts/local_tracker.py", "split", ticket.id, "--plan-json", "-", "--max-depth", String(MAX_AUTO_SPLITS)],
      {
        input: JSON.stringify(splitRun.output),
        stdio: ["pipe", "inherit", "inherit"],
      },
    );
    execFileSync("git", ["add", ".scratch/"], { stdio: "ignore" });
    execFileSync("git", ["commit", "-m", `chore(watchdog): auto-split drifted ticket ${ticket.id}`], {
      stdio: "ignore",
    });
    console.log(`  [DECOMPOSE] Split ${ticket.id} into ${splitRun.output.subtickets.length} smaller sub-ticket(s).`);
    return true;
  } catch (err) {
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog fired (${drift.message}) and Decomposer failed (${err instanceof Error ? err.message : String(err)}).`,
    );
    return false;
  }
}

async function processTicket(ticket: PlannedTicket): Promise<{ approved: boolean; decomposed: boolean }> {
  console.log(`\n--> Starting ${ticket.id} (depth=${ticket.splitDepth}) on branch ${ticket.branch}`);
  mkdirSync(".sandcastle/logs", { recursive: true });
  const safeId = ticket.id.replaceAll(/[^a-z0-9_-]/giu, "-");
  const logPath = `.sandcastle/logs/${safeId}-implement.log`;

  await using sandbox = await sandcastle.createSandbox({
    sandbox: makeDocker(),
    branch: ticket.branch,
  });

  // Step 2a: Implementer supervised by Deterministic Drift Watchdog
  const watchdog = new DriftWatchdog();
  let impl: sandcastle.SandboxRunResult;
  try {
    impl = await sandbox.run({
      name: `Implementer ${ticket.id}`,
      agent: sandcastle.codex(MODEL, {
        effort: "medium",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/implement-prompt.md",
      promptArgs: {
        TICKET_ID: ticket.id,
        TICKET_TITLE: ticket.title,
        BRANCH: ticket.branch,
      },
      maxIterations: MAX_IMPLEMENT_ITERATIONS,
      signal: watchdog.signal,
      logging: {
        type: "file",
        path: logPath,
        onAgentStreamEvent: (ev) => watchdog.onEvent(ev),
      },
    });
  } catch (err) {
    watchdog.dispose();
    const drift =
      watchdog.drift ??
      (err instanceof DriftDetectedError ? err : null);
    if (drift) {
      const stat = await sandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(ticket, drift, stat.stdout.trim());
      return { approved: false, decomposed };
    }
    throw err;
  } finally {
    watchdog.dispose();
  }

  // Step 2b: Post-run deterministic drift inspection (diff blast radius & context rot)
  const numstat = await sandbox.exec("git diff --numstat main..HEAD");
  const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
  const lastCtx = impl.iterations.at(-1)?.contextWindow;
  const postDrift = watchdog.checkPostRun({
    diffFiles,
    diffLines,
    contextTokens: lastCtx?.tokens,
    contextLimit: lastCtx?.limit,
    completed: impl.completionSignal !== undefined,
  });
  if (postDrift) {
    const stat = await sandbox.exec("git diff --stat main..HEAD");
    const decomposed = await handleDriftRemediation(ticket, postDrift, stat.stdout.trim());
    return { approved: false, decomposed };
  }

  // Step 2c: Deterministic shell verification gate (never trust LLM self-report)
  let checkPassed = false;
  for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
    const guardRes = await sandbox.exec("python scripts/test_guard.py --base main");
    if (guardRes.exitCode !== 0) {
      escalateTicketToHuman(
        ticket.id,
        `BLOCKED by strict test lock (\`scripts/test_guard.py\`): agent attempted to delete/weaken existing tests or fixtures.\n\n${guardRes.stdout}`,
      );
      return { approved: false, decomposed: false };
    }

    const checkRes = await sandbox.exec("python scripts/check.py");
    if (checkRes.exitCode === 0) {
      checkPassed = true;
      break;
    }
    if (attempt === MAX_VERIFY_RETRIES) {
      escalateTicketToHuman(
        ticket.id,
        `Deterministic gate \`python scripts/check.py\` still failed after ${MAX_VERIFY_RETRIES} fix resumes. Branch \`${ticket.branch}\` preserved for human inspection.`,
      );
      return { approved: false, decomposed: false };
    }
    console.log(`  [verify retry ${attempt + 1}/${MAX_VERIFY_RETRIES}] resuming implementer...`);
    await impl.resume?.(
      `\`python scripts/check.py\` failed (exit ${checkRes.exitCode}):\n\n${checkRes.stdout}\n${checkRes.stderr}\n\nFix the failures WITHOUT deleting/weakening existing tests or fixtures, re-run \`python scripts/check.py\`, commit your fix, and output <promise>COMPLETE</promise>.`,
    );
  }

  if (!checkPassed || !isAheadOfHead(ticket.branch)) {
    return { approved: false, decomposed: false };
  }

  // Step 2d: Fresh-context Adversarial Reviewer (high effort + CODING_STANDARDS.md, capped rounds)
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    const review = await sandbox.run({
      name: `Reviewer ${ticket.id} (round ${round}/${MAX_REVIEW_ROUNDS})`,
      agent: sandcastle.codex(MODEL, {
        effort: "high",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/review-prompt.md",
      promptArgs: {
        TICKET_ID: ticket.id,
        TICKET_TITLE: ticket.title,
        BRANCH: ticket.branch,
      },
      maxIterations: 1,
    });

    const postReviewCheck = await sandbox.exec("python scripts/check.py");
    const verdict = parseVerdict(review.stdout);

    if (postReviewCheck.exitCode === 0 && verdict?.approved) {
      console.log(`  [PASS] Reviewer approved ${ticket.id}: ${verdict.summary}`);
      return { approved: true, decomposed: false };
    }

    if (round === MAX_REVIEW_ROUNDS) {
      const reasons =
        verdict?.blockingIssues.join("; ") || "Reviewer did not approve or check.py failed.";
      escalateTicketToHuman(
        ticket.id,
        `Stopped at max review rounds (${MAX_REVIEW_ROUNDS}). Blocking findings: ${reasons}. Branch \`${ticket.branch}\` preserved.`,
      );
      return { approved: false, decomposed: false };
    }

    const feedback = verdict?.blockingIssues.join("\n- ") || postReviewCheck.stdout;
    await impl.resume?.(
      `Adversarial reviewer raised blocking issues:\n- ${feedback}\n\nAddress each issue WITHOUT weakening existing tests, run \`python scripts/check.py\`, commit, and output <promise>COMPLETE</promise>.`,
    );
  }

  return { approved: false, decomposed: false };
}

async function main(): Promise<void> {
  preflightChecks();

  for (let cycle = 1; cycle <= MAX_OUTER_CYCLES; cycle++) {
    console.log(`\n=== Sandcastle Outer Cycle ${cycle}/${MAX_OUTER_CYCLES} ===`);

    const planRun = await sandcastle.run({
      sandbox: makeDocker(),
      name: "Planner",
      agent: sandcastle.codex(MODEL, {
        effort: "medium",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/plan-prompt.md",
      output: Output.object({
        tag: "plan",
        schema: PlanSchema,
        maxRetries: 2,
      }),
    });

    const { tickets } = planRun.output;
    if (tickets.length === 0) {
      console.log("No unblocked `ready-for-agent` tickets remaining. Factory complete.");
      break;
    }

    console.log(`Planned ${tickets.length} unblocked ticket(s):`);
    for (const t of tickets) {
      console.log(`  - ${t.id} (depth=${t.splitDepth}): ${t.title} -> ${t.branch}`);
    }

    let active = 0;
    const queue: (() => void)[] = [];
    const acquire = async () =>
      active < MAX_PARALLEL
        ? (active++, Promise.resolve())
        : new Promise<void>((resolve) => queue.push(resolve));
    const release = () => {
      active--;
      const next = queue.shift();
      if (next) {
        active++;
        next();
      }
    };

    const outcomes = await Promise.allSettled(
      tickets.map(async (ticket) => {
        await acquire();
        try {
          return await processTicket(ticket);
        } finally {
          release();
        }
      }),
    );

    const readyToMerge = tickets.filter((t, idx) => {
      const outcome = outcomes[idx];
      return outcome?.status === "fulfilled" && outcome.value.approved && isAheadOfHead(t.branch);
    });
    const anyDecomposed = outcomes.some(
      (o) => o.status === "fulfilled" && o.value.decomposed,
    );

    if (readyToMerge.length === 0) {
      if (anyDecomposed) {
        console.log("Drifted ticket(s) auto-split into smaller sub-tickets. Continuing to next cycle.");
        continue;
      }
      console.log("No approved branches ready to merge this cycle. Stopping cleanly.");
      break;
    }

    await sandcastle.run({
      sandbox: makeDocker(),
      name: "Merger",
      branchStrategy: { type: "head" },
      maxIterations: 4,
      agent: sandcastle.codex(MODEL, {
        effort: "medium",
        approvalsReviewer: "auto_review",
        captureSessions: true,
      }),
      promptFile: "./.sandcastle/merge-prompt.md",
      promptArgs: {
        BRANCHES: readyToMerge.map((t) => `- ${t.branch}`).join("\n"),
        TICKETS: readyToMerge.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
      },
    });
  }
}

await main();
