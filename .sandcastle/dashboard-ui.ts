/**
 * Self-contained HTML/CSS/JS UI for the real-time PM Mission Control Dashboard.
 * Includes a live animated SVG Pipeline Flow Map showing every slice traveling
 * through Plan -> Build -> 6-Gate Verify -> Adversarial Challenge -> Merged,
 * plus glowing detour loops for Drift Auto-Splits and Adversarial Fix Rounds.
 *
 * Zero CDN dependencies — works 100% offline inside corporate/WSL2 environments.
 */

export function renderDashboardHtml(): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1.0" />
  <title>Sandcastle Workflow — PM Mission Control</title>
  <style>
    :root {
      --bg: #0b1020;
      --surface: #121a30;
      --surface-2: #18233f;
      --border: #253459;
      --text: #e8eefc;
      --muted: #93a4cc;
      --accent: #60a5fa;
      --accent-2: #a78bfa;
      --success: #34d399;
      --warning: #fbbf24;
      --danger: #f87171;
    }
    * { box-sizing: border-box; }
    body {
      margin: 0;
      font-family: -apple-system, BlinkMacSystemFont, "Segoe UI", Inter, Roboto, sans-serif;
      background: radial-gradient(circle at top right, #17254a 0%, var(--bg) 52%);
      color: var(--text);
      min-height: 100vh;
    }
    .wrap { max-width: 1220px; margin: 0 auto; padding: 24px 20px 48px; }
    .topbar {
      display: flex; flex-wrap: wrap; align-items: center; justify-content: space-between;
      gap: 16px; padding-bottom: 18px; border-bottom: 1px solid var(--border);
    }
    .brand { display: flex; align-items: center; gap: 12px; }
    .beacon {
      width: 12px; height: 12px; border-radius: 50%; background: var(--success);
      box-shadow: 0 0 0 0 rgba(52, 211, 153, 0.7);
      animation: pulse 1.8s infinite;
    }
    .beacon.running { background: var(--accent); box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.7); }
    .beacon.blocked { background: var(--danger); box-shadow: 0 0 0 0 rgba(248, 113, 113, 0.7); }
    @keyframes pulse {
      0% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0.65); }
      70% { box-shadow: 0 0 0 12px rgba(96, 165, 250, 0); }
      100% { box-shadow: 0 0 0 0 rgba(96, 165, 250, 0); }
    }
    h1 { font-size: 20px; margin: 0; letter-spacing: -0.02em; }
    .subtitle { font-size: 13px; color: var(--muted); margin-top: 3px; }
    .pills { display: flex; flex-wrap: wrap; gap: 8px; align-items: center; }
    .pill {
      font-size: 12px; padding: 5px 10px; border-radius: 999px;
      background: var(--surface-2); border: 1px solid var(--border); color: var(--text);
    }
    .pill.live { border-color: var(--accent); color: var(--accent); }
    .hero {
      margin-top: 20px; display: grid; gap: 16px;
      grid-template-columns: 260px 1fr;
    }
    @media (max-width: 860px) { .hero { grid-template-columns: 1fr; } }
    .card {
      background: linear-gradient(180deg, rgba(24,35,63,0.92), rgba(18,26,48,0.95));
      border: 1px solid var(--border); border-radius: 14px; padding: 18px;
      box-shadow: 0 12px 30px rgba(0,0,0,0.22);
    }
    .ring-box { display: flex; flex-direction: column; align-items: center; justify-content: center; text-align: center; }
    .ring-wrap { position: relative; width: 128px; height: 128px; }
    .ring-wrap svg { transform: rotate(-90deg); width: 128px; height: 128px; }
    .ring-track { fill: none; stroke: #223056; stroke-width: 11; }
    .ring-fill {
      fill: none; stroke: url(#grad); stroke-width: 11; stroke-linecap: round;
      transition: stroke-dashoffset 0.65s cubic-bezier(0.22, 1, 0.36, 1);
    }
    .ring-label {
      position: absolute; inset: 0; display: flex; flex-direction: column;
      align-items: center; justify-content: center;
    }
    .ring-pct { font-size: 27px; font-weight: 700; letter-spacing: -0.03em; }
    .ring-sub { font-size: 11px; color: var(--muted); text-transform: uppercase; letter-spacing: 0.06em; }
    .kpi-grid { display: grid; grid-template-columns: repeat(4, minmax(0, 1fr)); gap: 12px; }
    @media (max-width: 720px) { .kpi-grid { grid-template-columns: repeat(2, 1fr); } }
    .kpi {
      background: rgba(11,16,32,0.55); border: 1px solid var(--border);
      border-radius: 11px; padding: 14px;
    }
    .kpi-label { font-size: 11px; text-transform: uppercase; letter-spacing: 0.05em; color: var(--muted); }
    .kpi-val { font-size: 24px; font-weight: 700; margin-top: 6px; }
    .kpi-note { font-size: 12px; color: var(--muted); margin-top: 4px; }
    .headline-bar {
      margin-top: 14px; padding: 12px 14px; border-radius: 10px;
      background: rgba(96, 165, 250, 0.09); border: 1px solid rgba(96, 165, 250, 0.32);
      display: flex; align-items: center; justify-content: space-between; gap: 12px;
      font-size: 13px;
    }
    /* === Live Animated Pipeline Flow Map === */
    .flow-card { margin-top: 18px; padding: 16px 18px 14px; }
    .flow-top {
      display: flex; flex-wrap: wrap; justify-content: space-between; align-items: center;
      gap: 10px; margin-bottom: 10px;
    }
    .flow-legend { display: flex; flex-wrap: wrap; gap: 12px; font-size: 11.5px; color: var(--muted); }
    .leg-dot { display: inline-block; width: 8px; height: 8px; border-radius: 50%; margin-right: 5px; }
    .flow-svg-wrap { width: 100%; overflow-x: auto; }
    svg.flow-map { width: 100%; min-width: 780px; height: auto; display: block; }
    .track-base { fill: none; stroke: #24355c; stroke-width: 4; stroke-linecap: round; }
    .track-flow {
      fill: none; stroke: var(--accent); stroke-width: 3.5; stroke-linecap: round;
      stroke-dasharray: 8 10; animation: flowDash 1.1s linear infinite;
    }
    .track-done { fill: none; stroke: var(--success); stroke-width: 4; stroke-linecap: round; opacity: 0.8; }
    .detour-split {
      fill: none; stroke: #3b2d63; stroke-width: 3; stroke-dasharray: 6 6;
      transition: stroke 0.35s ease, opacity 0.35s ease;
    }
    .detour-split.lit {
      stroke: var(--accent-2); stroke-width: 3.5; animation: flowDashRev 1.3s linear infinite;
      filter: drop-shadow(0 0 6px rgba(167,139,250,0.55));
    }
    .detour-fix {
      fill: none; stroke: #4a3a1e; stroke-width: 3; stroke-dasharray: 6 6;
      transition: stroke 0.35s ease;
    }
    .detour-fix.lit {
      stroke: var(--warning); stroke-width: 3.5; animation: flowDash 1.2s linear infinite;
      filter: drop-shadow(0 0 6px rgba(251,191,36,0.5));
    }
    @keyframes flowDash { to { stroke-dashoffset: -36; } }
    @keyframes flowDashRev { to { stroke-dashoffset: 36; } }
    .station-box {
      fill: #131d36; stroke: #2c406d; stroke-width: 1.5; rx: 12;
      transition: stroke 0.3s ease, fill 0.3s ease;
    }
    .station-box.active {
      stroke: var(--accent); fill: #18274a;
      filter: drop-shadow(0 0 10px rgba(96,165,250,0.35));
    }
    .station-box.done { stroke: rgba(52,211,153,0.65); }
    .station-box.split-box { stroke: rgba(167,139,250,0.65); fill: #1b1838; }
    .station-title { fill: var(--text); font-size: 13px; font-weight: 700; }
    .station-sub { fill: var(--muted); font-size: 10.5px; }
    .token-g { cursor: pointer; transition: transform 0.55s cubic-bezier(0.22, 1, 0.36, 1); }
    .token-pill { stroke-width: 1.5; rx: 11; transition: fill 0.3s ease, stroke 0.3s ease; }
    .token-pill.running { fill: #1e3a6e; stroke: var(--accent); }
    .token-pill.merged { fill: #113b31; stroke: var(--success); }
    .token-pill.split { fill: #2b1f4d; stroke: var(--accent-2); stroke-dasharray: 3 2; }
    .token-pill.remediating { fill: #4a3410; stroke: var(--warning); }
    .token-pill.needs_human { fill: #4b1a1f; stroke: var(--danger); }
    .token-pill.queued { fill: #1a243d; stroke: #4b5e8a; }
    .token-pill.selected { stroke-width: 2.6; filter: drop-shadow(0 0 8px rgba(255,255,255,0.45)); }
    .token-txt { fill: var(--text); font-size: 11px; font-weight: 700; font-family: ui-monospace, monospace; }
    .token-pulse {
      fill: none; stroke: var(--accent); stroke-width: 2; opacity: 0.8;
      animation: ringPop 1.6s ease-out infinite; transform-box: fill-box; transform-origin: center;
    }
    @keyframes ringPop {
      0% { opacity: 0.9; transform: scale(1); }
      100% { opacity: 0; transform: scale(1.32); }
    }
    .filter-banner {
      display: none; margin-top: 8px; padding: 8px 12px; border-radius: 8px;
      background: rgba(167,139,250,0.12); border: 1px solid rgba(167,139,250,0.4);
      font-size: 12px; justify-content: space-between; align-items: center;
    }
    .filter-banner.show { display: flex; }
    .clear-btn {
      background: transparent; border: 1px solid var(--border); color: var(--text);
      padding: 3px 9px; border-radius: 6px; cursor: pointer; font-size: 11px;
    }

    .section-hdr {
      margin: 24px 0 12px; display: flex; align-items: center; justify-content: space-between;
    }
    .section-hdr h2 { font-size: 15px; margin: 0; letter-spacing: -0.01em; }
    .slices-grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(330px, 1fr)); gap: 14px; }
    .slice {
      background: var(--surface); border: 1px solid var(--border); border-radius: 13px;
      padding: 16px; transition: transform 0.25s ease, border-color 0.25s ease, opacity 0.25s ease;
    }
    .slice.dimmed { opacity: 0.32; }
    .slice.active { border-color: var(--accent); box-shadow: 0 0 0 1px rgba(96,165,250,0.25); }
    .slice.merged { border-color: rgba(52, 211, 153, 0.5); }
    .slice.split { opacity: 0.72; border-style: dashed; }
    .slice.needs_human { border-color: var(--danger); }
    .slice-top { display: flex; justify-content: space-between; gap: 10px; align-items: flex-start; }
    .slice-id { font-size: 11px; color: var(--muted); font-family: ui-monospace, SFMono-Regular, monospace; }
    .slice-title { font-size: 14px; font-weight: 600; margin-top: 2px; }
    .badge {
      font-size: 11px; font-weight: 600; padding: 3px 9px; border-radius: 999px;
      text-transform: uppercase; letter-spacing: 0.04em; white-space: nowrap;
    }
    .b-queued { background: #23304f; color: var(--muted); }
    .b-implementing, .b-verifying, .b-reviewing, .b-remediating, .b-merging {
      background: rgba(96,165,250,0.18); color: #93c5fd; border: 1px solid rgba(96,165,250,0.4);
    }
    .b-merged { background: rgba(52,211,153,0.18); color: var(--success); border: 1px solid rgba(52,211,153,0.4); }
    .b-split { background: rgba(167,139,250,0.18); color: #c4b5fd; border: 1px solid rgba(167,139,250,0.4); }
    .b-needs_human { background: rgba(248,113,113,0.18); color: var(--danger); border: 1px solid rgba(248,113,113,0.4); }
    .stepper { display: grid; grid-template-columns: repeat(5, 1fr); gap: 5px; margin: 12px 0; }
    .step { height: 6px; border-radius: 99px; background: #223056; overflow: hidden; position: relative; }
    .step.done { background: var(--success); }
    .step.now { background: var(--accent); }
    .step.now::after {
      content: ""; position: absolute; inset: 0;
      background: linear-gradient(90deg, transparent, rgba(255,255,255,0.55), transparent);
      animation: shimmer 1.2s infinite;
    }
    @keyframes shimmer { from { transform: translateX(-100%); } to { transform: translateX(100%); } }
    .pm-summary {
      font-size: 13px; line-height: 1.45; color: var(--text);
      background: rgba(11,16,32,0.55); border-radius: 9px; padding: 10px 12px;
      border: 1px solid rgba(37,52,89,0.7);
    }
    .gauges { display: grid; grid-template-columns: repeat(3, 1fr); gap: 8px; margin-top: 10px; }
    .gauge { font-size: 11px; color: var(--muted); }
    .gauge-bar { height: 5px; border-radius: 99px; background: #1e2b4b; margin-top: 4px; overflow: hidden; }
    .gauge-fill { height: 100%; background: var(--accent); transition: width 0.4s ease; }
    .gauge-fill.warn { background: var(--warning); }
    .gauge-fill.danger { background: var(--danger); }
    .challenges { margin-top: 10px; display: flex; flex-direction: column; gap: 6px; }
    .ch-item {
      font-size: 12px; padding: 7px 10px; border-radius: 8px;
      background: rgba(251,191,36,0.1); border: 1px solid rgba(251,191,36,0.35); color: #fde68a;
    }
    .ch-item.fixed { background: rgba(52,211,153,0.1); border-color: rgba(52,211,153,0.35); color: #a7f3d0; }
    .ch-item.split { background: rgba(167,139,250,0.12); border-color: rgba(167,139,250,0.4); color: #ddd6fe; }
    .timeline { display: flex; flex-direction: column; gap: 8px; }
    .ev {
      background: var(--surface); border: 1px solid var(--border); border-radius: 10px;
      padding: 11px 14px; animation: slideIn 0.25s ease;
    }
    .ev.dimmed { opacity: 0.32; }
    @keyframes slideIn { from { opacity: 0; transform: translateY(-6px); } to { opacity: 1; transform: translateY(0); } }
    .ev.challenge { border-left: 3px solid var(--warning); }
    .ev.success { border-left: 3px solid var(--success); }
    .ev.error { border-left: 3px solid var(--danger); }
    .ev.info { border-left: 3px solid var(--accent); }
    .ev-top { display: flex; justify-content: space-between; gap: 8px; font-size: 13px; font-weight: 600; }
    .ev-time { font-size: 11px; color: var(--muted); font-weight: 400; font-family: ui-monospace, monospace; }
    .ev-detail { font-size: 12.5px; color: var(--muted); margin-top: 4px; line-height: 1.4; }
    .tech-log {
      display: none; margin-top: 8px; padding: 8px 10px; border-radius: 7px;
      background: #090d1a; font-family: ui-monospace, monospace; font-size: 11px;
      color: #9fb2d9; white-space: pre-wrap; max-height: 150px; overflow: auto;
    }
    body.show-tech .tech-log { display: block; }
    .toggle { font-size: 12px; color: var(--muted); display: flex; align-items: center; gap: 6px; cursor: pointer; }
  </style>
</head>
<body>
  <div class="wrap">
    <div class="topbar">
      <div class="brand">
        <div id="beacon" class="beacon running"></div>
        <div>
          <h1 id="title">Sandcastle Workflow — PM Mission Control</h1>
          <div class="subtitle" id="sub">Live slice journey, container progress, adversarial challenges &amp; quality gates</div>
        </div>
      </div>
      <div class="pills">
        <span class="pill live" id="conn-pill">Live SSE</span>
        <span class="pill" id="mode-pill">mode: factory</span>
        <span class="pill" id="cycle-pill">Cycle 1 / 6</span>
        <span class="pill" id="image-pill">sandcastle:python-codex</span>
      </div>
    </div>

    <div class="hero">
      <div class="card ring-box">
        <div class="ring-wrap">
          <svg viewBox="0 0 132 132">
            <defs>
              <linearGradient id="grad" x1="0%" y1="0%" x2="100%" y2="0%">
                <stop offset="0%" stop-color="#60a5fa" />
                <stop offset="100%" stop-color="#34d399" />
              </linearGradient>
            </defs>
            <circle class="ring-track" cx="66" cy="66" r="54"></circle>
            <circle id="ring-fill" class="ring-fill" cx="66" cy="66" r="54" stroke-dasharray="339.29" stroke-dashoffset="339.29"></circle>
          </svg>
          <div class="ring-label">
            <div class="ring-pct" id="pct-text">0%</div>
            <div class="ring-sub">Shipped</div>
          </div>
        </div>
        <div style="margin-top:10px;font-size:13px;font-weight:600" id="slices-count">0 of 0 slices merged</div>
        <div style="margin-top:3px;font-size:12px;color:var(--muted)" id="run-status-text">Initializing...</div>
      </div>

      <div class="card" style="display:flex;flex-direction:column;justify-content:space-between;">
        <div class="kpi-grid">
          <div class="kpi">
            <div class="kpi-label">Adversarial Challenges</div>
            <div class="kpi-val" id="kpi-challenges" style="color:var(--warning)">0</div>
            <div class="kpi-note" id="kpi-challenges-note">0 caught &amp; fixed before merge</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Test-Tamper Blocks</div>
            <div class="kpi-val" id="kpi-tampers" style="color:var(--danger)">0</div>
            <div class="kpi-note">Blocked by test_guard.py</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Drift Auto-Splits</div>
            <div class="kpi-val" id="kpi-splits" style="color:var(--accent-2)">0</div>
            <div class="kpi-note">Oversized slices broken down</div>
          </div>
          <div class="kpi">
            <div class="kpi-label">Test Strength</div>
            <div class="kpi-val" id="kpi-quality" style="color:var(--success)">--</div>
            <div class="kpi-note" id="kpi-quality-note">Coverage / AST mutation kill</div>
          </div>
        </div>
        <div class="headline-bar">
          <div><strong>Current Focus:</strong> <span id="headline">Waiting for planner...</span></div>
          <div style="font-size:11px;color:var(--muted)" id="updated-at"></div>
        </div>
      </div>
    </div>

    <!-- Live Animated Pipeline Flow Map -->
    <div class="card flow-card">
      <div class="flow-top">
        <div>
          <div style="font-size:14px;font-weight:700;">Live Slice Journey Map</div>
          <div style="font-size:12px;color:var(--muted);">Watch every slice move across containers, detour through challenges, or split via DriftWatchdog (click any slice badge to focus)</div>
        </div>
        <div class="flow-legend">
          <span><i class="leg-dot" style="background:var(--accent)"></i>Active</span>
          <span><i class="leg-dot" style="background:var(--warning)"></i>Challenge / Fix Loop</span>
          <span><i class="leg-dot" style="background:var(--accent-2)"></i>Drift Auto-Split</span>
          <span><i class="leg-dot" style="background:var(--success)"></i>Merged</span>
        </div>
      </div>
      <div class="flow-svg-wrap">
        <svg id="flow-svg" class="flow-map" viewBox="0 0 1120 295" xmlns="http://www.w3.org/2000/svg"></svg>
      </div>
      <div id="filter-banner" class="filter-banner">
        <span id="filter-text"></span>
        <button id="clear-filter" type="button" class="clear-btn">Show all slices</button>
      </div>
    </div>

    <div class="section-hdr">
      <h2>Container Slices &amp; Live Drift Gauges</h2>
      <span style="font-size:12px;color:var(--muted)">Stages: Plan → Build → 6-Gate Verify → Adversarial Challenge → Merge</span>
    </div>
    <div id="slices-grid" class="slices-grid"></div>

    <div class="section-hdr">
      <h2>Executive Story Feed (What's Happening Inside the Containers)</h2>
      <label class="toggle">
        <input id="tech-toggle" type="checkbox" />
        Show technical details
      </label>
    </div>
    <div id="timeline" class="timeline"></div>
  </div>

  <script>
    const CIRC = 2 * Math.PI * 54;
    const STAGE_INDEX = {
      queued: 0, implementing: 1, verifying: 2, reviewing: 3, remediating: 3, merging: 4, merged: 5, split: 1, needs_human: 2
    };
    const STATIONS = [
      { key: "plan",      x: 20,  y: 122, w: 175, h: 78, title: "1. Plan",        sub: "Unblocked slices" },
      { key: "build",     x: 245, y: 122, w: 175, h: 78, title: "2. Build (TDD)", sub: "Docker worktree" },
      { key: "verify",    x: 470, y: 122, w: 175, h: 78, title: "3. 6-Gate Check",sub: "Ratchet · Mutation" },
      { key: "challenge", x: 695, y: 122, w: 175, h: 78, title: "4. Challenge",   sub: "Fresh Reviewer" },
      { key: "merged",    x: 920, y: 122, w: 175, h: 78, title: "5. Merged",      sub: "Shipped to main" },
    ];

    let lastState = null;
    let selectedSliceId = null;

    document.getElementById("tech-toggle").addEventListener("change", (e) => {
      document.body.classList.toggle("show-tech", e.target.checked);
    });
    document.getElementById("clear-filter").addEventListener("click", () => {
      selectedSliceId = null;
      if (lastState) render(lastState);
    });

    function esc(s) {
      return String(s ?? "").replaceAll("&","&amp;").replaceAll("<","&lt;").replaceAll(">","&gt;");
    }
    function shortTag(id) {
      const part = String(id).split("/").pop() || id;
      return "#" + part;
    }
    function fmtTime(iso) {
      try { return new Date(iso).toLocaleTimeString(); } catch { return iso; }
    }
    function gaugeBar(val, max, label) {
      const pct = max > 0 ? Math.min(100, Math.round((val / max) * 100)) : 0;
      const cls = pct >= 85 ? "danger" : pct >= 60 ? "warn" : "";
      return \`<div class="gauge"><div>\${label}: <strong>\${val}</strong>/\${max}</div><div class="gauge-bar"><div class="gauge-fill \${cls}" style="width:\${pct}%"></div></div></div>\`;
    }

    function stationForStage(stage) {
      if (stage === "queued") return "plan";
      if (stage === "implementing") return "build";
      if (stage === "verifying" || stage === "needs_human") return "verify";
      if (stage === "reviewing" || stage === "remediating") return "challenge";
      if (stage === "merging" || stage === "merged") return "merged";
      if (stage === "split") return "watchdog";
      return "plan";
    }

    function renderFlowMap(state) {
      const svg = document.getElementById("flow-svg");
      const m = state.metrics;
      const slices = state.slices || [];
      const hasSplit = m.driftAutoSplits > 0 || slices.some((s) => s.stage === "split");
      const hasChallenge = m.adversarialChallengesRaised > 0 || slices.some((s) => s.stage === "remediating");
      const anyActive = m.activeSlices > 0;

      // Group slices per station so badges stack cleanly without overlapping
      const buckets = { plan: [], build: [], verify: [], challenge: [], merged: [], watchdog: [] };
      for (const s of slices) {
        buckets[stationForStage(s.stage)].push(s);
      }

      // Main spine connectors
      const connectors = [0, 1, 2, 3].map((i) => {
        const a = STATIONS[i];
        const b = STATIONS[i + 1];
        const x1 = a.x + a.w;
        const x2 = b.x;
        const y = a.y + a.h / 2;
        const allDone = state.runStatus === "complete";
        const cls = allDone ? "track-done" : anyActive ? "track-flow" : "track-base";
        return \`<line x1="\${x1}" y1="\${y}" x2="\${x2}" y2="\${y}" class="track-base" />\`
             + \`<line x1="\${x1}" y1="\${y}" x2="\${x2}" y2="\${y}" class="\${cls}" />\`;
      }).join("");

      // Top Detour: Build (x=332) -> Watchdog/Decomposer box (x=145..355, y=14..68) -> Plan (x=107)
      const splitLoop = \`
        <path d="M 332 122 C 332 82, 332 82, 305 66" class="detour-split \${hasSplit ? "lit" : ""}" />
        <path d="M 165 66 C 107 80, 107 88, 107 122" class="detour-split \${hasSplit ? "lit" : ""}" />
        <rect x="145" y="14" width="210" height="54" rx="11" class="station-box \${hasSplit ? "split-box" : ""}" />
        <text x="250" y="36" text-anchor="middle" class="station-title" style="fill:\${hasSplit ? "#d8b4fe" : "#93a4cc"}">Drift Watchdog → Re-Slicer</text>
        <text x="250" y="54" text-anchor="middle" class="station-sub">\${hasSplit ? m.driftAutoSplits + " oversized slice auto-split" : "Guards time · thrash · diff size"}</text>
      \`;

      // Bottom Detour: Verify (557) & Challenge (782) -> Remedy loop back to Build (332)
      const fixCount = m.adversarialChallengesResolved + m.testTamperBlocks;
      const fixLoop = \`
        <path d="M 782 200 C 782 262, 332 262, 332 200" class="detour-fix \${hasChallenge ? "lit" : ""}" />
        <path d="M 557 200 C 557 248, 360 250, 332 200" class="detour-fix \${m.testTamperBlocks > 0 ? "lit" : ""}" />
        <rect x="468" y="242" width="268" height="32" rx="16" fill="#1b1820" stroke="\${hasChallenge ? "#fbbf24" : "#3a3548"}" stroke-width="1.3" />
        <text x="602" y="262" text-anchor="middle" style="fill:\${hasChallenge ? "#fde68a" : "#93a4cc"};font-size:11.5px;font-weight:600;">
          \${hasChallenge ? "Adversarial &amp; Lock Loop · " + fixCount + " caught &amp; remediated" : "Adversarial Challenge &amp; Anti-Tamper Fix Loop"}
        </text>
      \`;

      // Main 5 station cards
      const stationSvg = STATIONS.map((st) => {
        const list = buckets[st.key];
        const isStationActive = list.some((s) =>
          ["implementing","verifying","reviewing","remediating","merging"].includes(s.stage)
        );
        const isMergedDone = st.key === "merged" && list.length > 0;
        const cls = isStationActive ? "active" : (isMergedDone ? "done" : "");
        return \`
          <rect x="\${st.x}" y="\${st.y}" width="\${st.w}" height="\${st.h}" class="station-box \${cls}" />
          <text x="\${st.x + 14}" y="\${st.y + 26}" class="station-title">\${st.title}</text>
          <text x="\${st.x + 14}" y="\${st.y + 44}" class="station-sub">\${st.sub}</text>
        \`;
      }).join("");

      // Render slice tokens inside their station (or inside Watchdog box for split parents)
      function renderTokens(list, baseX, baseY, maxPerRow) {
        return list.map((s, i) => {
          const col = i % maxPerRow;
          const row = Math.floor(i / maxPerRow);
          const x = baseX + col * 52;
          const y = baseY + row * 24;
          const isRunning = ["implementing","verifying","reviewing","merging"].includes(s.stage);
          const pillCls = isRunning ? "running" : s.stage;
          const selCls = selectedSliceId === s.id ? "selected" : "";
          const badge = shortTag(s.id) + (s.splitDepth > 0 ? "*" : "");
          return \`
            <g class="token-g" data-slice="\${esc(s.id)}" transform="translate(\${x},\${y})">
              <title>\${esc(s.id)} (\${esc(s.stage)}): \${esc(s.pmSummary)}</title>
              \${isRunning ? '<rect x="0" y="0" width="46" height="22" rx="11" class="token-pulse" />' : ""}
              <rect x="0" y="0" width="46" height="22" class="token-pill \${pillCls} \${selCls}" />
              <text x="23" y="15" text-anchor="middle" class="token-txt">\${esc(badge)}</text>
            </g>
          \`;
        }).join("");
      }

      let tokensSvg = "";
      for (const st of STATIONS) {
        tokensSvg += renderTokens(buckets[st.key], st.x + 12, st.y + 51, 3);
      }
      // Split parent tokens sit beside Watchdog box
      tokensSvg += renderTokens(buckets.watchdog, 372, 30, 3);

      // Subtle lineage note when children were spawned from a split parent
      const children = slices.filter((s) => s.parentId);
      const lineageNote = children.length > 0
        ? \`<text x="435" y="45" style="fill:#c4b5fd;font-size:11px;font-weight:600;">⇢ spawned \${children.map((c) => shortTag(c.id)).join(", ")}</text>\`
        : "";

      svg.innerHTML = connectors + splitLoop + fixLoop + stationSvg + tokensSvg + lineageNote;

      svg.querySelectorAll(".token-g").forEach((g) => {
        g.addEventListener("click", () => {
          const id = g.getAttribute("data-slice");
          selectedSliceId = selectedSliceId === id ? null : id;
          if (lastState) render(lastState);
        });
      });
    }

    function render(state) {
      lastState = state;
      const m = state.metrics;
      document.getElementById("title").textContent = state.title;
      document.getElementById("mode-pill").textContent = "mode: " + state.mode;
      document.getElementById("cycle-pill").textContent = "Cycle " + state.cycle + " / " + state.maxCycles;
      document.getElementById("image-pill").textContent = state.dockerImage;
      document.getElementById("headline").textContent = state.headline;
      document.getElementById("updated-at").textContent = "Updated " + fmtTime(state.updatedAt);

      const beacon = document.getElementById("beacon");
      beacon.className = "beacon " + state.runStatus;
      document.getElementById("run-status-text").textContent =
        state.runStatus === "complete" ? "All planned slices complete" :
        state.runStatus === "blocked" ? "Needs human attention" : "Containers actively running";

      document.getElementById("pct-text").textContent = m.progressPercent + "%";
      document.getElementById("ring-fill").style.strokeDashoffset = String(CIRC * (1 - m.progressPercent / 100));
      document.getElementById("slices-count").textContent = m.completedSlices + " of " + m.totalSlices + " slices merged";

      document.getElementById("kpi-challenges").textContent = String(m.adversarialChallengesRaised);
      document.getElementById("kpi-challenges-note").textContent = m.adversarialChallengesResolved + " fixed & verified before merge";
      document.getElementById("kpi-tampers").textContent = String(m.testTamperBlocks);
      document.getElementById("kpi-splits").textContent = String(m.driftAutoSplits);

      const cov = m.latestCoveragePercent !== null ? m.latestCoveragePercent.toFixed(0) + "%" : "--";
      const mut = m.latestMutationScore !== null ? m.latestMutationScore.toFixed(1) + "%" : "--";
      document.getElementById("kpi-quality").textContent = mut !== "--" ? mut : cov;
      document.getElementById("kpi-quality-note").textContent = "Coverage " + cov + " · Mutation kill " + mut;

      renderFlowMap(state);

      const banner = document.getElementById("filter-banner");
      if (selectedSliceId) {
        banner.classList.add("show");
        document.getElementById("filter-text").textContent = "Focused on slice " + selectedSliceId + " — click token again or Clear to view all.";
      } else {
        banner.classList.remove("show");
      }

      const grid = document.getElementById("slices-grid");
      grid.innerHTML = state.slices.map((s) => {
        const idx = STAGE_INDEX[s.stage] ?? 0;
        const isActive = ["implementing","verifying","reviewing","remediating","merging"].includes(s.stage);
        const dim = selectedSliceId && selectedSliceId !== s.id ? "dimmed" : "";
        const steps = [0,1,2,3,4].map((i) => {
          const cls = s.stage === "merged" || i < idx ? "done" : (i === idx && isActive ? "now" : "");
          return \`<div class="step \${cls}"></div>\`;
        }).join("");
        const chHtml = (s.challenges || []).map((c) => \`
          <div class="ch-item \${esc(c.outcome)}">
            <strong>[\${esc(c.source.replace("_"," "))} · \${esc(c.outcome)}]</strong> \${esc(c.finding)}
          </div>\`).join("");
        const depthTag = s.splitDepth > 0 ? \` · sub-slice (depth \${s.splitDepth})\` : "";
        const ctrTag = s.containerName ? \` · docker: \${esc(s.containerName)}\` : "";
        return \`
          <div class="slice \${isActive ? "active" : esc(s.stage)} \${dim}">
            <div class="slice-top">
              <div>
                <div class="slice-id">\${esc(s.id)}\${depthTag}\${ctrTag}</div>
                <div class="slice-title">\${esc(s.title)}</div>
              </div>
              <span class="badge b-\${esc(s.stage)}">\${esc(s.stage.replace("_"," "))}</span>
            </div>
            <div class="stepper">\${steps}</div>
            <div class="pm-summary">\${esc(s.pmSummary)}</div>
            <div class="gauges">
              \${gaugeBar(Math.round(s.watchdog.elapsedSec / 60), Math.round(s.watchdog.maxSec / 60), "Min")}
              \${gaugeBar(s.watchdog.toolCalls, s.watchdog.maxToolCalls, "Tools")}
              \${gaugeBar(s.watchdog.diffLines, s.watchdog.maxDiffLines, "Diff lines")}
            </div>
            \${chHtml ? \`<div class="challenges">\${chHtml}</div>\` : ""}
          </div>\`;
      }).join("");

      const tl = document.getElementById("timeline");
      tl.innerHTML = state.timeline.map((e) => {
        const dim = selectedSliceId && e.sliceId && e.sliceId !== selectedSliceId ? "dimmed" : "";
        return \`
          <div class="ev \${esc(e.level)} \${dim}">
            <div class="ev-top">
              <span>\${e.sliceId ? \`[\${esc(e.sliceId)}] \` : ""}\${esc(e.headline)}</span>
              <span class="ev-time">\${fmtTime(e.timestamp)}</span>
            </div>
            <div class="ev-detail">\${esc(e.detail)}</div>
            \${e.technicalLog ? \`<pre class="tech-log">\${esc(e.technicalLog)}</pre>\` : ""}
          </div>\`;
      }).join("");
    }

    fetch("/api/state").then((r) => r.json()).then(render).catch(() => {});
    const es = new EventSource("/events");
    es.onmessage = (ev) => {
      try { render(JSON.parse(ev.data)); } catch {}
    };
    es.onerror = () => { document.getElementById("conn-pill").textContent = "Reconnecting..."; };
    es.onopen = () => { document.getElementById("conn-pill").textContent = "Live SSE"; };
  </script>
</body>
</html>`;
}
