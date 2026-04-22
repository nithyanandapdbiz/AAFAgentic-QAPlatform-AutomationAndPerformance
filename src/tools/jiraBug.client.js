'use strict';
const axios = require("axios");
const config = require("../core/config");

// JIRA_BUG_ISSUETYPE lets you override (e.g. "Defect"); defaults to "Bug".
const BUG_ISSUETYPE = process.env.JIRA_BUG_ISSUETYPE || "Bug";

/**
 * Creates a Jira issue (bug) for the failing test and links it to the parent story.
 *
 * @param {object} test        - { title, error, file }
 * @param {string} parentKey   - Parent user story key, e.g. "SCRUM-5"
 */
async function createBug(test, parentKey) {
  const parentStory = parentKey || process.env.ISSUE_KEY || "";

  const response = await axios.post(
    `${config.jira.baseUrl}/rest/api/3/issue`,
    {
      fields: {
        project: { key: config.jira.projectKey },
        summary: `[Auto Bug] ${test.title}`,
        description: {
          type: "doc",
          version: 1,
          content: [
            {
              type: "paragraph",
              content: [{ type: "text", text: "Auto-created by Agentic QA Platform", marks: [{ type: "strong" }] }]
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: `Parent Story: ${parentStory || "N/A"}` }]
            },
            { type: "rule" },
            {
              type: "heading", attrs: { level: 3 },
              content: [{ type: "text", text: "Failed Test" }]
            },
            {
              type: "paragraph",
              content: [{ type: "text", text: test.title }]
            },
            {
              type: "heading", attrs: { level: 3 },
              content: [{ type: "text", text: "Error Details" }]
            },
            {
              type: "codeBlock", attrs: { language: "text" },
              content: [{ type: "text", text: test.error || "No error message captured" }]
            }
          ]
        },
        issuetype: { name: BUG_ISSUETYPE },
        labels: ["auto-bug", "playwright", "qa-platform"]
      }
    },
    { auth: { username: config.jira.email, password: config.jira.token } }
  );

  const bugKey = response.data.key;

  // Link the bug to the parent user story via the Jira issue link API
  if (bugKey && parentStory) {
    try {
      await axios.post(
        `${config.jira.baseUrl}/rest/api/3/issueLink`,
        {
          type:         { name: "Relates" },
          inwardIssue:  { key: bugKey },
          outwardIssue: { key: parentStory }
        },
        { auth: { username: config.jira.email, password: config.jira.token } }
      );
    } catch {
      // Link failure is non-fatal — bug is still created
    }
  }

  return response;
}

/**
 * Creates a Jira bug specifically for a pentest finding.
 * Adds CVSS score as a custom field (JIRA_CVSS_FIELD_ID) and security level
 * (JIRA_SECURITY_LEVEL_ID) when configured.
 *
 * @param {object} finding     - UnifiedFinding from pentest.execution.service
 * @param {string} parentKey   - Parent user story key, e.g. "SCRUM-5"
 * @param {object} jiraConfig  - { baseUrl, email, token, projectKey }
 * @returns {Promise<{key:string, url:string}>}
 */
async function createPentestBug(finding, parentKey, jiraConfig) {
  const cfg  = jiraConfig || {};
  const base = (cfg.baseUrl || '').replace(/\/$/, '');
  const auth = { username: cfg.email, password: cfg.token };
  const projectKey = cfg.projectKey || process.env.PROJECT_KEY;

  const priorityMap = { critical: 'Highest', high: 'High', medium: 'Medium', low: 'Low', info: 'Low' };
  const priority    = priorityMap[finding.severity] || 'Medium';

  const cveText  = finding.cve  ? `\n\n*CVE:* ${finding.cve}`  : '';
  const owaspText = finding.owasp ? `\n\n*OWASP:* ${finding.owasp}` : '';

  const fields = {
    project:   { key: projectKey },
    summary:   `[PENTEST][${(finding.severity || '').toUpperCase()}][${finding.tool}] ${finding.name}`,
    issuetype: { name: process.env.JIRA_BUG_ISSUETYPE || 'Bug' },
    priority:  { name: priority },
    labels:    ['pentest', finding.severity, finding.tool, 'security'].filter(Boolean),
    description: {
      type: 'doc',
      version: 1,
      content: [
        {
          type: 'heading', attrs: { level: 2 },
          content: [{ type: 'text', text: 'Penetration Test Finding' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: finding.description || finding.name || '' }],
        },
        {
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: 'Affected URL' }],
        },
        {
          type: 'codeBlock', attrs: { language: 'text' },
          content: [{ type: 'text', text: finding.url || 'N/A' }],
        },
        {
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: `CVSS Score: ${(finding.cvss || 0).toFixed(1)}${cveText}${owaspText}` }],
        },
        {
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: 'Evidence' }],
        },
        {
          type: 'codeBlock', attrs: { language: 'text' },
          content: [{ type: 'text', text: finding.evidence || 'No evidence captured.' }],
        },
        {
          type: 'heading', attrs: { level: 3 },
          content: [{ type: 'text', text: 'Remediation' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: finding.remediation || 'See OWASP guidance.' }],
        },
        {
          type: 'paragraph',
          content: [{ type: 'text', text: `Found by: ${finding.tool}`, marks: [{ type: 'em' }] }],
        },
      ],
    },
  };

  // Optional: CVSS custom field
  const cvssFieldId = process.env.JIRA_CVSS_FIELD_ID;
  if (cvssFieldId && finding.cvss != null) {
    fields[cvssFieldId] = parseFloat((finding.cvss || 0).toFixed(1));
  }

  // Optional: security level
  const secLevelId = process.env.JIRA_SECURITY_LEVEL_ID;
  if (secLevelId) {
    fields.security = { id: secLevelId };
  }

  const response = await axios.post(
    `${base}/rest/api/3/issue`,
    { fields },
    { auth }
  );

  const bugKey = response.data.key;
  const bugUrl = bugKey ? `${base}/browse/${bugKey}` : '';

  // Link to parent story
  if (bugKey && parentKey) {
    try {
      await axios.post(
        `${base}/rest/api/3/issueLink`,
        {
          type:         { name: 'Relates' },
          inwardIssue:  { key: bugKey },
          outwardIssue: { key: parentKey },
        },
        { auth }
      );
    } catch {
      // Link failure is non-fatal
    }
  }

  return { key: bugKey, url: bugUrl };
}

module.exports = { createBug, createPentestBug };
