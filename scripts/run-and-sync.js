'use strict';
/**
 * run-and-sync.js
 *
 * 1. Runs all Playwright tests in tests/specs/ and captures JSON results.
 * 2. Parses results — maps each spec file → Zephyr test case key (from filename).
 * 3. Creates a new Zephyr test cycle named "AutoRun-SCRUM-5-<timestamp>".
 * 4. For every test case: creates an execution in the cycle, then updates its
 *    status (Pass / Fail / Blocked / Not Executed) based on Playwright output.
 *
 * Usage:
 *   node scripts/run-and-sync.js
 */

require('dotenv').config();
const { execSync }      = require('child_process');
const fs                = require('fs');
const path              = require('path');
const axios             = require('axios');
const { retry }         = require('../src/utils/retry');

// Zephyr request timeout (ms) — prevents indefinite hangs when the API is unreachable.
const ZEPHYR_TIMEOUT_MS = parseInt(process.env.ZEPHYR_TIMEOUT_MS || '15000', 10);

// ─── Jira config (for traceability) ───────────────────────────────────────────
const JIRA_URL     = (process.env.JIRA_URL || '').replace(/\/$/, '');
const JIRA_EMAIL   = process.env.JIRA_EMAIL;
const JIRA_TOKEN   = process.env.JIRA_API_TOKEN;
const ENV_NAME     = process.env.ZEPHYR_ENV_NAME || 'Chromium - Playwright (headless)';

// ─── Paths ────────────────────────────────────────────────────────────────────
const ROOT             = path.resolve(__dirname, '..');
const RESULTS_FILE     = path.join(ROOT, 'test-results.json');
const SPECS_DIR        = path.join(ROOT, 'tests', 'specs');

// ─── Zephyr config ────────────────────────────────────────────────────────────
const ZEPHYR_BASE  = process.env.ZEPHYR_BASE_URL  || 'https://prod-api.zephyr4jiracloud.com/v2';
const ZEPHYR_TOKEN = process.env.ZEPHYR_ACCESS_KEY;
const PROJECT_KEY  = process.env.PROJECT_KEY       || 'SCRUM';
const ISSUE_KEY    = process.env.ISSUE_KEY         || 'SCRUM-5';

function zHeaders() {
  return {
    Authorization:  ZEPHYR_TOKEN,
    'Content-Type': 'application/json',
    Accept:         'application/json'
  };
}

// ─── Status mapping ───────────────────────────────────────────────────────────
// Playwright result.status  → Zephyr status name
const STATUS_MAP = {
  passed:   'Pass',
  failed:   'Fail',
  timedOut: 'Blocked',
  skipped:  'Not Executed',
  // ok shorthand used for suite-level
  ok:       'Pass',
  notOk:    'Fail'
};

// ─── Playwright JSON parser ───────────────────────────────────────────────────
/**
 * Recursively walk the Playwright JSON reporter tree.
 *
 * Structure (Playwright v1.40+):
 *   suites[]                 ← one per spec FILE  (suite.file = basename)
 *     .suites[]              ← one per test.describe()
 *       .specs[]             ← one per test()
 *         .ok                ← boolean (after retries)
 *         .tests[].results[].status   "passed"|"failed"|"timedOut"|"skipped"
 *
 * Returns [{ zephyrKey, title, status, error }]
 */
function collectTests(suites, parentFile = '') {
  const results = [];
  for (const suite of (suites || [])) {
    const file = suite.file || parentFile;

    // Extract Zephyr key from filename  "SCRUM-T3_verify_...spec.js"
    const keyMatch  = path.basename(file).match(/^(SCRUM-T\d+)_/i);
    const zephyrKey = keyMatch ? keyMatch[1].toUpperCase() : null;

    // ── Recurse into nested describe-blocks (suite.suites) ───────────────
    if (suite.suites && suite.suites.length) {
      results.push(...collectTests(suite.suites, file));
    }

    // ── Collect leaf tests from `specs` (Playwright ≥1.40 JSON schema) ──
    for (const spec of (suite.specs || [])) {
      let finalStatus = 'Not Executed';

      if (Array.isArray(spec.tests) && spec.tests.length > 0) {
        // Use the LAST test attempt (covers retries)
        const lastTest = spec.tests[spec.tests.length - 1];
        if (Array.isArray(lastTest.results) && lastTest.results.length > 0) {
          const lastResult = lastTest.results[lastTest.results.length - 1];
          finalStatus = STATUS_MAP[lastResult.status] || 'Fail';
        } else {
          finalStatus = lastTest.status === 'expected' ? 'Pass' : 'Fail';
        }
      } else if (typeof spec.ok === 'boolean') {
        finalStatus = spec.ok ? 'Pass' : 'Fail';
      }

      results.push({
        zephyrKey,
        title:  spec.title,
        status: finalStatus,
        error:  extractError(spec)
      });
    }
  }
  return results;
}

