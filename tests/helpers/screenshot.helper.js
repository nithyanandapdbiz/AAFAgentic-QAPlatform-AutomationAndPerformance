'use strict';
const { test } = require('@playwright/test');
const fs   = require('fs');
const path = require('path');

// Screenshots are saved to: test-results/screenshots/<test-slug>/<step>.png
const SCREENSHOTS_ROOT = path.resolve(__dirname, '..', '..', 'test-results', 'screenshots');

/**
 * ScreenshotHelper
 *
 * Provides two mechanisms for capturing screenshots during Playwright tests:
 *
 *  1. sh.step('Label', async () => { ... })
 *     Wraps actions inside a named Playwright test.step() block.
 *     A full-page screenshot is taken AFTER the step's actions complete.
 *     Screenshots are:
 *       - Saved to disk: test-results/screenshots/<test-slug>/step-01-label.png
 *       - Attached to testInfo via testInfo.attach() so they appear in:
 *         • Allure report (allure-playwright picks them up automatically)
 *         • Playwright HTML report
 *         • Playwright JSON reporter (paths in test-results.json)
 *
 *  2. sh.capture('label')
 *     Takes a standalone screenshot at any point — not inside a step block.
 *
 * Usage inside a spec file:
 *
 *   test('my test', async ({ page }, testInfo) => {
 *     const sh = new ScreenshotHelper(page, testInfo);
 *
 *     await sh.step('Open login page', async () => {
 *       await page.goto('/web/index.php/auth/login');
 *     });
 *   });
 */
class ScreenshotHelper {
  /**
   * @param {import('@playwright/test').Page}     page
   * @param {import('@playwright/test').TestInfo} testInfo
   */
  constructor(page, testInfo) {
    this.page     = page;
    this.testInfo = testInfo;
    this._counter = 0;

    // Unique directory per test — derived from the test title
    const title = (testInfo.title || 'test')
      .replace(/[^a-z0-9]+/gi, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 60)
      .toLowerCase();
    this._dir = path.join(SCREENSHOTS_ROOT, title);
    fs.mkdirSync(this._dir, { recursive: true });
  }

  /**
   * Run `fn` inside a named test.step() and capture a full-page screenshot
   * after the step completes.
   *
   * @param {string}   label  Human-readable step label shown in the report
   * @param {Function} fn     Async callback containing the step's actions
   */
  async step(label, fn) {
    this._counter++;
    const num = String(this._counter).padStart(2, '0');
    return test.step(`${num}. ${label}`, async () => {
      let stepError = null;
      try {
        await fn();
      } catch (err) {
        stepError = err;
      }
      // Always capture — even when the step failed, so every step has a screenshot
      await this._capture(`step-${num}-${label}`, `${num}. ${label}`);
      // Re-throw after screenshot so Playwright still records the failure
      if (stepError) throw stepError;
    });
  }

  /**
   * Capture a screenshot at a specific point outside a step wrapper.
   *
   * @param {string} label  Descriptive label used as the file name
   */
  async capture(label) {
    await this._capture(label, label);
  }

  // ── Internal ──────────────────────────────────────────────────────────────

  async _capture(label, attachName) {
    const slug = label
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, '-')
      .replace(/^-|-$/g, '')
      .slice(0, 70);
    const filePath = path.join(this._dir, `${slug}.png`);
    try {
      // Bail out early if the page is already closed / crashed
      if (this.page.isClosed()) return;

      const buffer = await this.page.screenshot({ fullPage: true });
      fs.writeFileSync(filePath, buffer);

      // Attach to Playwright testInfo so the screenshot appears in:
      //   - Allure report (allure-playwright reads testInfo attachments)
      //   - Playwright HTML reporter
      //   - Playwright JSON reporter (accessible in test-results.json)
      await this.testInfo.attach(attachName || label, {
        body: buffer,
        contentType: 'image/png',
      });
    } catch (err) {
      // Log the failure so it's visible in CI output — don't crash the test
      console.warn(`  [ScreenshotHelper] ⚠ Failed to capture "${attachName || label}": ${err.message}`);
    }
  }
}

module.exports = { ScreenshotHelper };
