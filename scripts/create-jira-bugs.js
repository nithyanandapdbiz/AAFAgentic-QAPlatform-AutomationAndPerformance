'use strict';
/**
 * create-jira-bugs.js — Auto Jira Bug Creator for Failed Tests
 * ─────────────────────────────────────────────────────────────────────────────
 * Reads test-results.json (and optionally test-results-healed.json), identifies
 * all remaining failing tests, and creates a Jira bug issue for each one.
 *
 * Each bug is:
 *   • Created under the configured PROJECT_KEY
 *   • Tagged with labels: auto-bug, playwright, qa-platform
 *   • Linked to the parent user story (ISSUE_KEY) via a "Relates" issue link
 *   • Has a structured ADF description with error details + spec file reference
 *
 * Usage:
 *   node scripts/create-jira-bugs.js
 *
 * Env vars required:
 *   JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN, PROJECT_KEY, ISSUE_KEY
 * Optional:
 *   JIRA_BUG_ISSUETYPE  (default: "Bug")
 */

require('dotenv').config();
const axios    = require('axios');
const FormData = require('form-data');
const fs       = require('fs');
const path     = require('path');

const ROOT               = path.resolve(__dirname, '..');
const RESULTS_FILE       = path.join(ROOT, 'test-results.json');
const HEALED_RESULTS     = path.join(ROOT, 'test-results-healed.json');
const SCREENSHOTS_ROOT   = path.join(ROOT, 'test-results', 'screenshots');

const JIRA_URL    = (process.env.JIRA_URL || '').replace(/\/$/, '');
const JIRA_EMAIL  = process.env.JIRA_EMAIL;
const JIRA_TOKEN  = process.env.JIRA_API_TOKEN;
const PROJECT_KEY = process.env.PROJECT_KEY || 'SCRUM';
const ISSUE_KEY   = process.env.ISSUE_KEY   || 'SCRUM-5';
const BUG_TYPE    = process.env.JIRA_BUG_ISSUETYPE || 'Bug';

// ─── ANSI ─────────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
};

function jiraAuth() {
  return { username: JIRA_EMAIL, password: JIRA_TOKEN };
}

