'use strict';
/** @module generate-perf-report â€” Generates a detailed self-contained HTML performance test report from k6 results. */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

const ROOT = path.resolve(__dirname, '..');

// ─── Build time-bucketed series from a k6 NDJSON output file ─────────────────
// Returns { labels, p50, p95, p99, rps, errorRate, vus } arrays aligned by bucket.
// Bucket size defaults to 5 seconds; caller can override. Returns null on failure.
function buildTimeSeries(ndjsonPath, bucketSec = 5) {
  try {
    if (!fs.existsSync(ndjsonPath)) return null;
    const stat = fs.statSync(ndjsonPath);
    if (stat.size === 0) return null;
    const raw = fs.readFileSync(ndjsonPath, 'utf8');
    const buckets = new Map(); // key = epoch seconds (floored to bucket)
    let firstTs = null;
    for (const line of raw.split('\n')) {
      if (!line || line[0] !== '{') continue;
      let obj;
      try { obj = JSON.parse(line); } catch { continue; }
      if (obj.type !== 'Point' || !obj.data || !obj.data.time) continue;
      const metric = obj.metric;
      if (!['http_req_duration', 'http_reqs', 'http_req_failed', 'vus'].includes(metric)) continue;
      const ts = Date.parse(obj.data.time);
      if (Number.isNaN(ts)) continue;
      if (firstTs === null || ts < firstTs) firstTs = ts;
      const bucketKey = Math.floor(ts / (bucketSec * 1000)) * bucketSec;
      let b = buckets.get(bucketKey);
      if (!b) { b = { durations: [], reqs: 0, fails: 0, vus: 0, vusCount: 0 }; buckets.set(bucketKey, b); }
      const v = obj.data.value;
      if (metric === 'http_req_duration') b.durations.push(v);
      else if (metric === 'http_reqs')    b.reqs += (v || 0);
      else if (metric === 'http_req_failed') { b.fails += (v || 0); }
      else if (metric === 'vus')          { b.vus += (v || 0); b.vusCount++; }
    }
    if (buckets.size === 0) return null;
    const pct = (arr, p) => {
      if (!arr.length) return 0;
      const s = [...arr].sort((a, b) => a - b);
      return s[Math.max(0, Math.ceil((p / 100) * s.length) - 1)];
    };
    const sorted = [...buckets.entries()].sort((a, b) => a[0] - b[0]);
    const firstKey = sorted[0][0];
    const labels = [], p50 = [], p95 = [], p99 = [], rps = [], errorRate = [], vus = [];
    for (const [key, b] of sorted) {
      labels.push(String(key - firstKey) + 's');
      p50.push(Math.round(pct(b.durations, 50)));
      p95.push(Math.round(pct(b.durations, 95)));
      p99.push(Math.round(pct(b.durations, 99)));
      rps.push(+(b.reqs / bucketSec).toFixed(2));
      const total = b.durations.length || 1;
      errorRate.push(+((b.fails / total) * 100).toFixed(2));
      vus.push(b.vusCount ? Math.round(b.vus / b.vusCount) : 0);
    }
    return { labels, p50, p95, p99, rps, errorRate, vus, bucketSec };
  } catch {
    return null;
  }
}

// ─── Auto-generate insights from results ─────────────────────────────────────
function buildInsights(rows, thresholds) {
  const insights = [];
  if (!rows.length) return insights;
  const worstP99 = rows.reduce((a, r) => r.p99 > a.p99 ? r : a, rows[0]);
  if (worstP99.p99 > 0 && thresholds.p99 > 0) {
    const pct = Math.round((worstP99.p99 / thresholds.p99) * 100);
    if (pct >= 90) {
      insights.push({ level: pct >= 100 ? 'fail' : 'warn',
        text: `<strong>${worstP99.name}</strong> p99 at ${Math.round(worstP99.p99)}ms is ${pct}% of SLA (${thresholds.p99}ms).` });
    }
  }
  const highErr = rows.filter(r => r.errorRate > thresholds.errorRate);
  if (highErr.length) {
    insights.push({ level: 'fail',
      text: `${highErr.length} script(s) exceeded error-rate SLA (${(thresholds.errorRate * 100).toFixed(2)}%): ${highErr.map(r => r.name).join(', ')}.` });
  }
  const degraded = rows.filter(r => r.baselineDegraded);
  if (degraded.length) {
    insights.push({ level: 'warn',
      text: `${degraded.length} script(s) show baseline regression vs previous run.` });
  }
  const slowNet = rows.filter(r => r.waiting > 500);
  if (slowNet.length) {
    insights.push({ level: 'warn',
      text: `High server wait time (TTFB > 500ms) detected on ${slowNet.length} script(s) — investigate backend latency.` });
  }
  if (insights.length === 0) {
    insights.push({ level: 'pass', text: 'All scripts within SLA, no baseline regression, no near-threshold warnings.' });
  }
  return insights;
}

