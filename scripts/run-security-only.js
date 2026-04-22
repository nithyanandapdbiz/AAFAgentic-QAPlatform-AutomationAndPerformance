'use strict';
/**
 * run-security-only.js  —  Security + Penetration Tests Only
 * ───────────────────────────────────────────────────────────────────────────
 * Dedicated entry point for security + penetration testing. Runs the full
 * eight-stage security pipeline (generate config → start ZAP → passive scan
 * → active scan → evaluate findings → generate report → pentest → git sync)
 * with no functional (Playwright) or performance (k6) testing.
 *
 * All flags are forwarded directly to run-security.js.
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────────────
 *   node scripts/run-security-only.js              ← full security + pentest
 *   node scripts/run-security-only.js --no-zap     ← custom checks only (no ZAP)
 *   node scripts/run-security-only.js --skip-pentest ← security only (no pentest)
 *   node scripts/run-security-only.js --skip-git   ← skip git auto-commit
 *
 * OWASP ZAP is optional. To enable auto-launch set in .env:
 *   ZAP_PATH=<absolute path to zap.sh / zap.bat>
 *   ZAP_AUTO_LAUNCH=true
 *   ZAP_API_KEY=changeme
 *   ZAP_API_URL=http://localhost:8080
 *
 * Custom security checks always run (no ZAP dependency):
 *   • SQL injection probes
 *   • XSS injection probes
 *   • Authentication bypass detection
 *   • Security header validation
 *   • CSRF token checks
 *   • Sensitive cookie flag checks
 *
 * Environment variables (can also be set in .env):
 *   ZAP_PATH          Absolute path to the ZAP start script
 *   ZAP_AUTO_LAUNCH   Set to "true" to auto-spawn ZAP daemon
 *   ZAP_API_URL       ZAP API base URL (default: http://localhost:8080)
 *   ZAP_API_KEY       ZAP API key    (default: changeme)
 *   BASE_URL          AUT base URL
 *   ISSUE_KEY         Jira story key (e.g. SCRUM-5)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const path          = require('path');

const ROOT = path.resolve(__dirname, '..');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red:   '\x1b[31m', white: '\x1b[97m', yellow: '\x1b[33m',
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

// ─── Banner ───────────────────────────────────────────────────────────────────
const args         = process.argv.slice(2);
const noZap        = args.includes('--no-zap');
const skipPentest  = args.includes('--skip-pentest');
const zapPath      = process.env.ZAP_PATH || '';
const pentestEnabled = process.env.PENTEST_ENABLED === 'true';
const zapMode = noZap
  ? 'Custom checks only (--no-zap)'
  : zapPath
    ? `ZAP + custom checks  (${zapPath.split(/[\/]/).pop()})`
    : 'Custom checks only  (ZAP_PATH not configured)';
const pentestMode = skipPentest
  ? 'SKIPPED (--skip-pentest)'
  : !pentestEnabled
    ? 'disabled — set PENTEST_ENABLED=true in .env'
    : 'ON — Nuclei · SQLMap · ffuf · ZAP-Auth';

const W = 58;
const B = '═'.repeat(W);
const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
const row = s => `${C.bold}${C.red}║  ${C.reset}${pad(s)}${C.bold}${C.red}║${C.reset}`;
console.log(`\n${C.bold}${C.red}╔${B}╗${C.reset}`);
console.log(row('Agentic QA Platform  —  Security + Pentest'));
console.log(row(''));
console.log(row(`ZAP      : ${zapMode}`));
console.log(row('Custom   : SQLi · XSS · Auth-bypass · Headers'));
console.log(row('           CSRF · Cookie flags'));
console.log(row(`Pentest  : ${pentestMode}`));
console.log(row(''));
console.log(row(`Issue    : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`));
console.log(row(`Target   : ${process.env.BASE_URL  || '(set BASE_URL in .env)'}`));
console.log(row(`Time     : ${now()}`));
console.log(`${C.bold}${C.red}╚${B}╝${C.reset}\n`);

// ─── Delegate to run-security.js ─────────────────────────────────────────────
const secScript = path.join(ROOT, 'scripts', 'run-security.js');
const r = spawnSync('node', [secScript, ...args], {
  cwd:   ROOT,
  stdio: 'inherit',
  env:   process.env,
});

process.exit(r.status ?? (r.error ? 1 : 0));
