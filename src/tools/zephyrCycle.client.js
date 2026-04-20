'use strict';
const axios = require("axios");
const config = require("../core/config");
const { zephyrHeaders } = require("../utils/zephyrJwt");

/**
 * Zephyr Scale Cloud API v2 — Test Cycles
 *
 * POST /testcycles                              — create a cycle
 * GET  /testcycles/{key}                        — get a cycle by key
 * PUT  /testcycles/{key}                        — update a cycle
 * DELETE /testcycles/{key}                      — delete a cycle
 * POST /testcycles/{key}/links/issues           — link cycle → Jira issue (traceability)
 */

/**
 * Creates a test cycle with full Details per Zephyr Scale standards.
 *
 * @param {string} name   — Cycle name (required, max 255 chars)
 * @param {object} [opts] — Optional fields for Details, Traceability & History
 * @param {string} [opts.description]       — Scope / objective description
 * @param {string} [opts.plannedStartDate]  — ISO-8601 e.g. "2026-04-08T00:00:00Z"
 * @param {string} [opts.plannedEndDate]    — ISO-8601
 * @param {string} [opts.statusName]        — "Not Executed" | "In Progress" | "Done"
 * @param {string} [opts.ownerId]           — Atlassian Account ID
 * @param {number} [opts.jiraProjectVersion]— Jira fixVersion ID
 * @param {number} [opts.folderId]          — Zephyr folder ID
 * @param {object} [opts.customFields]      — key/value pairs for custom fields
 * @returns {{ id: number, key: string }}
 */
async function createTestCycle(name, opts = {}) {
  const body = {
    projectKey: config.zephyr.projectKey,
    name
  };

  // ── Details ──────────────────────────────────────────────────────────────
  if (opts.description)        body.description        = opts.description;
  if (opts.plannedStartDate)   body.plannedStartDate   = opts.plannedStartDate;
  if (opts.plannedEndDate)     body.plannedEndDate     = opts.plannedEndDate;
  if (opts.statusName)         body.statusName         = opts.statusName;
  if (opts.ownerId)            body.ownerId            = opts.ownerId;
  if (opts.jiraProjectVersion) body.jiraProjectVersion = opts.jiraProjectVersion;
  if (opts.folderId)           body.folderId           = opts.folderId;
  if (opts.customFields)       body.customFields       = opts.customFields;

  const res = await axios.post(
    `${config.zephyr.baseUrl}/testcycles`,
    body,
    { headers: zephyrHeaders() }
  );
  return { id: res.data.id, key: res.data.key };
}

async function getTestCycle(cycleKey) {
  const res = await axios.get(
    `${config.zephyr.baseUrl}/testcycles/${cycleKey}`,
    { headers: zephyrHeaders() }
  );
  return res.data;
}

async function updateTestCycle(cycleKey, fields) {
  await axios.put(
    `${config.zephyr.baseUrl}/testcycles/${cycleKey}`,
    fields,
    { headers: zephyrHeaders() }
  );
}

async function deleteTestCycle(cycleKey) {
  await axios.delete(
    `${config.zephyr.baseUrl}/testcycles/${cycleKey}`,
    { headers: zephyrHeaders() }
  );
}

/**
 * Traceability — link a test cycle to a Jira issue.
 * POST /testcycles/{cycleKey}/links/issues  { issueId }
 *
 * @param {string} cycleKey — e.g. "SCRUM-R1"
 * @param {number} issueId  — numeric Jira issue ID (story.id)
 */
async function linkCycleToIssue(cycleKey, issueId) {
  await axios.post(
    `${config.zephyr.baseUrl}/testcycles/${cycleKey}/links/issues`,
    { issueId: Number(issueId) },
    { headers: zephyrHeaders() }
  );
}

module.exports = {
  createTestCycle,
  getTestCycle,
  updateTestCycle,
  deleteTestCycle,
  linkCycleToIssue
};
