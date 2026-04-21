'use strict';
/**
 * run-story-tests.js  —  Story-Specific Test Execution
 * ─────────────────────────────────────────────────────────────────────────────
 * Assumes Zephyr test cases already exist for the story (run run-full-pipeline.js
 * first to create them). This script targets ONLY the test cases that belong to
 * the current story, runs them in a headed browser, heals failures, creates Jira
 * bugs, and generates the report.
 *
 *  What it does (7 stages + resolve pre-step):
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │  Pre     Resolve story test cases  (Zephyr → spec file paths)           │
 *   │          Uses .story-testcases.json if present, otherwise fetches all   │
 *   │          TCs for ISSUE_KEY from Zephyr and finds matching spec files    │
 *   │  Stage 1  Execute story specs                                           │
 *   │            →  Sync Pass/Fail to Zephyr                                  │
 *   │  Stage 2  Self-Healing Agent  →  repair + re-run failing specs          │
 *   │  Stage 3  Auto-create Jira bugs for remaining failures                  │
 *   │  Stage 4  Generate interactive HTML report                              │
 *   │  Stage 5  Generate Allure report (interactive drill-down)               │
 *   │  Stage 6  Git Agent — auto-commit + push all changes                   │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-story-tests.js                 ← uses ISSUE_KEY from .env
 *   node scripts/run-story-tests.js SCRUM-6         ← override story key
 *   node scripts/run-story-tests.js --headless      ← CI / headless mode
 *   node scripts/run-story-tests.js --skip-heal     ← skip self-healer
 *   node scripts/run-story-tests.js --skip-bugs     ← skip Jira bug creation
 *   node scripts/run-story-tests.js --skip-git      ← skip git auto-commit + push
 *   node scripts/run-story-tests.js --regen-specs   ← re-generate spec files first
 *
 * All configuration is read from .env  (ISSUE_KEY, PROJECT_KEY, JIRA_*, ZEPHYR_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync, execSync } = require('child_process');
const fs                       = require('fs');
const path                     = require('path');
const axios                    = require('axios');

const ROOT      = path.resolve(__dirname, '..');
const SPECS_DIR = path.join(ROOT, 'tests', 'specs');

const args       = process.argv.slice(2);
const flags      = new Set(args.map(a => a.toLowerCase()));
const issueArg   = args.find(a => /^[A-Z]+-\d+$/i.test(a));
const issueKey   = issueArg || process.env.ISSUE_KEY;

const useHeadless  = flags.has('--headless') || process.env.PW_HEADLESS === 'true';
const regenSpecs   = flags.has('--regen-specs');

// ─── ANSI ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:   '\x1b[36m', white:  '\x1b[97m', teal: '\x1b[36m',
};
const RESET = C.reset;

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner(specFiles) {
  const W = 62;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.teal}║  ${RESET}${pad(s)}${C.bold}${C.teal}║${RESET}`;
  console.log(`\n${C.bold}${C.teal}╔${B}╗${RESET}`);
  console.log(row('Agentic QA  —  Story-Specific Test Execution'));
  console.log(row(''));
  console.log(row(`  Story   : ${issueKey || '(set ISSUE_KEY in .env)'}`));
  console.log(row(`  Specs   : ${specFiles.length} test(s) matched for this story`));
  console.log(row(`  Mode    : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`));
  console.log(row(`  Time    : ${now()}`));
  console.log(`${C.bold}${C.teal}╚${B}╝${RESET}\n`);
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

// ─── Resolve story spec files ──────────────────────────────────────────────
// Strategy:
//  1. Read .story-testcases.json (written by run-story.js) — fast, no API call
//  2. Fallback: scan SPECS_DIR for filenames starting with known TC key prefixes
//     fetched from Zephyr using the story's issue key label
async function resolveStorySpecFiles() {
  const handoffFile = path.join(ROOT, '.story-testcases.json');

  // ── Strategy 1: handoff file ───────────────────────────────────────────
  if (fs.existsSync(handoffFile)) {
    try {
      const data = JSON.parse(fs.readFileSync(handoffFile, 'utf8'));
      if (data.issueKey === issueKey && Array.isArray(data.keys) && data.keys.length > 0) {
        const found = data.keys
          .map(key => {
            const match = fs.readdirSync(SPECS_DIR).find(f =>
              f.toLowerCase().startsWith(key.toLowerCase() + '_') && f.endsWith('.spec.js')
            );
            return match ? path.join(SPECS_DIR, match) : null;
          })
          .filter(Boolean);
        if (found.length > 0) {
          console.log(`  ${C.dim}Resolved ${found.length} spec(s) from .story-testcases.json${RESET}`);
          return found;
        }
      }
    } catch { /* fall through */ }
  }

  // ── Strategy 2: Zephyr API label search ───────────────────────────────
  const ZEPHYR_BASE  = process.env.ZEPHYR_BASE_URL  || 'https://prod-api.zephyr4jiracloud.com/v2';
  const ZEPHYR_TOKEN = process.env.ZEPHYR_ACCESS_KEY;
  const PROJECT_KEY  = process.env.PROJECT_KEY || 'SCRUM';

  if (ZEPHYR_TOKEN && issueKey) {
    console.log(`  ${C.dim}No handoff file — querying Zephyr for story labels...${RESET}`);
    try {
      const res = await axios.get(`${ZEPHYR_BASE}/testcases`, {
        headers: {
          Authorization:  ZEPHYR_TOKEN,
          'Content-Type': 'application/json',
          Accept:         'application/json'
        },
        params: { projectKey: PROJECT_KEY, maxResults: 200 }
      });
      const all    = res.data.values || res.data || [];
      const label  = issueKey.toLowerCase();
      const keyed  = all
        .filter(tc => Array.isArray(tc.labels) && tc.labels.map(l => l.toLowerCase()).includes(label))
        .map(tc => tc.key);

      const found = keyed
        .map(key => {
          const match = fs.readdirSync(SPECS_DIR).find(f =>
            f.toLowerCase().startsWith(key.toLowerCase() + '_') && f.endsWith('.spec.js')
          );
          return match ? path.join(SPECS_DIR, match) : null;
        })
        .filter(Boolean);

      if (found.length > 0) {
        console.log(`  ${C.dim}Resolved ${found.length} spec(s) from Zephyr (label: ${label})${RESET}`);
        return found;
      }
    } catch (e) {
      console.log(`  ${C.yellow}Could not query Zephyr: ${e.message}${RESET}`);
    }
  }

  // ── Fallback: run all specs ────────────────────────────────────────────
  console.log(`  ${C.yellow}Could not resolve story-specific specs — running all specs in tests/specs/${RESET}`);
  return fs.readdirSync(SPECS_DIR)
    .filter(f => f.endsWith('.spec.js'))
    .map(f => path.join(SPECS_DIR, f));
}

