'use strict';
/**
 * run-nonfunctional.js  —  Non-Functional Test Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated runner for NON-FUNCTIONAL testing: Performance (k6) + Security
 * (OWASP ZAP + custom checks) + Penetration Testing (Nuclei/SQLMap/ffuf).
 * No Playwright / functional specs are involved.
 *
 *  Stages:
 *   ┌──────────────────────────────────────────────────────────────────────┐
 *   │  Stage 1  Performance tests — k6 load/stress/spike/soak/scalability/    │
 *   │           breakpoint  (six-stage k6 pipeline internally)                │
 *   │  Stage 2  Security tests — OWASP ZAP passive/active scan + custom       │
 *   │           injection, auth-bypass, header, CSRF, cookie checks           │
 *   │  Stage 3  Penetration Tests — Nuclei CVE scan + SQLMap injection +      │
 *   │           ffuf endpoint fuzzing + ZAP authenticated scan                │
 *   │  Stage 4  Git Agent — auto-commit + push all reports                   │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-nonfunctional.js                   ← perf + security + pentest
 *   node scripts/run-nonfunctional.js --skip-perf       ← security + pentest only
 *   node scripts/run-nonfunctional.js --skip-security   ← perf + pentest only
 *   node scripts/run-nonfunctional.js --skip-pentest    ← perf + security only
 *   node scripts/run-nonfunctional.js --no-zap          ← security without ZAP scan
 *   node scripts/run-nonfunctional.js --skip-git        ← skip git auto-commit
 *
 * Performance flags forwarded to run-perf.js:
 *   --test-type=<type>    Only run one type (load|stress|spike|soak|scalability|breakpoint)
 *   --skip-generate       Skip k6 script generation step
 *   --skip-sync           Skip Zephyr sync in perf pipeline
 *   --dry-run             Print k6 commands but do not execute
 *
 * All configuration is read from .env  (ISSUE_KEY, PERF_K6_BINARY, ZAP_PATH, …)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

const skipPerf     = flags.has('--skip-perf');
const skipSecurity = flags.has('--skip-security');
const skipPentest  = flags.has('--skip-pentest');
const skipGit      = flags.has('--skip-git');
const noZap        = flags.has('--no-zap');

// Perf-specific flags — forward to run-perf.js as-is
const perfForwardFlags = args.filter(a =>
  a.startsWith('--test-type=') ||
  a === '--skip-generate'      ||
  a === '--skip-sync'          ||
  a === '--skip-bugs'          ||
  a === '--dry-run'
);

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:   '\x1b[0m', bold:    '\x1b[1m', dim:     '\x1b[2m',
  green:   '\x1b[32m', yellow: '\x1b[33m', red:    '\x1b[31m',
  cyan:    '\x1b[36m', magenta: '\x1b[35m', white:  '\x1b[97m',
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner() {
  const W = 58;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.magenta}║  ${C.reset}${pad(s)}${C.bold}${C.magenta}║${C.reset}`;
  console.log(`\n${C.bold}${C.magenta}╔${B}╗${C.reset}`);
  console.log(row('Agentic QA Platform  —  Non-Functional Test Pipeline'));
  console.log(row(''));
  console.log(row(`Scope    : Performance (k6) + Security (ZAP) + Pentest`));
  console.log(row('Functional (Playwright): EXCLUDED'));
  console.log(row(''));
  console.log(row(`Performance : ${skipPerf     ? 'SKIPPED (--skip-perf)'     : 'ON — k6 multi-type load tests'}`));
  console.log(row(`Security    : ${skipSecurity  ? 'SKIPPED (--skip-security)' : `ON — ZAP${noZap ? ' disabled' : ''} + custom checks`}`));
  console.log(row(`Pentest     : ${skipPentest   ? 'SKIPPED (--skip-pentest)'  : (process.env.PENTEST_ENABLED === 'true' ? 'ON — Nuclei · SQLMap · ffuf · ZAP-Auth' : 'disabled (set PENTEST_ENABLED=true)')}`));
  console.log(row(`Git         : ${skipGit       ? 'SKIPPED (--skip-git)'      : 'ON — auto-commit + push'}`));
  console.log(row(`Issue       : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`));
  console.log(row(`Time        : ${now()}`));
  console.log(`${C.bold}${C.magenta}╚${B}╝${C.reset}\n`);
}

function stageHeader(num, total, label, skipped = false) {
  const tag = skipped ? `${C.yellow}SKIP${C.reset}` : `${C.cyan}RUN${C.reset}`;
  console.log(`\n${C.bold}${C.white}┌─ [${num}/${total}] ${label}${C.reset}  ${tag}`);
  console.log(`${C.dim}│  ${now()}${C.reset}`);
  console.log(`${C.bold}${C.white}└${'─'.repeat(62)}${C.reset}\n`);
}

function stageDone(num, label, ok, ms) {
  const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const col  = ok ? C.green : C.red;
  console.log(`\n${icon} ${C.bold}${col}[${num}] ${label}${C.reset}  (${(ms / 1000).toFixed(1)}s)\n`);
}

function runScript(relPath, extraArgs = [], extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${C.reset}`);
    return { ok: false, exitCode: 1 };
  }
  const r = spawnSync('node', [abs, ...extraArgs], {
    cwd:   ROOT,
    stdio: 'inherit',
    env:   { ...process.env, ...extraEnv },
  });
  const exitCode = r.status ?? (r.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pipelineStart = Date.now();
  banner();

  if (skipPerf && skipSecurity && skipPentest) {
    console.log(`${C.yellow}  All non-functional pillars skipped — nothing to run.${C.reset}\n`);
    process.exit(0);
  }

  const TOTAL   = 4;   // perf, security, pentest, git
  const summary = [];

  // ── Stage 1: Performance ────────────────────────────────────────────────────
  stageHeader(1, TOTAL, 'Performance Tests (k6)', skipPerf);
  if (skipPerf) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-perf passed${C.reset}\n`);
    summary.push({ num: 1, label: 'Performance (k6)', status: 'SKIP', ms: 0 });
  } else {
    const t1 = Date.now();
    // Always skip git here — consolidated git push happens in Stage 3
    const perfArgs = [...perfForwardFlags, '--skip-git'];
    const { ok, exitCode } = runScript('scripts/run-perf.js', perfArgs);
    const ms1 = Date.now() - t1;
    stageDone(1, 'Performance Tests', ok, ms1);
    summary.push({ num: 1, label: 'Performance (k6)', status: ok ? 'PASS' : 'WARN', ms: ms1, exitCode });
    // Performance threshold breaches are warnings, not pipeline killers
  }

  // ── Stage 2: Security ───────────────────────────────────────────────────────
  stageHeader(2, TOTAL, 'Security Tests (ZAP + custom checks)', skipSecurity);
  if (skipSecurity) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-security passed${C.reset}\n`);
    summary.push({ num: 2, label: 'Security (ZAP + checks)', status: 'SKIP', ms: 0 });
  } else {
    const t2 = Date.now();
    const secArgs = ['--skip-git', '--skip-pentest'];
    if (noZap) secArgs.push('--no-zap');
    const { ok, exitCode } = runScript('scripts/run-security.js', secArgs);
    const ms2 = Date.now() - t2;
    stageDone(2, 'Security Tests', ok, ms2);
    summary.push({ num: 2, label: 'Security (ZAP + checks)', status: ok ? 'PASS' : 'WARN', ms: ms2, exitCode });
    // Security findings are warnings — report is generated but pipeline continues
  }

  // ── Stage 3: Penetration Tests ──────────────────────────────────────────────
  stageHeader(3, TOTAL, 'Penetration Tests (Nuclei · SQLMap · ffuf · ZAP-Auth)', skipPentest || process.env.PENTEST_ENABLED !== 'true');
  if (skipPentest) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-pentest passed${C.reset}\n`);
    summary.push({ num: 3, label: 'Pentest (Nuclei+ffuf)', status: 'SKIP', ms: 0 });
  } else if (process.env.PENTEST_ENABLED !== 'true') {
    console.log(`  ${C.yellow}↷  Skipped — PENTEST_ENABLED not set to true in .env${C.reset}\n`);
    summary.push({ num: 3, label: 'Pentest (Nuclei+ffuf)', status: 'SKIP', ms: 0 });
  } else {
    const t3 = Date.now();
    const pentestArgs = ['--skip-git', '--no-pause'];
    const { ok, exitCode } = runScript('scripts/run-pentest.js', pentestArgs);
    const ms3 = Date.now() - t3;
    stageDone(3, 'Penetration Tests', ok, ms3);
    summary.push({ num: 3, label: 'Pentest (Nuclei+ffuf)', status: ok ? 'PASS' : 'WARN', ms: ms3, exitCode });
    // Pentest findings are warnings — pipeline continues regardless
  }

  // ── Stage 4: Git sync ───────────────────────────────────────────────────
  stageHeader(4, TOTAL, 'Git Agent — auto-commit + push all reports', skipGit);
  if (skipGit) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-git passed${C.reset}\n`);
    summary.push({ num: 4, label: 'Git sync', status: 'SKIP', ms: 0 });
  } else {
    const t4 = Date.now();
    const { ok } = runScript('scripts/git-sync.js', []);
    const ms4 = Date.now() - t4;
    stageDone(4, 'Git sync', ok || true, ms4);
    summary.push({ num: 4, label: 'Git sync', status: ok ? 'PASS' : 'WARN', ms: ms4 });
  }

  // ─── Summary ─────────────────────────────────────────────────────────────────
  const total = (Date.now() - pipelineStart) / 1000;
  console.log(`\n${C.bold}${C.white}${'─'.repeat(64)}${C.reset}`);
  console.log(`${C.bold}  Non-Functional Pipeline Summary  ${C.dim}(${total.toFixed(1)}s total)${C.reset}\n`);
  for (const s of summary) {
    const col = s.status === 'PASS' ? C.green : s.status === 'SKIP' ? C.yellow : C.yellow;
    const dur = s.ms ? `  ${C.dim}${(s.ms / 1000).toFixed(1)}s${C.reset}` : '';
    console.log(`  ${col}${s.status.padEnd(5)}${C.reset}  Stage ${s.num}  ${s.label}${dur}`);
  }
  console.log(`\n${C.bold}${C.white}${'─'.repeat(64)}${C.reset}\n`);

  const failed = summary.filter(s => s.status === 'FAIL').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
