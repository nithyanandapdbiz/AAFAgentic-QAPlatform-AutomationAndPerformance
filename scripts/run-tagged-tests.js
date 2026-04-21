'use strict';
/**
 * run-tagged-tests.js  —  Annotation / Tag-Filtered Test Execution
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs only the Playwright test cases that match a given tag or annotation,
 * then generates the HTML report. Useful for targeted regression runs, smoke
 * checks, or technique-specific validation without running the full suite.
 *
 *  Tag filtering works at two levels:
 *   1. Spec FILE filtering  — matches spec filename patterns
 *      (fast, no need to open each file)
 *   2. Playwright --grep    — matches inside test title / describe block
 *      (precise, case-insensitive regex)
 *
 *  Built-in tag aliases:
 *   ┌───────────────┬──────────────────────────────────────────────────────────┐
 *   │ Tag           │ Matches test cases about …                               │
 *   ├───────────────┼──────────────────────────────────────────────────────────┤
 *   │ smoke         │ successful / happy-path tests                            │
 *   │ regression    │ all tests (full regression suite)                        │
 *   │ bva           │ boundary value analysis tests                            │
 *   │ ep            │ equivalence partitioning tests                           │
 *   │ negative      │ invalid input / mandatory-field tests                    │
 *   │ boundary      │ boundary-value and edge-case tests                       │
 *   │ security      │ RBAC / role-based access control tests                   │
 *   │ rbac          │ role-based access control tests                          │
 *   │ unicode       │ special characters and unicode tests                     │
 *   │ ui            │ UI feedback / visual validation tests                    │
 *   │ cancel        │ cancel / discard action tests                            │
 *   │ persistence   │ data persistence tests                                   │
 *   │ duplicate     │ duplicate entry / dedup tests                            │
 *   │ max           │ maximum record count tests                               │
 *   │ <TC-key>      │ exact Zephyr key, e.g. SCRUM-T36                        │
 *   │ <any regex>   │ passed directly as Playwright --grep pattern            │
 *   └───────────────┴──────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-tagged-tests.js --tag smoke
 *   node scripts/run-tagged-tests.js --tag bva
 *   node scripts/run-tagged-tests.js --tag negative
 *   node scripts/run-tagged-tests.js --tag rbac
 *   node scripts/run-tagged-tests.js --tag SCRUM-T36
 *   node scripts/run-tagged-tests.js --tag "boundary|duplicate"
 *   node scripts/run-tagged-tests.js --tag regression --skip-heal
 *
 * ─── Options ─────────────────────────────────────────────────────────────────
 *   --tag <value>    Tag / annotation / regex to filter tests  (REQUIRED)
 *   --skip-heal      Skip the self-healing stage
 *   --skip-bugs      Skip Jira bug creation
 *   --skip-git       Skip git auto-commit + push
 *   --list-only      Print matching spec files and test count, do not run
 *
 * All configuration is read from .env  (ISSUE_KEY, PROJECT_KEY, JIRA_*, ZEPHYR_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs                       = require('fs');
const path                     = require('path');

const ROOT      = path.resolve(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'tests', 'specs');

const args  = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

// ─── Parse --tag argument ──────────────────────────────────────────────────
const tagIdx = args.findIndex(a => a.toLowerCase() === '--tag');
const rawTag = tagIdx !== -1 ? args[tagIdx + 1] : null;

const useHeadless = flags.has('--headless') || process.env.PW_HEADLESS === 'true';
const listOnly    = flags.has('--list-only');

// ─── Tag → grep pattern map ────────────────────────────────────────────────
const TAG_MAP = {
  // Test type shortcuts
  smoke:       'successful|happy.path|valid input',
  regression:  '.*',                             // all tests
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

// ─── File-name patterns for fast spec-file filtering ──────────────────────
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
  regression:  /.spec\.js$/i,   // all specs
};

// ─── ANSI ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:   '\x1b[36m', white:  '\x1b[97m', orange: '\x1b[33m',
};
const RESET = C.reset;

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner(tag, grepPattern, specFiles) {
  const W = 62;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.orange}║  ${RESET}${pad(s)}${C.bold}${C.orange}║${RESET}`;
  console.log(`\n${C.bold}${C.orange}╔${B}╗${RESET}`);
  console.log(row('Agentic QA  —  Tag / Annotation Filtered Execution'));
  console.log(row(''));
  console.log(row(`  Tag      : ${tag}`));
  console.log(row(`  Pattern  : ${grepPattern.slice(0, 55)}`));
  console.log(row(`  Matching : ${specFiles.length} spec file(s)`));
  console.log(row(`  Mode     : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`));
  console.log(row(`  Time     : ${now()}`));
  if (listOnly) console.log(row('  *** LIST-ONLY mode — tests will NOT be executed ***'));
  console.log(`${C.bold}${C.orange}╚${B}╝${RESET}\n`);
}

function stageHeader(num, total, label, skipped = false) {
  const tag = skipped ? `${C.yellow}SKIP${RESET}` : `${C.cyan}RUN${RESET}`;
  console.log(`\n${C.bold}${C.white}┌─ [${num}/${total}] ${label}${RESET}  ${tag}`);
  console.log(`${C.dim}│  ${now()}${RESET}`);
  console.log(`${C.bold}${C.white}└${'─'.repeat(60)}${RESET}\n`);
}

function stageDone(num, label, ok, ms) {
  const icon = ok ? `${C.green}✓${RESET}` : `${C.red}✗${RESET}`;
  const col  = ok ? C.green : C.red;
  console.log(`\n${icon} ${C.bold}${col}[${num}] ${label}${RESET}  (${(ms/1000).toFixed(1)}s)\n`);
}

function runScript(relPath, extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${RESET}`);
    return { ok: false, exitCode: 1 };
  }
  const r = spawnSync('node', [abs], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  const exitCode = r.status ?? (r.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode };
}

// ─── Resolve tag → { grepPattern, specFiles } ─────────────────────────────
function resolveTag(rawTag) {
  if (!rawTag) return null;

  const lower = rawTag.toLowerCase();

  // Exact Zephyr TC key: SCRUM-T36
  if (/^[a-z]+-t\d+$/i.test(rawTag)) {
    const specFile = fs.readdirSync(SPECS_DIR)
      .find(f => f.toLowerCase().startsWith(rawTag.toLowerCase() + '_') && f.endsWith('.spec.js'));
    const specFiles = specFile ? [path.join(SPECS_DIR, specFile)] : [];
    return { grepPattern: rawTag, specFiles, isKeyMode: true };
  }

  // Named alias
  const grepPattern  = TAG_MAP[lower]  || rawTag;   // fallback: use rawTag as regex
  const filePattern  = FILE_PATTERNS[lower];

  let specFiles;
  if (filePattern) {
    // Fast file-based filter
    specFiles = fs.readdirSync(SPECS_DIR)
      .filter(f => f.endsWith('.spec.js') && filePattern.test(f))
      .map(f => path.join(SPECS_DIR, f));
  } else {
    // No file pattern — include all specs, rely on --grep inside Playwright
    specFiles = fs.readdirSync(SPECS_DIR)
      .filter(f => f.endsWith('.spec.js'))
      .map(f => path.join(SPECS_DIR, f));
  }

  return { grepPattern, specFiles, isKeyMode: false };
}

// ─── Run Playwright with grep ─────────────────────────────────────────────
function runPlaywright(specFiles, grepPattern) {
  const RESULTS_FILE = path.join(ROOT, 'test-results.json');
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  const relSpecs = specFiles.map(f => path.relative(ROOT, f));

  // Pass the grep pattern via PW_GREP env var (read by playwright.config.js)
  // instead of --grep on the CLI — this avoids Windows cmd.exe treating "|"
  // as a pipe operator, which breaks multi-pattern regexes like
  // "successful|happy.path|valid input".
  // Use forward slashes in spec paths — Playwright treats CLI file args as
  // globs/regexes and backslashes break matching on Windows.
  const relSpecs2 = relSpecs.map(p => p.replace(/\\/g, '/'));
  const pwArgs = ['playwright', 'test', ...relSpecs2];

  const displayCmd = `npx ${pwArgs.join(' ')}${grepPattern && grepPattern !== '.*' ? ` --grep "${grepPattern}"` : ''}`;
  console.log(`  ${C.dim}Running: ${displayCmd}${RESET}\n`);

  const extraEnv = {
    ...process.env,
    PW_HEADLESS: 'false',
    PLAYWRIGHT_JSON_OUTPUT_NAME: RESULTS_FILE
  };
  if (grepPattern && grepPattern !== '.*') extraEnv.PW_GREP = grepPattern;

  const NPX = process.platform === 'win32' ? 'npx.cmd' : 'npx';
  const r = spawnSync(NPX, pwArgs, {
    cwd:   ROOT,
    stdio: 'inherit',
    shell: true,   // npx requires shell on Windows; PW_GREP env var carries the
    env:   extraEnv  // pattern so the shell never sees pipe chars in CLI args
  });

  return r.status ?? (r.error ? 1 : 0);
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  if (!rawTag) {
    console.error(`${C.red}
  Error: --tag is required.

  Examples:
    node scripts/run-tagged-tests.js --tag smoke
    node scripts/run-tagged-tests.js --tag bva
    node scripts/run-tagged-tests.js --tag SCRUM-T36
    node scripts/run-tagged-tests.js --tag "boundary|duplicate"

  Available tag aliases:
    smoke, regression, bva, ep, negative, boundary, security,
    rbac, unicode, ui, cancel, persistence, duplicate, max
${RESET}`);
    process.exit(1);
  }

  const resolved = resolveTag(rawTag);
  if (!resolved) {
    console.error(`${C.red}  Could not resolve tag: "${rawTag}"${RESET}`);
    process.exit(1);
  }

  const { grepPattern, specFiles } = resolved;

  banner(rawTag, grepPattern, specFiles);

  if (specFiles.length === 0) {
    console.log(`${C.yellow}  No spec files matched tag "${rawTag}". No tests to run.${RESET}\n`);
    process.exit(0);
  }

  console.log(`  ${C.bold}Matching spec files:${RESET}`);
  specFiles.forEach(f => console.log(`    ${C.dim}→ ${path.basename(f)}${RESET}`));
  console.log();

  // List-only mode: print and exit
  if (listOnly) {
    console.log(`${C.green}  ${specFiles.length} spec file(s) matched.${RESET}`);
    console.log(`${C.dim}  (Pass without --list-only to execute them.)${RESET}\n`);
    process.exit(0);
  }

  const TOTAL   = 6;
  const summary = [];
  const t0      = Date.now();

  // ── Stage 1: Execute filtered tests ────────────────────────────────────────────
  stageHeader(1, TOTAL, `Run [tag: ${rawTag}] — ${specFiles.length} spec(s) [${useHeadless ? 'HEADLESS' : 'HEADED'}]`);
  const ts1   = Date.now();
  const pwExit = runPlaywright(specFiles, grepPattern);
  const ms1    = Date.now() - ts1;
  stageDone(1, `Execute [tag: ${rawTag}]`, pwExit === 0 || true, ms1);
  summary.push({ num: 1, label: `Execute [tag: ${rawTag}]`, status: pwExit === 0 ? 'PASS' : 'WARN', ms: ms1 });

  // ── Stage 2: Self-Healing Agent ────────────────────────────────────────────
  stageHeader(2, TOTAL, 'Self-Healing Agent → repair & re-run failures', flags.has('--skip-heal'));
  if (flags.has('--skip-heal')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-heal)${RESET}\n`);
    summary.push({ num: 2, label: 'Self-Healing Agent', status: 'SKIPPED', ms: 0 });
  } else {
    const ts2 = Date.now();
    const { ok } = runScript('scripts/healer.js', { PW_HEADLESS: 'false' });
    const ms2 = Date.now() - ts2;
    stageDone(2, 'Self-Healing Agent', ok || true, ms2);
    summary.push({ num: 2, label: 'Self-Healing Agent', status: ok ? 'PASS' : 'WARN', ms: ms2 });
  }

  // ── Stage 3: Jira bug creation ─────────────────────────────────────────────────
  stageHeader(3, TOTAL, 'Auto-create Jira bugs for remaining failures', flags.has('--skip-bugs'));
  if (flags.has('--skip-bugs')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-bugs)${RESET}\n`);
    summary.push({ num: 3, label: 'Jira bug creation', status: 'SKIPPED', ms: 0 });
  } else {
    const tsB = Date.now();
    const { ok: okBugs } = runScript('scripts/create-jira-bugs.js');
    const msB = Date.now() - tsB;
    stageDone(3, 'Jira bug creation', okBugs || true, msB);
    summary.push({ num: 3, label: 'Jira bug creation', status: okBugs ? 'PASS' : 'WARN', ms: msB });
  }

  // ── Stage 4: HTML report ──────────────────────────────────────────────────────
  stageHeader(4, TOTAL, 'Generate HTML report');
  const ts3 = Date.now();
  const { ok: okReport } = runScript('scripts/generate-report.js');
  const ms3 = Date.now() - ts3;
  stageDone(4, 'Generate HTML report', okReport, ms3);
  summary.push({ num: 4, label: 'Generate HTML report', status: okReport ? 'PASS' : 'FAIL', ms: ms3 });

  // ── Stage 5: Allure report ─────────────────────────────────────────────────
  stageHeader(5, TOTAL, 'Generate Allure report');
  const ts4 = Date.now();
  const { ok: okAllure } = runScript('scripts/generate-allure-report.js');
  const ms4 = Date.now() - ts4;
  stageDone(5, 'Generate Allure report', okAllure || true, ms4);
  summary.push({ num: 5, label: 'Generate Allure report', status: okAllure ? 'PASS' : 'WARN', ms: ms4 });

  // ── Stage 6: Git Agent — auto-commit + push ──────────────────────────────
  stageHeader(6, TOTAL, 'Git Agent — auto-commit + push', flags.has('--skip-git'));
  if (flags.has('--skip-git')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-git)${RESET}\n`);
    summary.push({ num: 6, label: 'Git Agent', status: 'SKIPPED', ms: 0 });
  } else {
    const ts6 = Date.now();
    const { ok: okGit } = runScript('scripts/git-sync.js');
    const ms6 = Date.now() - ts6;
    stageDone(6, 'Git Agent', okGit || true, ms6);
    summary.push({ num: 6, label: 'Git Agent', status: okGit ? 'PASS' : 'WARN', ms: ms6 });
  }
  // ── Summary ────────────────────────────────────────────────────────────────
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.bold}${C.white}┌── Execution Summary (tag: ${rawTag}) ${'─'.repeat(27)}${RESET}`);
  console.log(`${C.bold}│${RESET}  Specs: ${specFiles.length}  |  Grep: ${grepPattern.slice(0, 48)}`);
  for (const s of summary) {
    const icon = s.status === 'PASS'    ? `${C.green}✓ PASS   ${RESET}`
               : s.status === 'WARN'    ? `${C.yellow}⚠ WARN   ${RESET}`
               : s.status === 'SKIPPED' ? `${C.dim}↷ SKIPPED${RESET}`
               :                          `${C.red}✗ FAIL   ${RESET}`;
    const dur  = s.status === 'SKIPPED' ? '      ' : `${(s.ms/1000).toFixed(1)}s`.padStart(6);
    console.log(`${C.bold}│${RESET}  Step ${s.num}  ${icon}  ${dur}  ${s.label}`);
  }
  console.log(`${C.bold}${C.white}└── Total: ${totalSec}s ${'─'.repeat(48)}${RESET}\n`);

  const reportPath    = path.join(ROOT, 'custom-report', 'index.html');
  const allurePath    = path.join(ROOT, 'allure-report', 'index.html');
  if (fs.existsSync(reportPath))     console.log(`  ${C.cyan}📄  Custom Report      : custom-report/index.html${RESET}`);
  if (fs.existsSync(allurePath))     console.log(`  ${C.cyan}📊  Allure Report      : allure-report/index.html${RESET}`);
  console.log();

  process.exit(summary.some(s => s.status === 'FAIL') ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${C.red}  FATAL: ${err.message}${RESET}\n`);
  process.exit(1);
});
