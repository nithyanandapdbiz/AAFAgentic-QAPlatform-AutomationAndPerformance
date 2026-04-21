'use strict';
/** @module run-security — Seven-stage standalone security pipeline: generate config, start ZAP, run scans, evaluate findings, sync, report, git. */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

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
  console.log(`║  Agentic QA — Security Pipeline (7 stages)          ║`);
  console.log(`╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  const secService = require('../src/services/sec.execution.service');

  let allFindings   = [];
  let verdict       = 'pass';
  let zapReportPath = null;
  let zapStarted    = false;

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
  stageLog(2, 'Start OWASP ZAP', flags.noZap ? 'SKIPPED' : 'RUNNING');
  const s2 = Date.now();
  if (!flags.noZap) {
    try {
      const zapState = await secService.startZap({});
      zapStarted = zapState.started;
      if (!zapStarted) {
        console.log(`  ${C.yellow}⚠ ZAP not available — continuing with custom checks only${C.reset}`);
      } else {
        console.log(`  ${C.green}✓ ZAP ready (version: ${zapState.version})${C.reset}`);
      }
    } catch (err) {
      logger.warn(`[run-security] Stage 2 — ZAP start failed: ${err.message}`);
      console.log(`  ${C.yellow}⚠ ZAP start failed — continuing with custom checks only${C.reset}`);
    }
    stageLog(2, 'Start OWASP ZAP', `DONE (${elapsed(s2)}s)`);
  }

  // ── Stage 3 — Run scans ──────────────────────────────────────────────────
  stageLog(3, 'Run ZAP + custom security scans', 'RUNNING');
  const s3 = Date.now();

  // Load scan config
  const configPath = path.join(ROOT, 'tests', 'security', `${storyKey}-scan-config.json`);
  let zapConfig    = null;
  let checkNames   = ALL_CHECKS;

  // Re-derive check names from the registry via a simple approach
  const ALL_CHECKS = [
    'missing-security-headers', 'insecure-cookie-flags', 'session-fixation',
    'open-redirect', 'sensitive-data-in-response', 'csrf-token-absence',
    'idor-employee-id', 'sql-injection-signal', 'xss-reflection-signal',
    'broken-auth-brute-force',
  ];

  if (fs.existsSync(configPath)) {
    try {
      const cfg  = JSON.parse(fs.readFileSync(configPath, 'utf8'));
      zapConfig  = cfg.zapConfig;
      checkNames = cfg.customChecks || ALL_CHECKS;
    } catch { checkNames = ALL_CHECKS; }
  } else {
    checkNames = ALL_CHECKS;
    zapConfig  = {
      targetUrl:    targetUrl,
      scanType:     process.env.ZAP_SCAN_TYPE || 'baseline',
      contextName:  `${storyKey}-context`,
      authScript:   false,
      ajaxSpider:   false,
      reportFormat: 'json',
    };
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

  // Custom checks (sequential)
  console.log(`  Running ${checkNames.length} custom security checks...`);
  const customResults = await secService.runCustomChecks(checkNames, targetUrl, '');
  console.log(`  ${C.green}✓ Custom checks complete (${customResults.length} checks run)${C.reset}`);

  stageLog(3, 'Run ZAP + custom security scans', `DONE (${elapsed(s3)}s)`);

  // ── Stage 4 — Evaluate findings ──────────────────────────────────────────
  stageLog(4, 'Evaluate findings', 'RUNNING');
  const s4 = Date.now();

  const { findings, summary } = secService.parseFindings(zapReportPath, customResults);
  allFindings = findings;

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
      await secService.syncToZephyrAndJira(findings, verdict, storyKey, { skipBugs: flags.skipBugs });
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
      generateSecReport(findings, verdict, storyKey, outputDir);
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

  // ── Stage 7 — Git agent ──────────────────────────────────────────────────
  stageLog(7, 'Git Agent — auto-commit + push', flags.skipGit ? 'SKIPPED' : 'RUNNING');
  const s7 = Date.now();
  if (!flags.skipGit) {
    try {
      const gitSync = require('./git-sync');
      if (typeof gitSync.run === 'function') {
        await gitSync.run();
        console.log(`  ${C.green}✓ Git sync complete${C.reset}`);
      }
    } catch (err) {
      logger.warn(`[run-security] Stage 7 non-fatal: ${err.message}`);
    }
    stageLog(7, 'Git Agent — auto-commit + push', `DONE (${elapsed(s7)}s)`);
  }

  // ── Final banner ─────────────────────────────────────────────────────────
  const totalTime       = elapsed(pipelineStart);
  const finalVerdictCol = verdict === 'pass' ? C.green : verdict === 'warn' ? C.yellow : C.red;

  console.log(`\n${C.bold}${C.magenta}╔══════════════════════════════════════════════════════╗`);
  console.log(`║  Security Pipeline Complete                          ║`);
  console.log(`╠══════════════════════════════════════════════════════╣`);
  console.log(`║  Total findings  : ${String(findings.length).padEnd(33)}║`);
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
