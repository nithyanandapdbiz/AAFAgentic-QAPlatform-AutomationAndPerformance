'use strict';
/**
 * run-full-pipeline.js  —  Full Autonomous QA Journey
 * ─────────────────────────────────────────────────────────────────────────────
 * Executes the COMPLETE end-to-end QA journey for a Jira user story with zero
 * human input — from story analysis all the way to the HTML report.
 *
 *  Journey (8 stages):
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │  Stage 1  Analyse Jira story → AI test plan → create Zephyr test cases  │
 *   │           (BVA, EP, DT, ST, EG, UC — with concrete test data)           │
 *   │  Stage 2  Generate Playwright spec files from Zephyr                    │
 *   │  Stage 3  Execute all specs in headed browser (or headless)             │
 *   │           → Sync Pass/Fail to Zephyr test cycle                        │
 *   │  Stage 4  Self-Healing Agent → repair failing specs + re-run            │
 *   │  Stage 5  Auto-create Jira bugs for remaining failures (linked to story)│
 *   │  Stage 6  Generate interactive HTML report                              │
 *   │  Stage 7  Generate Allure report (interactive drill-down)               │
 *   │  Stage 8  Git Agent — auto-commit + push all changes                   │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-full-pipeline.js                    ← full journey
 *   node scripts/run-full-pipeline.js --headless         ← CI / headless mode
 *   node scripts/run-full-pipeline.js --force            ← recreate Zephyr TCs
 *   node scripts/run-full-pipeline.js --skip-heal        ← skip self-healer
 *   node scripts/run-full-pipeline.js --skip-bugs        ← skip Jira bug creation
 *   node scripts/run-full-pipeline.js --skip-git         ← skip git auto-commit + push
 *   ISSUE_KEY=SCRUM-6 node scripts/run-full-pipeline.js  ← override story key
 *
 * All configuration is read from .env  (ISSUE_KEY, PROJECT_KEY, JIRA_*, ZEPHYR_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT  = path.resolve(__dirname, '..');
const args  = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

const useHeadless = flags.has('--headless') || process.env.PW_HEADLESS === 'true';
const useForce    = flags.has('--force');

// ─── ANSI ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:   '\x1b[36m', blue:  '\x1b[34m',  white: '\x1b[97m',
  purple: '\x1b[35m',
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner() {
  const W = 62;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.purple}║  ${C.reset}${pad(s)}${C.bold}${C.purple}║${C.reset}`;
  console.log(`\n${C.bold}${C.purple}╔${B}╗${C.reset}`);
  console.log(row('Agentic QA Platform  —  Full Autonomous Pipeline'));
  console.log(row(''));
  console.log(row('  Jira Story  →  Test Plan  →  Zephyr TCs  →  Specs'));
  console.log(row('  →  Execute  →  Heal  →  Bugs  →  Report  →  Allure  →  Git'));
  console.log(row(''));
  console.log(row(`  Story  : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`));
  console.log(row(`  Mode   : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`));
  console.log(row(`  Force  : ${useForce ? 'YES — will recreate Zephyr test cases' : 'No (dedup active)'}`));
  console.log(row(`  Time   : ${now()}`));
  console.log(`${C.bold}${C.purple}╚${B}╝${C.reset}\n`);
}

function stageHeader(num, total, label, skipped = false) {
  const tag = skipped ? `${C.yellow}SKIP${C.reset}` : `${C.cyan}RUN${C.reset}`;
  console.log(`\n${C.bold}${C.white}┌─ [${num}/${total}] ${label}${C.reset}  ${tag}`);
  console.log(`${C.dim}│  ${now()}${C.reset}`);
  console.log(`${C.bold}${C.white}└${'─'.repeat(60)}${C.reset}\n`);
}

function stageDone(num, label, ok, ms) {
  const icon = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const col  = ok ? C.green : C.red;
  console.log(`\n${icon} ${C.bold}${col}[${num}] ${label}${C.reset}  (${(ms/1000).toFixed(1)}s)\n`);
}

function runScript(relPath, extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${C.reset}`);
    return { ok: false, exitCode: 1 };
  }
  const r = spawnSync('node', [abs], {
    cwd: ROOT, stdio: 'inherit',
    env: { ...process.env, ...extraEnv }
  });
  const exitCode = r.status ?? (r.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode };
}

// ─── Pipeline stages ───────────────────────────────────────────────────────
const STAGES = [
  {
    num: 1, label: 'Analyse story → build AI test plan',
    desc: 'Fetches the Jira story, applies design techniques (BVA/EP/DT/ST/EG/UC), creates Zephyr test cases',
    script: 'scripts/run-story.js',
    skip: () => false,
    softFail: false,
    extraEnv: () => useForce ? { FORCE_CREATE: 'true' } : {}
  },
  {
    num: 2, label: 'Generate Playwright spec files from Zephyr',
    desc: 'Converts Zephyr test cases into executable POM-based Playwright specs',
    script: 'scripts/generate-playwright.js',
    skip: () => false,
    softFail: false
  },
  {
    num: 3, label: `Execute tests [${useHeadless ? 'HEADLESS' : 'HEADED/UI'}] → sync Zephyr`,
    desc: `Runs all specs in ${useHeadless ? 'headless' : 'headed'} browser. Syncs Pass/Fail to Zephyr test cycle.`,
    script: 'scripts/run-and-sync.js',
    skip: () => false,
    softFail: true,
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false' })
  },
  {
    num: 4, label: 'Self-Healing Agent → repair & re-run failures',
    desc: 'Classifies failures, applies patches (timeout/strict-mode/visibility/navigation), re-runs healed specs',
    script: 'scripts/healer.js',
    skip: () => flags.has('--skip-heal'),
    skipMsg: 'Healer skipped  (--skip-heal)',
    softFail: true,
    // Stage 3 (run-and-sync.js) already executed the full suite and wrote test-results.json.
    // Pass --skip-run so the healer uses those results instead of re-running the entire suite.
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false', HEALER_SKIP_RUN: 'true' })
  },
  {
    num: 5, label: 'Auto-create Jira bugs for remaining failures',
    desc: `Creates and links Jira bugs to parent story ${process.env.ISSUE_KEY || 'ISSUE_KEY'}`,
    script: 'scripts/create-jira-bugs.js',
    skip: () => flags.has('--skip-bugs'),
    skipMsg: 'Bug creation skipped  (--skip-bugs)',
    softFail: true
  },
  {
    num: 6, label: 'Generate HTML report',
    desc: 'Builds interactive report with pass/fail breakdown, screenshots, and Zephyr links',
    script: 'scripts/generate-report.js',
    skip: () => false,
    softFail: false
  },
  {
    num: 7, label: 'Generate Allure report',
    desc: 'Converts allure-results/ into a rich interactive Allure HTML report',
    script: 'scripts/generate-allure-report.js',
    skip: () => false,
    softFail: true   // non-critical — missing allure-results/ prints a warning and continues
  },
  {
    num: 8, label: 'Git Agent — auto-commit + push all changes',
    desc: 'Stages all modified files (specs, results, reports), commits, and pushes to current branch',
    script: 'scripts/git-sync.js',
    skip: () => flags.has('--skip-git'),
    skipMsg: 'Git sync skipped  (--skip-git)',
    softFail: true   // non-critical — push failure should not halt pipeline
  }
];

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const t0     = Date.now();
  const total  = STAGES.length;
  banner();

  const summary = [];

  for (const stage of STAGES) {
    const skipped = stage.skip();
    stageHeader(stage.num, total, stage.label, skipped);

    if (!skipped && stage.desc) console.log(`  ${C.dim}${stage.desc}${C.reset}\n`);

    if (skipped) {
      console.log(`  ${C.yellow}↷ Skipped${C.reset}  ${C.dim}${stage.skipMsg || ''}${C.reset}\n`);
      summary.push({ num: stage.num, label: stage.label, status: 'SKIPPED', ms: 0 });
      continue;
    }

    const extraEnv = stage.extraEnv ? stage.extraEnv() : {};
    const ts       = Date.now();
    const { ok, exitCode } = runScript(stage.script, extraEnv);
    const ms = Date.now() - ts;

    stageDone(stage.num, stage.label, ok, ms);
    const isSoft = !ok && stage.softFail;
    summary.push({
      num: stage.num, label: stage.label,
      status: ok ? 'PASS' : (isSoft ? 'WARN' : 'FAIL'),
      ms, exitCode
    });

    if (!ok && !isSoft) {
      console.error(`\n${C.red}  Pipeline halted at Stage ${stage.num} (exit ${exitCode}).${C.reset}\n`);
      break;
    }
  }

  // ── Summary table ──────────────────────────────────────────────────────
  const totalSec = ((Date.now() - t0) / 1000).toFixed(1);
  console.log(`\n${C.bold}${C.white}┌── Journey Summary ${'─'.repeat(44)}${C.reset}`);
  for (const s of summary) {
    const icon = s.status === 'PASS'    ? `${C.green}✓ PASS   ${C.reset}`
               : s.status === 'WARN'    ? `${C.yellow}⚠ WARN   ${C.reset}`
               : s.status === 'SKIPPED' ? `${C.dim}↷ SKIPPED${C.reset}`
               :                          `${C.red}✗ FAIL   ${C.reset}`;
    const dur  = s.status === 'SKIPPED' ? '      ' : `${(s.ms/1000).toFixed(1)}s`.padStart(6);
    console.log(`${C.bold}│${C.reset}  Stage ${s.num}  ${icon}  ${dur}  ${s.label}`);
  }
  console.log(`${C.bold}${C.white}└── Total: ${totalSec}s ${'─'.repeat(48)}${C.reset}\n`);

  const reportPath  = path.join(ROOT, 'custom-report', 'index.html');
  const allurePath  = path.join(ROOT, 'allure-report', 'index.html');
  if (fs.existsSync(reportPath)) {
    console.log(`  ${C.cyan}📄  Custom Report : custom-report/index.html${C.reset}`);
  }
  if (fs.existsSync(allurePath)) {
    console.log(`  ${C.purple}📊  Allure Report : allure-report/index.html${C.reset}`);
  }
  console.log();

  process.exit(summary.some(s => s.status === 'FAIL') ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${C.red}  FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
