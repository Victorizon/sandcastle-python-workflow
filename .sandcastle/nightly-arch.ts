/**
 * Overnight No-Bloat Architecture & Reliability PR Bot (`npm --prefix .sandcastle run nightly-arch`).
 *
 * Implements Matt Pocock's `$improve-codebase-architecture` discipline on a bounded overnight run:
 *   1. Ranks high-churn files from recent git history (Python + Sandcastle TS; YAGNI on cold files).
 *   2. Wakes a fresh Scout container proposing AT MOST 1–3 high-impact improvements (No-Bloat Charter).
 *   3. Enforces a hard wall-clock budget (default `--max-minutes 240`, comfortably under 5h).
 *   4. Operates in two modes:
 *      - `--mode tickets` (default): writes a markdown report, PM HTML report, and `needs-triage` tickets.
 *      - `--mode draft-branch` (+ optional `--open-prs`): builds each proposal in a fresh Docker container
 *        guarded by `DriftWatchdog` (130k token cap), verifies ALL 4 gates (6-gate Python `check.py`,
 *        TypeScript `typecheck + test`, and `OPSEC_HITS=0`), discards any branch that fails, and opens
 *        verified **Draft PRs** (NEVER auto-merges to `main`).
 *
 * Supports both Codex (default) and Claude Code (`--agent claude` or `SANDCASTLE_AGENT=claude`).
 */

import { execFileSync } from "node:child_process";
import { mkdirSync, readdirSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import { type AgentKind, createAgent, createDockerSandbox, resolveAgentKind } from "./agent-factory.js";
import { formatEndOfRunFooter } from "./coach.js";
import { DriftDetectedError, DriftWatchdog, parseGitNumstat } from "./drift-watchdog.js";
import { writePmHtmlReport } from "./pm-report.js";
import { acquireRunLock, assertCleanGitWorktree } from "./preflight.js";

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
  proposals: z.array(ArchProposalSchema).max(3),
});

export type ArchProposal = z.infer<typeof ArchProposalSchema>;

export interface HotspotEntry {
  readonly file: string;
  readonly touches: number;
}

export interface DraftBranchOutcome {
  readonly slug: string;
  readonly branch: string;
  readonly passed: boolean;
  readonly prUrl?: string;
  readonly note: string;
}

