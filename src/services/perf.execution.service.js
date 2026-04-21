'use strict';
/** @module perf.execution.service — Runs k6 scripts, parses results, evaluates thresholds, and manages baselines. */

const fs            = require('fs');
const path          = require('path');
const { spawnSync, spawn } = require('child_process');
const logger        = require('../utils/logger');
const AppError      = require('../core/errorHandler');
const { retry }     = require('../utils/retry');
const { perf: perfConfig } = require('../core/config');

const ROOT          = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(ROOT, 'tests', 'perf', 'baselines', 'baseline.json');

// ─── Per-metric baseline tolerances (read from perfConfig) ──────────────────
const BASELINE_TOLERANCES = perfConfig.baselineTolerances;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function readBaseline() {
  try {
    if (!fs.existsSync(BASELINE_PATH)) return {};
    return JSON.parse(fs.readFileSync(BASELINE_PATH, 'utf8'));
  } catch {
    return {};
  }
}

function writeBaseline(data) {
  const dir = path.dirname(BASELINE_PATH);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(BASELINE_PATH, JSON.stringify(data, null, 2), 'utf8');
}

/**
 * Resolve the threshold set for a given test type.
 * Priority: explicit thresholds arg > perfConfig.thresholds[testType] > legacy env vars.
 *
 * @param {object|null} thresholds - Explicit thresholds passed by caller
 * @param {string|null} testType   - Test type key (load/stress/spike/...)
 * @returns {{ p95: number, p99: number, errorRate: number }}
 */
function resolveThresholds(thresholds, testType) {
  if (thresholds && (thresholds.p95 || thresholds.errorRate)) return thresholds;
  if (testType && perfConfig.thresholds[testType]) return perfConfig.thresholds[testType];
  return perfConfig.legacyThresholds;
}

// ─── runPerfTest ─────────────────────────────────────────────────────────────

/**
 * Spawns k6 and runs a performance script.
 *
 * @param {string} scriptPath  - Absolute path to the k6 .js script
 * @param {string} outJsonPath - Where k6 should write its JSON summary
 * @param {object} [env]       - Extra env vars: BASE_URL, VUS, DURATION
 * @returns {object}           - { skipped, stdout, stderr }
 */
function runPerfTest(scriptPath, outJsonPath, env = {}) {
  return (async () => {
  try {
    const k6Binary = perfConfig.k6Binary;
    const skipSoak = perfConfig.skipSoak;

    if (skipSoak && scriptPath.includes('soak')) {
      logger.warn(`[PerfExecution] Skipping soak test (PERF_SKIP_SOAK=true): ${scriptPath}`);
      return { skipped: true, scriptPath, outJsonPath };
    }

    const outDir = path.dirname(outJsonPath);
    fs.mkdirSync(outDir, { recursive: true });

    const envArgs = [];
    if (env.BASE_URL)  envArgs.push('--env', `BASE_URL=${env.BASE_URL}`);
    if (env.VUS)       envArgs.push('--env', `VUS=${env.VUS}`);
    if (env.DURATION)  envArgs.push('--env', `DURATION=${env.DURATION}`);

    const relOutPath        = path.relative(ROOT, outJsonPath).replace(/\\/g, '/');
    const summaryExportPath = outJsonPath.replace(/\.json$/, '-summary.json');
    const relSummaryPath    = path.relative(ROOT, summaryExportPath).replace(/\\/g, '/');

    const args = [
      'run',
      '--out',             `json=${relOutPath}`,
      '--summary-export',  relSummaryPath,
      ...envArgs,
      scriptPath,
    ];

    logger.info(`[PerfExecution] Running: ${k6Binary} ${args.join(' ')}`);

    const result = await new Promise((resolve) => {
      const child = spawn(k6Binary, args, {
        cwd: ROOT,
        env: { ...process.env, ...env },
        windowsHide: true,
      });
      let stdout = '';
      let stderr = '';
      child.stdout.on('data', (d) => { stdout += d.toString(); });
      child.stderr.on('data', (d) => { stderr += d.toString(); });
      child.on('error', (error) => resolve({ status: 1, stdout, stderr, error }));
      child.on('close', (code) => resolve({ status: code, stdout, stderr, error: null }));
    });

    const exitCode = result.status ?? (result.error ? 1 : 0);
    const stdout   = result.stdout || '';
    const stderr   = result.stderr || '';

    if (result.error) {
      throw new AppError(`k6 spawn error: ${result.error.message}`);
    }

    const thresholdsBreach = stderr.includes('thresholds on metrics') && stderr.includes('have been crossed');
    if (exitCode !== 0 && exitCode !== 99 && !(exitCode === 1 && thresholdsBreach)) {
      const msg = `k6 exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`;
      if (!skipSoak) throw new AppError(msg);
    }

    if (exitCode !== 0) {
      logger.warn(`[PerfExecution] k6 thresholds breached for ${path.basename(scriptPath)} (exit ${exitCode}) — results still available`);
    }

    return { skipped: false, scriptPath, outJsonPath, summaryExportPath, stdout, stderr, exitCode };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`runPerfTest failed: ${err.message}`);
  }
  })();
}

