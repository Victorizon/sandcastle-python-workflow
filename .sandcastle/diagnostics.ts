/**
 * Zero-Dependency Phase Trace & Post-Run Autopsy Diagnostics (`.sandcastle/diagnostics.ts`).
 *
 * Captures structured per-phase spans (Planner, Implementer, Reviewer, Fixer, Decomposer,
 * Merger, Host Check, Post-Merge Cross-Slice Auditor) as lightweight JSONL under
 * `.sandcastle/logs/runs/trace-<runId>.jsonl`, and toggles Sandcastle's built-in
 * `logging: { type: "file", path, verbose }` via `SANDCASTLE_VERBOSE=1`.
 *
 * Usage:
 *   npm --prefix .sandcastle run diagnose
 *   npm --prefix .sandcastle run diagnose -- --file .sandcastle/logs/runs/trace-<id>.jsonl
 */

import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";

export type PhaseName =
  | "planner"
  | "implement"
  | "pow_verify"
  | "review"
  | "fix"
  | "decompose"
  | "merge"
  | "host_check"
  | "pow_merge_verify"
  | "post_merge_audit";

export type PhaseOutcome = "pass" | "fail" | "rollback" | "escalated" | "decomposed";

export interface PhaseSpan {
  readonly timestamp: string;
  readonly runId: string;
  readonly cycle: number;
  readonly sliceId?: string;
  readonly phase: PhaseName;
  readonly outcome: PhaseOutcome;
  readonly durationMs: number;
  readonly detail?: string;
  readonly logFile?: string;
}

export interface PhaseTimingSummary {
  readonly phase: PhaseName;
  readonly count: number;
  readonly totalMs: number;
  readonly avgMs: number;
  readonly maxMs: number;
  readonly failures: number;
}

export interface TraceSummary {
  readonly totalSpans: number;
  readonly totalDurationMs: number;
  readonly byPhase: readonly PhaseTimingSummary[];
  readonly anomalies: readonly PhaseSpan[];
  readonly mergeAndAuditVerdicts: readonly PhaseSpan[];
}

export class RunTracer {
  readonly runId: string;
  readonly logsDir: string;
  readonly traceFile: string;
  readonly verbose: boolean;

  constructor(logsDir = path.join(".sandcastle", "logs"), verbose?: boolean) {
    const stamp = new Date().toISOString().replaceAll(/[:.]/gu, "-");
    this.runId = `trace-${stamp}-${Math.random().toString(36).slice(2, 6)}`;
    this.logsDir = logsDir;
    this.verbose = verbose ?? process.env["SANDCASTLE_VERBOSE"] === "1";
    const runsDir = path.join(logsDir, "runs");
    mkdirSync(runsDir, { recursive: true });
    this.traceFile = path.join(runsDir, `${this.runId}.jsonl`);
    writeFileSync(path.join(runsDir, "latest-trace.txt"), `${this.traceFile}\n`, "utf8");
  }

  phaseLogPath(cycle: number, phase: PhaseName, sliceId?: string): string {
    const slug = sliceId ? `-${sliceId.replaceAll(/[^a-zA-Z0-9_-]/gu, "_")}` : "";
    return path.join(this.logsDir, `${this.runId}-c${cycle}-${phase}${slug}.log`);
  }

  sandboxLogging(cycle: number, phase: PhaseName, sliceId?: string): {
    readonly type: "file";
    readonly path: string;
    readonly verbose: boolean;
  } {
    return { type: "file", path: this.phaseLogPath(cycle, phase, sliceId), verbose: this.verbose };
  }

  recordSpan(input: Omit<PhaseSpan, "timestamp" | "runId">): PhaseSpan {
    const span: PhaseSpan = {
      timestamp: new Date().toISOString(),
      runId: this.runId,
      ...input,
      durationMs: Math.max(0, Math.round(input.durationMs)),
    };
    appendFileSync(this.traceFile, `${JSON.stringify(span)}\n`, "utf8");
    return span;
  }
}

export function resolveLatestTraceFile(logsDir = path.join(".sandcastle", "logs")): string | null {
  const pointer = path.join(logsDir, "runs", "latest-trace.txt");
  if (!existsSync(pointer)) return null;
  const target = readFileSync(pointer, "utf8").trim();
  return target && existsSync(target) ? target : null;
}

export function loadTraceSpans(traceFile: string): PhaseSpan[] {
  if (!existsSync(traceFile)) return [];
  const spans: PhaseSpan[] = [];
  for (const line of readFileSync(traceFile, "utf8").split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    try {
      spans.push(JSON.parse(trimmed) as PhaseSpan);
    } catch {
      // Ignore malformed trailing line if process was hard-killed mid-write
    }
  }
  return spans;
}

