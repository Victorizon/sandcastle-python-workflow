import assert from "node:assert/strict";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DriftDetectedError } from "./drift-watchdog.js";
import { countLocalTicketsByStatus, evaluateGoalContract } from "./goal-core.js";
import {
  classifyError,
  installGracefulShutdown,
  resolvePythonBin,
  withTransientRetry,
} from "./resilience.js";

test("classifyError separates transient rate-limit/network errors from permanent failures", () => {
  assert.equal(classifyError(new Error("HTTP 429 Too Many Requests")), "transient");
  assert.equal(classifyError(new Error("503 Service temporarily unavailable")), "transient");
  assert.equal(classifyError(new Error("read ECONNRESET")), "transient");

  assert.equal(classifyError(new Error("401 Unauthorized: invalid_api_key")), "permanent");
  assert.equal(classifyError(new DriftDetectedError("thrash_loop", "looping")), "permanent");
  assert.equal(classifyError(new Error("SyntaxError: unexpected token")), "permanent");
});

test("withTransientRetry retries transient blips and fails fast on permanent errors", async () => {
  let transientCalls = 0;
  const delays: number[] = [];
  const recovered = await withTransientRetry(
    async () => {
      transientCalls += 1;
      if (transientCalls < 3) {
        throw new Error("429 rate limit exceeded");
      }
      return "ok";
    },
    {
      label: "test-op",
      maxRetries: 3,
      baseDelayMs: 10,
      maxDelayMs: 50,
      sleepFn: async (ms) => {
        delays.push(ms);
      },
    },
  );
  assert.equal(recovered, "ok");
  assert.equal(transientCalls, 3);
  assert.equal(delays.length, 2);

  let permanentCalls = 0;
  await assert.rejects(
    () =>
      withTransientRetry(
        async () => {
          permanentCalls += 1;
          throw new Error("401 Unauthorized");
        },
        {
          label: "auth-op",
          maxRetries: 3,
          baseDelayMs: 10,
          sleepFn: async () => {},
        },
      ),
    /401 Unauthorized/u,
  );
  assert.equal(permanentCalls, 1);
});

test("resolvePythonBin prefers local .venv Python and countLocalTicketsByStatus fails closed on errors", () => {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-resilience-"));
  try {
    const venvBin =
      process.platform === "win32"
        ? path.join(tmp, ".venv", "Scripts", "python.exe")
        : path.join(tmp, ".venv", "bin", "python");
    mkdirSync(path.dirname(venvBin), { recursive: true });
    writeFileSync(venvBin, "", "utf8");
    assert.equal(resolvePythonBin(tmp), venvBin);

    // Empty dir without scripts/local_tracker.py -> MUST return -1 (fail closed), NEVER 0!
    const brokenDir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-broken-"));
    try {
      assert.equal(countLocalTicketsByStatus("ready-for-agent", brokenDir), -1);
      const evalResult = evaluateGoalContract(
        {
          name: "Fail-Closed Tracker Test",
          slug: "fail-closed-test",
          researchDepth: "skip",
          requireAllTicketsResolved: true,
          verifyCommands: ["node -e \"process.exit(0)\""],
          maxTotalMinutes: 10,
          maxStalledCycles: 2,
          maxGapPlanRounds: 0,
        },
        brokenDir,
      );
      assert.equal(evalResult.met, false);
    } finally {
      rmSync(brokenDir, { recursive: true, force: true });
    }
  } finally {
    rmSync(tmp, { recursive: true, force: true });
  }
});

test("installGracefulShutdown registers and cleanly uninstalls SIGINT/SIGTERM listeners", () => {
  const beforeSigint = process.listenerCount("SIGINT");
  const beforeSigterm = process.listenerCount("SIGTERM");
  const uninstall = installGracefulShutdown(() => {});
  assert.equal(process.listenerCount("SIGINT"), beforeSigint + 1);
  assert.equal(process.listenerCount("SIGTERM"), beforeSigterm + 1);
  uninstall();
  assert.equal(process.listenerCount("SIGINT"), beforeSigint);
  assert.equal(process.listenerCount("SIGTERM"), beforeSigterm);
});