// ─── parsePerfResults ────────────────────────────────────────────────────────

/**
 * Reads a k6 JSON summary output file and extracts key metrics.
 *
 * @param {string} jsonPath - Path to the k6 --out json file
 * @returns {object}        - Flat metrics object
 */
function parsePerfResults(jsonPath) {
  try {
    // k6 v1.0.0: stats are FLAT on the metric object (no .values wrapper)
    function mv(metric) {
      if (!metric) return {};
      if (typeof metric.values === 'object' && metric.values !== null) return metric.values;
      return metric;
    }

    const summaryPath = jsonPath.replace(/\.json$/, '-summary.json');
    if (fs.existsSync(summaryPath)) {
      const s = JSON.parse(fs.readFileSync(summaryPath, 'utf8'));
      const m = s.metrics || {};
      const dur         = mv(m.http_req_duration);
      const fail        = mv(m.http_req_failed);
      const reqs        = m.http_reqs         || {};
      const vus         = mv(m.vus_max);
      const waitBlocked = mv(m.http_req_blocked);
      const waitConnect = mv(m.http_req_connecting);
      const waitTLS     = mv(m.http_req_tls_handshaking);
      const waitSending = mv(m.http_req_sending);
      const waitWaiting = mv(m.http_req_waiting);
      const waitReceive = mv(m.http_req_receiving);
      const droppedIt   = mv(m.dropped_iterations || {});
      return {
        p95:               dur['p(95)']             ?? 0,
        p99:               dur['p(99)']  ?? dur.max ?? 0,
        p90:               dur['p(90)']             ?? 0,
        p50:               dur['p(50)']  ?? dur.med ?? 0,
        avg:               dur.avg                  ?? 0,
        min:               dur.min                  ?? 0,
        max:               dur.max                  ?? 0,
        errorRate:         fail.value ?? fail.rate  ?? 0,
        reqCount:          reqs.count               ?? 0,
        reqRate:           reqs.rate                ?? 0,
        vusMax:            vus.max    ?? vus.value  ?? 0,
        blocked:           waitBlocked.avg  ?? 0,
        connecting:        waitConnect.avg  ?? 0,
        tlsHandshake:      waitTLS.avg      ?? 0,
        sending:           waitSending.avg  ?? 0,
        waiting:           waitWaiting.avg  ?? 0,
        receiving:         waitReceive.avg  ?? 0,
        droppedIterations: droppedIt.count  ?? droppedIt.value ?? 0,
        _source:           'summary-export',
      };
    }

    // ── Fallback: parse NDJSON from --out json ──────────────────────────────
    if (!fs.existsSync(jsonPath)) {
      logger.warn(`[PerfExecution] Neither summary-export nor result file found: ${jsonPath}`);
      return {};
    }
    logger.warn('[perf] summary-export missing; percentiles are estimates', { scriptPath: jsonPath });
    const raw  = fs.readFileSync(jsonPath, 'utf8');
    const aggregated = {};
    for (const line of raw.split('\n')) {
      if (!line) continue;
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'Point' && obj.metric && obj.data) {
          if (!aggregated[obj.metric]) aggregated[obj.metric] = [];
          aggregated[obj.metric].push(obj.data.value);
        }
      } catch { /* skip malformed lines */ }
    }
    function pct(arr, p) {
      if (!arr || arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      return sorted[Math.max(0, Math.ceil((p / 100) * sorted.length) - 1)];
    }
    const dur   = aggregated['http_req_duration'] || [];
    const fail  = aggregated['http_req_failed']   || [];
    const reqs  = aggregated['http_reqs']         || [];
    const vmax  = aggregated['vus_max']           || [];
    return {
      p95:               pct(dur, 95),
      p99:               pct(dur, 99),
      p90:               pct(dur, 90),
      p50:               pct(dur, 50),
      avg:               dur.length ? dur.reduce((a, b) => a + b, 0) / dur.length : 0,
      min:               dur.length ? Math.min(...dur) : 0,
      max:               dur.length ? Math.max(...dur) : 0,
      errorRate:         fail.length ? fail.reduce((a, b) => a + b, 0) / fail.length : 0,
      reqCount:          reqs.length,
      reqRate:           reqs.length,
      vusMax:            vmax.length ? Math.max(...vmax) : 0,
      droppedIterations: 0,
      _source:           'ndjson-fallback',
      _warning:          'ndjson-fallback: percentiles are approximations — install k6 v0.43+ for accurate summary-export',
    };
  } catch (err) {
    throw new AppError(`parsePerfResults failed: ${err.message}`);
  }
}

