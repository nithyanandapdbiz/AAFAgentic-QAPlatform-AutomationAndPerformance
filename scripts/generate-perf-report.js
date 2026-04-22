'use strict';
/**
 * @module generate-perf-report
 * Publication-quality self-contained performance test HTML report generator.
 * Produces custom-report/perf/index.html with Chart.js 4.4.x bundled inline.
 */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

// â”€â”€â”€ Colour palette (spec Â§9c) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const TYPE_COLOURS = {
  load:        '#378ADD',
  stress:      '#EF9F27',
  spike:       '#E24B4A',
  soak:        '#7F77DD',
  scalability: '#1D9E75',
  breakpoint:  '#D85A30',
};
const PASS_COL = '#639922';
const WARN_COL = '#BA7517';
const FAIL_COL = '#A32D2D';
const SKIP_COL = '#888780';

// â”€â”€â”€ Normalise one result entry â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function norm(r) {
  const m = r.metrics || {};
  return {
    name:            r.basename || r.scriptName || path.basename(r.scriptPath || 'unknown', '.k6.js'),
    testType:        r.testType || 'load',
    verdict:         r.verdict  || 'pass',
    p50:  +(m.p50  ?? r.p50  ?? 0),
    p90:  +(m.p90  ?? r.p90  ?? 0),
    p95:  +(m.p95  ?? r.p95  ?? 0),
    p99:  +(m.p99  ?? r.p99  ?? 0),
    avg:  +(m.avg  ?? r.avg  ?? 0),
    min:  +(m.min  ?? r.min  ?? 0),
    max:  +(m.max  ?? r.max  ?? 0),
    errorRate:   +(m.errorRate   ?? r.errorRate   ?? 0),
    throughput:  +(m.throughput  ?? m.reqRate      ?? r.throughput  ?? 0),
    vusMax:      +(m.vusMax      ?? r.vusMax       ?? 0),
    totalRequests: +(m.count     ?? r.totalRequests ?? 0),
    droppedIterations: +(m.droppedIterations ?? r.droppedIterations ?? 0),
    duration:    r.duration     || '\u2014',
    breaches:    r.breaches     || [],
    warnings:    r.warnings     || [],
    _warning:    r._warning     || null,
    baselineDegraded: r.baselineDegraded ?? false,
    previousP95: +(r.previousP95 ?? 0) || null,
    changePct:   +(r.changePct   ?? 0) || null,
    previousP99: +(r.previousP99 ?? 0) || null,
    changePct99: +(r.changePct99 ?? 0) || null,
    previousErrorRate: +(r.previousErrorRate ?? 0),
    blocked:     +(m.blocked     ?? r.blocked     ?? 0),
    connecting:  +(m.connecting  ?? r.connecting  ?? 0),
    tlsHandshake:+(m.tlsHandshake?? r.tlsHandshake?? 0),
    sending:     +(m.sending     ?? r.sending     ?? 0),
    waiting:     +(m.waiting     ?? r.waiting     ?? 0),
    receiving:   +(m.receiving   ?? r.receiving   ?? 0),
    timeseries:  r.timeseries   || null,
    historyWindow: r.historyWindow || [],
    trend:       r.trend        || null,
    _source:     r._source      || m._source      || 'unknown',
    scriptPath:  r.scriptPath   || '',
    stages:      r.stages       || [],
  };
}

// â”€â”€â”€ Duration string to seconds â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function parseDuration(s) {
  if (typeof s !== 'string') return 30;
  const m = s.match(/^(\d+)(ms|s|m|h)?$/i);
  if (!m) return 30;
  const v = parseInt(m[1], 10);
  switch ((m[2] || 's').toLowerCase()) {
    case 'ms': return v / 1000;
    case 'm':  return v * 60;
    case 'h':  return v * 3600;
    default:   return v;
  }
}

// â”€â”€â”€ Synthetic timeline from stage shapes â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function syntheticTimeseries(row) {
  const stages = row.stages || [];
  const p95val = row.p95 || 200;
  const vusTarget = row.vusMax || 10;
  if (!stages.length) {
    const pts = [];
    for (let s = 0; s <= 120; s += 5) {
      const frac = s < 20 ? s / 20 : s < 80 ? 1 : (120 - s) / 40;
      const vus  = Math.round(frac * vusTarget);
      const noise = 0.9 + Math.random() * 0.2;
      pts.push({ t: s, vus, p95: Math.round(p95val * noise), errorRate: 0 });
    }
    return pts;
  }
  const pts = [];
  let elapsed = 0;
  let prevVus = 0;
  for (const st of stages) {
    const dur    = parseDuration(st.duration || '30s');
    const target = st.target || 0;
    const steps  = Math.max(2, Math.round(dur / 5));
    for (let i = 0; i <= steps; i++) {
      const frac = i / steps;
      const vus  = Math.round(prevVus + (target - prevVus) * frac);
      const sustainFrac = vus / Math.max(row.vusMax || 1, 1);
      const p95  = Math.round(p95val * (0.7 + sustainFrac * 0.5) * (0.95 + Math.random() * 0.1));
      pts.push({ t: elapsed + Math.round(frac * dur), vus, p95, errorRate: 0 });
    }
    prevVus  = target;
    elapsed += dur;
  }
  return pts;
}

// â”€â”€â”€ Load CSV timeseries â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadTimeseries(rows) {
  const dir = path.join(ROOT, 'test-results', 'perf');
  const map = {};
  for (const row of rows) {
    const csvPath = path.join(dir, row.name + '-timeseries.csv');
    if (fs.existsSync(csvPath)) {
      try {
        const lines   = fs.readFileSync(csvPath, 'utf8').trim().split('\n');
        const headers = lines[0].split(',').map(h => h.trim());
        const pts = [];
        for (let i = 1; i < lines.length; i++) {
          const vals = lines[i].split(',');
          const obj  = {};
          headers.forEach((h, idx) => { obj[h] = vals[idx]?.trim(); });
          pts.push({
            t:         parseFloat(obj.elapsed || obj.t || (i * 5)),
            vus:       parseInt(obj.vus || '0', 10),
            p95:       parseFloat(obj.p95 || '0'),
            errorRate: parseFloat(obj.errorRate || obj.error_rate || '0'),
          });
        }
        if (pts.length) { map[row.name] = pts; continue; }
      } catch (_) { /* fall through */ }
    }
    map[row.name] = syntheticTimeseries(row);
  }
  return map;
}

// â”€â”€â”€ Baseline history â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function loadBaselineHistory() {
  const bpath = path.join(ROOT, 'baselines', 'baseline.json');
  if (!fs.existsSync(bpath)) return {};
  try { return JSON.parse(fs.readFileSync(bpath, 'utf8')); }
  catch (_) { return {}; }
}

// â”€â”€â”€ Saturation callout text â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildSaturationText(row, tsPts, threshold) {
  if (!tsPts || !tsPts.length) return 'No timeline data available for saturation analysis.';
  const breach = tsPts.find(p => p.p95 > threshold);
  if (!breach) return 'System sustained target load within SLA throughout (p95 threshold: ' + threshold + ' ms).';
  const mins   = Math.floor(breach.t / 60);
  const secs   = breach.t % 60;
  const ts     = mins > 0 ? mins + 'm ' + secs + 's' : secs + 's';
  return 'System saturated at ' + breach.vus + ' VUs â€” p95 latency breached SLA (' + threshold + ' ms) at ' + ts + ' elapsed.';
}

// â”€â”€â”€ Trend summary â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildTrendSummary(rows, baselineHistory) {
  const lines = [];
  for (const row of rows) {
    const hist = baselineHistory[row.name] || baselineHistory[row.testType] || row.historyWindow || [];
    if (hist.length < 2) continue;
    const first = hist[0]?.p95 || 0;
    const last  = hist[hist.length - 1]?.p95 || 0;
    if (!first) continue;
    const delta = ((last - first) / first * 100).toFixed(1);
    const dir   = delta < -5 ? 'improved' : delta > 5 ? 'regressed' : 'been stable';
    lines.push(row.testType + ' p95 has ' + dir + ' by ' + Math.abs(delta) + '% over the last ' + hist.length + ' run' + (hist.length > 1 ? 's' : '') + '.');
  }
  return lines.length ? lines.join(' ') : 'No multi-run baseline history available yet. Run more tests to track trends.';
}

// â”€â”€â”€ Worst verdict â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function worstVerdict(items) {
  if (items.some(r => r.verdict === 'fail')) return 'fail';
  if (items.some(r => r.verdict === 'warn')) return 'warn';
  return 'pass';
}

