/**
 * Bounded Pre-Flight Prior-Art Research & Fresh-Context Summarizer (`.sandcastle/prior-art.ts`).
 *
 * Sits between `/grill-with-docs` and Sandcastle execution so new subsystems, parsers, or
 * tooling guards check existing GitHub/PyPI/npm prior art before building from scratch:
 *   - Non-skippable by default; skipping requires an explicit narrow exemption
 *     (bug fix, repo-context-only domain change, or small internal refactor).
 *   - 4 bounded depth tiers: `fast`, `standard`, `deep`, and `deep-synthesis`
 *     (2 independent parallel research passes + fresh-context Summarizer).
 *   - Compresses findings into a strict <= 30-line Prior-Art Decision Card so downstream
 *     Builders never suffer context rot.
 *   - Pauses for human approval ONLY when recommending a new external dependency (`adopt`);
 *     auto-proceeds for `borrow` (borrow pattern) or `build` (custom build).
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import { createAgent, createDockerSandbox } from "./agent-factory.js";

export const ResearchDepthSchema = z.enum([
  "auto",
  "skip",
  "fast",
  "standard",
  "deep",
  "deep-synthesis",
]);

export type ResearchDepth = z.infer<typeof ResearchDepthSchema>;
export type ActiveResearchDepth = "fast" | "standard" | "deep" | "deep-synthesis";

export interface ResearchProfile {
  readonly rounds: number;
  readonly maxMinutes: number;
  readonly parallelPasses: 1 | 2;
  readonly useSummarizer: boolean;
}

export const RESEARCH_PROFILES: Record<ActiveResearchDepth, ResearchProfile> = {
  fast: { rounds: 1, maxMinutes: 3, parallelPasses: 1, useSummarizer: false },
  standard: { rounds: 2, maxMinutes: 8, parallelPasses: 1, useSummarizer: false },
  deep: { rounds: 3, maxMinutes: 15, parallelPasses: 1, useSummarizer: true },
  "deep-synthesis": { rounds: 3, maxMinutes: 25, parallelPasses: 2, useSummarizer: true },
};

export const PriorArtCardSchema = z.object({
  verdict: z.enum(["adopt", "borrow", "build"]),
  summary: z.string().min(1),
  requiresDependencyApproval: z.boolean(),
  recommendedPackages: z.array(z.string().min(1)).max(5).default([]),
  borrowedPatterns: z.array(z.string().min(1)).max(5).default([]),
  rejectedAlternatives: z.array(z.string().min(1)).max(5).default([]),
  nextStep: z.string().min(1),
});

export type PriorArtCard = z.infer<typeof PriorArtCardSchema>;

export interface ResearchRecommendation {
  readonly depth: ResearchDepth;
  readonly skippable: boolean;
  readonly reason: string;
}

const DEEP_KEYWORDS = /\b(architect|engine|orchestrat|sandbox|pipeline|framework|multi-agent|benchmark|parser|ast|linter|guard)\b/iu;
const SYNTHESIS_KEYWORDS = /\b(subsystem|platform|cross-language|polyglot|end-to-end|hybrid)\b/iu;

/**
 * Post-grill deterministic classifier that recommends a research depth for human confirmation/override.
 * Never skips unless one of the 3 narrow exemptions explicitly applies.
 */
export function recommendResearchDepth(input: {
  readonly title: string;
  readonly description: string;
  readonly isBugFix?: boolean;
  readonly isRepoContextOnly?: boolean;
  readonly isInternalRefactor?: boolean;
}): ResearchRecommendation {
  if (input.isBugFix) {
    return { depth: "skip", skippable: true, reason: "Exempt: targeted bug or regression fix." };
  }
  if (input.isRepoContextOnly) {
    return {
      depth: "skip",
      skippable: true,
      reason: "Exempt: repo-context-only business rule, fixture, or docs change.",
    };
  }
  if (input.isInternalRefactor) {
    return {
      depth: "skip",
      skippable: true,
      reason: "Exempt: small mechanical refactor or internal de-duplication.",
    };
  }

  const combined = `${input.title} ${input.description}`;
  if (SYNTHESIS_KEYWORDS.test(combined)) {
    return {
      depth: "deep-synthesis",
      skippable: false,
      reason: "Multi-part or cross-language subsystem warrants 2 independent research passes + Summarizer.",
    };
  }
  if (DEEP_KEYWORDS.test(combined)) {
    return {
      depth: "deep",
      skippable: false,
      reason: "New tooling/parser/guard capability benefits from deep repo & license comparison.",
    };
  }
  return {
    depth: "standard",
    skippable: false,
    reason: "Default 2-round scan (breadth + spec fit) to check mature GitHub prior art before building.",
  };
}

