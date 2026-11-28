import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import { DriftDetectedError } from "./drift-watchdog.js";
import { countLocalTicketsByStatus, evaluateGoalContract } from "./goal-core.js";
import {
  REPO_MUTATION_LOCK,
  acquireRunLock,
  assertCleanGitWorktree,
  commitScratchState,
  rollbackToCommitClean,
} from "./preflight.js";
import {
  classifyError,
  installGracefulShutdown,
  normalizeRepoCwd,
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

test("commitScratchState and rollbackToCommitClean keep git worktree clean for subsequent cycles", () => {
  const repo = mkdtempSync(path.join(os.tmpdir(), "sandcastle-git-continuity-"));
  const git = (args: string[]) =>
    execFileSync("git", args, { cwd: repo, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] }).trim();
  try {
    git(["init"]);
    git(["config", "user.email", "test@example.com"]);
    git(["config", "user.name", "Test"]);
    writeFileSync(path.join(repo, "README.md"), "base\n", "utf8");
    git(["add", "README.md"]);
    git(["commit", "-m", "initial"]);
    const baseSha = git(["rev-parse", "HEAD"]);

    // 1. No-op when .scratch/ is clean
    assert.equal(commitScratchState("chore: noop", repo), false);

    // 2. Escalation mutating .scratch/ commits cleanly and leaves worktree clean
    mkdirSync(path.join(repo, ".scratch", "feat", "issues"), { recursive: true });
    writeFileSync(path.join(repo, ".scratch", "feat", "issues", "01.md"), "status: ready-for-human\n", "utf8");
    assert.equal(commitScratchState("chore(factory): escalate 01", repo), true);
    assert.doesNotThrow(() => assertCleanGitWorktree(repo));

    // 3. Rollback resets HEAD AND cleans untracked files while preserving .sandcastle/logs
    mkdirSync(path.join(repo, ".sandcastle", "logs"), { recursive: true });
    writeFileSync(path.join(repo, ".sandcastle", "logs", "keep.log"), "ok\n", "utf8");
    writeFileSync(path.join(repo, "stray_untracked.py"), "x = 1\n", "utf8");
    rollbackToCommitClean(baseSha, repo);

    assert.equal(git(["rev-parse", "HEAD"]), baseSha);
    assert.equal(existsSync(path.join(repo, "stray_untracked.py")), false);
    assert.equal(existsSync(path.join(repo, ".sandcastle", "logs", "keep.log")), true);
    assert.equal(git(["status", "--porcelain", "--", "stray_untracked.py"]), "");
  } finally {
    rmSync(repo, { recursive: true, force: true });
  }
});

test("normalizeRepoCwd chdirs from .sandcastle/ to parent repo root and leaves other dirs untouched", () => {
  const originalCwd = process.cwd();
  const repo = mkdtempSync(path.join(os.tmpdir(), "sandcastle-cwd-norm-"));
  try {
    mkdirSync(path.join(repo, ".sandcastle"), { recursive: true });
    mkdirSync(path.join(repo, "scripts"), { recursive: true });
    process.chdir(path.join(repo, ".sandcastle"));
    const normalized = normalizeRepoCwd();
    assert.equal(path.resolve(normalized), path.resolve(repo));
    assert.equal(path.resolve(process.cwd()), path.resolve(repo));

    // Calling again from repo root is a safe no-op
    assert.equal(path.resolve(normalizeRepoCwd()), path.resolve(repo));
  } finally {
    process.chdir(originalCwd);
    rmSync(repo, { recursive: true, force: true });
  }
});

test("shared REPO_MUTATION_LOCK prevents concurrent factory/nightly/bakeoff collisions", () => {
  const logsDir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-lock-"));
  const release = acquireRunLock(REPO_MUTATION_LOCK, "factory", logsDir);
  try {
    assert.throws(
      () => acquireRunLock(REPO_MUTATION_LOCK, "nightly-arch", logsDir),
      /Another Sandcastle factory is already active/u,
    );
    assert.throws(
      () => acquireRunLock(REPO_MUTATION_LOCK, "bakeoff", logsDir),
      /Another Sandcastle factory is already active/u,
    );
  } finally {
    release();
    rmSync(logsDir, { recursive: true, force: true });
  }
});
