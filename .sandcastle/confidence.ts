/**
 * Deterministic Confidence Grading & Agent Trust Engine (`.sandcastle/confidence.ts`).
 *
 * ZERO LLM math, ZERO self-reported confidence scores:
 *   - Every 0-100 score and plain-English Action Badge is computed strictly from
 *     hard mechanical signals, hard safety caps, and verified test execution.
 *   - Spec alignment and Standards alignment are tracked as separate axes so a clean
 *     style check can never hide a missing requirement.
 *   - Agent Trust Score aggregates verified local runs plus optional human post-review
 *     verdicts (`rate.ts`) into an actionable Autonomy Readiness Tier.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { z } from "zod";
import type { CommandCheckResult } from "./goal-core.js";
import type { FactoryRunRecord, SliceRunRecord } from "./run-history.js";
import { MIN_RUNS_FOR_TUNING } from "./run-history.js";

export type ActionBadge =
  | "Spot-Check Ready"
  | "Quick Review"
  | "Review Carefully"
  | "Blocked — Do Not Ship";

export type ConfidenceStatus = "success" | "attention" | "blocked";

export interface ConfidenceAssessment {
  readonly score: number;
  readonly badge: ActionBadge;
  readonly status: ConfidenceStatus;
  readonly reasons: readonly string[];
}

export interface SliceConfidenceInput {
  readonly stage: string;
  readonly checkPassed: boolean;
  readonly coveragePercent: number | null;
  readonly mutationScore: number | null;
  readonly tamperBlocks: number;
  readonly driftSplits: number;
  readonly challengeCount: number;
  readonly diffLines: number;
  readonly contextPercent: number;
  readonly contextTokens?: number;
  readonly missingSpecItems?: number;
  readonly scopeCreepCount?: number;
  readonly standardsViolations?: number;
}

export interface SpecContractItem {
  readonly id: string;
  readonly category: "REQ" | "INV" | "OUT";
  readonly text: string;
}

export const SpecAuditOutputSchema = z.object({
  summary: z.string().min(1),
  items: z.array(
    z.object({
      id: z.string().min(1),
      status: z.enum(["VERIFIED", "IMPLEMENTED_UNTESTED", "MISSING", "RESPECTED", "VIOLATED"]),
      evidenceFile: z.string().default(""),
      citedTest: z.string().default(""),
      note: z.string().default(""),
    }),
  ),
  standardsViolations: z.array(z.string()).default([]),
  scopeCreepItems: z.array(z.string()).default([]),
});

export type SpecAuditOutput = z.infer<typeof SpecAuditOutputSchema>;

export interface VerifiedSpecRow {
  readonly id: string;
  readonly category: "REQ" | "INV" | "OUT";
  readonly requirement: string;
  readonly status: "VERIFIED" | "IMPLEMENTED_UNTESTED" | "MISSING" | "RESPECTED" | "VIOLATED";
  readonly evidenceFile: string;
  readonly citedTest: string;
  readonly testVerifiedInPytest: boolean | null;
  readonly note: string;
}

export interface VerifiedSpecAudit {
  readonly rows: readonly VerifiedSpecRow[];
  readonly totalSpecItems: number;
  readonly verifiedCount: number;
  readonly untestedCount: number;
  readonly missingCount: number;
  readonly violatedNonGoals: number;
  readonly hallucinatedTestsDowngraded: number;
  readonly standardsViolations: readonly string[];
  readonly scopeCreepItems: readonly string[];
}

export type HumanVerdict = "good" | "tweak" | "rework";

export interface HumanRatingRecord {
  readonly runId: string;
  readonly verdict: HumanVerdict;
  readonly note: string;
  readonly ratedAt: string;
}

export type AutonomyTier =
  | "Supervised Only"
  | "Factory Ready (Level 1)"
  | "Goal Autonomy Ready (Level 2)";

export interface AgentTrustScorecard {
  readonly trustScore: number;
  readonly tier: AutonomyTier;
  readonly runsAnalyzed: number;
  readonly slicesAnalyzed: number;
  readonly ratedRunsCount: number;
  readonly firstPassRate: number;
  readonly integrityRate: number;
  readonly stabilityRate: number;
  readonly deliveryRate: number;
  readonly humanApprovalRate: number | null;
  readonly diagnosticLever: string;
  readonly reasons: readonly string[];
}

function clampScore(score: number): number {
  return Math.max(0, Math.min(100, Math.round(score)));
}

export function badgeForScore(score: number, hardBlocked = false): {
  readonly badge: ActionBadge;
  readonly status: ConfidenceStatus;
} {
  if (hardBlocked || score < 50) {
    return { badge: "Blocked — Do Not Ship", status: "blocked" };
  }
  if (score >= 90) {
    return { badge: "Spot-Check Ready", status: "success" };
  }
  if (score >= 75) {
    return { badge: "Quick Review", status: "success" };
  }
  return { badge: "Review Carefully", status: "attention" };
}

/**
 * Deterministically grades a single slice (0-100 + Action Badge) with strict hard caps
 * so high style/lint scores can never mask tampering, drift, or missing spec coverage.
 */
