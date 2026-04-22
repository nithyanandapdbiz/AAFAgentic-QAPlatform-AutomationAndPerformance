'use strict';
/**
 * base.fixture.js — Composed Playwright fixture with full hook lifecycle.
 *
 * Merges:
 *   • POM fixtures (LoginPage, AddEmployeePage, EmployeeListPage)
 *   • ScreenshotHelper
 *
 * Hooks provided:
 *   • beforeEach — Clear cookies for session isolation
 *   • afterEach  — On failure: capture failure screenshot, collect console errors,
 *                  dismiss open dialogs; always: log test result with duration
 *   • beforeAll  — Log suite start
 *   • afterAll   — Log suite summary
 *
 * Usage in spec files:
 *   const { test, expect } = require('../fixtures/base.fixture');
 *
 *   test('my test', async ({ page, loginPage, addEmployeePage, sh }, testInfo) => {
 *     await sh.step('Open login', async () => { ... });
 *   });
 */

const { test: base, expect } = require('@playwright/test');
const fs                     = require('fs');
const path                   = require('path');
const { LoginPage }          = require('../pages/LoginPage');
const { AddEmployeePage }    = require('../pages/AddEmployeePage');
const { EmployeeListPage }   = require('../pages/EmployeeListPage');
const { ScreenshotHelper }   = require('../helpers/screenshot.helper');

// ── Suite-level counters (shared across workers) ──────────────────────────
let _suiteStartTime = 0;
let _suitePassed    = 0;
let _suiteFailed    = 0;

const test = base.extend({

  // ── POM Fixtures ──────────────────────────────────────────────────────
  loginPage: async ({ page }, use) => {
    await use(new LoginPage(page));
  },

  addEmployeePage: async ({ page }, use) => {
    await use(new AddEmployeePage(page));
  },

  employeeListPage: async ({ page }, use) => {
    await use(new EmployeeListPage(page));
  },

  uniqueSuffix: async ({}, use) => {
    await use(String(Date.now()).slice(-5));
  },

  // ── ScreenshotHelper ─────────────────────────────────────────────────
  sh: async ({ page }, use, testInfo) => {
    await use(new ScreenshotHelper(page, testInfo));
  },

  // ── Video capture for failed tests ───────────────────────────────────
  // Overrides Playwright's built-in `page` fixture so we can close the
  // page ourselves AFTER _afterEach has run, finalise the WebM recording,
  // and attach the buffer to testInfo.  This makes the video available:
  //   • in test-results.json (body field) → picked up by generate-report.js
  //   • in allure-results/   (file copy)  → shown in Allure report
  // The override is transparent: callers receive the same `page` object.
  page: async ({ page }, use, testInfo) => {
    // Grab the video recording object BEFORE the test runs so we can
    // query it even if the page is replaced during the test.
    const videoObj = page.video ? page.video() : null;

    await use(page); // ← test body + auto-fixture teardowns run here

    // Only embed video for non-passing tests (kept small and relevant).
    if (testInfo.status !== 'passed' && testInfo.status !== 'skipped' && videoObj) {
      try {
        // Close the page first — Playwright finalises the WebM file on close.
        // Calling close() on an already-closed page is a safe no-op.
        if (!page.isClosed()) {
          await page.close();
        }
        const videoPath = await videoObj.path();
        if (videoPath && fs.existsSync(videoPath)) {
          const buf = fs.readFileSync(videoPath);
          // Attach with body (base64) so it is embedded in test-results.json
          // and automatically copied to allure-results/ by allure-playwright.
          await testInfo.attach('video', {
            body:        buf,
            contentType: 'video/webm',
          });
          console.log(`  [Hook] 🎬 Video attached (${(buf.length / 1024).toFixed(0)} KB) for "${testInfo.title}"`);
        }
      } catch (err) {
        // Non-fatal — video capture failure must never break CI.
        console.warn(`  [Hook] ⚠ Video capture failed for "${testInfo.title}": ${err.message}`);
      }
    }
  },

  // ── Console error collector ───────────────────────────────────────────
  _consoleErrors: async ({ page }, use, testInfo) => {
    const errors = [];
    const handler = (msg) => {
      if (msg.type() === 'error') {
        errors.push({ text: msg.text(), url: msg.location()?.url || '' });
      }
    };
    page.on('console', handler);

    await use(errors);

    // Teardown: attach collected console errors to test report
    if (errors.length > 0) {
      const summary = errors.map((e, i) => `${i + 1}. ${e.text} (${e.url})`).join('\n');
      await testInfo.attach('Console Errors', { body: summary, contentType: 'text/plain' });
      if (testInfo.status !== 'passed') {
        console.log(`  [Hook] ⚠ ${errors.length} console error(s) captured during "${testInfo.title}"`);
      }
    }
  },

  // ── beforeEach / afterEach (auto-use fixtures) ────────────────────────
  _beforeEach: [async ({ page }, use) => {
    // ── beforeEach: clean session isolation ──
    await page.context().clearCookies();
    await use();
  }, { auto: true }],

  _afterEach: [async ({ page, _consoleErrors }, use, testInfo) => {
    await use();

    // ── afterEach: post-test hooks ──
    const status   = testInfo.status;
    const duration = (testInfo.duration / 1000).toFixed(1);
    const icon     = status === 'passed' ? '✅' : status === 'skipped' ? '⏭' : '❌';

    // Track suite counts
    if (status === 'passed') _suitePassed++;
    else if (status !== 'skipped') _suiteFailed++;

    // On failure: capture failure screenshot + handle open dialogs
    if (status !== 'passed' && status !== 'skipped') {
      try {
        // Dismiss any open dialogs that might block screenshot
        page.once('dialog', async (dialog) => { await dialog.dismiss(); });

        // Capture failure screenshot
        const buffer = await page.screenshot({ fullPage: true }).catch(() => null);
        if (buffer) {
          await testInfo.attach('failure-screenshot', {
            body: buffer,
            contentType: 'image/png',
          });
        }
      } catch {
        // Page may already be closed — silently skip
      }
    }

    console.log(`  ${icon} [${duration}s] ${testInfo.title}`);
  }, { auto: true }],

  // ── beforeAll / afterAll (worker-scoped fixtures) ─────────────────────
  _beforeAll: [async ({}, use) => {
    // ── beforeAll: runs once per worker ──
    _suiteStartTime = Date.now();
    _suitePassed    = 0;
    _suiteFailed    = 0;
    console.log('\n  ┌─────────────────────────────────────────────');
    console.log('  │ Test Suite Starting');
    console.log('  │ Time: ' + new Date().toISOString());
    console.log('  └─────────────────────────────────────────────');

    await use();

    // ── afterAll: runs once per worker after all tests ──
    const elapsed = ((Date.now() - _suiteStartTime) / 1000).toFixed(1);
    console.log('\n  ┌─────────────────────────────────────────────');
    console.log('  │ Test Suite Complete');
    console.log(`  │ Passed: ${_suitePassed}  Failed: ${_suiteFailed}  Duration: ${elapsed}s`);
    console.log('  └─────────────────────────────────────────────\n');
  }, { auto: true, scope: 'worker' }],
});

module.exports = { test, expect };