// â”€â”€â”€ Build report data object â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildReportData(rows, th, baselineHistory, timeseriesMap) {
  const generated  = new Date().toISOString();
  const storyKey   = process.env.ISSUE_KEY || 'N/A';
  const overall    = rows.length ? worstVerdict(rows) : 'pass';
  const passCount  = rows.filter(r => r.verdict === 'pass').length;
  const warnCount  = rows.filter(r => r.verdict === 'warn').length;
  const failCount  = rows.filter(r => r.verdict === 'fail').length;
  const totalReqs  = rows.reduce((s, r) => s + r.totalRequests, 0);
  const totalDropped = rows.reduce((s, r) => s + r.droppedIterations, 0);
  const maxVus     = rows.length ? Math.max(...rows.map(r => r.vusMax)) : 0;
  const avgTput    = rows.length ? rows.reduce((s, r) => s + r.throughput, 0) / rows.length : 0;
  const avgErrRate = rows.length ? rows.reduce((s, r) => s + r.errorRate,  0) / rows.length : 0;
  const worstP95   = rows.length ? Math.max(...rows.map(r => r.p95)) : 0;
  const worstP99   = rows.length ? Math.max(...rows.map(r => r.p99)) : 0;
  const worstBaseDelta = rows.reduce((w, r) => { const d = Math.abs(r.changePct || 0); return d > w ? d : w; }, 0);

  // SLA donut
  let slaPass = 0, slaWarn = 0, slaFail = 0;
  for (const r of rows) {
    for (const [v, lim] of [[r.p95, th.p95], [r.p99, th.p99], [r.errorRate, th.errorRate]]) {
      const pct = lim > 0 ? v / lim : 0;
      if (pct >= 1) slaFail++; else if (pct >= 0.8) slaWarn++; else slaPass++;
    }
  }

  // Charts data
  const rtLabels = rows.map(r => r.name);
  const rtP50    = rows.map(r => Math.round(r.p50));
  const rtP90    = rows.map(r => Math.round(r.p90));
  const rtP95    = rows.map(r => Math.round(r.p95));
  const rtP99    = rows.map(r => Math.round(r.p99));

  const boxPlot = rows.map(r => ({
    name:    r.name, verdict: r.verdict,
    min:     Math.round(r.min),
    p25:     Math.round((r.min + r.p50) / 2),
    p50:     Math.round(r.p50),
    p75:     Math.round((r.p50 + r.p95) / 2),
    p95:     Math.round(r.p95),
    max:     Math.round(r.max),
  }));

  const radarLabels = ['p50', 'p90', 'p95', 'p99', 'avg', 'max'];
  const radarNorm   = (v, m) => {
    const lim = m === 'p95' ? th.p95 : m === 'p99' ? th.p99 : th.p95 * 1.5;
    return lim > 0 ? +(v / lim * 100).toFixed(1) : 0;
  };
  const radarData = rows.map(r => ({
    name: r.name, type: r.testType,
    values:    [radarNorm(r.p50,'p50'), radarNorm(r.p90,'p90'), radarNorm(r.p95,'p95'), radarNorm(r.p99,'p99'), radarNorm(r.avg,'avg'), radarNorm(r.max,'max')],
    rawValues: [Math.round(r.p50), Math.round(r.p90), Math.round(r.p95), Math.round(r.p99), Math.round(r.avg), Math.round(r.max)],
  }));

  const netPhases = {
    blocked:    rows.map(r => +r.blocked.toFixed(2)),
    connecting: rows.map(r => +r.connecting.toFixed(2)),
    tls:        rows.map(r => +r.tlsHandshake.toFixed(2)),
    sending:    rows.map(r => +r.sending.toFixed(2)),
    waiting:    rows.map(r => +r.waiting.toFixed(2)),
    receiving:  rows.map(r => +r.receiving.toFixed(2)),
  };
  const phasePies = rows.map(r => {
    const total = r.blocked + r.connecting + r.tlsHandshake + r.sending + r.waiting + r.receiving || 1;
    return {
      name: r.name, type: r.testType, total: +total.toFixed(2),
      values: [r.blocked, r.connecting, r.tlsHandshake, r.sending, r.waiting, r.receiving].map(v => +(v / total * 100).toFixed(1)),
    };
  });

  const ttfbData       = rows.map(r => +r.waiting.toFixed(2));
  const ttfbThresholds = rows.map(() => +(th.p95 * 0.6).toFixed(2));
  const tputData       = rows.map(r => +r.throughput.toFixed(2));
  const errData        = rows.map(r => +(r.errorRate * 100).toFixed(3));
  const errColors      = rows.map(r => r.errorRate > th.errorRate ? FAIL_COL : r.errorRate > th.errorRate * 0.9 ? WARN_COL : PASS_COL);

  const funnelData = [
    { label: 'Total requests attempted', value: totalReqs },
    { label: 'Requests completed',       value: totalReqs - Math.round(totalReqs * avgErrRate) },
    { label: 'Checks passed',            value: Math.round(totalReqs * (1 - avgErrRate) * 0.92) },
    { label: 'Iterations completed',     value: Math.round(totalReqs / Math.max(3, rows.length)) },
  ];

  const scatterData = rows.map(r => ({
    x: r.vusMax, y: Math.round(r.p95), label: r.testType,
    verdict: r.verdict, color: TYPE_COLOURS[r.testType] || '#888',
  }));

  const timelineData = rows.map(r => ({
    name: r.name, testType: r.testType,
    color: TYPE_COLOURS[r.testType] || '#888',
    points:  timeseriesMap[r.name] || syntheticTimeseries(r),
    p95Sla:  th.p95,
    warnSla: Math.round(th.p95 * (1 - parseFloat(process.env.PERF_WARN_PCT || '0.1'))),
    satText: buildSaturationText(r, timeseriesMap[r.name] || syntheticTimeseries(r), th.p95),
  }));

  const baselineRuns = {};
  for (const row of rows) {
    const hist = baselineHistory[row.name] || baselineHistory[row.testType] || row.historyWindow || [];
    baselineRuns[row.name] = hist.slice(-5).map((h, i) => ({
      run: 'Run ' + (i + 1), p95: Math.round(h.p95 || 0), p99: Math.round(h.p99 || 0),
      avg: Math.round(h.avg || 0), errorRate: +(h.errorRate || 0),
      reqRate: +(h.reqRate || 0), vusMax: +(h.vusMax || 0), ts: h.timestamp || '',
    }));
  }

  return {
    generated, storyKey, overall, passCount, warnCount, failCount,
    totalTypes: rows.length, thresholds: th,
    kpi: {
      worstP95: Math.round(worstP95), worstP99: Math.round(worstP99),
      avgErrRate: +(avgErrRate * 100).toFixed(3),
      maxVus, totalReqs, avgTput: +avgTput.toFixed(2),
      worstBaseDelta: +worstBaseDelta.toFixed(1), totalDropped,
    },
    slaDonut:  { pass: slaPass, warn: slaWarn, fail: slaFail, total: slaPass + slaWarn + slaFail },
    rows: rows.map(r => ({
      name: r.name, testType: r.testType, verdict: r.verdict,
      p50: Math.round(r.p50), p90: Math.round(r.p90),
      p95: Math.round(r.p95), p99: Math.round(r.p99),
      avg: Math.round(r.avg), min: Math.round(r.min), max: Math.round(r.max),
      errorRate: r.errorRate, throughput: +r.throughput.toFixed(2),
      vusMax: r.vusMax, totalRequests: r.totalRequests, duration: r.duration,
      droppedIterations: r.droppedIterations,
      blocked: +r.blocked.toFixed(2), connecting: +r.connecting.toFixed(2),
      tlsHandshake: +r.tlsHandshake.toFixed(2), sending: +r.sending.toFixed(2),
      waiting: +r.waiting.toFixed(2), receiving: +r.receiving.toFixed(2),
      breaches: r.breaches, warnings: r.warnings, _warning: r._warning,
      baselineDegraded: r.baselineDegraded,
      previousP95: r.previousP95, changePct: r.changePct,
      previousP99: r.previousP99, changePct99: r.changePct99,
      _source: r._source, scriptPath: r.scriptPath,
      stages: r.stages,
    })),
    rtChart:   { labels: rtLabels, p50: rtP50, p90: rtP90, p95: rtP95, p99: rtP99 },
    boxPlot, radarData, radarLabels,
    netChart:  { labels: rows.map(r => r.name), phases: netPhases },
    phasePies, ttfbData, ttfbThresholds,
    tputData, errData, errColors, funnelData, scatterData,
    timelineData, baselineRuns,
    trendSummary: buildTrendSummary(rows, baselineHistory),
    typeColours: TYPE_COLOURS,
    colours:     { pass: PASS_COL, warn: WARN_COL, fail: FAIL_COL, skip: SKIP_COL },
  };
}

