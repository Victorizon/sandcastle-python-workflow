/**
 * Real-Docker End-to-End Synthetic Workflow Test (`npm --prefix .sandcastle run e2e`).
 *
 * Proves the ENTIRE pipeline inside a REAL Docker container built from `.sandcastle/Dockerfile`
 * using synthetic data — zero LLM API keys needed — while streaming live PM updates to the
 * real-time Mission Control Dashboard (`http://127.0.0.1:4311`).
 *
 * Scenarios exercised inside a real isolated container + temporary git clone:
 *   1. Slice 01 (Unknown risk_tier fail-closed):
 *      Builder writes fixture + code -> Adversarial Reviewer challenges a missing reason check
 *      -> Builder fixes on Round 2 -> Real 6-gate `python scripts/check.py` PASSES inside Docker
 *      -> Merged to main & resolved.
 *   2. Slice 02 (Oversized multi-rule slice):
 *      Real DriftWatchdog detects thrash loop -> Aborts worker -> Real `scripts/local_tracker.py split`
 *      splits into 2 smaller child slices (03 & 04, split_depth=1).
 *   3. Slice 03 (Child slice A — Reject unknown channel):
 *      Real 6-gate `python scripts/check.py` PASSES inside Docker -> Merged to main.
 *   4. Slice 04 (Child slice B — Test-tampering catch & recovery):
 *      Simulated bad agent tries to weaken an existing assertion -> REAL `scripts/test_guard.py`
 *      inside Docker BLOCKS the cheat -> Agent reverts & writes proper additive test
 *      -> REAL 6-gate `python scripts/check.py` PASSES inside Docker -> Merged to main (100%!).
 */

import { execFileSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { PMDashboard, parseCheckMetrics } from "./dashboard.js";
import { DriftWatchdog } from "./drift-watchdog.js";

const REPO_ROOT = path.resolve(import.meta.dirname, "..");
const IMAGE_NAME = process.env["SANDCASTLE_IMAGE"] ?? "sandcastle:python-codex";
const KEEP_OPEN_SEC = Number(process.env["DASHBOARD_KEEP_OPEN_SEC"] ?? "0");
const STEP_DELAY_MS = Number(process.env["E2E_STEP_DELAY_MS"] ?? "1400");

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function runHost(cmd: string, args: string[], cwd: string): string {
  return execFileSync(cmd, args, { cwd, encoding: "utf8", stdio: ["pipe", "pipe", "pipe"] });
}

function dockerExec(container: string, bashCmd: string): { code: number; out: string } {
  try {
    const out = execFileSync("docker", ["exec", "-w", "/home/agent/workspace", container, "bash", "-lc", bashCmd], {
      encoding: "utf8",
      stdio: ["pipe", "pipe", "pipe"],
    });
    return { code: 0, out };
  } catch (err) {
    const e = err as { status?: number; stdout?: string; stderr?: string };
    return { code: e.status ?? 1, out: `${e.stdout ?? ""}\n${e.stderr ?? ""}`.trim() };
  }
}

function createTempRepoCopy(): string {
  const tmp = mkdtempSync(path.join(os.tmpdir(), "sandcastle-e2e-"));
  const dest = path.join(tmp, "repo");
  cpSync(REPO_ROOT, dest, {
    recursive: true,
    filter: (src) =>
      ![".git", ".venv", "node_modules", "__pycache__", ".pytest_cache", ".ruff_cache"].some((skip) =>
        src.includes(`${path.sep}${skip}`),
      ),
  });
  runHost("git", ["init", "-b", "main"], dest);
  runHost("git", ["config", "user.email", "e2e@example.test"], dest);
  runHost("git", ["config", "user.name", "Synthetic E2E"], dest);
  runHost("git", ["add", "."], dest);
  runHost("git", ["commit", "-m", "chore: e2e synthetic baseline"], dest);
  return dest;
}

async function main(): Promise<void> {
  const dashboard = new PMDashboard({
    title: "Sandcastle Workflow — Live Synthetic E2E (Real Docker)",
    mode: "synthetic-e2e",
    dockerImage: IMAGE_NAME,
    maxCycles: 2,
  });
  const url = await dashboard.start();
  console.log(`\nPM Mission Control Dashboard LIVE at: ${url}\n`);

  const tmpRepo = createTempRepoCopy();
  const containerName = `sandcastle-e2e-${Date.now()}`;

  try {
    dashboard.addEvent({
      level: "info",
      headline: "Booting isolated Docker container",
      detail: `Starting ${IMAGE_NAME} mounted to temporary isolated clone with pre-baked /opt/venv Python tools.`,
    });

    // Boot real container from our built image
    runHost(
      "docker",
      [
        "run",
        "-d",
        "--rm",
        "--name",
        containerName,
        "-v",
        `${tmpRepo}:/home/agent/workspace`,
        IMAGE_NAME,
      ],
      tmpRepo,
    );

    // Seed Ticket 02 (an intentionally oversized ticket that will trigger DriftWatchdog + auto-split)
    writeFileSync(
      path.join(tmpRepo, ".scratch/workflow-smoke-test/issues/02-multi-signal-hardening.md"),
      [
        "# 02: Multi-signal validation & region allowlist hardening",
        "",
        "**What to build:** Validate empty channel strings and add strict region validation across all order signals.",
        "",
        "**Blocked by:** None (can start immediately)",
        "",
        "**Status:** ready-for-agent",
        "",
        "- [ ] Fail closed on blank channel",
        "- [ ] Fail closed on unsupported region",
      ].join("\n") + "\n",
      "utf8",
    );
    runHost("git", ["add", ".scratch/"], tmpRepo);
    runHost("git", ["commit", "-m", "chore: add second synthetic ticket"], tmpRepo);

    // Phase 1: Planner discovers initial unblocked slices inside Docker
    dashboard.setCycle(1, "Planner container scanning open ready-for-agent slices...");
    const planOut = dockerExec(containerName, "python scripts/local_tracker.py list --status ready-for-agent --json");
    if (planOut.code !== 0) throw new Error(`Tracker failed in Docker: ${planOut.out}`);
    const planned = JSON.parse(planOut.out) as { id: string; title: string }[];

    for (const t of planned) {
      dashboard.upsertSlice(t.id, {
        title: t.title,
        branch: `sandcastle/${t.id}`,
        stage: "queued",
        containerName,
        pmSummary: "Planned by Planner container — queued for isolated execution.",
      });
    }
    dashboard.addEvent({
      level: "info",
      headline: `Planner scheduled ${planned.length} synthetic slices`,
      detail: "Both tickets are unblocked and ready for container execution.",
      technicalLog: planOut.out.slice(0, 600),
    });
    await sleep(STEP_DELAY_MS);

    // === SLICE 1: Unknown risk_tier -> Adversarial Challenge caught -> Fixed on Round 2 -> 6-Gate PASS ===
    const s1 = "workflow-smoke-test/01";
    dashboard.setCycle(1, `Building ${s1} inside Docker container...`);
    dashboard.upsertSlice(s1, {
      stage: "implementing",
      pmSummary: "Builder is creating anonymized unknown-risk fixture and updating order_triage.py via TDD.",
      watchdog: { elapsedSec: 120, toolCalls: 9, diffLines: 44 },
    });
    dockerExec(containerName, "git checkout -b sandcastle/workflow-smoke-test/01");
    await sleep(STEP_DELAY_MS);

    // Write anonymized fixture + first-draft code (intentionally missing exact reason string so Reviewer challenges it!)
    writeFileSync(
      path.join(tmpRepo, "tests/fixtures/order_triage/unknown_risk_tier_fail_closed.json"),
      JSON.stringify(
        {
          order: {
            order_id: "ord-unk-008",
            partner_id: "partner-trusted-01",
            customer_email: "qa.demo@example.test",
            channel: "api",
            region: "US",
          },
          allowlisted_partners: ["partner-trusted-01"],
          signals: [
            {
              channel: "api",
              region: "US",
              payment_verified: true,
              address_matched: true,
              risk_tier: "unexpectedTier",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );

    const procPath = path.join(tmpRepo, "src/app/processors/order_triage.py");
    const origProc = readFileSync(procPath, "utf8");
    const draftProc = origProc.replace(
      '    if not signals:\n        return _fail_closed(order_id, "fail_closed_missing_signals")',
      [
        '    if not signals:',
        '        return _fail_closed(order_id, "fail_closed_missing_signals")',
        '',
        '    known_tiers = {"low", "medium", "high"}',
        '    if any(s.risk_tier not in known_tiers for s in signals):',
        '        return _fail_closed(order_id, "fail_closed_bad_tier")',
      ].join("\n"),
    );
    writeFileSync(procPath, draftProc, "utf8");

    const testPath = path.join(tmpRepo, "tests/test_order_triage.py");
    const origTests = readFileSync(testPath, "utf8");
    writeFileSync(
      testPath,
      origTests +
        [
          "",
          "",
          "def test_unknown_risk_tier_fails_closed_even_for_allowlisted_partner() -> None:",
          "    client = FakeExternalClient.from_fixture_file(",
          '        FIXTURES / "unknown_risk_tier_fail_closed.json"',
          "    )",
          "",
          '    result = triage_order("ord-unk-008", client)',
          "",
          "    assert result.decision is Decision.MANUAL_REVIEW",
          "    assert result.auto_execute is False",
          "",
        ].join("\n"),
      "utf8",
    );

    // Fresh Adversarial Reviewer challenges the wrong reason string!
    dashboard.upsertSlice(s1, {
      stage: "reviewing",
      pmSummary: "Fresh Adversarial Reviewer inspecting diff against spec and CODING_STANDARDS.md...",
      watchdog: { elapsedSec: 185, toolCalls: 14, diffLines: 56 },
    });
    await sleep(STEP_DELAY_MS);

    dashboard.upsertSlice(s1, {
      stage: "remediating",
      pmSummary: "Adversarial Reviewer challenged spec compliance — Builder fixing reason code & assertion (Round 2).",
    });
    dashboard.recordChallenge(s1, {
      source: "reviewer",
      finding:
        'Spec required reason=="fail_closed_unknown_risk_tier" + explicit assertion; Builder emitted "fail_closed_bad_tier".',
      outcome: "fixed",
    });
    dashboard.addEvent({
      sliceId: s1,
      level: "challenge",
      headline: "Adversarial Reviewer caught spec mismatch (Round 1 -> Fixed)",
      detail:
        'Fresh Reviewer caught wrong escalation reason ("fail_closed_bad_tier") and missing assertion. Sent back to Builder and resolved cleanly.',
    });
    await sleep(STEP_DELAY_MS);

    // Builder fixes exact reason + explicit assertion
    writeFileSync(procPath, draftProc.replace("fail_closed_bad_tier", "fail_closed_unknown_risk_tier"), "utf8");
    writeFileSync(
      testPath,
      readFileSync(testPath, "utf8") + '    assert result.reason == "fail_closed_unknown_risk_tier"\n',
      "utf8",
    );

    // Run REAL 6-gate `python scripts/check.py` inside Docker!
    dashboard.upsertSlice(s1, {
      stage: "verifying",
      pmSummary: "Referee executing real 6-gate `python scripts/check.py` inside Docker container...",
      watchdog: { elapsedSec: 220, toolCalls: 17, diffLines: 58 },
    });
    dockerExec(containerName, "ruff format src tests");
    const check1 = dockerExec(containerName, "python scripts/check.py");
    if (check1.code !== 0) throw new Error(`Slice 1 check.py failed in Docker:\n${check1.out}`);
    const q1 = parseCheckMetrics(check1.out);
    dashboard.recordQualityMetrics(q1.coveragePercent, q1.mutationScore);

    dockerExec(containerName, 'git add . && git commit -m "RALPH: workflow-smoke-test/01 - fail closed on unknown risk_tier"');
    dockerExec(containerName, "git checkout main && git merge sandcastle/workflow-smoke-test/01 --no-edit");
    dockerExec(containerName, 'python scripts/local_tracker.py resolve workflow-smoke-test/01 --summary "Verified in Docker"');
    dockerExec(containerName, 'git add .scratch/ && git commit -m "RALPH: Merge and resolve slice 01"');

    dashboard.upsertSlice(s1, {
      stage: "merged",
      pmSummary: `All 6 gates passed inside Docker (Coverage ${q1.coveragePercent ?? 100}%, Mutation ${q1.mutationScore ?? 93}%). Merged to main.`,
    });
    dashboard.addEvent({
      sliceId: s1,
      level: "success",
      headline: "Slice 01 passed all 6 Docker gates & merged to main",
      detail: `Coverage ${q1.coveragePercent}% · AST Mutation Kill ${q1.mutationScore}% · Adversarial challenge resolved before merge.`,
      technicalLog: check1.out.slice(-900),
    });
    await sleep(STEP_DELAY_MS);

    // === SLICE 2: DriftWatchdog catches thrash loop -> Auto-splits via real local_tracker.py split ===
    const s2 = "workflow-smoke-test/02";
    dashboard.setCycle(1, `Supervising ${s2} with real DriftWatchdog...`);
    dashboard.upsertSlice(s2, {
      stage: "implementing",
      pmSummary: "Builder working on oversized multi-rule ticket inside Docker...",
      watchdog: { elapsedSec: 540, toolCalls: 28, diffLines: 190 },
    });
    await sleep(STEP_DELAY_MS);

    // Trigger real DriftWatchdog thrash detector
    const wd = new DriftWatchdog({ maxTicketMs: 60_000, maxRepeatedToolCalls: 4 });
    for (let i = 0; i < 4; i++) {
      wd.onEvent({
        type: "toolCall",
        name: "shell",
        formattedArgs: "pytest tests/test_order_triage.py",
        iteration: 2,
        timestamp: new Date(),
      });
    }
    const driftMsg = wd.drift?.message ?? "Drift detected (thrash_loop)";
    wd.dispose();

    dashboard.recordChallenge(s2, {
      source: "drift_watchdog",
      finding: `${driftMsg} — aborted worker & auto-split into 2 smaller slices (depth=1).`,
      outcome: "split",
    });
    dashboard.upsertSlice(s2, {
      stage: "split",
      pmSummary: "Stopped automatically by DriftWatchdog; re-sliced by Decomposer into 2 focused sub-slices.",
      watchdog: { elapsedSec: 610, toolCalls: 32, diffLines: 190 },
    });

    const splitPlan = {
      reason: driftMsg,
      subtickets: [
        {
          title: "Fail closed on empty verification channel",
          what_to_build: "Reject blank channel strings with MANUAL_REVIEW.",
          acceptance_criteria: ["Add fixture + test", "python scripts/check.py passes"],
          blocked_by_indexes: [],
        },
        {
          title: "Fail closed on empty verification region",
          what_to_build: "Reject blank region strings with MANUAL_REVIEW.",
          acceptance_criteria: ["Add fixture + test", "python scripts/check.py passes"],
          blocked_by_indexes: [0],
        },
      ],
    };
    const splitPath = path.join(tmpRepo, ".sandcastle/logs/split-02.json");
    mkdirSync(path.dirname(splitPath), { recursive: true });
    writeFileSync(splitPath, JSON.stringify(splitPlan, null, 2), "utf8");
    const splitRes = dockerExec(
      containerName,
      "python scripts/local_tracker.py split workflow-smoke-test/02 --plan-json .sandcastle/logs/split-02.json --max-depth 1",
    );
    if (splitRes.code !== 0) throw new Error(`Split failed in Docker: ${splitRes.out}`);
    dockerExec(containerName, 'git add .scratch/ && git commit -m "chore(watchdog): auto-split slice 02"');

    dashboard.addEvent({
      sliceId: s2,
      level: "challenge",
      headline: "DriftWatchdog stopped thrashing & auto-split oversized ticket",
      detail: "Worker repeated identical failing test calls 4x. Watchdog aborted it and split the ticket into sub-slices 03 & 04.",
      technicalLog: splitRes.out,
    });

    // Cycle 2: Register sub-slices 03 & 04
    const s3 = "workflow-smoke-test/03";
    const s4 = "workflow-smoke-test/04";
    dashboard.setCycle(2, "Cycle 2: Executing auto-split sub-slices 03 & 04 inside Docker...");
    dashboard.upsertSlice(s3, {
      title: "03: Fail closed on empty verification channel",
      splitDepth: 1,
      parentId: s2,
      stage: "implementing",
      containerName,
      pmSummary: "Implementing focused sub-slice A (blank channel fail-closed check).",
      watchdog: { elapsedSec: 95, toolCalls: 8, diffLines: 38 },
    });
    dashboard.upsertSlice(s4, {
      title: "04: Fail closed on empty verification region",
      splitDepth: 1,
      parentId: s2,
      stage: "queued",
      containerName,
      pmSummary: "Waiting on sub-slice 03 to merge before starting.",
    });
    await sleep(STEP_DELAY_MS);

    // === SLICE 3: Clean implementation + real Docker 6-gate PASS ===
    dockerExec(containerName, "git checkout -b sandcastle/workflow-smoke-test/03");
    writeFileSync(
      path.join(tmpRepo, "tests/fixtures/order_triage/blank_channel_fail_closed.json"),
      JSON.stringify(
        {
          order: {
            order_id: "ord-ch-009",
            partner_id: "partner-trusted-01",
            customer_email: "qa2.demo@example.test",
            channel: "",
            region: "US",
          },
          allowlisted_partners: ["partner-trusted-01"],
          signals: [
            {
              channel: "",
              region: "US",
              payment_verified: true,
              address_matched: true,
              risk_tier: "low",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      procPath,
      readFileSync(procPath, "utf8").replace(
        '    if any(s.risk_tier not in known_tiers for s in signals):\n        return _fail_closed(order_id, "fail_closed_unknown_risk_tier")',
        [
          '    if any(s.risk_tier not in known_tiers for s in signals):',
          '        return _fail_closed(order_id, "fail_closed_unknown_risk_tier")',
          '',
          '    if any(not s.channel.strip() for s in signals):',
          '        return _fail_closed(order_id, "fail_closed_blank_channel")',
        ].join("\n"),
      ),
      "utf8",
    );
    writeFileSync(
      testPath,
      readFileSync(testPath, "utf8") +
        [
          "",
          "",
          "def test_blank_channel_fails_closed_to_manual_review() -> None:",
          '    client = FakeExternalClient.from_fixture_file(FIXTURES / "blank_channel_fail_closed.json")',
          "",
          '    result = triage_order("ord-ch-009", client)',
          "",
          "    assert result.decision is Decision.MANUAL_REVIEW",
          "    assert result.auto_execute is False",
          '    assert result.reason == "fail_closed_blank_channel"',
          "",
        ].join("\n"),
      "utf8",
    );

    dashboard.upsertSlice(s3, {
      stage: "verifying",
      pmSummary: "Running real 6-gate `python scripts/check.py` inside Docker...",
    });
    dockerExec(containerName, "ruff format src tests");
    const check3 = dockerExec(containerName, "python scripts/check.py");
    if (check3.code !== 0) throw new Error(`Slice 3 check.py failed:\n${check3.out}`);
    const q3 = parseCheckMetrics(check3.out);
    dashboard.recordQualityMetrics(q3.coveragePercent, q3.mutationScore);

    dockerExec(containerName, 'git add . && git commit -m "RALPH: workflow-smoke-test/03 - blank channel fail-closed"');
    dockerExec(containerName, "git checkout main && git merge sandcastle/workflow-smoke-test/03 --no-edit");
    dockerExec(containerName, 'python scripts/local_tracker.py resolve workflow-smoke-test/03 --summary "Merged"');
    dockerExec(containerName, 'git add .scratch/ && git commit -m "RALPH: Merge and resolve slice 03"');

    dashboard.upsertSlice(s3, {
      stage: "merged",
      pmSummary: `Sub-slice passed all 6 Docker gates cleanly (Coverage ${q3.coveragePercent}%, Mutation ${q3.mutationScore}%). Merged!`,
    });
    dashboard.addEvent({
      sliceId: s3,
      level: "success",
      headline: "Auto-split sub-slice 03 passed cleanly & merged",
      detail: "Breaking the oversized ticket down let the worker finish cleanly in under 2 minutes.",
    });
    await sleep(STEP_DELAY_MS);

    // === SLICE 4: Simulated cheat attempt -> REAL test_guard.py BLOCKS -> Reverts & finishes cleanly ===
    dashboard.setCycle(2, `Supervising ${s4} — testing strict anti-tamper lock inside Docker...`);
    dashboard.upsertSlice(s4, {
      stage: "implementing",
      pmSummary: "Builder implementing sub-slice B (blank region fail-closed check)...",
      watchdog: { elapsedSec: 80, toolCalls: 7, diffLines: 32 },
    });
    dockerExec(containerName, "git checkout -b sandcastle/workflow-smoke-test/04");
    await sleep(STEP_DELAY_MS);

    // Simulate agent trying to weaken an existing assertion to cheat!
    const preCheatTests = readFileSync(testPath, "utf8");
    const weakened = preCheatTests.replace(/^\s*assert result\.auto_execute is False\r?\n/m, "");
    if (weakened === preCheatTests) {
      throw new Error("Test setup error: expected assertion line not found");
    }
    writeFileSync(testPath, weakened, "utf8");
    const guardBlock = dockerExec(containerName, "python scripts/test_guard.py --base main");
    if (guardBlock.code === 0) throw new Error("Expected test_guard.py to block assertion removal!");

    dashboard.upsertSlice(s4, {
      stage: "remediating",
      pmSummary: "Anti-tamper lock caught attempted removal of existing test assertion — blocked & recovered!",
    });
    dashboard.recordChallenge(s4, {
      source: "test_guard",
      finding: "Blocked attempt to reduce assertion count on an existing test (`test_guard.py` exit 1).",
      outcome: "fixed",
    });
    dashboard.addEvent({
      sliceId: s4,
      level: "challenge",
      headline: "Strict Test Guard blocked attempted test weakening inside Docker",
      detail: "Simulated agent removed an assertion on an existing test. `scripts/test_guard.py` caught it mechanically before merge.",
      technicalLog: guardBlock.out,
    });
    await sleep(STEP_DELAY_MS);

    // Restore existing tests and add proper additive fixture + implementation
    writeFileSync(testPath, preCheatTests, "utf8");
    writeFileSync(
      path.join(tmpRepo, "tests/fixtures/order_triage/blank_region_fail_closed.json"),
      JSON.stringify(
        {
          order: {
            order_id: "ord-reg-010",
            partner_id: "partner-trusted-01",
            customer_email: "qa3.demo@example.test",
            channel: "api",
            region: "",
          },
          allowlisted_partners: ["partner-trusted-01"],
          signals: [
            {
              channel: "api",
              region: "",
              payment_verified: true,
              address_matched: true,
              risk_tier: "low",
            },
          ],
        },
        null,
        2,
      ) + "\n",
      "utf8",
    );
    writeFileSync(
      procPath,
      readFileSync(procPath, "utf8").replace(
        [
          '    known_tiers = {"low", "medium", "high"}',
          '    if any(s.risk_tier not in known_tiers for s in signals):',
          '        return _fail_closed(order_id, "fail_closed_unknown_risk_tier")',
          '',
          '    if any(not s.channel.strip() for s in signals):',
          '        return _fail_closed(order_id, "fail_closed_blank_channel")',
        ].join("\n"),
        [
          '    known_tiers = {"low", "medium", "high"}',
          '    invalid_reason = (',
          '        "fail_closed_unknown_risk_tier"',
          '        if any(s.risk_tier not in known_tiers for s in signals)',
          '        else "fail_closed_blank_channel"',
          '        if any(not s.channel.strip() for s in signals)',
          '        else "fail_closed_blank_region"',
          '        if any(not s.region.strip() for s in signals)',
          '        else None',
          '    )',
          '    if invalid_reason is not None:',
          '        return _fail_closed(order_id, invalid_reason)',
        ].join("\n"),
      ),
      "utf8",
    );
    writeFileSync(
      testPath,
      readFileSync(testPath, "utf8") +
        [
          "",
          "",
          "def test_blank_region_fails_closed_to_manual_review() -> None:",
          '    client = FakeExternalClient.from_fixture_file(FIXTURES / "blank_region_fail_closed.json")',
          "",
          '    result = triage_order("ord-reg-010", client)',
          "",
          "    assert result.decision is Decision.MANUAL_REVIEW",
          "    assert result.auto_execute is False",
          '    assert result.reason == "fail_closed_blank_region"',
          "",
        ].join("\n"),
      "utf8",
    );

    dashboard.upsertSlice(s4, {
      stage: "verifying",
      pmSummary: "Re-running all 6 deterministic gates inside Docker after clean fix...",
      watchdog: { elapsedSec: 155, toolCalls: 13, diffLines: 49 },
    });
    dockerExec(containerName, "ruff format src tests");
    const check4 = dockerExec(containerName, "python scripts/check.py");
    if (check4.code !== 0) throw new Error(`Slice 4 check.py failed:\n${check4.out}`);
    const q4 = parseCheckMetrics(check4.out);
    dashboard.recordQualityMetrics(q4.coveragePercent, q4.mutationScore);

    dockerExec(containerName, 'git add . && git commit -m "RALPH: workflow-smoke-test/04 - blank region fail-closed"');
    dockerExec(containerName, "git checkout main && git merge sandcastle/workflow-smoke-test/04 --no-edit");
    dockerExec(containerName, 'python scripts/local_tracker.py resolve workflow-smoke-test/04 --summary "Merged"');
    dockerExec(containerName, 'git add .scratch/ && git commit -m "RALPH: Merge and resolve slice 04"');

    dashboard.upsertSlice(s4, {
      stage: "merged",
      pmSummary: `Recovered cleanly & passed all 6 Docker gates (Coverage ${q4.coveragePercent}%, Mutation ${q4.mutationScore}%). Merged!`,
    });
    dashboard.setRunStatus(
      "complete",
      "100% complete — all 3 active slices verified inside Docker and merged cleanly!",
    );
    dashboard.addEvent({
      level: "success",
      headline: "End-to-End Docker Synthetic Run COMPLETE (100%)",
      detail: `3/3 deliverable slices shipped · 1 Adversarial Challenge caught & fixed · 1 Drift Auto-Split executed · 1 Test-Tamper cheat blocked · Coverage ${q4.coveragePercent}% · Mutation kill ${q4.mutationScore}%.`,
    });

    console.log("\n=== SYNTHETIC DOCKER E2E TEST PASSED 100% ===");
    console.log(`Dashboard URL: ${url}`);
    if (KEEP_OPEN_SEC > 0) {
      console.log(`Keeping PM Dashboard live for ${KEEP_OPEN_SEC}s so you can inspect it...`);
      await sleep(KEEP_OPEN_SEC * 1000);
    }
  } finally {
    try {
      execFileSync("docker", ["rm", "-f", containerName], { stdio: "ignore" });
    } catch {
      // already stopped
    }
    rmSync(path.dirname(tmpRepo), { recursive: true, force: true });
    await dashboard.close();
  }
}

await main();
