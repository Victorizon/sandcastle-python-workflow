/**
 * Domain-Grounded Proof-of-Work Verifier (`.sandcastle/pow-verifier.ts`).
 *
 * Runs a fresh-context synthetic QA agent (ON by default; disable with `SANDCASTLE_POW_QA=0`)
 * that generates realistic, production-shaped offline scenarios anchored to `tests/fixtures/`,
 * `GLOSSARY.md`, `docs/adr/`, and `.out-of-scope/`:
 *   1. Per-slice (`runSliceProofOfWork`): tests a single slice branch before Adversarial Review.
 *   2. Post-merge (`runMergeProofOfWork`): tests cross-slice interactions when >= 2 branches merge.
 *
 * Probe files are quarantined & deleted after pytest runs; failing evidence is passed to the
 * Fresh Adversarial Reviewer / Post-Merge Auditor so hallucinated tests can never falsely block.
 */

import * as sandcastle from "@ai-hero/sandcastle";
import { Output } from "@ai-hero/sandcastle";
import { z } from "zod";
import { createAgent, createDockerSandbox } from "./agent-factory.js";
import type { RunTracer } from "./diagnostics.js";
import { withTransientRetry } from "./resilience.js";

export const PowVerdictSchema = z.object({
  status: z.enum(["verified", "defect_found", "no_new_scenarios"]),
  scenarios: z.array(z.string()).default([]),
  failingEvidence: z.array(z.string()).default([]),
  summary: z.string().min(1),
});

export type PowVerdict = z.infer<typeof PowVerdictSchema>;

export function isPowVerifierEnabled(env: NodeJS.ProcessEnv = process.env): boolean {
  const raw = env["SANDCASTLE_POW_QA"]?.trim().toLowerCase();
  return raw !== "0" && raw !== "false" && raw !== "off";
}

export function formatPowEvidenceForReviewer(verdict: PowVerdict | null): string {
  if (!verdict) {
    return "(Proof-of-Work Verifier skipped or unavailable.)";
  }
  const lines = [
    `Status: ${verdict.status}`,
    `Summary: ${verdict.summary}`,
    `Scenarios tested (${verdict.scenarios.length}):`,
    ...verdict.scenarios.slice(0, 6).map((s) => `  - ${s}`),
  ];
  if (verdict.failingEvidence.length > 0) {
    lines.push("Failing Synthetic Evidence (judge whether real defect or out-of-scope probe):");
    lines.push(...verdict.failingEvidence.slice(0, 6).map((f) => `  - ${f}`));
  }
  return lines.join("\n");
}

export async function runSliceProofOfWork(params: {
  readonly imageName: string;
  readonly ticket: { readonly id: string; readonly title: string; readonly branch: string };
  readonly cycle: number;
  readonly tracer?: RunTracer;
}): Promise<PowVerdict | null> {
  if (!isPowVerifierEnabled()) return null;
  const started = performance.now();
  try {
    const run = await withTransientRetry(
      () =>
        sandcastle.run({
          sandbox: createDockerSandbox(params.imageName),
          name: `Proof-of-Work Verifier ${params.ticket.id}`,
          branchStrategy: { type: "branch", branch: params.ticket.branch },
          agent: createAgent("medium"),
          logging: params.tracer?.sandboxLogging(params.cycle, "pow_verify", params.ticket.id),
          promptFile: "./.sandcastle/pow-slice-prompt.md",
          promptArgs: {
            TICKET_ID: params.ticket.id,
            TICKET_TITLE: params.ticket.title,
            BRANCH: params.ticket.branch,
          },
          maxIterations: 2,
          output: Output.object({ tag: "pow-verdict", schema: PowVerdictSchema, maxRetries: 2 }),
        }),
      { label: `PoW Verifier ${params.ticket.id}` },
    );
    const verdict = run.output;
    params.tracer?.recordSpan({
      cycle: params.cycle,
      sliceId: params.ticket.id,
      phase: "pow_verify",
      outcome: verdict.status === "defect_found" ? "fail" : "pass",
      durationMs: performance.now() - started,
      detail: verdict.summary,
    });
    return verdict;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.tracer?.recordSpan({
      cycle: params.cycle,
      sliceId: params.ticket.id,
      phase: "pow_verify",
      outcome: "fail",
      durationMs: performance.now() - started,
      detail: `PoW runner error: ${msg.slice(0, 140)}`,
    });
    return null;
  }
}

export async function runMergeProofOfWork(params: {
  readonly imageName: string;
  readonly preMergeSha: string;
  readonly tickets: readonly { readonly id: string; readonly title: string }[];
  readonly cycle: number;
  readonly tracer?: RunTracer;
}): Promise<PowVerdict | null> {
  if (!isPowVerifierEnabled() || params.tickets.length < 2) return null;
  const started = performance.now();
  try {
    const run = await withTransientRetry(
      () =>
        sandcastle.run({
          sandbox: createDockerSandbox(params.imageName),
          name: "Cross-Slice Proof-of-Work Verifier",
          agent: createAgent("medium"),
          logging: params.tracer?.sandboxLogging(params.cycle, "pow_merge_verify"),
          promptFile: "./.sandcastle/pow-merge-prompt.md",
          promptArgs: {
            PRE_MERGE_SHA: params.preMergeSha,
            TICKETS: params.tickets.map((t) => `- ${t.id}: ${t.title}`).join("\n"),
          },
          maxIterations: 2,
          output: Output.object({ tag: "pow-verdict", schema: PowVerdictSchema, maxRetries: 2 }),
        }),
      { label: `Cross-Slice PoW cycle ${params.cycle}` },
    );
    const verdict = run.output;
    params.tracer?.recordSpan({
      cycle: params.cycle,
      phase: "pow_merge_verify",
      outcome: verdict.status === "defect_found" ? "fail" : "pass",
      durationMs: performance.now() - started,
      detail: verdict.summary,
    });
    return verdict;
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    params.tracer?.recordSpan({
      cycle: params.cycle,
      phase: "pow_merge_verify",
      outcome: "fail",
      durationMs: performance.now() - started,
      detail: `Cross-Slice PoW error: ${msg.slice(0, 140)}`,
    });
    return null;
  }
}
