'use strict';
/**
 * Global Setup — runs ONCE before the entire test suite.
 *
 * Responsibilities:
 *   1. Health-check the AUT (OrangeHRM) to fail fast if it's unreachable
 *   2. Authenticate and cache storageState for optional reuse
 *   3. Log environment info for traceability
 */
const { chromium } = require('@playwright/test');
const fs           = require('fs');
const path         = require('path');
const { CREDENTIALS } = require('./data/testData');
const { ensureDirs, cleanDir } = require('../scripts/ensure-dirs');

const BASE_URL = 'https://opensource-demo.orangehrmlive.com';
const AUTH_FILE = '.auth/storage-state.json';

module.exports = async function globalSetup(config) {
  // Ensure ALL output directories exist (allure-results, screenshots, reports, etc.)
  ensureDirs();

  // Clean up stale Allure results so the report reflects only this run.
  // cleanDir() wipes contents but keeps the directory — allure-playwright v3
  // caches the directory handle during reporter init (before globalSetup runs).
  cleanDir('allure-results');

  // Clean up step screenshots from the previous run so the custom report only
  // embeds screenshots from this run (avoids stale screenshot bleeding).
  cleanDir('test-results/screenshots');

  const startTime = Date.now();
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║            GLOBAL SETUP — Starting               ║');
  console.log('╚══════════════════════════════════════════════════╝');
  console.log(`  Base URL : ${BASE_URL}`);
  console.log(`  Workers  : ${config.workers}`);
  console.log(`  Retries  : ${config.projects?.[0]?.retries ?? 'default'}`);
  console.log(`  Time     : ${new Date().toISOString()}`);

  // ── 1. Health-check the AUT ──────────────────────────────────────
  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ ignoreHTTPSErrors: true });
  const page    = await context.newPage();

  try {
    console.log('\n  [Health Check] Navigating to OrangeHRM login page...');
    const response = await page.goto(`${BASE_URL}/web/index.php/auth/login`, {
      waitUntil: 'domcontentloaded',
      timeout: 30000
    });

    if (!response || !response.ok()) {
      throw new Error(`AUT returned HTTP ${response?.status()} — expected 200`);
    }

    await page.waitForSelector('input[name="username"]', { timeout: 15000 });
    console.log('  [Health Check] ✅ OrangeHRM is reachable and login page loaded');

    // ── 2. Authenticate and save storageState ──────────────────────
    console.log('  [Auth Cache] Logging in as Admin to cache session...');
    await page.locator('input[name="username"]').fill(CREDENTIALS.admin.username);
    await page.locator('input[name="password"]').fill(CREDENTIALS.admin.password);
    await page.locator('button[type="submit"]').click();
    await page.waitForURL('**/dashboard**', { timeout: 15000 });
    console.log('  [Auth Cache] ✅ Login successful — dashboard loaded');

    // Save authenticated state
    const fs   = require('fs');
    const path = require('path');
    const authDir = path.resolve(AUTH_FILE, '..');
    if (!fs.existsSync(authDir)) fs.mkdirSync(authDir, { recursive: true });
    await context.storageState({ path: AUTH_FILE });
    console.log(`  [Auth Cache] ✅ Storage state saved to ${AUTH_FILE}`);

  } catch (error) {
    console.error(`\n  ❌ GLOBAL SETUP FAILED: ${error.message}`);
    console.error('  The AUT may be down or unreachable. Skipping test run.');
    throw error;
  } finally {
    await browser.close();
  }

  const elapsed = ((Date.now() - startTime) / 1000).toFixed(1);
  console.log(`\n  Global setup completed in ${elapsed}s`);
  console.log('─'.repeat(52) + '\n');
};
