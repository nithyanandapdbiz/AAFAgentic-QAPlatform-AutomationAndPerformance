'use strict';
/**
 * generate-allure-report.js
 *
 * Generates an Allure HTML report from the allure-results/ folder produced
 * by allure-playwright during the test run.
 *
 * Requires:   allure-commandline  (installed as devDependency)
 *
 * Usage:
 *   node scripts/generate-allure-report.js
 *
 * Output:
 *   allure-report/index.html   ← open this in a browser
 */

const { spawnSync, execFileSync } = require('child_process');
const path                        = require('path');
const fs                          = require('fs');
const { ensureDirs }              = require('./ensure-dirs');

const ROOT         = path.resolve(__dirname, '..');
const RESULTS_DIR  = path.join(ROOT, 'allure-results');
const REPORT_DIR   = path.join(ROOT, 'allure-report');

// Resolve the allure binary from node_modules/.bin — no shell needed
const ALLURE_BIN   = path.join(ROOT, 'node_modules', '.bin',
                               process.platform === 'win32' ? 'allure.cmd' : 'allure');

console.log('\n╔══════════════════════════════════════════════════╗');
console.log('║   Allure Report Generator                        ║');
console.log('╚══════════════════════════════════════════════════╝\n');

// Ensure output directories exist (allure-report/ in particular)
ensureDirs();

if (!fs.existsSync(RESULTS_DIR)) {
  console.warn(`  WARNING: allure-results/ not found at ${RESULTS_DIR}`);
  console.warn('  Run Playwright tests first — they generate allure-results/ automatically.\n');
  process.exit(0);   // soft exit — don't break the pipeline
}

const resultCount = fs.readdirSync(RESULTS_DIR).length;
console.log(`  allure-results/ contains ${resultCount} file(s)`);
console.log(`  Generating report → allure-report/\n`);

try {
  if (process.platform === 'win32') {
    // .cmd files require a shell on Windows. Build a single quoted string
    // (no separate args array) so DEP0190 is never triggered.
    // --single-file embeds all data inside index.html so it opens without a web server
    const shellCmd = `"${ALLURE_BIN}" generate "${RESULTS_DIR}" --output "${REPORT_DIR}" --clean --single-file`;
    const result = spawnSync(shellCmd, { stdio: 'inherit', shell: true });
    if (result.error) throw result.error;
    if (result.status !== 0) throw Object.assign(new Error(), { status: result.status });
  } else {
    execFileSync(ALLURE_BIN, ['generate', RESULTS_DIR, '--output', REPORT_DIR, '--clean', '--single-file'],
                 { stdio: 'inherit' });
  }
} catch (err) {
  console.error(`\n  ERROR: allure generate failed (exit ${err.status ?? 1})`);
  process.exit(err.status || 1);
}

console.log('\n  ✓ Allure report generated: allure-report/index.html');
console.log('  Open: allure-report/index.html (self-contained single file)\n');
