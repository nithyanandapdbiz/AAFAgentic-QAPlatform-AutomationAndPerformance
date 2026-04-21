'use strict';
/**
 * @deprecated Use `node scripts/run-full-pipeline.js --use-runner --include-perf --include-security`
 *             or call `require('../src/pipeline/runner').runPipeline(PRESETS.full, ctx)` directly.
 *             This script is kept for backward compatibility and will be removed in a future major release.
 *
 * @module run-qa-complete — Unified 14-stage QA pipeline orchestrating functional (Playwright), performance (k6), and security (OWASP ZAP + custom checks) testing.
 */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const { execFileSync } = require('child_process');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..');

// ─── Flag parsing ─────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const flagSet = new Set(args.map(a => a.toLowerCase()));

const flags = {
  skipFunctional: flagSet.has('--skip-functional'),
  skipPerf:       flagSet.has('--skip-perf'),
  skipSecurity:   flagSet.has('--skip-security'),
  noZap:          flagSet.has('--no-zap'),
  skipBugs:       flagSet.has('--skip-bugs'),
  skipGit:        flagSet.has('--skip-git'),
  headless:       flagSet.has('--headless'),
};

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:  '\x1b[36m', blue:   '\x1b[34m', white: '\x1b[97m',
  magenta: '\x1b[35m',
};

