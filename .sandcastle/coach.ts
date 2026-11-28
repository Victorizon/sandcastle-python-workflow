/**
 * Deterministic Shadow Guide / Workflow Coach (`.sandcastle/coach.ts`).
 *
 * ZERO LLM calls, <100ms runtime. Inspects live local workspace signals:
 *   - Latest PM HTML reports under `.sandcastle/logs/reports/`
 *   - Unrated factory runs (`run-history.jsonl` vs `human-ratings.jsonl`)
 *   - Local tracker counts (`ready-for-human`, `needs-triage`, `ready-for-agent`)
 *   - Rolling Agent Trust Tier & 10-run Tuner unlock
 *   - Git branch safety (`main` + `src/` edits), processor changes, stale branches
 *
 * Outputs 2-5 prioritized, copy-pasteable next steps + exact report paths.
 */

import { execFileSync } from "node:child_process";
import { existsSync, readdirSync, statSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import {
  type AgentTrustScorecard,
  computeAgentTrustScore,
  loadHumanRatings,
} from "./confidence.js";
import { countLocalTicketsByStatus } from "./goal-core.js";
import { resolvePythonBin } from "./resilience.js";
import { MIN_RUNS_FOR_TUNING, loadVerifiedRunHistory } from "./run-history.js";

export type NudgePriority = "urgent" | "recommended" | "tip";

export interface CoachNudge {
  readonly priority: NudgePriority;
  readonly title: string;
  readonly detail: string;
  readonly command?: string;
  readonly filePath?: string;
}

const CONTEXTUAL_TIPS: readonly { readonly pattern: RegExp; readonly tip: string }[] = [
  {
    pattern: /\b(error|bug|crash|fail|broken|report|upstream)\b/iu,
    tip: "Hit a harness bug? Draft an anonymized, issue-only upstream report: `python scripts/upstream_report.py --kind bug --title \"...\" --summary \"...\" --include-latest-trace`.",
  },
  {
    pattern: /\b(slow|timing|diagnose|autopsy|merge|audit|trace|verbose)\b/iu,
    tip: "Want X-ray timings & Merger/Auditor verdicts? Run `SANDCASTLE_VERBOSE=1 npm --prefix .sandcastle run factory` then `npm --prefix .sandcastle run diagnose`.",
  },
  {
    pattern: /\b(install|setup|onboard|work|prereq|docker|env)\b/iu,
    tip: "Setting up a fresh machine? Run `python scripts/setup.py --check-only` first (zero changes, exact fix hints), then `python scripts/setup.py`.",
  },
  {
    pattern: /\b(bloat|dead|unused|duplicate|size|clean)\b/iu,
    tip: "Keep the repo lean with `python scripts/anti_bloat_guard.py --full` (file-size caps + vulture + knip + jscpd).",
  },
  {
    pattern: /\b(security|secret|sast|symbolic|fuzz|adversarial|scan)\b/iu,
    tip: "Hard-scan diffs for secrets, SAST anti-patterns, 100% diff-cover & Z3 counterexamples: `python scripts/adversarial_scan.py --base main`.",
  },
  {
    pattern: /\b(refactor|legacy|monolith|cassette|migrate)\b/iu,
    tip: "Refactoring legacy scripts? Freeze baseline debt via `python scripts/ratchet.py --init` and pin SDK behavior with Multi-Round Case Cassettes.",
  },
  {
    pattern: /\b(scale|100|many|slices|backlog|cycles)\b/iu,
    tip: "Running 100+ slices? Set `SANDCASTLE_MAX_CYCLES=50` — Planner automatically caps payloads to top 15 unblocked summaries.",
  },
  {
    pattern: /\b(new|feature|design|architecture|prior|research|spec)\b/iu,
    tip: "Starting a new feature? Run `$grill-me` (<= 3 batches), confirm Prior-Art `researchDepth`, and freeze `docs/specs/<slug>.md`.",
  },
  {
    pattern: /\b(adr|anomaly|quirk|jira|history|workaround)\b/iu,
    tip: "Need ADRs for legacy code quirks? Run `python scripts/adr_miner.py mine` (optional `--jira-export`), review drafts, then `approve` to auto-enforce via `Applies-to:`.",
  },
];

export function pickContextualTip(contextPrompt?: string, seed = Math.floor(Date.now() / 60_000)): string {
  const text = contextPrompt?.trim() ?? "";
  if (text.length > 0) {
    const matched = CONTEXTUAL_TIPS.find((entry) => entry.pattern.test(text));
    if (matched) return matched.tip;
  }
  const idx = Math.abs(seed) % CONTEXTUAL_TIPS.length;
  return CONTEXTUAL_TIPS[idx]!.tip;
}

export interface WorkspaceCoachSignals {
  readonly currentBranch: string;
  readonly modifiedFiles: readonly string[];
  readonly staleWorkBranches: number;
  readonly openHumanTickets: number;
  readonly openTriageTickets: number;
  readonly openReadyTickets: number;
  readonly latestReportPath: string | null;
  readonly latestReportAgeHours: number | null;
  readonly latestRunId: string | null;
  readonly latestRunRated: boolean;
  readonly verifiedRunCount: number;
  readonly trust: AgentTrustScorecard;
  readonly connectedReminders?: readonly string[];
  readonly pendingAdrDrafts?: number;
}

function runGit(args: readonly string[], cwd: string): string {
  try {
    return execFileSync("git", args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  } catch {
    return "";
  }
}

export function findLatestHtmlReport(
  logsDir = path.join(".sandcastle", "logs"),
): { readonly filePath: string | null; readonly ageHours: number | null } {
  const reportsDir = path.join(logsDir, "reports");
  if (!existsSync(reportsDir)) {
    return { filePath: null, ageHours: null };
  }
  const entries = readdirSync(reportsDir)
    .filter((f) => f.endsWith(".html"))
    .map((f) => {
      const full = path.join(reportsDir, f);
      return { full, mtimeMs: statSync(full).mtimeMs };
    })
    .sort((a, b) => b.mtimeMs - a.mtimeMs);

  const newest = entries[0];
  if (!newest) return { filePath: null, ageHours: null };
  const rel = path.relative(process.cwd(), newest.full).replaceAll("\\", "/");
  const ageHours = Number(((Date.now() - newest.mtimeMs) / 3_600_000).toFixed(1));
  return { filePath: rel, ageHours };
}

function collectConnectedReminders(modifiedFiles: readonly string[], cwd: string): string[] {
  if (modifiedFiles.length === 0) return [];
  const archMap = path.join(cwd, "scripts", "arch_map.py");
  if (!existsSync(archMap)) return [];
  try {
    const out = execFileSync(
      resolvePythonBin(cwd),
      [archMap, "--root", cwd, "--impact", "--json", "--files", ...modifiedFiles],
      { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] },
    );
    const parsed = JSON.parse(out) as {
      suggestions?: { file: string; check_callers?: string[] }[];
    };
    const callers = new Set<string>();
    for (const s of parsed.suggestions ?? []) {
      for (const c of s.check_callers ?? []) callers.add(c);
    }
    return [...callers].slice(0, 6);
  } catch {
    return [];
  }
}

export function collectWorkspaceSignals(
  cwd = process.cwd(),
  logsDir = path.join(cwd, ".sandcastle", "logs"),
): WorkspaceCoachSignals {
  const currentBranch = runGit(["rev-parse", "--abbrev-ref", "HEAD"], cwd) || "unknown";
  const porcelain = runGit(["status", "--porcelain"], cwd);
  const modifiedFiles = porcelain
    .split(/\r?\n/u)
    .map((l) => l.slice(3).trim())
    .filter(Boolean);

  const branchesOut = runGit(["branch", "--list", "sandcastle/*", "prototype/*", "arch/*"], cwd);
  const staleWorkBranches = branchesOut
    .split(/\r?\n/u)
    .map((b) => b.trim())
    .filter(Boolean).length;

  const openHumanTickets = Math.max(0, countLocalTicketsByStatus("ready-for-human", cwd));
  const openTriageTickets = Math.max(0, countLocalTicketsByStatus("needs-triage", cwd));
  const openReadyTickets = Math.max(0, countLocalTicketsByStatus("ready-for-agent", cwd));

  const { verifiedRuns } = loadVerifiedRunHistory(logsDir);
  const ratings = loadHumanRatings(logsDir);
  const trust = computeAgentTrustScore(verifiedRuns, ratings);
  const latestRun = verifiedRuns.at(-1) ?? null;
  const ratedIds = new Set(ratings.map((r) => r.runId));

  const latestReport = findLatestHtmlReport(logsDir);

  const adrDraftsDir = path.join(cwd, "docs", "adr", "drafts");
  const pendingAdrDrafts = existsSync(adrDraftsDir)
    ? readdirSync(adrDraftsDir).filter((f) => f.endsWith(".md")).length
    : 0;

  return {
    currentBranch,
    modifiedFiles,
    staleWorkBranches,
    openHumanTickets,
    openTriageTickets,
    openReadyTickets,
    latestReportPath: latestReport.filePath,
    latestReportAgeHours: latestReport.ageHours,
    latestRunId: latestRun?.runId ?? null,
    latestRunRated: latestRun ? ratedIds.has(latestRun.runId) : true,
    verifiedRunCount: verifiedRuns.length,
    trust,
    connectedReminders: collectConnectedReminders(modifiedFiles, cwd),
    pendingAdrDrafts,
  };
}

export function buildCoachNudges(signals: WorkspaceCoachSignals): CoachNudge[] {
  const nudges: CoachNudge[] = [];

  // 1. Urgent safety & blocker checks
  if (signals.openHumanTickets > 0) {
    nudges.push({
      priority: "urgent",
      title: `Resolve ${signals.openHumanTickets} human-escalated ticket(s) first`,
      detail:
        "Autonomous cycles pause when tickets are waiting on human decisions. Inspect and unblock them on the board (if caused by a workflow bug, draft an anonymized upstream report with scripts/upstream_report.py).",
      command: "python scripts/local_tracker.py board",
    });
  }

  const touchedSrc = signals.modifiedFiles.some((f) => f.startsWith("src/"));
  if (signals.currentBranch === "main" && touchedSrc) {
    nudges.push({
      priority: "urgent",
      title: "Move uncommitted src/ edits off main onto a feature branch",
      detail:
        "Direct src/ commits on main are blocked by scripts/branch_guard.py. Create a feature branch before committing.",
      command: "git checkout -b feat/my-slice",
    });
  }

  // 2. Latest PM HTML report & human reality check
  if (signals.latestReportPath) {
    const ageNote =
      signals.latestReportAgeHours !== null ? ` (${signals.latestReportAgeHours}h ago)` : "";
    nudges.push({
      priority: "recommended",
      title: `Don't forget to review your latest PM HTML report${ageNote}`,
      detail:
        "Open it in your browser for executive metrics, confidence badge, and 1-click Copy Jira Markup.",
      filePath: signals.latestReportPath,
    });
  }

  if (signals.latestRunId && !signals.latestRunRated) {
    nudges.push({
      priority: "recommended",
      title: `Log a 5-second Human Reality Check on ${signals.latestRunId}`,
      detail:
        "Anchors your Agent Trust Score to real-world review quality and feeds notes into the Parameter Tuner.",
      command: "npm --prefix .sandcastle run rate -- --latest --verdict good",
    });
  }

  // 2b. Pending mined ADR drafts -> recommend dedicated $grill-me reconciliation session
  if (signals.pendingAdrDrafts && signals.pendingAdrDrafts > 0) {
    nudges.push({
      priority: "recommended",
      title: `Reconcile ${signals.pendingAdrDrafts} mined ADR draft(s) via a dedicated $grill-me session`,
      detail:
        "Walk through each mined quirk in docs/adr/drafts/ with $grill-me to confirm what is still required and set exact `Applies-to:` globs, then approve or reject.",
      command: "python scripts/adr_miner.py list-drafts",
    });
  }

  // 3. Processor / parser safety nudge (Hypothesis deep fuzzing)
  const touchedProcessors = signals.modifiedFiles.some((f) =>
    f.startsWith("src/app/processors/"),
  );
  if (touchedProcessors) {
    nudges.push({
      priority: "recommended",
      title: "Run deep 300-case Hypothesis fuzzing on your processor/parser change",
      detail:
        "You modified src/app/processors/ — stress-test fail-closed edge cases before merging.",
      command: "HYPOTHESIS_PROFILE=deep python scripts/check.py",
    });
  }

  // 4. Ticket queue matched to earned Agent Trust Tier
  if (signals.openReadyTickets > 0 && signals.openHumanTickets === 0) {
    if (signals.trust.tier === "Goal Autonomy Ready (Level 2)") {
      nudges.push({
        priority: "recommended",
        title: `${signals.openReadyTickets} slice(s) ready — Level 2 Goal Autonomy unlocked (${signals.trust.trustScore}/100)`,
        detail:
          "Freeze your /grill-me decisions in docs/specs/<slug>.md, link specFile in goal.json, and run unattended Goal Autonomy.",
        command:
          "npm --prefix .sandcastle run goal -- --goal .sandcastle/goal.json --max-minutes 0",
      });
    } else {
      nudges.push({
        priority: "recommended",
        title: `${signals.openReadyTickets} slice(s) ready — run Level 1 Factory (${signals.trust.tier})`,
        detail: `Current trust is ${signals.trust.trustScore}/100 (${signals.verifiedRunCount}/${MIN_RUNS_FOR_TUNING} runs). Use Factory with the Live Mission Control Dashboard.`,
        command: "npm --prefix .sandcastle run factory",
      });
    }
  }

  if (signals.openTriageTickets > 0) {
    nudges.push({
      priority: "tip",
      title: `Review ${signals.openTriageTickets} needs-triage proposal(s)`,
      detail:
        "Promote high-ROI overnight architecture proposals to ready-for-agent, mark low-value ones wontfix, or report harness improvements upstream via scripts/upstream_report.py (issue-only, auto-anonymized, human-approved).",
      command: "python scripts/local_tracker.py board",
    });
  }

  // 5. 10-run Parameter Tuner unlock
  if (signals.verifiedRunCount >= MIN_RUNS_FOR_TUNING) {
    nudges.push({
      priority: "tip",
      title: `Parameter Tuner unlocked (${signals.verifiedRunCount} verified runs on disk)`,
      detail:
        "Generate safety-clamped DriftWatchdog & prompt tuning recommendations grounded in your p50/p90 history.",
      command: "npm --prefix .sandcastle run tune",
    });
  }

  // 6. Connected-component reminder (don't leave linked files behind!)
  if (signals.connectedReminders && signals.connectedReminders.length > 0) {
    nudges.push({
      priority: "tip",
      title: `Double-check ${signals.connectedReminders.length} connected component(s) for your edits`,
      detail: `Your modified files are referenced by: ${signals.connectedReminders.join(", ")}.`,
      command: "python scripts/arch_map.py --impact",
    });
  }

  // 7. Branch hygiene
  if (signals.staleWorkBranches >= 4) {
    nudges.push({
      priority: "tip",
      title: `${signals.staleWorkBranches} old agent/prototype branches sitting locally`,
      detail: "Clean up merged or discarded prototype/* and sandcastle/* branches to keep git tidy.",
      command: "git branch --list 'sandcastle/*' 'prototype/*' 'arch/*'",
    });
  }

  // Fallback when workspace is completely idle
  if (nudges.length === 0) {
    nudges.push({
      priority: "tip",
      title: "Clean slate — pick your entry point for the next task",
      detail:
        "Uncertain architecture? Run a 3-variant Prototype Bake-Off. Clear feature? Run /grill-me, freeze docs/specs/<slug>.md, and queue slices.",
      command:
        'npm --prefix .sandcastle run bakeoff -- --slug next-design --brief "Compare 3 designs"',
    });
  }

  return nudges;
}

export function formatEndOfRunFooter(params: {
  readonly kind: "factory" | "goal" | "nightly-arch" | "bakeoff" | "tuning";
  readonly reportPath: string;
  readonly extraCommand?: string;
}): string {
  const lines = [
    "",
    "--- Shadow Guide (Next Best Steps) ---",
    `1. Read your styled PM HTML report (1-click Copy Jira Markup): ${params.reportPath}`,
  ];
  if (params.kind === "factory" || params.kind === "goal") {
    lines.push(
      "2. After reviewing the diff, log a 5s Human Reality Check: npm --prefix .sandcastle run rate -- --latest --verdict good|tweak|rework",
    );
  } else if (params.kind === "nightly-arch") {
    lines.push("2. Triage the proposals on your local board: python scripts/local_tracker.py board");
  } else if (params.kind === "bakeoff") {
    lines.push(
      "2. Inspect the winning prototype branch diff before building cleanly on a feature branch.",
    );
  }
  if (params.extraCommand) {
    lines.push(`3. Suggested follow-up: ${params.extraCommand}`);
  }
  lines.push(
    `Tip: ${pickContextualTip(params.kind === "factory" || params.kind === "goal" ? "diagnose" : params.kind)}`,
  );
  return lines.join("\n");
}

export function formatCoachOutput(
  signals: WorkspaceCoachSignals,
  nudges: readonly CoachNudge[],
  contextPrompt?: string,
): string {
  const lines: string[] = [
    "",
    "=== Shadow Guide · Workflow Coach ===",
    `Branch: ${signals.currentBranch} | Agent Trust: ${signals.trust.trustScore}/100 (${signals.trust.tier})`,
    `Tickets: ${signals.openReadyTickets} ready-for-agent · ${signals.openHumanTickets} ready-for-human · ${signals.openTriageTickets} needs-triage`,
    "",
  ];

  const tagFor = (p: NudgePriority): string =>
    p === "urgent" ? "[URGENT]" : p === "recommended" ? "[NEXT]  " : "[TIP]   ";

  for (const n of nudges) {
    lines.push(`${tagFor(n.priority)} ${n.title}`);
    lines.push(`         ${n.detail}`);
    if (n.filePath) lines.push(`         Open: ${n.filePath}`);
    if (n.command) lines.push(`         Run:  ${n.command}`);
    lines.push("");
  }

  lines.push(`Trust Lever: ${signals.trust.diagnosticLever}`);
  lines.push(`Workflow Tip: ${pickContextualTip(contextPrompt)}`);
  lines.push("Full Visual Handbook: docs/WORKFLOW_GUIDE.html");
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const ctxIdx = argv.indexOf("--context");
  const contextPrompt = ctxIdx >= 0 ? argv[ctxIdx + 1] : undefined;
  const repoRoot =
    path.basename(process.cwd()) === ".sandcastle"
      ? path.resolve(process.cwd(), "..")
      : process.cwd();
  const signals = collectWorkspaceSignals(repoRoot, path.join(repoRoot, ".sandcastle", "logs"));
  const nudges = buildCoachNudges(signals);
  console.log(formatCoachOutput(signals, nudges, contextPrompt));
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  main();
}
