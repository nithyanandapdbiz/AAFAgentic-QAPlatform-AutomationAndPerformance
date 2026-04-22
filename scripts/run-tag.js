'use strict';
/**
 * run-tag.js  —  Tag / Annotation-Based Test Execution
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs only the Playwright specs that match a given tag, annotation, or regex.
 * Ideal for targeted regression, smoke runs, and technique-specific validation
 * without executing the full suite.
 *
 *  Built-in tag aliases:
 *   ┌───────────────┬──────────────────────────────────────────────────────┐
 *   │ smoke         │ happy-path / successful tests                        │
 *   │ regression    │ full regression suite (all specs)                    │
 *   │ bva           │ boundary value analysis tests                        │
 *   │ ep            │ equivalence partitioning tests                       │
 *   │ negative      │ invalid input / mandatory-field tests                │
 *   │ boundary      │ boundary / edge-case tests                           │
 *   │ security      │ RBAC / role-based access control tests               │
 *   │ rbac          │ role-based access control tests                      │
 *   │ unicode       │ special-character / unicode tests                    │
 *   │ ui            │ UI feedback / visual validation tests                │
 *   │ cancel        │ cancel / discard action tests                        │
 *   │ persistence   │ data persistence tests                               │
 *   │ duplicate     │ duplicate-entry / dedup tests                        │
 *   │ max           │ maximum record count tests                           │
 *   │ <TC-key>      │ exact Zephyr key, e.g. SCRUM-T36                    │
 *   │ <any regex>   │ passed directly as Playwright --grep pattern        │
 *   └───────────────┴──────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-tag.js --tag smoke
 *   node scripts/run-tag.js --tag bva
 *   node scripts/run-tag.js --tag negative
 *   node scripts/run-tag.js --tag rbac
 *   node scripts/run-tag.js --tag SCRUM-T36
 *   node scripts/run-tag.js --tag "boundary|duplicate"
 *   node scripts/run-tag.js --tag regression --skip-heal
 *   node scripts/run-tag.js --tag smoke --headless
 *   node scripts/run-tag.js --tag smoke --list-only    ← print matches, no execution
 *
 * ─── Options ─────────────────────────────────────────────────────────────────
 *   --tag <value>    Tag / alias / TC-key / regex  [REQUIRED]
 *   --headless       Run browser in headless CI mode
 *   --skip-heal      Skip the self-healing stage
 *   --skip-bugs      Skip Jira bug creation
 *   --skip-report    Skip HTML + Allure report generation
 *   --skip-git       Skip git auto-commit + push
 *   --list-only      Print matching specs and exit without running tests
 *
 * All configuration is read from .env  (ISSUE_KEY, PROJECT_KEY, JIRA_*, ZEPHYR_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'tests', 'specs');

const args  = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

// ─── Parse --tag ──────────────────────────────────────────────────────────────
const tagIdx = args.findIndex(a => a.toLowerCase() === '--tag');
const rawTag = tagIdx !== -1 ? args[tagIdx + 1] : null;

const useHeadless = flags.has('--headless') || process.env.PW_HEADLESS === 'true';
const skipHeal    = flags.has('--skip-heal');
const skipBugs    = flags.has('--skip-bugs');
const skipReport  = flags.has('--skip-report');
const skipGit     = flags.has('--skip-git');
const listOnly    = flags.has('--list-only');

// ─── Tag → grep pattern ───────────────────────────────────────────────────────
const TAG_MAP = {
  smoke:       'successful|happy.path|valid input',
  regression:  '.*',
  bva:         'boundary|boundary value',
  ep:          'valid input|mandatory|rejects invalid',
  negative:    'rejects invalid|mandatory|required',
  boundary:    'boundary|edge.case',
  security:    'role.based|access control|rbac',
  rbac:        'role.based|access control|rbac',
  unicode:     'special character|unicode',
  ui:          'ui feedback|feedback message',
  cancel:      'cancel|discard',
  persistence: 'persist|persisted',
  duplicate:   'duplicate',
  max:         'maximum|max number',
};

// ─── File-name patterns for fast pre-filtering ────────────────────────────────
const FILE_PATTERNS = {
  smoke:       /verify_successful/i,
  bva:         /verify_boundary/i,
  negative:    /rejects_invalid|mandatory_fields/i,
  boundary:    /verify_boundary/i,
  security:    /role_based|access_control/i,
  rbac:        /role_based|access_control/i,
  unicode:     /special_character|unicode/i,
  ui:          /ui_feedback/i,
  cancel:      /cancel_or_discard/i,
  persistence: /data_is_persisted/i,
  duplicate:   /duplicate/i,
  max:         /maximum_number/i,
  regression:  /.spec\.js$/i,
};

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:   '\x1b[1m', dim:    '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red:  '\x1b[31m',
  cyan:   '\x1b[36m', orange: '\x1b[33m', white: '\x1b[97m',
};
const R = C.reset;

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner(tag, grepPattern, specFiles) {
  const W = 64;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.orange}║  ${R}${pad(s)}${C.bold}${C.orange}║${R}`;
  console.log(`\n${C.bold}${C.orange}╔${B}╗${R}`);
  console.log(row('Agentic QA Platform  —  Tag-Based Execution'));
  console.log(row(''));
  console.log(row(`  Tag      : ${tag}`));
  console.log(row(`  Pattern  : ${grepPattern.slice(0, 58)}`));
  console.log(row(`  Matching : ${specFiles.length} spec file(s)`));
  console.log(row(`  Mode     : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`));
  console.log(row(`  Time     : ${now()}`));
  if (listOnly) console.log(row('  *** LIST-ONLY mode — tests will NOT be executed ***'));
  console.log(`${C.bold}${C.orange}╚${B}╝${R}\n`);
}

function stageHeader(num, total, label, skipped = false) {
  const tag = skipped ? `${C.yellow}SKIP${R}` : `${C.cyan}RUN${R}`;
  console.log(`\n${C.bold}${C.white}┌─ [${num}/${total}] ${label}${R}  ${tag}`);
  console.log(`${C.dim}│  ${now()}${R}`);
  console.log(`${C.bold}${C.white}└${'─'.repeat(62)}${R}\n`);
}

function stageDone(num, label, ok, ms) {
  const icon = ok ? `${C.green}✓${R}` : `${C.red}✗${R}`;
  const col  = ok ? C.green : C.red;
  console.log(`\n${icon} ${C.bold}${col}[${num}] ${label}${R}  (${(ms / 1000).toFixed(1)}s)\n`);
}

function runScript(relPath, extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${R}`);
    return { ok: false, exitCode: 1 };
  }
  const r = spawnSync('node', [abs], {
    cwd:   ROOT,
    stdio: 'inherit',
    env:   { ...process.env, ...extraEnv },
  });
  const exitCode = r.status ?? (r.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode };
}

// ─── Resolve tag → { grepPattern, specFiles } ─────────────────────────────────
function resolveTag(tag) {
  if (!tag) return null;
  const lower = tag.toLowerCase();

  // Exact Zephyr TC key: SCRUM-T36
  if (/^[a-z]+-t\d+$/i.test(tag)) {
    const specFile = fs.readdirSync(SPECS_DIR)
      .find(f => f.toLowerCase().startsWith(tag.toLowerCase() + '_') && f.endsWith('.spec.js'));
    const specFiles = specFile ? [path.join(SPECS_DIR, specFile)] : [];
    return { grepPattern: tag, specFiles };
  }

  const grepPattern = TAG_MAP[lower] || tag;
  const filePattern = FILE_PATTERNS[lower];

  const specFiles = fs.existsSync(SPECS_DIR)
    ? fs.readdirSync(SPECS_DIR)
        .filter(f => f.endsWith('.spec.js') && (filePattern ? filePattern.test(f) : true))
        .map(f => path.join(SPECS_DIR, f))
    : [];

  return { grepPattern, specFiles };
}

// ─── Run Playwright with grep ─────────────────────────────────────────────────
function runPlaywright(specFiles, grepPattern) {
  const RESULTS_FILE = path.join(ROOT, 'test-results.json');
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  const relSpecs = specFiles
    .map(f => path.relative(ROOT, f).replace(/\\/g, '/'));

  const NPX    = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const pwArgs = ['playwright', 'test', ...relSpecs];
  const extraEnv = {
    ...process.env,
    PW_HEADLESS: useHeadless ? 'true' : 'false',
    PLAYWRIGHT_JSON_OUTPUT_NAME: RESULTS_FILE,
  };
  if (grepPattern && grepPattern !== '.*') extraEnv.PW_GREP = grepPattern;

  console.log(`  ${C.dim}Running: npx playwright test ${relSpecs.join(' ')}${R}\n`);
  const r = spawnSync(NPX, pwArgs, { cwd: ROOT, stdio: 'inherit', shell: true, env: extraEnv });
  return r.status ?? (r.error ? 1 : 0);
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  if (!rawTag) {
    console.error(`${C.red}
  Error: --tag is required.

  Examples:
    node scripts/run-tag.js --tag smoke
    node scripts/run-tag.js --tag bva
    node scripts/run-tag.js --tag SCRUM-T36
    node scripts/run-tag.js --tag "boundary|duplicate"

  Available tag aliases:
    smoke, regression, bva, ep, negative, boundary,
    security, rbac, unicode, ui, cancel, persistence,
    duplicate, max, <SCRUM-Txx key>, <any regex>
${R}`);
    process.exit(1);
  }

  const resolved = resolveTag(rawTag);
  const { grepPattern, specFiles } = resolved;

  banner(rawTag, grepPattern, specFiles);

  if (specFiles.length === 0) {
    console.log(`${C.yellow}  No spec files matched tag "${rawTag}".${R}\n`);
    process.exit(0);
  }

  console.log(`  ${C.bold}Matching spec files:${R}`);
  specFiles.forEach(f => console.log(`    ${C.dim}→ ${path.basename(f)}${R}`));
  console.log();

  if (listOnly) {
    console.log(`${C.green}  ${specFiles.length} spec(s) matched. Pass without --list-only to run.${R}\n`);
    process.exit(0);
  }

  const TOTAL   = 6;
  const summary = [];
  const t0      = Date.now();

  // ── Stage 1: Execute filtered specs ──────────────────────────────────────────
  stageHeader(1, TOTAL, `Run [tag: ${rawTag}]  ${specFiles.length} spec(s)  [${useHeadless ? 'HEADLESS' : 'HEADED'}]`);
  const ts1   = Date.now();
  const pwExit = runPlaywright(specFiles, grepPattern);
  const ms1   = Date.now() - ts1;
  stageDone(1, `Execute [tag: ${rawTag}]`, pwExit === 0, ms1);
  summary.push({ num: 1, label: `Execute [tag: ${rawTag}]`, status: pwExit === 0 ? 'PASS' : 'WARN', ms: ms1 });

  // ── Stage 2: Self-healing ─────────────────────────────────────────────────────
  stageHeader(2, TOTAL, 'Self-Healing Agent → repair + re-run failures', skipHeal);
  if (skipHeal) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-heal${R}\n`);
    summary.push({ num: 2, label: 'Self-Healing', status: 'SKIP', ms: 0 });
  } else {
    const ts2 = Date.now();
    const { ok } = runScript('scripts/healer.js', { PW_HEADLESS: useHeadless ? 'true' : 'false' });
    const ms2 = Date.now() - ts2;
    stageDone(2, 'Self-Healing', ok || true, ms2);
    summary.push({ num: 2, label: 'Self-Healing', status: ok ? 'PASS' : 'WARN', ms: ms2 });
  }

  // ── Stage 3: Jira bugs ────────────────────────────────────────────────────────
  stageHeader(3, TOTAL, 'Auto-create Jira bugs for remaining failures', skipBugs);
  if (skipBugs) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-bugs${R}\n`);
    summary.push({ num: 3, label: 'Jira bug creation', status: 'SKIP', ms: 0 });
  } else {
    const ts3 = Date.now();
    const { ok } = runScript('scripts/create-jira-bugs.js');
    const ms3 = Date.now() - ts3;
    stageDone(3, 'Jira bug creation', ok || true, ms3);
    summary.push({ num: 3, label: 'Jira bug creation', status: ok ? 'PASS' : 'WARN', ms: ms3 });
  }

  // ── Stage 4: HTML report ──────────────────────────────────────────────────────
  stageHeader(4, TOTAL, 'Generate HTML report', skipReport);
  if (skipReport) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-report${R}\n`);
    summary.push({ num: 4, label: 'HTML report', status: 'SKIP', ms: 0 });
  } else {
    const ts4 = Date.now();
    const { ok } = runScript('scripts/generate-report.js');
    const ms4 = Date.now() - ts4;
    stageDone(4, 'HTML report', ok, ms4);
    summary.push({ num: 4, label: 'HTML report', status: ok ? 'PASS' : 'FAIL', ms: ms4 });
  }

  // ── Stage 5: Allure report ────────────────────────────────────────────────────
  stageHeader(5, TOTAL, 'Generate Allure report', skipReport);
  if (skipReport) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-report${R}\n`);
    summary.push({ num: 5, label: 'Allure report', status: 'SKIP', ms: 0 });
  } else {
    const ts5 = Date.now();
    const { ok } = runScript('scripts/generate-allure-report.js');
    const ms5 = Date.now() - ts5;
    stageDone(5, 'Allure report', ok || true, ms5);
    summary.push({ num: 5, label: 'Allure report', status: ok ? 'PASS' : 'WARN', ms: ms5 });
  }

  // ── Stage 6: Git sync ─────────────────────────────────────────────────────────
  stageHeader(6, TOTAL, 'Git Agent — auto-commit + push', skipGit);
  if (skipGit) {
    console.log(`  ${C.yellow}↷  Skipped — --skip-git${R}\n`);
    summary.push({ num: 6, label: 'Git sync', status: 'SKIP', ms: 0 });
  } else {
    const ts6 = Date.now();
    const { ok } = runScript('scripts/git-sync.js');
    const ms6 = Date.now() - ts6;
    stageDone(6, 'Git sync', ok || true, ms6);
    summary.push({ num: 6, label: 'Git sync', status: ok ? 'PASS' : 'WARN', ms: ms6 });
  }

  // ─── Summary ──────────────────────────────────────────────────────────────────
  const total = (Date.now() - t0) / 1000;
  console.log(`\n${C.bold}${C.white}${'─'.repeat(64)}${R}`);
  console.log(`${C.bold}  Tag-Based Run Summary  [tag: ${rawTag}]  ${C.dim}(${total.toFixed(1)}s)${R}\n`);
  for (const s of summary) {
    const col = s.status === 'PASS' ? C.green : s.status === 'SKIP' ? C.yellow : s.status === 'WARN' ? C.yellow : C.red;
    const dur = s.ms ? `  ${C.dim}${(s.ms / 1000).toFixed(1)}s${R}` : '';
    console.log(`  ${col}${s.status.padEnd(5)}${R}  Stage ${s.num}  ${s.label}${dur}`);
  }
  console.log(`\n${C.bold}${C.white}${'─'.repeat(64)}${R}\n`);

  const failed = summary.filter(s => s.status === 'FAIL').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