export function shouldPauseForDependencyApproval(card: PriorArtCard): boolean {
  return card.verdict === "adopt" || card.requiresDependencyApproval;
}

export function priorArtCardPath(slug: string, logsDir = path.join(".sandcastle", "logs")): string {
  const safeSlug = slug.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, "-") || "goal";
  return path.join(logsDir, `prior-art-${safeSlug}.md`);
}

export function hasPriorArtDecisionCard(
  slug: string,
  logsDir = path.join(".sandcastle", "logs"),
): boolean {
  return existsSync(priorArtCardPath(slug, logsDir));
}

/**
 * Renders a strictly compressed <= 30-line Prior-Art Decision Card so downstream
 * Builder containers stay well inside the 130k smart-zone context cap.
 */
export function renderPriorArtDecisionCard(
  slug: string,
  depth: ActiveResearchDepth,
  card: PriorArtCard,
): string {
  const profile = RESEARCH_PROFILES[depth];
  const lines: string[] = [
    `# Prior-Art Decision Card: ${slug}`,
    `- **Verdict:** ${card.verdict.toUpperCase()} | **Depth:** ${depth} (${profile.parallelPasses}x pass, <= ${profile.maxMinutes}m)`,
    `- **Approval Gate:** ${shouldPauseForDependencyApproval(card) ? "PAUSE — human approval required for new dependency" : "AUTO-PROCEED (zero new external dependencies)"}`,
    `- **Summary:** ${card.summary.replaceAll(/\s+/gu, " ").trim().slice(0, 240)}`,
  ];

  if (card.recommendedPackages.length > 0) {
    lines.push("## Adoptable Packages");
    for (const pkg of card.recommendedPackages.slice(0, 4)) {
      lines.push(`- ${pkg.replaceAll(/\s+/gu, " ").trim().slice(0, 140)}`);
    }
  }
  if (card.borrowedPatterns.length > 0) {
    lines.push("## Patterns to Borrow");
    for (const pat of card.borrowedPatterns.slice(0, 4)) {
      lines.push(`- ${pat.replaceAll(/\s+/gu, " ").trim().slice(0, 140)}`);
    }
  }
  if (card.rejectedAlternatives.length > 0) {
    lines.push("## Rejected Alternatives");
    for (const rej of card.rejectedAlternatives.slice(0, 4)) {
      lines.push(`- ${rej.replaceAll(/\s+/gu, " ").trim().slice(0, 140)}`);
    }
  }
  lines.push(`- **Next Step:** ${card.nextStep.replaceAll(/\s+/gu, " ").trim().slice(0, 200)}`);

  return lines.slice(0, 30).join("\n") + "\n";
}

export function writePriorArtDecisionCard(
  slug: string,
  depth: ActiveResearchDepth,
  card: PriorArtCard,
  logsDir = path.join(".sandcastle", "logs"),
): string {
  mkdirSync(logsDir, { recursive: true });
  const filePath = priorArtCardPath(slug, logsDir);
  writeFileSync(filePath, renderPriorArtDecisionCard(slug, depth, card), "utf8");
  return filePath;
}

