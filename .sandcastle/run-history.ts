/**
 * Append-only Run History Collector & Verified 10-Run Gate (`.sandcastle/run-history.ts`).
 *
 * Every real `factory` run writes an immutable JSON artifact under `.sandcastle/logs/runs/`
 * and appends a reference line to `.sandcastle/logs/run-history.jsonl`.
 *
 * The Tuner requires at least `MIN_RUNS_FOR_TUNING` (10) verified runs whose backing
 * local artifact files actually exist on disk and parse cleanly before any analysis runs.
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import type { DashboardState } from "./dashboard.js";

export const MIN_RUNS_FOR_TUNING = 10;

export interface SliceRunRecord {
  readonly id: string;
  readonly stage: string;
  readonly splitDepth: number;
  readonly elapsedSec: number;
  readonly toolCalls: number;
  readonly diffLines: number;
  readonly contextPercent: number;
  readonly challengeCount: number;
  readonly tamperBlocks: number;
  readonly driftSplits: number;
}

export interface FactoryRunRecord {
  readonly runId: string;
  readonly mode: "factory";
  readonly startedAt: string;
  readonly finishedAt: string;
  readonly runStatus: DashboardState["runStatus"];
  readonly dockerImage: string;
  readonly cyclesRun: number;
  readonly runFile: string;
  readonly totalSlices: number;
  readonly completedSlices: number;
  readonly adversarialChallengesRaised: number;
  readonly adversarialChallengesResolved: number;
  readonly testTamperBlocks: number;
  readonly driftAutoSplits: number;
  readonly coveragePercent: number | null;
  readonly mutationScore: number | null;
  readonly slices: readonly SliceRunRecord[];
}

export interface VerifiedHistoryResult {
  readonly verifiedRuns: readonly FactoryRunRecord[];
  readonly skippedMissingFiles: number;
  readonly skippedInvalidLines: number;
}

export function recordFactoryRun(
  state: DashboardState,
  logsDir = path.join(".sandcastle", "logs"),
): FactoryRunRecord | null {
  if (state.mode !== "factory") return null;

  const runsDir = path.join(logsDir, "runs");
  mkdirSync(runsDir, { recursive: true });

  const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
  const runId = `run-${stamp}-${Math.random().toString(36).slice(2, 7)}`;
  const relRunFile = path.posix.join("runs", `${runId}.json`);
  const absRunFile = path.join(runsDir, `${runId}.json`);

  const record: FactoryRunRecord = {
    runId,
    mode: "factory",
    startedAt: state.startedAt,
    finishedAt: new Date().toISOString(),
    runStatus: state.runStatus,
    dockerImage: state.dockerImage,
    cyclesRun: state.cycle,
    runFile: relRunFile,
    totalSlices: state.metrics.totalSlices,
    completedSlices: state.metrics.completedSlices,
    adversarialChallengesRaised: state.metrics.adversarialChallengesRaised,
    adversarialChallengesResolved: state.metrics.adversarialChallengesResolved,
    testTamperBlocks: state.metrics.testTamperBlocks,
    driftAutoSplits: state.metrics.driftAutoSplits,
    coveragePercent: state.metrics.latestCoveragePercent,
    mutationScore: state.metrics.latestMutationScore,
    slices: state.slices.map((s) => ({
      id: s.id,
      stage: s.stage,
      splitDepth: s.splitDepth,
      elapsedSec: s.watchdog.elapsedSec,
      toolCalls: s.watchdog.toolCalls,
      diffLines: s.watchdog.diffLines,
      contextPercent: s.watchdog.contextPercent,
      challengeCount: s.challenges.length,
      tamperBlocks: s.challenges.filter((c) => c.source === "test_guard").length,
      driftSplits: s.challenges.filter((c) => c.outcome === "split").length,
    })),
  };

  writeFileSync(absRunFile, JSON.stringify({ record, state }, null, 2) + "\n", "utf8");
  const indexPath = path.join(logsDir, "run-history.jsonl");
  appendFileSync(indexPath, JSON.stringify(record) + "\n", "utf8");
  return record;
}

export function loadVerifiedRunHistory(
  logsDir = path.join(".sandcastle", "logs"),
): VerifiedHistoryResult {
  const indexPath = path.join(logsDir, "run-history.jsonl");
  if (!existsSync(indexPath)) {
    return { verifiedRuns: [], skippedMissingFiles: 0, skippedInvalidLines: 0 };
  }

  const lines = readFileSync(indexPath, "utf8")
    .split(/\r?\n/u)
    .map((l) => l.trim())
    .filter(Boolean);

  const seenIds = new Set<string>();
  const verifiedRuns: FactoryRunRecord[] = [];
  let skippedMissingFiles = 0;
  let skippedInvalidLines = 0;

  for (const line of lines) {
    let parsed: unknown;
    try {
      parsed = JSON.parse(line);
    } catch {
      skippedInvalidLines += 1;
      continue;
    }

    const rec = parsed as Partial<FactoryRunRecord>;
    if (
      rec.mode !== "factory" ||
      typeof rec.runId !== "string" ||
      typeof rec.runFile !== "string" ||
      seenIds.has(rec.runId)
    ) {
      skippedInvalidLines += 1;
      continue;
    }

    // Hard check: the backing local run JSON file MUST exist on disk and parse validly
    const absArtifact = path.resolve(logsDir, rec.runFile);
    if (!existsSync(absArtifact)) {
      skippedMissingFiles += 1;
      continue;
    }
    try {
      const artifact = JSON.parse(readFileSync(absArtifact, "utf8")) as {
        record?: { runId?: string };
      };
      if (artifact.record?.runId !== rec.runId) {
        skippedInvalidLines += 1;
        continue;
      }
    } catch {
      skippedInvalidLines += 1;
      continue;
    }

    seenIds.add(rec.runId);
    verifiedRuns.push(rec as FactoryRunRecord);
  }

  return { verifiedRuns, skippedMissingFiles, skippedInvalidLines };
}
