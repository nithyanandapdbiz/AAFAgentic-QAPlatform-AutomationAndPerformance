'use strict';
/** @module run-security — Eight-stage standalone security pipeline: generate config, start ZAP, run scans, evaluate findings, sync, report, pentest, git. */

require('dotenv').config();
const fs     = require('fs');
const http   = require('http');
const path   = require('path');
const { spawn, spawnSync } = require('child_process');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

/** Quick TCP-level ping to ZAP API. Resolves true if ZAP responds within 3s. */
function zapReachable() {
  const zapUrl  = process.env.ZAP_API_URL || 'http://localhost:8080';
  const apiKey  = process.env.ZAP_API_KEY  || 'changeme';
  return new Promise(resolve => {
    const req = http.get(
      `${zapUrl}/JSON/core/view/version/?apikey=${encodeURIComponent(apiKey)}`,
      res => { res.resume(); resolve(res.statusCode === 200); }
    );
    req.setTimeout(3000, () => { req.destroy(); resolve(false); });
    req.on('error', () => resolve(false));
  });
}

/**
 * Spawns the ZAP process in the background without waiting.
 * Returns false (with a log) if ZAP_PATH is missing.
 */
function spawnZapProcess() {
  const zapPath = process.env.ZAP_PATH;
  if (!zapPath || !fs.existsSync(zapPath)) {
    logger.info('[ZAP] ZAP_PATH not set or binary not found — cannot auto-launch');
    return false;
  }
  const port   = (process.env.ZAP_API_URL || 'http://localhost:8080').replace(/.*:/, '');
  const apiKey = process.env.ZAP_API_KEY || 'changeme';
  logger.info(`[ZAP] Spawning ZAP daemon on port ${port} (background)...`);
  const child = spawn(zapPath, [
    '-daemon',
    '-host', '127.0.0.1',
    '-port', port,
    '-config', `api.key=${apiKey}`,
    '-config', 'api.addrs.addr.name=.*',
    '-config', 'api.addrs.addr.regex=true',
  ], {
    cwd:         path.dirname(zapPath),
    detached:    true,
    stdio:       'ignore',
    windowsHide: true,
    shell:       true,
  });
  child.unref();
  return true;
}

/**
 * Polls until ZAP responds or timeout expires.
 * @param {number} timeoutMs  default 90 s
 * @returns {Promise<boolean>}
 */
async function waitForZap(timeoutMs = 90000) {
  const pollMs   = parseInt(process.env.ZAP_POLL_INTERVAL_MS || '2000', 10);
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await zapReachable()) return true;
    logger.info('[ZAP] Waiting for ZAP to be ready...');
    await new Promise(r => setTimeout(r, pollMs));
  }
  return false;
}

/**
 * Convenience: spawn + wait (used when ZAP was not pre-launched).
 * @returns {Promise<boolean>}
 */
async function launchZapDaemon() {
  if (!spawnZapProcess()) return false;
  return waitForZap();
}

const ROOT = path.resolve(__dirname, '..');

// ─── Flag parsing ─────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const flagSet = new Set(args.map(a => a.toLowerCase()));

const flags = {
  skipGenerate: flagSet.has('--skip-generate'),
  noZap:        flagSet.has('--no-zap'),
  skipSync:     flagSet.has('--skip-sync'),
  skipBugs:     flagSet.has('--skip-bugs'),
  skipReport:   flagSet.has('--skip-report'),
  skipGit:      flagSet.has('--skip-git'),
  skipPentest:  flagSet.has('--skip-pentest'),
};

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:  '\x1b[36m', blue:   '\x1b[34m', white: '\x1b[97m',
  magenta: '\x1b[35m',
};

