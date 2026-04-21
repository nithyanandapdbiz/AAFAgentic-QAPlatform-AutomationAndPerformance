'use strict';
/**
 * Dedicated Playwright config for unit tests in tests/unit/**.
 * Uses a no-browser, no-baseURL, no-fixture setup for pure JS unit testing
 * of modules under src/core/**.
 */
const { defineConfig } = require('@playwright/test');

module.exports = defineConfig({
  testDir: './tests/unit',
  timeout: 10_000,
  retries: 0,
  workers: 2,
  reporter: [['list']],
  use: {
    // No browser usage in unit tests — leave most options at defaults.
    trace: 'off',
    screenshot: 'off',
    video: 'off'
  },
  // Explicitly exclude global setup/teardown from the main config.
});