// ─── saveThresholdsForRun ─────────────────────────────────────────────────────

/**
 * Persists the resolved thresholds to test-results/perf/ for report display.
 *
 * @param {string} storyKey  - e.g. "SCRUM-5"
 * @param {string} testType  - e.g. "load"
 * @param {object} thresholds
 */
function saveThresholdsForRun(storyKey, testType, thresholds) {
  try {
    const dir  = path.join(ROOT, 'test-results', 'perf');
    fs.mkdirSync(dir, { recursive: true });
    const file = path.join(dir, `${storyKey}-${testType}-thresholds.json`);
    fs.writeFileSync(file, JSON.stringify({ storyKey, testType, thresholds, savedAt: new Date().toISOString() }, null, 2), 'utf8');
  } catch (e) {
    logger.warn(`[PerfExecution] Could not save thresholds file: ${e.message}`);
  }
}

// ─── evaluateThresholds ──────────────────────────────────────────────────────

/**
 * Evaluates metrics against thresholds and returns a verdict.
 *
 * @param {object} metrics         - From parsePerfResults()
 * @param {object} [thresholds]    - { p95, p99, errorRate } — if omitted, resolved from testType
 * @param {string} [testType=null] - Test type; 'breakpoint' disables enforcement
 * @returns {{ verdict: string, breaches: Array, warnings: Array }}
 */
