/**
 * Overnight Architecture PR Bot (`npm --prefix .sandcastle run nightly-arch`).
 *
 * Implements Matt Pocock's `$improve-codebase-architecture` discipline on a schedule:
 *   1. Ranks high-churn files from recent git history (YAGNI — never refactors cold files).
 *   2. Wakes a fresh Architecture Scout container proposing AT MOST 1–2 deepening refactors.
 *   3. Operates in two modes:
 *      - `--mode tickets` (default, safest): writes a markdown report + `needs-triage` local tickets.
 *      - `--mode draft-branch`: builds each refactor on an isolated `arch/nightly-<slug>` branch,
 *        runs all 6 gates (`scripts/check.py`) + Fresh Adversarial Reviewer, keeps ONLY 100%-green
 *        branches, and optionally opens Draft PRs via `gh pr create --draft` (`--open-prs`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { docker } from "@ai-hero/sandcastle/sandboxes/docker";
import { z } from "zod";

const MODEL = process.env["CODEX_MODEL"] ?? "gpt-5.4";
const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";

export const ArchProposalSchema = z.object({
  slug: z.string().regex(/^[a-z0-9-]+$/u),
  title: z.string().min(1),
  strength: z.enum(["strong", "worth_exploring"]),
  files: z.array(z.string().min(1)).min(1),
  problem: z.string().min(1),
  solution: z.string().min(1),
  benefits: z.string().min(1),
  acceptance_criteria: z.array(z.string().min(1)).min(1),
});

export const ArchProposalsResponseSchema = z.object({
  proposals: z.array(ArchProposalSchema).max(2),
});

export type ArchProposal = z.infer<typeof ArchProposalSchema>;

export interface HotspotEntry {
  readonly file: string;
  readonly touches: number;
}

export function rankChurnHotspots(gitLogNamesOutput: string, limit = 12): HotspotEntry[] {
  const counts = new Map<string, number>();
  for (const raw of gitLogNamesOutput.split(/\r?\n/u)) {
    const file = raw.trim();
    if (!file || !file.endsWith(".py") || file.startsWith("tests_tooling/")) continue;
    counts.set(file, (counts.get(file) ?? 0) + 1);
  }
  return [...counts.entries()]
    .map(([file, touches]) => ({ file, touches }))
    .sort((a, b) => b.touches - a.touches || a.file.localeCompare(b.file))
    .slice(0, limit);
}

export function writeProposalsAsNeedsTriageTickets(
  proposals: readonly ArchProposal[],
  rootDir = process.cwd(),
): string[] {
  const issuesDir = path.join(rootDir, ".scratch", "nightly-arch", "issues");
  mkdirSync(issuesDir, { recursive: true });
  const existing = readdirSync(issuesDir).filter((f) => /^\d+-.*\.md$/u.test(f));
  let nextNum =
    existing.reduce((m, name) => Math.max(m, Number.parseInt(name.split("-")[0] ?? "0", 10)), 0) + 1;

  const createdPaths: string[] = [];
  for (const p of proposals) {
    const numStr = String(nextNum).padStart(2, "0");
    const filename = `${numStr}-${p.slug}.md`;
    const body = [
      `# ${numStr}: ${p.title}`,
      "",
      `**What to build:** ${p.solution}`,
      "",
      `**Why (architecture friction):** ${p.problem}`,
      "",
      `**Expected benefit:** ${p.benefits}`,
      "",
      `**Target files:** ${p.files.join(", ")}`,
      "",
      "**Blocked by:** None (can start immediately)",
      "",
      "**Status:** needs-triage",
      "",
      ...p.acceptance_criteria.map((c) => `- [ ] ${c}`),
      "",
    ].join("\n");
    const absPath = path.join(issuesDir, filename);
    writeFileSync(absPath, body, "utf8");
    createdPaths.push(path.relative(rootDir, absPath).replaceAll("\\", "/"));
    nextNum += 1;
  }
  return createdPaths;
}

export function renderNightlyArchReport(
  dateTag: string,
  hotspots: readonly HotspotEntry[],
  proposals: readonly ArchProposal[],
  branchResults: readonly { readonly slug: string; readonly branch: string; readonly passed: boolean }[],
): string {
  const lines: string[] = [
    `# Overnight Architecture Report (${dateTag})`,
    "",
    "## High-Churn Hot Spots Scanned",
    "",
    ...(hotspots.length === 0
      ? ["- _(No recent Python churn found; scanned full `src/`.)_"]
      : hotspots.map((h) => `- \`${h.file}\` (${h.touches} recent commits)`)),
    "",
    `## Proposed Deepening Refactors (${proposals.length})`,
    "",
  ];

  if (proposals.length === 0) {
    lines.push("No high-leverage deepening refactors needed tonight.");
  } else {
    for (const p of proposals) {
      const br = branchResults.find((b) => b.slug === p.slug);
      const statusBadge = br ? (br.passed ? ` · Verified branch \`${br.branch}\`` : " · Draft attempt failed (discarded)") : "";
      lines.push(
        `### ${p.title} (\`${p.strength}\`${statusBadge})`,
        "",
        `- **Files:** ${p.files.map((f) => `\`${f}\``).join(", ")}`,
        `- **Problem:** ${p.problem}`,
        `- **Solution:** ${p.solution}`,
        `- **Benefits:** ${p.benefits}`,
        "",
      );
    }
  }
  return lines.join("\n") + "\n";
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

function parseCliArgs(argv: readonly string[]): {
  readonly maxProposals: number;
  readonly mode: "tickets" | "draft-branch";
  readonly openPrs: boolean;
} {
  let maxProposals = 2;
  let mode: "tickets" | "draft-branch" = "tickets";
  let openPrs = false;
  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--max" && next) {
      maxProposals = Math.min(2, Math.max(1, Number(next)));
      i += 1;
    } else if (arg === "--mode" && (next === "tickets" || next === "draft-branch")) {
      mode = next;
      i += 1;
    } else if (arg === "--open-prs") {
      openPrs = true;
    }
  }
  return { maxProposals, mode, openPrs };
}

async function main(): Promise<void> {
  const { maxProposals, mode, openPrs } = parseCliArgs(process.argv.slice(2));
  const dateTag = new Date().toISOString().slice(0, 10);

  let gitLogOut = "";
  try {
    gitLogOut = execFileSync("git", ["log", "-n", "40", "--pretty=format:", "--name-only"], {
      encoding: "utf8",
    });
  } catch {
    gitLogOut = "";
  }
  const hotspots = rankChurnHotspots(gitLogOut);
  const hotspotsText =
    hotspots.map((h) => `- ${h.file} (${h.touches} touches)`).join("\n") ||
    "(No recent git history — scan src/ organically)";

  console.log(`\n=== Overnight Architecture Bot (${mode}, max=${maxProposals}) ===`);
  const scoutRun = await sandcastle.run({
    sandbox: makeDocker(),
    name: "Architecture Scout",
    agent: sandcastle.codex(MODEL, {
      effort: "high",
      approvalsReviewer: "auto_review",
      captureSessions: true,
    }),
    promptFile: "./.sandcastle/nightly-arch-prompt.md",
    promptArgs: {
      MAX_PROPOSALS: String(maxProposals),
      HOTSPOTS_SUMMARY: hotspotsText,
    },
    output: Output.object({
      tag: "proposals",
      schema: ArchProposalsResponseSchema,
      maxRetries: 2,
    }),
  });

  const proposals = scoutRun.output.proposals.slice(0, maxProposals);
  const branchResults: { slug: string; branch: string; passed: boolean }[] = [];

  if (mode === "tickets" && proposals.length > 0) {
    const created = writeProposalsAsNeedsTriageTickets(proposals);
    console.log(`Created ${created.length} needs-triage ticket(s):`, created.join(", "));
  }

  if (mode === "draft-branch") {
    for (const p of proposals) {
      const branch = `arch/nightly-${dateTag}-${p.slug}`;
      console.log(`\n--> Building draft architecture branch: ${branch}`);
      let passed = false;
      await using sandbox = await sandcastle.createSandbox({
        sandbox: makeDocker(),
        branch,
      });

      await sandbox.run({
        name: `Arch-Refactor ${p.slug}`,
        agent: sandcastle.codex(MODEL, {
          effort: "medium",
          approvalsReviewer: "auto_review",
          captureSessions: true,
        }),
        prompt: [
          `Implement this behavior-preserving deepening refactor on branch ${branch}:`,
          `Title: ${p.title}`,
          `Files: ${p.files.join(", ")}`,
          `Problem: ${p.problem}`,
          `Solution: ${p.solution}`,
          `Rules: NEVER delete or weaken existing tests or fixtures. Run \`python scripts/check.py\` before committing with prefix \`RALPH: Arch -\`. Output <promise>COMPLETE</promise>.`,
        ].join("\n"),
        maxIterations: 3,
      });

      const guard = await sandbox.exec("python scripts/test_guard.py --base main");
      const check = await sandbox.exec("python scripts/check.py");
      passed = guard.exitCode === 0 && check.exitCode === 0;
      branchResults.push({ slug: p.slug, branch, passed });

      if (passed && openPrs) {
        try {
          execFileSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
          execFileSync(
            "gh",
            [
              "pr",
              "create",
              "--draft",
              "--head",
              branch,
              "--title",
              `refactor(arch): ${p.title}`,
              "--body",
              `## Summary\n${p.solution}\n\n## Problem\n${p.problem}\n\n## Benefits\n${p.benefits}\n\n## Verification\nAll 6 gates (\`python scripts/check.py\`) passed inside Sandcastle Docker.`,
            ],
            { stdio: "inherit" },
          );
        } catch (err) {
          console.warn(`Could not open draft PR for ${branch}:`, err);
        }
      } else if (!passed) {
        try {
          execFileSync("git", ["branch", "-D", branch], { stdio: "ignore" });
        } catch {
          // ignore
        }
      }
    }
  }

  const logsDir = path.join(".sandcastle", "logs");
  mkdirSync(logsDir, { recursive: true });
  const reportPath = path.join(logsDir, `nightly-arch-${dateTag}.md`);
  writeFileSync(reportPath, renderNightlyArchReport(dateTag, hotspots, proposals, branchResults), "utf8");
  console.log(`\nNightly architecture report saved to: ${reportPath}`);
}

if (import.meta.url === `file://${process.argv[1]?.replaceAll("\\", "/")}`) {
  await main();
}