export function scoreSliceConfidence(input: SliceConfidenceInput): ConfidenceAssessment {
  let score = 100;
  let cap = 100;
  let hardBlocked = false;
  const reasons: string[] = [];

  if (!input.checkPassed || input.stage === "needs_human") {
    hardBlocked = true;
    cap = Math.min(cap, 35);
    score -= 65;
    reasons.push("Hard gate failed or slice escalated for human intervention.");
  }

  if ((input.missingSpecItems ?? 0) > 0) {
    hardBlocked = true;
    cap = Math.min(cap, 40);
    score -= 40;
    reasons.push(`${input.missingSpecItems} required spec item(s) missing or incorrect.`);
  }

  if ((input.standardsViolations ?? 0) > 0) {
    hardBlocked = true;
    cap = Math.min(cap, 45);
    score -= 35;
    reasons.push(`${input.standardsViolations} unresolved coding-standards violation(s).`);
  }

  if (input.tamperBlocks > 0) {
    cap = Math.min(cap, 65);
    score -= 25;
    reasons.push(
      `Test-guard blocked ${input.tamperBlocks} tampering attempt(s) — capped at Review Carefully.`,
    );
  }

  if (input.driftSplits > 0) {
    cap = Math.min(cap, 72);
    score -= 12;
    reasons.push(`DriftWatchdog intervened (${input.driftSplits} auto-split).`);
  }

  if ((input.scopeCreepCount ?? 0) > 0) {
    cap = Math.min(cap, 72);
    score -= 10;
    reasons.push(`${input.scopeCreepCount} unrequested scope-creep item(s) flagged.`);
  }

  if (input.mutationScore !== null) {
    if (input.mutationScore < 85) {
      cap = Math.min(cap, 70);
      score -= 18;
      reasons.push(`Mutation kill rate ${input.mutationScore}% is below 85% target.`);
    } else if (input.mutationScore < 90) {
      score -= 5;
      reasons.push(`Mutation kill rate ${input.mutationScore}% (90%+ needed for top score).`);
    }
  }

  if (input.coveragePercent !== null && input.coveragePercent < 95) {
    score -= 8;
    reasons.push(`Line coverage ${input.coveragePercent}% is under 95%.`);
  }

  if (input.challengeCount > 0) {
    const penalty = Math.min(18, input.challengeCount * 6);
    score -= penalty;
    reasons.push(`Required ${input.challengeCount} adversarial fix round(s).`);
  }

  if (input.diffLines > 400) {
    cap = Math.min(cap, 74);
    score -= 10;
    reasons.push(`Large diff (${input.diffLines} lines > 400) increases review risk.`);
  } else if (input.diffLines > 250) {
    score -= 4;
    reasons.push(`Moderate diff size (${input.diffLines} lines).`);
  }

  if (input.contextTokens !== undefined && input.contextTokens >= 130_000) {
    cap = Math.min(cap, 72);
    score -= 10;
    reasons.push(
      `Context reached ${input.contextTokens.toLocaleString("en-US")} tokens (>= 130k smart-zone cap).`,
    );
  } else if (input.contextPercent > 75) {
    score -= 8;
    reasons.push(`High context usage (${input.contextPercent}%) near context-rot threshold.`);
  }

  const finalScore = clampScore(Math.min(score, cap));
  const { badge, status } = badgeForScore(finalScore, hardBlocked);
  if (reasons.length === 0) {
    reasons.push("Clean first-pass execution: all 6 gates green, zero tampering, zero drift.");
  }

  return { score: finalScore, badge, status, reasons };
}