function evaluateThresholds(metrics, thresholds, testType = null) {
  if (testType === 'breakpoint') {
    return {
      verdict:  'pass',
      breaches: [],
      warnings: [],
      note:     'breakpoint test — thresholds disabled by design',
    };
  }

  const resolved = resolveThresholds(thresholds, testType);
  const breaches = [];
  const warnings = [];
  const warnPct  = perfConfig.warnPct;

  const metricsToCheck = [
    { name: 'p95',       value: metrics.p95       || 0, threshold: resolved.p95       || Infinity },
    { name: 'p99',       value: metrics.p99       || 0, threshold: resolved.p99       || Infinity },
    { name: 'errorRate', value: metrics.errorRate || 0, threshold: resolved.errorRate || Infinity },
  ];

  for (const { name, value, threshold } of metricsToCheck) {
    if (!isFinite(threshold)) continue;
    if (value > threshold) {
      breaches.push({ metric: name, actual: name === 'errorRate' ? +value.toFixed(4) : Math.round(value), limit: threshold });
    } else if (value > threshold * (1 - warnPct)) {
      const pctToLimit = threshold > 0 ? Math.round((value / threshold) * 100) : 0;
      const entry = { metric: name, value, threshold, pctToLimit };
      warnings.push(entry);
      logger.warn('[perf] metric near threshold', entry);
    }
  }

  // dropped_iterations assertion (fail if >= 5, warn if > 0)
  const dropped = metrics.droppedIterations || 0;
  if (dropped >= 5) {
    breaches.push({ metric: 'dropped_iterations', actual: dropped, limit: 5 });
  } else if (dropped > 0) {
    warnings.push({ metric: 'dropped_iterations', value: dropped, threshold: 5, pctToLimit: Math.round((dropped / 5) * 100) });
  }

  let verdict;
  if (breaches.length > 0)       verdict = 'fail';
  else if (warnings.length > 0)  verdict = 'warn';
  else                            verdict = 'pass';

  if (verdict === 'pass' && metrics._warning) {
    verdict = 'warn';
    warnings.push({ metric: 'data-quality', value: metrics._source || 'ndjson-fallback', threshold: 'summary-export', pctToLimit: 0 });
  }

  return { verdict, breaches, warnings };
}

// ─── updateBaseline ──────────────────────────────────────────────────────────

/**
 * Updates the rolling baseline window for a script key (only if verdict is "pass").
 * Stores the last PERF_BASELINE_WINDOW runs per storyKey+testType combination.
 *
 * @param {string} scriptKey  - e.g. "SCRUM-5_load"
 * @param {object} metrics    - Current metrics
 * @param {string} verdict    - Current verdict
 */
function updateBaseline(scriptKey, metrics, verdict) {
  try {
    if (verdict !== 'pass') {
      logger.info(`[PerfExecution] Skipping baseline update for ${scriptKey} (verdict: ${verdict})`);
      return;
    }
    const baseline   = readBaseline();
    const windowSize = perfConfig.baselineWindow;

    if (!baseline[scriptKey] || !baseline[scriptKey].history) {
      baseline[scriptKey] = { history: [] };
    }

    const entry = {
      p95:        metrics.p95,
      p99:        metrics.p99,
      avg:        metrics.avg,
      errorRate:  metrics.errorRate,
      reqRate:    metrics.reqRate,
      recordedAt: new Date().toISOString(),
    };

    baseline[scriptKey].history.push(entry);
    if (baseline[scriptKey].history.length > windowSize) {
      baseline[scriptKey].history = baseline[scriptKey].history.slice(-windowSize);
    }

    // Flat fields for backward-compat
    baseline[scriptKey].p95       = metrics.p95;
    baseline[scriptKey].p99       = metrics.p99;
    baseline[scriptKey].avg       = metrics.avg;
    baseline[scriptKey].errorRate = metrics.errorRate;
    baseline[scriptKey].reqRate   = metrics.reqRate;
    baseline[scriptKey].updatedAt = entry.recordedAt;

    writeBaseline(baseline);
    logger.info(`[PerfExecution] Baseline updated for ${scriptKey}: p95=${metrics.p95}ms (window=${baseline[scriptKey].history.length})`);
  } catch (err) {
    throw new AppError(`updateBaseline failed: ${err.message}`);
  }
}

// ─── compareToBaseline ───────────────────────────────────────────────────────

/**
 * Compares current metrics against the stored rolling-window baseline.
 * Computes per-metric degradation flags and overall trend direction.
 *
 * @param {string} scriptKey - e.g. "SCRUM-5_load"
 * @param {object} metrics   - Current metrics
 * @returns {object}
 */
