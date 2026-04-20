'use strict';
const { createExecution, updateExecution, linkExecutionToIssue } = require("../tools/zephyrExecution.client");
const logger = require("../utils/logger");

const ENV_NAME = process.env.ZEPHYR_ENV_NAME || 'Chromium - Playwright (headless)';

/**
 * Maps Playwright results to Zephyr Scale executions with full Details,
 * Traceability, and History fields per Zephyr Essentials standards.
 *
 * @param {string} cycleKey          — Cycle key returned by setupCycle() e.g. "SCRUM-R1"
 * @param {Array<{id, key}>} testCaseRefs — Objects returned by executor.agent
 * @param {Array} results            — Playwright parsed results (title, passed, duration, error)
 * @param {object} [story]           — Jira story for traceability linking
 */
async function mapResults(cycleKey, testCaseRefs, results, story) {
  for (const r of results) {
    // Match on test case key substring in result title; fall back to first entry
    const ref =
      testCaseRefs.find(t => r.title.toLowerCase().includes(t.key.toLowerCase())) ||
      testCaseRefs[0];
    if (!ref) continue;

    const statusName = r.passed ? "Pass" : "Fail";
    const now = new Date().toISOString();

    // Build rich execution comment for History
    const commentParts = [
      `**Status:** ${statusName}`,
      `**Test Case:** ${ref.key}`,
      `**Cycle:** ${cycleKey}`,
      `**Duration:** ${r.duration ? (r.duration / 1000).toFixed(1) + 's' : 'N/A'}`,
      `**Environment:** ${ENV_NAME}`,
      `**Executed:** ${now}`
    ];
    if (r.retries > 0) {
      commentParts.push(`**Retries:** ${r.retries}`);
    }
    if (r.error) {
      commentParts.push(`**Error:** ${r.error.slice(0, 300)}`);
    }

    // Create execution with full Details
    const exec = await createExecution(cycleKey, ref.key, statusName, {
      environmentName: ENV_NAME,
      executionTime:   r.duration || 0,
      comment:         commentParts.join('\n'),
      actualEndDate:   now
    });

    // Traceability — link execution to the originating Jira story
    if (story && story.id) {
      try {
        await linkExecutionToIssue(exec.id, story.id);
      } catch (err) {
        logger.warn(`Failed to link execution ${exec.id} to ${story.key}: ${err.message}`);
      }
    }
  }
}
module.exports = { mapResults };
