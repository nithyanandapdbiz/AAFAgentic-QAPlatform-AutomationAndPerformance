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

module.exports = { createBug };
