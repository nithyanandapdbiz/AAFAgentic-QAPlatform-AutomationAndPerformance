'use strict';

// Strip any trailing slash from JIRA_URL to avoid double-slash in API paths
const jiraUrl = (process.env.JIRA_URL || "").replace(/\/$/, "");

module.exports = {
  port: process.env.PORT || 3000,
  jira: {
    baseUrl: jiraUrl,
    email: process.env.JIRA_EMAIL,
    token: process.env.JIRA_API_TOKEN,
    projectKey: process.env.PROJECT_KEY
  },
  // Zephyr Essential Cloud API v2.8
  // Base URL: https://prod-api.zephyr4jiracloud.com/v2
  // Auth: Authorization: <token>  (the ZEPHYR_API_TOKEN is used directly as a Bearer token)
  zephyr: {
    baseUrl: process.env.ZEPHYR_BASE_URL || "https://prod-api.zephyr4jiracloud.com/v2",
    token: process.env.ZEPHYR_ACCESS_KEY,
    projectKey: process.env.PROJECT_KEY
  },
};
