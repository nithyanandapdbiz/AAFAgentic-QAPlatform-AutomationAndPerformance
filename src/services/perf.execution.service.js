'use strict';
/** @module perf.execution.service — Runs k6 scripts, parses results, evaluates thresholds, and manages baselines. */

const fs            = require('fs');
const path          = require('path');
const { spawnSync } = require('child_process');
const logger        = require('../utils/logger');
const AppError      = require('../core/errorHandler');
const { retry }     = require('../utils/retry');

const ROOT          = path.resolve(__dirname, '..', '..');
const BASELINE_PATH = path.join(ROOT, 'tests', 'perf', 'baselines', 'baseline.json');

// ─── Helpers ────────────────────────────────────────────────────────────────

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
  try {
    const k6Binary = process.env.PERF_K6_BINARY || 'k6';
    const skipSoak = process.env.PERF_SKIP_SOAK === 'true';

    // If soak and PERF_SKIP_SOAK=true, return skipped result
    if (skipSoak && scriptPath.includes('soak')) {
      logger.warn(`[PerfExecution] Skipping soak test (PERF_SKIP_SOAK=true): ${scriptPath}`);
      return { skipped: true, scriptPath, outJsonPath };
    }

    // Ensure output directory exists
    const outDir = path.dirname(outJsonPath);
    fs.mkdirSync(outDir, { recursive: true });

    const envArgs = [];
    if (env.BASE_URL)  envArgs.push('--env', `BASE_URL=${env.BASE_URL}`);
    if (env.VUS)       envArgs.push('--env', `VUS=${env.VUS}`);
    if (env.DURATION)  envArgs.push('--env', `DURATION=${env.DURATION}`);

    // Use a relative path for k6's --out json= argument (relative to ROOT/cwd).
    // Absolute Windows paths with drive letters can be mis-parsed by k6 on Windows.
    const relOutPath = path.relative(ROOT, outJsonPath).replace(/\\/g, '/');

    const args = [
      'run',
      '--out', `json=${relOutPath}`,
      ...envArgs,
      scriptPath,
    ];

    logger.info(`[PerfExecution] Running: ${k6Binary} ${args.join(' ')}`);

    const result = spawnSync(k6Binary, args, {
      cwd:      ROOT,
      encoding: 'utf8',
      env:      { ...process.env, ...env },
    });

    const exitCode = result.status ?? (result.error ? 1 : 0);
    const stdout   = result.stdout || '';
    const stderr   = result.stderr || '';

    if (result.error) {
      throw new AppError(`k6 spawn error: ${result.error.message}`);
    }

    // Exit codes 0 = success, 1 = threshold breach (non-staged), 99 = threshold breach (staged).
    // All three mean k6 ran to completion and the output file is valid.
    const thresholdsBreach = stderr.includes('thresholds on metrics') && stderr.includes('have been crossed');
    if (exitCode !== 0 && exitCode !== 99 && !(exitCode === 1 && thresholdsBreach)) {
      const msg = `k6 exited with code ${exitCode}. stderr: ${stderr.slice(0, 500)}`;
      if (!skipSoak) throw new AppError(msg);
    }

    if (exitCode !== 0) {
      logger.warn(`[PerfExecution] k6 thresholds breached for ${path.basename(scriptPath)} (exit ${exitCode}) — results still available`);
    }

    return { skipped: false, scriptPath, outJsonPath, stdout, stderr, exitCode };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`runPerfTest failed: ${err.message}`);
  }
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
    if (!fs.existsSync(jsonPath)) {
      logger.warn(`[PerfExecution] Result file not found: ${jsonPath}`);
      return {};
    }

    // k6 --out json writes one JSON object per line (NDJSON)
    const raw     = fs.readFileSync(jsonPath, 'utf8');
    const lines   = raw.split('\n').filter(Boolean);

    // The last non-empty line with type==="Point" contains individual samples;
    // the summary object has type==="Metric". We accumulate values from summary lines.
    const summaryLines = lines.filter(l => {
      try { const o = JSON.parse(l); return o.type === 'Metric'; } catch { return false; }
    });

    // Build a metric-name → data map from the last encountered value for each metric
    const metricMap = {};
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        if (obj.type === 'Point' && obj.metric && obj.data) {
          if (!metricMap[obj.metric]) metricMap[obj.metric] = { values: {} };
        }
      } catch { /* skip */ }
    }

    // Prefer summary file format: look for the aggregated summary at end
    // k6 v0.42+ writes a summary JSON when using --out json
    // Fall back to scanning all Point entries and computing percentiles manually
    const aggregated = {};

    // Scan for summary-style lines (k6 summary object written at end)
    for (const line of lines) {
      try {
        const obj = JSON.parse(line);
        // k6 writes summary as: { "type": "Point", "metric": "...", "data": { "value": ..., "tags": {} } }
        // and also writes aggregate summaries for metrics
        if (obj.type === 'Point' && obj.data && obj.data.tags) {
          const m = obj.metric;
          const v = obj.data.value;
          if (!aggregated[m]) aggregated[m] = [];
          aggregated[m].push(v);
        }
      } catch { /* skip */ }
    }

    // Helper: percentile from sorted array
    function pct(arr, p) {
      if (!arr || arr.length === 0) return 0;
      const sorted = [...arr].sort((a, b) => a - b);
      const idx    = Math.ceil((p / 100) * sorted.length) - 1;
      return sorted[Math.max(0, idx)];
    }

    const durations  = aggregated['http_req_duration']  || [];
    const failed     = aggregated['http_req_failed']     || [];
    const reqCounts  = aggregated['http_reqs']           || [];
    const vusMax     = aggregated['vus_max']             || [];

    return {
      p95:         pct(durations, 95),
      p99:         pct(durations, 99),
      avg:         durations.length ? durations.reduce((a, b) => a + b, 0) / durations.length : 0,
      max:         durations.length ? Math.max(...durations) : 0,
      errorRate:   failed.length  ? failed.reduce((a, b) => a + b, 0) / failed.length : 0,
      reqCount:    reqCounts.length,
      reqRate:     reqCounts.length,
      vusMax:      vusMax.length ? Math.max(...vusMax) : 0,
    };
  } catch (err) {
    throw new AppError(`parsePerfResults failed: ${err.message}`);
  }
}

