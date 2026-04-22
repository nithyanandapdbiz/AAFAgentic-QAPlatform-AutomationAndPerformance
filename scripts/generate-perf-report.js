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
  pentest:     '#c2185b',
};

function typePill(t) {
  const bg = TYPE_COLOURS[t] || '#555';
  return `<span class="pill" style="background:${bg}22;color:${bg};border:1px solid ${bg}55">${t}</span>`;
}

function verdictBadge(v) {
  const cls = v === 'pass' ? 'badge-pass' : v === 'warn' ? 'badge-warn' : 'badge-fail';
  const icon = v === 'pass' ? '&#10003;' : v === 'warn' ? '&#9888;' : '&#10007;';
  const label = { pass:'PASS', warn:'WARN', fail:'FAIL' };
  return `<span class="badge ${cls}">${icon} ${label[v]||v.toUpperCase()}</span>`;
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
      const vCls  = verd === 'pass' ? 'c-pass' : verd === 'warn' ? 'c-warn' : 'c-fail';
      return `
        <div class="sla-card">
          ${verdictBadge(verd)}
          <div class="sla-name">${title}</div>
          <div class="sla-actual ${vCls}">${disp}</div>
          <div class="sla-limit">Limit: ${ldisp} &middot; ${pct}% of SLA</div>
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

    // ── Overview chart data (server-side) ────────────────────────────────────
    const typePeakP95Arr = testTypes.map(t => {
      const subset = rows.filter(r => r.testType === t);
      return subset.length ? Math.round(Math.max(...subset.map(r => r.p95))) : 0;
    });
    const typePeakP95Data = JSON.stringify(typePeakP95Arr);
    const typeColorData   = JSON.stringify(testTypes.map(t => TYPE_COLOURS[t] || '#888'));

    // â”€â”€ Sort rows: failâ†’warnâ†’pass â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const ORDER = { fail: 0, warn: 1, pass: 2 };
    const sortedRows = [...rows].sort((a, b) => ORDER[a.verdict] - ORDER[b.verdict]);

    // â”€â”€ Tab 2: All Scripts Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const tableRows = sortedRows.map(r => `
      <tr class="hover-row">
        <td>${r.name}</td>
        <td>${typePill(r.testType)}</td>
        <td class="${cellCls(r.p95, th.p95)}">${fmt(r.p95)}</td>
        <td class="${cellCls(r.p99, th.p99)}">${fmt(r.p99)}</td>
        <td>${fmt(r.avg)}</td>
        <td class="${cellCls(r.errorRate, th.errorRate)}">${(r.errorRate * 100).toFixed(2)}%</td>
        <td>${fmt(r.throughput, 1)}</td>
        <td>${fmt(r.vusMax)}</td>
        <td>${r.duration}</td>
        <td>${verdictBadge(r.verdict)}</td>
      </tr>`).join('');

    // Cell colour helper: green < 80 % of SLA, amber 80-99 %, red >= 100 %
    function cellCls(actual, limit) {
      if (!limit) return '';
      const pct = actual / limit;
      return pct >= 1 ? 'cell-fail' : pct >= 0.8 ? 'cell-warn' : 'cell-ok';
    }

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
  <link rel="preconnect" href="https://fonts.googleapis.com">
  <link href="https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,400;0,500;0,600;0,700;0,800;1,400&display=swap" rel="stylesheet">
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
  <style>
    /* ════════════════ DESIGN TOKENS ════════════════ */
    :root{
      --bg:#eef2f7; --surface:#ffffff; --surface-alt:#f7f9fc;
      --ink:#0f172a; --ink-soft:#475569; --ink-muted:#94a3b8;
      --border:#e2e8f0; --border-soft:#eef2f7;
      --brand:#4f46e5; --brand-2:#6366f1; --brand-soft:#eef2ff;
      --accent:#0ea5e9; --accent-soft:#e0f2fe;
      --ok:#059669; --ok-soft:#d1fae5;
      --warn:#d97706; --warn-soft:#fef3c7;
      --fail:#dc2626; --fail-soft:#fee2e2;
      --grad-hero:linear-gradient(135deg,#4f46e5 0%,#7c3aed 55%,#0ea5e9 100%);
      --shadow-sm:0 1px 2px rgba(15,23,42,.06),0 1px 3px rgba(15,23,42,.04);
      --shadow-md:0 4px 12px rgba(15,23,42,.08),0 2px 4px rgba(15,23,42,.04);
      --shadow-lg:0 10px 25px rgba(15,23,42,.10),0 4px 10px rgba(15,23,42,.05);
      --radius:12px; --radius-sm:8px;
    }
    [data-theme="dark"]{
      --bg:#0b1220; --surface:#111a2e; --surface-alt:#0f1729;
      --ink:#e6edf6; --ink-soft:#94a3b8; --ink-muted:#64748b;
      --border:#1e293b; --border-soft:#172033;
      --brand:#818cf8; --brand-2:#a78bfa; --brand-soft:#1e1b4b;
      --accent:#38bdf8; --accent-soft:#0c4a6e;
      --ok:#34d399; --ok-soft:#064e3b;
      --warn:#fbbf24; --warn-soft:#78350f;
      --fail:#f87171; --fail-soft:#7f1d1d;
    }
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;margin:0;padding:0;background:var(--bg);color:var(--ink);font-size:14px;line-height:1.55;-webkit-font-smoothing:antialiased}
    .wrap{max-width:1400px;margin:0 auto;padding:0 28px 40px}
    h1{font-size:1.9rem;margin:0 0 4px;font-weight:700;letter-spacing:-.02em}
    h2{font-size:.85rem;margin:32px 0 14px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.12em;font-weight:700;display:flex;align-items:center;gap:10px}
    h2::before{content:"";width:4px;height:16px;background:var(--grad-hero);border-radius:2px}
    h3{font-size:1rem;margin:0 0 10px;font-weight:600}
    h4{font-size:.8rem;margin:14px 0 6px;color:var(--ink-soft);text-transform:uppercase;letter-spacing:.08em;font-weight:600}

    /* ════════════════ HERO ════════════════ */
    .hero{background:var(--grad-hero);color:#fff;padding:36px 28px 80px;position:relative;overflow:hidden}
    .hero::before{content:"";position:absolute;inset:0;background:radial-gradient(circle at 80% 20%,rgba(255,255,255,.15),transparent 50%),radial-gradient(circle at 20% 80%,rgba(255,255,255,.08),transparent 50%);pointer-events:none}
    .hero-inner{max-width:1400px;margin:0 auto;position:relative}
    .hero h1{color:#fff}
    .hero-meta{color:rgba(255,255,255,.82);font-size:.88rem;margin-top:6px;display:flex;gap:18px;flex-wrap:wrap}
    .hero-meta strong{color:#fff;font-weight:600}
    .hero-actions{display:flex;gap:10px;align-items:center}
    .btn{background:rgba(255,255,255,.14);color:#fff;border:1px solid rgba(255,255,255,.25);border-radius:8px;padding:8px 16px;cursor:pointer;font-size:.85rem;font-weight:600;transition:all .15s;backdrop-filter:blur(8px);display:inline-flex;align-items:center;gap:6px}
    .btn:hover{background:rgba(255,255,255,.24);transform:translateY(-1px)}
    .btn-icon{width:34px;height:34px;padding:0;justify-content:center;font-size:1rem}
    .hero-top{display:flex;justify-content:space-between;align-items:flex-start;flex-wrap:wrap;gap:16px}
    .hero-badges{display:flex;gap:8px;margin-top:18px;flex-wrap:wrap}
    .hero-badge{background:rgba(255,255,255,.18);padding:5px 12px;border-radius:999px;font-size:.78em;font-weight:600;backdrop-filter:blur(8px);display:inline-flex;align-items:center;gap:6px}
    .hero-badge.pass{background:rgba(5,150,105,.85)}
    .hero-badge.warn{background:rgba(217,119,6,.90)}
    .hero-badge.fail{background:rgba(220,38,38,.90)}
    .hero-badge.neutral{border:1px solid rgba(255,255,255,.3)}
    .hero-dot{width:6px;height:6px;border-radius:50%;background:#fff;box-shadow:0 0 0 3px rgba(255,255,255,.2)}

    /* ════════════════ CONTENT AREA (pulled up into hero) ════════════════ */
    .content{margin-top:-60px;position:relative;z-index:2}

    /* ════════════════ KPI CARDS ════════════════ */
    .kpi-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(180px,1fr));gap:14px;margin-bottom:28px}
    .kpi{background:var(--surface);border-radius:var(--radius);padding:18px 20px;box-shadow:var(--shadow-md);border:1px solid var(--border-soft);position:relative;overflow:hidden;transition:transform .15s,box-shadow .15s}
    .kpi:hover{transform:translateY(-2px);box-shadow:var(--shadow-lg)}
    .kpi::after{content:"";position:absolute;left:0;top:0;bottom:0;width:3px;background:var(--brand)}
    .kpi.pass::after{background:var(--ok)}.kpi.warn::after{background:var(--warn)}.kpi.fail::after{background:var(--fail)}.kpi.info::after{background:var(--accent)}
    .kpi-label{font-size:.72rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-muted);font-weight:600;display:flex;align-items:center;gap:6px}
    .kpi-val{font-size:1.9rem;font-weight:700;letter-spacing:-.02em;margin-top:6px;line-height:1}
    .kpi-sub{font-size:.78rem;color:var(--ink-soft);margin-top:4px}
    .kpi-ico{font-size:.9rem;opacity:.7}

    /* ════════════════ SLA CARDS ════════════════ */
    .sla-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:28px}
    .sla-card{background:var(--surface);border-radius:var(--radius);padding:16px 20px;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);transition:box-shadow .15s}
    .sla-card:hover{box-shadow:var(--shadow-md)}
    .sla-name{font-size:.72rem;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.1em;font-weight:600;margin:8px 0 2px}
    .sla-actual{font-size:1.35rem;font-weight:700;letter-spacing:-.01em}
    .sla-limit{font-size:.75rem;color:var(--ink-soft);margin-top:2px}
    .sla-bar-bg{background:var(--border-soft);border-radius:999px;height:6px;margin-top:10px;overflow:hidden}
    .sla-bar-fill{height:100%;border-radius:999px;transition:width .6s cubic-bezier(.4,0,.2,1);background:linear-gradient(90deg,var(--brand),var(--brand-2))}

    /* ════════════════ BADGES ════════════════ */
    .badge{display:inline-flex;align-items:center;gap:5px;padding:3px 10px;border-radius:999px;font-size:.72em;font-weight:700;text-transform:uppercase;letter-spacing:.05em;border:1px solid transparent}
    .badge-pass{background:var(--ok-soft);color:var(--ok);border-color:var(--ok)}
    .badge-warn{background:var(--warn-soft);color:var(--warn);border-color:var(--warn)}
    .badge-fail{background:var(--fail-soft);color:var(--fail);border-color:var(--fail)}
    .pill{display:inline-flex;align-items:center;padding:2px 10px;border-radius:999px;font-size:.72em;font-weight:600;letter-spacing:.03em}

    /* ════════════════ TABLE UTILITIES ════════════════ */
    .cell-ok{color:var(--ok);font-weight:700}.cell-warn{color:var(--warn);font-weight:700}.cell-fail{color:var(--fail);font-weight:700}
    .tbl-toolbar{display:flex;justify-content:space-between;align-items:center;gap:10px;margin-bottom:12px;flex-wrap:wrap}
    .tbl-search{flex:1;min-width:200px;max-width:400px;padding:8px 14px;border:1px solid var(--border);border-radius:var(--radius-sm);background:var(--surface-alt);color:var(--ink);font-size:.85rem;font-family:inherit;outline:none;transition:border-color .15s,box-shadow .15s}
    .tbl-search:focus{border-color:var(--brand);box-shadow:0 0 0 3px rgba(79,70,229,.12)}
    .btn-sm{background:var(--surface-alt);color:var(--ink-soft);border:1px solid var(--border);border-radius:var(--radius-sm);padding:7px 14px;cursor:pointer;font-size:.8rem;font-weight:600;transition:all .15s;font-family:inherit;display:inline-flex;align-items:center;gap:6px;white-space:nowrap}
    .btn-sm:hover{background:var(--brand-soft);color:var(--brand);border-color:var(--brand)}
    th.sortable{cursor:pointer;user-select:none;position:relative;padding-right:24px}
    th.sortable::after{content:"\\2195";position:absolute;right:8px;opacity:.35;font-size:.8em}
    th.sort-asc::after{content:"\\2191";opacity:1;color:var(--brand)}
    th.sort-desc::after{content:"\\2193";opacity:1;color:var(--brand)}

    /* ════════════════ OVERVIEW RING ════════════════ */
    .overview-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(280px,1fr));gap:20px;margin-bottom:24px}
    .ov-card{background:var(--surface);border-radius:var(--radius);padding:20px 24px;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft)}
    .ov-card h3{margin:0 0 14px;font-size:.82rem;text-transform:uppercase;letter-spacing:.1em;color:var(--ink-soft);font-weight:700}

    /* ════════════════ TABS ════════════════ */
    .tab-bar{display:flex;gap:4px;background:var(--surface);padding:6px;border-radius:var(--radius);box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);margin-bottom:20px;overflow-x:auto;flex-wrap:wrap;position:sticky;top:0;z-index:100;backdrop-filter:blur(14px);-webkit-backdrop-filter:blur(14px)}
    .tab-btn{padding:9px 16px;cursor:pointer;border:none;background:transparent;font-size:.82rem;color:var(--ink-soft);border-radius:8px;font-weight:600;transition:all .15s;white-space:nowrap;font-family:inherit}
    .tab-btn.active{background:var(--grad-hero);color:#fff;box-shadow:0 2px 6px rgba(79,70,229,.35)}
    .tab-btn:hover:not(.active){background:var(--surface-alt);color:var(--ink)}
    .tab-pane{display:none;animation:fadeIn .25s ease}
    .tab-pane.active{display:block}
    @keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:none}}

    /* ════════════════ TABLES ════════════════ */
    table{border-collapse:separate;border-spacing:0;width:100%;background:var(--surface);border-radius:var(--radius);overflow:hidden;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);margin-bottom:20px}
    th{background:var(--surface-alt);color:var(--ink-soft);padding:11px 14px;text-align:left;font-size:.72rem;text-transform:uppercase;letter-spacing:.08em;font-weight:700;border-bottom:1px solid var(--border)}
    td{padding:11px 14px;border-bottom:1px solid var(--border-soft);font-size:.86rem;vertical-align:middle;color:var(--ink)}
    tr:last-child td{border-bottom:none}
    tbody tr{transition:background .12s}
    .hover-row:hover td{background:var(--surface-alt)}
    table.inner{box-shadow:none;border:1px solid var(--border-soft);border-radius:var(--radius-sm)}

    /* ════════════════ DETAIL CARDS ════════════════ */
    .detail-card{background:var(--surface);border-radius:var(--radius);box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);padding:16px 20px;margin-bottom:12px;transition:box-shadow .15s}
    .detail-card:hover{box-shadow:var(--shadow-md)}
    .detail-card summary{cursor:pointer;user-select:none;outline:none;display:flex;align-items:center;gap:10px;flex-wrap:wrap;font-weight:600;list-style:none}
    .detail-card summary::-webkit-details-marker{display:none}
    .detail-card summary .chevron{margin-left:auto;transition:transform .2s;color:var(--ink-muted)}
    .detail-card[open] summary .chevron{transform:rotate(180deg)}
    .detail-body{padding-top:14px;margin-top:12px;border-top:1px solid var(--border-soft)}
    .stat-grid{display:grid;grid-template-columns:repeat(auto-fit,minmax(130px,1fr));gap:10px;margin:14px 0}
    .stat-cell{background:var(--surface-alt);border-radius:var(--radius-sm);padding:10px 14px;border:1px solid var(--border-soft)}
    .stat-label{display:block;font-size:.7rem;color:var(--ink-muted);text-transform:uppercase;letter-spacing:.08em;font-weight:600;margin-bottom:4px}
    .stat-val{font-size:1.1rem;font-weight:700;color:var(--ink);letter-spacing:-.01em}
    .breach-alert{background:var(--fail-soft);border-left:3px solid var(--fail);padding:12px 16px;border-radius:var(--radius-sm);margin-bottom:12px;color:var(--ink)}
    .breach-alert ul{margin:6px 0 0 18px;padding:0;font-size:.85rem}

    /* ════════════════ CHART WRAPPER ════════════════ */
    .chart-wrap{background:var(--surface);border-radius:var(--radius);padding:22px;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);margin-bottom:20px;transition:box-shadow .15s}
    .chart-wrap:hover{box-shadow:var(--shadow-md)}
    .chart-legend{display:flex;gap:18px;margin-bottom:12px;flex-wrap:wrap;font-size:.82rem;color:var(--ink-soft)}
    .legend-dot{width:10px;height:10px;border-radius:3px;display:inline-block;margin-right:6px;vertical-align:middle}

    /* ════════════════ INSIGHTS ════════════════ */
    .insights{background:var(--surface);border-radius:var(--radius);padding:18px 22px;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);margin:0 0 28px;position:relative;overflow:hidden}
    .insights::before{content:"";position:absolute;left:0;top:0;bottom:0;width:4px;background:var(--grad-hero)}
    .insights h3{margin:0 0 12px;font-size:.82rem;color:var(--ink-soft);letter-spacing:.1em;text-transform:uppercase;display:flex;align-items:center;gap:8px}
    .insights ul{list-style:none;padding:0;margin:0}
    .insights li{padding:9px 0;font-size:.88rem;display:flex;align-items:flex-start;gap:12px;border-bottom:1px dashed var(--border-soft);color:var(--ink)}
    .insights li:last-child{border-bottom:none}
    .insights .ins-ico{font-weight:700;width:22px;height:22px;border-radius:50%;flex:none;text-align:center;display:inline-flex;align-items:center;justify-content:center;font-size:.78rem}
    .ins-fail .ins-ico{color:var(--fail);background:var(--fail-soft)}
    .ins-warn .ins-ico{color:var(--warn);background:var(--warn-soft)}
    .ins-pass .ins-ico{color:var(--ok);background:var(--ok-soft)}

    /* ════════════════ TYPE AGGREGATE CARDS ════════════════ */
    .type-agg{display:grid;grid-template-columns:repeat(auto-fit,minmax(240px,1fr));gap:14px;margin-bottom:28px}
    .type-card{background:var(--surface);border-radius:var(--radius);padding:16px 18px;box-shadow:var(--shadow-sm);border:1px solid var(--border-soft);position:relative;overflow:hidden;transition:transform .15s,box-shadow .15s}
    .type-card:hover{transform:translateY(-2px);box-shadow:var(--shadow-md)}
    .type-card::before{content:"";position:absolute;top:0;left:0;right:0;height:3px;background:var(--brand)}
    .type-card.type-pass::before{background:var(--ok)}
    .type-card.type-warn::before{background:var(--warn)}
    .type-card.type-fail::before{background:var(--fail)}
    .type-head{display:flex;justify-content:space-between;align-items:center;margin-bottom:12px;font-size:.82rem;padding-top:4px}
    .type-count{color:var(--ink-muted);font-weight:600;font-size:.75rem}
    .type-metrics{display:grid;grid-template-columns:repeat(2,1fr);gap:8px 14px;font-size:.8rem}
    .type-metrics>div{display:flex;justify-content:space-between;padding:4px 0;border-bottom:1px dotted var(--border-soft)}
    .type-metrics span{color:var(--ink-muted);font-size:.74rem}
    .type-metrics strong{color:var(--ink);font-weight:700;font-size:.88rem}

    /* ════════════════ FOOTER ════════════════ */
    footer{margin-top:40px;padding:20px 0;border-top:1px solid var(--border);font-size:.78rem;color:var(--ink-muted);display:flex;gap:20px;flex-wrap:wrap;align-items:center}
    footer a{color:var(--brand);text-decoration:none;font-weight:600}
    footer a:hover{text-decoration:underline}

    /* Colour helpers */
    .c-pass{color:var(--ok)}.c-warn{color:var(--warn)}.c-fail{color:var(--fail)}.c-brand{color:var(--brand)}

    /* Responsive */
    @media(max-width:700px){
      .wrap{padding:0 16px 32px}.hero{padding:24px 16px 70px}
      .kpi-grid{grid-template-columns:repeat(2,1fr)}
      h1{font-size:1.4rem}
    }
    @media print{
      body{background:#fff}.hero{background:#1e293b!important;-webkit-print-color-adjust:exact;print-color-adjust:exact;padding:20px}
      .tab-bar,.tab-btn,.hero-actions{display:none!important}
      .tab-pane{display:block!important;page-break-inside:avoid;margin-bottom:20px}
      .detail-card[open] .detail-body{display:block!important}
      .chart-wrap,.kpi,.sla-card,.type-card,.insights,.detail-card{break-inside:avoid;box-shadow:none;border:1px solid #e2e8f0}
      footer a{color:#000!important}
    }
  </style>
</head>
<body>
  <!-- ══ HERO ══════════════════════════════════════════════════════════════ -->
  <div class="hero">
    <div class="hero-inner">
      <div class="hero-top">
        <div>
          <h1>Performance Test Report</h1>
          <div class="hero-meta">
            <span>Story <strong>${storyKey}</strong></span>
            <span>Run <strong>${generated}</strong></span>
            <span>Scripts <strong>${rows.length}</strong></span>
            <span>Requests <strong>${totalReqs.toLocaleString()}</strong></span>
          </div>
        </div>
        <div class="hero-actions">
          <button class="btn btn-icon" onclick="toggleTheme()" title="Toggle dark mode" aria-label="Toggle theme">&#9681;</button>
          <button class="btn" onclick="window.print()" title="Export as PDF">&#x2B73; Export PDF</button>
        </div>
      </div>
      <div class="hero-badges">
        <span class="hero-badge ${overall === 'pass' ? 'pass' : overall === 'warn' ? 'warn' : 'fail'}"><span class="hero-dot"></span>Overall ${overall.toUpperCase()}</span>
        <span class="hero-badge pass">&#10003; ${passCount} Pass</span>
        <span class="hero-badge warn">&#9888; ${warnCount} Warn</span>
        <span class="hero-badge fail">&#10007; ${failCount} Fail</span>
        ${baseReg ? '<span class="hero-badge warn">&#x21B1; Baseline regression</span>' : '<span class="hero-badge neutral">&#10003; Baseline stable</span>'}
      </div>
    </div>
  </div>

  <div class="wrap content">
  <!-- â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->

  <!-- ══ KPI GRID ══════════════════════════════════════════════════════════ -->
  <div class="kpi-grid">
    <div class="kpi info">
      <div class="kpi-label"><span class="kpi-ico">&#9729;</span>Scripts</div>
      <div class="kpi-val">${rows.length}</div>
      <div class="kpi-sub">${testTypes.length} test type${testTypes.length === 1 ? '' : 's'}</div>
    </div>
    <div class="kpi pass">
      <div class="kpi-label"><span class="kpi-ico">&#10003;</span>Pass</div>
      <div class="kpi-val c-pass">${passCount}</div>
      <div class="kpi-sub">${Math.round(passCount / Math.max(rows.length, 1) * 100)}% of runs</div>
    </div>
    <div class="kpi warn">
      <div class="kpi-label"><span class="kpi-ico">&#9888;</span>Warn</div>
      <div class="kpi-val c-warn">${warnCount}</div>
      <div class="kpi-sub">near-threshold</div>
    </div>
    <div class="kpi fail">
      <div class="kpi-label"><span class="kpi-ico">&#10007;</span>Fail</div>
      <div class="kpi-val c-fail">${failCount}</div>
      <div class="kpi-sub">SLA breach</div>
    </div>
    <div class="kpi info">
      <div class="kpi-label"><span class="kpi-ico">&#8634;</span>Total Requests</div>
      <div class="kpi-val c-brand">${totalReqs.toLocaleString()}</div>
      <div class="kpi-sub">${bestTput.toFixed(1)} req/s peak</div>
    </div>
    <div class="kpi info">
      <div class="kpi-label"><span class="kpi-ico">&#9201;</span>Worst p99</div>
      <div class="kpi-val ${worstP99 > th.p99 ? 'c-fail' : worstP99 > th.p99 * 0.9 ? 'c-warn' : 'c-pass'}">${Math.round(worstP99)}<span style="font-size:.6em;font-weight:500;color:var(--ink-muted)">ms</span></div>
      <div class="kpi-sub">SLA ${th.p99}ms</div>
    </div>
    <div class="kpi info">
      <div class="kpi-label"><span class="kpi-ico">&#9774;</span>Peak VUs</div>
      <div class="kpi-val c-brand">${maxVus}</div>
      <div class="kpi-sub">concurrent users</div>
    </div>
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
      <div class="sla-actual ${baseReg ? 'c-warn' : 'c-pass'}">${baseReg ? 'DETECTED' : 'NONE'}</div>
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
    <button class="tab-btn" onclick="showTab('t0',this)">&#128200; Overview</button>
    <button class="tab-btn active" onclick="showTab('t1',this)">Response Time</button>
    <button class="tab-btn"       onclick="showTab('t6',this)">Latency Distribution</button>
    <button class="tab-btn"       onclick="showTab('t7',this)">Throughput Timeline</button>
    <button class="tab-btn"       onclick="showTab('t8',this)">Network Breakdown</button>
    <button class="tab-btn"       onclick="showTab('t2',this)">All Scripts ${failCount > 0 ? `<span style="background:var(--fail);color:#fff;border-radius:999px;font-size:.65em;padding:1px 6px;margin-left:4px">${failCount}</span>` : ''}</button>
    <button class="tab-btn"       onclick="showTab('t3',this)">Script Details</button>
    <button class="tab-btn"       onclick="showTab('t4',this)">Baseline Comparison</button>
    <button class="tab-btn"       onclick="showTab('t5',this)">VU vs Latency</button>
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
    <div class="tbl-toolbar">
      <input type="search" class="tbl-search" id="tblSearch" placeholder="&#128269;  Filter by script name or type…" oninput="filterTable(this.value)">
      <div style="display:flex;gap:8px">
        <button class="btn-sm" onclick="exportTableCSV()">&#8659; Export CSV</button>
        <button class="btn-sm" onclick="clearFilter()">&#215; Clear</button>
      </div>
    </div>
    <table id="scriptsTable">
      <thead>
        <tr>
          <th class="sortable" onclick="sortByCol(0)">Script name</th>
          <th class="sortable" onclick="sortByCol(1)">Type</th>
          <th class="sortable" onclick="sortByCol(2)">p95 ms</th>
          <th class="sortable" onclick="sortByCol(3)">p99 ms</th>
          <th class="sortable" onclick="sortByCol(4)">Avg ms</th>
          <th class="sortable" onclick="sortByCol(5)">Error %</th>
          <th class="sortable" onclick="sortByCol(6)">Req/s</th>
          <th class="sortable" onclick="sortByCol(7)">VUs</th>
          <th class="sortable" onclick="sortByCol(8)">Duration</th>
          <th>Verdict</th>
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
  <!-- TAB 5: VU vs LATENCY TIMELINE -->
  <div id="t5" class="tab-pane">
    <p style="color:var(--ink-soft);margin-top:0;font-size:.88rem">Dual-axis chart: left Y-axis = p95 latency (ms), right Y-axis = virtual users. Reads time-series CSV files from <code style="background:var(--surface-alt);padding:2px 6px;border-radius:4px">test-results/perf/</code>.</p>
    <div id="t5-empty" style="display:none;background:var(--surface-alt);border:1px dashed var(--border);border-radius:var(--radius);padding:40px;text-align:center;color:var(--ink-muted)">
      No timeseries CSV files found in <code>test-results/perf/</code>. Re-run tests to generate them.
    </div>
    <div class="chart-wrap"><canvas id="vuLatencyChart" height="90"></canvas></div>
    <p style="font-size:.8rem;color:var(--ink-muted);margin-top:-8px">SLA p95 shown as a blue dashed annotation line.</p>
  </div>

  <!-- TAB 0: OVERVIEW SUMMARY -->
  <div id="t0" class="tab-pane">
    <div class="overview-grid">
      <div class="ov-card">
        <h3>Result Distribution</h3>
        <div style="max-width:280px;margin:0 auto"><canvas id="overviewDonut" height="180"></canvas></div>
        <div style="display:flex;gap:16px;justify-content:center;margin-top:14px;font-size:.82rem;flex-wrap:wrap">
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#059669;margin-right:5px"></span>${passCount} Pass</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#d97706;margin-right:5px"></span>${warnCount} Warn</span>
          <span><span style="display:inline-block;width:10px;height:10px;border-radius:50%;background:#dc2626;margin-right:5px"></span>${failCount} Fail</span>
        </div>
      </div>
      <div class="ov-card">
        <h3>Peak p95 by Test Type</h3>
        <canvas id="overviewTypeBar" height="180"></canvas>
      </div>
      <div class="ov-card">
        <h3>Key Metrics at a Glance</h3>
        <div style="display:grid;row-gap:10px;font-size:.85rem">
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Total scripts run</span><strong>${rows.length}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Total HTTP requests</span><strong>${totalReqs.toLocaleString()}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Worst p95</span>
            <strong class="${worstP95 > th.p95 ? 'c-fail' : worstP95 > th.p95 * 0.9 ? 'c-warn' : 'c-pass'}">${Math.round(worstP95)} ms</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Worst p99</span>
            <strong class="${worstP99 > th.p99 ? 'c-fail' : worstP99 > th.p99 * 0.9 ? 'c-warn' : 'c-pass'}">${Math.round(worstP99)} ms</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Worst error rate</span>
            <strong class="${worstErr > th.errorRate ? 'c-fail' : worstErr > th.errorRate * 0.9 ? 'c-warn' : 'c-pass'}">${(worstErr * 100).toFixed(2)}%</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0;border-bottom:1px dashed var(--border-soft)">
            <span style="color:var(--ink-muted)">Peak VUs</span><strong>${maxVus}</strong>
          </div>
          <div style="display:flex;justify-content:space-between;padding:8px 0">
            <span style="color:var(--ink-muted)">Baseline regression</span>
            <strong class="${baseReg ? 'c-warn' : 'c-pass'}">${baseReg ? 'DETECTED' : 'None'}</strong>
          </div>
        </div>
      </div>
    </div>
    ${typeAgg.length > 0 ? '<h2>Per Test-Type Summary</h2><div class="type-agg">' + typeAggHtml + '</div>' : ''}
  </div>

  <footer>
    ${jiraUrl && storyKey !== 'N/A' ? `<a href="${jiraUrl}/browse/${storyKey}" target="_blank">&#128279; Jira Story</a>` : ''}
    ${zephyrUrl ? `<a href="${zephyrUrl}" target="_blank">&#128279; Zephyr Cycle</a>` : ''}
    <span>&#128336; ${generated}</span>
    <span style="margin-left:auto">Generated by <strong>Agentic QA Platform</strong></span>
  </footer>
  </div><!-- /.wrap -->

  <script>
    // ── Theme toggle (persists in localStorage) ─────────────────────────────
    (function initTheme(){
      try { const t = localStorage.getItem('perfReportTheme'); if (t) document.documentElement.setAttribute('data-theme', t); } catch(_) {}
    })();
    function toggleTheme(){
      const cur = document.documentElement.getAttribute('data-theme') === 'dark' ? '' : 'dark';
      if (cur) document.documentElement.setAttribute('data-theme', cur); else document.documentElement.removeAttribute('data-theme');
      try { localStorage.setItem('perfReportTheme', cur); } catch(_) {}
    }
    // ── Chart.js global defaults (theme-aware) ──────────────────────────────
    (function(){
      const dark = document.documentElement.getAttribute('data-theme') === 'dark';
      Chart.defaults.font.family = "'Inter',-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif";
      Chart.defaults.font.size = 11;
      Chart.defaults.color = dark ? '#94a3b8' : '#475569';
      Chart.defaults.borderColor = dark ? '#1e293b' : '#e2e8f0';
      Chart.defaults.plugins.legend.labels.boxWidth = 12;
      Chart.defaults.plugins.legend.labels.boxHeight = 12;
      Chart.defaults.plugins.legend.labels.usePointStyle = true;
      Chart.defaults.plugins.tooltip.backgroundColor = dark ? '#0f172a' : '#1e293b';
      Chart.defaults.plugins.tooltip.padding = 10;
      Chart.defaults.plugins.tooltip.cornerRadius = 6;
      Chart.defaults.plugins.tooltip.titleFont = { weight: '600' };
      Chart.defaults.elements.bar.borderRadius = 4;
      Chart.defaults.elements.line.borderWidth = 2;
    })();
    // ── Tab switching ──────────────────────────────────────────────────────
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
    const PASS_COUNT    = ${passCount};
    const WARN_COUNT    = ${warnCount};
    const FAIL_COUNT    = ${failCount};
    const TEST_TYPES    = ${JSON.stringify(testTypes)};
    const TYPE_PEAK_P95 = ${typePeakP95Data};
    const TYPE_COLORS   = ${typeColorData};

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

    // Overview Tab: Donut + Type Bar
    (function drawOverview() {
      var donutEl = document.getElementById('overviewDonut');
      if (donutEl) {
        new Chart(donutEl, {
          type: 'doughnut',
          data: {
            labels: ['Pass', 'Warn', 'Fail'],
            datasets: [{ data: [PASS_COUNT, WARN_COUNT, FAIL_COUNT],
              backgroundColor: ['#059669','#d97706','#dc2626'],
              borderWidth: 3, hoverOffset: 8 }]
          },
          options: { responsive: true, cutout: '68%',
            plugins: { legend: { position: 'bottom' },
              tooltip: { callbacks: { label: function(ctx) {
                return ctx.label + ': ' + ctx.parsed + ' script' + (ctx.parsed !== 1 ? 's' : '');
              }}}}}
        });
      }
      var typeBarEl = document.getElementById('overviewTypeBar');
      if (typeBarEl) {
        new Chart(typeBarEl, {
          type: 'bar',
          data: { labels: TEST_TYPES,
            datasets: [{ label: 'Peak p95 (ms)', data: TYPE_PEAK_P95,
              backgroundColor: TYPE_COLORS, borderRadius: 6 }]
          },
          options: { indexAxis: 'y', responsive: true,
            plugins: { legend: { display: false } },
            scales: { x: { beginAtZero: true, title: { display: true, text: 'p95 (ms)' }}}},
        });
      }
    })();

    // Table search / filter
    function filterTable(val) {
      var rows = document.querySelectorAll('#scriptsTable tbody tr');
      var q = val.toLowerCase();
      rows.forEach(function(r) { r.style.display = r.textContent.toLowerCase().includes(q) ? '' : 'none'; });
    }
    function clearFilter() {
      var el = document.getElementById('tblSearch');
      if (el) { el.value = ''; filterTable(''); }
    }

    // Table sort
    var _sortState = { col: -1, asc: true };
    function sortByCol(colIdx) {
      var table = document.getElementById('scriptsTable');
      if (!table) return;
      var tbody = table.querySelector('tbody');
      var rows = Array.from(tbody.querySelectorAll('tr'));
      var asc = _sortState.col === colIdx ? !_sortState.asc : true;
      _sortState = { col: colIdx, asc: asc };
      rows.sort(function(a, b) {
        var av = a.cells[colIdx] ? a.cells[colIdx].textContent.trim() : '';
        var bv = b.cells[colIdx] ? b.cells[colIdx].textContent.trim() : '';
        var an = parseFloat(av.replace(/[^0-9.-]/g,'')); var bn = parseFloat(bv.replace(/[^0-9.-]/g,''));
        if (!isNaN(an) && !isNaN(bn)) return asc ? an - bn : bn - an;
        return asc ? av.localeCompare(bv) : bv.localeCompare(av);
      });
      rows.forEach(function(r) { tbody.appendChild(r); });
      table.querySelectorAll('th').forEach(function(th, i) {
        th.classList.toggle('sort-asc', i === colIdx && asc);
        th.classList.toggle('sort-desc', i === colIdx && !asc);
      });
    }

    // CSV Export
    function exportTableCSV() {
      var headers = ['Script','Type','p95 ms','p99 ms','Avg ms','Error %','Req/s','VUs','Duration','Verdict'];
      var rows = Array.from(document.querySelectorAll('#scriptsTable tbody tr'))
        .filter(function(r) { return r.style.display !== 'none'; })
        .map(function(r) {
          return Array.from(r.cells).map(function(c) {
            return '"' + c.textContent.trim().replace(/"/g,'""') + '"';
          }).join(',');
        });
      var csv = [headers.join(',')].concat(rows).join('\\n');
      var blob = new Blob([csv], { type: 'text/csv' });
      var a = document.createElement('a'); a.href = URL.createObjectURL(blob);
      a.download = 'perf-results.csv'; a.click(); URL.revokeObjectURL(a.href);
    }

    // KPI counter animation
    (function animateCounters() {
      document.querySelectorAll('.kpi-val').forEach(function(el) {
        var text = el.textContent.trim();
        var m = text.match(/^([0-9,]+)(\D*.*)$/);
        if (!m) return;
        var target = parseInt(m[1].replace(/,/g,''), 10);
        var suffix = m[2] || '';
        if (isNaN(target) || target < 2) return;
        var startTime = null; var duration = 900;
        var animate = function(ts) {
          if (!startTime) startTime = ts;
          var p = Math.min((ts - startTime) / duration, 1);
          var e = 1 - Math.pow(1 - p, 3);
          el.textContent = Math.round(e * target).toLocaleString() + suffix;
          if (p < 1) requestAnimationFrame(animate);
        };
        requestAnimationFrame(animate);
      });
    })();

    // Tab 5: VU vs Latency Timeline ─────────────────────────────────────────────
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
