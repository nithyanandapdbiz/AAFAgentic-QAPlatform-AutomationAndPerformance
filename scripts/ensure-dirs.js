'use strict';
// NOTE: scripts/pre-flight.js also creates all required output directories
// before the pipeline runs. This script performs the same operation and is
// therefore a safe no-op on any pipeline run that starts with pre-flight.
// It is retained for backward compatibility with legacy pipeline scripts
// (qa-run.js, run-qa-complete.js, run-e2e.js) that call it directly.
/**
 * ensure-dirs.js — Centralized output directory management
 * ─────────────────────────────────────────────────────────────────────────────
 * Guarantees that every output directory the QA platform needs exists before
 * tests, reports, or pipeline scripts run.
 *
 * Why this matters:
 *   • `allure-results/`          — allure-playwright writes here during tests
 *   • `allure-report/`           — allure generate writes here
 *   • `test-results/screenshots/`— ScreenshotHelper writes per-test PNGs here
 *   • `custom-report/`           — generate-report.js writes here
 *   • `.auth/`                   — global-setup caches login storageState here
 *
 * If any of these dirs are missing (clean checkout, git clean, manual delete),
 * reporters and helpers fail silently — producing empty reports.
 *
 * Usage:
 *   require('./ensure-dirs');            // side-effect: creates all dirs
 *   const { ensureDirs, cleanDir } = require('./ensure-dirs');
 *   ensureDirs();                        // explicit call
 *   cleanDir('allure-results');          // wipe contents, keep directory
 * ─────────────────────────────────────────────────────────────────────────────
 */

const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');

/** All output directories the platform depends on (relative to project root) */
const OUTPUT_DIRS = [
  'allure-results',
  'allure-report',
  'test-results',
  'test-results/screenshots',
  'custom-report',
  'playwright-report',
  '.auth',
  'tests/perf/load',
  'tests/perf/stress',
  'tests/perf/spike',
  'tests/perf/soak',
  'tests/perf/scalability',
  'tests/perf/breakpoint',
  'tests/perf/baselines',
  'test-results/perf',
  'custom-report/perf',
  'tests/security',
  'test-results/security',
  'custom-report/security',
];

/**
 * Ensure every output directory exists. Safe to call multiple times.
 */
function ensureDirs() {
  for (const rel of OUTPUT_DIRS) {
    const abs = path.join(ROOT, rel);
    if (!fs.existsSync(abs)) {
      fs.mkdirSync(abs, { recursive: true });
    }
  }
}

/**
 * Remove all files/folders inside `dirName` but keep the directory itself.
 * This avoids breaking reporter handles that cached the directory reference.
 *
 * @param {string} dirName  Relative directory name (e.g. 'allure-results')
 */
function cleanDir(dirName) {
  const abs = path.join(ROOT, dirName);
  if (!fs.existsSync(abs)) {
    fs.mkdirSync(abs, { recursive: true });
    return;
  }
  for (const entry of fs.readdirSync(abs)) {
    fs.rmSync(path.join(abs, entry), { recursive: true, force: true });
  }
}

/**
 * Validate that allure-playwright produced results after a test run.
 * Returns { ok, count } — callers can decide whether to warn or fail.
 */
function validateAllureResults() {
  const dir = path.join(ROOT, 'allure-results');
  if (!fs.existsSync(dir)) return { ok: false, count: 0 };
  const files = fs.readdirSync(dir).filter(f => f.endsWith('.json'));
  return { ok: files.length > 0, count: files.length };
}

// Auto-run on require (side-effect import) — ensures dirs exist immediately
ensureDirs();

module.exports = { ensureDirs, cleanDir, validateAllureResults, OUTPUT_DIRS };
