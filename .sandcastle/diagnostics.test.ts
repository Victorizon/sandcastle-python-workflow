import assert from "node:assert/strict";
import { mkdtempSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import test from "node:test";
import {
  RunTracer,
  formatDiagnoseReport,
  loadTraceSpans,
  resolveLatestTraceFile,
  summarizeTrace,
} from "./diagnostics.js";

test("RunTracer writes JSONL phase spans, updates latest-trace pointer, and summarizes anomalies", () => {
  const logsDir = mkdtempSync(path.join(os.tmpdir(), "sandcastle-diag-"));
  try {
    const tracer = new RunTracer(logsDir, true);
    const logCfg = tracer.sandboxLogging(1, "merge");
    assert.equal(logCfg.type, "file");
    assert.equal(logCfg.verbose, true);
    assert.ok(logCfg.path.includes("c1-merge.log"));

    tracer.recordSpan({ cycle: 1, phase: "planner", outcome: "pass", durationMs: 1200, detail: "picked 2, dropped 1" });
    tracer.recordSpan({ cycle: 1, sliceId: "feat/01", phase: "implement", outcome: "pass", durationMs: 4500 });
    tracer.recordSpan({ cycle: 1, phase: "merge", outcome: "pass", durationMs: 2100, detail: "merged 2 branches" });
    tracer.recordSpan({
      cycle: 1,
      phase: "post_merge_audit",
      outcome: "rollback",
      durationMs: 1800,
      detail: "dropped requirement from feat/01",
    });

    const latest = resolveLatestTraceFile(logsDir);
    assert.equal(latest, tracer.traceFile);
    const spans = loadTraceSpans(tracer.traceFile);
    assert.equal(spans.length, 4);

    const summary = summarizeTrace(spans);
    assert.equal(summary.totalSpans, 4);
    assert.equal(summary.totalDurationMs, 9600);
    assert.equal(summary.anomalies.length, 1);
    assert.equal(summary.mergeAndAuditVerdicts.length, 2);

    const report = formatDiagnoseReport(tracer.traceFile, spans);
    assert.match(report, /Sandcastle Post-Run Autopsy/u);
    assert.match(report, /post_merge_audit/u);
    assert.match(report, /ROLLBACK/u);
    assert.match(report, /dropped requirement from feat\/01/u);
  } finally {
    rmSync(logsDir, { recursive: true, force: true });
  }
});
