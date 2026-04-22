'use strict';
/**
 * run-functional.js  —  Functional (Playwright E2E) Test Pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * Dedicated runner for FUNCTIONAL testing only. Executes all Playwright specs
 * against the AUT, syncs results to Zephyr, heals failures, creates Jira bugs,
 * and generates HTML + Allure reports.
 *
 * No performance (k6) or security (ZAP) testing is involved.
 *
 *  Stages:
 *   ┌──────────────────────────────────────────────────────────────────────────┐
 *   │  Stage 1  Run Playwright specs + sync Pass/Fail to Zephyr test cycle    │
 *   │  Stage 2  Self-Healing Agent → repair failing specs + re-run            │
 *   │  Stage 3  Auto-create Jira bugs for remaining failures                  │
 *   │  Stage 4  Generate interactive HTML report (with screenshots/video)     │
 *   │  Stage 5  Generate Allure report (interactive drill-down)               │
 *   │  Stage 6  Git Agent — auto-commit + push all changes                   │
 *   └──────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-functional.js                 ← full functional pipeline
 *   node scripts/run-functional.js --headless      ← CI / headless mode
 *   node scripts/run-functional.js --skip-heal     ← skip Stage 2 (self-healer)
 *   node scripts/run-functional.js --skip-bugs     ← skip Stage 3 (bug creation)
 *   node scripts/run-functional.js --skip-sync     ← skip Zephyr sync in Stage 1
 *   node scripts/run-functional.js --skip-report   ← skip HTML + Allure reports
 *   node scripts/run-functional.js --skip-git      ← skip Stage 6 (git push)
 *
 * All configuration is read from .env  (ISSUE_KEY, ZEPHYR_*, JIRA_*, BASE_URL)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

const useHeadless  = flags.has('--headless')     || process.env.PW_HEADLESS === 'true';
const skipHeal     = flags.has('--skip-heal');
const skipBugs     = flags.has('--skip-bugs');
const skipSync     = flags.has('--skip-sync');
const skipReport   = flags.has('--skip-report');
const skipGit      = flags.has('--skip-git');

// ─── ANSI helpers ─────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:   '\x1b[1m', dim:    '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red:  '\x1b[31m',
  cyan:   '\x1b[36m', blue:   '\x1b[34m', white: '\x1b[97m',
};

function now() { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }

function banner() {
  const W = 56;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = s => `${C.bold}${C.blue}║  ${C.reset}${pad(s)}${C.bold}${C.blue}║${C.reset}`;
  console.log(`\n${C.bold}${C.blue}╔${B}╗${C.reset}`);
  console.log(row('Agentic QA Platform  —  Functional Test Pipeline'));
  console.log(row(''));
  console.log(row('Scope    : Playwright E2E specs only'));
  console.log(row('Non-functional (perf/security): EXCLUDED'));
  console.log(row(''));
  console.log(row(`Mode     : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`));
  console.log(row(`Issue    : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`));
  console.log(row(`Heal     : ${skipHeal ? 'SKIPPED (--skip-heal)' : 'ON — self-heal failing specs'}`));
  console.log(row(`Bugs     : ${skipBugs ? 'SKIPPED (--skip-bugs)' : 'ON — auto-create Jira bugs'}`));
  console.log(row(`Git      : ${skipGit  ? 'SKIPPED (--skip-git)'  : 'ON — auto-commit + push'}`));
  console.log(row(`Time     : ${now()}`));
  console.log(`${C.bold}${C.blue}╚${B}╝${C.reset}\n`);
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
  console.log(`\n${icon} ${C.bold}${col}[${num}] ${label}${C.reset}  (${(ms / 1000).toFixed(1)}s)\n`);
}

function runScript(relPath, extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${C.reset}`);
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

// ─── Pipeline definition ──────────────────────────────────────────────────────
const STAGES = [
  {
    num:      1,
    label:    `Run Playwright specs [${useHeadless ? 'HEADLESS' : 'HEADED'}] → sync to Zephyr`,
    script:   skipSync ? 'scripts/run-e2e.js'   : 'scripts/run-and-sync.js',
    skip:     () => false,
    softFail: true,    // test failures are expected; don't halt the pipeline
    extraEnv: () => ({
      PW_HEADLESS:   useHeadless ? 'true' : 'false',
      SKIP_ZEPHYR:   skipSync    ? 'true' : 'false',
    }),
  },
  {
    num:      2,
    label:    'Self-Healing Agent → repair + re-run failures',
    script:   'scripts/healer.js',
    skip:     () => skipHeal,
    skipMsg:  '--skip-heal passed',
    softFail: true,
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false' }),
  },
  {
    num:      3,
    label:    'Auto-create Jira bugs for remaining failures',
    script:   'scripts/create-jira-bugs.js',
    skip:     () => skipBugs,
    skipMsg:  '--skip-bugs passed',
    softFail: true,
  },
  {
    num:      4,
    label:    'Generate HTML report (screenshots + video)',
    script:   'scripts/generate-report.js',
    skip:     () => skipReport,
    skipMsg:  '--skip-report passed',
    softFail: false,
  },
  {
    num:      5,
    label:    'Generate Allure report',
    script:   'scripts/generate-allure-report.js',
    skip:     () => skipReport,
    skipMsg:  '--skip-report passed',
    softFail: true,
  },
  {
    num:      6,
    label:    'Git Agent — auto-commit + push',
    script:   'scripts/git-sync.js',
    skip:     () => skipGit,
    skipMsg:  '--skip-git passed',
    softFail: true,
  },
];

const TOTAL = STAGES.length;

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const pipelineStart = Date.now();
  banner();

  const summary = [];

  for (const stage of STAGES) {
    const skipped = stage.skip();
    stageHeader(stage.num, TOTAL, stage.label, skipped);

    if (skipped) {
      console.log(`  ${C.yellow}↷  Skipped — ${stage.skipMsg}${C.reset}\n`);
      summary.push({ num: stage.num, label: stage.label, status: 'SKIP', ms: 0 });
      continue;
    }

    const t0  = Date.now();
    const env = stage.extraEnv ? stage.extraEnv() : {};
    const { ok, exitCode } = runScript(stage.script, env);
    const ms  = Date.now() - t0;

    stageDone(stage.num, stage.label, ok || stage.softFail, ms);

    summary.push({
      num:    stage.num,
      label:  stage.label,
      status: ok ? 'PASS' : (stage.softFail ? 'WARN' : 'FAIL'),
      ms,
      exitCode,
    });

    if (!ok && !stage.softFail) {
      console.error(`\n${C.red}  Pipeline halted at Stage ${stage.num} (exit ${exitCode}).${C.reset}\n`);
      break;
    }
  }

  // ─── Summary ───────────────────────────────────────────────────────────────
  const total = (Date.now() - pipelineStart) / 1000;
  console.log(`\n${C.bold}${C.white}${'─'.repeat(62)}${C.reset}`);
  console.log(`${C.bold}  Functional Pipeline Summary  ${C.dim}(${total.toFixed(1)}s total)${C.reset}\n`);
  for (const s of summary) {
    const col = s.status === 'PASS' ? C.green : s.status === 'SKIP' ? C.yellow : s.status === 'WARN' ? C.yellow : C.red;
    const dur = s.ms ? `  ${C.dim}${(s.ms / 1000).toFixed(1)}s${C.reset}` : '';
    console.log(`  ${col}${s.status.padEnd(5)}${C.reset}  Stage ${s.num}  ${s.label}${dur}`);
  }
  console.log(`\n${C.bold}${C.white}${'─'.repeat(62)}${C.reset}\n`);

  const failed = summary.filter(s => s.status === 'FAIL').length;
  process.exit(failed > 0 ? 1 : 0);
}

main().catch(err => { console.error(err); process.exit(1); });
