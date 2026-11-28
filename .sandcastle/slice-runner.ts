/**
 * Deep module owning the 3-phase single-slice lifecycle:
 * Phase A (Builder), Phase B (Zero-trust Verifier + Fixer), Phase C (PoW + Adversarial Reviewer).
 */

import { mkdirSync } from "node:fs";
import * as sandcastle from "@ai-hero/sandcastle";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import { parseCheckMetrics } from "./dashboard.js";
import { type PowVerdict, formatPowEvidenceForReviewer, runSliceProofOfWork } from "./pow-verifier.js";
import {
  type PlannedTicket,
  type SliceRuntimeContext,
  escalateTicketToHuman,
  isAheadOfHead,
  parseVerdict,
  runWatchedContainer,
} from "./slice-container.js";

const MAX_VERIFY_RETRIES = 2;
const MAX_REVIEW_ROUNDS = 2;

export interface SliceRunnerOps {
  readonly runWatched: typeof runWatchedContainer;
  readonly runVerify: (branch: string, imageName: string) => Promise<{
    readonly guardExit: number;
    readonly guardOut: string;
    readonly checkExit: number;
    readonly checkOut: string;
  }>;
  readonly runPow: typeof runSliceProofOfWork;
  readonly runReview: (params: {
    readonly ticket: PlannedTicket;
    readonly round: number;
    readonly powVerdict: PowVerdict | null;
    readonly imageName: string;
  }) => Promise<{
    readonly reviewStdout: string;
    readonly postCheckExit: number;
    readonly postCheckOut: string;
  }>;
  readonly isAhead: (branch: string) => boolean;
  readonly escalate: typeof escalateTicketToHuman;
}

const DEFAULT_SLICE_OPS: SliceRunnerOps = {
  runWatched: runWatchedContainer,
  runVerify: async (branch, imageName) => {
    await using verifySandbox = await sandcastle.createSandbox({
      sandbox: createDockerSandbox(imageName),
      branch,
    });
    const guardRes = await verifySandbox.exec("python scripts/test_guard.py --base main");
    if (guardRes.exitCode !== 0) {
      return { guardExit: guardRes.exitCode, guardOut: guardRes.stdout, checkExit: 1, checkOut: "" };
    }
    const checkRes = await verifySandbox.exec("python scripts/check.py");
    return {
      guardExit: 0,
      guardOut: guardRes.stdout,
      checkExit: checkRes.exitCode,
      checkOut: `${checkRes.stdout}\n${checkRes.stderr}`.trim(),
    };
  },
  runPow: runSliceProofOfWork,
  runReview: async ({ ticket, round, powVerdict, imageName }) => {
    await using reviewSandbox = await sandcastle.createSandbox({
      sandbox: createDockerSandbox(imageName),
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
        POW_EVIDENCE: formatPowEvidenceForReviewer(powVerdict),
      },
      maxIterations: 1,
    });
    const postReviewCheck = await reviewSandbox.exec(
      "python scripts/check.py && python scripts/adversarial_scan.py --base main",
    );
    return {
      reviewStdout: review.stdout,
      postCheckExit: postReviewCheck.exitCode,
      postCheckOut: `${postReviewCheck.stdout}\n${postReviewCheck.stderr}`.trim(),
    };
  },
  isAhead: isAheadOfHead,
  escalate: escalateTicketToHuman,
};

