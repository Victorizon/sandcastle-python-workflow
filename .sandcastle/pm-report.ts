/**
 * Deterministic Styled PM HTML Report Generator with 1-Click Jira Copy (`.sandcastle/pm-report.ts`).
 *
 * Automatically generates a clean, offline-viewable, print-ready executive HTML report
 * under `.sandcastle/logs/reports/` after every factory, goal, nightly-arch, bakeoff, or tune run.
 * Zero LLM tokens, zero hallucinations — 100% grounded in verified run artifacts.
 */

import { mkdirSync, writeFileSync } from "node:fs";
import path from "node:path";

export interface ReportMetric {
  readonly label: string;
  readonly value: string;
  readonly note?: string;
}

export interface ReportSection {
  readonly heading: string;
  readonly paragraphs?: readonly string[];
  readonly bullets?: readonly string[];
  readonly table?: {
    readonly headers: readonly string[];
    readonly rows: readonly (readonly string[])[];
  };
}

export interface PmReportInput {
  readonly kind: "factory" | "goal" | "nightly-arch" | "bakeoff" | "tuning" | "trust";
  readonly slug: string;
  readonly title: string;
  readonly status: "success" | "attention" | "proposal" | "blocked";
  readonly statusLabel: string;
  readonly executiveSummary: string;
  readonly generatedAt?: string;
  readonly metrics: readonly ReportMetric[];
  readonly sections: readonly ReportSection[];
}

function esc(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;");
}

export function buildJiraMarkup(input: PmReportInput): string {
  const lines: string[] = [
    `h2. ${input.title}`,
    `{panel:title=Executive Summary (${input.statusLabel})|borderStyle=solid}`,
    input.executiveSummary,
    `{panel}`,
    "",
    "h3. Key Metrics",
    ...input.metrics.map((m) => `* *${m.label}:* ${m.value}${m.note ? ` (${m.note})` : ""}`),
    "",
  ];

  for (const sec of input.sections) {
    lines.push(`h3. ${sec.heading}`);
    for (const p of sec.paragraphs ?? []) {
      lines.push(p);
    }
    for (const b of sec.bullets ?? []) {
      lines.push(`* ${b}`);
    }
    if (sec.table) {
      lines.push(`|| ${sec.table.headers.join(" || ")} ||`);
      for (const row of sec.table.rows) {
        lines.push(`| ${row.join(" | ")} |`);
      }
    }
    lines.push("");
  }

  return lines.join("\n").trim() + "\n";
}