function now()      { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function elapsed(t) { return ((Date.now() - t) / 1000).toFixed(1); }

function stageLog(num, label, status = 'RUNNING') {
  const col = status === 'SKIPPED' ? C.yellow
    : status.startsWith('DONE')    ? C.green
    : C.cyan;
  console.log(`\n${C.bold}${C.white}Stage ${num} — ${label}${C.reset}  ${col}${status}${C.reset}  ${C.dim}[${now()}]${C.reset}`);
}

// ─── Pillars helpers ──────────────────────────────────────────────────────────
function safeStat(filePath) {
  try { return fs.statSync(filePath); } catch { return null; }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pipelineStart = Date.now();

  const storyKey  = process.env.ISSUE_KEY || 'UNKNOWN';
  const targetUrl = process.env.BASE_URL  || 'https://opensource-demo.orangehrmlive.com';

  // ─── Stores for pillar results ─────────────────────────────────────────────
  const results = {
    functional: { status: flags.skipFunctional ? 'skipped' : 'pending', passed: 0, failed: 0, skipped: 0 },
    perf:       { status: flags.skipPerf       ? 'skipped' : 'pending', verdict: 'n/a', violations: 0 },
    security:   { status: flags.skipSecurity   ? 'skipped' : 'pending', verdict: 'n/a', critical: 0, high: 0, medium: 0 },
  };

  // Services / modules (loaded lazily)
  let secService     = null;
  let secFindings    = [];
  let secVerdict     = 'pass';
  let zapStarted     = false;
  let zapReportPath  = null;
  let collectedPerfResults = [];  // populated in Stage 4b, consumed in Stages 5b + 6

  console.log(`\n${C.bold}${C.white}╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  Agentic QA Platform — Complete Run (14 stages)               ║`);
  console.log(`║  Story: ${storyKey.padEnd(55)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝${C.reset}\n`);

  const activeFlags = Object.entries(flags)
    .filter(([, v]) => v)
    .map(([k]) => `--${k.replace(/([A-Z])/g, '-$1').toLowerCase()}`);
  if (activeFlags.length) console.log(`  Flags: ${C.dim}${activeFlags.join(' ')}${C.reset}\n`);

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 1 — Ensure output directories exist
  // ══════════════════════════════════════════════════════════════════════════
  stageLog(1, 'Ensure output directories');
  const s1 = Date.now();
  try {
    require('./ensure-dirs').ensureDirs();
    stageLog(1, 'Ensure output directories', `DONE (${elapsed(s1)}s)`);
  } catch (err) {
    logger.warn(`Stage 1 non-fatal: ${err.message}`);
    stageLog(1, 'Ensure output directories', `WARN (${elapsed(s1)}s)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 2 — Planner Agent (story analysis)
  // ══════════════════════════════════════════════════════════════════════════
  stageLog(2, 'Planner Agent — analyse story', 'RUNNING');
  const s2 = Date.now();
  let plannerResult = null;
  try {
    const plannerAgent = require('../src/agents/planner.agent');
    const description  = process.env.STORY_DESCRIPTION || process.env.ISSUE_KEY || 'full qa run';
    plannerResult = await plannerAgent.analyse({ key: storyKey, description });
    console.log(`  ${C.green}✓ Types detected: ${JSON.stringify(plannerResult.types)}${C.reset}`);
    stageLog(2, 'Planner Agent — analyse story', `DONE (${elapsed(s2)}s)`);
  } catch (err) {
    logger.warn(`Stage 2 non-fatal: ${err.message}`);
    stageLog(2, 'Planner Agent — analyse story', `WARN (${elapsed(s2)}s)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 3a — Generate functional Playwright tests
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('3a', 'Generate Playwright test files', flags.skipFunctional ? 'SKIPPED' : 'RUNNING');
  const s3a = Date.now();
  if (!flags.skipFunctional) {
    try {
      const gen = require('./generate-tests');
      if (typeof gen.run === 'function') await gen.run({ storyKey });
      stageLog('3a', 'Generate Playwright test files', `DONE (${elapsed(s3a)}s)`);
    } catch (err) {
      logger.warn(`Stage 3a non-fatal: ${err.message}`);
      stageLog('3a', 'Generate Playwright test files', `WARN (${elapsed(s3a)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 3b — Generate k6 performance scripts
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('3b', 'Generate k6 performance scripts', flags.skipPerf ? 'SKIPPED' : 'RUNNING');
  const s3b = Date.now();
  if (!flags.skipPerf) {
    try {
      const genPerf = require('./generate-perf-scripts');
      await genPerf.run({ storyKey, baseUrl: targetUrl });
      stageLog('3b', 'Generate k6 performance scripts', `DONE (${elapsed(s3b)}s)`);
    } catch (err) {
      logger.warn(`Stage 3b non-fatal: ${err.message}`);
      stageLog('3b', 'Generate k6 performance scripts', `WARN (${elapsed(s3b)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 3c — Generate security scan config
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('3c', 'Generate security scan config', flags.skipSecurity ? 'SKIPPED' : 'RUNNING');
  const s3c = Date.now();
  if (!flags.skipSecurity) {
    try {
      await require('./generate-sec-scripts').run({ storyKey, baseUrl: targetUrl });
      stageLog('3c', 'Generate security scan config', `DONE (${elapsed(s3c)}s)`);
    } catch (err) {
      logger.warn(`Stage 3c non-fatal: ${err.message}`);
      stageLog('3c', 'Generate security scan config', `WARN (${elapsed(s3c)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 4a — Run Playwright functional tests
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('4a', 'Run Playwright functional tests', flags.skipFunctional ? 'SKIPPED' : 'RUNNING');
  const s4a = Date.now();
  if (!flags.skipFunctional) {
    try {
      const headlessArg = flags.headless ? '--headless' : '';
      const cmd  = `node scripts/qa-run.js ${headlessArg}`.trim().split(' ');
      execFileSync(process.execPath, cmd.slice(1), {
        cwd: ROOT,
        stdio: 'inherit',
        env: { ...process.env, ISSUE_KEY: storyKey },
      });
      results.functional.status = 'pass';
      stageLog('4a', 'Run Playwright functional tests', `DONE (${elapsed(s4a)}s)`);
    } catch (err) {
      results.functional.status = 'fail';
      logger.warn(`Stage 4a: ${err.message}`);
      stageLog('4a', 'Run Playwright functional tests', `WARN — tests may have failures (${elapsed(s4a)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 4b — Run k6 performance tests
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('4b', 'Run k6 performance tests', flags.skipPerf ? 'SKIPPED' : 'RUNNING');
  const s4b = Date.now();
  if (!flags.skipPerf) {
    try {
      const perfService = require('../src/services/perf.execution.service');
      collectedPerfResults = await perfService.runAll({ storyKey, baseUrl: targetUrl });
      // Derive aggregate verdict from the array of individual results
      const worstVerdict = collectedPerfResults.some(r => r.verdict === 'fail') ? 'fail'
        : collectedPerfResults.some(r => r.verdict === 'warn') ? 'warn' : 'pass';
      const totalBreaches = collectedPerfResults.reduce((sum, r) => sum + (r.breaches || []).length, 0);
      results.perf.status     = worstVerdict;
      results.perf.verdict    = worstVerdict;
      results.perf.violations = totalBreaches;
      stageLog('4b', 'Run k6 performance tests', `DONE (${elapsed(s4b)}s)`);
    } catch (err) {
      results.perf.status  = 'warn';
      results.perf.verdict = 'warn';
      logger.warn(`Stage 4b non-fatal: ${err.message}`);
      stageLog('4b', 'Run k6 performance tests', `WARN (${elapsed(s4b)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 4c — Start ZAP + run security scans
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('4c', 'Run ZAP + custom security scans', flags.skipSecurity ? 'SKIPPED' : 'RUNNING');
  const s4c = Date.now();
  if (!flags.skipSecurity) {
    secService = require('../src/services/sec.execution.service');

    // Start ZAP — only attempt if ZAP_DOCKER=true or ZAP_API_URL is set
    const zapConfigured = !flags.noZap && (process.env.ZAP_DOCKER === 'true' || process.env.ZAP_API_URL);
    if (zapConfigured) {
      try {
        const zapState = await secService.startZap({});
        zapStarted = zapState.started;
        if (zapStarted) {
          logger.info(`[complete] ZAP started: version ${zapState.version}`);
        } else {
          logger.warn('[complete] ZAP not available — continuing with custom checks only');
        }
      } catch (err) {
        logger.warn(`Stage 4c ZAP start non-fatal: ${err.message}`);
      }
    } else if (!flags.noZap) {
      logger.info('[complete] ZAP skipped — ZAP_DOCKER is not true and ZAP_API_URL is not set');
    }

    // Load config
    const configPath = path.join(ROOT, 'tests', 'security', `${storyKey}-scan-config.json`);
    let zapConfig = null;
    let checkNames = [
      'missing-security-headers', 'insecure-cookie-flags', 'session-fixation',
      'open-redirect', 'sensitive-data-in-response', 'csrf-token-absence',
      'idor-employee-id', 'sql-injection-signal', 'xss-reflection-signal',
      'broken-auth-brute-force',
    ];

    if (fs.existsSync(configPath)) {
      try {
        const cfg  = JSON.parse(fs.readFileSync(configPath, 'utf8'));
        zapConfig  = cfg.zapConfig;
        checkNames = cfg.customChecks || checkNames;
      } catch { /* use defaults */ }
    }

    if (!zapConfig) {
      zapConfig = {
        targetUrl:   targetUrl,
        scanType:    process.env.ZAP_SCAN_TYPE || 'baseline',
        contextName: `${storyKey}-context`,
        reportFormat: 'json',
      };
    }

    // ZAP scan
    if (!flags.noZap && zapStarted) {
      try {
        zapReportPath = await secService.runZapScan(zapConfig);
        console.log(`  ${C.green}✓ ZAP scan complete${C.reset}`);
      } catch (err) {
        logger.warn(`ZAP scan non-fatal: ${err.message}`);
      }
    }

    // Custom checks
    const customResults = await secService.runCustomChecks(checkNames, targetUrl, '');

    const { findings, summary } = secService.parseFindings(zapReportPath, customResults);
    secFindings = findings;

    const policy = {
      failOn:    process.env.ZAP_FAIL_ON || 'high',
      warnOn:    process.env.ZAP_WARN_ON || 'medium',
      maxIssues: parseInt(process.env.ZAP_MAX_ISSUES || '0', 10),
    };
    const evalResult = secService.evaluateSeverity(secFindings, policy);
    secVerdict = evalResult.verdict;

    results.security.status   = secVerdict;
    results.security.verdict  = secVerdict;
    results.security.critical = summary.critical;
    results.security.high     = summary.high;
    results.security.medium   = summary.medium;

    stageLog('4c', 'Run ZAP + custom security scans', `DONE (${elapsed(s4c)}s)`);
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 5a — Sync functional results to Zephyr/Jira
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('5a', 'Sync functional results to Zephyr/Jira',
    (flags.skipFunctional || flags.skipBugs) ? 'SKIPPED' : 'DONE (synced inside qa-run.js above)');

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 5b — Sync perf results to Zephyr/Jira
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('5b', 'Sync perf results to Zephyr/Jira', (flags.skipPerf || flags.skipBugs) ? 'SKIPPED' : 'RUNNING');
  const s5b = Date.now();
  if (!flags.skipPerf && !flags.skipBugs) {
    try {
      const perfService = require('../src/services/perf.execution.service');
      if (typeof perfService.syncResults === 'function' && collectedPerfResults.length > 0) {
        await perfService.syncResults(collectedPerfResults, { skipBugs: flags.skipBugs });
        console.log(`  ${C.green}✓ Perf sync complete${C.reset}`);
      } else if (collectedPerfResults.length === 0) {
        console.log(`  ${C.dim}No perf results to sync${C.reset}`);
      }
      stageLog('5b', 'Sync perf results to Zephyr/Jira', `DONE (${elapsed(s5b)}s)`);
    } catch (err) {
      logger.warn(`Stage 5b non-fatal: ${err.message}`);
      stageLog('5b', 'Sync perf results to Zephyr/Jira', `WARN (${elapsed(s5b)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 5c — Sync security results to Zephyr/Jira
  // ══════════════════════════════════════════════════════════════════════════
  stageLog('5c', 'Sync security results to Zephyr/Jira', (flags.skipSecurity || flags.skipBugs) ? 'SKIPPED' : 'RUNNING');
  const s5c = Date.now();
  if (!flags.skipSecurity && !flags.skipBugs && secService) {
    try {
      await secService.syncToZephyrAndJira(secFindings, secVerdict, storyKey, { skipBugs: flags.skipBugs });
      console.log(`  ${C.green}✓ Security sync complete${C.reset}`);
      stageLog('5c', 'Sync security results to Zephyr/Jira', `DONE (${elapsed(s5c)}s)`);
    } catch (err) {
      logger.warn(`Stage 5c non-fatal: ${err.message}`);
      stageLog('5c', 'Sync security results to Zephyr/Jira', `WARN (${elapsed(s5c)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 6 — Generate reports (functional + perf + security)
  // ══════════════════════════════════════════════════════════════════════════
  stageLog(6, 'Generate all HTML reports', 'RUNNING');
  const s6 = Date.now();

  if (!flags.skipPerf) {
    try {
      const { generatePerfReport } = require('./generate-perf-report');
      const perfDir = path.join(ROOT, 'custom-report', 'perf');
      generatePerfReport(collectedPerfResults, null, perfDir);
      console.log(`  ${C.green}✓ Perf report generated${C.reset}`);
    } catch (err) { logger.warn(`Perf report non-fatal: ${err.message}`); }
  }

  if (!flags.skipSecurity) {
    try {
      const { generateSecReport } = require('./generate-sec-report');
      const secDir = path.join(ROOT, 'custom-report', 'security');
      generateSecReport(secFindings, secVerdict, storyKey, secDir);
      console.log(`  ${C.green}✓ Security report generated${C.reset}`);
    } catch (err) { logger.warn(`Security report non-fatal: ${err.message}`); }
  }

  stageLog(6, 'Generate all HTML reports', `DONE (${elapsed(s6)}s)`);

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 7 — Stop ZAP
  // ══════════════════════════════════════════════════════════════════════════
  stageLog(7, 'Stop OWASP ZAP', (!flags.skipSecurity && !flags.noZap && zapStarted) ? 'RUNNING' : 'SKIPPED');
  if (!flags.skipSecurity && !flags.noZap && zapStarted && secService) {
    try {
      await secService.stopZap();
      console.log(`  ${C.green}✓ ZAP stopped${C.reset}`);
    } catch { /* ignore */ }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Stage 8 — Git agent sync
  // ══════════════════════════════════════════════════════════════════════════
  stageLog(8, 'Git Agent — auto-commit + push', flags.skipGit ? 'SKIPPED' : 'RUNNING');
  const s8 = Date.now();
  if (!flags.skipGit) {
    try {
      const gitSync = require('./git-sync');
      if (typeof gitSync.run === 'function') {
        await gitSync.run();
        console.log(`  ${C.green}✓ Git sync complete${C.reset}`);
      }
      stageLog(8, 'Git Agent — auto-commit + push', `DONE (${elapsed(s8)}s)`);
    } catch (err) {
      logger.warn(`Stage 8 non-fatal: ${err.message}`);
      stageLog(8, 'Git Agent — auto-commit + push', `WARN (${elapsed(s8)}s)`);
    }
  }

  // ══════════════════════════════════════════════════════════════════════════
  // Final tri-panel summary banner
  // ══════════════════════════════════════════════════════════════════════════
  const totalTime = elapsed(pipelineStart);

  function panelLine(label, val, colour) {
    const str = `  ${label}: ${colour}${val}${C.reset}`;
    return str;
  }

  const fColour = results.functional.status === 'pass' ? C.green
    : results.functional.status === 'skipped' ? C.dim : C.red;
  const pColour = results.perf.verdict === 'pass' ? C.green
    : results.perf.verdict === 'n/a' ? C.dim : results.perf.verdict === 'warn' ? C.yellow : C.red;
  const sColour = results.security.verdict === 'pass' ? C.green
    : results.security.verdict === 'n/a' ? C.dim : results.security.verdict === 'warn' ? C.yellow : C.red;

  const overallFail = (results.functional.status === 'fail') ||
                      (results.perf.verdict === 'fail')       ||
                      (results.security.verdict === 'fail');
  const overallColour = overallFail ? C.red : C.green;
  const overallLabel  = overallFail ? 'FAIL' : 'PASS';

  console.log(`\n${C.bold}${C.white}╔═══════════════════════════════════════════════════════════════╗`);
  console.log(`║  QA COMPLETE — RESULTS SUMMARY                                ║`);
  console.log(`╠════════════════════════╦══════════════╦═══════════════════════╣`);
  console.log(`║ FUNCTIONAL             ║ PERFORMANCE  ║ SECURITY              ║`);
  console.log(`╠════════════════════════╬══════════════╬═══════════════════════╣`);
  console.log(`║ ${fColour}${String(results.functional.status.toUpperCase()).padEnd(22)}${C.reset}${C.bold}${C.white}║ ${pColour}${String(results.perf.verdict.toUpperCase()).padEnd(12)}${C.reset}${C.bold}${C.white}║ ${sColour}${String(results.security.verdict.toUpperCase()).padEnd(21)}${C.reset}${C.bold}${C.white}║`);
  console.log(`║                        ║ violations:  ║ Critical: ${String(results.security.critical).padEnd(11)}║`);
  console.log(`║                        ║ ${String(results.perf.violations).padEnd(12)} ║ High:     ${String(results.security.high).padEnd(11)}║`);
  console.log(`║                        ║              ║ Medium:   ${String(results.security.medium).padEnd(11)}║`);
  console.log(`╠════════════════════════╩══════════════╩═══════════════════════╣`);
  console.log(`║  Overall: ${overallColour}${overallLabel.padEnd(6)}${C.reset}${C.bold}${C.white}     Total time: ${String(totalTime + 's').padEnd(28)}║`);
  console.log(`╚═══════════════════════════════════════════════════════════════╝${C.reset}\n`);

  process.exit(overallFail ? 1 : 0);
}

main().catch(err => {
  logger.error(`[run-qa-complete] Fatal: ${err.message}`);
  console.error(`\n${C.red}FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