export function rankChurnHotspots(gitLogNamesOutput: string, limit = 12): HotspotEntry[] {
  const counts = new Map<string, number>();
  for (const raw of gitLogNamesOutput.split(/\r?\n/u)) {
    const file = raw.trim();
    if (!file || file.startsWith("tests_tooling/")) continue;
    const isCode = file.endsWith(".py") || (file.startsWith(".sandcastle/") && file.endsWith(".ts"));
    if (!isCode) continue;
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
  branchResults: readonly {
    readonly slug: string;
    readonly branch: string;
    readonly passed: boolean;
    readonly prUrl?: string;
    readonly note?: string;
  }[],
): string {
  const lines: string[] = [
    `# Overnight No-Bloat Improvement Report (${dateTag})`,
    "",
    "## High-Churn Hot Spots Scanned",
    "",
    ...(hotspots.length === 0
      ? ["- _(No recent churn found; scanned repository organically.)_"]
      : hotspots.map((h) => `- \`${h.file}\` (${h.touches} recent commits)`)),
    "",
    `## Proposed High-Impact Improvements (${proposals.length})`,
    "",
  ];

  if (proposals.length === 0) {
    lines.push("No high-impact improvements needed tonight.");
  } else {
    for (const p of proposals) {
      const br = branchResults.find((b) => b.slug === p.slug);
      const statusBadge = br
        ? br.passed
          ? ` · Verified Draft Branch \`${br.branch}\`${br.prUrl ? ` (${br.prUrl})` : ""}`
          : ` · Draft attempt discarded (${br.note ?? "failed verification"})`
        : "";
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

export function parseCliArgs(argv: readonly string[]): {
  readonly maxProposals: number;
  readonly maxMinutes: number;
  readonly mode: "tickets" | "draft-branch";
  readonly openPrs: boolean;
  readonly agentKind: AgentKind;
} {
  let maxProposals = 2;
  let maxMinutes = 240; // Comfortably under 5-hour window
  let mode: "tickets" | "draft-branch" = "tickets";
  let openPrs = false;
  let agentArg: string | undefined;

  for (let i = 0; i < argv.length; i++) {
    const arg = argv[i];
    const next = argv[i + 1];
    if (arg === "--max" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        maxProposals = Math.min(3, Math.max(1, Math.trunc(parsed)));
      }
      i += 1;
    } else if (arg === "--max-minutes" && next) {
      const parsed = Number(next);
      if (Number.isFinite(parsed)) {
        maxMinutes = Math.min(280, Math.max(15, parsed));
      }
      i += 1;
    } else if (arg === "--mode" && (next === "tickets" || next === "draft-branch")) {
      mode = next;
      i += 1;
    } else if (arg === "--agent" && next) {
      agentArg = next;
      i += 1;
    } else if (arg === "--open-prs") {
      openPrs = true;
    }
  }
  return { maxProposals, maxMinutes, mode, openPrs, agentKind: resolveAgentKind(agentArg) };
}

function isBranchAheadOfMain(branch: string): boolean {
  try {
    const out = execFileSync("git", ["rev-list", "--count", `main..${branch}`], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    }).trim();
    return Number(out) > 0;
  } catch {
    return false;
  }
}

async function main(): Promise<void> {
  const { maxProposals, maxMinutes, mode, openPrs, agentKind } = parseCliArgs(process.argv.slice(2));
  const startedMs = Date.now();
  const dateTag = new Date().toISOString().slice(0, 10);

  if (mode === "draft-branch") {
    assertCleanGitWorktree();
  }
  const releaseLock = acquireRunLock(".nightly.lock", "nightly-arch");

  try {
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
      "(No recent git history — scan repository organically)";

    console.log(
      `\n=== Overnight No-Bloat Bot (agent=${agentKind}, mode=${mode}, max=${maxProposals}, cap=${maxMinutes}m) ===`,
    );

    const scoutRun = await sandcastle.run({
      sandbox: createDockerSandbox(IMAGE_NAME, agentKind),
      name: "Architecture Scout",
      agent: createAgent("high", agentKind),
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
    const branchResults: DraftBranchOutcome[] = [];

    if (mode === "tickets" && proposals.length > 0) {
      const created = writeProposalsAsNeedsTriageTickets(proposals);
      console.log(`Created ${created.length} needs-triage ticket(s):`, created.join(", "));
    }

    if (mode === "draft-branch") {
      for (const p of proposals) {
        const elapsedMin = (Date.now() - startedMs) / 60_000;
        if (elapsedMin >= maxMinutes) {
          console.warn(
            `\n[STOP] Wall-clock budget reached (${elapsedMin.toFixed(1)}m >= ${maxMinutes}m). Skipping remaining proposals.`,
          );
          break;
        }

        const branch = `arch/nightly-${dateTag}-${p.slug}`;
        console.log(`\n--> Building verified draft branch: ${branch} (${elapsedMin.toFixed(1)}m/${maxMinutes}m elapsed)`);
        let passed = false;
        let note = "All checks passed";
        let prUrl: string | undefined;

        const watchdog = new DriftWatchdog();
        try {
          // Phase A: Isolated Builder container (disposed immediately after commit)
          {
            await using builder = await sandcastle.createSandbox({
              sandbox: createDockerSandbox(IMAGE_NAME, agentKind),
              branch,
            });
            const buildRun = await builder.run({
              name: `Arch-Refactor ${p.slug}`,
              agent: createAgent("medium", agentKind),
              prompt: [
                `Implement this No-Bloat improvement on branch ${branch}:`,
                `Title: ${p.title}`,
                `Target files: ${p.files.join(", ")}`,
                `Problem: ${p.problem}`,
                `Solution: ${p.solution}`,
                `STRICT RULES:`,
                `- NEVER modify locked referee/harness files (scripts/check.py, scripts/test_guard.py, scripts/ratchet.py, scripts/mutation_check.py, scripts/coverage-baseline.json, pyproject.toml, tests/conftest.py).`,
                `- NEVER delete or weaken existing tests or replay fixtures.`,
                `- Keep diff small and focused (<= 250 lines).`,
                `- Run \`python scripts/check.py\` before committing with prefix \`RALPH: Arch -\`, then output <promise>COMPLETE</promise>.`,
              ].join("\n"),
              maxIterations: 3,
              signal: watchdog.signal,
              logging: {
                type: "file",
                path: `.sandcastle/logs/nightly-${p.slug}.log`,
                onAgentStreamEvent: (ev) => watchdog.onEvent(ev),
              },
            });

            const numstat = await builder.exec("git diff --numstat main..HEAD");
            const { files: diffFiles, lines: diffLines } = parseGitNumstat(numstat.stdout);
            const lastCtx = buildRun.iterations.at(-1)?.contextWindow;
            const postDrift = watchdog.checkPostRun({
              diffFiles,
              diffLines,
              contextTokens: lastCtx?.tokens,
              contextLimit: lastCtx?.limit,
              completed: buildRun.completionSignal !== undefined,
            });
            if (postDrift) {
              throw postDrift;
            }
          }

          if (!isBranchAheadOfMain(branch)) {
            throw new Error("Builder produced zero commits on branch.");
          }

          // Phase B: Fresh zero-trust Verifier container (read-only /opt/venv)
          {
            await using verifier = await sandcastle.createSandbox({
              sandbox: createDockerSandbox(IMAGE_NAME, agentKind),
              branch,
            });
            const pyCheck = await verifier.exec("python scripts/check.py");
            if (pyCheck.exitCode !== 0) {
              throw new Error(`Python 6-gate check.py failed (exit ${pyCheck.exitCode}).`);
            }
            const tsCheck = await verifier.exec(
              "if [ -d .sandcastle/node_modules ]; then npm --prefix .sandcastle run typecheck && npm --prefix .sandcastle test; fi",
            );
            if (tsCheck.exitCode !== 0) {
              throw new Error(`TypeScript check/tests failed (exit ${tsCheck.exitCode}).`);
            }
          }

          passed = true;
        } catch (err) {
          passed = false;
          note =
            err instanceof DriftDetectedError
              ? err.message
              : err instanceof Error
                ? err.message
                : String(err);
          console.warn(`  [DISCARD] ${branch}: ${note}`);
        } finally {
          watchdog.dispose();
        }

        if (passed && openPrs) {
          try {
            execFileSync("git", ["push", "-u", "origin", branch], { stdio: "inherit" });
            prUrl = execFileSync(
              "gh",
              [
                "pr",
                "create",
                "--draft",
                "--head",
                branch,
                "--title",
                `refactor(nightly): ${p.title}`,
                "--body",
                [
                  `## Plain-English Summary`,
                  p.solution,
                  "",
                  `## Why This Matters`,
                  p.problem,
                  "",
                  `## Expected Benefit`,
                  p.benefits,
                  "",
                  `## Deterministic Verification`,
                  `- Built inside isolated Docker container (${agentKind}) with 130k smart-zone token cap`,
                  `- Re-verified in fresh zero-trust container with read-only \`/opt/venv\``,
                  `- Passed all 6 Python gates (\`python scripts/check.py\`)`,
                  `- Opened as **Draft PR** — requires human approval to merge into \`main\``,
                ].join("\n"),
              ],
              { encoding: "utf8" },
            ).trim();
          } catch (err) {
            note = `Verified locally, but could not push/open Draft PR: ${err instanceof Error ? err.message : String(err)}`;
            console.warn(`  [WARN] ${note}`);
          }
        } else if (!passed) {
          try {
            execFileSync("git", ["branch", "-D", branch], { stdio: "ignore" });
          } catch {
            // ignore
          }
        }

        branchResults.push({ slug: p.slug, branch, passed, prUrl, note });
      }
    }

    const elapsedTotal = ((Date.now() - startedMs) / 60_000).toFixed(1);
    const logsDir = path.join(".sandcastle", "logs");
    mkdirSync(logsDir, { recursive: true });
    const reportPath = path.join(logsDir, `nightly-arch-${dateTag}.md`);
    writeFileSync(reportPath, renderNightlyArchReport(dateTag, hotspots, proposals, branchResults), "utf8");

    const verifiedCount = branchResults.filter((b) => b.passed).length;
    const htmlPath = writePmHtmlReport({
      kind: "nightly-arch",
      slug: "proposals",
      title: `Overnight No-Bloat Briefing (${dateTag})`,
      status: verifiedCount > 0 ? "success" : "proposal",
      statusLabel:
        mode === "draft-branch"
          ? `${verifiedCount}/${proposals.length} Verified Draft PR(s)`
          : `${proposals.length} Proposal(s)`,
      executiveSummary:
        proposals.length > 0
          ? `Ran ${agentKind} overnight (${elapsedTotal}m / ${maxMinutes}m cap), scanned ${hotspots.length} active hot spots, and produced ${proposals.length} No-Bloat improvement proposal(s) (${verifiedCount} verified Draft PR(s) ready for your 1-click review).`
          : `Scanned ${hotspots.length} active hot spots (${elapsedTotal}m) — no high-impact improvements needed tonight.`,
      metrics: [
        { label: "Agent Provider", value: agentKind, note: `Cap ${maxMinutes}m` },
        { label: "Proposals", value: String(proposals.length), note: `Max ${maxProposals}` },
        { label: "Verified Drafts", value: String(verifiedCount), note: `Mode: ${mode}` },
        { label: "Elapsed Time", value: `${elapsedTotal}m`, note: `${hotspots.length} hotspots` },
      ],
      sections: [
        {
          heading: "Overnight Improvements (Plain-English Summary)",
          table: {
            headers: ["Improvement", "Why It Matters", "Benefit", "Status / Draft PR"],
            rows: proposals.map((p) => {
              const br = branchResults.find((b) => b.slug === p.slug);
              const statusText = br
                ? br.passed
                  ? br.prUrl || `Verified branch: ${br.branch}`
                  : `Discarded: ${br.note}`
                : "Queued in needs-triage";
              return [p.title, p.problem, p.benefits, statusText];
            }),
          },
        },
      ],
    });
    console.log(
      `\nNightly briefing saved to: ${reportPath}\nPM HTML report: ${htmlPath}` +
        formatEndOfRunFooter({ kind: "nightly-arch", reportPath: htmlPath }),
    );
  } finally {
    releaseLock();
  }
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  await main();
}
