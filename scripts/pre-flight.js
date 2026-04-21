#!/usr/bin/env node
'use strict';
/**
 * pre-flight.js — Fast health check for the Agentic QA pipeline.
 *
 * Validates (in parallel):
 *   • ISSUE_KEY is set
 *   • Jira credentials reach GET /myself
 *   • Zephyr credentials reach GET /healthcheck
 *   • k6 binary is on PATH (if perf enabled OR not explicitly disabled)
 *   • ZAP (docker/owasp zap) is available (only warning if security enabled)
 *   • Required directories exist (or can be created)
 *
 * Budget: < 10s total wall-clock. Uses Promise.allSettled so one failing
 * check does not mask others.
 *
 * Exit codes:
 *   0 — all checks passed
 *   1 — one or more CRITICAL checks failed (see stdout for remediation)
 */
require('dotenv').config();

const fs       = require('fs');
const path     = require('path');
const { execFile } = require('child_process');

const ROOT = path.resolve(__dirname, '..');
const CHECK_TIMEOUT_MS = 8_000;

// ─── Tiny colour helpers (no dep) ─────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m', cyan: '\x1b[36m'
};

function withTimeout(promise, ms, label) {
  return Promise.race([
    promise,
    new Promise((_, rej) => setTimeout(() => rej(new Error(`${label} timed out after ${ms}ms`)), ms))
  ]);
}

// ─── Individual checks ────────────────────────────────────────────
async function checkIssueKey() {
  if (!process.env.ISSUE_KEY) {
    throw new Error('ISSUE_KEY is not set. Export it or add to .env (e.g. ISSUE_KEY=SCRUM-6).');
  }
  return `ISSUE_KEY=${process.env.ISSUE_KEY}`;
}

async function checkDirs() {
  // Pre-flight is responsible for output-directory creation so the pipeline
  // starts clean on fresh checkouts. scripts/ensure-dirs.js is a safe no-op
  // afterwards (kept only for legacy pipeline scripts that call it directly).
  const needed = [
    'logs',
    'tests/specs',
    'test-results',
    'custom-report',
    'allure-results',
    'heal-artifacts',
    'perf/scripts',
    'perf/results',
    'security/scripts',
    'security/reports',
  ];
  const failed = [];
  for (const d of needed) {
    const p = path.join(ROOT, d);
    try {
      if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
    } catch (err) {
      failed.push(`${d} (${err.message})`);
    }
  }
  if (failed.length > 0) {
    throw new Error(`Failed to create: ${failed.join(', ')}`);
  }
  return `${needed.length} directories ready`;
}

async function checkJira() {
  const { JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN } = process.env;
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_API_TOKEN) {
    throw new Error('JIRA_URL / JIRA_EMAIL / JIRA_API_TOKEN missing in .env');
  }
  const base = JIRA_URL.replace(/\/$/, '');
  const auth = 'Basic ' + Buffer.from(`${JIRA_EMAIL}:${JIRA_API_TOKEN}`).toString('base64');
  const res  = await withTimeout(fetch(`${base}/rest/api/3/myself`, {
    headers: { Authorization: auth, Accept: 'application/json' }
  }), CHECK_TIMEOUT_MS, 'Jira');
  if (!res.ok) throw new Error(`Jira auth failed: HTTP ${res.status}`);
  const j = await res.json().catch(() => ({}));
  return `Jira OK (${j.emailAddress || j.displayName || 'authenticated'})`;
}

async function checkZephyr() {
  const base  = (process.env.ZEPHYR_BASE_URL || 'https://prod-api.zephyr4jiracloud.com/v2').replace(/\/$/, '');
  const token = process.env.ZEPHYR_ACCESS_KEY;
  if (!token) throw new Error('ZEPHYR_ACCESS_KEY missing in .env');
  const res = await withTimeout(fetch(`${base}/healthcheck`, {
    headers: { Authorization: token, Accept: 'application/json' }
  }), CHECK_TIMEOUT_MS, 'Zephyr');
  if (res.status === 401 || res.status === 403) {
    throw new Error(`Zephyr auth failed: HTTP ${res.status} — check ZEPHYR_ACCESS_KEY`);
  }
  return `Zephyr reachable (HTTP ${res.status})`;
}

function which(binary) {
  return new Promise((resolve, reject) => {
    const cmd = process.platform === 'win32' ? 'where' : 'which';
    execFile(cmd, [binary], { timeout: 3000, shell: true }, (err, stdout) => {
      if (err || !stdout.trim()) return reject(new Error(`${binary} not found on PATH`));
      resolve(stdout.trim().split(/\r?\n/)[0]);
    });
  });
}

async function checkK6() {
  const binaryName = process.env.PERF_K6_BINARY || 'k6';
  const location = await which(binaryName);
  return `k6 at ${location}`;
}

async function checkZAP() {
  // ZAP is only critical if --include-security is intended.
  // We check Docker first (most common invocation), then plain `zap.sh`.
  try { return `zap via docker: ${await which('docker')}`; }
  catch (_) {
    return `zap.sh: ${await which('zap.sh')}`;
  }
}

// ─── Runner ───────────────────────────────────────────────────────
async function main() {
  const includePerf     = process.argv.includes('--include-perf')     || process.env.PREFLIGHT_PERF === 'true';
  const includeSecurity = process.argv.includes('--include-security') || process.env.PREFLIGHT_SEC  === 'true';

  const checks = [
    { name: 'Env: ISSUE_KEY',   fn: checkIssueKey, critical: true  },
    { name: 'Filesystem: dirs', fn: checkDirs,     critical: true  },
    { name: 'Jira API',         fn: checkJira,     critical: true  },
    { name: 'Zephyr API',       fn: checkZephyr,   critical: true  },
    { name: 'k6 binary',        fn: checkK6,       critical: includePerf },
    { name: 'ZAP availability', fn: checkZAP,      critical: includeSecurity },
  ];

  console.log(`${C.bold}${C.cyan}▶ Pre-flight checks${C.reset} (budget ${CHECK_TIMEOUT_MS}ms each)\n`);
  const t0 = Date.now();
  const outcomes = await Promise.allSettled(checks.map(c => c.fn()));

  let criticalFailed = 0;
  outcomes.forEach((o, i) => {
    const c = checks[i];
    if (o.status === 'fulfilled') {
      console.log(`  ${C.green}✓${C.reset} ${c.name.padEnd(22)} ${C.dim}${o.value}${C.reset}`);
    } else {
      const icon = c.critical ? `${C.red}✗${C.reset}` : `${C.yellow}⚠${C.reset}`;
      const tag  = c.critical ? `${C.red}CRITICAL${C.reset}` : `${C.yellow}optional${C.reset}`;
      console.log(`  ${icon} ${c.name.padEnd(22)} [${tag}] ${o.reason.message}`);
      if (c.critical) criticalFailed++;
    }
  });

  const ms = Date.now() - t0;
  console.log(`\n${C.dim}Completed in ${ms}ms${C.reset}`);

  if (criticalFailed > 0) {
    console.error(`\n${C.red}${C.bold}Pre-flight failed: ${criticalFailed} critical check(s).${C.reset} Aborting pipeline.`);
    process.exit(1);
  }
  console.log(`\n${C.green}${C.bold}Pre-flight OK.${C.reset}`);
  process.exit(0);
}

main().catch(err => {
  console.error(`${C.red}Pre-flight crashed: ${err.message}${C.reset}`);
  process.exit(1);
});
