'use strict';
const axios = require("axios");
const config = require("../core/config");
const { zephyrHeaders } = require("../utils/zephyrJwt");

/**
 * Zephyr Scale Cloud API v2 — Test Executions
 *
 * POST /testexecutions                              — create an execution
 * GET  /testexecutions/{id}                         — get an execution
 * PUT  /testexecutions/{id}                         — update status / comment
 * DELETE /testexecutions/{id}                       — delete an execution
 * GET /testexecutions                               — search executions
 * POST /testexecutions/{id}/links/issues            — link execution → Jira issue
 *
 * Status name values: "Pass", "Fail", "In Progress", "Blocked", "Not Executed"
 */

/**
 * Creates a test execution with full Details per Zephyr Scale standards.
 *
 * @param {string} cycleKey        — e.g. "SCRUM-R1"
 * @param {string} testCaseKey     — e.g. "SCRUM-T33"
 * @param {string} [statusName]    — default "In Progress"
 * @param {object} [opts]          — Optional fields
 * @param {string} [opts.environmentName]  — e.g. "Chrome - Windows"
 * @param {number} [opts.executionTime]    — actual duration in ms
 * @param {string} [opts.comment]          — execution comment
 * @param {string} [opts.actualEndDate]    — ISO-8601
 * @param {string} [opts.executedById]     — Atlassian Account ID
 * @param {string} [opts.assignedToId]     — Atlassian Account ID
 * @returns {{ id: number, key: string }}
 */
async function createExecution(cycleKey, testCaseKey, statusName = "In Progress", opts = {}) {
  const body = {
    projectKey: config.zephyr.projectKey,
    testCaseKey,
    testCycleKey: cycleKey,
    statusName
  };

  if (opts.environmentName) body.environmentName = opts.environmentName;
  if (opts.executionTime != null) body.executionTime = opts.executionTime;
  if (opts.comment)         body.comment         = opts.comment;
  if (opts.actualEndDate)   body.actualEndDate   = opts.actualEndDate;
  if (opts.executedById)    body.executedById     = opts.executedById;
  if (opts.assignedToId)    body.assignedToId     = opts.assignedToId;

  const res = await axios.post(
    `${config.zephyr.baseUrl}/testexecutions`,
    body,
    { headers: zephyrHeaders() }
  );
  return { id: res.data.id, key: testCaseKey };
}

/**
 * Updates a test execution with full audit trail fields.
 *
 * @param {string|number} executionId
 * @param {string} statusName        — "Pass" | "Fail" | "Blocked" | "Not Executed"
 * @param {string} [comment]
 * @param {object} [opts]
 * @param {number} [opts.executionTime]    — actual duration in ms
 * @param {string} [opts.environmentName]  — environment label
 * @param {string} [opts.actualEndDate]    — ISO-8601
 * @param {string} [opts.executedById]     — Atlassian Account ID
 */
async function updateExecution(executionId, statusName, comment = "", opts = {}) {
  const body = { statusName };
  if (comment) body.comment = comment;
  if (opts.executionTime != null) body.executionTime  = opts.executionTime;
  if (opts.environmentName)       body.environmentName = opts.environmentName;
  if (opts.actualEndDate)         body.actualEndDate   = opts.actualEndDate;
  if (opts.executedById)          body.executedById     = opts.executedById;

  await axios.put(
    `${config.zephyr.baseUrl}/testexecutions/${executionId}`,
    body,
    { headers: zephyrHeaders() }
  );
}

async function getExecution(executionId) {
  const res = await axios.get(
    `${config.zephyr.baseUrl}/testexecutions/${executionId}`,
    { headers: zephyrHeaders() }
  );
  return res.data;
}

async function deleteExecution(executionId) {
  await axios.delete(
    `${config.zephyr.baseUrl}/testexecutions/${executionId}`,
    { headers: zephyrHeaders() }
  );
}

/**
 * Search executions — filter by cycleKey, testCaseKey, or project.
 */
async function searchExecutions({ cycleKey, testCaseKey, maxResults = 50, startAt = 0 } = {}) {
  const params = { projectKey: config.zephyr.projectKey, maxResults, startAt };
  if (cycleKey) params.testCycleKey = cycleKey;
  if (testCaseKey) params.testCaseKey = testCaseKey;
  const res = await axios.get(
    `${config.zephyr.baseUrl}/testexecutions`,
    { headers: zephyrHeaders(), params }
  );
  return res.data;
}

/**
 * Traceability — link a test execution to a Jira issue.
 * POST /testexecutions/{executionId}/links/issues  { issueId }
 *
 * @param {string|number} executionId
 * @param {number} issueId — numeric Jira issue ID
 */
async function linkExecutionToIssue(executionId, issueId) {
  await axios.post(
    `${config.zephyr.baseUrl}/testexecutions/${executionId}/links/issues`,
    { issueId: Number(issueId) },
    { headers: zephyrHeaders() }
  );
}

module.exports = {
  createExecution,
  updateExecution,
  getExecution,
  deleteExecution,
  searchExecutions,
  linkExecutionToIssue
};
