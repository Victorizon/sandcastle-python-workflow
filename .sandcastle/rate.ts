/**
 * 5-Second Human Reality-Check CLI (`npm --prefix .sandcastle run rate`).
 *
 * Usage:
 *   npm --prefix .sandcastle run rate -- --latest --verdict good
 *   npm --prefix .sandcastle run rate -- --latest --verdict tweak --note "renamed helper"
 *   npm --prefix .sandcastle run rate -- --run run-2026-... --verdict rework --note "missed nested case"
 */

import path from "node:path";
import {
  type HumanVerdict,
  computeAgentTrustScore,
  loadHumanRatings,
  saveHumanRating,
} from "./confidence.js";
import { normalizeRepoCwd } from "./resilience.js";
import { loadVerifiedRunHistory } from "./run-history.js";

function parseArgs(argv: readonly string[]): {
  readonly runId?: string;
  readonly latest: boolean;
  readonly verdict?: HumanVerdict;
  readonly note: string;
} {
  let runId: string | undefined;
  let latest = false;
  let verdict: HumanVerdict | undefined;
  let note = "";

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--latest") {
      latest = true;
    } else if (arg === "--run" && next) {
      runId = next;
      i += 1;
    } else if (arg === "--verdict" && next) {
      if (next === "good" || next === "tweak" || next === "rework") {
        verdict = next;
      } else {
        throw new Error(`Invalid --verdict "${next}". Use: good | tweak | rework`);
      }
      i += 1;
    } else if (arg === "--note" && next) {
      note = next;
      i += 1;
    }
  }
  return { runId, latest, verdict, note };
}

function main(): void {
  normalizeRepoCwd();
  const args = parseArgs(process.argv.slice(2));
  if (!args.verdict) {
    throw new Error(
      "Missing --verdict (good | tweak | rework).\nExample: npm --prefix .sandcastle run rate -- --latest --verdict good",
    );
  }

  const logsDir = path.join(".sandcastle", "logs");
  const { verifiedRuns } = loadVerifiedRunHistory(logsDir);
  if (verifiedRuns.length === 0) {
    throw new Error("No verified local factory runs found in .sandcastle/logs/run-history.jsonl yet.");
  }

  const targetRun = args.runId
    ? verifiedRuns.find((r) => r.runId === args.runId)
    : args.latest
      ? verifiedRuns.at(-1)
      : verifiedRuns.at(-1);

  if (!targetRun) {
    throw new Error(`Run ID "${args.runId}" not found in verified local run history.`);
  }

  const saved = saveHumanRating(
    {
      runId: targetRun.runId,
      verdict: args.verdict,
      note: args.note,
    },
    logsDir,
  );

  const ratings = loadHumanRatings(logsDir);
  const trust = computeAgentTrustScore(verifiedRuns, ratings);
  console.log(`Saved human verdict [${saved.verdict}] for ${saved.runId}`);
  if (saved.note) console.log(`Note: ${saved.note}`);
  console.log(
    `\nUpdated Agent Trust Score: ${trust.trustScore}/100 — ${trust.tier}\n` +
      `Next lever: ${trust.diagnosticLever}`,
  );
}

main();