function extractError(spec) {
  if (!Array.isArray(spec.tests)) return '';
  for (const t of spec.tests) {
    if (!Array.isArray(t.results)) continue;
    for (const r of t.results) {
      const msg = r.error && (r.error.message || (typeof r.error === 'string' ? r.error : ''));
      if (msg) return String(msg).slice(0, 300);
    }
  }
  return '';
}

/**
 * Roll up per-key: if ANY test for a key failed → Fail, else Pass.
 * Returns Map<zephyrKey, { status, error }>
 */
function rollupByKey(tests) {
  const map = new Map();
  for (const t of tests) {
    if (!t.zephyrKey) continue;
    const prev = map.get(t.zephyrKey);
    if (!prev) {
      map.set(t.zephyrKey, { status: t.status, error: t.error });
    } else if (prev.status !== 'Fail' && t.status === 'Fail') {
      map.set(t.zephyrKey, { status: 'Fail', error: t.error || prev.error });
    } else if (prev.status !== 'Fail' && t.status === 'Blocked') {
      map.set(t.zephyrKey, { status: 'Blocked', error: t.error || prev.error });
    }
  }
  return map;
}

// ─── Zephyr API calls ─────────────────────────────────────────────────────────
/**
 * Fetch all test cases for the project from Zephyr Scale.
 * Uses a request timeout and up to 3 retries with 3-second back-off so that
 * transient network blips (ETIMEDOUT / ECONNRESET) do not immediately crash
 * the sync pipeline.
 */
async function fetchTestCases() {
  return retry(async () => {
    const res = await axios.get(`${ZEPHYR_BASE}/testcases`, {
      headers: zHeaders(),
      params:  { projectKey: PROJECT_KEY, maxResults: 100 },
      timeout: ZEPHYR_TIMEOUT_MS,
    });
    return res.data.values || res.data || [];
  }, 3, 3000);
}

/**
 * Fetch the Jira story for traceability — returns { id, key, fields } or null.
 */
async function fetchJiraIssue(issueKey) {
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN) return null;
  try {
    const res = await axios.get(`${JIRA_URL}/rest/api/3/issue/${encodeURIComponent(issueKey)}`, {
      auth: { username: JIRA_EMAIL, password: JIRA_TOKEN }
    });
    return res.data;
  } catch {
    return null;
  }
}

/**
 * Creates a test cycle with full Details per Zephyr Scale standards.
 */
async function createCycle(name, story) {
  const now = new Date();
  const storyTitle = (story && story.fields && story.fields.summary) || ISSUE_KEY;

  const descParts = [
    `Automated regression cycle for ${ISSUE_KEY}: ${storyTitle}`,
    `Triggered: ${now.toISOString()}`,
    `Environment: ${ENV_NAME}`,
    `Runner: run-and-sync.js (agentic-qa-platform)`
  ];
  if (story && story.fields && story.fields.priority) {
    descParts.push(`Story priority: ${story.fields.priority.name || 'Normal'}`);
  }
  if (story && story.fields && story.fields.status) {
    descParts.push(`Story status: ${story.fields.status.name || 'Unknown'}`);
  }

  const body = {
    projectKey:       PROJECT_KEY,
    name,
    description:      descParts.join('\n'),
    plannedStartDate: now.toISOString(),
    plannedEndDate:   new Date(now.getTime() + 2 * 60 * 60 * 1000).toISOString(),
    statusName:       'In Progress'
  };

  // Link to Jira fixVersion if available
  if (story && story.fields && Array.isArray(story.fields.fixVersions) && story.fields.fixVersions.length) {
    body.jiraProjectVersion = Number(story.fields.fixVersions[0].id);
  }
  // Set owner from Jira assignee
  if (story && story.fields && story.fields.assignee && story.fields.assignee.accountId) {
    body.ownerId = story.fields.assignee.accountId;
  }

  const res = await axios.post(`${ZEPHYR_BASE}/testcycles`, body, { headers: zHeaders() });
  return { id: res.data.id, key: res.data.key };
}