function compareToBaseline(scriptKey, metrics) {
  try {
    const tol      = BASELINE_TOLERANCES;
    const baseline = readBaseline();
    const stored   = baseline[scriptKey];

    if (!stored || !stored.p95) {
      return { degraded: false };
    }

    const changePct              = stored.p95 > 0 ? (metrics.p95 - stored.p95) / stored.p95 : 0;
    const degraded               = changePct > tol.p95;

    const changePct99            = stored.p99 && stored.p99 > 0 ? (metrics.p99 - stored.p99) / stored.p99 : 0;
    const baselineDegradedP99    = changePct99 > tol.p99;

    const changeAvg              = stored.avg && stored.avg > 0 ? (metrics.avg - stored.avg) / stored.avg : 0;
    const baselineDegradedAvg    = changeAvg > tol.avg;

    const prevErrorRate          = stored.errorRate || 0;
    const errDelta               = (metrics.errorRate || 0) - prevErrorRate;
    const baselineErrorRateIncreased = errDelta > tol.errorRate;

    const prevReqRate            = stored.reqRate || 0;
    const reqRateChange          = prevReqRate > 0 ? (prevReqRate - (metrics.reqRate || 0)) / prevReqRate : 0;
    const baselineRpsDegraded    = reqRateChange > tol.reqRate;

    // Rolling window trend analysis across last 3 runs
    let trend = 'stable';
    const history = (stored.history || []).map(h => h.p95).filter(v => v > 0);
    if (history.length >= 3) {
      const recent  = history.slice(-3);
      const first   = recent[0];
      const last    = recent[recent.length - 1];
      const winChg  = first > 0 ? (last - first) / first : 0;
      if (winChg > 0.05)       trend = 'degrading';
      else if (winChg < -0.05) trend = 'improving';
    }

    return {
      degraded,
      previousP95:  stored.p95,
      currentP95:   metrics.p95,
      changePct:    Math.round(changePct * 10000) / 100,

      baselineDegradedP99,
      previousP99:  stored.p99 || null,
      currentP99:   metrics.p99,
      changePct99:  Math.round(changePct99 * 10000) / 100,

      baselineDegradedAvg,
      previousAvg:  stored.avg || null,
      currentAvg:   metrics.avg,
      changePctAvg: Math.round(changeAvg * 10000) / 100,

      baselineErrorRateIncreased,
      previousErrorRate: prevErrorRate,
      currentErrorRate:  metrics.errorRate || 0,

      baselineRpsDegraded,
      previousReqRate:   prevReqRate,
      currentReqRate:    metrics.reqRate || 0,

      trend,
      historyWindow: history,
    };
  } catch (err) {
    throw new AppError(`compareToBaseline failed: ${err.message}`);
  }
}

// ─── runAll (convenience for qa-run.js injection) ────────────────────────────

/**
 * Run all k6 scripts found in tests/perf/ and return aggregated results.
 *
 * @param {object} opts - { storyKey, testResultsDir }
 * @returns {Array}
 */
async function runAll(opts = {}) {
  const { storyKey = '', testResultsDir = 'test-results/perf' } = opts;
  const perfDir = path.join(ROOT, 'tests', 'perf');

  function findScripts(dir) {
    const results = [];
    if (!fs.existsSync(dir)) return results;
    for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) results.push(...findScripts(full));
      else if (entry.name.endsWith('.k6.js')) results.push(full);
    }
    return results;
  }

  const scripts  = findScripts(perfDir).filter(s => !storyKey || s.includes(storyKey));
  const outDir   = path.join(ROOT, testResultsDir);
  fs.mkdirSync(outDir, { recursive: true });

  const results = [];
  for (const scriptPath of scripts) {
    const basename    = path.basename(scriptPath, '.k6.js');
    const outJsonPath = path.join(outDir, `${basename}.json`);
    const parts       = basename.split('_');
    const testType    = parts[parts.length - 1] || 'load';

    const runResult = await runPerfTest(scriptPath, outJsonPath, {
      BASE_URL: process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
    });
    if (runResult.skipped) {
      results.push({ scriptPath, skipped: true });
      continue;
    }
    const metrics  = parsePerfResults(outJsonPath);
    const resolved = resolveThresholds(null, testType);
    const { verdict, breaches, warnings } = evaluateThresholds(metrics, resolved, testType);
    results.push({ scriptPath, metrics, verdict, breaches, warnings });
  }
  return results;
}