// ─── Collect all failing tests from a Playwright JSON result file ─────────────
function collectFailures(suites, parentFile = '') {
  const failures = [];
  for (const suite of (suites || [])) {
    const file = suite.file || parentFile;

    if (suite.suites && suite.suites.length) {
      failures.push(...collectFailures(suite.suites, file));
    }

    for (const spec of (suite.specs || [])) {
      let failed      = false;
      let errorMsg    = '';
      let errorStack  = '';
      let errorSnippet = '';
      let screenshots = [];
      let videoPath   = null;
      let steps       = [];
      let duration    = 0;

      for (const t of (spec.tests || [])) {
        for (const r of (t.results || [])) {
          if (r.status === 'failed' || r.status === 'timedOut') {
            failed   = true;
            duration = r.duration || 0;

            // Extract full error details — message, stack, snippet
            if (r.error) {
              errorMsg = r.error.message || (typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
              errorStack = r.error.stack || '';
              errorSnippet = r.error.snippet || '';
            }

            // Collect ALL attachments — screenshots + video
            for (const a of (r.attachments || [])) {
              if (a.contentType === 'image/png' && a.path && fs.existsSync(a.path)) {
                screenshots.push(a.path);
              }
              if (a.contentType === 'video/webm' && a.path && fs.existsSync(a.path)) {
                videoPath = a.path;
              }
            }

            // Collect step details with pass/fail status
            steps = (r.steps || []).map(s => ({
              title:    s.title || '(step)',
              duration: s.duration || 0,
              error:    s.error ? (s.error.message || String(s.error)) : null
            }));

            break;
          }
        }
        if (failed) break;
      }

      // Also gather step screenshots from disk (ScreenshotHelper writes these)
      if (failed) {
        const stepScreenshots = loadStepScreenshots(spec.title);
        // Merge: Playwright attachments first, then step screenshots from disk
        const allScreenshots = [...screenshots];
        for (const sp of stepScreenshots) {
          if (!allScreenshots.includes(sp)) allScreenshots.push(sp);
        }

        failures.push({
          title:    spec.title,
          error:    String(errorMsg).slice(0, 2000),
          stack:    String(errorStack).slice(0, 3000),
          snippet:  String(errorSnippet).slice(0, 1000),
          file,
          screenshots: allScreenshots,
          videoPath,
          steps,
          duration
        });
      }
    }
  }
  return failures;
}

// ─── Load step screenshots from ScreenshotHelper output directory ────────────
function loadStepScreenshots(title) {
  const slug = (title || 'test')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const dir = path.join(SCREENSHOTS_ROOT, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => path.join(dir, f));
}

// ─── Build an ADF (Atlassian Document Format) description ────────────────────
function buildDescription(failure) {
  const content = [
    {
      type:    'paragraph',
      content: [{ type: 'text', text: 'Auto-created by Agentic QA Platform', marks: [{ type: 'strong' }] }]
    },
    { type: 'rule' },
    // ── Environment ─────────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: 'Environment' }]
    },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field' }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value' }] }] },
        ]},
        tableRow('Parent Story', ISSUE_KEY),
        tableRow('Project', PROJECT_KEY),
        tableRow('AUT URL', 'https://opensource-demo.orangehrmlive.com'),
        tableRow('Spec File', path.basename(failure.file || 'unknown')),
        tableRow('Duration', failure.duration ? `${(failure.duration / 1000).toFixed(1)}s` : 'N/A'),
        tableRow('Date', new Date().toISOString()),
      ]
    },
    // ── Failed Test ─────────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: 'Failed Test' }]
    },
    {
      type:    'paragraph',
      content: [{ type: 'text', text: failure.title, marks: [{ type: 'strong' }] }]
    },
    // ── Error Message ───────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: 'Error Message' }]
    },
    {
      type:    'codeBlock',
      attrs:   { language: 'text' },
      content: [{ type: 'text', text: failure.error || 'No error message captured' }]
    },
  ];

  // ── Code Snippet (if available) ──────────────────────────────────────
  if (failure.snippet) {
    content.push(
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: 'Code Snippet (at failure point)' }]
      },
      {
        type:    'codeBlock',
        attrs:   { language: 'javascript' },
        content: [{ type: 'text', text: failure.snippet }]
      }
    );
  }

  // ── Stack Trace (if available) ───────────────────────────────────────
  if (failure.stack) {
    content.push(
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: 'Stack Trace' }]
      },
      {
        type:    'codeBlock',
        attrs:   { language: 'text' },
        content: [{ type: 'text', text: failure.stack }]
      }
    );
  }

  // ── Test Steps ───────────────────────────────────────────────────────
  if (failure.steps && failure.steps.length > 0) {
    content.push({
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: `Test Steps (${failure.steps.length})` }]
    });

    const stepRows = [
      { type: 'tableRow', content: [
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '#' }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step' }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Duration' }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Status' }] }] },
      ]}
    ];

    failure.steps.forEach((s, i) => {
      const dur = s.duration >= 1000 ? `${(s.duration / 1000).toFixed(1)}s` : `${s.duration}ms`;
      const status = s.error ? '❌ FAILED' : '✅ Pass';
      stepRows.push({ type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: String(i + 1) }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: s.title }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: dur }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: status }] }] },
      ]});
      // Add error detail row for failed step
      if (s.error) {
        stepRows.push({ type: 'tableRow', content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
          { type: 'tableCell', attrs: { colspan: 3 }, content: [
            { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: String(s.error).slice(0, 500) }] }
          ]},
        ]});
      }
    });

    content.push({
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'wide' },
      content: stepRows
    });
  }

  // ── Attachments note ─────────────────────────────────────────────────
  const mediaNotes = [];
  if (failure.screenshots.length > 0) mediaNotes.push(`${failure.screenshots.length} screenshot(s)`);
  if (failure.videoPath) mediaNotes.push('1 video recording');
  if (mediaNotes.length > 0) {
    content.push(
      { type: 'rule' },
      {
        type:    'paragraph',
        content: [{ type: 'text', text: `📎 Attachments: ${mediaNotes.join(', ')} attached to this issue.`, marks: [{ type: 'em' }] }]
      }
    );
  }

  return { type: 'doc', version: 1, content };
}

// ─── Helper: ADF table row (2 cells) ────────────────────────────────────────
function tableRow(field, value) {
  return { type: 'tableRow', content: [
    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: field, marks: [{ type: 'strong' }] }] }] },
    { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: value || 'N/A' }] }] },
  ]};
}

// ─── Attach a file (screenshot or video) to a Jira issue ─────────────────────
async function attachFile(issueKey, filePath, contentType = null) {
  const ext = path.extname(filePath).toLowerCase();
  const mimeMap = { '.png': 'image/png', '.jpg': 'image/jpeg', '.webm': 'video/webm', '.mp4': 'video/mp4' };
  const mime = contentType || mimeMap[ext] || 'application/octet-stream';

  const form = new FormData();
  form.append('file', fs.createReadStream(filePath), {
    filename: path.basename(filePath),
    contentType: mime
  });
  await axios.post(
    `${JIRA_URL}/rest/api/3/issue/${issueKey}/attachments`,
    form,
    {
      auth: jiraAuth(),
      headers: {
        ...form.getHeaders(),
        'X-Atlassian-Token': 'no-check'
      }
    }
  );
}

// ─── Create a single Jira bug issue ──────────────────────────────────────────
async function createBug(failure) {
  const response = await axios.post(
    `${JIRA_URL}/rest/api/3/issue`,
    {
      fields: {
        project:     { key: PROJECT_KEY },
        summary:     `[Auto Bug] ${failure.title}`,
        description: buildDescription(failure),
        issuetype:   { name: BUG_TYPE },
        labels:      ['auto-bug', 'playwright', 'qa-platform']
      }
    },
    { auth: jiraAuth() }
  );
  return response.data;
}

