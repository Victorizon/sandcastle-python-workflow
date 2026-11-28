/**
 * Deterministic Continuity & Resilience Utilities (`.sandcastle/resilience.ts`).
 *
 * Zero-dependency durability primitives borrowed from production orchestrators:
 *   1. `.venv`-aware Python binary resolution (`resolvePythonBin`)
 *   2. Transient vs. permanent error classification (`classifyError`)
 *   3. Jittered exponential backoff for transient 429/5xx/network blips (`withTransientRetry`)
 *   4. Graceful `SIGINT` / `SIGTERM` shutdown trap (`installGracefulShutdown`)
 */

import { existsSync } from "node:fs";
import path from "node:path";

const TRANSIENT_PATTERN =
  /\b(429|502|503|504|rate[\s_-]?limit|too many requests|overloaded|econnreset|etimedout|eai_again|enotfound|socket hang up|temporarily unavailable)\b/iu;

const PERMANENT_PATTERN =
  /\b(401|403|unauthorized|forbidden|invalid_api_key|authentication failed|drift detected)\b/iu;

export function normalizeRepoCwd(cwd = process.cwd()): string {
  const resolved = path.resolve(cwd);
  if (path.basename(resolved) === ".sandcastle") {
    const parent = path.dirname(resolved);
    if (existsSync(path.join(parent, "scripts")) || existsSync(path.join(parent, ".git"))) {
      process.chdir(parent);
      return parent;
    }
  }
  return resolved;
}

export function resolvePythonBin(cwd = process.cwd()): string {
  const candidates =
    process.platform === "win32"
      ? [path.join(cwd, ".venv", "Scripts", "python.exe"), path.join(cwd, ".venv", "bin", "python")]
      : [path.join(cwd, ".venv", "bin", "python"), path.join(cwd, ".venv", "Scripts", "python.exe")];
  for (const candidate of candidates) {
    if (existsSync(candidate)) {
      return candidate;
    }
  }
  return process.platform === "win32" ? "python" : "python3";
}

export function classifyError(err: unknown): "transient" | "permanent" {
  if (err instanceof Error && err.name === "DriftDetectedError") {
    return "permanent";
  }
  const message = err instanceof Error ? `${err.name}: ${err.message}` : String(err);
  if (PERMANENT_PATTERN.test(message)) {
    return "permanent";
  }
  if (TRANSIENT_PATTERN.test(message)) {
    return "transient";
  }
  return "permanent";
}

export async function withTransientRetry<T>(
  operation: () => Promise<T>,
  options: {
    readonly label: string;
    readonly maxRetries?: number;
    readonly baseDelayMs?: number;
    readonly maxDelayMs?: number;
    readonly sleepFn?: (ms: number) => Promise<void>;
  },
): Promise<T> {
  const maxRetries = options.maxRetries ?? 3;
  const baseDelayMs = options.baseDelayMs ?? 5_000;
  const maxDelayMs = options.maxDelayMs ?? 45_000;
  const sleep = options.sleepFn ?? ((ms: number) => new Promise<void>((r) => setTimeout(r, ms)));

  let attempt = 0;
  while (true) {
    try {
      return await operation();
    } catch (err) {
      const kind = classifyError(err);
      if (kind !== "transient" || attempt >= maxRetries) {
        throw err;
      }
      attempt += 1;
      const expDelay = Math.min(maxDelayMs, baseDelayMs * 2 ** (attempt - 1));
      const jitter = Math.round(expDelay * (0.75 + Math.random() * 0.5));
      const detail = err instanceof Error ? err.message : String(err);
      console.warn(
        `  [RETRY ${attempt}/${maxRetries}] Transient error in ${options.label} (${detail.slice(0, 120)}). Retrying in ${jitter}ms...`,
      );
      await sleep(jitter);
    }
  }
}

export function installGracefulShutdown(
  onShutdown: (signal: NodeJS.Signals) => void | Promise<void>,
): () => void {
  let triggered = false;
  const handler = (signal: NodeJS.Signals) => {
    if (triggered) return;
    triggered = true;
    console.warn(`\n[SHUTDOWN] Received ${signal} — cleaning up locks and saving state...`);
    Promise.resolve(onShutdown(signal))
      .catch((err) => {
        console.error("[SHUTDOWN] Cleanup error:", err);
      })
      .finally(() => {
        process.exit(signal === "SIGINT" ? 130 : 143);
      });
  };

  process.on("SIGINT", handler);
  process.on("SIGTERM", handler);
  return () => {
    process.off("SIGINT", handler);
    process.off("SIGTERM", handler);
  };
}
