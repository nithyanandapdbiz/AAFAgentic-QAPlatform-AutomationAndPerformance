require('dotenv').config();
const express = require("express");
const config = require("./core/config");
const routes = require("./api/routes");
const logger = require("./utils/logger");

// Validate JIRA_URL is a well-formed absolute URL before starting
const jiraUrl = process.env.JIRA_URL || '';
if (!jiraUrl) {
  logger.error(
    'JIRA_URL is not set. ' +
    'Copy .env.example to .env and fill in your credentials. ' +
    'In CI, set them as GitHub Secrets.'
  );
  process.exit(1);
}
try {
  new URL(jiraUrl);
} catch {
  logger.error(`JIRA_URL is not a valid URL: "${jiraUrl}"`);
  process.exit(1);
}
if (!process.env.JIRA_EMAIL || !process.env.JIRA_API_TOKEN) {
  logger.error(
    'JIRA_EMAIL and JIRA_API_TOKEN must be set. ' +
    'Copy .env.example to .env and fill in your credentials.'
  );
  process.exit(1);
}

const app = express();
app.use(express.json());
app.use("/api", routes);

// Global error handler — prevents unhandled errors from crashing the server
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled route error: ${err.message}`);
  res.status(err.status || 500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

app.listen(config.port, () => logger.info(`API server running on port ${config.port}`));
