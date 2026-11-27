/**
 * Deterministic Drift Watchdog for Sandcastle worker runs.
 *
 * Watches worker execution for zero tokens using AbortController + live AgentStreamEvent
 * stream events + post-run git diff & context-window metrics. Only when a deterministic
 * tripwire fires does `run.ts` wake the fresh-context Decomposer agent (at most once per ticket).
 */

import type { AgentStreamEvent } from "@ai-hero/sandcastle";

export type DriftKind =
  | "wall_clock_timeout"
  | "tool_call_limit"
  | "thrash_loop"
  | "diff_size_explosion"
  | "diff_file_explosion"
  | "context_rot";

export class DriftDetectedError extends Error {
  readonly kind: DriftKind;
  readonly detail: string;

  constructor(kind: DriftKind, detail: string) {
    super(`Drift detected (${kind}): ${detail}`);
    this.name = "DriftDetectedError";
    this.kind = kind;
    this.detail = detail;
  }
}

export interface DriftConfig {
  readonly maxTicketMs: number;
  readonly maxToolCalls: number;
  readonly maxRepeatedToolCalls: number;
  readonly maxOscillationCycles: number;
  readonly maxDiffLines: number;
  readonly maxDiffFiles: number;
  readonly maxContextRatio: number;
}

export const DEFAULT_DRIFT_CONFIG: DriftConfig = {
  maxTicketMs: Number(process.env["DRIFT_MAX_MINUTES"] ?? "20") * 60_000,
  maxToolCalls: Number(process.env["DRIFT_MAX_TOOL_CALLS"] ?? "45"),
  maxRepeatedToolCalls: Number(process.env["DRIFT_MAX_REPEATED_TOOLS"] ?? "6"),
  maxOscillationCycles: Number(process.env["DRIFT_MAX_OSCILLATION_CYCLES"] ?? "3"),
  maxDiffLines: Number(process.env["DRIFT_MAX_DIFF_LINES"] ?? "400"),
  maxDiffFiles: Number(process.env["DRIFT_MAX_DIFF_FILES"] ?? "6"),
  maxContextRatio: Number(process.env["DRIFT_MAX_CONTEXT_RATIO"] ?? "0.78"),
};

export interface PostRunMetrics {
  readonly diffLines: number;
  readonly diffFiles: number;
  readonly contextTokens?: number;
  readonly contextLimit?: number;
  readonly completed: boolean;
}

export function parseGitNumstat(output: string): { files: number; lines: number } {
  let files = 0;
  let lines = 0;
  for (const rawLine of output.split(/\r?\n/u)) {
    const trimmed = rawLine.trim();
    if (!trimmed) continue;
    const parts = trimmed.split(/\s+/u);
    if (parts.length < 3) continue;
    files += 1;
    const added = parts[0] === "-" ? 0 : Number.parseInt(parts[0] ?? "0", 10);
    const deleted = parts[1] === "-" ? 0 : Number.parseInt(parts[1] ?? "0", 10);
    if (Number.isFinite(added)) lines += added;
    if (Number.isFinite(deleted)) lines += deleted;
  }
  return { files, lines };
}

export class DriftWatchdog {
  readonly controller = new AbortController();
  private readonly config: DriftConfig;
  private readonly timer: NodeJS.Timeout;
  private toolCalls = 0;
  private lastToolSignature = "";
  private repeatedCount = 0;
  private readonly recentSignatures: string[] = [];
  private triggered: DriftDetectedError | null = null;

  constructor(config: Partial<DriftConfig> = {}) {
    this.config = { ...DEFAULT_DRIFT_CONFIG, ...config };
    this.timer = setTimeout(() => {
      const mins = (this.config.maxTicketMs / 60_000).toFixed(1);
      this.trip(
        new DriftDetectedError(
          "wall_clock_timeout",
          `worker exceeded wall-clock limit (${mins} min) without completing`,
        ),
      );
    }, this.config.maxTicketMs);
    this.timer.unref();
  }

  get signal(): AbortSignal {
    return this.controller.signal;
  }

  get drift(): DriftDetectedError | null {
    return this.triggered;
  }

  get toolCallCount(): number {
    return this.toolCalls;
  }

  private trip(error: DriftDetectedError): void {
    if (this.triggered !== null) return;
    this.triggered = error;
    this.controller.abort(error);
  }

  onEvent(event: AgentStreamEvent): void {
    if (event.type !== "toolCall" || this.triggered !== null) return;
    this.toolCalls += 1;

    const signature = `${event.name}::${event.formattedArgs.trim()}`;
    this.recentSignatures.push(signature);
    if (this.recentSignatures.length > 24) {
      this.recentSignatures.shift();
    }

    if (signature === this.lastToolSignature) {
      this.repeatedCount += 1;
    } else {
      this.lastToolSignature = signature;
      this.repeatedCount = 1;
    }

    if (this.repeatedCount >= this.config.maxRepeatedToolCalls) {
      this.trip(
        new DriftDetectedError(
          "thrash_loop",
          `repeated identical tool call ${this.repeatedCount}x in a row (${event.name})`,
        ),
      );
      return;
    }

    const cyclePeriod = this.detectOscillationPeriod();
    if (cyclePeriod !== null) {
      this.trip(
        new DriftDetectedError(
          "thrash_loop",
          `ping-pong oscillation loop detected (${cyclePeriod}-step cycle repeated ${this.config.maxOscillationCycles}x)`,
        ),
      );
      return;
    }

    if (this.toolCalls > this.config.maxToolCalls) {
      this.trip(
        new DriftDetectedError(
          "tool_call_limit",
          `exceeded ${this.config.maxToolCalls} tool calls without finishing`,
        ),
      );
    }
  }

  private detectOscillationPeriod(): number | null {
    const repeats = this.config.maxOscillationCycles;
    if (repeats < 2) return null;
    for (const period of [2, 3]) {
      const needed = period * repeats;
      if (this.recentSignatures.length < needed) continue;
      const tail = this.recentSignatures.slice(-needed);
      const pattern = tail.slice(0, period);
      // Ensure the pattern isn't all identical (handled by maxRepeatedToolCalls)
      if (new Set(pattern).size <= 1) continue;
      let matched = true;
      for (let i = period; i < tail.length; i++) {
        if (tail[i] !== pattern[i % period]) {
          matched = false;
          break;
        }
      }
      if (matched) return period;
    }
    return null;
  }

  checkPostRun(metrics: PostRunMetrics): DriftDetectedError | null {
    if (this.triggered) return this.triggered;

    if (metrics.diffFiles > this.config.maxDiffFiles) {
      return new DriftDetectedError(
        "diff_file_explosion",
        `changed ${metrics.diffFiles} files (limit ${this.config.maxDiffFiles}); slice is too wide`,
      );
    }

    if (metrics.diffLines > this.config.maxDiffLines) {
      return new DriftDetectedError(
        "diff_size_explosion",
        `changed ${metrics.diffLines} lines (limit ${this.config.maxDiffLines}); slice is too large`,
      );
    }

    if (
      !metrics.completed &&
      metrics.contextTokens !== undefined &&
      metrics.contextLimit !== undefined &&
      metrics.contextLimit > 0
    ) {
      const ratio = metrics.contextTokens / metrics.contextLimit;
      if (ratio >= this.config.maxContextRatio) {
        return new DriftDetectedError(
          "context_rot",
          `context window reached ${(ratio * 100).toFixed(0)}% without completing`,
        );
      }
    }

    return null;
  }

  dispose(): void {
    clearTimeout(this.timer);
  }
}
