'use strict';
/** @module generate-perf-report â€” Generates a detailed self-contained HTML performance test report from k6 results. */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

const ROOT = path.resolve(__dirname, '..');

// â”€â”€â”€ Normalise a result entry regardless of flat vs metrics-nested format â”€â”€â”€â”€
function norm(r) {
  const m = r.metrics || {};
  return {
    name:             r.basename      || r.scriptName  || path.basename(r.scriptPath || 'unknown', '.k6.js'),
    testType:         r.testType      || 'load',
    verdict:          r.verdict       || 'pass',
    p95:              +(m.p95          ?? r.p95          ?? 0),
    p99:              +(m.p99          ?? r.p99          ?? 0),
    avg:              +(m.avg          ?? r.avg          ?? 0),
    max:              +(m.max          ?? r.max          ?? 0),
    errorRate:        +(m.errorRate    ?? r.errorRate    ?? 0),
    throughput:       +(m.throughput   ?? m.reqRate      ?? r.throughput ?? 0),
    vusMax:           +(m.vusMax       ?? r.vusMax       ?? 0),
    totalRequests:    +(m.count        ?? r.totalRequests ?? 0),
    duration:          r.duration      || 'â€”',
    thinkTime:         r.thinkTime     || 1,
    breaches:          r.breaches      || [],
    baselineDegraded:  r.baselineDegraded ?? false,
    previousP95:      +(r.previousP95  ?? r.baseline?.prevP95  ?? 0) || null,
    changePct:        +(r.changePct    ?? r.baseline?.delta     ?? 0) || null,
  };
}

const TYPE_COLOURS = {
  load:        '#1565c0',
  stress:      '#e65100',
  spike:       '#b71c1c',
  soak:        '#6a1b9a',
  scalability: '#00695c',
  breakpoint:  '#bf360c',
};

function typePill(t) {
  const bg = TYPE_COLOURS[t] || '#555';
  return `<span style="background:${bg};color:#fff;padding:2px 10px;border-radius:12px;font-size:0.8em;font-weight:bold">${t}</span>`;
}

function verdictBadge(v) {
  const map = { pass:'#2e7d32', warn:'#e65100', fail:'#b71c1c' };
  const label = { pass:'PASS', warn:'WARN', fail:'FAIL' };
  const bg = map[v] || '#555';
  return `<span style="background:${bg};color:#fff;padding:3px 12px;border-radius:12px;font-weight:bold;font-size:0.9em">${label[v]||v.toUpperCase()}</span>`;
}

function barColour(pct) {
  if (pct >= 100) return '#b71c1c';
  if (pct >= 80)  return '#e65100';
  return '#2e7d32';
}

function fmt(n, dp = 0) {
  if (n === undefined || n === null || Number.isNaN(Number(n))) return 'â€”';
  return Number(n).toFixed(dp);
}

function worstVerdict(items) {
  if (items.some(r => r.verdict === 'fail')) return 'fail';
  if (items.some(r => r.verdict === 'warn')) return 'warn';
  return 'pass';
}

/**
 * Generate the full performance HTML report.
 *
 * @param {Array}  results    - Array of perf result objects (flat or metrics-nested)
 * @param {object} thresholds - { p95, p99, errorRate }
 * @param {string} outputDir  - Target directory for index.html
 */
