/**
 * Deterministic Outer Orchestrator for Matt Pocock's Workflow (Codex + Docker + Python)
 * with Built-In Deterministic Drift Watchdog, 1-Shot Re-Slicer, and Live PM Mission Control Dashboard.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import {
  PMDashboard,
  parseCheckMetrics,
  summarizeAgentEventForPm,
} from "./dashboard.js";
import { createAgent, createDockerSandbox, resolveAgentKind } from "./agent-factory.js";
import { formatEndOfRunFooter } from "./coach.js";
import {
  computeAgentTrustScore,
  loadHumanRatings,
  scoreFactoryRunConfidence,
} from "./confidence.js";
import { writePmHtmlReport } from "./pm-report.js";
import { loadVerifiedRunHistory, recordFactoryRun } from "./run-history.js";
import {
  DriftDetectedError,
  DriftWatchdog,
  parseGitNumstat,
} from "./drift-watchdog.js";
import {
  type TrackerTicketSnapshot,
  acquireRunLock,
  assertCleanGitWorktree,
  validatePlannedTicketsAgainstTracker,
} from "./preflight.js";

const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";
const PYTHON_BIN = process.platform === "win32" ? "python" : "python3";

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

function makeDocker() {
  return createDockerSandbox(IMAGE_NAME);
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

function escalateTicketToHuman(ticketId: string, reason: string, dashboard: PMDashboard): void {
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
    execFileSync(PYTHON_BIN, ["scripts/local_tracker.py", "comment", ticketId, "--body", reason], {
      stdio: "inherit",
    });
    execFileSync(PYTHON_BIN, ["scripts/local_tracker.py", "set-status", ticketId, "ready-for-human"], {
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
  dashboard: PMDashboard,
): Promise<boolean> {
  console.warn(`  [DRIFT] ${ticket.id}: ${drift.message}`);

  if (ticket.splitDepth >= MAX_AUTO_SPLITS) {
    dashboard.recordChallenge(ticket.id, {
      source: "drift_watchdog",
      finding: `${drift.message} (max split depth ${MAX_AUTO_SPLITS} reached)`,
      outcome: "escalated",
    });
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog stopped ticket (${drift.message}). Already at split depth ${ticket.splitDepth}/${MAX_AUTO_SPLITS}.`,
      dashboard,
    );
    return false;
  }

  dashboard.recordChallenge(ticket.id, {
    source: "drift_watchdog",
    finding: `${drift.message} — waking Decomposer to split into smaller slices.`,
    outcome: "split",
  });
  dashboard.upsertSlice(ticket.id, {
    stage: "remediating",
    pmSummary: "Stopped by Drift Watchdog — Decomposer breaking ticket into 2–3 smaller vertical slices.",
  });

  try {
    const splitRun = await sandcastle.run({
      sandbox: makeDocker(),
      name: `Decomposer ${ticket.id}`,
      agent: createAgent("medium"),
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
      PYTHON_BIN,
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
    try {
      execFileSync("git", ["branch", "-D", ticket.branch], { stdio: "ignore" });
    } catch {
      // Branch may not exist yet if drift occurred before first commit
    }

    dashboard.upsertSlice(ticket.id, {
      stage: "split",
      pmSummary: `Auto-split into ${splitRun.output.subtickets.length} smaller sub-slices after drift detection.`,
    });
    dashboard.addEvent({
      sliceId: ticket.id,
      level: "challenge",
      headline: `DriftWatchdog auto-split oversized ticket into ${splitRun.output.subtickets.length} slices`,
      detail: drift.message,
    });
    return true;
  } catch (err) {
    escalateTicketToHuman(
      ticket.id,
      `Drift Watchdog fired (${drift.message}) and Decomposer failed (${err instanceof Error ? err.message : String(err)}).`,
      dashboard,
    );
    return false;
  }
}

async function runFreshFixContainer(params: {
  readonly ticket: PlannedTicket;
  readonly source: string;
  readonly details: string;
  readonly dashboard: PMDashboard;
  readonly startedAtMs: number;
  readonly logPath: string;
}): Promise<{ readonly ok: boolean; readonly decomposed: boolean }> {
  await using fixSandbox = await sandcastle.createSandbox({
    sandbox: makeDocker(),
    branch: params.ticket.branch,
  });
  const watchdog = new DriftWatchdog();
  try {
    const fixRun = await fixSandbox.run({
      name: `Fixer ${params.ticket.id}`,
      agent: createAgent("medium"),
      promptFile: "./.sandcastle/fix-prompt.md",
      promptArgs: {
        TICKET_ID: params.ticket.id,
        TICKET_TITLE: params.ticket.title,
        BRANCH: params.ticket.branch,
        FAILURE_SOURCE: params.source,
        FAILURE_DETAILS: params.details,
      },
      maxIterations: MAX_IMPLEMENT_ITERATIONS,
      signal: watchdog.signal,
      logging: {
        type: "file",
        path: params.logPath,
        onAgentStreamEvent: (ev) => {
          watchdog.onEvent(ev);
          const pmNote = summarizeAgentEventForPm(ev);
          if (pmNote) {
            params.dashboard.upsertSlice(params.ticket.id, {
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

    const numstat = await fixSandbox.exec("git diff --numstat main..HEAD");
    const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
    const lastCtx = fixRun.iterations.at(-1)?.contextWindow;
    const postDrift = watchdog.checkPostRun({
      diffFiles,
      diffLines,
      contextTokens: lastCtx?.tokens,
      contextLimit: lastCtx?.limit,
      completed: fixRun.completionSignal !== undefined,
    });
    if (postDrift) {
      const stat = await fixSandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(
        params.ticket,
        postDrift,
        stat.stdout.trim(),
        params.dashboard,
      );
      return { ok: false, decomposed };
    }
    return { ok: true, decomposed: false };
  } catch (err) {
    watchdog.dispose();
    const drift = watchdog.drift ?? (err instanceof DriftDetectedError ? err : null);
    if (drift) {
      const stat = await fixSandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(
        params.ticket,
        drift,
        stat.stdout.trim(),
        params.dashboard,
      );
      return { ok: false, decomposed };
    }
    throw err;
  } finally {
    watchdog.dispose();
  }
}

async function processTicket(
  ticket: PlannedTicket,
  dashboard: PMDashboard,
): Promise<{ approved: boolean; decomposed: boolean }> {
  const startedAtMs = Date.now();
  mkdirSync(".sandcastle/logs", { recursive: true });
  const safeId = ticket.id.replaceAll(/[^a-z0-9_-]/giu, "-");
  const logPath = `.sandcastle/logs/${safeId}-implement.log`;

  dashboard.upsertSlice(ticket.id, {
    title: ticket.title,
    branch: ticket.branch,
    splitDepth: ticket.splitDepth,
    stage: "implementing",
    pmSummary: "Booting isolated Builder container & starting TDD implementation...",
  });

  // Phase A: Isolated Builder container (disposed immediately once commit or drift finishes)
  let impl: sandcastle.SandboxRunResult;
  {
    await using builderSandbox = await sandcastle.createSandbox({
      sandbox: makeDocker(),
      branch: ticket.branch,
    });

    const watchdog = new DriftWatchdog();
    try {
      impl = await builderSandbox.run({
        name: `Implementer ${ticket.id}`,
        agent: createAgent("medium"),
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
          onAgentStreamEvent: (ev) => {
            watchdog.onEvent(ev);
            const pmNote = summarizeAgentEventForPm(ev);
            if (pmNote) {
              dashboard.upsertSlice(ticket.id, {
                pmSummary: pmNote,
                watchdog: {
                  elapsedSec: Math.round((Date.now() - startedAtMs) / 1000),
                  toolCalls: watchdog.toolCallCount,
                },
              });
            }
          },
        },
      });
    } catch (err) {
      watchdog.dispose();
      const drift = watchdog.drift ?? (err instanceof DriftDetectedError ? err : null);
      if (drift) {
        const stat = await builderSandbox.exec("git diff --stat main..HEAD");
        const decomposed = await handleDriftRemediation(ticket, drift, stat.stdout.trim(), dashboard);
        return { approved: false, decomposed };
      }
      throw err;
    } finally {
      watchdog.dispose();
    }

    const numstat = await builderSandbox.exec("git diff --numstat main..HEAD");
    const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
    const lastCtx = impl.iterations.at(-1)?.contextWindow;
    const ctxPct =
      lastCtx?.limit && lastCtx.limit > 0 ? Math.round((lastCtx.tokens / lastCtx.limit) * 100) : 0;
    dashboard.upsertSlice(ticket.id, {
      watchdog: {
        elapsedSec: Math.round((Date.now() - startedAtMs) / 1000),
        toolCalls: watchdog.toolCallCount,
        diffLines,
        contextPercent: ctxPct,
      },
    });

    const postDrift = watchdog.checkPostRun({
      diffFiles,
      diffLines,
      contextTokens: lastCtx?.tokens,
      contextLimit: lastCtx?.limit,
      completed: impl.completionSignal !== undefined,
    });
    if (postDrift) {
      const stat = await builderSandbox.exec("git diff --stat main..HEAD");
      const decomposed = await handleDriftRemediation(ticket, postDrift, stat.stdout.trim(), dashboard);
      return { approved: false, decomposed };
    }
  }

  // Phase B: Fresh, zero-trust Verifier container per attempt (read-only /opt/venv)
  let checkPassed = false;
  let tamperStrikes = 0;
  for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
    dashboard.upsertSlice(ticket.id, {
      stage: "verifying",
      pmSummary: `Fresh Verifier container running 6 mechanical checks (attempt ${attempt + 1}/${MAX_VERIFY_RETRIES + 1})...`,
    });

    let guardExit = 0;
    let guardOut = "";
    let checkExit = 0;
    let checkOut = "";
    {
      await using verifySandbox = await sandcastle.createSandbox({
        sandbox: makeDocker(),
        branch: ticket.branch,
      });
      const guardRes = await verifySandbox.exec("python scripts/test_guard.py --base main");
      guardExit = guardRes.exitCode;
      guardOut = guardRes.stdout;
      if (guardExit === 0) {
        const checkRes = await verifySandbox.exec("python scripts/check.py");
        checkExit = checkRes.exitCode;
        checkOut = `${checkRes.stdout}\n${checkRes.stderr}`.trim();
      }
    }

    if (guardExit !== 0) {
      tamperStrikes += 1;
      dashboard.recordChallenge(ticket.id, {
        source: "test_guard",
        finding: `Blocked test/fixture/harness tampering (strike ${tamperStrikes}/2).`,
        outcome: tamperStrikes >= 2 || attempt === MAX_VERIFY_RETRIES ? "blocked" : "fixed",
      });
      if (tamperStrikes >= 2 || attempt === MAX_VERIFY_RETRIES) {
        escalateTicketToHuman(
          ticket.id,
          `BLOCKED by strict test/harness lock (\`scripts/test_guard.py\`, strike ${tamperStrikes}):\n\n${guardOut}`,
          dashboard,
        );
        return { approved: false, decomposed: false };
      }
      dashboard.upsertSlice(ticket.id, {
        stage: "remediating",
        pmSummary:
          "Test Guard caught unauthorized test/harness edit (strike 1/2) — booting fresh Fixer to restore locked files & fix properly...",
      });
      const fixRes = await runFreshFixContainer({
        ticket,
        source: "scripts/test_guard.py (anti-tamper lock)",
        details: guardOut,
        dashboard,
        startedAtMs,
        logPath,
      });
      if (!fixRes.ok) {
        return { approved: false, decomposed: fixRes.decomposed };
      }
      continue;
    }

    if (checkExit === 0) {
      const q = parseCheckMetrics(checkOut);
      dashboard.recordQualityMetrics(q.coveragePercent, q.mutationScore);
      checkPassed = true;
      break;
    }
    if (attempt === MAX_VERIFY_RETRIES) {
      escalateTicketToHuman(
        ticket.id,
        `Deterministic gate \`python scripts/check.py\` still failed after ${MAX_VERIFY_RETRIES} fresh Fixer rounds.`,
        dashboard,
      );
      return { approved: false, decomposed: false };
    }
    dashboard.upsertSlice(ticket.id, {
      stage: "remediating",
      pmSummary: `6-gate check failed — booting fresh Fixer container (attempt ${attempt + 1}/${MAX_VERIFY_RETRIES})...`,
    });
    const fixRes = await runFreshFixContainer({
      ticket,
      source: "python scripts/check.py (6-gate verification)",
      details: checkOut.slice(-4000),
      dashboard,
      startedAtMs,
      logPath,
    });
    if (!fixRes.ok) {
      return { approved: false, decomposed: fixRes.decomposed };
    }
  }

  if (!checkPassed || !isAheadOfHead(ticket.branch)) {
    return { approved: false, decomposed: false };
  }

  // Phase C: Fresh-context Adversarial Reviewer in a clean container per round
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    dashboard.upsertSlice(ticket.id, {
      stage: "reviewing",
      pmSummary: `Fresh Adversarial Reviewer checking diff against spec & CODING_STANDARDS.md (round ${round}/${MAX_REVIEW_ROUNDS})...`,
    });

    let reviewStdout = "";
    let postCheckExit = 1;
    let postCheckOut = "";
    {
      await using reviewSandbox = await sandcastle.createSandbox({
        sandbox: makeDocker(),
        branch: ticket.branch,
      });
      const review = await reviewSandbox.run({
        name: `Reviewer ${ticket.id} (round ${round}/${MAX_REVIEW_ROUNDS})`,
        agent: createAgent("high"),
        promptFile: "./.sandcastle/review-prompt.md",
        promptArgs: {
          TICKET_ID: ticket.id,
          TICKET_TITLE: ticket.title,
          BRANCH: ticket.branch,
        },
        maxIterations: 1,
      });
      reviewStdout = review.stdout;
      const postReviewCheck = await reviewSandbox.exec("python scripts/check.py");
      postCheckExit = postReviewCheck.exitCode;
      postCheckOut = `${postReviewCheck.stdout}\n${postReviewCheck.stderr}`.trim();
    }

    const verdict = parseVerdict(reviewStdout);
    if (postCheckExit === 0 && verdict?.approved) {
      const q = parseCheckMetrics(postCheckOut);
      dashboard.recordQualityMetrics(q.coveragePercent, q.mutationScore);
      dashboard.upsertSlice(ticket.id, {
        stage: "merging",
        pmSummary: `Approved by Fresh Reviewer: ${verdict.summary}`,
      });
      dashboard.addEvent({
        sliceId: ticket.id,
        level: "success",
        headline: "Passed 6 gates & Fresh Adversarial Review",
        detail: verdict.summary,
      });
      return { approved: true, decomposed: false };
    }

    const findingText =
      verdict?.blockingIssues.join("; ") || "Reviewer raised blocking findings or check.py failed.";
    if (round === MAX_REVIEW_ROUNDS) {
      dashboard.recordChallenge(ticket.id, {
        source: "reviewer",
        finding: findingText,
        outcome: "escalated",
      });
      escalateTicketToHuman(
        ticket.id,
        `Stopped at max review rounds (${MAX_REVIEW_ROUNDS}). Blocking findings: ${findingText}`,
        dashboard,
      );
      return { approved: false, decomposed: false };
    }

    dashboard.recordChallenge(ticket.id, {
      source: "reviewer",
      finding: findingText,
      outcome: "fixed",
    });
    dashboard.addEvent({
      sliceId: ticket.id,
      level: "challenge",
      headline: `Adversarial Reviewer challenged diff (round ${round})`,
      detail: findingText,
    });
    dashboard.upsertSlice(ticket.id, {
      stage: "remediating",
      pmSummary: `Adversarial Reviewer caught blocking findings — booting fresh Fixer container...`,
    });

    const feedback = verdict?.blockingIssues.join("\n- ") || postCheckOut.slice(-3000);
    const fixRes = await runFreshFixContainer({
      ticket,
      source: `Adversarial Reviewer (round ${round})`,
      details: `- ${feedback}`,
      dashboard,
      startedAtMs,
      logPath,
    });
    if (!fixRes.ok) {
      return { approved: false, decomposed: fixRes.decomposed };
    }
  }

  return { approved: false, decomposed: false };
}

async function main(): Promise<void> {
  preflightChecks();
  const releaseLock = acquireRunLock(".run.lock", "factory");

  const dashboard = new PMDashboard({
    mode: "factory",
    dockerImage: IMAGE_NAME,
    maxCycles: MAX_OUTER_CYCLES,
  });
  const dashUrl = await dashboard.start();
  console.log(`\nPM Mission Control Dashboard LIVE at: ${dashUrl}\n`);

  try {
    for (let cycle = 1; cycle <= MAX_OUTER_CYCLES; cycle++) {
      dashboard.setCycle(cycle, `Cycle ${cycle}/${MAX_OUTER_CYCLES}: Planner analyzing unblocked slices...`);

      const planRun = await sandcastle.run({
        sandbox: makeDocker(),
        name: "Planner",
        agent: createAgent("medium"),
        promptFile: "./.sandcastle/plan-prompt.md",
        output: Output.object({
          tag: "plan",
          schema: PlanSchema,
          maxRetries: 2,
        }),
      });

      const liveTrackerTickets = loadLiveTrackerReadyTickets();
      const { valid: tickets, droppedReasons } = validatePlannedTicketsAgainstTracker(
        planRun.output.tickets,
        liveTrackerTickets,
      );
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
            return await processTicket(ticket, dashboard);
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
          continue;
        }
        dashboard.setRunStatus("blocked", "Cycle stopped — remaining slices escalated for human review.");
        break;
      }

      const preMergeSha = execFileSync("git", ["rev-parse", "HEAD"], { encoding: "utf8" }).trim();
      dashboard.setCycle(cycle, `Merger combining ${readyToMerge.length} approved branch(es) into main...`);
      await sandcastle.run({
        sandbox: makeDocker(),
        name: "Merger",
        branchStrategy: { type: "head" },
        maxIterations: 4,
        agent: createAgent("medium"),
        promptFile: "./.sandcastle/merge-prompt.md",
        promptArgs: {
          BRANCHES: readyToMerge.map((t) => `- ${t.branch}`).join("\n"),
          TICKETS: readyToMerge.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
        },
      });

      // Deterministic host-side verification after Merger + optional multi-branch cross-slice audit
      let hostCheckPassed = true;
      try {
        execFileSync(PYTHON_BIN, ["scripts/check.py"], { stdio: "inherit" });
      } catch {
        hostCheckPassed = false;
      }

      let multiMergeConflictIssue: string | null = null;
      if (hostCheckPassed && readyToMerge.length >= 2) {
        const mergeReview = await sandcastle.run({
          sandbox: makeDocker(),
          name: "Post-Merge Cross-Slice Auditor",
          agent: createAgent("high"),
          prompt: [
            `Inspect the combined multi-branch merge diff (\`git diff ${preMergeSha}..HEAD\`) for tickets:`,
            ...readyToMerge.map((t) => `- ${t.id}: ${t.title}`),
            `Check ONLY whether merging these branches dropped, contradicted, or weakened any behavior from either ticket.`,
            `Do NOT edit files. Output JSON inside <verdict> tags: {"approved": true|false, "severity": "none"|"minor"|"blocking", "summary": "...", "blockingIssues": []}`,
            `Then output <promise>COMPLETE</promise>.`,
          ].join("\n"),
          maxIterations: 1,
        });
        const mergeVerdict = parseVerdict(mergeReview.stdout);
        if (!mergeVerdict?.approved) {
          multiMergeConflictIssue =
            mergeVerdict?.blockingIssues.join("; ") ||
            "Post-merge cross-slice auditor flagged a conflict or dropped requirement.";
        }
      }

      if (!hostCheckPassed || multiMergeConflictIssue !== null) {
        // Atomic rollback so main is NEVER left broken!
        try {
          execFileSync("git", ["reset", "--hard", preMergeSha], { stdio: "inherit" });
        } catch (err) {
          console.error(`Failed to roll back main to ${preMergeSha}:`, err);
        }
        const reason = multiMergeConflictIssue
          ? `Post-merge cross-slice audit blocked batch (main atomically rolled back to ${preMergeSha.slice(0, 7)}): ${multiMergeConflictIssue}`
          : `Host post-merge \`python scripts/check.py\` FAILED (main atomically rolled back to ${preMergeSha.slice(0, 7)}).`;
        for (const t of readyToMerge) {
          escalateTicketToHuman(t.id, reason, dashboard);
        }
        dashboard.setRunStatus(
          "blocked",
          `Post-merge verification failed — main atomically rolled back to ${preMergeSha.slice(0, 7)}.`,
        );
        break;
      }

      for (const merged of readyToMerge) {
        dashboard.upsertSlice(merged.id, {
          stage: "merged",
          pmSummary: "Merged into main, re-verified on host via check.py, and marked resolved.",
        });
      }
    }
  } finally {
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
        {
          label: "Run Confidence",
          value: `${conf.overall.score}/100`,
          note: conf.overall.badge,
        },
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
        {
          label: "Agent Trust",
          value: `${trust.trustScore}/100`,
          note: trust.tier,
        },
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
    await dashboard.close();
    releaseLock();
  }
}

await main();