// ─── syncResults ─────────────────────────────────────────────────────────────

/**
 * Sync results to Zephyr (one execution per test type) and optionally create Jira bugs.
 *
 * @param {Array}  results
 * @param {object} opts    - { skipBugs }
 */
async function syncResults(results, opts = {}) {
  const zephyrExec = require('../tools/zephyrExecution.client');
  const jiraBug    = require('../tools/jiraBug.client');

  let tcMap = {};
  const tcMapPath = path.join(ROOT, 'tests', 'perf', 'perf-testcase-map.json');
  if (fs.existsSync(tcMapPath)) {
    try { tcMap = JSON.parse(fs.readFileSync(tcMapPath, 'utf8')); } catch { /* ignore */ }
  }

  const verdictToStatus = { pass: 'Pass', warn: 'Blocked', fail: 'Fail', 'data-invalid': 'Not Executed' };

  for (const r of results) {
    if (r.skipped) continue;
    const basename = path.basename(r.scriptPath, '.k6.js');
    const parts    = basename.split('_');
    const testType = parts[parts.length - 1] || 'load';
    const storyKey = parts.slice(0, -1).join('_') || process.env.ISSUE_KEY || 'UNKNOWN';
    const status   = verdictToStatus[r.verdict] || 'Blocked';
    const m        = r.metrics || {};

    const comment = [
      `Test type  : ${testType}`,
      `p95        : ${Math.round(m.p95 || 0)} ms`,
      `p99        : ${Math.round(m.p99 || 0)} ms`,
      `Error rate : ${((m.errorRate || 0) * 100).toFixed(2)}%`,
      `Max VUs    : ${m.vusMax || 0}`,
      r.changePct   != null ? `Baseline Dp95 : ${r.changePct > 0 ? '+' : ''}${r.changePct}%`    : null,
      r.changePct99 != null ? `Baseline Dp99 : ${r.changePct99 > 0 ? '+' : ''}${r.changePct99}%` : null,
      r.trend       != null ? `Trend         : ${r.trend}`                                          : null,
    ].filter(Boolean).join('\n');

    const tcKey = tcMap[basename] || tcMap[`${storyKey}_${testType}`] || tcMap[storyKey];
    if (tcKey) {
      try {
        await retry(() => zephyrExec.updateExecution
          ? zephyrExec.updateExecution(tcKey, status, comment)
          : zephyrExec.createExecution(process.env.ZEPHYR_CYCLE_KEY || '', tcKey, status, { comment }),
        3, 1500);
      } catch (e) {
        logger.warn(`[PerfExecution] Zephyr sync failed for ${basename}: ${e.message}`);
      }
    }

    if (r.verdict === 'fail' && !opts.skipBugs) {
      const breach     = (r.breaches || [])[0] || {};
      const bugSummary = `Perf failure: ${basename} — p95 ${breach.actual}ms exceeded ${breach.limit}ms`;
      try {
        await retry(() => jiraBug.createBug(
          { title: bugSummary, error: JSON.stringify(r.breaches, null, 2), file: r.scriptPath },
          process.env.ISSUE_KEY
        ), 3, 1500);
      } catch (e) {
        logger.warn(`[PerfExecution] Jira bug creation failed for ${basename}: ${e.message}`);
      }
    }
  }
}

module.exports = {
  runPerfTest,
  parsePerfResults,
  evaluateThresholds,
  updateBaseline,
  compareToBaseline,
  saveThresholdsForRun,
  resolveThresholds,
  runAll,
  syncResults,
};