export function scoreFactoryRunConfidence(
  record: FactoryRunRecord,
): {
  readonly overall: ConfidenceAssessment;
  readonly bySlice: ReadonlyMap<string, ConfidenceAssessment>;
} {
  const bySlice = new Map<string, ConfidenceAssessment>();
  for (const s of record.slices) {
    bySlice.set(
      s.id,
      scoreSliceConfidence({
        stage: s.stage,
        checkPassed: s.stage === "merged",
        coveragePercent: record.coveragePercent,
        mutationScore: record.mutationScore,
        tamperBlocks: s.tamperBlocks,
        driftSplits: s.driftSplits,
        challengeCount: s.challengeCount,
        diffLines: s.diffLines,
        contextPercent: s.contextPercent,
      }),
    );
  }

  if (record.slices.length === 0) {
    const emptyBlocked = record.runStatus !== "complete";
    const score = emptyBlocked ? 40 : 100;
    const { badge, status } = badgeForScore(score, emptyBlocked);
    return {
      overall: {
        score,
        badge,
        status,
        reasons: [
          emptyBlocked
            ? "Factory run did not complete cleanly."
            : "No pending slices remained to process.",
        ],
      },
      bySlice,
    };
  }

  const sliceScores = [...bySlice.values()];
  const minSlice = Math.min(...sliceScores.map((s) => s.score));
  const avgSlice = sliceScores.reduce((acc, s) => acc + s.score, 0) / sliceScores.length;
  // Blend average with worst slice so a broken slice drags the overall run down cleanly.
  const blended = clampScore(avgSlice * 0.6 + minSlice * 0.4);
  const anyBlocked = sliceScores.some((s) => s.status === "blocked") || record.runStatus === "blocked";
  const cap = record.testTamperBlocks > 0 ? 65 : 100;
  const finalScore = clampScore(Math.min(blended, cap));
  const { badge, status } = badgeForScore(finalScore, anyBlocked);

  const reasons: string[] = [];
  if (anyBlocked) {
    reasons.push("One or more slices failed hard gates or escalated for human intervention.");
  }
  if (record.testTamperBlocks > 0) {
    reasons.push(`${record.testTamperBlocks} test-tampering block(s) capped run confidence.`);
  }
  if (record.driftAutoSplits > 0) {
    reasons.push(`${record.driftAutoSplits} drift auto-split(s) occurred during the run.`);
  }
  if (reasons.length === 0) {
    reasons.push(
      `All ${record.completedSlices}/${record.totalSlices} slices shipped cleanly through 6 gates and fresh review.`,
    );
  }

  return { overall: { score: finalScore, badge, status, reasons }, bySlice };
}

/**
 * Extracts numbered REQ-*, INV-*, and OUT-* items from a frozen `/grill-me` Spec Contract markdown file.
 */
export function parseSpecContract(markdown: string): SpecContractItem[] {
  const items: SpecContractItem[] = [];
  const seen = new Set<string>();
  const regex = /^\s*[-*]\s*(?:\*\*)?((?:REQ|INV|OUT)-\d+)(?:\*\*)?\s*[:\-–—]\s*(.+)$/gmu;

  for (const match of markdown.matchAll(regex)) {
    const id = (match[1] ?? "").toUpperCase();
    const text = (match[2] ?? "").trim();
    if (!id || !text || seen.has(id)) continue;
    seen.add(id);
    const category = id.startsWith("INV-") ? "INV" : id.startsWith("OUT-") ? "OUT" : "REQ";
    items.push({ id, category, text });
  }
  return items;
}

/**
 * Parses passing test names from `pytest -v` output (e.g. `tests/test_order_triage.py::test_foo PASSED`).
 */
export function parsePassingPytestNames(pytestVerboseStdout: string): Set<string> {
  const passed = new Set<string>();
  for (const line of pytestVerboseStdout.split(/\r?\n/u)) {
    const m = /^(\S+::(\S+))\s+PASSED\b/u.exec(line.trim());
    if (m?.[1] && m[2]) {
      passed.add(m[1]);
      passed.add(m[2]);
    }
  }
  return passed;
}

/**
 * Deterministically cross-checks the Spec Auditor's output against:
 *   1. Every REQ/INV/OUT ID in the frozen grilling spec (catches silently omitted requirements)
 *   2. Real passing pytest test names (catches hallucinated or non-passing test citations)
 *   3. Optional workspace file existence check
 */
