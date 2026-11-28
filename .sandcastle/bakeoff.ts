/**
 * Parallel "Design It Twice" Prototype Bake-Off (`npm --prefix .sandcastle run bakeoff`).
 *
 * Implements Matt Pocock's `Design It Twice` + Sandcastle `session.fork()` fan-out:
 *   1. Shared Exploration (`parent` run) reads the codebase, GLOSSARY.md, ADRs, and fixtures once.
 *   2. Parallel `parent.fork()` spawns 3 radically different variants on isolated `prototype/*` branches:
 *        - Variant A: Minimal deep module (1–2 entry points max, smallest line count)
 *        - Variant B: Declarative / data-driven rule table (extensible without branching sprawl)
 *        - Variant C: Strict ports & adapters (maximal boundary isolation & explicit error states)
 *   3. Deterministic 6-Gate Referee scores every variant (pass/fail, diff lines, coverage %, mutation kill %).
 *   4. Fresh-Context Adversarial Judge (`high` effort + CODING_STANDARDS.md) ranks all 3 variants
 *      and writes `.sandcastle/logs/bakeoff-<slug>-YYYY-MM-DD.md` — leaving branches ready for your pick!
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import { formatEndOfRunFooter } from "./coach.js";
import { parseCheckMetrics } from "./dashboard.js";
import { DriftWatchdog, parseGitNumstat } from "./drift-watchdog.js";
import { writePmHtmlReport } from "./pm-report.js";
import { REPO_MUTATION_LOCK, acquireRunLock, assertCleanGitWorktree } from "./preflight.js";
import { installGracefulShutdown, withTransientRetry } from "./resilience.js";

const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";

export interface BakeoffVariantSpec {
  readonly label: "A" | "B" | "C";
  readonly name: string;
  readonly constraint: string;
}

export const DEFAULT_VARIANTS: readonly BakeoffVariantSpec[] = [
  {
    label: "A",
    name: "Minimal Deep Module",
    constraint:
      "Minimize the interface: 1–2 public functions max, smallest total line count, zero speculative abstractions or class hierarchies. Maximize leverage per entry point.",
  },
  {
    label: "B",
    name: "Declarative Rule Table",
    constraint:
      "Model rules declaratively using small typed rule tables/predicates so adding a new case requires adding one table entry rather than nested if/else chains.",
  },
  {
    label: "C",
    name: "Strict Ports & Typed States",
    constraint:
      "Optimize for explicit typed boundary states and fail-closed clarity: isolate parsing/normalization cleanly behind explicit immutable domain dataclasses.",
  },
];

export interface VariantScorecard {
  readonly variant: "A" | "B" | "C";
  readonly name: string;
  readonly branch: string;
  readonly checkPassed: boolean;
  readonly diffFiles: number;
  readonly diffLines: number;
  readonly coveragePercent: number | null;
  readonly mutationScore: number | null;
  readonly deterministicRankScore: number;
}

export const BakeoffJudgementSchema = z.object({
  winner: z.enum(["A", "B", "C"]),
  ranking: z
    .array(
      z.object({
        variant: z.enum(["A", "B", "C"]),
        branch: z.string().min(1),
        verdict: z.string().min(1),
        strengths: z.array(z.string().min(1)),
        weaknesses: z.array(z.string().min(1)),
      }),
    )
    .min(1),
  hybridRecommendation: z.string().min(1),
  mergeAction: z.string().min(1),
});

export type BakeoffJudgement = z.infer<typeof BakeoffJudgementSchema>;

/**
 * Deterministic tie-breaker / baseline score (0..100) rewarding:
 *   - Passing all 6 gates (+50)
 *   - High mutation kill score (up to +25)
 *   - High coverage (up to +15)
 *   - Concise diff size <= 200 lines (up to +10, penalizing bloat)
 */
export function computeDeterministicScore(input: {
  readonly checkPassed: boolean;
  readonly coveragePercent: number | null;
  readonly mutationScore: number | null;
  readonly diffLines: number;
}): number {
  let score = input.checkPassed ? 50 : 0;
  if (input.mutationScore !== null) {
    score += Math.min(25, (input.mutationScore / 100) * 25);
  }
  if (input.coveragePercent !== null) {
    score += Math.min(15, (input.coveragePercent / 100) * 15);
  }
  const brevityBonus =
    input.diffLines <= 200 ? 10 : Math.max(0, 10 - ((input.diffLines - 200) / 300) * 10);
  score += brevityBonus;
  return Number(score.toFixed(1));
}