/**
 * Traceability — link a test cycle to its originating Jira issue.
 */
async function linkCycleToIssue(cycleKey, issueId) {
  try {
    await axios.post(`${ZEPHYR_BASE}/testcycles/${cycleKey}/links/issues`,
      { issueId: Number(issueId) }, { headers: zHeaders() });
    return true;
  } catch { return false; }
}

/**
 * Traceability — link a test execution to a Jira issue.
 */
async function linkExecutionToIssue(execId, issueId) {
  try {
    await axios.post(`${ZEPHYR_BASE}/testexecutions/${execId}/links/issues`,
      { issueId: Number(issueId) }, { headers: zHeaders() });
    return true;
  } catch { return false; }
}

/**
 * History — update cycle status ("In Progress" → "Done") with actual end date.
 */
async function updateCycleStatus(cycleKey, statusName) {
  try {
    const current = await axios.get(`${ZEPHYR_BASE}/testcycles/${cycleKey}`, { headers: zHeaders() });
    await axios.put(`${ZEPHYR_BASE}/testcycles/${cycleKey}`, {
      ...current.data,
      statusName,
      plannedEndDate: new Date().toISOString()
    }, { headers: zHeaders() });
    return true;
  } catch { return false; }
}

async function createExecution(cycleKey, testCaseKey) {
  const res = await axios.post(`${ZEPHYR_BASE}/testexecutions`, {
    projectKey:   PROJECT_KEY,
    testCaseKey,
    testCycleKey: cycleKey,
    statusName:   'In Progress'
  }, { headers: zHeaders() });
  return res.data.id;
}

async function updateExecution(execId, statusName, comment = '') {
  const body = { statusName };
  if (comment) body.comment = comment;
  await axios.put(`${ZEPHYR_BASE}/testexecutions/${execId}`, body, { headers: zHeaders() });
}

// Mark a test case as Automated in Zephyr (called only after TC has been executed by Playwright)
async function markAsAutomated(tcKey) {
  try {
    // GET existing TC so we can do a full-body PUT (Zephyr requires all fields)
    const existing = await axios.get(
      `${ZEPHYR_BASE}/testcases/${tcKey}`,
      { headers: zHeaders() }
    );
    await axios.put(
      `${ZEPHYR_BASE}/testcases/${tcKey}`,
      { ...existing.data, projectKey: PROJECT_KEY, automationStatus: 'Automated' },
      { headers: zHeaders() }
    );
    return true;
  } catch {
    return false;
  }
}

// ─── Helpers ──────────────────────────────────────────────────────────────────
function statusIcon(s) {
  return s === 'Pass' ? '✓' : s === 'Fail' ? '✗' : s === 'Blocked' ? '⊘' : '○';
}