// ─── Link bug issue to parent user story ─────────────────────────────────────
async function linkToParent(bugKey) {
  try {
    await axios.post(
      `${JIRA_URL}/rest/api/3/issueLink`,
      {
        type:         { name: 'Relates' },
        inwardIssue:  { key: bugKey },
        outwardIssue: { key: ISSUE_KEY }
      },
      { auth: jiraAuth() }
    );
  } catch (err) {
    const msg = err.response ? `HTTP ${err.response.status}` : err.message;
    console.log(`    ${C.dim}  Link to ${ISSUE_KEY} failed: ${msg} (bug still created)${C.reset}`);
  }
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║        Auto Jira Bug Creator                          ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  // ── Guard: credentials ──────────────────────────────────────────────────────
  if (!JIRA_URL || !JIRA_EMAIL || !JIRA_TOKEN) {
    console.log(`  ${C.yellow}⚠  Jira credentials not configured.${C.reset}`);
    console.log(`  ${C.dim}  Set JIRA_URL, JIRA_EMAIL, JIRA_API_TOKEN in .env to enable bug creation.${C.reset}\n`);
    return;
  }

  // ── Load results ────────────────────────────────────────────────────────────
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log(`  ${C.yellow}⚠  test-results.json not found. Run tests first.${C.reset}\n`);
    return;
  }

  const raw      = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  let   failures = collectFailures(raw.suites || []);

  // If healed results exist, remove tests that passed after healing
  if (fs.existsSync(HEALED_RESULTS)) {
    try {
      const healedRaw   = JSON.parse(fs.readFileSync(HEALED_RESULTS, 'utf8'));
      const healedPassed = new Set();
      const gatherPassed = (suites) => {
        for (const s of (suites || [])) {
          gatherPassed(s.suites || []);
          for (const sp of (s.specs || [])) {
            if (sp.ok) healedPassed.add(sp.title);
          }
        }
      };
      gatherPassed(healedRaw.suites || []);
      const before = failures.length;
      failures = failures.filter(f => !healedPassed.has(f.title));
      if (before !== failures.length) {
        console.log(`  ${C.dim}  ${before - failures.length} test(s) excluded — already fixed by Healer.${C.reset}\n`);
      }
    } catch {
      // ignore parse errors on healed results
    }
  }

  if (failures.length === 0) {
    console.log(`  ${C.green}✓  No failing tests remain. No bugs to create.${C.reset}\n`);
    return;
  }

  console.log(`  ${C.yellow}Found ${failures.length} failing test(s). Creating Jira bugs linked to ${ISSUE_KEY}...\n${C.reset}`);

  const created = [];
  const errored = [];

  for (const failure of failures) {
    const label = failure.title.slice(0, 55);
    process.stdout.write(`  Creating: "${label}" ... `);

    try {
      const bug = await createBug(failure);
      await linkToParent(bug.key);

      // Attach screenshots to the bug
      let attachCount = 0;
      for (const screenshotPath of (failure.screenshots || [])) {
        try {
          await attachFile(bug.key, screenshotPath);
          attachCount++;
        } catch (attachErr) {
          const msg = attachErr.response
            ? `HTTP ${attachErr.response.status}`
            : attachErr.message;
          console.log(`\n    ${C.yellow}⚠  Screenshot attach failed: ${msg}${C.reset}`);
        }
      }

      // Attach video recording if available
      if (failure.videoPath) {
        try {
          await attachFile(bug.key, failure.videoPath);
          attachCount++;
        } catch (attachErr) {
          const msg = attachErr.response
            ? `HTTP ${attachErr.response.status}`
            : attachErr.message;
          console.log(`\n    ${C.yellow}⚠  Video attach failed: ${msg}${C.reset}`);
        }
      }

      const attachNote = attachCount > 0
        ? ` ${C.dim}[${attachCount} file(s) attached]${C.reset}`
        : '';
      console.log(`${C.green}✓ ${bug.key}${C.reset}${attachNote}`);
      created.push({ key: bug.key, title: failure.title, attachments: attachCount });
    } catch (err) {
      const msg = err.response
        ? `HTTP ${err.response.status} — ${JSON.stringify(err.response.data).slice(0, 100)}`
        : err.message;
      console.log(`${C.red}✗ FAILED${C.reset} — ${msg}`);
      errored.push({ title: failure.title, error: msg });
    }
  }

  // ── Summary ─────────────────────────────────────────────────────────────────
  console.log(`\n${C.bold}  Bug Creation Summary:${C.reset}`);
  console.log(`    ${C.green}Created : ${created.length}${C.reset}  ${C.red}Failed  : ${errored.length}${C.reset}\n`);

  if (created.length > 0) {
    console.log(`  ${C.bold}Created Bugs (linked to ${ISSUE_KEY}):${C.reset}`);
    for (const b of created) {
      const sc = b.attachments > 0 ? `  ${C.dim}[${b.attachments} attachment(s)]${C.reset}` : '';
      console.log(`    ${C.green}✓${C.reset} ${C.bold}${b.key}${C.reset}  ${b.title.slice(0, 60)}${sc}`);
    }
    console.log('');
  }
}

main().catch(err => {
  console.error(`\n${C.red}  BUG CREATOR ERROR: ${err.message}${C.reset}\n`);
  process.exit(1);
});