export function renderBakeoffReport(
  slug: string,
  brief: string,
  scorecards: readonly VariantScorecard[],
  judgement: BakeoffJudgement,
): string {
  const lines: string[] = [
    `# Design-It-Twice Prototype Bake-Off Report: \`${slug}\``,
    "",
    `> **Problem Brief:** ${brief}`,
    `> **Adversarial Judge Winner:** **Variant ${judgement.winner}**`,
    "",
    "## Deterministic 6-Gate Comparison",
    "",
    "| Variant | Approach | Branch | 6-Gate `check.py` | Diff (files / lines) | Coverage | AST Mutation | Auto Score |",
    "| :--- | :--- | :--- | :---: | :---: | :---: | :---: | :---: |",
    ...scorecards.map(
      (s) =>
        `| **${s.variant}** | ${s.name} | \`${s.branch}\` | ${s.checkPassed ? "PASS" : "FAIL"} | ${s.diffFiles} / ${s.diffLines} | ${s.coveragePercent !== null ? `${s.coveragePercent}%` : "--"} | ${s.mutationScore !== null ? `${s.mutationScore}%` : "--"} | **${s.deterministicRankScore}** |`,
    ),
    "",
    "## Adversarial Judge Ranking",
    "",
  ];

  for (const r of judgement.ranking) {
    lines.push(
      `### Variant ${r.variant} (\`${r.branch}\`)`,
      "",
      `${r.verdict}`,
      "",
      `- **Strengths:** ${r.strengths.join("; ")}`,
      `- **Weaknesses:** ${r.weaknesses.join("; ")}`,
      "",
    );
  }

  lines.push(
    "## Hybrid Synthesis Recommendation",
    "",
    judgement.hybridRecommendation,
    "",
    "## Next Step (Human Pick)",
    "",
    judgement.mergeAction,
    "",
    "```bash",
    `# Inspect the winning branch diff before merging or reimplementing cleanly:`,
    `git diff main..prototype/${slug}-${judgement.winner.toLowerCase()}`,
    "```",
    "",
  );
  return lines.join("\n");
}

function makeDocker() {
  return createDockerSandbox(IMAGE_NAME);
}

function parseBakeoffArgs(argv: readonly string[]): { readonly slug: string; readonly brief: string } {
  let slug = "design-bakeoff";
  let brief = "";
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--slug" && next) {
      slug = next.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, "-");
      i += 1;
    } else if (arg === "--brief" && next) {
      brief = next;
      i += 1;
    }
  }
  if (!brief) {
    throw new Error('Missing required `--brief "<problem statement>"` argument.');
  }
  return { slug, brief };
}

async function main(): Promise<void> {
  assertCleanGitWorktree();
  const releaseLock = acquireRunLock(REPO_MUTATION_LOCK, "bakeoff");
  const uninstallShutdown = installGracefulShutdown(() => releaseLock());
  try {
    await runBakeoff();
  } finally {
    uninstallShutdown();
    releaseLock();
  }
}