function generatePerfReport(results, thresholds, outputDir) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const rows       = (results || []).map(norm);
    const generated  = new Date().toISOString();
    const storyKey   = process.env.ISSUE_KEY || 'N/A';
    const jiraUrl    = (process.env.JIRA_URL  || '').replace(/\/$/, '');
    const zephyrUrl  = process.env.ZEPHYR_BASE_URL || '';

    const passCount  = rows.filter(r => r.verdict === 'pass').length;
    const warnCount  = rows.filter(r => r.verdict === 'warn').length;
    const failCount  = rows.filter(r => r.verdict === 'fail').length;
    const totalReqs  = rows.reduce((s, r) => s + r.totalRequests, 0);
    const overall    = worstVerdict(rows);

    const th = {
      p95:       thresholds?.p95       || parseInt(process.env.PERF_THRESHOLDS_P95  || '2000', 10),
      p99:       thresholds?.p99       || parseInt(process.env.PERF_THRESHOLDS_P99  || '5000', 10),
      errorRate: thresholds?.errorRate || parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
    };

    // â”€â”€ SLA metrics (worst across all runs) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const worstP95    = rows.length ? Math.max(...rows.map(r => r.p95))       : 0;
    const worstP99    = rows.length ? Math.max(...rows.map(r => r.p99))       : 0;
    const worstErr    = rows.length ? Math.max(...rows.map(r => r.errorRate)) : 0;
    const bestTput    = rows.length ? Math.max(...rows.map(r => r.throughput)): 0;
    const maxVus      = rows.length ? Math.max(...rows.map(r => r.vusMax))    : 0;
    const baseReg     = rows.some(r => r.baselineDegraded);

    // â”€â”€ SLA status card helper â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function slaCard(title, actual, limit, unit, isRate) {
      const pct   = limit > 0 ? Math.min(100, Math.round((actual / limit) * 100)) : 0;
      const col   = barColour(pct);
      const verd  = actual > limit ? 'fail' : actual > limit * 0.9 ? 'warn' : 'pass';
      const disp  = isRate ? (actual * 100).toFixed(2) + '%' : Math.round(actual) + ' ' + unit;
      const ldisp = isRate ? (limit  * 100).toFixed(2) + '%' : limit + ' ' + unit;
      return `
        <div class="sla-card">
          ${verdictBadge(verd)}
          <div class="sla-name">${title}</div>
          <div class="sla-actual" style="color:${col};font-size:1.3em;font-weight:bold">${disp}</div>
          <div class="sla-limit">Limit: ${ldisp}</div>
          <div class="sla-bar-bg"><div class="sla-bar-fill" style="width:${pct}%;background:${col}"></div></div>
        </div>`;
    }

    // â”€â”€ Chart data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const testTypes     = [...new Set(rows.map(r => r.testType))];
    const chartLabels   = JSON.stringify(rows.map(r => r.name));
    const p95Data       = JSON.stringify(rows.map(r => Math.round(r.p95)));
    const p99Data       = JSON.stringify(rows.map(r => Math.round(r.p99)));
    const errData       = JSON.stringify(rows.map(r => parseFloat((r.errorRate * 100).toFixed(3))));
    const errColors     = JSON.stringify(rows.map(r =>
      r.errorRate > th.errorRate ? '#b71c1c' : r.errorRate > th.errorRate * 0.9 ? '#e65100' : '#2e7d32'
    ));
    const p95Threshold  = th.p95;
    const p99Threshold  = th.p99;
    const errThreshold  = parseFloat((th.errorRate * 100).toFixed(3));

    // â”€â”€ Sort rows: failâ†’warnâ†’pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ORDER = { fail: 0, warn: 1, pass: 2 };
    const sortedRows = [...rows].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);

    // â”€â”€ Tab 2: All Scripts Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const tableRows = sortedRows.map(r => `
      <tr class="hover-row">
        <td>${r.name}</td>
        <td>${typePill(r.testType)}</td>
        <td>${fmt(r.p95)}</td>
        <td>${fmt(r.p99)}</td>
        <td>${fmt(r.avg)}</td>
        <td>${(r.errorRate * 100).toFixed(2)}%</td>
        <td>${fmt(r.throughput, 1)}</td>
        <td>${fmt(r.vusMax)}</td>
        <td>${r.duration}</td>
        <td>${verdictBadge(r.verdict)}</td>
      </tr>`).join('');

    // â”€â”€ Tab 3: Script Details â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const RECS = {
      p95:       'Investigate slow database queries or add caching.',
      p99:       'Check for tail latency; review thread pool config.',
      errorRate: 'Review server logs for 5xx responses under load.',
      throughput:'Scale horizontally or optimise connection pooling.',
    };

    const detailCards = sortedRows.map(r => {
      const alertBox = r.breaches.length
        ? `<div class="breach-alert">
            <strong>Threshold breaches:</strong>
            <ul>${r.breaches.map(b =>
              `<li>${b.metric} ${Math.round(b.actual)}${b.metric === 'errorRate' ? '' : 'ms'} &gt; ${Math.round(b.limit)}${b.metric === 'errorRate' ? '' : 'ms'} limit â€” <em>${RECS[b.metric] || ''}</em></li>`
            ).join('')}</ul>
          </div>` : '';

      const bLine = r.previousP95 != null
        ? `<table class="inner baseline-table">
            <thead><tr><th>Prev p95</th><th>Curr p95</th><th>Delta %</th><th>Status</th></tr></thead>
            <tbody><tr>
              <td>${fmt(r.previousP95)} ms</td>
              <td>${fmt(r.p95)} ms</td>
              <td style="color:${r.changePct > 0 ? '#e65100':'#2e7d32'}">${r.changePct != null ? (r.changePct > 0 ? '+' : '') + fmt(r.changePct, 1) + '%' : 'â€”'}</td>
              <td>${r.baselineDegraded ? '<span style="color:#b71c1c">DEGRADED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
            </tr></tbody>
          </table>` : '<p style="color:#888;font-size:0.85em">No baseline data available.</p>';

      return `
        <details class="detail-card" open="${r.verdict === 'fail' ? 'true' : 'false'}">
          <summary>
            ${verdictBadge(r.verdict)} &nbsp; <strong>${r.name}</strong> &nbsp; ${typePill(r.testType)}
            <span class="chevron">&#9660;</span>
          </summary>
          <div class="detail-body">
            ${alertBox}
            <div class="stat-grid">
              <div class="stat-cell"><span class="stat-label">p95</span><span class="stat-val">${fmt(r.p95)} ms</span></div>
              <div class="stat-cell"><span class="stat-label">p99</span><span class="stat-val">${fmt(r.p99)} ms</span></div>
              <div class="stat-cell"><span class="stat-label">Error rate</span><span class="stat-val">${(r.errorRate*100).toFixed(2)}%</span></div>
              <div class="stat-cell"><span class="stat-label">Max VUs</span><span class="stat-val">${fmt(r.vusMax)}</span></div>
              <div class="stat-cell"><span class="stat-label">Duration</span><span class="stat-val">${r.duration}</span></div>
              <div class="stat-cell"><span class="stat-label">Total requests</span><span class="stat-val">${fmt(r.totalRequests)}</span></div>
              <div class="stat-cell"><span class="stat-label">Req/s avg</span><span class="stat-val">${fmt(r.throughput, 1)}</span></div>
              <div class="stat-cell"><span class="stat-label">Think time</span><span class="stat-val">${r.thinkTime}s</span></div>
            </div>
            <h4>Baseline comparison</h4>
            ${bLine}
          </div>
        </details>`;
    }).join('');

    // â”€â”€ Tab 4: Baseline comparison table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const baselineRows = sortedRows.map(r => {
      const deltaNum  = r.changePct ?? 0;
      const tolerance = parseFloat(process.env.PERF_BASELINE_TOLERANCE || '0.20') * 100;
      const deltaCol  = deltaNum > tolerance ? '#b71c1c' : deltaNum > 0 ? '#e65100' : '#2e7d32';
      return `<tr>
        <td>${r.name}</td>
        <td>${r.previousP95 != null ? fmt(r.previousP95) + ' ms' : 'â€”'}</td>
        <td>${fmt(r.p95)} ms</td>
        <td style="color:${deltaCol}">${r.changePct != null ? (deltaNum > 0 ? '+' : '') + fmt(r.changePct, 1) + '%' : 'â€”'}</td>
        <td>${tolerance}%</td>
        <td>${r.baselineDegraded ? '<span style="color:#b71c1c;font-weight:bold">DEGRADED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
      </tr>`;
    }).join('');

    // â”€â”€ Assemble HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Performance Test Report â€” ${storyKey}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px;background:#f0f2f5;color:#212121}
    h1{font-size:2rem;margin:0 0 4px}
    h2{font-size:1.1rem;margin:28px 0 12px;border-bottom:2px solid #1565c0;padding-bottom:4px;color:#1565c0;text-transform:uppercase;letter-spacing:.05em}
    h4{font-size:0.85rem;margin:12px 0 4px;color:#555}
    .header-meta{color:#888;font-size:0.85rem;margin-bottom:16px}
    .badge-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}

    /* Executive summary cards */
    .exec-cards{display:flex;gap:16px;flex-wrap:wrap;margin-bottom:28px}
    .exec-card{background:#fff;border-radius:10px;padding:16px 24px;box-shadow:0 2px 6px rgba(0,0,0,.1);min-width:140px;text-align:center}
    .exec-card .card-num{font-size:2rem;font-weight:bold}
    .exec-card .card-lbl{font-size:0.75rem;color:#888;text-transform:uppercase;letter-spacing:.05em}
    .card-pass{color:#2e7d32}.card-warn{color:#e65100}.card-fail{color:#b71c1c}.card-blue{color:#1565c0}

    /* SLA cards */
    .sla-grid{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
    .sla-card{background:#fff;border-radius:10px;padding:14px 18px;box-shadow:0 2px 6px rgba(0,0,0,.1)}
    .sla-name{font-size:0.75rem;color:#888;text-transform:uppercase;margin:6px 0 2px}
    .sla-limit{font-size:0.78rem;color:#888;margin-top:2px}
    .sla-bar-bg{background:#e0e0e0;border-radius:4px;height:6px;margin-top:8px;overflow:hidden}
    .sla-bar-fill{height:100%;border-radius:4px;transition:width .3s}

    /* Tabs */
    .tab-bar{display:flex;gap:0;border-bottom:2px solid #1565c0;margin-bottom:20px}
    .tab-btn{padding:10px 22px;cursor:pointer;border:none;background:transparent;font-size:0.9rem;color:#555;border-bottom:3px solid transparent;margin-bottom:-2px;font-weight:500;transition:all .2s}
    .tab-btn.active{color:#1565c0;border-bottom-color:#1565c0;font-weight:700}
    .tab-btn:hover{background:#e3f2fd}
    .tab-pane{display:none}.tab-pane.active{display:block}

    /* Tables */
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:20px}
    th{background:#1565c0;color:#fff;padding:10px 14px;text-align:left;font-size:0.82rem}
    td{padding:9px 14px;border-bottom:1px solid #e8e8e8;font-size:0.88rem;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .hover-row:hover td{background:#e3f2fd}
    table.inner{box-shadow:none;border:1px solid #e0e0e0}

    /* Detail cards */
    .detail-card{background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:14px 18px;margin-bottom:10px}
    .detail-card summary{cursor:pointer;user-select:none;outline:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .detail-card summary .chevron{margin-left:auto;transition:transform .2s}
    .detail-card[open] summary .chevron{transform:rotate(180deg)}
    .detail-body{padding-top:12px}
    .stat-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:10px;margin:10px 0}
    .stat-cell{background:#f9f9f9;border-radius:6px;padding:10px 14px}
    .stat-label{display:block;font-size:0.72rem;color:#888;text-transform:uppercase;margin-bottom:4px}
    .stat-val{font-size:1.1rem;font-weight:bold;color:#212121}
    .breach-alert{background:#fdecea;border-left:4px solid #b71c1c;padding:10px 14px;border-radius:4px;margin-bottom:12px}
    .breach-alert ul{margin:4px 0 0 16px;padding:0}

    /* Legend */
    .chart-legend{display:flex;gap:16px;margin-bottom:8px;flex-wrap:wrap;font-size:0.85rem}
    .legend-dot{width:14px;height:14px;border-radius:2px;display:inline-block;margin-right:4px;vertical-align:middle}
    .chart-wrap{background:#fff;border-radius:8px;padding:20px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:24px}

    /* Footer */
    footer{margin-top:40px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.78rem;color:#888;display:flex;gap:20px;flex-wrap:wrap}
    footer a{color:#1565c0;text-decoration:none}
    @media(max-width:700px){.sla-grid{grid-template-columns:repeat(2,1fr)}.stat-grid{grid-template-columns:repeat(2,1fr)}}
  </style>
</head>
<body>
  <!-- â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h1>&#128200; Performance test report</h1>
  <div class="header-meta">
    Story: <strong>${storyKey}</strong> &nbsp;|&nbsp;
    Run: <strong>${generated}</strong> &nbsp;|&nbsp;
    Scripts: <strong>${rows.length}</strong>
  </div>
  <div class="badge-row">
    <span>Overall verdict:</span> ${verdictBadge(overall)}
    <span style="background:#2e7d32;color:#fff;padding:2px 10px;border-radius:12px;font-size:0.82em">${passCount} PASS</span>
    <span style="background:#e65100;color:#fff;padding:2px 10px;border-radius:12px;font-size:0.82em">${warnCount} WARN</span>
    <span style="background:#b71c1c;color:#fff;padding:2px 10px;border-radius:12px;font-size:0.82em">${failCount} FAIL</span>
  </div>

  <!-- â”€â”€ SECTION 1: EXECUTIVE SUMMARY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h2>Executive Summary</h2>
  <div class="exec-cards">
    <div class="exec-card"><div class="card-num card-blue">${rows.length}</div><div class="card-lbl">Scripts run</div></div>
    <div class="exec-card"><div class="card-num card-pass">${passCount}</div><div class="card-lbl">Pass</div></div>
    <div class="exec-card"><div class="card-num card-warn">${warnCount}</div><div class="card-lbl">Warn</div></div>
    <div class="exec-card"><div class="card-num card-fail">${failCount}</div><div class="card-lbl">Fail</div></div>
    <div class="exec-card"><div class="card-num card-blue">${totalReqs.toLocaleString()}</div><div class="card-lbl">Total requests</div></div>
  </div>

  <!-- â”€â”€ SECTION 2: SLA THRESHOLD STATUS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h2>SLA Threshold Status</h2>
  <div class="sla-grid">
    ${slaCard('p95 Response', worstP95, th.p95, 'ms', false)}
    ${slaCard('p99 Response', worstP99, th.p99, 'ms', false)}
    ${slaCard('Error Rate',   worstErr, th.errorRate, '', true)}
    ${slaCard('Throughput',   bestTput, bestTput || 1, 'req/s', false)}
    <div class="sla-card">
      ${verdictBadge(baseReg ? 'warn' : 'pass')}
      <div class="sla-name">Baseline Regression</div>
      <div class="sla-actual" style="color:${baseReg?'#e65100':'#2e7d32'};font-size:1.1em;font-weight:bold">${baseReg ? 'DETECTED' : 'NONE'}</div>
      <div class="sla-limit">Scripts degraded: ${rows.filter(r=>r.baselineDegraded).length}</div>
      <div class="sla-bar-bg"><div class="sla-bar-fill" style="width:${rows.filter(r=>r.baselineDegraded).length / Math.max(rows.length,1) * 100}%;background:${baseReg?'#e65100':'#2e7d32'}"></div></div>
    </div>
    ${slaCard('Max VUs',      maxVus,   parseInt(process.env.PERF_VUS_MAX||'50',10), '', false)}
  </div>

  <!-- â”€â”€ TABS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <div class="tab-bar">
    <button class="tab-btn active" onclick="showTab('t1',this)">Response Time Charts</button>
    <button class="tab-btn"       onclick="showTab('t2',this)">All Scripts Table</button>
    <button class="tab-btn"       onclick="showTab('t3',this)">Script Details</button>
    <button class="tab-btn"       onclick="showTab('t4',this)">Baseline Comparison</button>
  </div>

  <!-- TAB 1: RESPONSE TIME CHARTS -->
  <div id="t1" class="tab-pane active">
    <div class="chart-legend">
      <span><span class="legend-dot" style="background:#1565c0"></span>p95</span>
      <span><span class="legend-dot" style="background:#ef5350"></span>p99</span>
      <span style="color:#555">SLA p95 = ${th.p95}ms &nbsp;|&nbsp; SLA p99 = ${th.p99}ms</span>
    </div>
    <div class="chart-wrap"><canvas id="rtChart" height="80"></canvas></div>
    <h4>Error Rate (%) per script</h4>
    <div class="chart-wrap"><canvas id="errChart" height="60"></canvas></div>
  </div>

  <!-- TAB 2: ALL SCRIPTS TABLE -->
  <div id="t2" class="tab-pane">
    <table>
      <thead>
        <tr>
          <th>Script name</th><th>Type</th><th>p95 ms</th><th>p99 ms</th>
          <th>Avg ms</th><th>Error %</th><th>Req/s</th><th>VUs</th>
          <th>Duration</th><th>Verdict</th>
        </tr>
      </thead>
      <tbody>
        ${tableRows || '<tr><td colspan="10" style="text-align:center;color:#888">No results</td></tr>'}
      </tbody>
    </table>
  </div>

  <!-- TAB 3: SCRIPT DETAILS -->
  <div id="t3" class="tab-pane">
    ${detailCards || '<p style="color:#888">No script detail data available.</p>'}
  </div>

  <!-- TAB 4: BASELINE COMPARISON -->
  <div id="t4" class="tab-pane">
    <table>
      <thead>
        <tr><th>Script</th><th>Prev p95</th><th>Curr p95</th><th>Delta</th><th>Threshold</th><th>Status</th></tr>
      </thead>
      <tbody>
        ${baselineRows || '<tr><td colspan="6" style="text-align:center;color:#888">No baseline data</td></tr>'}
      </tbody>
    </table>
    <p style="font-size:0.8rem;color:#888">Baseline updated only on PASS runs. Last baseline: ${generated}</p>
  </div>

  <!-- â”€â”€ FOOTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <footer>
    ${jiraUrl && storyKey !== 'N/A' ? `<a href="${jiraUrl}/browse/${storyKey}" target="_blank">&#128279; Jira Story</a>` : ''}
    ${zephyrUrl ? `<a href="${zephyrUrl}" target="_blank">&#128279; Zephyr Cycle</a>` : ''}
    <span>&#128336; ${generated}</span>
    <span>Generated by Agentic QA Platform</span>
  </footer>

  <script>
    // â”€â”€ Tab switching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    function showTab(id, btn) {
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      btn.classList.add('active');
    }

    // â”€â”€ Chart data (embedded) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const LABELS     = ${chartLabels};
    const P95_DATA   = ${p95Data};
    const P99_DATA   = ${p99Data};
    const ERR_DATA   = ${errData};
    const ERR_COLORS = ${errColors};
    const P95_SLA    = ${p95Threshold};
    const P99_SLA    = ${p99Threshold};
    const ERR_SLA    = ${errThreshold};

    // Response Time Chart
    new Chart(document.getElementById('rtChart'), {
      type: 'bar',
      data: {
        labels: LABELS,
        datasets: [
          { label: 'p95 (ms)', data: P95_DATA, backgroundColor: '#1565c0' },
          { label: 'p99 (ms)', data: P99_DATA, backgroundColor: '#ef5350' },
          { label: 'SLA p95',  data: Array(LABELS.length).fill(P95_SLA),  type: 'line', borderColor: '#1565c0', borderDash: [6,3], pointRadius: 0, fill: false },
          { label: 'SLA p99',  data: Array(LABELS.length).fill(P99_SLA),  type: 'line', borderColor: '#ef5350', borderDash: [6,3], pointRadius: 0, fill: false },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'ms' } } }
      }
    });

    // Error Rate Chart
    new Chart(document.getElementById('errChart'), {
      type: 'bar',
      data: {
        labels: LABELS,
        datasets: [
          { label: 'Error Rate (%)', data: ERR_DATA, backgroundColor: ERR_COLORS },
          { label: 'SLA Limit', data: Array(LABELS.length).fill(ERR_SLA), type: 'line', borderColor: '#e65100', borderDash: [6,3], pointRadius: 0, fill: false },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' } },
        scales: { y: { beginAtZero: true, title: { display: true, text: '%' } } }
      }
    });
  </script>
</body>
</html>`;

    const outFile = path.join(outputDir, 'index.html');
    fs.writeFileSync(outFile, html, 'utf8');
    logger.info(`[PerfReport] Report written to: ${path.relative(ROOT, outFile)}`);
    return outFile;
  } catch (err) {
    throw new AppError(`generatePerfReport failed: ${err.message}`);
  }
}

// â”€â”€â”€ Standalone CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (require.main === module) {
  const outputDir  = path.join(ROOT, 'custom-report', 'perf');
  const thresholds = {
    p95:       parseInt(process.env.PERF_THRESHOLDS_P95  || '2000', 10),
    p99:       parseInt(process.env.PERF_THRESHOLDS_P99  || '5000', 10),
    errorRate: parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
  };

  const resultsDir = path.join(ROOT, 'test-results', 'perf');
  const results    = [];

  if (fs.existsSync(resultsDir)) {
    const { parsePerfResults, evaluateThresholds, compareToBaseline } = require('../src/services/perf.execution.service');
    const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json'));
    for (const f of files) {
      const fp = path.join(resultsDir, f);
      try {
        const metrics  = parsePerfResults(fp);
        const { verdict, breaches } = evaluateThresholds(metrics, thresholds);
        const parts    = path.basename(f, '.json').split('_');
        const testType = parts[parts.length - 1] || 'load';
        const sk       = parts.slice(0, -1).join('_') || process.env.ISSUE_KEY || 'UNKNOWN';
        const baseline = compareToBaseline(`${sk}_${testType}`, metrics);
        results.push({ basename: path.basename(f, '.json'), testType, storyKey: sk, metrics, verdict, breaches, ...baseline });
      } catch (_) { /* skip malformed */ }
    }
  }

  try {
    const out = generatePerfReport(results, thresholds, outputDir);
    console.log(`[generate-perf-report] Written: ${out}`);
    process.exit(0);
  } catch (err) {
    console.error('[generate-perf-report] FATAL:', err.message);
    process.exit(1);
  }
}

module.exports = { generatePerfReport };