// ─── evaluateThresholds ──────────────────────────────────────────────────────

/**
 * Evaluates metrics against thresholds and returns a verdict.
 *
 * @param {object} metrics    - From parsePerfResults()
 * @param {object} thresholds - { p95, p99, errorRate }
 * @returns {{ verdict: string, breaches: Array }}
 */
function evaluateThresholds(metrics, thresholds) {
  const breaches = [];

  if (metrics.p95 > thresholds.p95) {
    breaches.push({ metric: 'p95', actual: metrics.p95, limit: thresholds.p95 });
  }
  if (metrics.p99 > thresholds.p99) {
    breaches.push({ metric: 'p99', actual: metrics.p99, limit: thresholds.p99 });
  }
  if (metrics.errorRate > thresholds.errorRate) {
    breaches.push({ metric: 'errorRate', actual: metrics.errorRate, limit: thresholds.errorRate });
  }

  let verdict;
  if (metrics.p95 > thresholds.p95 || metrics.errorRate > thresholds.errorRate) {
    verdict = 'fail';
  } else if (metrics.p95 > thresholds.p95 * 0.9) {
    verdict = 'warn';
  } else {
    verdict = 'pass';
  }

  return { verdict, breaches };
}

// ─── updateBaseline ──────────────────────────────────────────────────────────

/**
 * Updates the baseline for a script key (only if verdict is "pass").
 *
 * @param {string} scriptKey  - Unique key (e.g. "SCRUM-5_load")
 * @param {object} metrics    - Current metrics
 * @param {string} verdict    - Current verdict
 */
function updateBaseline(scriptKey, metrics, verdict) {
  try {
    if (verdict !== 'pass') {
      logger.info(`[PerfExecution] Skipping baseline update for ${scriptKey} (verdict: ${verdict})`);
      return;
    }
    const baseline = readBaseline();
    baseline[scriptKey] = {
      p95:       metrics.p95,
      p99:       metrics.p99,
      errorRate: metrics.errorRate,
      updatedAt: new Date().toISOString(),
    };
    writeBaseline(baseline);
    logger.info(`[PerfExecution] Baseline updated for ${scriptKey}: p95=${metrics.p95}ms`);
  } catch (err) {
    throw new AppError(`updateBaseline failed: ${err.message}`);
  }
}

