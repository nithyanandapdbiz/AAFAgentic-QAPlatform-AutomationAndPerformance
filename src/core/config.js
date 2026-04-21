'use strict';

const fs   = require('fs');
const path = require('path');

// Strip any trailing slash from JIRA_URL to avoid double-slash in API paths
const jiraUrl = (process.env.JIRA_URL || "").replace(/\/$/, "");

// ─── Performance Config ───────────────────────────────────────────────────────
// All perf service files MUST import from here rather than reading process.env directly.
const perfConfig = {
  // k6 binary path — validated at startup if set
  k6Binary: process.env.PERF_K6_BINARY || 'k6',

  // Per-test-type SLA thresholds (ms / fraction)
  thresholds: {
    load:        { p95: parseInt(process.env.PERF_LOAD_P95   || '2000', 10), p99: parseInt(process.env.PERF_LOAD_P99   || '4000', 10), errorRate: parseFloat(process.env.PERF_LOAD_ERROR   || '0.01') },
    stress:      { p95: parseInt(process.env.PERF_STRESS_P95 || '3500', 10), p99: parseInt(process.env.PERF_STRESS_P99 || '6000', 10), errorRate: parseFloat(process.env.PERF_STRESS_ERROR || '0.02') },
    spike:       { p95: parseInt(process.env.PERF_SPIKE_P95  || '5000', 10), p99: parseInt(process.env.PERF_SPIKE_P99  || '9000', 10), errorRate: parseFloat(process.env.PERF_SPIKE_ERROR  || '0.05') },
    soak:        { p95: parseInt(process.env.PERF_SOAK_P95   || '2200', 10), p99: parseInt(process.env.PERF_SOAK_P99   || '4500', 10), errorRate: parseFloat(process.env.PERF_SOAK_ERROR   || '0.005') },
    scalability: { p95: parseInt(process.env.PERF_SCALE_P95  || '3000', 10), p99: parseInt(process.env.PERF_SCALE_P99  || '5500', 10), errorRate: parseFloat(process.env.PERF_SCALE_ERROR  || '0.015') },
    breakpoint:  { p95: parseInt(process.env.PERF_BREAK_P95  || '99999', 10), p99: parseInt(process.env.PERF_BREAK_P99 || '99999', 10), errorRate: parseFloat(process.env.PERF_BREAK_ERROR || '0.10') },
  },

  // Per-metric baseline regression tolerances
  baselineTolerances: {
    p95:       parseFloat(process.env.PERF_BASELINE_TOL_P95 || '0.15'),
    p99:       parseFloat(process.env.PERF_BASELINE_TOL_P99 || '0.20'),
    avg:       parseFloat(process.env.PERF_BASELINE_TOL_AVG || '0.10'),
    errorRate: parseFloat(process.env.PERF_BASELINE_TOL_ERR || '0.005'),
    reqRate:   parseFloat(process.env.PERF_BASELINE_TOL_RPS || '0.10'),
  },

  // Rolling window size for baseline history
  baselineWindow: parseInt(process.env.PERF_BASELINE_WINDOW || '5', 10),

  // VU configuration
  vusMax:       parseInt(process.env.PERF_VUS_MAX || '50', 10),
  soakDuration: process.env.PERF_SOAK_DURATION || '30m',
  skipSoak:     process.env.PERF_SKIP_SOAK === 'true',

  // Near-threshold warning percentage (0.10 = 10%)
  warnPct: parseFloat(process.env.PERF_WARN_PCT || '0.10'),

  // Legacy flat thresholds (backward-compat fallback)
  legacyThresholds: {
    p95:       parseInt(process.env.PERF_THRESHOLDS_P95         || '2000',  10),
    p99:       parseInt(process.env.PERF_THRESHOLDS_P99         || '5000',  10),
    errorRate: parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01'),
  },
};

// ─── Startup: k6 binary validation ───────────────────────────────────────────
(function validateK6Binary() {
  if (!process.env.PERF_K6_BINARY) return; // not configured — skip
  try {
    const { spawnSync } = require('child_process');
    const result = spawnSync(perfConfig.k6Binary, ['version'], { encoding: 'utf8', timeout: 5000 });
    if (result.error || result.status !== 0) {
      const msg = result.error ? result.error.message : `exit ${result.status}`;
      // Log warning only — do NOT exit; platform should still start
      console.warn(`[config] WARNING: PERF_K6_BINARY="${perfConfig.k6Binary}" is set but does not appear executable (${msg}). Performance tests will fail.`);
    }
  } catch (e) {
    console.warn(`[config] WARNING: Could not validate PERF_K6_BINARY: ${e.message}`);
  }
})();

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
  perf: perfConfig,
  agent: {
    // Minimum confidence required for a planner category to be selected.
    // Also used by QA agent to trigger fallback test cases.
    confidenceThreshold: parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.4'),
  },
};