// ─── Normalise a result entry regardless of flat vs metrics-nested format ────
function norm(r) {
  const m = r.metrics || {};
  return {
    name:             r.basename      || r.scriptName  || path.basename(r.scriptPath || 'unknown', '.k6.js'),
    testType:         r.testType      || 'load',
    verdict:          r.verdict       || 'pass',
    p95:              +(m.p95          ?? r.p95          ?? 0),
    p99:              +(m.p99          ?? r.p99          ?? 0),
    p50:              +(m.p50          ?? r.p50          ?? 0),
    p90:              +(m.p90          ?? r.p90          ?? 0),
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
    // Fix 2+3+4 additions
    warnings:          r.warnings      || [],
    _warning:          r._warning      || null,
    baselineDegradedP99:        r.baselineDegradedP99 ?? false,
    previousP99:               +(r.previousP99 ?? 0) || null,
    changePct99:               +(r.changePct99 ?? 0) || null,
    baselineErrorRateIncreased: r.baselineErrorRateIncreased ?? false,
    previousErrorRate:          +(r.previousErrorRate ?? 0),
    // Network breakdown (k6 http_req_* sub-metrics)
    blocked:       +(m.blocked      ?? r.blocked      ?? 0),
    connecting:    +(m.connecting   ?? r.connecting   ?? 0),
    tlsHandshake:  +(m.tlsHandshake ?? r.tlsHandshake ?? 0),
    sending:       +(m.sending      ?? r.sending      ?? 0),
    waiting:       +(m.waiting      ?? r.waiting      ?? 0),
    receiving:     +(m.receiving    ?? r.receiving    ?? 0),
    // Baseline rolling window & trend (Fix 3)
    trend:           r.trend         || null,
    historyWindow:   r.historyWindow || [],
    droppedIterations: +(m.droppedIterations ?? r.droppedIterations ?? 0),
    // Time-bucketed series built from NDJSON by buildTimeSeries (optional)
    timeseries:      r.timeseries    || null,
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


    // ── Empty-state guard: no results available ──────────────────────────────
    if (rows.length === 0) {
      const emptyHtml = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Performance Report — No Data</title>
  <style>
    body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', sans-serif; margin: 0; background: #fafafa; display: flex; align-items: center; justify-content: center; min-height: 100vh; }
    .card { background: #fff; border-radius: 12px; padding: 48px 64px; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; max-width: 560px; }
    .icon { font-size: 3rem; margin-bottom: 16px; }
    h1 { font-size: 1.5rem; color: #1a237e; margin: 0 0 12px; }
    p { color: #555; margin: 0 0 24px; line-height: 1.6; }
    .banner { background: #fff8e1; border-left: 4px solid #fbc02d; border-radius: 6px; padding: 14px 20px; text-align: left; font-size: 0.95rem; color: #5d4037; }
    code { background: #f5f5f5; padding: 2px 8px; border-radius: 4px; font-size: 0.9em; }
  </style>
</head>
<body>
  <div class="card">
    <div class="icon">⏱️</div>
    <h1>No Performance Results Available</h1>
    <p>The performance test pipeline has not yet produced any results for this run.</p>
    <div class="banner">
      Run <code>npm run perf</code> (or <code>node scripts/run-perf.js</code>) to generate data,
      then refresh this report.
    </div>
  </div>

  <!-- TAB 5: VU VS LATENCY TIMELINE -->
  <div id="t5" class="tab-pane">
    <p style="font-size:0.85rem;color:#888">Dual-axis chart: left Y-axis = p95 latency (ms), right Y-axis = virtual users. Dashed lines = VU ramp. Reads <code>test-results/perf/*-timeseries.csv</code>.</p>
    <div id="t5-empty" style="display:none;color:#888;padding:24px;text-align:center">No timeseries CSV files found in test-results/perf/. Run tests with k6 to generate them.</div>
    <div class="chart-wrap"><canvas id="vuLatencyChart" height="90"></canvas></div>
    <div style="font-size:0.8rem;color:#888;margin-top:8px">SLA p95 annotation line shown in blue dashes.</div>
  </div>

</body>
</html>`;
      const outFile = path.join(outputDir, 'index.html');
      fs.writeFileSync(outFile, emptyHtml, 'utf8');
      logger.info('[PerfReport] No results — written empty-state report');
      return outFile;
    }
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
    const p50Data       = JSON.stringify(rows.map(r => Math.round(r.p50)));
    const p90Data       = JSON.stringify(rows.map(r => Math.round(r.p90)));
    const avgData       = JSON.stringify(rows.map(r => Math.round(r.avg)));
    const throughputData= JSON.stringify(rows.map(r => +r.throughput.toFixed(2)));
    // Network breakdown stacked-bar datasets (avg ms per phase per script)
    const netBlocked    = JSON.stringify(rows.map(r => +r.blocked.toFixed(1)));
    const netConnecting = JSON.stringify(rows.map(r => +r.connecting.toFixed(1)));
    const netTls        = JSON.stringify(rows.map(r => +r.tlsHandshake.toFixed(1)));
    const netSending    = JSON.stringify(rows.map(r => +r.sending.toFixed(1)));
    const netWaiting    = JSON.stringify(rows.map(r => +r.waiting.toFixed(1)));
    const netReceiving  = JSON.stringify(rows.map(r => +r.receiving.toFixed(1)));
    // Time-series (NDJSON-derived) for throughput & latency trend charts
    const timeSeriesData = JSON.stringify(rows.map(r => ({
      name: r.name, testType: r.testType, ts: r.timeseries || null,
    })));
    const errData       = JSON.stringify(rows.map(r => parseFloat((r.errorRate * 100).toFixed(3))));    const errColors     = JSON.stringify(rows.map(r =>
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
      // ── Amber NDJSON-fallback banner (data quality warning) ───────────────────────
      const ndjsonBanner = r._warning
        ? `<div style="background:#fff3e0;border-left:4px solid #e65100;padding:10px 16px;margin-bottom:12px;border-radius:0 6px 6px 0;font-size:0.88rem;color:#bf360c">
            <strong>⚠️ Metric accuracy warning:</strong> ${r._warning}
          </div>`
        : '';

      // ── Yellow near-threshold warnings ──────────────────────────────────────────
      const nearLimitWarnings = (r.warnings || []).filter(w => w.metric !== 'data-quality');
      const warningsBox = nearLimitWarnings.length
        ? `<div style="background:#fffde7;border-left:4px solid #f9a825;padding:10px 16px;margin-bottom:12px;border-radius:0 6px 6px 0;font-size:0.88rem">
            <strong style="color:#e65100">⚠️ Near-threshold warnings:</strong>
            <ul style="margin:6px 0 0;padding-left:20px">${nearLimitWarnings.map(w =>
              `<li>${w.metric}: ${typeof w.value === 'number' ? w.value.toFixed(2) : w.value} is ${w.pctToLimit}% of limit (${w.threshold})</li>`
            ).join('')}</ul>
          </div>`
        : '';

      // ── Red breach alert box ───────────────────────────────────────────────────────────────
      const alertBox = r.breaches.length
        ? `<div class="breach-alert">
            <strong>Threshold breaches:</strong>
            <ul>${r.breaches.map(b =>
              `<li>${b.metric} ${Math.round(b.actual)}${b.metric === 'errorRate' ? '' : 'ms'} &gt; ${Math.round(b.limit)}${b.metric === 'errorRate' ? '' : 'ms'} limit â€” <em>${RECS[b.metric] || ''}</em></li>`
            ).join('')}</ul>
          </div>` : '';

      // ── Inline baseline comparison (p95, p99, errorRate) ──────────────────────────
      const bLine = r.previousP95 != null
        ? `<table class="inner baseline-table">
            <thead><tr><th>Metric</th><th>Previous</th><th>Current</th><th>Delta %</th><th>Status</th></tr></thead>
            <tbody>
              <tr>
                <td>p95</td>
                <td>${fmt(r.previousP95)} ms</td>
                <td>${fmt(r.p95)} ms</td>
                <td style="color:${r.changePct > 0 ? '#e65100':'#2e7d32'}">${r.changePct != null ? (r.changePct > 0 ? '+' : '') + fmt(r.changePct, 1) + '%' : '—'}</td>
                <td>${r.baselineDegraded ? '<span style="color:#b71c1c">DEGRADED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
              </tr>
              ${r.previousP99 ? `<tr>
                <td>p99</td>
                <td>${fmt(r.previousP99)} ms</td>
                <td>${fmt(r.p99)} ms</td>
                <td style="color:${r.changePct99 > 0 ? '#e65100':'#2e7d32'}">${r.changePct99 != null ? (r.changePct99 > 0 ? '+' : '') + fmt(r.changePct99, 1) + '%' : '—'}</td>
                <td>${r.baselineDegradedP99 ? '<span style="color:#e65100">DEGRADED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
              </tr>` : ''}
              ${r.previousErrorRate > 0 ? `<tr>
                <td>errorRate</td>
                <td>${(r.previousErrorRate * 100).toFixed(2)}%</td>
                <td>${(r.errorRate * 100).toFixed(2)}%</td>
                <td style="color:${r.baselineErrorRateIncreased ? '#e65100':'#2e7d32'}">${r.baselineErrorRateIncreased ? '↑ increased' : '↓ stable'}</td>
                <td>${r.baselineErrorRateIncreased ? '<span style="color:#e65100">⚠ INCREASED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
              </tr>` : ''}
            </tbody>
          </table>` : '<p style="color:#888;font-size:0.85em">No baseline data available.</p>';

      return `
        <details class="detail-card" open="${r.verdict === 'fail' ? 'true' : 'false'}">
          <summary>
            ${verdictBadge(r.verdict)} &nbsp; <strong>${r.name}</strong> &nbsp; ${typePill(r.testType)}
            <span class="chevron">&#9660;</span>
          </summary>
          <div class="detail-body">
            ${ndjsonBanner}
            ${alertBox}
            ${warningsBox}
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
            <h4>Network Breakdown (avg ms)</h4>
            <table class="inner" style="width:auto;font-size:0.82rem">
              <thead><tr><th>DNS blocked</th><th>Connecting</th><th>TLS handshake</th><th>Sending</th><th>Waiting (TTFB)</th><th>Receiving</th></tr></thead>
              <tbody><tr>
                <td>${fmt(r.blocked, 1)}</td>
                <td>${fmt(r.connecting, 1)}</td>
                <td>${fmt(r.tlsHandshake, 1)}</td>
                <td>${fmt(r.sending, 1)}</td>
                <td>${fmt(r.waiting, 1)}</td>
                <td>${fmt(r.receiving, 1)}</td>
              </tr></tbody>
            </table>
            <h4>Baseline comparison</h4>
            ${bLine}
          </div>
        </details>`;
    }).join('');

    // â”€â”€ Tab 4: Baseline comparison table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const baselineRows = sortedRows.map((r, idx) => {
      const deltaNum  = r.changePct ?? 0;
      const tolerance = parseFloat(process.env.PERF_BASELINE_TOLERANCE || '0.20') * 100;
      const deltaCol  = deltaNum > tolerance ? '#b71c1c' : deltaNum > 0 ? '#e65100' : '#2e7d32';
      const trendArrow = r.trend === 'degrading' ? '&#9650;' : r.trend === 'improving' ? '&#9660;' : r.trend === 'stable' ? '&#8212;' : '';
      const trendColor = r.trend === 'degrading' ? '#b71c1c' : r.trend === 'improving' ? '#2e7d32' : '#888';
      return `<tr>
        <td>${r.name}</td>
        <td>${r.previousP95 != null ? fmt(r.previousP95) + ' ms' : '&mdash;'}</td>
        <td>${fmt(r.p95)} ms</td>
        <td style="color:${deltaCol}">${r.changePct != null ? (deltaNum > 0 ? '+' : '') + fmt(r.changePct, 1) + '%' : '&mdash;'}</td>
        <td>${tolerance}%</td>
        <td style="color:${trendColor};font-weight:bold">${trendArrow} ${r.trend || '&mdash;'}</td>
        <td><canvas id="spark_${idx}" width="80" height="30"></canvas></td>
        <td>${r.baselineDegraded ? '<span style="color:#b71c1c;font-weight:bold">DEGRADED</span>' : '<span style="color:#2e7d32">OK</span>'}</td>
      </tr>`;
    }).join('');

    // Build sparkline data for Tab 4 (rolling p95 history per row)
    const sparkData = sortedRows.map(r => ({
      history: (r.historyWindow || []).map(h => Math.round(h.p95 || 0)).filter(v => v > 0),
    }));

    // ── Tab 5: VU vs Latency Timeline data ────────────────────────────────────────
    const perfResultsDir = path.join(ROOT, 'test-results', 'perf');
    const timelineDatasets = [];
    if (fs.existsSync(perfResultsDir)) {
      const csvFiles = fs.readdirSync(perfResultsDir).filter(f => f.endsWith('-timeseries.csv'));
      for (const cf of csvFiles) {
        try {
          const lines = fs.readFileSync(path.join(perfResultsDir, cf), 'utf8').split('\n').filter(Boolean);
          if (lines.length < 2) continue;
          const headers = lines[0].split(',');
          const p95Col  = headers.indexOf('p95');
          const vuCol   = headers.indexOf('vus_max');
          const tCol    = headers.indexOf('timestamp');
          if (p95Col < 0) continue;
          const label  = cf.replace('-timeseries.csv', '');
          const p95Pts = lines.slice(1).map(l => +l.split(',')[p95Col] || null).filter(v => v !== null);
          const vuPts  = vuCol  >= 0 ? lines.slice(1).map(l => +l.split(',')[vuCol]  || null).filter(v => v !== null) : [];
          const tlbls  = tCol   >= 0 ? lines.slice(1).map(l => l.split(',')[tCol] || '').slice(0, p95Pts.length) : p95Pts.map((_, i) => String(i + 1));
          timelineDatasets.push({ label, p95: p95Pts, vus: vuPts, labels: tlbls });
        } catch { /* skip */ }
      }
    }
    const timelineLabels = timelineDatasets[0]?.labels || [];
    const timelineP95DS  = timelineDatasets.map((ds, i) => ({
      label: ds.label + ' p95 (ms)',
      data:  ds.p95,
      borderColor: Object.values(TYPE_COLOURS)[i % Object.keys(TYPE_COLOURS).length],
      yAxisID: 'yLatency', tension: 0.3, fill: false,
    }));
    const timelineVuDS = timelineDatasets.map((ds, i) => ({
      label: ds.label + ' VUs',
      data:  ds.vus,
      borderColor: Object.values(TYPE_COLOURS)[i % Object.keys(TYPE_COLOURS).length],
      borderDash: [4, 3],
      yAxisID: 'yVUs', tension: 0.3, fill: false,
    }));

    // ── Insights (auto-generated observations) ────────────────────────────────
    const insights = buildInsights(rows, th);
    const insightsHtml = insights.map(i => {
      const cls = i.level === 'fail' ? 'ins-fail' : i.level === 'warn' ? 'ins-warn' : 'ins-pass';
      const icon = i.level === 'fail' ? '✖' : i.level === 'warn' ? '⚠' : '✔';
      return `<li class="${cls}"><span class="ins-ico">${icon}</span>${i.text}</li>`;
    }).join('');

    // ── Per-test-type aggregates ──────────────────────────────────────────────
    const typeAgg = testTypes.map(t => {
      const subset = rows.filter(r => r.testType === t);
      if (!subset.length) return null;
      const avg = (k) => subset.reduce((s, r) => s + (r[k] || 0), 0) / subset.length;
      const worst = subset.reduce((a, r) => r.p99 > a.p99 ? r : a, subset[0]);
      const passN = subset.filter(r => r.verdict === 'pass').length;
      return {
        type: t, count: subset.length, passN,
        avgP95: Math.round(avg('p95')), worstP99: Math.round(worst.p99),
        avgThr: avg('throughput').toFixed(1),
        avgErr: (avg('errorRate') * 100).toFixed(2),
        maxVus: Math.max(...subset.map(r => r.vusMax || 0)),
        verdict: worstVerdict(subset),
      };
    }).filter(Boolean);
    const typeAggHtml = typeAgg.map(t => `
      <div class="type-card type-${t.verdict}">
        <div class="type-head">${typePill(t.type)} <span class="type-count">${t.passN}/${t.count} pass</span></div>
        <div class="type-metrics">
          <div><span>Avg p95</span><strong>${t.avgP95}ms</strong></div>
          <div><span>Worst p99</span><strong>${t.worstP99}ms</strong></div>
          <div><span>Throughput</span><strong>${t.avgThr}/s</strong></div>
          <div><span>Err rate</span><strong>${t.avgErr}%</strong></div>
          <div><span>Peak VUs</span><strong>${t.maxVus}</strong></div>
        </div>
      </div>`).join('');

    // ── Assemble HTML ──────────────────────────────────────────────────────────────
    
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

    /* Insights panel */
    .insights{background:#fff;border-radius:8px;padding:16px 22px;box-shadow:0 1px 4px rgba(0,0,0,.08);margin:20px 0 28px;border-left:4px solid #1565c0}
    .insights h3{margin:0 0 10px;font-size:1rem;color:#1565c0;letter-spacing:.3px}
    .insights ul{list-style:none;padding:0;margin:0}
    .insights li{padding:6px 0;font-size:0.88rem;display:flex;align-items:flex-start;gap:10px;border-bottom:1px dashed #f0f0f0}
    .insights li:last-child{border-bottom:none}
    .insights .ins-ico{font-weight:700;width:18px;flex:none;text-align:center}
    .ins-fail .ins-ico{color:#c62828}.ins-warn .ins-ico{color:#e65100}.ins-pass .ins-ico{color:#2e7d32}

    /* Per-test-type aggregate cards */
    .type-agg{display:grid;grid-template-columns:repeat(auto-fit,minmax(220px,1fr));gap:14px;margin-bottom:28px}
    .type-card{background:#fff;border-radius:8px;padding:14px 16px;box-shadow:0 1px 4px rgba(0,0,0,.08);border-top:3px solid #1565c0}
    .type-card.type-pass{border-top-color:#2e7d32}.type-card.type-warn{border-top-color:#e65100}.type-card.type-fail{border-top-color:#c62828}
    .type-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:10px;font-size:0.85rem}
    .type-count{color:#666;font-weight:500}
    .type-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:6px 12px;font-size:0.82rem}
    .type-metrics>div{display:flex;justify-content:space-between;padding:3px 0;border-bottom:1px dotted #eee}
    .type-metrics span{color:#777}.type-metrics strong{color:#1565c0;font-weight:600}

    /* Footer */
    footer{margin-top:40px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.78rem;color:#888;display:flex;gap:20px;flex-wrap:wrap}
    footer a{color:#1565c0;text-decoration:none}
    @media(max-width:700px){.sla-grid{grid-template-columns:repeat(2,1fr)}.stat-grid{grid-template-columns:repeat(2,1fr)}}
    @media print{
      .tab-bar,.tab-btn{display:none!important}
      .tab-pane{display:block!important}
      .detail-card[open] .detail-body{display:block!important}
      footer a{color:#000!important}
    }
  </style>
</head>
<body>
  <!-- â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <div style="display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:8px;margin-bottom:4px">
  <h1 style="margin:0">&#128200; Performance test report</h1>
  <button onclick="window.print()" style="background:#1565c0;color:#fff;border:none;border-radius:6px;padding:8px 18px;cursor:pointer;font-size:0.9rem;font-weight:600">&#128196; Export PDF</button>
  </div>
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

  <!-- ── INSIGHTS ─────────────────────────────────────────────────────────── -->
  <div class="insights">
    <h3>Automated Insights</h3>
    <ul>${insightsHtml}</ul>
  </div>

  <!-- ── PER-TEST-TYPE AGGREGATES ─────────────────────────────────────────── -->
  ${typeAgg.length > 1 ? `<h2>Per Test-Type Summary</h2><div class="type-agg">${typeAggHtml}</div>` : ''}

  <!-- ── TABS ─────────────────────────────────────────────────────────────── -->
  <div class="tab-bar">
    <button class="tab-btn active" onclick="showTab('t1',this)">Response Time</button>
    <button class="tab-btn"       onclick="showTab('t6',this)">Latency Distribution</button>
    <button class="tab-btn"       onclick="showTab('t7',this)">Throughput Timeline</button>
    <button class="tab-btn"       onclick="showTab('t8',this)">Network Breakdown</button>
    <button class="tab-btn"       onclick="showTab('t2',this)">All Scripts Table</button>
    <button class="tab-btn"       onclick="showTab('t3',this)">Script Details</button>
    <button class="tab-btn"       onclick="showTab('t4',this)">Baseline Comparison</button>
    <button class="tab-btn"       onclick="showTab('t5',this)">VU vs Latency Timeline</button>
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

  <!-- TAB 6: LATENCY DISTRIBUTION (p50/p90/p95/p99 per script) -->
  <div id="t6" class="tab-pane">
    <div class="chart-legend">
      <span><span class="legend-dot" style="background:#66bb6a"></span>p50</span>
      <span><span class="legend-dot" style="background:#26a69a"></span>p90</span>
      <span><span class="legend-dot" style="background:#1565c0"></span>p95</span>
      <span><span class="legend-dot" style="background:#ef5350"></span>p99</span>
      <span style="color:#555">Full percentile profile reveals tail latency spread.</span>
    </div>
    <div class="chart-wrap"><canvas id="distChart" height="80"></canvas></div>
    <h4>Average Latency vs Throughput</h4>
    <div class="chart-wrap"><canvas id="scatterChart" height="80"></canvas></div>
  </div>

  <!-- TAB 7: THROUGHPUT TIMELINE (RPS & p95 over time from NDJSON) -->
  <div id="t7" class="tab-pane">
    <p style="color:#555;margin-top:0">Requests-per-second and p95 latency bucketed per 5s window from the raw k6 NDJSON stream.</p>
    <div class="chart-wrap"><canvas id="rpsChart" height="70"></canvas></div>
    <h4>p95 Latency Over Time</h4>
    <div class="chart-wrap"><canvas id="p95TimeChart" height="70"></canvas></div>
    <div id="t7-empty" style="display:none;color:#888;text-align:center;padding:40px">No time-series data — re-run tests to capture raw NDJSON.</div>
  </div>

  <!-- TAB 8: NETWORK BREAKDOWN (stacked phase decomposition) -->
  <div id="t8" class="tab-pane">
    <p style="color:#555;margin-top:0">Average time (ms) spent in each HTTP request phase. High <strong>waiting</strong> usually indicates backend latency.</p>
    <div class="chart-wrap"><canvas id="netChart" height="80"></canvas></div>
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
        <tr><th>Script</th><th>Prev p95</th><th>Current p95</th><th>Delta</th><th>Tolerance</th><th>Trend</th><th>History</th><th>Status</th></tr>
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
    const P50_DATA   = ${p50Data};
    const P90_DATA   = ${p90Data};
    const AVG_DATA   = ${avgData};
    const THR_DATA   = ${throughputData};
    const NET_BLOCKED    = ${netBlocked};
    const NET_CONNECTING = ${netConnecting};
    const NET_TLS        = ${netTls};
    const NET_SENDING    = ${netSending};
    const NET_WAITING    = ${netWaiting};
    const NET_RECEIVING  = ${netReceiving};
    const TS_DATA    = ${timeSeriesData};
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

    // ── Tab 6: Latency Distribution (p50/p90/p95/p99 grouped bars) ───────────
    new Chart(document.getElementById('distChart'), {
      type: 'bar',
      data: {
        labels: LABELS,
        datasets: [
          { label: 'p50', data: P50_DATA, backgroundColor: '#66bb6a' },
          { label: 'p90', data: P90_DATA, backgroundColor: '#26a69a' },
          { label: 'p95', data: P95_DATA, backgroundColor: '#1565c0' },
          { label: 'p99', data: P99_DATA, backgroundColor: '#ef5350' },
          { label: 'SLA p95', data: Array(LABELS.length).fill(P95_SLA), type: 'line', borderColor: '#1565c0', borderDash: [6,3], pointRadius: 0, fill: false },
          { label: 'SLA p99', data: Array(LABELS.length).fill(P99_SLA), type: 'line', borderColor: '#ef5350', borderDash: [6,3], pointRadius: 0, fill: false },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' }, tooltip: { mode: 'index', intersect: false } },
        scales: { y: { beginAtZero: true, title: { display: true, text: 'Latency (ms)' } } }
      }
    });

    // Avg latency vs throughput scatter
    new Chart(document.getElementById('scatterChart'), {
      type: 'scatter',
      data: {
        datasets: LABELS.map((lbl, i) => ({
          label: lbl,
          data: [{ x: THR_DATA[i], y: AVG_DATA[i] }],
          backgroundColor: ERR_COLORS[i] || '#1565c0',
          pointRadius: 8, pointHoverRadius: 10,
        })),
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'bottom' }, tooltip: { callbacks: { label: (ctx) => ctx.dataset.label + ': ' + ctx.parsed.x + ' req/s @ ' + ctx.parsed.y + 'ms' } } },
        scales: {
          x: { title: { display: true, text: 'Throughput (req/s)' }, beginAtZero: true },
          y: { title: { display: true, text: 'Avg Latency (ms)' }, beginAtZero: true },
        },
      },
    });

    // ── Tab 7: Throughput Timeline (RPS & p95 over time from NDJSON) ─────────
    (function renderT7() {
      const haveTs = TS_DATA.filter(d => d.ts && d.ts.labels && d.ts.labels.length);
      if (!haveTs.length) {
        document.getElementById('t7-empty').style.display = 'block';
        return;
      }
      // Use longest series' labels as the x-axis
      const base = haveTs.reduce((a, b) => b.ts.labels.length > a.ts.labels.length ? b : a);
      const palette = ['#1565c0','#ef5350','#2e7d32','#e65100','#6a1b9a','#00838f'];
      const rpsDS = haveTs.map((d, i) => ({
        label: d.name + ' rps', data: d.ts.rps,
        borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length] + '33',
        tension: 0.3, fill: false, pointRadius: 0,
      }));
      new Chart(document.getElementById('rpsChart'), {
        type: 'line',
        data: { labels: base.ts.labels, datasets: rpsDS },
        options: {
          responsive: true, plugins: { legend: { position: 'top' } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'req/s' } }, x: { title: { display: true, text: 'Time' } } },
        },
      });
      const p95DS = haveTs.map((d, i) => ({
        label: d.name + ' p95', data: d.ts.p95,
        borderColor: palette[i % palette.length], backgroundColor: palette[i % palette.length] + '33',
        tension: 0.3, fill: false, pointRadius: 0,
      }));
      p95DS.push({ label: 'SLA p95', data: Array(base.ts.labels.length).fill(P95_SLA), borderColor: '#999', borderDash: [6,3], pointRadius: 0, fill: false });
      new Chart(document.getElementById('p95TimeChart'), {
        type: 'line',
        data: { labels: base.ts.labels, datasets: p95DS },
        options: {
          responsive: true, plugins: { legend: { position: 'top' } },
          scales: { y: { beginAtZero: true, title: { display: true, text: 'p95 (ms)' } }, x: { title: { display: true, text: 'Time' } } },
        },
      });
    })();

    // ── Tab 8: Network Breakdown (stacked bar) ───────────────────────────────
    new Chart(document.getElementById('netChart'), {
      type: 'bar',
      data: {
        labels: LABELS,
        datasets: [
          { label: 'blocked',    data: NET_BLOCKED,    backgroundColor: '#ce93d8' },
          { label: 'connecting', data: NET_CONNECTING, backgroundColor: '#90caf9' },
          { label: 'tls',        data: NET_TLS,        backgroundColor: '#80cbc4' },
          { label: 'sending',    data: NET_SENDING,    backgroundColor: '#ffe082' },
          { label: 'waiting',    data: NET_WAITING,    backgroundColor: '#ef9a9a' },
          { label: 'receiving',  data: NET_RECEIVING,  backgroundColor: '#a5d6a7' },
        ]
      },
      options: {
        responsive: true,
        plugins: { legend: { position: 'top' }, tooltip: { mode: 'index', intersect: false } },
        scales: { x: { stacked: true }, y: { stacked: true, beginAtZero: true, title: { display: true, text: 'ms' } } },
      },
    });

    // ── Tab 4: Sparklines ─────────────────────────────────────────────────────────
    const SPARK_DATA_EMBEDDED = ${JSON.stringify(sparkData)};
    function drawSparklines() {
      SPARK_DATA_EMBEDDED.forEach((sd, idx) => {
        const canvas = document.getElementById('spark_' + idx);
        if (!canvas || !sd.history || sd.history.length < 2) return;
        new Chart(canvas, {
          type: 'line',
          data: {
            labels: sd.history.map((_, i) => i + 1),
            datasets: [{ data: sd.history, borderColor: '#1565c0', borderWidth: 1.5, pointRadius: 0, fill: false, tension: 0.3 }],
          },
          options: {
            animation: false,
            plugins: { legend: { display: false }, tooltip: { enabled: false } },
            scales: { x: { display: false }, y: { display: false } },
          },
        });
      });
    }
    drawSparklines();

    // ── Tab 5: VU vs Latency Timeline ─────────────────────────────────────────────
    const TIMELINE_LABELS_EMBEDDED = ${JSON.stringify(timelineLabels)};
    const TIMELINE_P95_DS_EMBEDDED = ${JSON.stringify(timelineP95DS)};
    const TIMELINE_VU_DS_EMBEDDED  = ${JSON.stringify(timelineVuDS)};
    if (TIMELINE_LABELS_EMBEDDED.length === 0) {
      const emptyEl = document.getElementById('t5-empty');
      if (emptyEl) emptyEl.style.display = 'block';
    } else {
      new Chart(document.getElementById('vuLatencyChart'), {
        type: 'line',
        data: {
          labels: TIMELINE_LABELS_EMBEDDED,
          datasets: [
            ...TIMELINE_P95_DS_EMBEDDED,
            ...TIMELINE_VU_DS_EMBEDDED,
            { label: 'SLA p95', data: Array(TIMELINE_LABELS_EMBEDDED.length).fill(P95_SLA), borderColor: '#1565c0', borderDash: [6, 3], pointRadius: 0, fill: false, yAxisID: 'yLatency' },
          ],
        },
        options: {
          responsive: true,
          plugins: { legend: { position: 'top' } },
          scales: {
            yLatency: { type: 'linear', position: 'left',  title: { display: true, text: 'p95 (ms)' } },
            yVUs:     { type: 'linear', position: 'right', title: { display: true, text: 'VUs' }, grid: { drawOnChartArea: false } },
          },
        },
      });
    }
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
    // Only the raw k6 NDJSON output files are genuine inputs.
    // Exclude sibling artefacts that live in the same dir:
    //   *-summary.json    → k6 --summary-export output (read BY parsePerfResults, not fed to it)
    //   *-thresholds.json → threshold snapshot written by saveThresholdsForRun (metadata only)
    // Feeding those to parsePerfResults causes spurious "summary-export missing"
    // warnings and pollutes the report with empty rows.
    const files = fs.readdirSync(resultsDir).filter(f =>
      f.endsWith('.json') &&
      !f.endsWith('-summary.json') &&
      !f.endsWith('-thresholds.json')
    );
    for (const f of files) {
      const fp = path.join(resultsDir, f);
      try {
        const metrics  = parsePerfResults(fp);
        const { verdict, breaches } = evaluateThresholds(metrics, thresholds);
        const parts    = path.basename(f, '.json').split('_');
        const testType = parts[parts.length - 1] || 'load';
        const sk       = parts.slice(0, -1).join('_') || process.env.ISSUE_KEY || 'UNKNOWN';
        const baseline = compareToBaseline(`${sk}_${testType}`, metrics);
        // Build NDJSON-derived time-series for Throughput Timeline tab
        const timeseries = buildTimeSeries(fp);
        // Try to enrich with p50/p90 from k6 --summary-export sibling JSON
        let p50 = 0, p90 = 0;
        const sumPath = fp.replace(/\.json$/, '-summary.json');
        if (fs.existsSync(sumPath)) {
          try {
            const sx = JSON.parse(fs.readFileSync(sumPath, 'utf8'));
            const d = sx?.metrics?.http_req_duration?.values || sx?.metrics?.http_req_duration || {};
            p50 = +(d['p(50)'] ?? d.med ?? 0);
            p90 = +(d['p(90)'] ?? 0);
          } catch { /* ignore */ }
        }
        results.push({
          basename: path.basename(f, '.json'), testType, storyKey: sk,
          metrics: { ...metrics, p50, p90 }, verdict, breaches,
          timeseries, ...baseline,
        });
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
