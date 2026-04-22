'use strict';
/**
 * run-perf-only.js  —  Performance Tests Only
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated entry point for k6 performance testing. Runs the full six-stage
 * performance pipeline (generate scripts → execute k6 → evaluate thresholds →
 * sync Zephyr → generate report → git sync) with no functional or security
 * testing.
 *
 * All flags are forwarded directly to run-perf.js.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-perf-only.js                           ← all test types
 *   node scripts/run-perf-only.js --test-type=load          ← load only
 *   node scripts/run-perf-only.js --test-type=stress        ← stress only
 *   node scripts/run-perf-only.js --test-type=spike         ← spike only
 *   node scripts/run-perf-only.js --test-type=soak          ← soak only
 *   node scripts/run-perf-only.js --test-type=scalability   ← scalability only
 *   node scripts/run-perf-only.js --test-type=breakpoint    ← breakpoint only
 *   node scripts/run-perf-only.js --skip-generate           ← skip k6 script gen
 *   node scripts/run-perf-only.js --skip-sync               ← skip Zephyr sync
 *   node scripts/run-perf-only.js --skip-git                ← skip git push
 *   node scripts/run-perf-only.js --dry-run                 ← print cmds, no exec
 *
 * Environment variables (can also be set in .env):
 *   PERF_K6_BINARY   Path to k6 executable
 *   ISSUE_KEY        Jira story key (e.g. SCRUM-5)
 *   BASE_URL         AUT base URL
 *   PERF_VUS_MAX     Maximum virtual users
 *
 * Supported test types:
 *   load | stress | spike | soak | scalability | breakpoint
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const path          = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  cyan:  '\x1b[36m', white: '\x1b[97m', yellow: '\x1b[33m',
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

// ─── Banner ───────────────────────────────────────────────────────────────────
const args    = process.argv.slice(2);
const typeArg = (args.find(a => a.startsWith('--test-type=')) || '').replace('--test-type=', '') || 'all';

const W = 56;
const B = '═'.repeat(W);
const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
const row = s => `${C.bold}${C.cyan}║  ${C.reset}${pad(s)}${C.bold}${C.cyan}║${C.reset}`;
console.log(`\n${C.bold}${C.cyan}╔${B}╗${C.reset}`);
console.log(row('Agentic QA Platform  —  Performance Tests Only'));
console.log(row(''));
console.log(row('Engine   : k6'));
console.log(row(`Types    : load | stress | spike | soak | scalability | breakpoint`));
console.log(row(''));
console.log(row(`Running  : ${typeArg}`));
console.log(row(`Issue    : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`));
console.log(row(`k6       : ${process.env.PERF_K6_BINARY || 'k6 (from PATH)'}`));
console.log(row(`Time     : ${now()}`));
console.log(`${C.bold}${C.cyan}╚${B}╝${C.reset}\n`);

// ─── Delegate to run-perf.js ──────────────────────────────────────────────────
const perfScript = path.join(ROOT, 'scripts', 'run-perf.js');
const r = spawnSync('node', [perfScript, ...args], {
  cwd:   ROOT,
  stdio: 'inherit',
  env:   process.env,
});

process.exit(r.status ?? (r.error ? 1 : 0));
