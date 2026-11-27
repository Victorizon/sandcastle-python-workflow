/**
 * Deterministic Agent Trust Scorecard CLI (`npm --prefix .sandcastle run trust`).
 *
 * Computes your rolling Agent Trust Score (0-100) and Autonomy Readiness Tier strictly from
 * verified local runs + optional human `rate` verdicts (ZERO LLM calls), and writes an
 * executive PM HTML + 1-click Jira scorecard under `.sandcastle/logs/reports/`.
 */

import path from "node:path";
import { computeAgentTrustScore, loadHumanRatings } from "./confidence.js";
import { writePmHtmlReport } from "./pm-report.js";
import { loadVerifiedRunHistory } from "./run-history.js";

function main(): void {
  const logsDir = path.join(".sandcastle", "logs");
  const { verifiedRuns, skippedMissingFiles } = loadVerifiedRunHistory(logsDir);
  const ratings = loadHumanRatings(logsDir);
  const card = computeAgentTrustScore(verifiedRuns, ratings);

  console.log(`\n=== Agent Trust Scorecard ===`);
  console.log(`Trust Score:       ${card.trustScore}/100`);
  console.log(`Autonomy Tier:     ${card.tier}`);
  console.log(`Verified Runs:     ${card.runsAnalyzed} (${card.slicesAnalyzed} slices, ${card.ratedRunsCount} human-rated)`);
  console.log(`First-Pass Rate:   ${card.firstPassRate}%`);
  console.log(`Integrity Rate:    ${card.integrityRate}%`);
  console.log(`Stability Rate:    ${card.stabilityRate}%`);
  console.log(`Delivery Rate:     ${card.deliveryRate}%`);
  console.log(
    `Human Approval:    ${card.humanApprovalRate !== null ? `${card.humanApprovalRate}%` : "unrated (use `npm --prefix .sandcastle run rate`)"}`,
  );
  console.log(`Diagnostic Lever:  ${card.diagnosticLever}`);
  if (skippedMissingFiles > 0) {
    console.log(`Ignored ${skippedMissingFiles} history line(s) missing local artifact files.`);
  }

  const status =
    card.tier === "Goal Autonomy Ready (Level 2)"
      ? "success"
      : card.tier === "Factory Ready (Level 1)"
        ? "proposal"
        : "attention";

  const htmlPath = writePmHtmlReport({
    kind: "trust",
    slug: "agent-scorecard",
    title: `Agent Trust Scorecard — ${card.trustScore}/100`,
    status,
    statusLabel: `${card.trustScore}/100 · ${card.tier}`,
    executiveSummary: `${card.reasons.join(" ")} Primary lever: ${card.diagnosticLever}`,
    metrics: [
      { label: "Agent Trust Score", value: `${card.trustScore}/100`, note: card.tier },
      { label: "Integrity Rate", value: `${card.integrityRate}%`, note: "Zero test-tamper rate" },
      { label: "First-Pass Rate", value: `${card.firstPassRate}%`, note: `${card.slicesAnalyzed} slices` },
      {
        label: "Human Approval",
        value: card.humanApprovalRate !== null ? `${card.humanApprovalRate}%` : "Unrated",
        note: `${card.ratedRunsCount} rated run(s)`,
      },
    ],
    sections: [
      {
        heading: "Trust Dimensions Breakdown",
        table: {
          headers: ["Dimension", "Score", "Meaning"],
          rows: [
            ["Integrity Rate", `${card.integrityRate}%`, "Slices with zero test_guard / shortcut blocks"],
            ["Delivery Rate", `${card.deliveryRate}%`, "Slices merged cleanly into main"],
            ["Stability Rate", `${card.stabilityRate}%`, "Slices finishing without drift splits or escalation"],
            ["First-Pass Rate", `${card.firstPassRate}%`, "Slices approved on attempt 1 with zero fix loops"],
            [
              "Human Reality Check",
              card.humanApprovalRate !== null ? `${card.humanApprovalRate}%` : "Not yet rated",
              "Post-review verdicts logged via `npm --prefix .sandcastle run rate`",
            ],
          ],
        },
      },
      {
        heading: "Recommended Next Action",
        bullets: [...card.reasons, `Highest-leverage improvement: ${card.diagnosticLever}`],
      },
    ],
  }, logsDir);

  console.log(`\nPM HTML Trust Report: ${htmlPath}`);
}

main();
