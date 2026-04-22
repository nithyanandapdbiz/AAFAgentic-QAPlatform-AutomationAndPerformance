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
    load:        { p95: parseInt(process.env.PERF_LOAD_P95    || '2000',  10), p99: parseInt(process.env.PERF_LOAD_P99    || '4000',  10), errorRate: parseFloat(process.env.PERF_LOAD_ERROR    || '0.01') },
    stress:      { p95: parseInt(process.env.PERF_STRESS_P95  || '3500',  10), p99: parseInt(process.env.PERF_STRESS_P99  || '6000',  10), errorRate: parseFloat(process.env.PERF_STRESS_ERROR  || '0.02') },
    spike:       { p95: parseInt(process.env.PERF_SPIKE_P95   || '5000',  10), p99: parseInt(process.env.PERF_SPIKE_P99   || '9000',  10), errorRate: parseFloat(process.env.PERF_SPIKE_ERROR   || '0.05') },
    soak:        { p95: parseInt(process.env.PERF_SOAK_P95    || '2200',  10), p99: parseInt(process.env.PERF_SOAK_P99    || '4500',  10), errorRate: parseFloat(process.env.PERF_SOAK_ERROR    || '0.005') },
    scalability: { p95: parseInt(process.env.PERF_SCALE_P95   || '3000',  10), p99: parseInt(process.env.PERF_SCALE_P99   || '5500',  10), errorRate: parseFloat(process.env.PERF_SCALE_ERROR   || '0.015') },
    breakpoint:  { p95: parseInt(process.env.PERF_BREAK_P95   || '99999', 10), p99: parseInt(process.env.PERF_BREAK_P99   || '99999', 10), errorRate: parseFloat(process.env.PERF_BREAK_ERROR   || '0.10') },
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

// ─── Security Config ──────────────────────────────────────────────────────────
const secConfig = {};

// ─── Penetration Testing Config ───────────────────────────────────────────────
const pentestConfig = {
  enabled:       process.env.PENTEST_ENABLED === 'true',
  targetUrl:     process.env.PENTEST_TARGET_URL || process.env.BASE_URL || 'http://localhost:3000',
  allowedHosts:  (process.env.PENTEST_ALLOWED_HOSTS || '')
                   .split(',').map(h => h.trim().toLowerCase()).filter(Boolean),
  failOn:        (process.env.PENTEST_FAIL_ON || 'critical').toLowerCase(),
  warnOn:        (process.env.PENTEST_WARN_ON || 'high').toLowerCase(),

  nuclei: {
    binary:        process.env.NUCLEI_BINARY         || 'nuclei',
    templatesPath: process.env.NUCLEI_TEMPLATES_PATH || '',
    rateLimit:     parseInt(process.env.NUCLEI_RATE_LIMIT  || '50', 10),
    timeout:       parseInt(process.env.NUCLEI_TIMEOUT     || '10', 10),
  },

  sqlmap: {
    binary:     process.env.SQLMAP_BINARY       || 'sqlmap',
    apiPort:    parseInt(process.env.SQLMAP_API_PORT   || '8778', 10),
    level:      parseInt(process.env.SQLMAP_LEVEL      || '2', 10),
    risk:       parseInt(process.env.SQLMAP_RISK       || '2', 10),
    timeoutMs:  parseInt(process.env.SQLMAP_TIMEOUT_MS || '300000', 10),
  },

  ffuf: {
    binary:      process.env.FFUF_BINARY    || 'ffuf',
    seclistPath: process.env.SECLIST_PATH   || '/usr/share/seclists',
    rate:        parseInt(process.env.FFUF_RATE    || '100', 10),
    threads:     parseInt(process.env.FFUF_THREADS || '40', 10),
  },

  zapAuth: {
    ignoreSSL:         process.env.ZAP_IGNORE_SSL_ERRORS === 'true',
    username:          process.env.PENTEST_AUTH_USERNAME     || '',
    password:          process.env.PENTEST_AUTH_PASSWORD     || '',
    loginUrl:          process.env.PENTEST_AUTH_LOGIN_URL    || '',
    usernameField:     process.env.PENTEST_AUTH_USER_FIELD   || 'username',
    passwordField:     process.env.PENTEST_AUTH_PASS_FIELD   || 'password',
    loggedInIndicator: process.env.PENTEST_AUTH_LOGGED_IN    || '\\Qsign-out\\E',
  },

  jira: {
    cvssFieldId:     process.env.JIRA_CVSS_FIELD_ID      || '',
    securityLevelId: process.env.JIRA_SECURITY_LEVEL_ID  || '',
  },
};

