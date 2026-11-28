import assert from "node:assert/strict";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { GoalContractSchema } from "./goal-core.js";
import {
  hasPriorArtDecisionCard,
  recommendResearchDepth,
  renderPriorArtDecisionCard,
  shouldPauseForDependencyApproval,
  writePriorArtDecisionCard,
} from "./prior-art.js";

test("recommendResearchDepth refuses to skip by default and enforces narrow exemptions", () => {
  // Narrow exemptions allow skip
  const bugFix = recommendResearchDepth({
    title: "Fix NaN parsing in watchdog",
    description: "Guard blank env vars",
    isBugFix: true,
  });
  assert.equal(bugFix.depth, "skip");
  assert.equal(bugFix.skippable, true);

  const repoOnly = recommendResearchDepth({
    title: "Add new order triage rule",
    description: "Update order_triage.py allowlist check",
    isRepoContextOnly: true,
  });
  assert.equal(repoOnly.depth, "skip");

  // Non-exempt work MUST recommend an active research depth
  const guardTask = recommendResearchDepth({
    title: "Build Anti-Bloat Guard",
    description: "Detect dead code and clones across Python and TypeScript",
  });
  assert.equal(guardTask.skippable, false);
  assert.equal(guardTask.depth, "deep");

  const polyglotSubsystem = recommendResearchDepth({
    title: "Design hybrid polyglot verification subsystem",
    description: "End-to-end multi-language static analysis",
  });
  assert.equal(polyglotSubsystem.depth, "deep-synthesis");
});

test("renderPriorArtDecisionCard enforces <= 30-line cap and dependency approval pause gate", () => {
  const adoptCard = {
    verdict: "adopt" as const,
    summary: "Adopt vulture + knip + jscpd instead of custom regexes.",
    requiresDependencyApproval: true,
    recommendedPackages: ["vulture", "knip", "jscpd"],
    borrowedPatterns: ["monotonic file-size ceilings"],
    rejectedAlternatives: ["pmd-cpd (requires JVM)"],
    nextStep: "Add dev dependencies and wire into CI.",
  };
  assert.equal(shouldPauseForDependencyApproval(adoptCard), true);

  const borrowCard = {
    ...adoptCard,
    verdict: "borrow" as const,
    requiresDependencyApproval: false,
    recommendedPackages: [],
  };
  assert.equal(shouldPauseForDependencyApproval(borrowCard), false);

  const rendered = renderPriorArtDecisionCard("anti-bloat", "deep-synthesis", adoptCard);
  const lineCount = rendered.trim().split("\n").length;
  assert.ok(lineCount <= 30, `Decision Card exceeded 30 lines: ${lineCount}`);
  assert.ok(rendered.includes("PAUSE — human approval required"));

  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-prior-art-"));
  try {
    assert.equal(hasPriorArtDecisionCard("anti-bloat", tmp), false);
    const savedPath = writePriorArtDecisionCard("anti-bloat", "deep-synthesis", adoptCard, tmp);
    assert.equal(hasPriorArtDecisionCard("anti-bloat", tmp), true);
    assert.ok(readFileSync(savedPath, "utf8").includes("Adoptable Packages"));
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }

  const parsedContract = GoalContractSchema.parse({
    name: "Hybrid Guard",
    slug: "hybrid-guard",
    researchDepth: "deep-synthesis",
    verifyCommands: ["python scripts/check.py"],
  });
  assert.equal(parsedContract.researchDepth, "deep-synthesis");
});
