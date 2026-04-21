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
module.exports = { mapResults, validateMapping };

/**
 * validateMapping — quick sanity check that a story has usable Zephyr
 * test cases before the executor attempts to create executions.
 *
 * Looks up test cases via GET /testcases?projectKey=&folderId= (or by Jira
 * issueLinks). Returns structured outcome so callers can halt the pipeline
 * early when the mapping is clearly broken.
 *
 * @param {string} storyKey   - e.g. "SCRUM-6"
 * @returns {Promise<{valid:boolean, testCaseCount:number, missingKeys:string[], reason?:string}>}
 */
async function validateMapping(storyKey) {
  if (!storyKey || typeof storyKey !== 'string') {
    return { valid: false, testCaseCount: 0, missingKeys: [], reason: 'storyKey is required' };
  }

  // We don't have a direct "test cases for story" endpoint in all Zephyr tiers.
  // Instead we read the handoff file produced by scripts/run-story.js which
  // enumerates exactly the keys created/linked for this story in this run.
  const fs   = require('fs');
  const path = require('path');
  const handoff = path.resolve(process.cwd(), '.story-testcases.json');

  if (!fs.existsSync(handoff)) {
    return {
      valid:         false,
      testCaseCount: 0,
      missingKeys:   [],
      reason:        'No .story-testcases.json handoff file — run scripts/run-story.js first.'
    };
  }

  let payload;
  try { payload = JSON.parse(fs.readFileSync(handoff, 'utf8')); }
  catch (e) { return { valid: false, testCaseCount: 0, missingKeys: [], reason: `handoff parse error: ${e.message}` }; }

  const keys = Array.isArray(payload?.keys) ? payload.keys : [];
  if (keys.length === 0) {
    return {
      valid:         false,
      testCaseCount: 0,
      missingKeys:   [],
      reason:        `handoff file has no test case keys for story ${storyKey}`
    };
  }

  // Verify each key has a corresponding spec file (tests/specs/<KEY>_*.spec.js)
  const specsDir = path.resolve(process.cwd(), 'tests', 'specs');
  const specFiles = fs.existsSync(specsDir) ? fs.readdirSync(specsDir) : [];
  const missingKeys = keys.filter(k =>
    !specFiles.some(f => f.toUpperCase().startsWith(String(k).toUpperCase() + '_'))
  );

  return {
    valid:         missingKeys.length === 0,
    testCaseCount: keys.length,
    missingKeys,
    reason:        missingKeys.length === 0
      ? undefined
      : `${missingKeys.length} test case(s) have no spec file in tests/specs/`
  };
}