export function summarizeTrace(spans: readonly PhaseSpan[]): TraceSummary {
  const grouped = new Map<PhaseName, PhaseSpan[]>();
  for (const s of spans) {
    const list = grouped.get(s.phase) ?? [];
    list.push(s);
    grouped.set(s.phase, list);
  }
  const byPhase: PhaseTimingSummary[] = [...grouped.entries()].map(([phase, list]) => {
    const totalMs = list.reduce((sum, x) => sum + x.durationMs, 0);
    const maxMs = list.reduce((m, x) => Math.max(m, x.durationMs), 0);
    const failures = list.filter((x) => x.outcome !== "pass").length;
    return {
      phase,
      count: list.length,
      totalMs,
      avgMs: Math.round(totalMs / list.length),
      maxMs,
      failures,
    };
  });
  const totalDurationMs = spans.reduce((sum, s) => sum + s.durationMs, 0);
  const anomalies = spans.filter((s) => s.outcome !== "pass");
  const mergeAndAuditVerdicts = spans.filter(
    (s) => s.phase === "merge" || s.phase === "post_merge_audit" || s.phase === "host_check",
  );
  return { totalSpans: spans.length, totalDurationMs, byPhase, anomalies, mergeAndAuditVerdicts };
}

export function formatDiagnoseReport(traceFile: string, spans: readonly PhaseSpan[]): string {
  const summary = summarizeTrace(spans);
  const lines = [
    "",
    "=== Sandcastle Post-Run Autopsy (Diagnostics) ===",
    `Trace: ${traceFile} (${summary.totalSpans} phase spans, ${(summary.totalDurationMs / 1000).toFixed(1)}s cumulative)`,
    "",
    "Phase Timings:",
    "  PHASE               COUNT   TOTAL     AVG       MAX     NON-PASS",
  ];
  for (const p of summary.byPhase) {
    const row = [
      p.phase.padEnd(19),
      String(p.count).padStart(5),
      `${(p.totalMs / 1000).toFixed(1)}s`.padStart(8),
      `${(p.avgMs / 1000).toFixed(1)}s`.padStart(8),
      `${(p.maxMs / 1000).toFixed(1)}s`.padStart(8),
      String(p.failures).padStart(9),
    ].join("  ");
    lines.push(`  ${row}`);
  }

  if (summary.anomalies.length > 0) {
    lines.push("", "Faulty / Non-Pass Events:");
    for (const a of summary.anomalies) {
      const slice = a.sliceId ? ` [${a.sliceId}]` : "";
      lines.push(
        `  - c${a.cycle} ${a.phase}${slice} -> ${a.outcome.toUpperCase()} (${(a.durationMs / 1000).toFixed(1)}s): ${a.detail ?? "(no detail)"}`,
      );
    }
  } else {
    lines.push("", "Faulty / Non-Pass Events: none (all phases passed cleanly).");
  }

  if (summary.mergeAndAuditVerdicts.length > 0) {
    lines.push("", "Merge, Host-Check & Post-Merge Audit Verdicts:");
    for (const m of summary.mergeAndAuditVerdicts) {
      lines.push(
        `  - c${m.cycle} ${m.phase} -> ${m.outcome.toUpperCase()} (${(m.durationMs / 1000).toFixed(1)}s): ${m.detail ?? ""}`,
      );
    }
  }
  lines.push(
    "",
    "Tip: Set SANDCASTLE_VERBOSE=1 for verbatim per-phase agent stream logs under .sandcastle/logs/.",
  );
  return lines.join("\n");
}

function main(): void {
  const argv = process.argv.slice(2);
  const fileFlagIdx = argv.indexOf("--file");
  const explicitFile = fileFlagIdx >= 0 ? argv[fileFlagIdx + 1] : undefined;
  const repoRoot =
    path.basename(process.cwd()) === ".sandcastle"
      ? path.resolve(process.cwd(), "..")
      : process.cwd();
  const logsDir = path.join(repoRoot, ".sandcastle", "logs");
  const target = explicitFile ?? resolveLatestTraceFile(logsDir);
  if (!target) {
    console.log("No diagnostic trace found yet. Run `npm --prefix .sandcastle run factory` first.");
    return;
  }
  const spans = loadTraceSpans(target);
  console.log(formatDiagnoseReport(target, spans));
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main();
}