// ─── compareToBaseline ───────────────────────────────────────────────────────

/**
 * Compares current metrics against the stored baseline.
 *
 * @param {string} scriptKey    - Unique key
 * @param {object} metrics      - Current metrics
 * @param {number} [tolerancePct] - Default 0.20 (20%)
 * @returns {{ degraded: boolean, previousP95?: number, changePct?: number }}
 */
function compareToBaseline(scriptKey, metrics, tolerancePct) {
  try {
    const tol      = tolerancePct !== undefined
      ? tolerancePct
      : parseFloat(process.env.PERF_BASELINE_TOLERANCE || '0.20');
    const baseline = readBaseline();
    const stored   = baseline[scriptKey];

    if (!stored) {
      return { degraded: false };
    }

    const changePct = stored.p95 > 0
      ? (metrics.p95 - stored.p95) / stored.p95
      : 0;

    const degraded = changePct > tol;
    return {
      degraded,
      previousP95: stored.p95,
      currentP95:  metrics.p95,
      changePct:   Math.round(changePct * 10000) / 100, // percentage, 2dp
    };
  } catch (err) {
    throw new AppError(`compareToBaseline failed: ${err.message}`);
  }
}

// ─── runAll (convenience for run-perf.js) ────────────────────────────────────

/**
 * Run all k6 scripts found in a directory and return aggregated results.
 * Used by qa-run.js stage injection.
 *
 * @param {object} opts - { storyKey, testResultsDir }
 * @returns {Array}     - Array of result objects
 */
async function runAll(opts = {}) {
  const { storyKey = '', testResultsDir = 'test-results/perf' } = opts;
  const glob = require('fs');
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
    const basename   = path.basename(scriptPath, '.k6.js');
    const outJsonPath = path.join(outDir, `${basename}.json`);
    const runResult  = runPerfTest(scriptPath, outJsonPath, {
      BASE_URL: process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
    });
    if (runResult.skipped) {
      results.push({ scriptPath, skipped: true });
      continue;
    }
    const metrics  = parsePerfResults(outJsonPath);
    const thresholds = {
      p95:       parseInt(process.env.PERF_THRESHOLDS_P95  || '2000', 10),
      p99:       parseInt(process.env.PERF_THRESHOLDS_P99  || '5000', 10),
      errorRate: parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
    };
    const { verdict, breaches } = evaluateThresholds(metrics, thresholds);
    results.push({ scriptPath, metrics, verdict, breaches });
  }
  return results;
}

/**
 * Sync results to Zephyr / create Jira bugs.
 * Used by qa-run.js stage injection.
 *
 * @param {Array}  results
 * @param {object} opts    - { skipBugs }
 */
async function syncResults(results, opts = {}) {
  const { retry: retryFn } = require('../utils/retry');
  const zephyrExec = require('../tools/zephyrExecution.client');
  const jiraBug    = require('../tools/jiraBug.client');

  let tcMap = {};
  const tcMapPath = path.join(ROOT, 'tests', 'perf', 'perf-testcase-map.json');
  if (fs.existsSync(tcMapPath)) {
    try { tcMap = JSON.parse(fs.readFileSync(tcMapPath, 'utf8')); } catch { /* ignore */ }
  }

  for (const r of results) {
    if (r.skipped) continue;
    const basename  = path.basename(r.scriptPath, '.k6.js');
    const statusMap = { pass: 'Pass', warn: 'Blocked', fail: 'Fail' };
    const status    = statusMap[r.verdict] || 'Blocked';

    const tcKey = tcMap[basename];
    if (tcKey) {
      try {
        await retryFn(() => zephyrExec.updateExecution(tcKey, status), 3, 1500);
      } catch (e) {
        logger.warn(`[PerfExecution] Zephyr sync failed for ${basename}: ${e.message}`);
      }
    }

    if (r.verdict === 'fail' && !opts.skipBugs) {
      const breach = (r.breaches || [])[0] || {};
      const bugSummary = `Perf failure: ${basename} — p95 ${breach.actual}ms exceeded ${breach.limit}ms`;
      try {
        await retryFn(() => jiraBug.createBug(
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
  runAll,
  syncResults,
};
