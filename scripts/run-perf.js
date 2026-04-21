'use strict';
/** @module run-perf — Six-stage standalone performance pipeline: generate scripts, execute k6, evaluate thresholds, sync Zephyr/Jira, generate report, git sync. */

require('dotenv').config();
const fs   = require('fs');
const path = require('path');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

const ROOT = path.resolve(__dirname, '..');

// ─── Flag parsing ────────────────────────────────────────────────────────────
const args     = process.argv.slice(2);
const flagSet  = new Set(args.map(a => a.toLowerCase()));

function getFlag(prefix) {
  const a = args.find(a => a.startsWith(prefix));
  return a ? a.slice(prefix.length) : undefined;
}

const flags = {
  skipGenerate: flagSet.has('--skip-generate'),
  skipSync:     flagSet.has('--skip-sync'),
  skipBugs:     flagSet.has('--skip-bugs'),
  skipReport:   flagSet.has('--skip-report'),
  skipGit:      flagSet.has('--skip-git'),
  testType:     getFlag('--test-type='),
};

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan: '\x1b[36m', blue: '\x1b[34m', white: '\x1b[97m',
};

function now()      { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function elapsed(t) { return ((Date.now() - t) / 1000).toFixed(1); }

function stageLog(num, label, status = 'RUNNING') {
  const col = status === 'SKIPPED' ? C.yellow : status === 'DONE' ? C.green : C.cyan;
  console.log(`\n${C.bold}${C.white}Stage ${num} — ${label}${C.reset}  ${col}${status}${C.reset}  ${C.dim}[${now()}]${C.reset}`);
}

// ─── Glob helper ─────────────────────────────────────────────────────────────
function findK6Scripts(dir, typeFilter) {
  const results = [];
  if (!fs.existsSync(dir)) return results;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      // Recurse into every sub-directory; typeFilter is applied at file level below
      results.push(...findK6Scripts(full, typeFilter));
    } else if (entry.name.endsWith('.k6.js')) {
      if (!typeFilter || full.includes(path.sep + typeFilter + path.sep)) {
        results.push(full);
      }
    }
  }
  return results;
}

