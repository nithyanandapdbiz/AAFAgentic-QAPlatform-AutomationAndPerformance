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
      // ── Scan ALL results (including retries) ──────────────────────────────
      // Collect error details from the LAST failed result (most recent attempt).
      // Collect screenshots/videos/traces from ALL failed results (deduplicated).
      let failed       = false;
      let errorMsg     = '';
      let errorStack   = '';
      let errorSnippet = '';
      let steps        = [];
      let duration     = 0;
      // Keyed by resolved absolute path to avoid duplicates across retries
      const screenshotPaths = new Map(); // path → { label, path }
      let videoPath  = null;
      let tracePath  = null;

      for (const t of (spec.tests || [])) {
        for (const r of (t.results || [])) {
          if (r.status !== 'failed' && r.status !== 'timedOut') continue;

          failed   = true;
          duration = r.duration || 0;   // last failure wins

          // Error details — keep from last failure
          if (r.error) {
            errorMsg     = r.error.message || (typeof r.error === 'string' ? r.error : JSON.stringify(r.error));
            errorStack   = r.error.stack   || '';
            errorSnippet = r.error.snippet || '';
          }

          // Steps — keep from last failure
          steps = (r.steps || []).map(s => ({
            title:    s.title || '(step)',
            duration: s.duration || 0,
            error:    s.error ? (s.error.message || String(s.error)) : null
          }));

          // Attachments — collect from ALL retries, deduplicate by resolved path
          for (const a of (r.attachments || [])) {
            // Skip body-only attachments (no path on disk)
            if (!a.path) continue;
            const abs = path.resolve(ROOT, a.path);
            if (!fs.existsSync(abs)) continue;

            if (a.contentType === 'image/png') {
              if (!screenshotPaths.has(abs)) {
                // Use the attachment name as a human label (e.g. "01. Log in as HR Admin")
                screenshotPaths.set(abs, { label: a.name || path.basename(abs), absPath: abs });
              }
            }
            if (a.contentType === 'video/webm') {
              videoPath = abs;   // last retry's video wins
            }
            if (a.contentType === 'application/zip' && a.name === 'trace') {
              tracePath = abs;   // last retry's trace wins
            }
          }
        }
      }

      if (!failed) continue;

      // ── Step screenshots from disk (ScreenshotHelper) ─────────────────────
      // These are written to test-results/screenshots/<slug>/ but NOT attached
      // with a path in the JSON (stored as inline body buffers). Load from disk.
      const diskStepShots = loadStepScreenshots(spec.title);
      for (const diskPath of diskStepShots) {
        const abs = path.resolve(diskPath);
        if (!screenshotPaths.has(abs)) {
          const label = path.basename(abs, '.png').replace(/^step-\d+-/, '').replace(/-/g, ' ');
          screenshotPaths.set(abs, { label, absPath: abs });
        }
      }

      failures.push({
        title:       spec.title,
        error:       String(errorMsg).slice(0, 2000),
        stack:       String(errorStack).slice(0, 3000),
        snippet:     String(errorSnippet).slice(0, 1000),
        file,
        // Array of { label, absPath } — ordered: step shots first, then failure shots
        screenshots: [...screenshotPaths.values()],
        videoPath,
        tracePath,
        steps,
        duration
      });
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
  // ── Derive OS name ─────────────────────────────────────────────────────────
  const osMap = { win32: 'Windows', darwin: 'macOS', linux: 'Linux' };
  const osName = osMap[process.platform] || process.platform;

  // ── Reproduce steps (numbered list) ───────────────────────────────────────
  const stepListItems = (failure.steps || []).map((s, i) => ({
    type: 'listItem',
    content: [{
      type: 'paragraph',
      content: [
        { type: 'text', text: `${s.title}`, marks: s.error ? [{ type: 'strong' }] : [] },
        ...(s.error
          ? [{ type: 'text', text: `  ← FAILED: ${String(s.error).slice(0, 200)}`, marks: [{ type: 'code' }] }]
          : [])
      ]
    }]
  }));

  // ── Screenshot inventory (one bullet per file, with label) ────────────────
  const shotListItems = (failure.screenshots || []).map(s => ({
    type: 'listItem',
    content: [{ type: 'paragraph', content: [{ type: 'text', text: `${s.label} — ${path.basename(s.absPath)}` }] }]
  }));

  // ── Media note (footer) ───────────────────────────────────────────────────
  const mediaNotes = [];
  if (failure.screenshots.length > 0) mediaNotes.push(`${failure.screenshots.length} screenshot(s)`);
  if (failure.videoPath)  mediaNotes.push('1 video recording (video.webm)');
  if (failure.tracePath)  mediaNotes.push('1 Playwright trace archive (trace.zip — open with https://trace.playwright.dev)');

  const content = [
    {
      type:    'paragraph',
      content: [{ type: 'text', text: '🤖 Auto-created by Agentic QA Platform', marks: [{ type: 'strong' }] }]
    },
    { type: 'rule' },

    // ── 1. Environment ───────────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: '1. Environment' }]
    },
    {
      type: 'table',
      attrs: { isNumberColumnEnabled: false, layout: 'default' },
      content: [
        { type: 'tableRow', content: [
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Field', marks: [{ type: 'strong' }] }] }] },
          { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Value', marks: [{ type: 'strong' }] }] }] },
        ]},
        tableRow('Parent Story',  ISSUE_KEY),
        tableRow('Project',       PROJECT_KEY),
        tableRow('Application',   'OrangeHRM — https://opensource-demo.orangehrmlive.com'),
        tableRow('Test Runner',   'Playwright (Chromium)'),
        tableRow('OS',            osName),
        tableRow('Spec File',     path.basename(failure.file || 'unknown')),
        tableRow('Duration',      failure.duration ? `${(failure.duration / 1000).toFixed(1)}s` : 'N/A'),
        tableRow('Reported At',   new Date().toISOString()),
      ]
    },

    // ── 2. Failed Test ───────────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: '2. Failed Test' }]
    },
    {
      type:    'paragraph',
      content: [{ type: 'text', text: failure.title, marks: [{ type: 'strong' }] }]
    },

    // ── 3. Steps to Reproduce ────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: '3. Steps to Reproduce' }]
    },
  ];

  if (stepListItems.length > 0) {
    content.push({ type: 'orderedList', content: stepListItems });
  } else {
    content.push({ type: 'paragraph', content: [{ type: 'text', text: '(Steps not captured — see spec file)', marks: [{ type: 'em' }] }] });
  }

  content.push(
    // ── 4. Expected Result ───────────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: '4. Expected Result' }]
    },
    {
      type:    'paragraph',
      content: [{ type: 'text', text: 'All test steps should complete successfully with no errors.' }]
    },

    // ── 5. Actual Result (Error) ─────────────────────────────────────────────
    {
      type:    'heading',
      attrs:   { level: 3 },
      content: [{ type: 'text', text: '5. Actual Result' }]
    },
    {
      type:    'codeBlock',
      attrs:   { language: 'text' },
      content: [{ type: 'text', text: failure.error || 'No error message captured' }]
    },
  );

  // ── 6. Code Snippet ──────────────────────────────────────────────────────
  if (failure.snippet) {
    content.push(
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: '6. Code Snippet (at failure point)' }]
      },
      {
        type:    'codeBlock',
        attrs:   { language: 'javascript' },
        content: [{ type: 'text', text: failure.snippet }]
      }
    );
  }

  // ── 7. Stack Trace ───────────────────────────────────────────────────────
  if (failure.stack) {
    content.push(
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: '7. Stack Trace' }]
      },
      {
        type:    'codeBlock',
        attrs:   { language: 'text' },
        content: [{ type: 'text', text: failure.stack }]
      }
    );
  }

  // ── 8. Test Steps Table ──────────────────────────────────────────────────
  if (failure.steps && failure.steps.length > 0) {
    const stepRows = [
      { type: 'tableRow', content: [
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: '#', marks: [{ type: 'strong' }] }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Step', marks: [{ type: 'strong' }] }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Duration', marks: [{ type: 'strong' }] }] }] },
        { type: 'tableHeader', content: [{ type: 'paragraph', content: [{ type: 'text', text: 'Result', marks: [{ type: 'strong' }] }] }] },
      ]}
    ];

    failure.steps.forEach((s, i) => {
      const dur    = s.duration >= 1000 ? `${(s.duration / 1000).toFixed(1)}s` : `${s.duration}ms`;
      const status = s.error ? '❌ FAILED' : '✅ Pass';
      stepRows.push({ type: 'tableRow', content: [
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: String(i + 1) }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: s.title, marks: s.error ? [{ type: 'strong' }] : [] }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: dur }] }] },
        { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: status }] }] },
      ]});
      if (s.error) {
        stepRows.push({ type: 'tableRow', content: [
          { type: 'tableCell', content: [{ type: 'paragraph', content: [{ type: 'text', text: '' }] }] },
          { type: 'tableCell', attrs: { colspan: 3 }, content: [
            { type: 'codeBlock', attrs: { language: 'text' }, content: [{ type: 'text', text: String(s.error).slice(0, 500) }] }
          ]},
        ]});
      }
    });

    content.push(
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: '8. Step Execution Detail' }]
      },
      {
        type: 'table',
        attrs: { isNumberColumnEnabled: false, layout: 'wide' },
        content: stepRows
      }
    );
  }

  // ── 9. Attachments ───────────────────────────────────────────────────────
  if (mediaNotes.length > 0) {
    content.push(
      { type: 'rule' },
      {
        type:    'heading',
        attrs:   { level: 3 },
        content: [{ type: 'text', text: '9. Attachments' }]
      },
      {
        type:    'paragraph',
        content: [{ type: 'text', text: `The following ${mediaNotes.length > 1 ? 'files are' : 'file is'} attached to this issue:` }]
      },
      {
        type:    'bulletList',
        content: mediaNotes.map(n => ({
          type: 'listItem',
          content: [{ type: 'paragraph', content: [{ type: 'text', text: `📎 ${n}` }] }]
        }))
      }
    );

    if (shotListItems.length > 0) {
      content.push(
        {
          type:    'paragraph',
          content: [{ type: 'text', text: 'Screenshot inventory:', marks: [{ type: 'strong' }] }]
        },
        { type: 'bulletList', content: shotListItems }
      );
    }

    if (failure.tracePath) {
      content.push({
        type:    'paragraph',
        content: [
          { type: 'text', text: '💡 Tip: ', marks: [{ type: 'strong' }] },
          { type: 'text', text: 'Open trace.zip at ' },
          { type: 'text', text: 'https://trace.playwright.dev', marks: [{ type: 'link', attrs: { href: 'https://trace.playwright.dev' } }] },
          { type: 'text', text: ' for a full step-by-step DOM + network replay.' }
        ]
      });
    }
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
  const abs = path.resolve(filePath);
  if (!fs.existsSync(abs)) return;   // silently skip missing files
  const ext = path.extname(abs).toLowerCase();
  const mimeMap = {
    '.png': 'image/png',
    '.jpg': 'image/jpeg',
    '.webm': 'video/webm',
    '.mp4': 'video/mp4',
    '.zip': 'application/zip'
  };
  const mime = contentType || mimeMap[ext] || 'application/octet-stream';

  const form = new FormData();
  form.append('file', fs.createReadStream(abs), {
    filename: path.basename(abs),
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
        priority:    { name: 'High' },
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
      for (const shot of (failure.screenshots || [])) {
        try {
          await attachFile(bug.key, shot.absPath);
          attachCount++;
        } catch (attachErr) {
          const msg = attachErr.response ? `HTTP ${attachErr.response.status}` : attachErr.message;
          console.log(`\n    ${C.yellow}⚠  Screenshot attach failed (${path.basename(shot.absPath)}): ${msg}${C.reset}`);
        }
      }

      // Attach video recording if available
      if (failure.videoPath) {
        try {
          await attachFile(bug.key, failure.videoPath);
          attachCount++;
        } catch (attachErr) {
          const msg = attachErr.response ? `HTTP ${attachErr.response.status}` : attachErr.message;
          console.log(`\n    ${C.yellow}⚠  Video attach failed: ${msg}${C.reset}`);
        }
      }

      // Attach Playwright trace archive (enables step-by-step DOM/network replay)
      if (failure.tracePath) {
        try {
          await attachFile(bug.key, failure.tracePath);
          attachCount++;
        } catch (attachErr) {
          const msg = attachErr.response ? `HTTP ${attachErr.response.status}` : attachErr.message;
          console.log(`\n    ${C.yellow}⚠  Trace attach failed: ${msg}${C.reset}`);
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