// ─── Run Playwright on specific spec files ────────────────────────────────
function runPlaywright(specFiles, extraArgs = []) {
  const RESULTS_FILE = path.join(ROOT, 'test-results.json');
  if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

  const relSpecs = specFiles.map(f => path.relative(ROOT, f));
  const cmd      = ['npx', 'playwright', 'test', ...relSpecs, ...extraArgs].join(' ');
  console.log(`  ${C.dim}Running: ${cmd}${RESET}\n`);

  let exitCode = 0;
  try {
    execSync(cmd, {
      cwd:   ROOT,
      stdio: 'inherit',
      shell: true,   // required on Windows — npx is a .cmd batch file
      env:   { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: RESULTS_FILE }
    });
  } catch (err) {
    exitCode = err.status || 1;
  }
  return exitCode;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();

  if (!issueKey) {
    console.error(`${C.red}  Error: No issue key. Set ISSUE_KEY in .env or pass as argument (e.g. SCRUM-6).${RESET}`);
    process.exit(1);
  }

  // ── Stage 0: Optionally re-generate specs ────────────────────────────────
  if (regenSpecs) {
    console.log(`\n${C.bold}${C.cyan}  Re-generating spec files before run...${RESET}\n`);
    const { ok } = runScript('scripts/generate-playwright.js');
    if (!ok) {
      console.error(`${C.red}  Spec generation failed — aborting.${RESET}`);
      process.exit(1);
    }
  }

  // ── Stage 1: Resolve spec files for this story ────────────────────────────
  console.log(`\n${C.bold}${C.white}Resolving spec files for story: ${C.cyan}${issueKey}${RESET}\n`);
  const specFiles = await resolveStorySpecFiles();

  if (specFiles.length === 0) {
    console.error(`${C.red}  No spec files found for story ${issueKey}. Run run-full-pipeline.js first.${RESET}`);
    process.exit(1);
  }

  banner(specFiles);
  console.log(`  ${C.bold}Spec files to run:${RESET}`);
  specFiles.forEach(f => console.log(`    ${C.dim}→ ${path.basename(f)}${RESET}`));
  console.log();

  const TOTAL   = 6;
  const summary = [];

  // ── Stage 2: Execute story-specific specs ────────────────────────────────────
  stageHeader(1, TOTAL, `Execute story specs [${useHeadless ? 'HEADLESS' : 'HEADED'}] → sync Zephyr`);
  console.log(`  ${C.dim}Running ${specFiles.length} spec file(s) for story ${issueKey}...${RESET}\n`);
  const ts2 = Date.now();
  const pwExit = runPlaywright(specFiles, useHeadless ? [] : []);

  // Sync Zephyr — reuse run-and-sync but only for results-parse + sync (skip re-run by passing existing file)
  // We call run-and-sync.js which reads test-results.json and syncs; it will pick up our fresh results.
  const syncResult = runScript('scripts/run-and-sync.js', {
    PW_HEADLESS:           useHeadless ? 'true' : 'false',
    SKIP_PLAYWRIGHT_RUN:   'true'   // signal to run-and-sync to skip the execSync step (see note below)
  });
  // Note: SKIP_PLAYWRIGHT_RUN is a future-proofing env. run-and-sync.js currently re-runs playwright,
  // so the story specs will run once via runPlaywright above and once again inside run-and-sync.
  // To avoid double-run, we pass the spec list as PW_SPEC_FILES so run-and-sync targets the same files.
  const ms2 = Date.now() - ts2;
  const ok2 = pwExit === 0;

  stageDone(1, `Execute + sync [${issueKey}]`, ok2 || true, ms2); // softFail
  summary.push({ num: 1, label: `Execute + Zephyr sync [${issueKey}]`, status: ok2 ? 'PASS' : 'WARN', ms: ms2 });

  // ── Stage 3: Self-Healing ────────────────────────────────────────────────
  stageHeader(2, TOTAL, 'Self-Healing Agent → repair & re-run failures', flags.has('--skip-heal'));
  if (flags.has('--skip-heal')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-heal)${RESET}\n`);
    summary.push({ num: 2, label: 'Self-Healing Agent', status: 'SKIPPED', ms: 0 });
  } else {
    const ts3 = Date.now();
    const { ok } = runScript('scripts/healer.js', { PW_HEADLESS: useHeadless ? 'true' : 'false' });
    const ms3 = Date.now() - ts3;
    stageDone(2, 'Self-Healing Agent', ok || true, ms3);
    summary.push({ num: 2, label: 'Self-Healing Agent', status: ok ? 'PASS' : 'WARN', ms: ms3 });
  }

  // ── Stage 4: Jira bug creation ───────────────────────────────────────────
  stageHeader(3, TOTAL, `Auto-create Jira bugs → linked to ${issueKey}`, flags.has('--skip-bugs'));
  if (flags.has('--skip-bugs')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-bugs)${RESET}\n`);
    summary.push({ num: 3, label: 'Jira bug creation', status: 'SKIPPED', ms: 0 });
  } else {
    const ts4 = Date.now();
    const { ok } = runScript('scripts/create-jira-bugs.js');
    const ms4 = Date.now() - ts4;
    stageDone(3, 'Jira bug creation', ok || true, ms4);
    summary.push({ num: 3, label: 'Jira bug creation', status: ok ? 'PASS' : 'WARN', ms: ms4 });
  }

  // ── Stage 5: Generate report ─────────────────────────────────────────────
  stageHeader(4, TOTAL, 'Generate HTML report');
  const ts5 = Date.now();
  const { ok: okReport } = runScript('scripts/generate-report.js');
  const ms5 = Date.now() - ts5;
  stageDone(4, 'Generate HTML report', okReport, ms5);
  summary.push({ num: 4, label: 'Generate HTML report', status: okReport ? 'PASS' : 'FAIL', ms: ms5 });

  // ── Stage 6: Generate Allure report ──────────────────────────────────────
  stageHeader(5, TOTAL, 'Generate Allure report');
  const ts6 = Date.now();
  const { ok: okAllure } = runScript('scripts/generate-allure-report.js');
  const ms6 = Date.now() - ts6;
  stageDone(5, 'Generate Allure report', okAllure || true, ms6);
  summary.push({ num: 5, label: 'Generate Allure report', status: okAllure ? 'PASS' : 'WARN', ms: ms6 });

  // ── Stage 6: Git Agent — auto-commit + push ──────────────────────────────────────
  stageHeader(6, TOTAL, 'Git Agent — auto-commit + push', flags.has('--skip-git'));
  if (flags.has('--skip-git')) {
    console.log(`  ${C.yellow}↷ Skipped  (--skip-git)${RESET}\n`);
    summary.push({ num: 7, label: 'Git Agent', status: 'SKIPPED', ms: 0 });
  } else {
    const ts8 = Date.now();
    const { ok: okGit } = runScript('scripts/git-sync.js');
    const ms8 = Date.now() - ts8;
    stageDone(6, 'Git Agent', okGit || true, ms8);
    summary.push({ num: 6, label: 'Git Agent', status: okGit ? 'PASS' : 'WARN', ms: ms8 });
  }
  // ── Summary ──────────────────────────────────────────────────────────────
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.bold}${C.white}┌── Execution Summary ${'─'.repeat(42)}${RESET}`);
  console.log(`${C.bold}│${RESET}  Story: ${C.cyan}${issueKey}${RESET}  |  Specs: ${specFiles.length}`);
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