function now()      { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function elapsed(t) { return ((Date.now() - t) / 1000).toFixed(1); }

function stageLog(num, label, status = 'RUNNING') {
  const col = status === 'SKIPPED' ? C.yellow : status.startsWith('DONE') ? C.green : C.cyan;
  console.log(`\n${C.bold}${C.white}Stage ${num} — ${label}${C.reset}  ${col}${status}${C.reset}  ${C.dim}[${now()}]${C.reset}`);
}

// ─── Main pipeline ─────────────────────────────────────────────────────────────
async function main() {
  const pipelineStart = Date.now();

  const storyKey  = process.env.ISSUE_KEY || 'UNKNOWN';
  const targetUrl = process.env.BASE_URL  || 'https://opensource-demo.orangehrmlive.com';

  console.log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Agentic QA — Security Pipeline (8 stages)          ║`);
  console.log(`║  ZAP passive/active + 18 custom checks + Pentest     ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  const secService = require('../src/services/sec.execution.service');

  let allFindings   = [];
  let verdict       = 'pass';
  let zapReportPath = null;
  let zapStarted    = false;
  let customResults = [];

  // ── Pre-flight: start ZAP in background NOW so it warms up during Stage 1 ──
  let zapBootPromise = null;
  const wantZap = !flags.noZap && process.env.ZAP_DOCKER !== 'true'
    && process.env.ZAP_AUTO_LAUNCH === 'true';
  if (wantZap) {
    const alreadyUp = await zapReachable();
    if (alreadyUp) {
      zapBootPromise = Promise.resolve(true);   // already running — nothing to do
      console.log(`${C.dim}  ↗ ZAP already running — ready to scan${C.reset}`);
    } else {
      const spawned = spawnZapProcess();
      if (spawned) {
        zapBootPromise = waitForZap();            // polling runs concurrently with Stage 1
        console.log(`${C.dim}  ↗ ZAP daemon starting in background (will be ready by Stage 2)...${C.reset}`);
      } else {
        // ZAP_PATH not set or binary not found — leave zapBootPromise = null so Stage 2
        // falls into the "skip" branch instead of the misleading "did not start in time" branch.
        zapBootPromise = null;
        console.log(`${C.dim}  ↷ ZAP_PATH not configured — ZAP scan will be skipped${C.reset}`);
      }
    }
  }

  // ── Stage 1 — Generate scan config ──────────────────────────────────────
  stageLog(1, 'Generate security scan config', flags.skipGenerate ? 'SKIPPED' : 'RUNNING');
  const s1 = Date.now();
  if (!flags.skipGenerate) {
    try {
      await require('./generate-sec-scripts').run({ storyKey, baseUrl: targetUrl });
    } catch (err) {
      logger.warn(`[run-security] Stage 1 non-fatal: ${err.message}`);
    }
    stageLog(1, 'Generate security scan config', `DONE (${elapsed(s1)}s)`);
  }

  // ── Stage 2 — Start ZAP ──────────────────────────────────────────────────
  const s2 = Date.now();
  if (flags.noZap) {
    stageLog(2, 'Start OWASP ZAP', 'SKIPPED');
    console.log(`  ${C.dim}↷ ZAP skipped (--no-zap)${C.reset}`);
  } else if (process.env.ZAP_DOCKER === 'true') {
    // Docker path — unchanged
    stageLog(2, 'Start OWASP ZAP', 'RUNNING');
    try {
      const zapState = await secService.startZap({});
      zapStarted = zapState.started;
      if (!zapStarted) {
        console.log(`  ${C.yellow}⚠ ZAP Docker container did not start — continuing with custom checks only${C.reset}`);
        stageLog(2, 'Start OWASP ZAP', `WARN (${elapsed(s2)}s)`);
      } else {
        console.log(`  ${C.green}✓ ZAP ready (version: ${zapState.version})${C.reset}`);
        stageLog(2, 'Start OWASP ZAP', `DONE (${elapsed(s2)}s)`);
      }
    } catch (err) {
      logger.warn(`[run-security] Stage 2 — ZAP Docker start failed: ${err.message}`);
      console.log(`  ${C.yellow}⚠ ZAP start failed — continuing with custom checks only${C.reset}`);
      stageLog(2, 'Start OWASP ZAP', `WARN (${elapsed(s2)}s)`);
    }
  } else if (zapBootPromise) {
    // Auto-launch path — ZAP was pre-spawned before Stage 1; just await the result
    stageLog(2, 'Start OWASP ZAP', 'RUNNING');
    console.log(`  ${C.dim}→ Waiting for ZAP daemon to finish starting...${C.reset}`);
    const ready = await zapBootPromise;
    if (ready) {
      zapStarted = true;
      console.log(`  ${C.green}✓ ZAP ready${C.reset}`);
      stageLog(2, 'Start OWASP ZAP', `DONE (${elapsed(s2)}s)`);
    } else {
      console.log(`  ${C.yellow}⚠ ZAP did not start in time — continuing with custom checks only${C.reset}`);
      console.log(`  ${C.dim}  Check ZAP_PATH in .env or start ZAP manually: zap.bat -daemon -port 8080 -config api.key=${process.env.ZAP_API_KEY || 'changeme'}${C.reset}`);
      stageLog(2, 'Start OWASP ZAP', `WARN (${elapsed(s2)}s)`);
    }
  } else {
    // zapBootPromise is null: either ZAP_AUTO_LAUNCH=false, or ZAP_PATH was not configured.
    stageLog(2, 'Start OWASP ZAP', 'SKIPPED');
    if (wantZap) {
      // ZAP_AUTO_LAUNCH=true but ZAP_PATH not set / binary missing
      console.log(`  ${C.yellow}↷ ZAP_PATH not configured — ZAP scan skipped. Set ZAP_PATH in .env to enable.${C.reset}`);
    } else {
      console.log(`  ${C.dim}↷ ZAP auto-launch disabled — set ZAP_AUTO_LAUNCH=true in .env to enable${C.reset}`);
    }
  }

  // ── Stage 3 — Run scans ──────────────────────────────────────────────────
  stageLog(3, 'Run ZAP + custom security scans', 'RUNNING');
  const s3 = Date.now();

  // All 18 custom check names — always run the full set regardless of config
  const ALL_CHECKS = [
    'missing-security-headers', 'insecure-cookie-flags', 'session-fixation',
    'open-redirect', 'sensitive-data-in-response', 'csrf-token-absence',
    'idor-employee-id', 'sql-injection-signal', 'xss-reflection-signal',
    'broken-auth-brute-force', 'http-methods-allowed', 'server-version-disclosure',
    'cors-misconfiguration', 'clickjacking-protection', 'directory-traversal-signal',
    'user-enumeration', 'password-policy-enforcement', 'information-disclosure-errors',
  ];

  // Load scan config
  const configPath = path.join(ROOT, 'tests', 'security', `${storyKey}-scan-config.json`);
  let zapConfig = null;

  if (fs.existsSync(configPath)) {
    try {
      const cfg = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      zapConfig  = cfg.zapConfig;
    } catch { /* use defaults */ }
  }

  if (!zapConfig) {
    zapConfig = {
      targetUrl:    targetUrl,
      scanType:     process.env.ZAP_SCAN_TYPE || 'full',
      contextName:  `${storyKey}-context`,
      authScript:   true,
      ajaxSpider:   true,
      reportFormat: 'json',
    };
  }

  // Establish authenticated session for checks that need it
  console.log(`  ${C.dim}→ Establishing authenticated session...${C.reset}`);
  const sessionCookies = await secService.getAuthSession(targetUrl);
  if (sessionCookies) {
    console.log(`  ${C.green}✓ Authenticated session ready${C.reset}`);
  } else {
    console.log(`  ${C.yellow}⚠ No auth session — running unauthenticated checks only${C.reset}`);
  }

  // ZAP scan
  if (!flags.noZap && zapStarted && zapConfig) {
    try {
      logger.info('[run-security] Starting ZAP scan...');
      zapReportPath = await secService.runZapScan(zapConfig);
      console.log(`  ${C.green}✓ ZAP scan complete: ${zapReportPath}${C.reset}`);
    } catch (err) {
      logger.warn(`[run-security] ZAP scan failed (non-fatal): ${err.message}`);
      console.log(`  ${C.yellow}⚠ ZAP scan failed: ${err.message}${C.reset}`);
    }
  }

  // Custom checks (sequential) — always run all 18
  console.log(`  Running ${ALL_CHECKS.length} custom security checks...`);
  customResults = await secService.runCustomChecks(ALL_CHECKS, targetUrl, sessionCookies);
  const passedCount = customResults.filter(r => r.passed).length;
  const failedCount = customResults.filter(r => !r.passed).length;
  console.log(`  ${C.green}✓ Custom checks complete: ${passedCount} passed, ${failedCount} flagged${C.reset}`);

  stageLog(3, 'Run ZAP + custom security scans', `DONE (${elapsed(s3)}s)`);

  // ── Stage 4 — Evaluate findings ──────────────────────────────────────────
  stageLog(4, 'Evaluate findings', 'RUNNING');
  const s4 = Date.now();

  const { findings, summary } = secService.parseFindings(zapReportPath, customResults);
  allFindings = [...findings];

  const severityPolicy = {
    failOn:    process.env.ZAP_FAIL_ON || 'high',
    warnOn:    process.env.ZAP_WARN_ON || 'medium',
    maxIssues: parseInt(process.env.ZAP_MAX_ISSUES || '0', 10),
  };
  const evalResult = secService.evaluateSeverity(findings, severityPolicy);
  verdict = evalResult.verdict;

  // Print findings summary table
  console.log(`\n  ${'Finding'.padEnd(40)} ${'OWASP ID'.padEnd(12)} ${'Severity'.padEnd(14)} ${'CVSS'.padEnd(6)} Source`);
  console.log(`  ${'─'.repeat(85)}`);
  for (const f of findings.slice(0, 20)) {
    const sevCol = f.severity === 'critical' ? C.magenta
      : f.severity === 'high'   ? C.red
      : f.severity === 'medium' ? C.yellow : C.dim;
    console.log(
      `  ${f.name.slice(0, 38).padEnd(40)} ${(f.owaspId || '').padEnd(12)} ` +
      `${sevCol}${f.severity.padEnd(14)}${C.reset} ${String(f.cvss).padEnd(6)} ${f.source}`
    );
  }
  if (findings.length > 20) {
    console.log(`  ${C.dim}... and ${findings.length - 20} more findings${C.reset}`);
  }

  const verdictCol = verdict === 'pass' ? C.green : verdict === 'warn' ? C.yellow : C.red;
  console.log(`\n  Overall verdict: ${C.bold}${verdictCol}${verdict.toUpperCase()}${C.reset}`);
  console.log(`  Summary: Critical=${summary.critical} High=${summary.high} Medium=${summary.medium} Low=${summary.low} Info=${summary.informational}`);

  stageLog(4, 'Evaluate findings', `DONE (${elapsed(s4)}s)`);

  // ── Stage 5 — Sync to Zephyr + create Jira bugs ──────────────────────────
  stageLog(5, 'Sync to Zephyr + create Jira bugs', flags.skipSync ? 'SKIPPED' : 'RUNNING');
  const s5 = Date.now();
  if (!flags.skipSync) {
    try {
      await secService.syncToZephyrAndJira(allFindings, verdict, storyKey, { skipBugs: flags.skipBugs });
      console.log(`  ${C.green}✓ Zephyr/Jira sync complete${C.reset}`);
    } catch (err) {
      logger.warn(`[run-security] Stage 5 non-fatal: ${err.message}`);
      console.log(`  ${C.yellow}⚠ Sync error (non-fatal): ${err.message}${C.reset}`);
    }
    stageLog(5, 'Sync to Zephyr + create Jira bugs', `DONE (${elapsed(s5)}s)`);
  }

  // ── Stage 6 — Generate security report ──────────────────────────────────
  stageLog(6, 'Generate security HTML report', flags.skipReport ? 'SKIPPED' : 'RUNNING');
  const s6 = Date.now();
  if (!flags.skipReport) {
    try {
      const { generateSecReport } = require('./generate-sec-report');
      const outputDir = path.join(ROOT, 'custom-report', 'security');
      const meta = {
        zapVersion:            process.env.ZAP_VERSION || '2.14.0',
        scanType:              zapConfig ? (zapConfig.scanType || 'full') : 'custom',
        targetUrl:             targetUrl,
        startTime:             new Date(pipelineStart).toISOString(),
        endTime:               new Date().toISOString(),
        durationSeconds:       Math.round((Date.now() - pipelineStart) / 1000),
        spiderUrls:            summary._spiderUrls   || null,
        passiveAlerts:         summary.informational || null,
        activeAlerts:          (summary.high || 0) + (summary.medium || 0),
        customChecksRun:       customResults.length,
        customChecksPassed:    customResults.filter(r => r.passed).length,
        zapReportPath:         zapReportPath || null,
        jiraStoryUrl:          process.env.JIRA_BASE_URL
          ? `${process.env.JIRA_BASE_URL}/browse/${storyKey}` : null,
        historicalScans:       [],
      };
      generateSecReport(allFindings, verdict, storyKey, outputDir, meta);
      console.log(`  ${C.green}✓ Report written to custom-report/security/index.html${C.reset}`);
    } catch (err) {
      logger.warn(`[run-security] Stage 6 non-fatal: ${err.message}`);
    }
    stageLog(6, 'Generate security HTML report', `DONE (${elapsed(s6)}s)`);
  }

  // Always stop ZAP (even if earlier stages threw)
  if (!flags.noZap && zapStarted) {
    try {
      await secService.stopZap();
      logger.info('[run-security] ZAP stopped');
    } catch { /* ignore */ }
  }

  // ── Stage 7 — Penetration Test ─────────────────────────────────────────────
  const pentestEnabled   = process.env.PENTEST_ENABLED === 'true';
  const skipPentestStage = flags.skipPentest || !pentestEnabled;
  stageLog(7, 'Penetration Test (Nuclei · SQLMap · ffuf · ZAP-Auth)', skipPentestStage ? 'SKIPPED' : 'RUNNING');
  const s7 = Date.now();
  if (!skipPentestStage) {
    try {
      const pentestScript = path.join(ROOT, 'scripts', 'run-pentest.js');
      const pr = spawnSync('node', [pentestScript, '--skip-git', '--skip-sync', '--no-pause'], {
        cwd: ROOT, stdio: 'inherit', env: process.env,
      });
      const pentestOk = (pr.status ?? (pr.error ? 1 : 0)) === 0;
      console.log(`  ${pentestOk ? C.green + '✓' : C.yellow + '⚠'}${C.reset} Pentest ${pentestOk ? 'complete' : 'completed with warnings'}`);
    } catch (err) {
      logger.warn(`[run-security] Stage 7 pentest non-fatal: ${err.message}`);
    }
    stageLog(7, 'Penetration Test', `DONE (${elapsed(s7)}s)`);
  } else {
    const reason = !pentestEnabled
      ? 'set PENTEST_ENABLED=true in .env to enable'
      : '--skip-pentest passed';
    console.log(`  ${C.dim}↷ Pentest skipped — ${reason}${C.reset}`);
  }

  // ── Stage 8 — Git agent ──────────────────────────────────────────────────
  stageLog(8, 'Git Agent — auto-commit + push', flags.skipGit ? 'SKIPPED' : 'RUNNING');
  const s8 = Date.now();
  if (!flags.skipGit) {
    try {
      const gitSync = require('./git-sync');
      if (typeof gitSync.run === 'function') {
        await gitSync.run();
        console.log(`  ${C.green}✓ Git sync complete${C.reset}`);
      }
    } catch (err) {
      logger.warn(`[run-security] Stage 8 non-fatal: ${err.message}`);
    }
    stageLog(8, 'Git Agent — auto-commit + push', `DONE (${elapsed(s8)}s)`);
  }

  // ── Final banner ─────────────────────────────────────────────────────────
  const totalTime       = elapsed(pipelineStart);
  const finalVerdictCol = verdict === 'pass' ? C.green : verdict === 'warn' ? C.yellow : C.red;

  console.log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Security Pipeline Complete                          ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Total findings  : ${String(allFindings.length).padEnd(33)}║`);
  console.log(`║  Critical        : ${C.magenta}${String(summary.critical).padEnd(33)}${C.reset}${C.bold}${C.magenta}║`);
  console.log(`║  High            : ${C.red}${String(summary.high).padEnd(33)}${C.reset}${C.bold}${C.magenta}║`);
  console.log(`║  Medium          : ${C.yellow}${String(summary.medium).padEnd(33)}${C.reset}${C.bold}${C.magenta}║`);
  console.log(`║  Verdict         : ${finalVerdictCol}${verdict.toUpperCase().padEnd(33)}${C.reset}${C.bold}${C.magenta}║`);
  console.log(`║  Total time      : ${String(totalTime + 's').padEnd(33)}║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  process.exit(verdict === 'fail' ? 1 : 0);
}

main().catch(err => {
  logger.error(`[run-security] Fatal: ${err.message}`);
  console.error(`\n${C.red}FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
