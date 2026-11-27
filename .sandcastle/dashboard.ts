/**
 * Real-Time PM Mission Control Dashboard server (zero external dependencies).
 *
 * Serves an animated live UI over HTTP + Server-Sent Events (SSE) so a Product Manager
 * or engineer can watch every Docker container, slice stage, Drift Watchdog gauge,
 * 6-gate verification result, and Adversarial Reviewer challenge in real time.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import http from "node:http";
import type { AddressInfo } from "node:net";
import path from "node:path";
import type { AgentStreamEvent } from "@ai-hero/sandcastle";
import { renderDashboardHtml } from "./dashboard-ui.js";

export type SliceStage =
  | "queued"
  | "implementing"
  | "verifying"
  | "reviewing"
  | "remediating"
  | "merging"
  | "merged"
  | "split"
  | "needs_human";

export interface ChallengeRecord {
  readonly timestamp: string;
  readonly source: "reviewer" | "test_guard" | "mutation_check" | "drift_watchdog";
  readonly finding: string;
  readonly outcome: "fixed" | "split" | "blocked" | "escalated";
}

export interface WatchdogSnapshot {
  readonly elapsedSec: number;
  readonly maxSec: number;
  readonly toolCalls: number;
  readonly maxToolCalls: number;
  readonly diffLines: number;
  readonly maxDiffLines: number;
  readonly contextPercent: number;
}

export interface SliceCard {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  readonly splitDepth: number;
  readonly parentId?: string;
  readonly stage: SliceStage;
  readonly pmSummary: string;
  readonly containerName?: string;
  readonly watchdog: WatchdogSnapshot;
  readonly challenges: readonly ChallengeRecord[];
}

export interface TimelineEntry {
  readonly id: number;
  readonly timestamp: string;
  readonly sliceId?: string;
  readonly level: "info" | "success" | "challenge" | "warning" | "error";
  readonly headline: string;
  readonly detail: string;
  readonly technicalLog?: string;
}

export interface DashboardMetrics {
  readonly totalSlices: number;
  readonly completedSlices: number;
  readonly activeSlices: number;
  readonly splitSlices: number;
  readonly escalatedSlices: number;
  readonly progressPercent: number;
  readonly adversarialChallengesRaised: number;
  readonly adversarialChallengesResolved: number;
  readonly testTamperBlocks: number;
  readonly driftAutoSplits: number;
  readonly latestCoveragePercent: number | null;
  readonly latestMutationScore: number | null;
}

export interface DashboardState {
  readonly title: string;
  readonly mode: "factory" | "synthetic-e2e";
  readonly runStatus: "idle" | "running" | "complete" | "blocked";
  readonly cycle: number;
  readonly maxCycles: number;
  readonly dockerImage: string;
  readonly startedAt: string;
  readonly updatedAt: string;
  readonly headline: string;
  readonly metrics: DashboardMetrics;
  readonly slices: readonly SliceCard[];
  readonly timeline: readonly TimelineEntry[];
}

export function summarizeAgentEventForPm(event: AgentStreamEvent): string | null {
  if (event.type === "toolCall") {
    const args = event.formattedArgs.toLowerCase();
    if (args.includes("mutation_check.py")) return "Running AST mutation test suite to prove test strength";
    if (args.includes("test_guard.py")) return "Verifying anti-tamper test lock inside container";
    if (args.includes("check.py")) return "Running all 6 deterministic quality gates inside container";
    if (args.includes("pytest")) return "Running behavioral replay test suite inside container";
    if (args.includes("ruff") || args.includes("ratchet.py")) {
      return "Checking formatting, strict types, and monotonic ratchet";
    }
    if (args.includes("git commit")) return "Saving verified checkpoint commit to isolated worktree";
    if (args.includes("git diff")) return "Inspecting branch changes against main";
    if (args.includes("tests/fixtures")) return "Adding anonymized replay fixture data";
    if (args.includes("tests/")) return "Writing public-seam behavioral tests";
    if (args.includes("src/")) return "Updating core processor code";
    return `Executing container step (${event.name})`;
  }
  return null;
}

export function parseCheckMetrics(output: string): {
  coveragePercent: number | null;
  mutationScore: number | null;
} {
  const covMatch = /Coverage floor PASS:\s*([0-9]+(?:\.[0-9]+)?)%/u.exec(output);
  const mutMatch = /Mutation score:\s*\d+\/\d+\s*killed\s*\(([0-9]+(?:\.[0-9]+)?)%\)/u.exec(output);
  return {
    coveragePercent: covMatch?.[1] ? Number(covMatch[1]) : null,
    mutationScore: mutMatch?.[1] ? Number(mutMatch[1]) : null,
  };
}

export class PMDashboard {
  private server: http.Server | null = null;
  private readonly clients = new Set<http.ServerResponse>();
  private readonly slices = new Map<string, SliceCard>();
  private readonly timeline: TimelineEntry[] = [];
  private nextEventId = 1;
  private runStatus: DashboardState["runStatus"] = "running";
  private cycle = 1;
  private maxCycles = 6;
  private headline = "Initializing containerized workflow...";
  private latestCoveragePercent: number | null = null;
  private latestMutationScore: number | null = null;
  private readonly startedAt = new Date().toISOString();
  private readonly stateFilePath: string | null;

  constructor(
    private readonly options: {
      readonly title?: string;
      readonly mode: "factory" | "synthetic-e2e";
      readonly dockerImage: string;
      readonly maxCycles?: number;
      readonly stateFilePath?: string | null;
    },
  ) {
    this.maxCycles = options.maxCycles ?? 6;
    this.stateFilePath =
      options.stateFilePath === undefined
        ? path.join(".sandcastle", "logs", "dashboard-state.json")
        : options.stateFilePath;
  }

  get url(): string | null {
    if (!this.server) return null;
    const addr = this.server.address() as AddressInfo | null;
    return addr ? `http://127.0.0.1:${addr.port}` : null;
  }

  async start(preferredPort = Number(process.env["DASHBOARD_PORT"] ?? "4311")): Promise<string> {
    const html = renderDashboardHtml();
    this.server = http.createServer((req, res) => {
      if (req.url === "/events") {
        res.writeHead(200, {
          "Content-Type": "text/event-stream",
          "Cache-Control": "no-cache",
          Connection: "keep-alive",
        });
        res.write(`data: ${JSON.stringify(this.getState())}\n\n`);
        this.clients.add(res);
        req.on("close", () => {
          this.clients.delete(res);
        });
        return;
      }

      if (req.url === "/api/state") {
        res.writeHead(200, { "Content-Type": "application/json; charset=utf-8" });
        res.end(JSON.stringify(this.getState(), null, 2));
        return;
      }

      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(html);
    });

    await new Promise<void>((resolve, reject) => {
      const srv = this.server;
      if (!srv) return reject(new Error("Server not initialized"));
      srv.once("error", () => {
        srv.listen(0, "127.0.0.1", () => resolve());
      });
      srv.listen(preferredPort, "127.0.0.1", () => resolve());
    });

    return this.url ?? `http://127.0.0.1:${preferredPort}`;
  }

  async close(): Promise<void> {
    for (const client of this.clients) {
      client.end();
    }
    this.clients.clear();
    if (!this.server) return;
    await new Promise<void>((resolve) => {
      this.server?.close(() => resolve());
    });
    this.server = null;
  }

  setCycle(cycle: number, headline: string): void {
    this.cycle = cycle;
    this.headline = headline;
    this.broadcast();
  }

  setRunStatus(status: DashboardState["runStatus"], headline: string): void {
    this.runStatus = status;
    this.headline = headline;
    this.broadcast();
  }

  upsertSlice(
    id: string,
    patch: Partial<Omit<SliceCard, "id" | "challenges" | "watchdog">> & {
      readonly watchdog?: Partial<WatchdogSnapshot>;
    },
  ): void {
    const existing = this.slices.get(id);
    const defaultWatchdog: WatchdogSnapshot = {
      elapsedSec: 0,
      maxSec: Number(process.env["DRIFT_MAX_MINUTES"] ?? "20") * 60,
      toolCalls: 0,
      maxToolCalls: Number(process.env["DRIFT_MAX_TOOL_CALLS"] ?? "45"),
      diffLines: 0,
      maxDiffLines: Number(process.env["DRIFT_MAX_DIFF_LINES"] ?? "400"),
      contextPercent: 0,
    };
    const next: SliceCard = {
      id,
      title: patch.title ?? existing?.title ?? id,
      branch: patch.branch ?? existing?.branch ?? `sandcastle/${id}`,
      splitDepth: patch.splitDepth ?? existing?.splitDepth ?? 0,
      parentId: patch.parentId ?? existing?.parentId,
      stage: patch.stage ?? existing?.stage ?? "queued",
      pmSummary: patch.pmSummary ?? existing?.pmSummary ?? "Queued for container execution",
      containerName: patch.containerName ?? existing?.containerName,
      watchdog: {
        ...(existing?.watchdog ?? defaultWatchdog),
        ...(patch.watchdog ?? {}),
      },
      challenges: existing?.challenges ?? [],
    };
    this.slices.set(id, next);
    this.broadcast();
  }

  recordChallenge(sliceId: string, challenge: Omit<ChallengeRecord, "timestamp">): void {
    const existing = this.slices.get(sliceId);
    if (!existing) return;
    const record: ChallengeRecord = {
      ...challenge,
      timestamp: new Date().toISOString(),
    };
    this.slices.set(sliceId, {
      ...existing,
      challenges: [...existing.challenges, record],
    });
    this.broadcast();
  }

  recordQualityMetrics(coveragePercent: number | null, mutationScore: number | null): void {
    if (coveragePercent !== null) this.latestCoveragePercent = coveragePercent;
    if (mutationScore !== null) this.latestMutationScore = mutationScore;
    this.broadcast();
  }

  addEvent(entry: Omit<TimelineEntry, "id" | "timestamp">): void {
    this.timeline.unshift({
      ...entry,
      id: this.nextEventId++,
      timestamp: new Date().toISOString(),
    });
    if (this.timeline.length > 80) {
      this.timeline.length = 80;
    }
    this.broadcast();
  }

  computeMetrics(): DashboardMetrics {
    const all = [...this.slices.values()];
    const activeWorkItems = all.filter((s) => s.stage !== "split");
    const completed = activeWorkItems.filter((s) => s.stage === "merged").length;
    const active = activeWorkItems.filter((s) =>
      ["implementing", "verifying", "reviewing", "remediating", "merging"].includes(s.stage),
    ).length;
    const split = all.filter((s) => s.stage === "split").length;
    const escalated = activeWorkItems.filter((s) => s.stage === "needs_human").length;

    let challengesRaised = 0;
    let challengesResolved = 0;
    let tamperBlocks = 0;
    let autoSplits = 0;
    for (const s of all) {
      for (const ch of s.challenges) {
        challengesRaised += 1;
        if (ch.outcome === "fixed") challengesResolved += 1;
        if (ch.source === "test_guard") tamperBlocks += 1;
        if (ch.outcome === "split") autoSplits += 1;
      }
    }

    const denominator = activeWorkItems.length;
    const progressPercent =
      denominator === 0 ? 0 : Math.round((completed / denominator) * 100);

    return {
      totalSlices: denominator,
      completedSlices: completed,
      activeSlices: active,
      splitSlices: split,
      escalatedSlices: escalated,
      progressPercent,
      adversarialChallengesRaised: challengesRaised,
      adversarialChallengesResolved: challengesResolved,
      testTamperBlocks: tamperBlocks,
      driftAutoSplits: autoSplits,
      latestCoveragePercent: this.latestCoveragePercent,
      latestMutationScore: this.latestMutationScore,
    };
  }

  getState(): DashboardState {
    return {
      title: this.options.title ?? "Sandcastle Workflow Mission Control",
      mode: this.options.mode,
      runStatus: this.runStatus,
      cycle: this.cycle,
      maxCycles: this.maxCycles,
      dockerImage: this.options.dockerImage,
      startedAt: this.startedAt,
      updatedAt: new Date().toISOString(),
      headline: this.headline,
      metrics: this.computeMetrics(),
      slices: [...this.slices.values()],
      timeline: this.timeline,
    };
  }

  private broadcast(): void {
    const state = this.getState();
    const payload = JSON.stringify(state);
    if (this.stateFilePath) {
      try {
        mkdirSync(path.dirname(this.stateFilePath), { recursive: true });
        writeFileSync(this.stateFilePath, JSON.stringify(state, null, 2), "utf8");
      } catch {
        // Non-fatal persistence error
      }
    }
    for (const client of this.clients) {
      try {
        client.write(`data: ${payload}\n\n`);
      } catch {
        this.clients.delete(client);
      }
    }
  }
}