export function renderPmHtmlReport(input: PmReportInput): string {
  const stamp = input.generatedAt ?? new Date().toISOString();
  const jiraMarkup = buildJiraMarkup(input);
  const badgeColor =
    input.status === "success"
      ? "#059669"
      : input.status === "blocked"
        ? "#dc2626"
        : input.status === "attention"
          ? "#d97706"
          : "#4f46e5";

  const metricsHtml = input.metrics
    .map(
      (m) => `
      <div class="kpi">
        <div class="kpi-label">${esc(m.label)}</div>
        <div class="kpi-val">${esc(m.value)}</div>
        ${m.note ? `<div class="kpi-note">${esc(m.note)}</div>` : ""}
      </div>`,
    )
    .join("");

  const sectionsHtml = input.sections
    .map((sec) => {
      const paras = (sec.paragraphs ?? []).map((p) => `<p>${esc(p)}</p>`).join("");
      const bullets =
        sec.bullets && sec.bullets.length > 0
          ? `<ul>${sec.bullets.map((b) => `<li>${esc(b)}</li>`).join("")}</ul>`
          : "";
      const table = sec.table
        ? `<table><thead><tr>${sec.table.headers.map((h) => `<th>${esc(h)}</th>`).join("")}</tr></thead><tbody>${sec.table.rows
            .map((r) => `<tr>${r.map((cell) => `<td>${esc(cell)}</td>`).join("")}</tr>`)
            .join("")}</tbody></table>`
        : "";
      return `<section class="card"><h2>${esc(sec.heading)}</h2>${paras}${bullets}${table}</section>`;
    })
    .join("");

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>${esc(input.title)}</title>
  <style>
    :root { --bg:#f8fafc; --card:#ffffff; --border:#e2e8f0; --text:#0f172a; --muted:#475569; --accent:#2563eb; }
    * { box-sizing: border-box; }
    body { margin:0; font-family:-apple-system,BlinkMacSystemFont,"Segoe UI",Inter,Roboto,sans-serif; background:var(--bg); color:var(--text); line-height:1.5; }
    .wrap { max-width:960px; margin:0 auto; padding:28px 20px 56px; }
    .header { display:flex; flex-wrap:wrap; justify-content:space-between; align-items:flex-start; gap:14px; margin-bottom:20px; }
    .kicker { font-size:12px; font-weight:700; text-transform:uppercase; letter-spacing:0.06em; color:var(--muted); }
    h1 { margin:4px 0 6px; font-size:24px; letter-spacing:-0.02em; }
    .meta { font-size:12.5px; color:var(--muted); }
    .actions { display:flex; gap:8px; flex-wrap:wrap; align-items:center; }
    .badge { font-size:12px; font-weight:700; color:#fff; background:${badgeColor}; padding:5px 12px; border-radius:999px; }
    .btn {
      font-size:12.5px; font-weight:600; padding:7px 13px; border-radius:8px; cursor:pointer;
      border:1px solid var(--border); background:var(--card); color:var(--text);
    }
    .btn.primary { background:var(--accent); border-color:var(--accent); color:#fff; }
    .summary { background:#eff6ff; border:1px solid #bfdbfe; border-radius:12px; padding:16px 18px; font-size:14.5px; margin-bottom:18px; }
    .kpis { display:grid; grid-template-columns:repeat(auto-fit, minmax(170px, 1fr)); gap:12px; margin-bottom:20px; }
    .kpi { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:14px 16px; }
    .kpi-label { font-size:11px; text-transform:uppercase; letter-spacing:0.05em; color:var(--muted); font-weight:600; }
    .kpi-val { font-size:22px; font-weight:700; margin-top:4px; }
    .kpi-note { font-size:12px; color:var(--muted); margin-top:2px; }
    .card { background:var(--card); border:1px solid var(--border); border-radius:12px; padding:18px 20px; margin-bottom:16px; }
    .card h2 { margin:0 0 10px; font-size:16px; }
    p { margin:0 0 10px; color:#1e293b; font-size:14px; }
    ul { margin:0; padding-left:20px; font-size:14px; color:#1e293b; }
    li { margin-bottom:6px; }
    table { width:100%; border-collapse:collapse; margin-top:8px; font-size:13px; }
    th, td { text-align:left; padding:9px 10px; border-bottom:1px solid var(--border); }
    th { background:#f1f5f9; font-weight:700; color:#334155; }
    .jira-box { display:none; margin-top:12px; background:#0f172a; color:#e2e8f0; padding:14px; border-radius:10px; font-family:ui-monospace,monospace; font-size:12px; white-space:pre-wrap; }
    .jira-box.show { display:block; }
    @media print { .no-print { display:none !important; } body { background:#fff; } .card, .kpi { break-inside:avoid; } }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="header">
      <div>
        <div class="kicker">Sandcastle Executive Report · ${esc(input.kind)}</div>
        <h1>${esc(input.title)}</h1>
        <div class="meta">Generated ${esc(stamp)}</div>
      </div>
      <div class="actions no-print">
        <span class="badge">${esc(input.statusLabel)}</span>
        <button id="copy-jira" class="btn primary" type="button">Copy Jira Markup</button>
        <button id="toggle-jira" class="btn" type="button">Preview Jira Text</button>
        <button onclick="window.print()" class="btn" type="button">Print / PDF</button>
      </div>
    </div>

    <div class="summary">${esc(input.executiveSummary)}</div>
    <div class="kpis">${metricsHtml}</div>
    ${sectionsHtml}

    <pre id="jira-box" class="jira-box no-print">${esc(jiraMarkup)}</pre>
  </div>

  <script>
    const jiraText = document.getElementById("jira-box").textContent;
    document.getElementById("copy-jira").addEventListener("click", async (e) => {
      try {
        await navigator.clipboard.writeText(jiraText);
        e.target.textContent = "Copied for Jira!";
        setTimeout(() => { e.target.textContent = "Copy Jira Markup"; }, 1800);
      } catch {
        document.getElementById("jira-box").classList.add("show");
      }
    });
    document.getElementById("toggle-jira").addEventListener("click", () => {
      document.getElementById("jira-box").classList.toggle("show");
    });
  </script>
</body>
</html>`;
}

export function writePmHtmlReport(
  input: PmReportInput,
  logsDir = path.join(".sandcastle", "logs"),
): string {
  const reportsDir = path.join(logsDir, "reports");
  mkdirSync(reportsDir, { recursive: true });
  const dateTag = new Date().toISOString().slice(0, 10);
  const safeSlug = input.slug.toLowerCase().replaceAll(/[^a-z0-9-]+/gu, "-") || "run";
  const filePath = path.join(reportsDir, `${input.kind}-${safeSlug}-${dateTag}.html`);
  writeFileSync(filePath, renderPmHtmlReport(input), "utf8");
  return filePath;
}
