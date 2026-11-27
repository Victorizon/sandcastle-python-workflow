/**
 * Operational Safety Preflight Guards (`.sandcastle/preflight.ts`).
 *
 * Pure deterministic guards that prevent data loss, concurrent run collisions,
 * and LLM Planner hallucinations before any Docker container starts:
 *   1. Clean git worktree guard (protects uncommitted edits from branch switches / rollbacks)
 *   2. PID-aware run lockfile (blocks concurrent runs, auto-recovers stale locks after crashes)
 *   3. Ground-truth Planner cross-check against `local_tracker.py` (blocks hallucinated IDs,
 *      blocked tickets, or tampered `splitDepth`)
 */

import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface TrackerTicketSnapshot {
  readonly id: string;
  readonly status: string;
  readonly split_depth: number;
  readonly open_blockers: readonly string[];
}

export interface PlannedTicketCandidate {
  readonly id: string;
  readonly title: string;
  readonly branch: string;
  readonly splitDepth: number;
}

export function assertCleanGitWorktree(cwd = process.cwd()): void {
  const status = execFileSync("git", ["status", "--porcelain"], {
    cwd,
    encoding: "utf8",
    stdio: ["pipe", "pipe", "pipe"],
  }).trim();
  if (status.length > 0) {
    const preview = status.split(/\r?\n/u).slice(0, 5).join("\n  ");
    throw new Error(
      `Refusing to start Sandcastle with uncommitted local edits (protects your work from branch resets):\n  ${preview}\n` +
        `Commit or stash your changes first (\`git stash\` or \`git commit\`).`,
    );
  }
}

function isPidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    // EPERM means process exists but belongs to another user
    return code === "EPERM";
  }
}

/**
 * Acquires an exclusive lockfile under `.sandcastle/logs/<lockName>`.
 * Automatically cleans up stale locks left behind by a crashed/killed process.
 */
export function acquireRunLock(
  lockName = ".run.lock",
  label = "factory",
  logsDir = path.join(".sandcastle", "logs"),
): () => void {
  mkdirSync(logsDir, { recursive: true });
  const lockPath = path.join(logsDir, lockName);

  const payload =
    JSON.stringify({ pid: process.pid, label, startedAt: new Date().toISOString() }, null, 2) + "\n";

  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      writeFileSync(lockPath, payload, { encoding: "utf8", flag: "wx" });
      break;
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== "EEXIST") {
        throw err;
      }
      try {
        const existing = JSON.parse(readFileSync(lockPath, "utf8")) as {
          pid?: number;
          label?: string;
          startedAt?: string;
        };
        if (typeof existing.pid === "number" && isPidAlive(existing.pid)) {
          throw new Error(
            `Another Sandcastle ${existing.label ?? "run"} is already active (PID ${existing.pid}, started ${existing.startedAt ?? "unknown"}). ` +
              `Wait for it to finish or stop it before starting a second run.`,
          );
        }
      } catch (readErr) {
        if (readErr instanceof Error && readErr.message.startsWith("Another Sandcastle")) {
          throw readErr;
        }
        // Malformed/stale lockfile — safe to remove and retry atomically
      }
      try {
        unlinkSync(lockPath);
      } catch {
        // Another process may have already removed the stale lock
      }
      if (attempt === 1) {
        throw new Error(`Could not acquire Sandcastle lockfile ${lockPath} due to concurrent startup.`);
      }
    }
  }

  let released = false;
  return () => {
    if (released) return;
    released = true;
    try {
      if (existsSync(lockPath)) unlinkSync(lockPath);
    } catch {
      // ignore cleanup errors on shutdown
    }
  };
}

/**
 * Deterministically validates LLM Planner output against live `local_tracker.py` ground truth:
 *   - Drops unknown IDs, non-`ready-for-agent` tickets, duplicates, or tickets with open blockers
 *   - Overwrites `splitDepth` with the tracker's authoritative `split_depth` (prevents infinite splitting)
 */
export function validatePlannedTicketsAgainstTracker<T extends PlannedTicketCandidate>(
  planned: readonly T[],
  trackerReadyTickets: readonly TrackerTicketSnapshot[],
): { readonly valid: T[]; readonly droppedReasons: readonly string[] } {
  const byId = new Map(trackerReadyTickets.map((t) => [t.id, t]));
  const seen = new Set<string>();
  const valid: T[] = [];
  const droppedReasons: string[] = [];

  for (const item of planned) {
    if (seen.has(item.id)) {
      droppedReasons.push(`${item.id}: duplicate entry in Planner batch.`);
      continue;
    }
    seen.add(item.id);
    const truth = byId.get(item.id);
    if (!truth) {
      droppedReasons.push(`${item.id}: not found in live ready-for-agent tracker queue.`);
      continue;
    }
    if (truth.status !== "ready-for-agent") {
      droppedReasons.push(`${item.id}: status is "${truth.status}" (expected ready-for-agent).`);
      continue;
    }
    if (truth.open_blockers.length > 0) {
      droppedReasons.push(
        `${item.id}: still blocked by [${truth.open_blockers.join(", ")}] — dropped.`,
      );
      continue;
    }
    valid.push({
      ...item,
      splitDepth: truth.split_depth,
    });
  }

  return { valid, droppedReasons };
}