function statusColour(s) {
  if (s === 'Pass')         return '\x1b[32m'; // green
  if (s === 'Fail')         return '\x1b[31m'; // red
  if (s === 'Blocked')      return '\x1b[33m'; // yellow
  return '\x1b[90m';                           // grey
}
const RESET = '\x1b[0m';

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log('\n╔══════════════════════════════════════════════════════╗');
  console.log('║   Playwright Run + Zephyr Status Sync                ║');
  console.log('╚══════════════════════════════════════════════════════╝\n');

  if (!ZEPHYR_TOKEN) {
    console.error('  ERROR: ZEPHYR_ACCESS_KEY not set in .env');
    process.exit(1);
  }

  // ── Step 1: Run Playwright ───────────────────────────────────────────────
  console.log('──────────────────────────────────────────────────────');
  console.log('  Step 1 — Run Playwright Tests');
  console.log('──────────────────────────────────────────────────────\n');

  let playwrightExitCode = 0;

  if (process.env.SKIP_PLAYWRIGHT_RUN === 'true') {
    // Caller (e.g. run-story-tests.js) already ran Playwright and wrote test-results.json.
    // Skip the Playwright execution step and proceed directly to parse + sync.
    console.log('  [SKIP_PLAYWRIGHT_RUN=true] Skipping Playwright execution — using existing test-results.json\n');
  } else {
    // Remove stale results file so we always get fresh output
    if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

    console.log('  Running: npx playwright test ...\n');
    // Pass JSON output path via env var — Playwright JSON reporter honours it
    // and playwright.config.js also sets outputFile: 'test-results.json'
    try {
      // shell:true is required on Windows where 'npx' is a .cmd batch file —
      // without it Node can't locate the binary and the process hangs silently.
      execSync('npx playwright test', {
        cwd:   ROOT,
        stdio: 'inherit',
        shell: true,
        env:   {
          ...process.env,
          PLAYWRIGHT_JSON_OUTPUT_NAME: RESULTS_FILE
        }
      });
    } catch (err) {
      // Playwright exits non-zero when any test fails — that's expected
      playwrightExitCode = err.status || 1;
    }
  }

  // ── Step 2: Parse results ────────────────────────────────────────────────
  console.log('\n──────────────────────────────────────────────────────');
  console.log('  Step 2 — Parse Test Results');
  console.log('──────────────────────────────────────────────────────\n');

  if (!fs.existsSync(RESULTS_FILE)) {
    console.error(`  ERROR: ${RESULTS_FILE} was not created. Cannot sync to Zephyr.`);
    process.exit(1);
  }

  const raw     = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  const allTests = collectTests(raw.suites || []);
  const byKey   = rollupByKey(allTests);

  console.log(`  Tests collected: ${allTests.length}`);
  console.log(`  Zephyr keys found: ${byKey.size}\n`);

  // ── Step 3: Fetch Zephyr test cases (only those with Playwright results) ─
  console.log('──────────────────────────────────────────────────────');
  console.log('  Step 3 — Fetch Test Cases from Zephyr');
  console.log('──────────────────────────────────────────────────────\n');

  let allZephyrTCs = [];
  let zephyrFetchFailed = false;
  try {
    allZephyrTCs = await fetchTestCases();
    console.log(`  Total test cases in Zephyr: ${allZephyrTCs.length}`);
  } catch (fetchErr) {
    // Network error (ETIMEDOUT, ECONNRESET, etc.) — degrade gracefully so the
    // pipeline still produces a report; Zephyr sync steps will be skipped.
    zephyrFetchFailed = true;
    const code = fetchErr.code || (fetchErr.cause && fetchErr.cause.code) || 'UNKNOWN';
    console.warn(`  ⚠ Could not reach Zephyr API (${code}) — Zephyr sync will be skipped.`);
    console.warn(`    Check ZEPHYR_BASE_URL / ZEPHYR_ACCESS_KEY in .env, or set ZEPHYR_TIMEOUT_MS to increase the ${ZEPHYR_TIMEOUT_MS}ms timeout.`);
  }

  if (zephyrFetchFailed) {
    // Skip Steps 4-5 (cycle creation + executions); jump straight to summary.
    console.log('\n  Skipping Steps 4-5 (Zephyr sync) due to connectivity failure.\n');
    process.exitCode = 1;
    return;
  }

  // Only sync TCs that have a matching Playwright result — skip stale/old TCs
  const zephyrTCs = allZephyrTCs.filter(tc => byKey.has(tc.key));
  const skipped   = allZephyrTCs.length - zephyrTCs.length;
  console.log(`  Matched to Playwright results: ${zephyrTCs.length}`);
  if (skipped) console.log(`  Skipped (no matching spec): ${skipped}`);
  console.log();

  // ── Step 4: Create test cycle ────────────────────────────────────────────
  console.log('──────────────────────────────────────────────────────');
  console.log('  Step 4 — Create Test Cycle in Zephyr');
  console.log('──────────────────────────────────────────────────────\n');

  // ── Step 3b: Fetch Jira story for traceability ─────────────────────────
  console.log('  Fetching Jira story for traceability...');
  const story = await fetchJiraIssue(ISSUE_KEY);
  if (story) {
    console.log(`  ✓ Story: ${story.key} — ${(story.fields && story.fields.summary) || ''}`);
  } else {
    console.log('  ⚠ Could not fetch Jira story — cycle will have limited traceability');
  }
  console.log();

  const cycleName = `AutoRun-${ISSUE_KEY}-${new Date().toISOString().slice(0, 19).replace('T', '_').replace(/:/g, '-')}`;
  const cycle     = await createCycle(cycleName, story);
  console.log(`  ✓ Cycle created: ${cycle.key}  (${cycleName})`);

  // ── Traceability — link cycle to Jira issue ─────────────────────────────
  if (story && story.id) {
    const linked = await linkCycleToIssue(cycle.key, story.id);
    console.log(linked
      ? `  ✓ Cycle linked to ${ISSUE_KEY} (traceability)`
      : `  ⚠ Failed to link cycle to ${ISSUE_KEY}`);
  }
  console.log();

  // ── Step 5: Create executions + update statuses ──────────────────────────
  console.log('──────────────────────────────────────────────────────');
  console.log('  Step 5 — Create & Update Executions in Zephyr');
  console.log('──────────────────────────────────────────────────────\n');

  const summary = { Pass: 0, Fail: 0, Blocked: 0, 'Not Executed': 0, error: 0 };
  const rows    = [];

  for (const tc of zephyrTCs) {
    const tcKey  = tc.key;
    const result = byKey.get(tcKey);  // always exists — we pre-filtered
    const status = result.status;

    let execId;
    try {
      execId = await createExecution(cycle.key, tcKey);
      // Build rich execution comment for History
      const richComment = [
        `**Status:** ${status}`,
        `**Test Case:** ${tcKey}`,
        `**Cycle:** ${cycle.key}`,
        `**Environment:** ${ENV_NAME}`,
        `**Executed:** ${new Date().toISOString()}`
      ];
      if (result.error) richComment.push(`**Error:** ${result.error}`);

      await updateExecution(execId, status, richComment.join('\n'));
      summary[status] = (summary[status] || 0) + 1;

      // Mark as Automated in Zephyr
      let autoMarked = await markAsAutomated(tcKey);

      // Traceability — link execution to Jira issue
      let execLinked = false;
      if (story && story.id) {
        execLinked = await linkExecutionToIssue(execId, story.id);
      }

      rows.push({ tcKey, name: tc.name, status, synced: true, autoMarked, execLinked });
    } catch (err) {
      summary.error++;
      const msg = (err.response && JSON.stringify(err.response.data)) || err.message;
      rows.push({ tcKey, name: tc.name, status, synced: false, autoMarked: null, err: msg });
    }
  }

  // ── Step 6: Print results table ──────────────────────────────────────────
  console.log('──────────────────────────────────────────────────────');
  console.log('  Results');
  console.log('──────────────────────────────────────────────────────\n');

  for (const r of rows) {
    const col    = statusColour(r.status);
    const icon   = statusIcon(r.status);
    const name   = (r.name || '').slice(0, 50).padEnd(50);
    const synced = r.synced ? '' : ' ⚠ sync failed';
    const auto   = r.autoMarked === true  ? ` \x1b[32m[Automated ✓]\x1b[0m`
                 : r.autoMarked === false ? ` \x1b[33m[mark failed]\x1b[0m`
                 : '';
    const linked = r.execLinked ? ` \x1b[36m[Linked ✓]\x1b[0m` : '';
    console.log(`  ${col}${icon}${RESET} ${r.tcKey.padEnd(10)} ${name} [${col}${r.status}${RESET}]${auto}${linked}${synced}`);
    if (!r.synced && r.err) console.log(`          ${'\x1b[31m'}${r.err}${RESET}`);
  }

  // ── Summary ───────────────────────────────────────────────────────────────
  console.log('\n══════════════════════════════════════════════════════');
  console.log('  Summary');
  console.log('══════════════════════════════════════════════════════\n');
  console.log(`  Cycle     : ${cycle.key}  (${cycleName})`);
  console.log(`  Total TCs : ${zephyrTCs.length}`);
  console.log(`  \x1b[32mPass\x1b[0m      : ${summary.Pass        || 0}`);
  console.log(`  \x1b[31mFail\x1b[0m      : ${summary.Fail        || 0}`);
  console.log(`  \x1b[33mBlocked\x1b[0m   : ${summary.Blocked     || 0}`);
  console.log(`  \x1b[90mNot Exec\x1b[0m  : ${summary['Not Executed'] || 0}`);
  if (summary.error) console.log(`  \x1b[31mSync err\x1b[0m  : ${summary.error}`);
  console.log(`\n  Playwright exit code: ${playwrightExitCode === 0 ? '\x1b[32m0 (all passed)\x1b[0m' : '\x1b[31m' + playwrightExitCode + ' (some failed)\x1b[0m'}`);
  console.log(`  HTML report : playwright-report/index.html`);

  // ── History — mark cycle as Done ─────────────────────────────────────────
  const cycleDone = await updateCycleStatus(cycle.key, 'Done');
  console.log(cycleDone
    ? `  ✓ Cycle ${cycle.key} status → Done`
    : `  ⚠ Failed to update cycle status to Done`);

  console.log('\n══════════════════════════════════════════════════════\n');

  // Exit with playwright's exit code so CI pipelines respect it
  process.exit(playwrightExitCode);
}

main().catch(err => {
  console.error('\n  FATAL:', err.message || err);
  process.exit(1);
});
