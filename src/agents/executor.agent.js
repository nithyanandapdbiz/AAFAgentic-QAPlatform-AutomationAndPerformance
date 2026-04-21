'use strict';
const { createTestCase } = require("../tools/zephyr.client");
const { generateTest } = require("../tools/playwright.generator");
const { logDecision } = require("./agentDecisionLog");
const { validateExecutorOutput, sanitizeExecutorOutput } = require("../core/schemas");
const logger = require("../utils/logger");

/**
 * Creates each test case in Zephyr Essential Cloud API v2.8 via POST /testcases
 * and generates the corresponding Playwright spec file.
 * Returns createdKeys as an array of { id, key } objects where key is the
 * Zephyr test case key (e.g. "SCRUM-T1") used for execution linking.
 */
async function execute(testCases) {
  const inputCount = Array.isArray(testCases) ? testCases.length : 0;
  const createdKeys = [];
  const failures = [];
  for (const tc of testCases || []) {
    try {
      const { id, key } = await createTestCase(tc);
      if (key) createdKeys.push({ id, key });
      generateTest(tc);
    } catch (err) {
      failures.push({ title: tc?.title, error: err.message });
      logger.warn(`Executor: failed for test case "${tc?.title}": ${err.message}`);
    }
  }
  let output = { createdKeys };
  const { valid, errors } = validateExecutorOutput(output);
  if (!valid) {
    logger.warn(`Executor output failed schema validation: ${errors.join('; ')} — sanitising`);
    output = sanitizeExecutorOutput(output);
  }

  logDecision('executor', { inputCount }, {
    createdCount: output.createdKeys.length,
    failureCount: failures.length
  }, { failures: failures.slice(0, 10) });

  return output;
}
module.exports = { execute };

