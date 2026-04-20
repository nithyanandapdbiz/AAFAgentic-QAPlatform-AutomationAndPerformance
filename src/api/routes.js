'use strict';
const express = require("express");
const { getDashboard } = require("./dashboard.controller");
const { handleJiraWebhook, handleManualTrigger, getWebhookStatus } = require("./webhook.controller");
const { listAll, getSummary, listByTest, serveScreenshot } = require("./screenshot.controller");

const router = express.Router();

// ── Authentication middleware (opt-in via API_SECRET env var) ────────
function authMiddleware(req, res, next) {
  const secret = process.env.API_SECRET;
  if (!secret) return next(); // no secret configured — skip auth
  const token = (req.headers.authorization || "").replace(/^Bearer\s+/i, "");
  if (token !== secret) {
    return res.status(401).json({ error: "Unauthorized" });
  }
  next();
}

// ── Dashboard ─────────────────────────────────────────────────────
router.get("/dashboard", getDashboard);

// ── Webhooks ──────────────────────────────────────────────────────
router.post("/webhook/jira",   handleJiraWebhook);    // Jira → auto-trigger pipeline
router.post("/webhook/manual", authMiddleware, handleManualTrigger);   // Manual API trigger
router.get("/webhook/status",  authMiddleware, getWebhookStatus);      // Webhook config & recent triggers

// ── Screenshots ───────────────────────────────────────────────────
router.get("/screenshots/summary",     getSummary);           // Aggregated stats
router.get("/screenshots",             listAll);              // All tests + screenshots
router.get("/screenshots/:test",       listByTest);           // Screenshots for one test
router.get("/screenshots/:test/:file", serveScreenshot);      // Serve image file

module.exports = router;
