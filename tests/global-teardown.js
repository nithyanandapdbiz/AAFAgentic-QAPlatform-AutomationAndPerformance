'use strict';
/**
 * Global Teardown — runs ONCE after the entire test suite completes.
 *
 * Responsibilities:
 *   1. Parse test-results.json and print a summary table
 *   2. Log overall pass/fail/skip counts and duration
 *   3. Highlight any flaky or retried tests
 */
const fs   = require('fs');
const path = require('path');

const RESULTS_FILE = path.resolve(__dirname, '..', 'test-results.json');
const { validateAllureResults } = require('../scripts/ensure-dirs');

module.exports = async function globalTeardown() {
  console.log('\n' + '─'.repeat(52));
  console.log('╔══════════════════════════════════════════════════╗');
  console.log('║           GLOBAL TEARDOWN — Summary              ║');
  console.log('╚══════════════════════════════════════════════════╝');

  if (!fs.existsSync(RESULTS_FILE)) {
    console.log('  ⚠ test-results.json not found — skipping summary');
    return;
  }

  try {
    const raw     = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf-8'));
    const suites  = raw.suites || [];
    let passed = 0, failed = 0, skipped = 0, flaky = 0, totalDuration = 0;
    const failures = [];
    const flakyTests = [];

    function walkSpecs(suites) {
      for (const suite of suites) {
        for (const spec of (suite.specs || [])) {
          for (const test of (spec.tests || [])) {
            const status = test.status || test.expectedStatus;
            const duration = (test.results || []).reduce((sum, r) => sum + (r.duration || 0), 0);
            totalDuration += duration;

            if (status === 'expected' || status === 'passed') passed++;
            else if (status === 'skipped') skipped++;
            else if (status === 'flaky') { flaky++; flakyTests.push(spec.title); }
            else { failed++; failures.push(spec.title); }
          }
        }
        if (suite.suites) walkSpecs(suite.suites);
      }
    }

    walkSpecs(suites);
    const total = passed + failed + skipped + flaky;
    const durationSec = (totalDuration / 1000).toFixed(1);

    console.log(`\n  Total Tests : ${total}`);
    console.log(`  ✅ Passed   : ${passed}`);
    console.log(`  ❌ Failed   : ${failed}`);
    console.log(`  ⏭  Skipped  : ${skipped}`);
    console.log(`  ⚡ Flaky    : ${flaky}`);
    console.log(`  ⏱  Duration : ${durationSec}s`);

    if (failures.length > 0) {
      console.log('\n  ── Failed Tests ──────────────────────────────');
      failures.forEach(t => console.log(`    ✗ ${t}`));
    }

    if (flakyTests.length > 0) {
      console.log('\n  ── Flaky Tests ───────────────────────────────');
      flakyTests.forEach(t => console.log(`    ⚡ ${t}`));
    }

    // Pass rate
    if (total > 0) {
      const rate = ((passed / total) * 100).toFixed(1);
      console.log(`\n  Pass Rate: ${rate}%`);
    }

  } catch (err) {
    console.error(`  ⚠ Failed to parse test-results.json: ${err.message}`);
  }

  // ── Post-Run Validation: Allure Results ─────────────────────────────
  // Catch allure-playwright config mismatches (e.g. wrong option names)
  // immediately instead of discovering them when running the Allure report.
  const allure = validateAllureResults();
  if (!allure.ok) {
    console.log('\n  ⚠⚠⚠  ALLURE RESULTS EMPTY  ⚠⚠⚠');
    console.log('  The allure-results/ directory has 0 result files.');
    console.log('  This usually means the allure-playwright reporter config');
    console.log('  is wrong — check playwright.config.js reporter options.');
    console.log('  allure-playwright v3 uses "resultsDir" (not "outputFolder").');
  } else {
    console.log(`\n  ── Allure Results: ${allure.count} result file(s) collected`);
  }

  // ── Post-Run Validation: Step Screenshots ───────────────────────────
  const screenshotsDir = path.resolve(__dirname, '..', 'test-results', 'screenshots');
  let screenshotCount = 0;
  try {
    if (fs.existsSync(screenshotsDir)) {
      const walkCount = (dir) => {
        for (const entry of fs.readdirSync(dir)) {
          const full = path.join(dir, entry);
          if (fs.statSync(full).isDirectory()) walkCount(full);
          else if (entry.endsWith('.png')) screenshotCount++;
        }
      };
      walkCount(screenshotsDir);
    }
  } catch { /* ignore */ }
  console.log(`  ── Step Screenshots: ${screenshotCount} PNG file(s) captured`);

  console.log('\n' + '─'.repeat(52) + '\n');
};