export async function processTicket(
  ticket: PlannedTicket,
  cycle: number,
  ctx: SliceRuntimeContext,
  ops: SliceRunnerOps = DEFAULT_SLICE_OPS,
): Promise<{ approved: boolean; decomposed: boolean }> {
  const startedAtMs = Date.now();
  mkdirSync(".sandcastle/logs", { recursive: true });
  const safeId = ticket.id.replaceAll(/[^a-z0-9_-]/giu, "-");
  const logPath = `.sandcastle/logs/${safeId}-implement.log`;

  ctx.dashboard.upsertSlice(ticket.id, {
    title: ticket.title,
    branch: ticket.branch,
    splitDepth: ticket.splitDepth,
    stage: "implementing",
    pmSummary: "Booting isolated Builder container & starting TDD implementation...",
  });

  // Phase A: Isolated Builder container
  const buildRes = await ops.runWatched({
    ticket,
    cycle,
    phase: "implement",
    name: `Implementer ${ticket.id}`,
    promptFile: "./.sandcastle/implement-prompt.md",
    promptArgs: { TICKET_ID: ticket.id, TICKET_TITLE: ticket.title, BRANCH: ticket.branch },
    startedAtMs,
    logPath,
    recordPostMetrics: true,
    ctx,
  });
  if (!buildRes.ok) {
    return { approved: false, decomposed: buildRes.decomposed };
  }

  // Phase B: Fresh, zero-trust Verifier container per attempt
  let checkPassed = false;
  let tamperStrikes = 0;
  for (let attempt = 0; attempt <= MAX_VERIFY_RETRIES; attempt++) {
    ctx.dashboard.upsertSlice(ticket.id, {
      stage: "verifying",
      pmSummary: `Fresh Verifier container running 6 mechanical checks (attempt ${attempt + 1}/${MAX_VERIFY_RETRIES + 1})...`,
    });

    const { guardExit, guardOut, checkExit, checkOut } = await ops.runVerify(
      ticket.branch,
      ctx.imageName,
    );

    if (guardExit !== 0) {
      tamperStrikes += 1;
      ctx.dashboard.recordChallenge(ticket.id, {
        source: "test_guard",
        finding: `Blocked test/fixture/harness tampering (strike ${tamperStrikes}/2).`,
        outcome: tamperStrikes >= 2 || attempt === MAX_VERIFY_RETRIES ? "blocked" : "fixed",
      });
      if (tamperStrikes >= 2 || attempt === MAX_VERIFY_RETRIES) {
        ops.escalate(
          ticket.id,
          `BLOCKED by strict test/harness lock (\`scripts/test_guard.py\`, strike ${tamperStrikes}):\n\n${guardOut}`,
          ctx.dashboard,
          ctx.pythonBin,
        );
        return { approved: false, decomposed: false };
      }
      ctx.dashboard.upsertSlice(ticket.id, {
        stage: "remediating",
        pmSummary:
          "Test Guard caught unauthorized test/harness edit (strike 1/2) — booting fresh Fixer to restore locked files & fix properly...",
      });
      const fixRes = await ops.runWatched({
        ticket,
        cycle,
        phase: "fix",
        name: `Fixer ${ticket.id}`,
        promptFile: "./.sandcastle/fix-prompt.md",
        promptArgs: {
          TICKET_ID: ticket.id,
          TICKET_TITLE: ticket.title,
          BRANCH: ticket.branch,
          FAILURE_SOURCE: "scripts/test_guard.py (anti-tamper lock)",
          FAILURE_DETAILS: guardOut,
        },
        startedAtMs,
        logPath,
        recordPostMetrics: false,
        ctx,
      });
      if (!fixRes.ok) return { approved: false, decomposed: fixRes.decomposed };
      continue;
    }

    if (checkExit === 0) {
      const q = parseCheckMetrics(checkOut);
      ctx.dashboard.recordQualityMetrics(q.coveragePercent, q.mutationScore);
      checkPassed = true;
      break;
    }
    if (attempt === MAX_VERIFY_RETRIES) {
      ops.escalate(
        ticket.id,
        `Deterministic gate \`python scripts/check.py\` still failed after ${MAX_VERIFY_RETRIES} fresh Fixer rounds.`,
        ctx.dashboard,
        ctx.pythonBin,
      );
      return { approved: false, decomposed: false };
    }
    ctx.dashboard.upsertSlice(ticket.id, {
      stage: "remediating",
      pmSummary: `6-gate check failed — booting fresh Fixer container (attempt ${attempt + 1}/${MAX_VERIFY_RETRIES})...`,
    });
    const fixRes = await ops.runWatched({
      ticket,
      cycle,
      phase: "fix",
      name: `Fixer ${ticket.id}`,
      promptFile: "./.sandcastle/fix-prompt.md",
      promptArgs: {
        TICKET_ID: ticket.id,
        TICKET_TITLE: ticket.title,
        BRANCH: ticket.branch,
        FAILURE_SOURCE: "python scripts/check.py (6-gate verification)",
        FAILURE_DETAILS: checkOut.slice(-4000),
      },
      startedAtMs,
      logPath,
      recordPostMetrics: false,
      ctx,
    });
    if (!fixRes.ok) return { approved: false, decomposed: fixRes.decomposed };
  }

  if (!checkPassed || !ops.isAhead(ticket.branch)) {
    return { approved: false, decomposed: false };
  }

  // Phase C: Proof-of-Work Verifier + Fresh-context Adversarial Reviewer
  const powVerdict = await ops.runPow({
    imageName: ctx.imageName,
    ticket,
    cycle,
    tracer: ctx.tracer,
  });
  for (let round = 1; round <= MAX_REVIEW_ROUNDS; round++) {
    ctx.dashboard.upsertSlice(ticket.id, {
      stage: "reviewing",
      pmSummary: `Fresh Adversarial Reviewer checking diff against spec & CODING_STANDARDS.md (round ${round}/${MAX_REVIEW_ROUNDS})...`,
    });

    const tReview = performance.now();
    const { reviewStdout, postCheckExit, postCheckOut } = await ops.runReview({
      ticket,
      round,
      powVerdict,
      imageName: ctx.imageName,
    });
    const verdict = parseVerdict(reviewStdout);
    if (postCheckExit === 0 && verdict?.approved) {
      ctx.tracer.recordSpan({
        cycle,
        sliceId: ticket.id,
        phase: "review",
        outcome: "pass",
        durationMs: performance.now() - tReview,
        detail: verdict.summary,
      });
      const q = parseCheckMetrics(postCheckOut);
      ctx.dashboard.recordQualityMetrics(q.coveragePercent, q.mutationScore);
      ctx.dashboard.upsertSlice(ticket.id, {
        stage: "merging",
        pmSummary: `Approved by Fresh Reviewer: ${verdict.summary}`,
      });
      ctx.dashboard.addEvent({
        sliceId: ticket.id,
        level: "success",
        headline: "Passed 6 gates & Fresh Adversarial Review",
        detail: verdict.summary,
      });
      return { approved: true, decomposed: false };
    }

    const findingText =
      verdict?.blockingIssues.join("; ") || "Reviewer raised blocking findings or check.py failed.";
    ctx.tracer.recordSpan({
      cycle,
      sliceId: ticket.id,
      phase: "review",
      outcome: round === MAX_REVIEW_ROUNDS ? "escalated" : "fail",
      durationMs: performance.now() - tReview,
      detail: findingText,
    });
    if (round === MAX_REVIEW_ROUNDS) {
      ctx.dashboard.recordChallenge(ticket.id, {
        source: "reviewer",
        finding: findingText,
        outcome: "escalated",
      });
      ops.escalate(
        ticket.id,
        `Stopped at max review rounds (${MAX_REVIEW_ROUNDS}). Blocking findings: ${findingText}`,
        ctx.dashboard,
        ctx.pythonBin,
      );
      return { approved: false, decomposed: false };
    }

    ctx.dashboard.recordChallenge(ticket.id, { source: "reviewer", finding: findingText, outcome: "fixed" });
    ctx.dashboard.addEvent({
      sliceId: ticket.id,
      level: "challenge",
      headline: `Adversarial Reviewer challenged diff (round ${round})`,
      detail: findingText,
    });
    ctx.dashboard.upsertSlice(ticket.id, {
      stage: "remediating",
      pmSummary: "Adversarial Reviewer caught blocking findings — booting fresh Fixer container...",
    });

    const feedback = verdict?.blockingIssues.join("\n- ") || postCheckOut.slice(-3000);
    const fixRes = await ops.runWatched({
      ticket,
      cycle,
      phase: "fix",
      name: `Fixer ${ticket.id}`,
      promptFile: "./.sandcastle/fix-prompt.md",
      promptArgs: {
        TICKET_ID: ticket.id,
        TICKET_TITLE: ticket.title,
        BRANCH: ticket.branch,
        FAILURE_SOURCE: `Adversarial Reviewer (round ${round})`,
        FAILURE_DETAILS: `- ${feedback}`,
      },
      startedAtMs,
      logPath,
      recordPostMetrics: false,
      ctx,
    });
    if (!fixRes.ok) return { approved: false, decomposed: fixRes.decomposed };
  }

  return { approved: false, decomposed: false };
}