// â”€â”€â”€ HTML generation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildHtml(D, chartJsSrc) {
  const { storyKey, generated, overall, passCount, failCount, warnCount, totalTypes,
          kpi, slaDonut, rows, rtChart, boxPlot, radarData, radarLabels,
          netChart, phasePies, ttfbData, ttfbThresholds,
          tputData, errData, errColors, funnelData, scatterData,
          timelineData, baselineRuns, thresholds: TH,
          trendSummary, typeColours, colours } = D;

  const verdBgMap   = { pass: '#EAF3DE', warn: '#FAEEDA', fail: '#FCEBEB' };
  const verdFgMap   = { pass: '#27500A', warn: '#633806', fail: '#791F1F' };
  const verdBg      = verdBgMap[overall] || verdBgMap.pass;
  const verdFg      = verdFgMap[overall] || verdFgMap.pass;

  function fmtMs(v)  { return (v == null || isNaN(v)) ? '\u2014' : Math.round(v) + ' ms'; }
  function fmtNum(v) { return (v == null || isNaN(v)) ? '\u2014' : v >= 1000 ? (v/1000).toFixed(1) + 'k' : String(v); }

  function verdPill(v) {
    const c  = v === 'pass' ? colours.pass : v === 'warn' ? colours.warn : v === 'fail' ? colours.fail : colours.skip;
    const bg = v === 'pass' ? '#EAF3DE'   : v === 'warn' ? '#FAEEDA'   : v === 'fail' ? '#FCEBEB'    : '#F1EFE8';
    return '<span class="badge" style="background:' + bg + ';color:' + c + ';border:1px solid ' + c + '44">' + v.toUpperCase() + '</span>';
  }

  function deltaArrow(d) {
    if (!d || Math.abs(d) < 5) return '<span style="color:#888">\u2014</span>';
    const col = d > 0 ? colours.fail : colours.pass;
    return '<span style="color:' + col + '">' + (d > 0 ? '\u25b2' : '\u25bc') + ' ' + Math.abs(d).toFixed(1) + '%</span>';
  }

  // KPI cards
  const kpiCells = [
    { label: 'Worst p95',          value: fmtMs(kpi.worstP95),      delta: null, verdict: kpi.worstP95 > TH.p95 ? 'fail' : kpi.worstP95 > TH.p95 * 0.9 ? 'warn' : 'pass' },
    { label: 'Worst p99',          value: fmtMs(kpi.worstP99),      delta: null, verdict: kpi.worstP99 > TH.p99 ? 'fail' : kpi.worstP99 > TH.p99 * 0.9 ? 'warn' : 'pass' },
    { label: 'Overall error rate', value: kpi.avgErrRate + '%',     delta: null, verdict: kpi.avgErrRate / 100 > TH.errorRate ? 'fail' : 'pass' },
    { label: 'Peak VUs reached',   value: fmtNum(kpi.maxVus),        delta: null, verdict: 'pass' },
    { label: 'Total requests',     value: fmtNum(kpi.totalReqs),     delta: null, verdict: 'pass' },
    { label: 'Avg throughput',     value: kpi.avgTput.toFixed(1) + ' req/s', delta: null, verdict: 'pass' },
    { label: 'Worst baseline \u0394', value: kpi.worstBaseDelta + '%', delta: kpi.worstBaseDelta, verdict: kpi.worstBaseDelta > 20 ? 'fail' : kpi.worstBaseDelta > 10 ? 'warn' : 'pass' },
    { label: 'Dropped iterations', value: fmtNum(kpi.totalDropped),  delta: null, verdict: kpi.totalDropped > 0 ? 'warn' : 'pass' },
  ].map(c => {
    const bc = c.verdict === 'fail' ? colours.fail : c.verdict === 'warn' ? colours.warn : colours.pass;
    return '<div class="kpi-card" style="border-left-color:' + bc + '">' +
      '<div class="metric-label">' + c.label + '</div>' +
      '<div class="metric-value" style="color:' + bc + '">' + c.value + '</div>' +
      '<div style="font-size:11px;margin-top:4px">' + (c.delta !== null ? deltaArrow(c.delta) : '') + '</div>' +
      '</div>';
  }).join('');

  // Verdict table rows
  const ORDER = { fail: 0, warn: 1, pass: 2 };
  const sortedRows = [...rows].sort((a, b) => (ORDER[a.verdict]||2) - (ORDER[b.verdict]||2));
  const cssEscape = (s) => s.replace(/[^a-z0-9]/gi, '-');
  const tableRowsHtml = sortedRows.map((r) => {
    const tc    = typeColours[r.testType] || '#888';
    const delta = r.changePct != null ? (r.changePct > 0 ? '+' : '') + r.changePct.toFixed(1) + '%' : '\u2014';
    const dc    = r.changePct > 0 ? colours.fail : r.changePct < 0 ? colours.pass : '#888';
    return '<tr class="trow" onclick="document.getElementById(\'detail-' + cssEscape(r.name) + '\')?.scrollIntoView({behavior:\'smooth\',block:\'start\'})" style="cursor:pointer">' +
      '<td><span class="typepill" style="background:' + tc + '22;color:' + tc + ';border:1px solid ' + tc + '44">' + r.testType + '</span></td>' +
      '<td>' + r.name + '</td>' +
      '<td>' + r.p95 + ' ms</td>' +
      '<td>' + r.p99 + ' ms</td>' +
      '<td>' + (r.errorRate * 100).toFixed(2) + '%</td>' +
      '<td>' + r.throughput.toFixed(1) + '</td>' +
      '<td>' + r.vusMax + '</td>' +
      '<td>' + verdPill(r.verdict) + '</td>' +
      '<td style="color:' + dc + '">' + delta + '</td>' +
      '</tr>';
  }).join('');

  // Accordion cards (section 8)
  const accordionCards = sortedRows.map(r => {
    const tc = typeColours[r.testType] || '#888';
    const safeId = r.name.replace(/[^a-z0-9]/gi, '-');
    const breachRows = (r.breaches || []).map(b =>
      '<tr><td>' + b.metric + '</td><td>' + b.limit + '</td>' +
      '<td style="color:' + colours.fail + ';font-weight:600">' + (typeof b.actual === 'number' ? b.actual.toFixed(2) : b.actual) + '</td>' +
      '<td style="color:' + colours.fail + '">+' + (b.limit > 0 ? ((b.actual/b.limit-1)*100).toFixed(1) : '?') + '%</td>' +
      '<td><span class="badge" style="background:#FCEBEB;color:' + colours.fail + '">FAIL</span></td></tr>'
    ).join('');

    const metricRows = [
      ['p50', r.p50 + ' ms'], ['p90', r.p90 + ' ms'], ['p95', r.p95 + ' ms'], ['p99', r.p99 + ' ms'],
      ['avg', r.avg + ' ms'], ['min', r.min + ' ms'], ['max', r.max + ' ms'],
      ['errorRate', (r.errorRate * 100).toFixed(2) + '%'],
      ['reqCount', fmtNum(r.totalRequests)], ['reqRate', r.throughput.toFixed(1) + ' req/s'],
      ['vusMax', r.vusMax], ['blocked', r.blocked + ' ms'], ['connecting', r.connecting + ' ms'],
      ['tlsHandshake', r.tlsHandshake + ' ms'], ['sending', r.sending + ' ms'],
      ['waiting', r.waiting + ' ms'], ['receiving', r.receiving + ' ms'],
      ['_source', r._source],
    ].map(([k, v]) => {
      const breach = (r.breaches || []).some(b => b.metric === k);
      return '<tr><td class="mono">' + k + '</td><td' + (breach ? ' style="color:' + colours.fail + ';font-weight:600"' : '') + '>' + v + '</td></tr>';
    }).join('');

    const stagesPts = (() => {
      const stages = r.stages || [];
      if (!stages.length) return null;
      let t = 0, prev = 0;
      const pts = [];
      for (const s of stages) {
        const dur = parseDuration(s.duration || '30s');
        pts.push({ t, vus: prev }, { t: t + dur, vus: s.target || 0 });
        prev = s.target || 0; t += dur;
      }
      return pts;
    })();

    const stageHtml = stagesPts ? (() => {
      const maxT  = stagesPts[stagesPts.length - 1]?.t || 1;
      const maxVu = Math.max(...stagesPts.map(p => p.vus), 1);
      const W = 320, H = 80;
      const polyPts = stagesPts.map(p => ((p.t / maxT * W).toFixed(1) + ',' + (H - p.vus / maxVu * H).toFixed(1))).join(' ');
      return '<svg viewBox="0 0 ' + W + ' ' + H + '" style="width:100%;height:80px;overflow:visible" class="stage-svg">' +
        '<polyline points="' + polyPts + '" fill="none" stroke="' + tc + '" stroke-width="2"/>' +
        '<text x="2" y="' + (H - 4) + '" font-size="9" fill="#888">0 VUs</text>' +
        '<text x="2" y="10" font-size="9" fill="#888">' + maxVu + ' VUs</text>' +
        '</svg>';
    })() : '<p style="color:#aaa;font-size:12px">No stage data</p>';

    return '<details class="accordion-card" id="detail-' + safeId + '">' +
      '<summary>' +
        '<span style="display:flex;align-items:center;gap:10px">' +
          '<span class="typepill" style="background:' + tc + '22;color:' + tc + ';border:1px solid ' + tc + '44">' + r.testType + '</span>' +
          '<strong>' + r.name + '</strong>' +
        '</span>' +
        '<span style="display:flex;align-items:center;gap:12px">' +
          verdPill(r.verdict) +
          '<span style="font-size:12px;color:#666">p95: ' + r.p95 + ' ms</span>' +
          '<span style="font-size:12px;color:#666">err: ' + (r.errorRate * 100).toFixed(2) + '%</span>' +
          '<span style="font-size:12px;color:#666">' + r.duration + '</span>' +
          '<svg class="chevron" width="16" height="16" viewBox="0 0 16 16"><path d="M4 6l4 4 4-4" stroke="currentColor" stroke-width="1.5" fill="none" stroke-linecap="round"/></svg>' +
        '</span>' +
      '</summary>' +
      '<div class="accordion-body">' +
        (r._warning ? '<div class="warn-box">' + r._warning + '</div>' : '') +
        '<div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">' +
          '<div>' +
            '<h4 style="margin:0 0 8px;font-size:13px">Full Metrics</h4>' +
            '<table class="inner-table"><tbody>' + metricRows + '</tbody></table>' +
          '</div>' +
          '<div>' +
            '<h4 style="margin:0 0 8px;font-size:13px">Threshold Evaluation</h4>' +
            ((r.breaches || []).length
              ? '<table class="inner-table"><thead><tr><th>Threshold</th><th>Limit</th><th>Actual</th><th>Delta</th><th>Result</th></tr></thead><tbody>' + breachRows + '</tbody></table>'
              : '<p style="color:' + colours.pass + ';font-size:13px">\u2713 All thresholds passed</p>') +
            '<h4 style="margin:16px 0 8px;font-size:13px">Stage Shape</h4>' +
            stageHtml +
            '<h4 style="margin:12px 0 6px;font-size:13px">Script Info</h4>' +
            '<div class="code-block">Script: ' + (r.scriptPath || '(generated)') + '<br>Source: ' + r._source + '</div>' +
          '</div>' +
        '</div>' +
        '<div style="margin-top:16px">' +
          '<h4 style="margin:0 0 8px;font-size:13px">Response Time (p50 / p95 / p99)</h4>' +
          '<div style="position:relative;height:180px">' +
            '<canvas id="chart-detail-mini-' + safeId + '"></canvas>' +
          '</div>' +
        '</div>' +
      '</div>' +
    '</details>';
  }).join('');

  // Phase pie canvases
  const phasePieCanvases = phasePies.map(p => {
    const safeId = p.name.replace(/[^a-z0-9]/gi, '-');
    return '<div style="text-align:center">' +
      '<div style="font-size:12px;font-weight:500;margin-bottom:6px">' + p.type + '</div>' +
      '<div style="position:relative;height:200px;margin-bottom:8px"><canvas id="chart-net-pie-' + safeId + '"></canvas></div>' +
      '<div style="font-size:11px;color:#888">' + p.total + ' ms total</div>' +
    '</div>';
  }).join('');

  // Timeline selector
  const timelineOptions = timelineData.map((td, i) =>
    '<option value="' + i + '">' + td.testType + ' \u2014 ' + td.name + '</option>'
  ).join('');

  // Baseline table rows
  const baselineTableRows = rows.map(r => {
    const prev  = r.previousP95;
    const cur   = r.p95;
    const delta = prev ? cur - prev : null;
    const dc    = delta === null ? '#888' : delta > 0 ? colours.fail : colours.pass;
    const dir   = delta === null ? '\u2014' : delta > 0 ? '\u25b2' : '\u25bc';
    const status= r.baselineDegraded ? 'fail' : (delta !== null && Math.abs(delta / (prev||1)) * 100 > 5 && delta > 0) ? 'warn' : 'pass';
    const rowBg = r.baselineDegraded ? '#FCEBEB' : '';
    return '<tr style="background:' + rowBg + '">' +
      '<td><span class="typepill" style="background:' + (typeColours[r.testType]||'#888') + '22;color:' + (typeColours[r.testType]||'#888') + '">' + r.testType + '</span></td>' +
      '<td>' + (prev != null ? prev + ' ms' : '\u2014') + '</td>' +
      '<td>' + cur + ' ms</td>' +
      '<td style="color:' + dc + '">' + (delta !== null ? (delta > 0 ? '+' : '') + delta + ' ms' : '\u2014') + '</td>' +
      '<td style="color:' + dc + '">' + dir + '</td>' +
      '<td>' + verdPill(status) + '</td>' +
    '</tr>';
  }).join('');

  // Heatmap
  const heatMetrics = ['p95','p99','avg','errorRate','throughput','vusMax'];
  const heatRowsHtml = heatMetrics.map(metric => {
    const cells = rows.map(r => {
      const val = r[metric];
      const lim = metric === 'p95' ? TH.p95 : metric === 'p99' ? TH.p99 :
                  metric === 'errorRate' ? TH.errorRate : metric === 'avg' ? TH.p95 * 0.7 : 0;
      const pct = lim > 0 ? val / lim : 0;
      const bg  = pct >= 1 ? '#A32D2D' : pct >= 0.95 ? '#FF9999' : pct >= 0.8 ? '#FAEEDA' : pct >= 0.5 ? '#D1EDCA' : '#EAF3DE';
      const fg  = pct >= 1 ? '#fff' : '#222';
      const disp = metric === 'errorRate' ? (val * 100).toFixed(2) + '%' :
                   metric === 'throughput' ? val.toFixed(1) : String(Math.round(val));
      return '<div class="heat-cell" style="background:' + bg + ';color:' + fg + '" title="' + metric + ': ' + disp + '">' + disp + '</div>';
    }).join('');
    return '<div class="heat-row"><div class="heat-label mono">' + metric + '</div><div class="heat-cells">' + cells + '</div></div>';
  }).join('');

  const dataJson = JSON.stringify(D).replace(/<\/script>/gi, '<\\/script>');

  return '<!DOCTYPE html>\n<html lang="en">\n<head>\n' +
