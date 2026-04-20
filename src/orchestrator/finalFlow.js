'use strict';
const { parseResults } = require("../utils/resultParser");
const { createBugsForFailures } = require("../services/bug.service");
const { detectFlaky } = require("../services/flaky.service");
const { calculateCoverage } = require("../services/coverage.service");
const { setupCycle, completeCycle } = require("../services/cycle.service");
const { mapResults } = require("../services/executionMapping.service");
const { runPlaywright } = require("../services/execution.service");
const logger = require("../utils/logger");

async function finalFlow(issueKey, testCases, testCaseKeys, story) {
  let cycleKey;
  try {
    // ── Create cycle with full Details + Traceability ───────────────────────
    const cycle = await setupCycle(issueKey, story);
    cycleKey = cycle.key;

    await runPlaywright();
    const results = parseResults();

    await createBugsForFailures(results, issueKey);

    results.forEach(r => {
      if (detectFlaky(r.title, r.passed)) {
        logger.warn(`Flaky test detected: ${r.title}`);
      }
    });

    const coverage = calculateCoverage(testCases, story || { fields: {} });
    logger.info(`Coverage: ${JSON.stringify(coverage)}`);

    // ── Map results with full Details, Traceability & execution History ─────
    await mapResults(cycleKey, testCaseKeys, results, story);

    // ── History — mark cycle as Done ────────────────────────────────────────
    await completeCycle(cycleKey);
  } catch (err) {
    logger.error(`finalFlow failed for ${issueKey}: ${err.message}`);
    // Still try to close cycle on failure
    if (cycleKey) {
      await completeCycle(cycleKey).catch(() => {});
    }
    throw err;
  }
}
module.exports = { finalFlow };