async function runBakeoff(): Promise<void> {
  const { slug, brief } = parseBakeoffArgs(process.argv.slice(2));
  console.log(`\n=== Parallel Prototype Bake-Off: ${slug} ===`);

  // Phase 1: Shared exploration session
  const parent = await withTransientRetry(
    () =>
      sandcastle.run({
        sandbox: makeDocker(),
        name: `Bakeoff Explorer (${slug})`,
        agent: createAgent("medium"),
        prompt: [
          `Explore this repo (read GLOSSARY.md, docs/adr/, src/, and tests/) to understand the constraints for:`,
          brief,
          `Do NOT edit any files yet. Summarize the existing seams and constraints, then output <promise>COMPLETE</promise>.`,
        ].join("\n"),
        maxIterations: 1,
      }),
    { label: `Bakeoff Explorer (${slug})` },
  );

  // Phase 2: Parallel fork fan-out on 3 DISTINCT prototype branches (each guarded by DriftWatchdog)
  await Promise.allSettled(
    DEFAULT_VARIANTS.map(async (v) => {
      const branch = `prototype/${slug}-${v.label.toLowerCase()}`;
      console.log(`  --> Forking Variant ${v.label} (${v.name}) onto ${branch}`);
      if (!parent.fork) {
        throw new Error("Parent Codex session did not capture a forkable session ID.");
      }
      const watchdog = new DriftWatchdog();
      try {
        await parent.fork(
          [
            `Now build Prototype Variant ${v.label} (${v.name}) on branch ${branch}.`,
            `Problem: ${brief}`,
            `Constraint: ${v.constraint}`,
            `Rules: Follow GLOSSARY.md and ADRs. Add anonymized replay tests. NEVER delete/weaken existing tests. Run \`python scripts/check.py\`, commit with \`PROTOTYPE(${v.label}): ${slug}\`, and output <promise>COMPLETE</promise>.`,
          ].join("\n"),
          {
            branchStrategy: { type: "branch", branch },
            signal: watchdog.signal,
          },
        );
      } catch (err) {
        console.warn(
          `  [WARN] Variant ${v.label} stopped early:`,
          err instanceof Error ? err.message : String(err),
        );
      } finally {
        watchdog.dispose();
      }
    }),
  );

  // Phase 3: Parallel Deterministic 6-Gate Scoring on every variant branch
  const scored = await Promise.all(
    DEFAULT_VARIANTS.map(async (v) => {
      const branch = `prototype/${slug}-${v.label.toLowerCase()}`;
      await using sandbox = await sandcastle.createSandbox({
        sandbox: makeDocker(),
        branch,
      });
      const check = await sandbox.exec("python scripts/check.py");
      const numstat = await sandbox.exec("git diff --numstat main..HEAD");
      const diffStat = await sandbox.exec("git diff --stat main..HEAD");
      const fullDiff = await sandbox.exec("git diff main..HEAD");
      const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
      const { coveragePercent, mutationScore } = parseCheckMetrics(check.stdout);

      const card: VariantScorecard = {
        variant: v.label,
        name: v.name,
        branch,
        checkPassed: check.exitCode === 0,
        diffFiles,
        diffLines,
        coveragePercent,
        mutationScore,
        deterministicRankScore: computeDeterministicScore({
          checkPassed: check.exitCode === 0,
          coveragePercent,
          mutationScore,
          diffLines,
        }),
      };
      const diffPreview = fullDiff.stdout.trim().slice(0, 8000);
      const snippet = [
        `### Variant ${v.label} (${branch})`,
        "```",
        diffStat.stdout.trim(),
        "```",
        "```diff",
        diffPreview || "(no diff)",
        "```",
      ].join("\n");
      return { card, snippet };
    }),
  );
  const scorecards: VariantScorecard[] = scored.map((s) => s.card);
  const variantDiffSnippets: string[] = scored.map((s) => s.snippet);

  // Phase 4: Fresh-Context Adversarial Judge
  const judgeRun = await withTransientRetry(
    () =>
      sandcastle.run({
        sandbox: makeDocker(),
        name: `Bakeoff Judge (${slug})`,
        agent: createAgent("high"),
        promptFile: "./.sandcastle/bakeoff-judge-prompt.md",
        promptArgs: {
          PROBLEM_BRIEF: brief,
          SCORECARDS_JSON: JSON.stringify(scorecards, null, 2),
          VARIANT_DIFFS: variantDiffSnippets.join("\n\n"),
        },
        output: Output.object({
          tag: "judgement",
          schema: BakeoffJudgementSchema,
          maxRetries: 2,
        }),
      }),
    { label: `Bakeoff Judge (${slug})` },
  );

  const logsDir = path.join(".sandcastle", "logs");
  mkdirSync(logsDir, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10);
  const reportPath = path.join(logsDir, `bakeoff-${slug}-${dateTag}.md`);
  writeFileSync(reportPath, renderBakeoffReport(slug, brief, scorecards, judgeRun.output), "utf8");
  const htmlPath = writePmHtmlReport({
    kind: "bakeoff",
    slug,
    title: `Design-It-Twice Bake-Off: ${slug}`,
    status: "proposal",
    statusLabel: `Winner: Variant ${judgeRun.output.winner}`,
    executiveSummary: `${brief} — Adversarial Judge selected Variant ${judgeRun.output.winner}. ${judgeRun.output.hybridRecommendation}`,
    metrics: [
      { label: "Winning Variant", value: `Variant ${judgeRun.output.winner}` },
      { label: "Variants Tested", value: String(scorecards.length) },
      { label: "Passing 6-Gate", value: String(scorecards.filter((s) => s.checkPassed).length) },
    ],
    sections: [
      {
        heading: "Deterministic 6-Gate Comparison",
        table: {
          headers: ["Variant", "Approach", "6-Gate", "Diff Lines", "Coverage", "Mutation", "Score"],
          rows: scorecards.map((s) => [
            s.variant,
            s.name,
            s.checkPassed ? "PASS" : "FAIL",
            String(s.diffLines),
            s.coveragePercent !== null ? `${s.coveragePercent}%` : "--",
            s.mutationScore !== null ? `${s.mutationScore}%` : "--",
            String(s.deterministicRankScore),
          ]),
        },
      },
      {
        heading: "Next Step",
        paragraphs: [judgeRun.output.mergeAction],
      },
    ],
  });
  console.log(
    `\n=== Bake-Off Winner: Variant ${judgeRun.output.winner} ===\nReport: ${reportPath}\nPM HTML: ${htmlPath}` +
      formatEndOfRunFooter({
        kind: "bakeoff",
        reportPath: htmlPath,
        extraCommand: `git diff main..prototype/${slug}-${judgeRun.output.winner.toLowerCase()}`,
      }),
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
