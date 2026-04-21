require('dotenv').config();
const express = require("express");
const config = require("./core/config");
const { initConfig } = require("./core/config");
const routes = require("./api/routes");
const logger = require("./utils/logger");
const { securityHeaders } = require("./api/middleware/securityHeaders");
const { rateLimiter }     = require("./api/middleware/rateLimiter");

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
app.disable('x-powered-by');

// App-level hardening (applies to EVERY response, not just /api) ─────
app.use(securityHeaders);
app.use(rateLimiter);
app.use(express.json({ limit: '1mb' }));

app.use("/api", routes);

// Global error handler — prevents unhandled errors from crashing the server
app.use((err, _req, res, _next) => {
  logger.error(`Unhandled route error: ${err.message}`);
  res.status(err.status || 500).json({ error: "Internal server error" });
});

process.on("unhandledRejection", (reason) => {
  logger.error(`Unhandled rejection: ${reason}`);
});

// Async startup so initConfig() can resolve secrets before we accept traffic.
(async () => {
  try {
    await initConfig();
    logger.info(`Secrets loaded via provider: ${process.env.SECRETS_PROVIDER || 'env'}`);
    logger.info(
      `Security middleware loaded: rate-limit=${config.api.rateLimitMax}req/` +
      `${config.api.rateLimitWindowMs}ms, auth=${process.env.API_SECRET ? 'token' : 'disabled'}`
    );
    app.listen(config.port, () => logger.info(`API server running on port ${config.port}`));
  } catch (err) {
    logger.error(`Server startup failed: ${err.message}`);
    process.exit(1);
  }
})();