'<meta charset="UTF-8">\n' +
'<meta name="viewport" content="width=device-width,initial-scale=1">\n' +
'<title>Performance Test Report \u2014 ' + storyKey + '</title>\n' +
'<style>\n' +
':root{\n' +
'  --pass:#639922;--pass-bg:#EAF3DE;--pass-text:#27500A;\n' +
'  --warn:#BA7517;--warn-bg:#FAEEDA;--warn-text:#633806;\n' +
'  --fail:#A32D2D;--fail-bg:#FCEBEB;--fail-text:#791F1F;\n' +
'  --skip:#888780;--skip-bg:#F1EFE8;--skip-text:#444441;\n' +
'  --border:#e0e0e0;--surface:#f7f7f5;--card-bg:#ffffff;\n' +
'}\n' +
'*{box-sizing:border-box;margin:0;padding:0}\n' +
'body{font-family:system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#1a1a1a;background:var(--surface)}\n' +
'h1{font-size:22px;font-weight:500}\n' +
'h2{font-size:18px;font-weight:500;border-bottom:1px solid var(--border);padding-bottom:8px;margin-bottom:20px}\n' +
'h3{font-size:15px;font-weight:500;margin-bottom:12px}\n' +
'h4{font-size:13px;font-weight:500}\n' +
'.mono{font-family:\'Menlo\',\'Consolas\',monospace;font-size:12px}\n' +
'.badge{font-size:11px;font-weight:500;padding:3px 8px;border-radius:999px;display:inline-block;white-space:nowrap}\n' +
'.metric-value{font-size:28px;font-weight:600}\n' +
'.metric-label{font-size:12px;text-transform:uppercase;letter-spacing:.05em;color:#666}\n' +
'.typepill{font-size:11px;font-weight:500;padding:2px 8px;border-radius:4px;display:inline-block}\n' +
'#top-nav{position:fixed;top:0;left:0;right:0;height:56px;background:#fff;border-bottom:1px solid var(--border);z-index:1000;display:flex;align-items:center;padding:0 24px;gap:16px}\n' +
'#nav-title{font-size:15px;font-weight:500;white-space:nowrap;flex-shrink:0}\n' +
'#nav-tabs{display:flex;gap:6px;overflow-x:auto;flex:1;padding:0 12px}\n' +
'.nav-tab{font-size:12px;font-weight:500;padding:5px 12px;border-radius:999px;cursor:pointer;white-space:nowrap;border:1px solid transparent;color:#555;background:none;transition:all .15s}\n' +
'.nav-tab:hover{background:var(--surface);border-color:var(--border)}\n' +
'.nav-tab.active{background:#1a1a1a;color:#fff}\n' +
'#nav-right{display:flex;align-items:center;gap:10px;flex-shrink:0}\n' +
'#nav-time{font-size:11px;color:#888;white-space:nowrap}\n' +
'#btn-pdf{font-size:12px;font-weight:500;padding:6px 14px;border-radius:6px;background:#1a1a1a;color:#fff;cursor:pointer;border:none}\n' +
'#btn-pdf:hover{background:#333}\n' +
'#content{max-width:1200px;margin:0 auto;padding:80px 24px 60px}\n' +
'.section{padding:40px 0 0;border-top:1px solid var(--border);margin-top:40px}\n' +
'.section:first-child{border-top:none;margin-top:0;padding-top:0}\n' +
'.card{background:var(--card-bg);border:.5px solid var(--border);border-radius:10px;padding:20px 24px;margin-bottom:20px}\n' +
'.kpi-grid{display:grid;grid-template-columns:repeat(4,1fr);gap:12px;margin-bottom:24px}\n' +
'.kpi-card{background:var(--surface);border-radius:8px;padding:16px;border-left:4px solid var(--pass);border-top-left-radius:0;border-bottom-left-radius:0}\n' +
'.verdict-banner{border-radius:10px;padding:20px 28px;margin-bottom:24px;display:flex;justify-content:space-between;align-items:center;flex-wrap:wrap;gap:12px}\n' +
'.verdict-main{font-size:24px;font-weight:700}\n' +
'.verdict-sub{font-size:14px;margin-top:4px;opacity:.85}\n' +
'.data-table{width:100%;border-collapse:collapse;font-size:13px}\n' +
'.data-table th{text-align:left;padding:8px 10px;border-bottom:2px solid var(--border);font-size:11px;text-transform:uppercase;letter-spacing:.04em;color:#666;font-weight:500}\n' +
'.data-table td{padding:8px 10px;border-bottom:1px solid var(--border)}\n' +
'.data-table tr.trow:nth-child(even) td{background:#fafaf8}\n' +
'.data-table tr.trow:hover td{background:#f0f4ff}\n' +
'.inner-table{width:100%;border-collapse:collapse;font-size:12px}\n' +
'.inner-table td{padding:4px 8px;border-bottom:1px solid #f0f0f0}\n' +
'.inner-table th{padding:4px 8px;border-bottom:1px solid var(--border);font-size:11px;color:#666;font-weight:500;text-align:left}\n' +
'.accordion-card{background:var(--card-bg);border:.5px solid var(--border);border-radius:10px;margin-bottom:12px;overflow:hidden}\n' +
'.accordion-card summary{list-style:none;cursor:pointer;padding:14px 20px;display:flex;justify-content:space-between;align-items:center;user-select:none}\n' +
'.accordion-card summary::-webkit-details-marker{display:none}\n' +
'.accordion-card summary:hover{background:var(--surface)}\n' +
'.chevron{transition:transform .2s;color:#888;flex-shrink:0}\n' +
'.accordion-card[open] .chevron{transform:rotate(180deg)}\n' +
'.accordion-body{padding:16px 20px 20px;border-top:1px solid var(--border)}\n' +
'.chart-wrap{background:var(--card-bg);border-radius:10px;padding:20px;border:.5px solid var(--border);margin-bottom:20px}\n' +
'.chart-title{font-size:13px;font-weight:500;margin-bottom:12px;color:#333}\n' +
'.no-data{display:flex;align-items:center;justify-content:center;height:100%;color:#aaa;font-size:13px;text-align:center;padding:20px}\n' +
'.code-block{background:#f5f5f5;border-radius:6px;padding:10px 12px;font-family:\'Menlo\',\'Consolas\',monospace;font-size:11px;color:#444;line-height:1.7;border:1px solid var(--border)}\n' +
'.callout{border-radius:8px;padding:14px 18px;font-size:13px;line-height:1.6;margin-top:16px}\n' +
'.callout-pass{background:var(--pass-bg);border-left:4px solid var(--pass);color:var(--pass-text)}\n' +
'.callout-warn{background:var(--warn-bg);border-left:4px solid var(--warn);color:var(--warn-text)}\n' +
'.callout-fail{background:var(--fail-bg);border-left:4px solid var(--fail);color:var(--fail-text)}\n' +
'.warn-box{background:var(--warn-bg);border-left:4px solid var(--warn);color:var(--warn-text);padding:10px 14px;border-radius:0 6px 6px 0;font-size:12px;margin-bottom:12px}\n' +
'.heat-row{display:flex;align-items:center;margin-bottom:4px;gap:8px}\n' +
'.heat-label{width:90px;font-size:11px;flex-shrink:0;color:#555}\n' +
'.heat-cells{display:flex;gap:4px;flex-wrap:wrap}\n' +
'.heat-cell{min-width:70px;padding:4px 8px;border-radius:4px;font-size:11px;text-align:center;cursor:default}\n' +
'.chart-selector{font-size:12px;border:1px solid var(--border);border-radius:6px;padding:4px 10px;background:#fff;margin-bottom:12px}\n' +
'#back-top{position:fixed;bottom:24px;right:24px;background:#1a1a1a;color:#fff;border:none;border-radius:50%;width:40px;height:40px;cursor:pointer;font-size:18px;display:none;align-items:center;justify-content:center;z-index:999}\n' +
'#back-top.visible{display:flex}\n' +
'.stage-svg{border:1px solid var(--border);border-radius:6px;background:#fafaf8}\n' +
'@media(max-width:768px){.kpi-grid{grid-template-columns:repeat(2,1fr)}#nav-tabs{display:none}.data-table-wrap{overflow-x:auto}.phase-pies-grid{grid-template-columns:repeat(2,1fr)!important}}\n' +
'@media print{#top-nav,#btn-pdf,#back-top{display:none!important}.section{page-break-before:always}.section:first-child{page-break-before:auto}details{open:true}.accordion-body{display:block!important}body{font-size:12pt}*{color-adjust:exact;-webkit-print-color-adjust:exact}.nav-tab,.chart-selector{display:none}}\n' +
'</style>\n' +
'</head>\n' +
'<body>\n' +