// Startup: validate pentest binary availability when PENTEST_ENABLED=true
(function validatePentestBinaries() {
  if (!pentestConfig.enabled) return;
  const { spawnSync } = require('child_process');
  const binaries = [
    { name: 'nuclei',  bin: pentestConfig.nuclei.binary,  arg: '-version' },
    { name: 'sqlmap',  bin: pentestConfig.sqlmap.binary,   arg: '--version' },
    { name: 'ffuf',    bin: pentestConfig.ffuf.binary,     arg: '-V' },
  ];
  for (const { name, bin, arg } of binaries) {
    try {
      const r = spawnSync(bin, [arg], { encoding: 'utf8', timeout: 5000 });
      if (r.error) {
        console.warn(`[config] WARNING: ${name} binary "${bin}" not found or not executable. Install it or set ${name.toUpperCase()}_BINARY in .env.`);
      }
    } catch (e) {
      console.warn(`[config] WARNING: Could not validate ${name} binary: ${e.message}`);
    }
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
  sec:  secConfig,
  pentest: pentestConfig,
  agent: {
    // Minimum confidence required for a planner category to be selected.
    // Also used by QA agent to trigger fallback test cases.
    confidenceThreshold: parseFloat(process.env.AGENT_CONFIDENCE_THRESHOLD || '0.4'),
  },
  // ─── API security ──────────────────────────────────────────────────
  api: {
    rateLimitWindowMs: parseInt(process.env.RATE_LIMIT_WINDOW_MS || '60000', 10),
    rateLimitMax:      parseInt(process.env.RATE_LIMIT_MAX       || '100',   10),
  },
  // ─── Playwright execution ──────────────────────────────────────────
  playwright: {
    maxBufferMb:   parseInt(process.env.PLAYWRIGHT_MAX_BUFFER_MB    || '50',     10),
    streamOutput:  process.env.PLAYWRIGHT_STREAM_OUTPUT === 'true',
    execTimeoutMs: parseInt(process.env.PLAYWRIGHT_EXEC_TIMEOUT_MS  || '300000', 10),
  },
  // ─── Pipeline concurrency ──────────────────────────────────────────
  pipeline: {
    lockTimeoutMs: parseInt(process.env.PIPELINE_LOCK_TIMEOUT_MS || '1800000', 10),
  },
};

// ─── Async secrets initialisation (opt-in) ─────────────────────────────────
// Back-compat: the default export above is synchronous and reads directly
// from process.env, so every existing consumer continues to work unchanged.
// NEW: call `await initConfig()` in entry-points that want provider-backed
// secrets (vault / aws). The function mutates the exported object in place,
// so subsequent `require('./config')` calls see the resolved values.
let _initialised = (process.env.SECRETS_PROVIDER || 'env') === 'env';

async function initConfig() {
  if (_initialised) return module.exports;
  const { getSecret } = require('../utils/secrets');
  module.exports.jira.token      = await getSecret('JIRA_API_TOKEN');
  module.exports.zephyr.token    = await getSecret('ZEPHYR_ACCESS_KEY');
  if (process.env.ZAP_API_KEY   || process.env.SECRETS_PROVIDER === 'vault') {
    try { process.env.ZAP_API_KEY   = await getSecret('ZAP_API_KEY');   } catch (_e) { /* optional */ }
  }
  if (process.env.WEBHOOK_SECRET || process.env.SECRETS_PROVIDER === 'vault') {
    try { process.env.WEBHOOK_SECRET = await getSecret('WEBHOOK_SECRET'); } catch (_e) { /* optional */ }
  }
  if (process.env.API_SECRET    || process.env.SECRETS_PROVIDER === 'vault') {
    try { process.env.API_SECRET    = await getSecret('API_SECRET');    } catch (_e) { /* optional */ }
  }
  _initialised = true;
  return module.exports;
}

function getConfig() {
  if (!_initialised) {
    throw new Error('Config not initialised — call await initConfig() before accessing config');
  }
  return module.exports;
}

module.exports.initConfig = initConfig;
module.exports.getConfig  = getConfig;
