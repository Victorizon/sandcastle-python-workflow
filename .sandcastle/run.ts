/**
 * Deterministic Outer Orchestrator for Matt Pocock's Workflow (Codex + Docker + Python)
 * with Built-In Deterministic Drift Watchdog, 1-Shot Re-Slicer, and Live PM Mission Control Dashboard.
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";
import {
  PMDashboard,
  parseCheckMetrics,
  summarizeAgentEventForPm,
} from "./dashboard.js";
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

const MODEL = process.env["CODEX_MODEL"] ?? "gpt-5.4";
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

  // Phase B: Fresh, zero-trust Verifier & Reviewer container booted strictly from committed branch
  await using sandbox = await sandcastle.createSandbox({
    sandbox: makeDocker(),
    branch: ticket.branch,
  });

  // Deterministic shell verification gate in fresh container (read-only /opt/venv)
  dashboard.upsertSlice(ticket.id, {
    stage: "verifying",
    pmSummary: "Fresh Verifier container running 6 mechanical checks (format, ratchet, boundaries, coverage, anti-tamper, mutation)...",
  });
  let checkPassed = false;
  for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
    const guardRes = await sandbox.exec("python scripts/test_guard.py --base main");
    if (guardRes.exitCode !== 0) {
      dashboard.recordChallenge(ticket.id, {
        source: "test_guard",
        finding: "Blocked attempt to delete or weaken existing tests/fixtures.",
        outcome: "blocked",
      });
      escalateTicketToHuman(
        ticket.id,
        `BLOCKED by strict test lock (\`scripts/test_guard.py\`):\n\n${guardRes.stdout}`,
        dashboard,
      );
      return { approved: false, decomposed: false };
    }

    const checkRes = await sandbox.exec("python scripts/check.py");
    if (checkRes.exitCode === 0) {
      const q = parseCheckMetrics(checkRes.stdout);
      dashboard.recordQualityMetrics(q.coveragePercent, q.mutationScore);
      checkPassed = true;
      break;
    }
    if (attempt === MAX_VERIFY_RETRIES) {
      escalateTicketToHuman(
        ticket.id,
        `Deterministic gate \`python scripts/check.py\` still failed after ${MAX_VERIFY_RETRIES} fix resumes.`,
        dashboard,
      );
      return { approved: false, decomposed: false };
    }
    dashboard.upsertSlice(ticket.id, {
      stage: "remediating",
      pmSummary: `6-gate check failed — Builder fixing reported issues (attempt ${attempt + 1}/${MAX_VERIFY_RETRIES})...`,
    });
    await impl.resume?.(
      `\`python scripts/check.py\` failed (exit ${checkRes.exitCode}):\n\n${checkRes.stdout}\n${checkRes.stderr}\n\nFix the failures WITHOUT deleting/weakening existing tests or fixtures, re-run \`python scripts/check.py\`, commit your fix, and output <promise>COMPLETE</promise>.`,
    );
  }

  if (!checkPassed || !isAheadOfHead(ticket.branch)) {
    return { approved: false, decomposed: false };
  }

  // Fresh-context Adversarial Reviewer
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    dashboard.upsertSlice(ticket.id, {
      stage: "reviewing",
      pmSummary: `Fresh Adversarial Reviewer checking diff against spec & CODING_STANDARDS.md (round ${round}/${MAX_REVIEW_ROUNDS})...`,
    });
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
      const q = parseCheckMetrics(postReviewCheck.stdout);
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
      pmSummary: `Adversarial Reviewer caught blocking findings — Builder addressing feedback...`,
    });

    const feedback = verdict?.blockingIssues.join("\n- ") || postReviewCheck.stdout;
    await impl.resume?.(
      `Adversarial reviewer raised blocking issues:\n- ${feedback}\n\nAddress each issue WITHOUT weakening existing tests, run \`python scripts/check.py\`, commit, and output <promise>COMPLETE</promise>.`,
    );
  }

  return { approved: false, decomposed: false };
}

async function main(): Promise<void> {
  preflightChecks();

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

      dashboard.setCycle(cycle, `Merger combining ${readyToMerge.length} approved branch(es) into main...`);
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

      // Deterministic host-side verification after Merger (never trust Merger's word alone)
      let hostCheckPassed = true;
      try {
        execFileSync(PYTHON_BIN, ["scripts/check.py"], { stdio: "inherit" });
      } catch {
        hostCheckPassed = false;
      }

      if (!hostCheckPassed) {
        for (const t of readyToMerge) {
          escalateTicketToHuman(
            t.id,
            "Host post-merge `python scripts/check.py` FAILED after Merger finished. Inspect `main` immediately.",
            dashboard,
          );
        }
        dashboard.setRunStatus(
          "blocked",
          "Post-merge deterministic verification failed — halted for human inspection.",
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
  }
}

await main();