// ─── Main pipeline ────────────────────────────────────────────────────────────
async function main() {
  const pipelineStart = Date.now();
  let totalRun = 0, passCount = 0, warnCount = 0, failCount = 0;

  console.log(`\n${C.bold}${C.blue}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Agentic QA — Performance Pipeline (6 stages)       ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  const thresholds = {
    p95:       parseInt(process.env.PERF_THRESHOLDS_P95  || '2000', 10),
    p99:       parseInt(process.env.PERF_THRESHOLDS_P99  || '5000', 10),
    errorRate: parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
  };

  const allResults = [];

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 1 — Generate k6 scripts
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(1, 'Generate k6 performance scripts', flags.skipGenerate ? 'SKIPPED' : 'RUNNING');
  const s1 = Date.now();
  if (!flags.skipGenerate) {
    try {
      const genModule = require('./generate-perf-scripts');
      const genResult = await genModule.run({
        storyKey: process.env.ISSUE_KEY,
        baseUrl:  process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
        testType: flags.testType,
      });
      if (!genResult.perfRequired) {
        console.log(`  ${C.yellow}No performance signals found — no scripts generated.${C.reset}`);
      } else {
        console.log(`  ${C.green}Generated ${genResult.scripts.length} script(s).${C.reset}`);
      }
    } catch (err) {
      logger.error(`[run-perf] Stage 1 error: ${err.message}`);
      console.error(`  ${C.red}Stage 1 failed: ${err.message}${C.reset}`);
    }
  }
  stageLog(1, 'Generate k6 performance scripts', `DONE (${elapsed(s1)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 2 — Execute k6 scripts
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(2, 'Execute k6 scripts', 'RUNNING');
  const s2 = Date.now();

  const perfDir    = path.join(ROOT, 'tests', 'perf');
  const outBaseDir = path.join(ROOT, 'test-results', 'perf');
  fs.mkdirSync(outBaseDir, { recursive: true });

  const scripts = findK6Scripts(perfDir, flags.testType);
  if (scripts.length === 0) {
    console.log(`  ${C.yellow}No k6 scripts found in tests/perf/.${C.reset}`);
  }

  const {
    runPerfTest, parsePerfResults, evaluateThresholds, compareToBaseline, updateBaseline
  } = require('../src/services/perf.execution.service');

  for (const scriptPath of scripts) {
    const basename    = path.basename(scriptPath, '.k6.js');
    const outJsonPath = path.join(outBaseDir, `${basename}.json`);
    console.log(`  Running: ${basename}`);
    try {
      const runResult = runPerfTest(scriptPath, outJsonPath, {
        BASE_URL: process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
        VUS:      process.env.PERF_VUS_MAX,
      });
      if (runResult.skipped) {
        console.log(`  ${C.yellow}⟳ Skipped (soak): ${basename}${C.reset}`);
        continue;
      }
      const metrics  = parsePerfResults(outJsonPath);
      const { verdict, breaches } = evaluateThresholds(metrics, thresholds);

      const parts    = basename.split('_');
      const testType = parts[parts.length - 1] || 'load';
      const storyKey = parts.slice(0, -1).join('_') || process.env.ISSUE_KEY || 'UNKNOWN';
      const baseline = compareToBaseline(`${storyKey}_${testType}`, metrics);

      allResults.push({
        scriptPath, basename, testType, storyKey,
        metrics, verdict, breaches,
        baselineDegraded: baseline.degraded,
        previousP95:      baseline.previousP95,
        changePct:        baseline.changePct,
      });
      totalRun++;
    } catch (err) {
      logger.error(`[run-perf] Script failed: ${basename}: ${err.message}`);
      console.error(`  ${C.red}✗ ${basename}: ${err.message}${C.reset}`);
      allResults.push({ scriptPath, basename, verdict: 'fail', breaches: [], metrics: {} });
      totalRun++;
    }
  }

  stageLog(2, 'Execute k6 scripts', `DONE (${elapsed(s2)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 3 — Evaluate thresholds + baseline comparison
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(3, 'Evaluate thresholds + baseline comparison', 'RUNNING');
  const s3 = Date.now();

  console.log(`\n  ${'Script'.padEnd(40)} ${'p95'.padEnd(8)} ${'p99'.padEnd(8)} ${'ErrRate'.padEnd(10)} Verdict`);
  console.log(`  ${'─'.repeat(80)}`);

  for (const r of allResults) {
    // Degrade pass→warn if baseline is degraded
    if (r.baselineDegraded && r.verdict === 'pass') r.verdict = 'warn';

    const m = r.metrics || {};
    const verdictLabel = r.verdict === 'pass'
      ? `${C.green}pass${C.reset}`
      : r.verdict === 'warn'
        ? `${C.yellow}warn${C.reset}`
        : `${C.red}fail${C.reset}`;

    console.log(
      `  ${r.basename.padEnd(40)} ${String(Math.round(m.p95 || 0)).padEnd(8)} ` +
      `${String(Math.round(m.p99 || 0)).padEnd(8)} ` +
      `${String((m.errorRate || 0).toFixed(4)).padEnd(10)} ` +
      verdictLabel
    );

    // Update baseline for passing scripts
    if (r.verdict === 'pass') {
      updateBaseline(`${r.storyKey}_${r.testType}`, m, r.verdict);
    }

    if (r.verdict === 'pass')      passCount++;
    else if (r.verdict === 'warn') warnCount++;
    else                           failCount++;
  }

  stageLog(3, 'Evaluate thresholds + baseline comparison', `DONE (${elapsed(s3)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 4 — Sync to Zephyr + create Jira bugs
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(4, 'Sync to Zephyr + create Jira bugs', flags.skipSync ? 'SKIPPED' : 'RUNNING');
  const s4 = Date.now();
  if (!flags.skipSync) {
    try {
      const { retry } = require('../src/utils/retry');
      const zephyrExec = require('../src/tools/zephyrExecution.client');
      const jiraBug    = require('../src/tools/jiraBug.client');
      const { createExecution } = zephyrExec;

      const tcMapPath = path.join(ROOT, 'tests', 'perf', 'perf-testcase-map.json');
      let tcMap = {};
      if (fs.existsSync(tcMapPath)) {
        try { tcMap = JSON.parse(fs.readFileSync(tcMapPath, 'utf8')); } catch { /* ignore */ }
      }

      const verdictToZephyr = { pass: 'Pass', warn: 'Blocked', fail: 'Fail' };

      for (const r of allResults) {
        const status = verdictToZephyr[r.verdict] || 'Blocked';
        const tcKey  = tcMap[r.basename];

        if (tcKey) {
          try {
            await retry(() => createExecution(
              process.env.ZEPHYR_CYCLE_KEY || '',
              tcKey,
              status,
              { comment: `Perf test: p95=${Math.round((r.metrics || {}).p95 || 0)}ms` }
            ), 3, 1500);
            console.log(`  ${C.green}✓ Zephyr synced: ${r.basename} → ${status}${C.reset}`);
          } catch (e) {
            logger.warn(`[run-perf] Zephyr sync failed for ${r.basename}: ${e.message}`);
          }
        } else {
          console.log(`  ${C.dim}No Zephyr test case mapped for: ${r.basename}${C.reset}`);
        }

        if (r.verdict === 'fail' && !flags.skipBugs) {
          const breach = (r.breaches || [])[0] || {};
          const bugSummary = `Perf failure: ${r.basename} — p95 ${breach.actual}ms exceeded ${breach.limit}ms`;
          const breachDetails = (r.breaches || [])
            .map(b => `  - ${b.metric}: actual=${b.actual}, limit=${b.limit}`)
            .join('\n');

          try {
            await retry(() => jiraBug.createBug(
              { title: bugSummary, error: breachDetails, file: r.scriptPath },
              process.env.ISSUE_KEY
            ), 3, 1500);
            console.log(`  ${C.red}🐛 Jira bug created: ${r.basename}${C.reset}`);
          } catch (e) {
            logger.warn(`[run-perf] Jira bug creation failed for ${r.basename}: ${e.message}`);
          }
        }
      }
    } catch (err) {
      logger.error(`[run-perf] Stage 4 error: ${err.message}`);
      console.error(`  ${C.yellow}Stage 4 non-fatal error: ${err.message}${C.reset}`);
    }
  }
  if (!flags.skipSync) stageLog(4, 'Sync to Zephyr + create Jira bugs', `DONE (${elapsed(s4)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 5 — Generate performance report
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(5, 'Generate performance HTML report', flags.skipReport ? 'SKIPPED' : 'RUNNING');
  const s5 = Date.now();
  if (!flags.skipReport) {
    try {
      const { generatePerfReport } = require('./generate-perf-report');
      const outputDir = path.join(ROOT, 'custom-report', 'perf');
      generatePerfReport(allResults, thresholds, outputDir);
      console.log(`  ${C.green}✓ Report written to custom-report/perf/index.html${C.reset}`);
    } catch (err) {
      logger.error(`[run-perf] Stage 5 error: ${err.message}`);
      console.error(`  ${C.yellow}Stage 5 non-fatal error: ${err.message}${C.reset}`);
    }
  }
  if (!flags.skipReport) stageLog(5, 'Generate performance HTML report', `DONE (${elapsed(s5)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Stage 6 — Git agent
  // ──────────────────────────────────────────────────────────────────────────
  stageLog(6, 'Git Agent — auto-commit + push', flags.skipGit ? 'SKIPPED' : 'RUNNING');
  const s6 = Date.now();
  if (!flags.skipGit) {
    try {
      const gitSync = require('./git-sync');
      if (typeof gitSync.run === 'function') {
        await gitSync.run();
        console.log(`  ${C.green}✓ Git sync complete${C.reset}`);
      } else {
        logger.warn('[run-perf] git-sync.js does not export a run() function — skipping git stage');
      }
    } catch (err) {
      logger.error(`[run-perf] Stage 6 error: ${err.message}`);
      console.error(`  ${C.yellow}Stage 6 non-fatal error: ${err.message}${C.reset}`);
    }
  }
  if (!flags.skipGit) stageLog(6, 'Git Agent — auto-commit + push', `DONE (${elapsed(s6)}s)`);

  // ──────────────────────────────────────────────────────────────────────────
  // Final banner
  // ──────────────────────────────────────────────────────────────────────────
  const totalTime = elapsed(pipelineStart);
  console.log(`\n${C.bold}${C.white}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Performance Pipeline Complete                       ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Scripts run : ${String(totalRun).padEnd(37)}║`);
  console.log(`║  Pass        : ${C.green}${String(passCount).padEnd(37)}${C.reset}${C.bold}${C.white}║`);
  console.log(`║  Warn        : ${C.yellow}${String(warnCount).padEnd(37)}${C.reset}${C.bold}${C.white}║`);
  console.log(`║  Fail        : ${C.red}${String(failCount).padEnd(37)}${C.reset}${C.bold}${C.white}║`);
  console.log(`║  Total time  : ${String(totalTime + 's').padEnd(37)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);
}

main().catch(err => {
  logger.error(`[run-perf] Fatal: ${err.message}`);
  console.error(`\n${C.red}FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