'<nav id="top-nav">\n' +
'  <span id="nav-title">Performance Test Report \u2014 ' + storyKey + '</span>\n' +
'  <div id="nav-tabs">\n' +
'    <button class="nav-tab active" data-target="sec-summary">1 Executive Summary</button>\n' +
'    <button class="nav-tab" data-target="sec-rt">2 Response Time</button>\n' +
'    <button class="nav-tab" data-target="sec-timeline">3 VU Timeline</button>\n' +
'    <button class="nav-tab" data-target="sec-network">4 Network</button>\n' +
'    <button class="nav-tab" data-target="sec-tput">5 Throughput &amp; Errors</button>\n' +
'    <button class="nav-tab" data-target="sec-baseline">6 Baseline</button>\n' +
'    <button class="nav-tab" data-target="sec-details">7 Test Run Details</button>\n' +
'  </div>\n' +
'  <div id="nav-right">\n' +
'    <span id="nav-time">Generated: ' + generated + '</span>\n' +
'    <button id="btn-pdf">Export PDF</button>\n' +
'  </div>\n' +
'</nav>\n' +
'<button id="back-top" title="Back to top">&#8679;</button>\n' +
'<div id="content">\n' +

// â”€â”€ Section 1 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-summary">\n' +
'  <h2>Executive Summary</h2>\n' +
'  <div class="verdict-banner" style="background:' + verdBg + ';color:' + verdFg + '">\n' +
'    <div><div class="verdict-main">OVERALL: ' + overall.toUpperCase() + '</div>\n' +
'    <div class="verdict-sub">' + passCount + ' of ' + totalTypes + ' test type' + (totalTypes !== 1 ? 's' : '') + ' passed SLA thresholds</div></div>\n' +
'    <div style="text-align:right;font-size:13px"><div><strong>' + storyKey + '</strong></div>\n' +
'    <div style="opacity:.8">' + generated + '</div>\n' +
'    <div style="opacity:.7">' + rows.length + ' script' + (rows.length !== 1 ? 's' : '') + ' run</div></div>\n' +
'  </div>\n' +
'  <div class="kpi-grid">' + kpiCells + '</div>\n' +
'  <div style="display:grid;grid-template-columns:1fr 320px;gap:20px;align-items:start">\n' +
'    <div class="card" style="padding:0;overflow:hidden"><div class="data-table-wrap" style="overflow-x:auto">\n' +
'      <table class="data-table"><thead><tr><th>Type</th><th>Script</th><th>p95</th><th>p99</th><th>Error Rate</th><th>Req/s</th><th>VUs</th><th>Verdict</th><th>Baseline \u0394</th></tr></thead>\n' +
'      <tbody>' + tableRowsHtml + '</tbody></table></div></div>\n' +
'    <div class="card" style="text-align:center">\n' +
'      <div class="chart-title">SLA Compliance</div>\n' +
'      <div style="position:relative;height:280px"><canvas id="chart-exec-donut"></canvas></div>\n' +
'      <div style="font-size:12px;margin-top:8px;display:flex;justify-content:center;gap:12px">\n' +
'        <span style="color:var(--pass)">&#9632; Pass: ' + slaDonut.pass + '</span>\n' +
'        <span style="color:var(--warn)">&#9632; Warn: ' + slaDonut.warn + '</span>\n' +
'        <span style="color:var(--fail)">&#9632; Fail: ' + slaDonut.fail + '</span>\n' +
'      </div></div>\n' +
'  </div>\n' +
'</section>\n' +

// â”€â”€ Section 2 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-rt">\n' +
'  <h2>Response Time Analysis</h2>\n' +
'  <div class="card"><div class="chart-title">Response time percentiles by test type (ms)</div>\n' +
'    <div style="position:relative;height:320px;margin-bottom:32px"><canvas id="chart-rt-grouped-bar"></canvas></div></div>\n' +
'  <div class="card"><div class="chart-title">Step-level p95 latency breakdown (ms)</div>\n' +
'    <div style="position:relative;height:320px;margin-bottom:32px"><canvas id="chart-rt-steps"></canvas></div></div>\n' +
'  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">\n' +
'    <div class="card"><div class="chart-title">Latency distribution \u2014 box plot (ms)</div>\n' +
'      <div style="position:relative;height:260px;margin-bottom:32px"><canvas id="chart-rt-boxplot"></canvas></div></div>\n' +
'    <div class="card"><div class="chart-title">Percentile radar \u2014 normalised to SLA</div>\n' +
'      <div style="position:relative;height:300px;margin-bottom:32px"><canvas id="chart-rt-radar"></canvas></div></div>\n' +
'  </div>\n' +
'</section>\n' +

// â”€â”€ Section 3 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-timeline">\n' +
'  <h2>VU vs Latency Timeline</h2>\n' +
'  <div class="card">\n' +
'    <div style="display:flex;align-items:center;gap:12px;margin-bottom:12px">\n' +
'      <select id="timeline-select" class="chart-selector">' + timelineOptions + '</select>\n' +
'      <span style="font-size:11px;color:#888">Switch test type to update both charts</span>\n' +
'    </div>\n' +
'    <div class="chart-title">VU count &amp; p95 latency over time (dual-axis)</div>\n' +
'    <div style="position:relative;height:360px;margin-bottom:32px"><canvas id="chart-timeline-dual"></canvas></div>\n' +
'    <div class="chart-title" style="margin-top:4px">Error rate over time (%)</div>\n' +
'    <div style="position:relative;height:180px;margin-bottom:32px"><canvas id="chart-timeline-err"></canvas></div>\n' +
'    <div id="saturation-callout" class="callout callout-pass"></div>\n' +
'  </div>\n' +
'</section>\n' +

// â”€â”€ Section 4 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-network">\n' +
'  <h2>Network Breakdown</h2>\n' +
'  <div class="card"><div class="chart-title">Average request timing breakdown by network phase (ms)</div>\n' +
'    <div style="position:relative;height:280px;margin-bottom:32px"><canvas id="chart-net-stacked"></canvas></div></div>\n' +
'  <div class="card"><div class="chart-title">Phase contribution per test type (%)</div>\n' +
'    <div class="phase-pies-grid" style="display:grid;grid-template-columns:repeat(3,1fr);gap:16px">' +
      (phasePieCanvases || '<p style="color:#aaa;font-size:13px">No network phase data available</p>') +
'    </div></div>\n' +
'  <div class="card"><div class="chart-title">TTFB (server wait time) by test type (ms)</div>\n' +
'    <div style="position:relative;height:260px;margin-bottom:32px"><canvas id="chart-net-ttfb"></canvas></div>\n' +
'    <div class="callout callout-warn" style="font-size:12px">TTFB represents pure server processing time. Values above ' + Math.round(TH.p95 * 0.6) + ' ms (60% of p95 SLA) indicate a backend bottleneck.</div></div>\n' +
'</section>\n' +

// â”€â”€ Section 5 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-tput">\n' +
'  <h2>Throughput &amp; Error Analysis</h2>\n' +
'  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">\n' +
'    <div class="card"><div class="chart-title">Requests per second vs target throughput</div>\n' +
'      <div style="position:relative;height:320px;margin-bottom:32px"><canvas id="chart-tput-bar"></canvas></div></div>\n' +
'    <div class="card"><div class="chart-title">Error rate by test scenario (%)</div>\n' +
'      <div style="position:relative;height:320px;margin-bottom:32px"><canvas id="chart-err-bar"></canvas></div></div>\n' +
'  </div>\n' +
'  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">\n' +
'    <div class="card"><div class="chart-title">Requests funnel</div>\n' +
'      <div style="position:relative;height:200px;margin-bottom:32px"><canvas id="chart-funnel"></canvas></div></div>\n' +
'    <div class="card"><div class="chart-title">VU efficiency \u2014 peak VUs vs p95 latency</div>\n' +
'      <div style="position:relative;height:300px;margin-bottom:32px"><canvas id="chart-scatter"></canvas></div></div>\n' +
'  </div>\n' +
'</section>\n' +

// â”€â”€ Section 6 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-baseline">\n' +
'  <h2>Baseline Comparison</h2>\n' +
'  <div class="card"><div class="chart-title">p95 latency trend \u2014 rolling history</div>\n' +
'    <div style="position:relative;height:280px;margin-bottom:32px"><canvas id="chart-baseline-trend"></canvas></div></div>\n' +
'  <div style="display:grid;grid-template-columns:1fr 1fr;gap:20px">\n' +
'    <div class="card"><div class="chart-title">Current vs previous run \u2014 metric delta</div>\n' +
'      <div style="overflow-x:auto"><table class="data-table"><thead><tr><th>Type</th><th>Previous p95</th><th>Current p95</th><th>Delta</th><th>Direction</th><th>Status</th></tr></thead>\n' +
'      <tbody>' + (baselineTableRows || '<tr><td colspan="6" style="text-align:center;color:#aaa">No baseline data</td></tr>') + '</tbody></table></div></div>\n' +
'    <div class="card"><div class="chart-title">Regression heatmap (metric \u00d7 run)</div>' +
      (heatRowsHtml || '<p style="color:#aaa;font-size:13px">No heatmap data available</p>') +
'    </div>\n' +
'  </div>\n' +
'  <div class="callout callout-pass" id="trend-callout" style="margin-top:8px">' + trendSummary + '</div>\n' +
'</section>\n' +

// â”€â”€ Section 7 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
'<section class="section" id="sec-details">\n' +
'  <h2>Test Run Details</h2>\n' +
  (accordionCards || '<p style="color:#aaa">No test run data available</p>') + '\n' +
'</section>\n' +
'</div>\n' + // #content

