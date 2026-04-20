'use strict';
const { createTestCase } = require("../tools/zephyr.client");
const { generateTest } = require("../tools/playwright.generator");

/**
 * Creates each test case in Zephyr Essential Cloud API v2.8 via POST /testcases
 * and generates the corresponding Playwright spec file.
 * Returns createdKeys as an array of { id, key } objects where key is the
 * Zephyr test case key (e.g. "SCRUM-T1") used for execution linking.
 */
async function execute(testCases) {
  const createdKeys = [];
  for (const tc of testCases) {
    const { id, key } = await createTestCase(tc);
    if (key) createdKeys.push({ id, key });
    generateTest(tc);
  }
  return { createdKeys };
}
module.exports = { execute };