export function verifySpecAuditAgainstTests(params: {
  readonly specItems: readonly SpecContractItem[];
  readonly audit: SpecAuditOutput;
  readonly passingPytestNames: ReadonlySet<string>;
  readonly repoRoot?: string;
}): VerifiedSpecAudit {
  const auditById = new Map(params.audit.items.map((item) => [item.id.toUpperCase(), item]));
  const rows: VerifiedSpecRow[] = [];
  let verifiedCount = 0;
  let untestedCount = 0;
  let missingCount = 0;
  let violatedNonGoals = 0;
  let hallucinatedTestsDowngraded = 0;

  for (const spec of params.specItems) {
    const audited = auditById.get(spec.id);
    if (!audited) {
      missingCount += 1;
      rows.push({
        id: spec.id,
        category: spec.category,
        requirement: spec.text,
        status: "MISSING",
        evidenceFile: "",
        citedTest: "",
        testVerifiedInPytest: null,
        note: "Omitted from Spec Audit output — deterministically marked MISSING.",
      });
      continue;
    }

    if (spec.category === "OUT") {
      const violated = audited.status === "VIOLATED";
      if (violated) violatedNonGoals += 1;
      else verifiedCount += 1;
      rows.push({
        id: spec.id,
        category: spec.category,
        requirement: spec.text,
        status: violated ? "VIOLATED" : "RESPECTED",
        evidenceFile: audited.evidenceFile,
        citedTest: "",
        testVerifiedInPytest: null,
        note: audited.note,
      });
      continue;
    }

    let status = audited.status;
    let note = audited.note;
    let testVerifiedInPytest: boolean | null = null;

    if (status === "VERIFIED") {
      const cited = audited.citedTest.trim();
      const testMatched =
        cited.length > 0 &&
        (params.passingPytestNames.has(cited) ||
          [...params.passingPytestNames].some((t) => t.endsWith(`::${cited}`) || t === cited));
      testVerifiedInPytest = testMatched;

      if (!testMatched) {
        hallucinatedTestsDowngraded += 1;
        status = "IMPLEMENTED_UNTESTED";
        note = `${note ? `${note} ` : ""}[Deterministic check: cited test "${cited || "(none)"}" not found in passing pytest output -> downgraded]`.trim();
      } else if (
        params.repoRoot &&
        audited.evidenceFile &&
        !existsSync(path.resolve(params.repoRoot, audited.evidenceFile.split(":")[0] ?? ""))
      ) {
        status = "IMPLEMENTED_UNTESTED";
        note = `${note ? `${note} ` : ""}[Deterministic check: cited file "${audited.evidenceFile}" does not exist]`.trim();
      }
    }

    if (status === "VERIFIED") verifiedCount += 1;
    else if (status === "IMPLEMENTED_UNTESTED") untestedCount += 1;
    else missingCount += 1;

    rows.push({
      id: spec.id,
      category: spec.category,
      requirement: spec.text,
      status,
      evidenceFile: audited.evidenceFile,
      citedTest: audited.citedTest,
      testVerifiedInPytest,
      note,
    });
  }

  return {
    rows,
    totalSpecItems: params.specItems.length,
    verifiedCount,
    untestedCount,
    missingCount,
    violatedNonGoals,
    hallucinatedTestsDowngraded,
    standardsViolations: params.audit.standardsViolations,
    scopeCreepItems: params.audit.scopeCreepItems,
  };
}

export function scoreGoalConfidence(params: {
  readonly goalMet: boolean;
  readonly commandResults: readonly CommandCheckResult[];
  readonly verifiedAudit?: VerifiedSpecAudit | null;
  readonly gapPlanRoundsUsed?: number;
}): ConfidenceAssessment {
  let score = 100;
  let cap = 100;
  let hardBlocked = false;
  const reasons: string[] = [];

  const failedCmds = params.commandResults.filter((r) => !r.passed).length;
  if (!params.goalMet || failedCmds > 0) {
    hardBlocked = true;
    cap = Math.min(cap, 35);
    score -= 65;
    reasons.push(`Goal checks incomplete (${failedCmds} verifyCommand failure(s)).`);
  }

  if ((params.gapPlanRoundsUsed ?? 0) > 0) {
    score -= Math.min(10, (params.gapPlanRoundsUsed ?? 0) * 4);
    reasons.push(`Needed ${params.gapPlanRoundsUsed} Gap-Planner recovery round(s).`);
  }

  const audit = params.verifiedAudit;
  if (audit) {
    if (audit.missingCount > 0) {
      hardBlocked = true;
      cap = Math.min(cap, 40);
      score -= 40;
      reasons.push(`${audit.missingCount}/${audit.totalSpecItems} grilling spec item(s) MISSING.`);
    }
    if (audit.standardsViolations.length > 0) {
      hardBlocked = true;
      cap = Math.min(cap, 45);
      score -= 30;
      reasons.push(`${audit.standardsViolations.length} unresolved Standards violation(s).`);
    }
    if (audit.violatedNonGoals > 0) {
      cap = Math.min(cap, 68);
      score -= 15;
      reasons.push(`${audit.violatedNonGoals} explicit Out-of-Scope rule(s) violated.`);
    }
    if (audit.hallucinatedTestsDowngraded > 0) {
      cap = Math.min(cap, 70);
      score -= 12 * audit.hallucinatedTestsDowngraded;
      reasons.push(
        `${audit.hallucinatedTestsDowngraded} cited test(s) failed deterministic pytest cross-check.`,
      );
    }
    if (audit.untestedCount > 0) {
      cap = Math.min(cap, 82);
      score -= Math.min(20, audit.untestedCount * 8);
      reasons.push(`${audit.untestedCount} spec requirement(s) implemented without verified test proof.`);
    }
    if (audit.scopeCreepItems.length > 0) {
      cap = Math.min(cap, 74);
      score -= 8;
      reasons.push(`${audit.scopeCreepItems.length} unrequested scope-creep item(s) detected.`);
    }
  }

  const finalScore = clampScore(Math.min(score, cap));
  const { badge, status } = badgeForScore(finalScore, hardBlocked);
  if (reasons.length === 0) {
    reasons.push(
      audit
        ? `Every verifyCommand passed and all ${audit.verifiedCount}/${audit.totalSpecItems} grilling spec items are verified against live pytest runs.`
        : "Every deterministic goal check passed cleanly.",
    );
  }

  return { score: finalScore, badge, status, reasons };
}