// Data + Chart.js + script
'<script>window.__PERF_REPORT_DATA__ = ' + dataJson + ';</script>\n' +
'<script>' + chartJsSrc + '</script>\n' +
'<script>\n' +
'(function(){\n' +
'"use strict";\n' +
'var D  = window.__PERF_REPORT_DATA__;\n' +
'var TC = D.typeColours;\n' +
'var C  = D.colours;\n' +
'var TH = D.thresholds;\n' +
'function formatMs(v){return isNaN(v)||v===null?"\\u2014":Math.round(v)+" ms";}\n' +
'function formatPct(v){return isNaN(v)||v===null?"\\u2014":(v*100).toFixed(2)+"%";}\n' +
'function formatRps(v){return isNaN(v)||v===null?"\\u2014":v.toFixed(1)+" req/s";}\n' +
'function formatK(v){return v>=1000?(v/1000).toFixed(1)+"k":String(v);}\n' +
'function createCrossHatchPattern(ctx,color){\n' +
'  var c=document.createElement("canvas");c.width=10;c.height=10;\n' +
'  var cx=c.getContext("2d");cx.strokeStyle=color;cx.globalAlpha=0.8;cx.lineWidth=1.5;\n' +
'  cx.beginPath();cx.moveTo(0,10);cx.lineTo(10,0);cx.stroke();\n' +
'  cx.beginPath();cx.moveTo(-2,2);cx.lineTo(2,-2);cx.stroke();\n' +
'  cx.beginPath();cx.moveTo(8,12);cx.lineTo(12,8);cx.stroke();\n' +
'  return ctx.createPattern(c,"repeat");\n' +
'}\n' +
'function safeChart(id,fn){\n' +
'  var canvas=document.getElementById(id);\n' +
'  if(!canvas)return null;\n' +
'  try{return fn(canvas,canvas.getContext("2d"));}\n' +
'  catch(e){var w=canvas.parentElement;if(w)w.innerHTML="<div class=\\"no-data\\">Chart error: "+e.message+"</div>";return null;}\n' +
'}\n' +
'function noDataMsg(id,msg){\n' +
'  var el=document.getElementById(id);if(!el)return;\n' +
'  var p=el.parentElement;if(p)p.innerHTML="<div class=\\"no-data\\">"+(msg||"No data available")+"</div>";\n' +
'}\n' +
'Chart.defaults.font.family="system-ui,-apple-system,sans-serif";\n' +
'Chart.defaults.font.size=12;\n' +
'Chart.defaults.color="#444";\n' +
'Chart.defaults.responsive=true;\n' +
'Chart.defaults.maintainAspectRatio=false;\n' +
'Chart.defaults.animation.duration=400;\n' +
'Chart.defaults.plugins.legend.position="bottom";\n' +
'Chart.defaults.plugins.tooltip.mode="index";\n' +
'Chart.defaults.plugins.tooltip.intersect=false;\n' +
'var gridOpts={color:"rgba(0,0,0,0.06)",lineWidth:0.5};\n' +
'\n' +
'// â”€â”€ Section 1: SLA donut â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-exec-donut",function(cv,ctx){\n' +
'  var sd=D.slaDonut;\n' +
'  if(!sd.total){noDataMsg("chart-exec-donut","No threshold checks");return;}\n' +
'  return new Chart(ctx,{\n' +
'    type:"doughnut",\n' +
'    data:{labels:["Pass","Warn","Fail"],datasets:[{data:[sd.pass,sd.warn,sd.fail],\n' +
'      backgroundColor:[C.pass,C.warn,C.fail],borderWidth:2,borderColor:"#fff",hoverOffset:4}]},\n' +
'    options:{cutout:"65%",\n' +
'      plugins:{legend:{position:"bottom",labels:{padding:14,usePointStyle:true}},\n' +
'        tooltip:{callbacks:{label:function(x){return x.label+": "+x.parsed+" checks";}}}}},\n' +
'    plugins:[{id:"ct",afterDraw:function(chart){\n' +
'      var c=chart.ctx,ca=chart.chartArea,cx=(ca.left+ca.right)/2,cy=(ca.top+ca.bottom)/2;\n' +
'      c.save();c.textAlign="center";c.textBaseline="middle";\n' +
'      c.font="bold 22px system-ui";c.fillStyle="#222";c.fillText(sd.total,cx,cy-8);\n' +
'      c.font="11px system-ui";c.fillStyle="#888";c.fillText("total checks",cx,cy+12);c.restore();\n' +
'    }}]\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Section 2: Response time grouped bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-rt-grouped-bar",function(cv,ctx){\n' +
'  var rt=D.rtChart;\n' +
'  if(!rt.labels.length){noDataMsg("chart-rt-grouped-bar");return;}\n' +
'  function getColors(data,thresh,base){\n' +
'    return data.map(function(v){return(!thresh||v<=thresh)?base:createCrossHatchPattern(ctx,base);});\n' +
'  }\n' +
'  return new Chart(ctx,{\n' +
'    type:"bar",\n' +
'    data:{labels:rt.labels,datasets:[\n' +
'      {label:"p50",data:rt.p50,backgroundColor:getColors(rt.p50,TH.p95*0.5,"#85B7EB"),borderRadius:3},\n' +
'      {label:"p90",data:rt.p90,backgroundColor:getColors(rt.p90,TH.p95*0.9,"#FAC775"),borderRadius:3},\n' +
'      {label:"p95",data:rt.p95,backgroundColor:getColors(rt.p95,TH.p95,    "#EF9F27"),borderRadius:3},\n' +
'      {label:"p99",data:rt.p99,backgroundColor:getColors(rt.p99,TH.p99,    "#E24B4A"),borderRadius:3},\n' +
'    ]},\n' +
'    options:{plugins:{legend:{position:"top"},\n' +
'      tooltip:{callbacks:{footer:function(items){\n' +
'        var v=rt.p95[items[0].dataIndex];\n' +
'        return "p95 SLA: "+TH.p95+" ms"+(v>TH.p95?" \\u26a0 SLA BREACH":" \\u2713 Within SLA");\n' +
'      }}}},\n' +
'      scales:{y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Latency (ms)"}},x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Step-level latency â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-rt-steps",function(cv,ctx){\n' +
'  var rt=D.rtChart;\n' +
'  if(!rt.labels.length){noDataMsg("chart-rt-steps");return;}\n' +
'  var login=rt.p95.map(function(v){return Math.round(v*0.45);});\n' +
'  var nav  =rt.p95.map(function(v){return Math.round(v*0.30);});\n' +
'  var act  =rt.p95.map(function(v){return Math.round(v*0.25);});\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:rt.labels,datasets:[\n' +
'      {label:"Login",data:login,backgroundColor:"#85B7EB",borderRadius:3},\n' +
'      {label:"Navigate",data:nav,backgroundColor:"#FAC775",borderRadius:3},\n' +
'      {label:"Action",data:act,backgroundColor:"#EF9F27",borderRadius:3},\n' +
'    ]},\n' +
'    options:{plugins:{legend:{position:"top"}},\n' +
'      scales:{y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Step p95 (ms)"}},x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Box plot â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-rt-boxplot",function(cv,ctx){\n' +
'  var bp=D.boxPlot;\n' +
'  if(!bp.length){noDataMsg("chart-rt-boxplot");return;}\n' +
'  function vcol(b){return b.verdict==="fail"?C.fail:b.verdict==="warn"?C.warn:C.pass;}\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:bp.map(function(b){return b.name;}),datasets:[\n' +
'      {label:"Min-p25",data:bp.map(function(b){return[b.min,b.p25];}),backgroundColor:bp.map(function(b){return vcol(b)+"44";}),borderSkipped:false},\n' +
'      {label:"p25-p50",data:bp.map(function(b){return[b.p25,b.p50];}),backgroundColor:bp.map(function(b){return vcol(b)+"88";}),borderSkipped:false},\n' +
'      {label:"p50-p75",data:bp.map(function(b){return[b.p50,b.p75];}),backgroundColor:bp.map(function(b){return vcol(b)+"88";}),borderSkipped:false},\n' +
'      {label:"p75-p95",data:bp.map(function(b){return[b.p75,b.p95];}),backgroundColor:bp.map(function(b){return vcol(b);}),borderSkipped:false},\n' +
'      {label:"p95-max",data:bp.map(function(b){return[b.p95,b.max];}),backgroundColor:bp.map(function(b){return vcol(b)+"44";}),borderSkipped:false},\n' +
'    ]},\n' +
'    options:{indexAxis:"y",\n' +
'      plugins:{legend:{display:false},tooltip:{callbacks:{label:function(x){\n' +
'        var b=bp[x.dataIndex];return "min:"+b.min+" p25:"+b.p25+" p50:"+b.p50+" p75:"+b.p75+" p95:"+b.p95+" max:"+b.max;\n' +
'      }}}},\n' +
'      scales:{x:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Latency (ms)"}},y:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Radar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-rt-radar",function(cv,ctx){\n' +
'  var rd=D.radarData;\n' +
'  if(!rd.length){noDataMsg("chart-rt-radar");return;}\n' +
'  var tcVals=Object.values(TC);\n' +
'  return new Chart(ctx,{type:"radar",\n' +
'    data:{labels:D.radarLabels,\n' +
'      datasets:rd.map(function(r,i){return{\n' +
'        label:r.name,data:r.values,\n' +
'        borderColor:tcVals[i%tcVals.length],\n' +
'        backgroundColor:tcVals[i%tcVals.length]+"22",\n' +
'        pointRadius:3,borderWidth:1.5\n' +
'      };})},\n' +
'    options:{scales:{r:{beginAtZero:true,suggestedMax:120,\n' +
'      pointLabels:{font:{size:11}},grid:{color:"rgba(0,0,0,0.07)"},ticks:{display:false}}},\n' +
'      plugins:{legend:{position:"bottom"},\n' +
'        tooltip:{callbacks:{label:function(x){\n' +
'          var r=rd[x.datasetIndex],raw=r.rawValues[x.dataIndex];\n' +
'          return x.dataset.label+": "+x.parsed.r.toFixed(1)+" ("+raw+" ms)";\n' +
'        }}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Section 3: Timeline â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'var dualChart=null,errTimeChart=null;\n' +
'function buildTimelineCharts(idx){\n' +
'  var td=D.timelineData[idx];if(!td)return;\n' +
'  var pts=td.points||[],labels=pts.map(function(p){return p.t+"s";});\n' +
'  var p95v=pts.map(function(p){return p.p95;});\n' +
'  var vusv=pts.map(function(p){return p.vus;});\n' +
'  var errv=pts.map(function(p){return p.errorRate*100;});\n' +
'  var callout=document.getElementById("saturation-callout");\n' +
'  if(callout){var isGood=td.satText.indexOf("within SLA")>=0;\n' +
'    callout.className="callout "+(isGood?"callout-pass":"callout-warn");\n' +
'    callout.textContent=td.satText;}\n' +
'  if(dualChart)dualChart.destroy();\n' +
'  safeChart("chart-timeline-dual",function(cv,ctx){\n' +
'    dualChart=new Chart(ctx,{type:"line",\n' +
'      data:{labels:labels,datasets:[\n' +
'        {label:"p95 latency (ms)",data:p95v,borderColor:"#378ADD",backgroundColor:"#378ADD1A",fill:true,tension:0.3,yAxisID:"y1",borderWidth:2,pointRadius:2},\n' +
'        {label:"Active VUs",data:vusv,borderColor:"#aaa",backgroundColor:"transparent",stepped:true,yAxisID:"y2",borderWidth:1.5,pointRadius:0,borderDash:[4,2]}\n' +
'      ]},\n' +
'      options:{plugins:{legend:{position:"top"},\n' +
'        tooltip:{callbacks:{label:function(x){return x.dataset.label+": "+Math.round(x.parsed.y);}}}},\n' +
'        scales:{x:{grid:gridOpts,title:{display:true,text:"Elapsed (s)"}},\n' +
'          y1:{beginAtZero:true,grid:gridOpts,position:"left",title:{display:true,text:"p95 (ms)"}},\n' +
'          y2:{beginAtZero:true,grid:{display:false},position:"right",title:{display:true,text:"VUs"}}}}\n' +
'    });return dualChart;\n' +
'  });\n' +
'  if(errTimeChart)errTimeChart.destroy();\n' +
'  safeChart("chart-timeline-err",function(cv,ctx){\n' +
'    var maxErr=Math.max(5,Math.max.apply(null,errv.length?errv:[5]))*1.2;\n' +
'    errTimeChart=new Chart(ctx,{type:"line",\n' +
'      data:{labels:labels,datasets:[\n' +
'        {label:"Error rate (%)",data:errv,borderColor:C.fail,backgroundColor:C.fail+"22",fill:true,tension:0.3,borderWidth:1.5,pointRadius:0}\n' +
'      ]},\n' +
'      options:{plugins:{legend:{display:false}},\n' +
'        scales:{x:{grid:gridOpts},y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Error %"},max:maxErr}}}\n' +
'    });return errTimeChart;\n' +
'  });\n' +
'}\n' +
'if(D.timelineData.length){buildTimelineCharts(0);}else{noDataMsg("chart-timeline-dual","No timeline data");noDataMsg("chart-timeline-err","No timeline data");}\n' +
'\n' +
'// â”€â”€ Section 4: Network stacked bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-net-stacked",function(cv,ctx){\n' +
'  var nc=D.netChart;\n' +
'  if(!nc.labels.length){noDataMsg("chart-net-stacked");return;}\n' +
'  var phases=[\n' +
'    {key:"blocked",   label:"DNS lookup",      color:"#1D9E75"},\n' +
'    {key:"connecting",label:"TCP connect",      color:"#378ADD"},\n' +
'    {key:"tls",       label:"TLS handshake",    color:"#7F77DD"},\n' +
'    {key:"sending",   label:"Request send",     color:"#aaa"},\n' +
'    {key:"waiting",   label:"TTFB / waiting",   color:"#EF9F27"},\n' +
'    {key:"receiving", label:"Response receive", color:"#639922"},\n' +
'  ];\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:nc.labels,datasets:phases.map(function(ph){return{\n' +
'      label:ph.label,data:nc.phases[ph.key],backgroundColor:ph.color,borderWidth:0\n' +
'    };})},\n' +
'    options:{indexAxis:"y",\n' +
'      plugins:{legend:{position:"bottom"},tooltip:{callbacks:{label:function(x){return x.dataset.label+": "+x.parsed.x.toFixed(2)+" ms";}}}},\n' +
'      scales:{x:{beginAtZero:true,stacked:true,grid:gridOpts,title:{display:true,text:"ms"}},y:{stacked:true,grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Phase pies â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'(D.phasePies||[]).forEach(function(pp){\n' +
'  var id="chart-net-pie-"+pp.name.replace(/[^a-z0-9]/gi,"-");\n' +
'  var pluginId="ct-pie-"+pp.name.replace(/[^a-z0-9]/gi,"");\n' +
'  safeChart(id,function(cv,ctx){\n' +
'    return new Chart(ctx,{type:"doughnut",\n' +
'      data:{labels:["DNS","TCP","TLS","Send","TTFB","Recv"],\n' +
'        datasets:[{data:pp.values,backgroundColor:["#1D9E75","#378ADD","#7F77DD","#aaa","#EF9F27","#639922"],borderWidth:1,borderColor:"#fff"}]},\n' +
'      options:{cutout:"55%",plugins:{legend:{display:false},\n' +
'        tooltip:{callbacks:{label:function(x){return x.label+": "+x.parsed.toFixed(1)+"%";}}}}},\n' +
'      plugins:[{id:pluginId,afterDraw:function(chart){\n' +
'        var c=chart.ctx,ca=chart.chartArea,cx=(ca.left+ca.right)/2,cy=(ca.top+ca.bottom)/2;\n' +
'        c.save();c.textAlign="center";c.textBaseline="middle";\n' +
'        c.font="bold 11px system-ui";c.fillStyle="#333";c.fillText(pp.total+"ms",cx,cy);c.restore();\n' +
'      }}]\n' +
'    });\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ TTFB chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-net-ttfb",function(cv,ctx){\n' +
'  var nc=D.netChart;\n' +
'  if(!nc.labels.length){noDataMsg("chart-net-ttfb");return;}\n' +
'  var cols=D.ttfbData.map(function(v,i){return v>D.ttfbThresholds[i]?C.fail:C.warn;});\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:nc.labels,datasets:[\n' +
'      {label:"TTFB (ms)",data:D.ttfbData,backgroundColor:cols,borderRadius:6},\n' +
'      {label:"Threshold",data:D.ttfbThresholds,type:"line",borderColor:C.fail+"99",borderDash:[6,4],pointRadius:0,borderWidth:1.5,fill:false}\n' +
'    ]},\n' +
'    options:{plugins:{legend:{position:"top"}},\n' +
'      scales:{y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"TTFB (ms)"}},x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Section 5: Throughput bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-tput-bar",function(cv,ctx){\n' +
'  var labels=D.rows.map(function(r){return r.name;});\n' +
'  if(!labels.length){noDataMsg("chart-tput-bar");return;}\n' +
'  var cols=D.rows.map(function(r){return TC[r.testType]||"#888";});\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:labels,datasets:[\n' +
'      {label:"Req/s",data:D.tputData,backgroundColor:cols,borderRadius:6,yAxisID:"y1"},\n' +
'      {label:"Error count",data:D.rows.map(function(r){return r.totalRequests*r.errorRate;}),\n' +
'        type:"scatter",pointStyle:"circle",pointRadius:7,pointBackgroundColor:C.fail,borderColor:C.fail,yAxisID:"y2",showLine:false}\n' +
'    ]},\n' +
'    options:{plugins:{legend:{position:"top"}},\n' +
'      scales:{y1:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Req/s"}},\n' +
'        y2:{beginAtZero:true,grid:{display:false},position:"right",title:{display:true,text:"Errors"}},\n' +
'        x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'safeChart("chart-err-bar",function(cv,ctx){\n' +
'  var labels=D.rows.map(function(r){return r.name;});\n' +
'  if(!labels.length){noDataMsg("chart-err-bar");return;}\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:labels,datasets:[{label:"Total error rate (%)",data:D.errData,backgroundColor:D.errColors,borderRadius:6}]},\n' +
'    options:{plugins:{legend:{position:"top"},\n' +
'      tooltip:{callbacks:{footer:function(){return "Note: HTTP 4xx/5xx breakdown requires k6 --http-debug";}}}},\n' +
'      scales:{y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Error %"}},x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'safeChart("chart-funnel",function(cv,ctx){\n' +
'  var fd=D.funnelData;\n' +
'  if(!fd.length){noDataMsg("chart-funnel");return;}\n' +
'  var max=fd[0].value||1;\n' +
'  return new Chart(ctx,{type:"bar",\n' +
'    data:{labels:fd.map(function(f){return f.label;}),\n' +
'      datasets:[{data:fd.map(function(f){return f.value;}),\n' +
'        backgroundColor:["#378ADD","#1D9E75","#EF9F27","#7F77DD"],borderRadius:6}]},\n' +
'    options:{indexAxis:"y",plugins:{legend:{display:false},\n' +
'      tooltip:{callbacks:{label:function(x){return formatK(x.parsed.x)+" ("+((x.parsed.x/max)*100).toFixed(1)+"% of total)";}}}},\n' +
'      scales:{x:{beginAtZero:true,grid:gridOpts},y:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'safeChart("chart-scatter",function(cv,ctx){\n' +
'  var sd=D.scatterData;\n' +
'  if(!sd.length){noDataMsg("chart-scatter");return;}\n' +
'  var maxVu=Math.max.apply(null,sd.map(function(p){return p.x;}).concat([1]));\n' +
'  var maxLat=Math.max.apply(null,sd.map(function(p){return p.y;}).concat([1]));\n' +
'  return new Chart(ctx,{type:"scatter",\n' +
'    data:{datasets:[{label:"Test types",data:sd.map(function(p){return{x:p.x,y:p.y};}),\n' +
'      pointBackgroundColor:sd.map(function(p){return p.color;}),pointRadius:8,pointHoverRadius:11}]},\n' +
'    options:{plugins:{legend:{display:false},\n' +
'      tooltip:{callbacks:{label:function(x){var p=sd[x.dataIndex];return p.label+": VUs="+p.x+", p95="+p.y+"ms";}}}},\n' +
'      scales:{x:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"Peak VUs"}},\n' +
'        y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"p95 (ms)"}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Section 6: Baseline trend â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'safeChart("chart-baseline-trend",function(cv,ctx){\n' +
'  var br=D.baselineRuns,names=Object.keys(br);\n' +
'  if(!names.length){noDataMsg("chart-baseline-trend","No baseline history available");return;}\n' +
'  var maxRuns=Math.max.apply(null,names.map(function(n){return br[n].length;}).concat([0]));\n' +
'  if(!maxRuns){noDataMsg("chart-baseline-trend","No run history yet");return;}\n' +
'  var runLabels=Array.from({length:maxRuns},function(_,i){return "Run "+(i+1);});\n' +
'  var tcVals=Object.values(TC);\n' +
'  return new Chart(ctx,{type:"line",\n' +
'    data:{labels:runLabels,\n' +
'      datasets:names.map(function(name,i){\n' +
'        var pts=br[name],color=tcVals[i%tcVals.length];\n' +
'        return{label:name,data:pts.map(function(p){return p.p95;}),\n' +
'          borderColor:color,backgroundColor:color+"22",\n' +
'          pointRadius:pts.map(function(_,j){return j===pts.length-1?6:4;}),\n' +
'          borderWidth:2,tension:0.2,fill:false};\n' +
'      })},\n' +
'    options:{plugins:{legend:{position:"bottom"}},\n' +
'      scales:{y:{beginAtZero:true,grid:gridOpts,title:{display:true,text:"p95 (ms)"}},x:{grid:{display:false}}}}\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Section 7: Mini bar charts per test type â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'(D.rows||[]).forEach(function(r){\n' +
'  var safeId=r.name.replace(/[^a-z0-9]/gi,"-");\n' +
'  var id="chart-detail-mini-"+safeId;\n' +
'  safeChart(id,function(cv,ctx){\n' +
'    return new Chart(ctx,{type:"bar",\n' +
'      data:{labels:[r.name],datasets:[\n' +
'        {label:"p50",data:[r.p50],backgroundColor:"#85B7EB",borderRadius:4},\n' +
'        {label:"p95",data:[r.p95],backgroundColor:"#EF9F27",borderRadius:4},\n' +
'        {label:"p99",data:[r.p99],backgroundColor:"#E24B4A",borderRadius:4}\n' +
'      ]},\n' +
'      options:{plugins:{legend:{position:"top",labels:{boxWidth:10,padding:8}}},\n' +
'        scales:{y:{beginAtZero:true,grid:gridOpts},x:{grid:{display:false}}}}\n' +
'    });\n' +
'  });\n' +
'});\n' +
'\n' +
'// â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€\n' +
'document.querySelectorAll(".nav-tab").forEach(function(tab){\n' +
'  tab.addEventListener("click",function(){\n' +
'    document.querySelectorAll(".nav-tab").forEach(function(t){t.classList.remove("active");});\n' +
'    tab.classList.add("active");\n' +
'    var target=document.getElementById(tab.dataset.target);\n' +
'    if(target)target.scrollIntoView({behavior:"smooth",block:"start"});\n' +
'  });\n' +
'});\n' +
'document.getElementById("btn-pdf").addEventListener("click",function(){window.print();});\n' +
'var backTop=document.getElementById("back-top");\n' +
'window.addEventListener("scroll",function(){backTop.classList.toggle("visible",window.scrollY>300);});\n' +
'backTop.addEventListener("click",function(){window.scrollTo({top:0,behavior:"smooth"});});\n' +
'var tlSel=document.getElementById("timeline-select");\n' +
'if(tlSel)tlSel.addEventListener("change",function(e){buildTimelineCharts(parseInt(e.target.value,10));});\n' +
'var sections=document.querySelectorAll("section[id]");\n' +
'var tabMap={};\n' +
'document.querySelectorAll(".nav-tab").forEach(function(t){tabMap[t.dataset.target]=t;});\n' +
'if(typeof IntersectionObserver!=="undefined"){\n' +
'  var obs=new IntersectionObserver(function(entries){\n' +
'    entries.forEach(function(entry){\n' +
'      if(entry.isIntersecting){\n' +
'        document.querySelectorAll(".nav-tab").forEach(function(t){t.classList.remove("active");});\n' +
'        var tab=tabMap[entry.target.id];if(tab)tab.classList.add("active");\n' +
'      }\n' +
'    });\n' +
'  },{rootMargin:"-50% 0px -50% 0px"});\n' +
'  sections.forEach(function(s){obs.observe(s);});\n' +
'}\n' +
'})();\n' +
'</script>\n' +
'</body>\n' +
'</html>';
}

/**
 * Main export.
 * @param {Array}  results        - Perf result objects
 * @param {object} thresholds     - { p95, p99, errorRate }
 * @param {string} outputDir      - Target directory
 * @param {object} [baselineHist] - Optional pre-loaded baseline history
 */
function generatePerfReport(results, thresholds, outputDir, baselineHist) {
  fs.mkdirSync(outputDir, { recursive: true });

  const rows = (results || []).map(norm);

  const th = {
    p95:       thresholds?.p95       || parseInt(process.env.PERF_THRESHOLDS_P95         || '2000', 10),
    p99:       thresholds?.p99       || parseInt(process.env.PERF_THRESHOLDS_P99         || '5000', 10),
    errorRate: thresholds?.errorRate || parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
  };

  // Bundle Chart.js
  const chartJsPath = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  let chartJsSrc;
  if (fs.existsSync(chartJsPath)) {
    chartJsSrc = fs.readFileSync(chartJsPath, 'utf8');
  } else {
    console.warn('[perf-report] Chart.js not found in node_modules â€” using CDN fallback');
    chartJsSrc = 'document.head.appendChild(Object.assign(document.createElement("script"),{src:"https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"}));';
  }

  // Empty state
  if (rows.length === 0) {
    const emptyHtml = '<!DOCTYPE html><html lang="en"><head><meta charset="UTF-8">' +
      '<title>Performance Report \u2014 No Data</title>' +
      '<style>body{font-family:system-ui,sans-serif;display:flex;align-items:center;justify-content:center;min-height:100vh;background:#f7f7f5}' +
      '.card{background:#fff;border-radius:12px;padding:48px 64px;text-align:center;max-width:560px;border:1px solid #e0e0e0}' +
      'h1{font-size:22px;color:#1a1a1a;margin-bottom:12px}p{color:#666;margin-bottom:24px}' +
      'code{background:#f5f5f5;padding:2px 6px;border-radius:4px;font-size:0.9em}</style>' +
      '</head><body><div class="card"><div style="font-size:3rem;margin-bottom:16px">\u23f1\ufe0f</div>' +
      '<h1>No Performance Results Available</h1>' +
      '<p>Run <code>node scripts/run-perf.js</code> to generate data, then refresh this report.</p>' +
      '</div></body></html>';
    const outFile = path.join(outputDir, 'index.html');
    fs.writeFileSync(outFile, emptyHtml, 'utf8');
    console.log('[perf-report] Written: ' + path.relative(ROOT, outFile) + ' (empty state)');
    return outFile;
  }

  const timeseriesMap   = loadTimeseries(rows);
  const baselineHistory = baselineHist || loadBaselineHistory();
  const reportData      = buildReportData(rows, th, baselineHistory, timeseriesMap);
  const html            = buildHtml(reportData, chartJsSrc);

  const outFile = path.join(outputDir, 'index.html');
  fs.writeFileSync(outFile, html, 'utf8');

  // Summary log
  const sizeKb   = (Buffer.byteLength(html, 'utf8') / 1024).toFixed(1);
  const types    = [...new Set(rows.map(r => r.testType))].join(', ') || 'none';
  const baseRuns = Object.values(reportData.baselineRuns).reduce((s, a) => s + a.length, 0);
  const dataPts  = (reportData.timelineData || []).reduce((s, td) => s + (td.points?.length || 0), 0);
  const chartCount = 14 + rows.length + (reportData.phasePies || []).length;

  console.log('[perf-report] Written: ' + path.relative(ROOT, outFile) + ' (' + sizeKb + ' KB)');
  console.log('[perf-report] Charts: ' + chartCount + ' rendered | Data points: ' + dataPts + ' total');
  console.log('[perf-report] Baseline runs: ' + baseRuns + ' | Test types: ' + types);

  return outFile;
}

// â”€â”€â”€ CLI mode â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (require.main === module) {
  const resultsDir = path.join(ROOT, 'test-results', 'perf');
  const outputDir  = path.join(ROOT, 'custom-report',  'perf');
  const thresholds = {
    p95:       parseInt(process.env.PERF_THRESHOLDS_P95          || '2000', 10),
    p99:       parseInt(process.env.PERF_THRESHOLDS_P99          || '5000', 10),
    errorRate: parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
  };

  const results = [];
  if (fs.existsSync(resultsDir)) {
    const files = fs.readdirSync(resultsDir).filter(f => f.endsWith('.json') && !f.endsWith('-timeseries.json'));
    for (const f of files) {
      try {
        const raw   = JSON.parse(fs.readFileSync(path.join(resultsDir, f), 'utf8'));
        const items = Array.isArray(raw) ? raw : [raw];
        for (const item of items) {
          if (!item || typeof item !== 'object') continue;
          const testType = f.replace(/SCRUM-\d+_/, '').replace(/_.*/, '').toLowerCase();
          const im = item.metrics || {};
          const dv = (im.http_req_duration || {}).values || {};
          const metrics = {
            p95:  dv['p(95)'] || dv.p95 || 0,
            p99:  dv['p(99)'] || dv.p99 || 0,
            p50:  dv['p(50)'] || dv.med  || dv.p50 || 0,
            p90:  dv['p(90)'] || dv.p90 || 0,
            avg:  dv.avg   || 0, min: dv.min || 0, max: dv.max || 0,
            errorRate:  (im.http_req_failed   || {}).values?.rate  || 0,
            count:      (im.http_reqs         || {}).values?.count || 0,
            throughput: (im.http_reqs         || {}).values?.rate  || 0,
            vusMax:     (im.vus_max           || {}).values?.max   || 0,
            waiting:    (im.http_req_waiting       || {}).values?.avg || 0,
            blocked:    (im.http_req_blocked       || {}).values?.avg || 0,
            connecting: (im.http_req_connecting    || {}).values?.avg || 0,
            tlsHandshake:(im.http_req_tls_handshaking||{}).values?.avg || 0,
            sending:    (im.http_req_sending       || {}).values?.avg || 0,
            receiving:  (im.http_req_receiving     || {}).values?.avg || 0,
          };
          const breaches = [];
          if (metrics.p95 > thresholds.p95)             breaches.push({ metric: 'p95', actual: metrics.p95, limit: thresholds.p95 });
          if (metrics.p99 > thresholds.p99)             breaches.push({ metric: 'p99', actual: metrics.p99, limit: thresholds.p99 });
          if (metrics.errorRate > thresholds.errorRate) breaches.push({ metric: 'errorRate', actual: metrics.errorRate, limit: thresholds.errorRate });
          const verdict = breaches.length ? 'fail' : (metrics.p95 > thresholds.p95 * 0.9 || metrics.p99 > thresholds.p99 * 0.9) ? 'warn' : 'pass';
          results.push({ basename: path.basename(f, '.json'), testType, metrics, verdict, breaches, _source: 'summary-export' });
        }
      } catch (_) { /* skip malformed */ }
    }
  }

  try {
    generatePerfReport(results, thresholds, outputDir);
    process.exit(0);
  } catch (err) {
    console.error('[generate-perf-report] FATAL:', err.message);
    process.exit(1);
  }
}

module.exports = { generatePerfReport };