export async function runPreflightPriorArtResearch(params: {
  readonly name: string;
  readonly slug: string;
  readonly specFile?: string;
  readonly researchDepth: ResearchDepth;
  readonly skipResearchReason?: string;
  readonly imageName: string;
}): Promise<{
  readonly pausedForApproval: boolean;
  readonly cardPath?: string;
}> {
  if (params.researchDepth === "skip") {
    console.log(
      `Prior-art research skipped (${params.skipResearchReason ?? "explicit skip in goal.json"}).`,
    );
    return { pausedForApproval: false };
  }
  if (hasPriorArtDecisionCard(params.slug)) {
    const existing = priorArtCardPath(params.slug);
    console.log(`Reusing existing Prior-Art Decision Card: ${existing}`);
    return { pausedForApproval: false, cardPath: existing };
  }

  const specText =
    params.specFile && existsSync(params.specFile) ? readFileSync(params.specFile, "utf8") : "";
  const recommended =
    params.researchDepth === "auto"
      ? recommendResearchDepth({ title: params.name, description: specText }).depth
      : params.researchDepth;
  if (recommended === "skip" || recommended === "auto") {
    return { pausedForApproval: false };
  }
  const resolvedDepth: ActiveResearchDepth = recommended;
  const profile = RESEARCH_PROFILES[resolvedDepth];

  console.log(
    `\n--> Running Pre-Flight Prior-Art Research (depth=${resolvedDepth}, passes=${profile.parallelPasses}, cap=${profile.maxMinutes}m)...`,
  );

  const runPass = async (passName: string, angle: string): Promise<PriorArtCard> => {
    const res = await sandcastle.run({
      sandbox: createDockerSandbox(params.imageName),
      name: `Prior-Art ${passName} (${params.slug})`,
      agent: createAgent(resolvedDepth === "fast" ? "medium" : "high"),
      prompt: [
        `Perform bounded Prior-Art Research (${profile.rounds} round(s), max ${profile.maxMinutes}m) for goal: ${params.name}.`,
        `Focus angle: ${angle}`,
        specText ? `Frozen Spec:\n${specText.slice(0, 3000)}` : "",
        `Do NOT edit repository files. Return ONLY JSON inside <prior-art> tags matching: verdict (adopt|borrow|build), summary, requiresDependencyApproval, recommendedPackages, borrowedPatterns, rejectedAlternatives, nextStep.`,
        `Then output <promise>COMPLETE</promise>.`,
      ]
        .filter(Boolean)
        .join("\n\n"),
      maxIterations: profile.rounds,
      output: Output.object({ tag: "prior-art", schema: PriorArtCardSchema, maxRetries: 2 }),
    });
    return res.output;
  };

  let finalCard: PriorArtCard;
  if (profile.parallelPasses === 2) {
    const [passA, passB] = await Promise.all([
      runPass("Pass-A (Adoptable Libraries)", "Identify mature GitHub/PyPI/npm libraries we could adopt cleanly."),
      runPass("Pass-B (Borrow / Minimal Custom)", "Identify battle-tested patterns to borrow for a zero/low-dependency custom build."),
    ]);
    const synth = await sandcastle.run({
      sandbox: createDockerSandbox(params.imageName),
      name: `Prior-Art Summarizer (${params.slug})`,
      agent: createAgent("medium"),
      prompt: [
        `Distill these two independent Prior-Art Research passes into ONE crisp, unambiguous decision so downstream Builders do not get confused by excess context.`,
        `Pass A (Libraries):\n${JSON.stringify(passA, null, 2)}`,
        `Pass B (Borrow/Custom):\n${JSON.stringify(passB, null, 2)}`,
        `Do NOT edit repository files. Return ONLY the consolidated JSON inside <prior-art> tags, then <promise>COMPLETE</promise>.`,
      ].join("\n\n"),
      maxIterations: 1,
      output: Output.object({ tag: "prior-art", schema: PriorArtCardSchema, maxRetries: 2 }),
    });
    finalCard = synth.output;
  } else {
    finalCard = await runPass("Scout", "Compare top existing GitHub/PyPI/npm solutions vs. borrowing patterns vs. custom build.");
  }

  const cardPath = writePriorArtDecisionCard(params.slug, resolvedDepth, finalCard);
  console.log(`Prior-Art Decision Card saved (<= 30 lines): ${cardPath} (verdict=${finalCard.verdict})`);

  if (shouldPauseForDependencyApproval(finalCard)) {
    console.warn(
      `\n[PAUSE] Prior-Art Research recommended adopting a new external dependency (${finalCard.recommendedPackages.join(", ") || "see card"}).\n` +
        `Review ${cardPath} and approve before re-running goal.`,
    );
    return { pausedForApproval: true, cardPath };
  }
  return { pausedForApproval: false, cardPath };
}