export function saveHumanRating(
  rating: Omit<HumanRatingRecord, "ratedAt">,
  logsDir = path.join(".sandcastle", "logs"),
): HumanRatingRecord {
  mkdirSync(logsDir, { recursive: true });
  const record: HumanRatingRecord = {
    runId: rating.runId,
    verdict: rating.verdict,
    note: rating.note.trim(),
    ratedAt: new Date().toISOString(),
  };
  appendFileSync(path.join(logsDir, "human-ratings.jsonl"), JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function loadHumanRatings(
  logsDir = path.join(".sandcastle", "logs"),
): readonly HumanRatingRecord[] {
  const filePath = path.join(logsDir, "human-ratings.jsonl");
  if (!existsSync(filePath)) return [];
  const latestByRun = new Map<string, HumanRatingRecord>();
  for (const line of readFileSync(filePath, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      const parsed = JSON.parse(trimmed) as Partial<HumanRatingRecord>;
      if (
        typeof parsed.runId === "string" &&
        (parsed.verdict === "good" || parsed.verdict === "tweak" || parsed.verdict === "rework")
      ) {
        latestByRun.set(parsed.runId, {
          runId: parsed.runId,
          verdict: parsed.verdict,
          note: typeof parsed.note === "string" ? parsed.note : "",
          ratedAt: typeof parsed.ratedAt === "string" ? parsed.ratedAt : "",
        });
      }
    } catch {
      // Ignore malformed lines
    }
  }
  return [...latestByRun.values()];
}

function pct(num: number, den: number): number {
  if (den <= 0) return 0;
  return Math.round((num / den) * 100);
}

/**
 * Computes the longitudinal Agent Trust Score (0-100) and Autonomy Readiness Tier
 * from verified local runs (rolling last 20 runs) + optional human reality-check ratings.
 */
export function computeAgentTrustScore(
  verifiedRuns: readonly FactoryRunRecord[],
  humanRatings: readonly HumanRatingRecord[] = [],
  windowSize = 20,
): AgentTrustScorecard {
  const recentRuns = verifiedRuns.slice(-windowSize);
  const allSlices: SliceRunRecord[] = recentRuns.flatMap((r) => [...r.slices]);
  const totalSlices = allSlices.length;

  if (recentRuns.length === 0 || totalSlices === 0) {
    return {
      trustScore: 0,
      tier: "Supervised Only",
      runsAnalyzed: recentRuns.length,
      slicesAnalyzed: totalSlices,
      ratedRunsCount: 0,
      firstPassRate: 0,
      integrityRate: 0,
      stabilityRate: 0,
      deliveryRate: 0,
      humanApprovalRate: null,
      diagnosticLever: `Complete at least ${MIN_RUNS_FOR_TUNING} verified factory runs to establish an earned autonomy baseline.`,
      reasons: ["No verified local factory runs found yet."],
    };
  }

  const firstPassSlices = allSlices.filter(
    (s) => s.stage === "merged" && s.challengeCount === 0 && s.driftSplits === 0 && s.tamperBlocks === 0,
  ).length;
  const cleanIntegritySlices = allSlices.filter((s) => s.tamperBlocks === 0).length;
  const stableSlices = allSlices.filter((s) => s.driftSplits === 0 && s.stage !== "needs_human").length;
  const mergedSlices = allSlices.filter((s) => s.stage === "merged").length;

  const firstPassRate = pct(firstPassSlices, totalSlices);
  const integrityRate = pct(cleanIntegritySlices, totalSlices);
  const stabilityRate = pct(stableSlices, totalSlices);
  const deliveryRate = pct(mergedSlices, totalSlices);

  const recentRunIds = new Set(recentRuns.map((r) => r.runId));
  const matchingRatings = humanRatings.filter((r) => recentRunIds.has(r.runId));
  let humanApprovalRate: number | null = null;
  if (matchingRatings.length > 0) {
    const weighted = matchingRatings.reduce(
      (acc, r) => acc + (r.verdict === "good" ? 1 : r.verdict === "tweak" ? 0.6 : 0),
      0,
    );
    humanApprovalRate = Math.round((weighted / matchingRatings.length) * 100);
  }

  let rawScore: number;
  if (humanApprovalRate !== null) {
    rawScore =
      integrityRate * 0.25 +
      deliveryRate * 0.2 +
      firstPassRate * 0.15 +
      stabilityRate * 0.15 +
      humanApprovalRate * 0.25;
  } else {
    rawScore =
      integrityRate * 0.35 + deliveryRate * 0.25 + firstPassRate * 0.2 + stabilityRate * 0.2;
  }

  // Hard cap if agent integrity ever slips
  const cap = integrityRate < 95 ? 65 : 100;
  const trustScore = clampScore(Math.min(rawScore, cap));

  const reasons: string[] = [];
  let tier: AutonomyTier = "Supervised Only";

  if (recentRuns.length < MIN_RUNS_FOR_TUNING) {
    reasons.push(
      `Only ${recentRuns.length}/${MIN_RUNS_FOR_TUNING} verified local runs completed — keep supervised until sample floor is reached.`,
    );
  } else if (integrityRate < 95) {
    reasons.push(`Integrity rate ${integrityRate}% (< 95%) due to test-tampering attempts.`);
  } else if (
    trustScore >= 85 &&
    integrityRate >= 98 &&
    (humanApprovalRate === null || humanApprovalRate >= 85)
  ) {
    tier = "Goal Autonomy Ready (Level 2)";
    reasons.push("Earned trust for unattended Level 2 Goal runs and Prototype Bake-Offs.");
  } else if (trustScore >= 70) {
    tier = "Factory Ready (Level 1)";
    reasons.push("Reliable for multi-slice Level 1 factory runs and nightly architecture proposals.");
  } else {
    reasons.push("Trust score below 70 — stay on single-slice supervised runs until friction drops.");
  }

  const levers: { readonly score: number; readonly advice: string }[] = [
    {
      score: integrityRate,
      advice: "Integrity is lowest: inspect flaky legacy tests and reinforce anti-shortcut rules in prompts.",
    },
    {
      score: stabilityRate,
      advice: "Stability/drift is lowest: split tickets into smaller vertical slices or run nightly-arch on high-churn files.",
    },
    {
      score: firstPassRate,
      advice: "First-pass rate is lowest: tighten REQ-* acceptance criteria during /grill-me and update GLOSSARY.md.",
    },
    {
      score: deliveryRate,
      advice: "Delivery rate is lowest: inspect escalated ready-for-human tickets for missing fixtures or unclear seams.",
    },
  ];
  if (humanApprovalRate !== null) {
    levers.push({
      score: humanApprovalRate,
      advice:
        "Human review approval is lowest: turn your recent `rate --note` blind spots into new golden fixtures or Hypothesis invariants.",
    });
  }
  levers.sort((a, b) => a.score - b.score);
  const diagnosticLever =
    trustScore >= 90
      ? "All trust dimensions are healthy — keep running occasional `rate` spot-checks to stay calibrated."
      : (levers[0]?.advice ?? "Continue collecting verified runs.");

  return {
    trustScore,
    tier,
    runsAnalyzed: recentRuns.length,
    slicesAnalyzed: totalSlices,
    ratedRunsCount: matchingRatings.length,
    firstPassRate,
    integrityRate,
    stabilityRate,
    deliveryRate,
    humanApprovalRate,
    diagnosticLever,
    reasons,
  };
}
