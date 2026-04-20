'use strict';
const { createTestCycle, linkCycleToIssue, updateTestCycle, getTestCycle } = require("../tools/zephyrCycle.client");
const logger = require("../utils/logger");

/**
 * Creates a Zephyr Scale test cycle with full Details, Traceability & History.
 *
 * Details   — description, plannedStartDate/EndDate, statusName, ownerId
 * Traceability — links cycle to the originating Jira story/issue
 * History   — starts with "In Progress"; caller should update to "Done" via completeCycle()
 *
 * @param {string} storyKey  — Jira issue key, e.g. "SCRUM-5"
 * @param {object} [story]   — Full Jira issue object (from getStory)
 * @returns {{ key: string, id: number }}
 */
async function setupCycle(storyKey, story) {
  const now = new Date();
  const storyTitle = (story && story.fields && story.fields.summary) || storyKey;

  // ── Build readable cycle name ────────────────────────────────────────────
  const ts = now.toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-');
  const cycleName = `AutoRun-${storyKey}-${ts}`;

  // ── Build rich description ───────────────────────────────────────────────
  const descParts = [
    `Automated regression cycle for ${storyKey}: ${storyTitle}`,
    `Triggered: ${now.toISOString()}`,
    `Environment: Playwright + Chromium (headless)`,
    `Runner: agentic-qa-platform`
  ];
  if (story && story.fields && story.fields.priority) {
    descParts.push(`Story priority: ${story.fields.priority.name || 'Normal'}`);
  }
  if (story && story.fields && story.fields.status) {
    descParts.push(`Story status: ${story.fields.status.name || 'Unknown'}`);
  }

  // ── Resolve fixVersion ID for Jira project version link ──────────────────
  let jiraProjectVersion;
  if (story && story.fields && Array.isArray(story.fields.fixVersions) && story.fields.fixVersions.length) {
    jiraProjectVersion = Number(story.fields.fixVersions[0].id);
  }

  // ── Resolve owner from Jira assignee account ID ──────────────────────────
  let ownerId;
  if (story && story.fields && story.fields.assignee && story.fields.assignee.accountId) {
    ownerId = story.fields.assignee.accountId;
  }

  // ── Create cycle with full Details ───────────────────────────────────────
  const cycle = await createTestCycle(cycleName, {
    description:        descParts.join('\n'),
    plannedStartDate:   now.toISOString(),
    plannedEndDate:     new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),  // +2h default window
    statusName:         'In Progress',
    ownerId,
    jiraProjectVersion
  });

  logger.info(`Zephyr cycle created: ${cycle.key} (${cycleName})`);

  // ── Traceability — link cycle to originating Jira issue ──────────────────
  if (story && story.id) {
    try {
      await linkCycleToIssue(cycle.key, story.id);
      logger.info(`Cycle ${cycle.key} linked to Jira issue ${storyKey} (id: ${story.id})`);
    } catch (err) {
      logger.warn(`Failed to link cycle to ${storyKey}: ${err.message}`);
    }
  }

  return { key: cycle.key, id: cycle.id };
}

/**
 * History — marks a cycle as "Done" with actual end date after all executions.
 *
 * @param {string} cycleKey — e.g. "SCRUM-R1"
 */
async function completeCycle(cycleKey) {
  try {
    const existing = await getTestCycle(cycleKey);
    await updateTestCycle(cycleKey, {
      ...existing,
      statusName: 'Done',
      plannedEndDate: new Date().toISOString()
    });
    logger.info(`Cycle ${cycleKey} status updated to Done`);
  } catch (err) {
    logger.warn(`Failed to complete cycle ${cycleKey}: ${err.message}`);
  }
}

module.exports = { setupCycle, completeCycle };
