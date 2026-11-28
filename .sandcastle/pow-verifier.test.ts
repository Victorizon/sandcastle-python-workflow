import assert from "node:assert/strict";
import test from "node:test";
import {
  PowVerdictSchema,
  formatPowEvidenceForReviewer,
  isPowVerifierEnabled,
} from "./pow-verifier.js";

test("isPowVerifierEnabled defaults to ON and disables cleanly via SANDCASTLE_POW_QA=0|false|off", () => {
  assert.equal(isPowVerifierEnabled({}), true);
  assert.equal(isPowVerifierEnabled({ SANDCASTLE_POW_QA: "1" }), true);
  assert.equal(isPowVerifierEnabled({ SANDCASTLE_POW_QA: "0" }), false);
  assert.equal(isPowVerifierEnabled({ SANDCASTLE_POW_QA: "false" }), false);
  assert.equal(isPowVerifierEnabled({ SANDCASTLE_POW_QA: "OFF" }), false);
});

test("PowVerdictSchema parses verdicts and formatPowEvidenceForReviewer surfaces failing evidence clearly", () => {
  const parsed = PowVerdictSchema.parse({
    status: "defect_found",
    scenarios: ["REQ-2: high-risk + unknown channel fails closed"],
    failingEvidence: ["AssertionError: expected MANUAL_REVIEW, got AUTO_APPROVE"],
    summary: "1 of 3 synthetic scenarios failed.",
  });
  const formatted = formatPowEvidenceForReviewer(parsed);
  assert.match(formatted, /Status: defect_found/u);
  assert.match(formatted, /REQ-2: high-risk/u);
  assert.match(formatted, /Failing Synthetic Evidence/u);
  assert.match(formatted, /expected MANUAL_REVIEW/u);
  assert.match(formatPowEvidenceForReviewer(null), /skipped or unavailable/u);
});
