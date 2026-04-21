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
 *   node scripts/run-full-pipeline.js --include-perf      ← also run k6 performance tests
 *   node scripts/run-full-pipeline.js --include-security   ← also run ZAP + custom security scans
 *   node scripts/run-full-pipeline.js --headless         ← CI / headless mode
 *   node scripts/run-full-pipeline.js --force            ← recreate Zephyr TCs
 *   node scripts/run-full-pipeline.js --skip-heal        ← skip reactive self-healer
 *   node scripts/run-full-pipeline.js --skip-smart-heal   ← skip proactive smart-healer
 *   node scripts/run-full-pipeline.js --skip-bugs        ← skip Jira bug creation
 *   node scripts/run-full-pipeline.js --skip-git         ← skip git auto-commit + push
 *   ISSUE_KEY=SCRUM-6 node scripts/run-full-pipeline.js  ← override story key
 *
 * All configuration is read from .env  (ISSUE_KEY, PROJECT_KEY, JIRA_*, ZEPHYR_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync, spawn } = require('child_process');
const fs                   = require('fs');
const path                 = require('path');
const readline             = require('readline');

const ROOT  = path.resolve(__dirname, '..');
const args  = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

// ─── Opt-in new pipeline runner (backward-compatible) ─────────────────────
// When PIPELINE_USE_RUNNER=true or --use-runner is passed, delegate to the
// consolidated src/pipeline/runner with a named preset (PIPELINE_PRESET, default 'full').
// Default (unset) keeps the legacy STAGES[] path so existing CI does not change.
if (process.env.PIPELINE_USE_RUNNER === 'true' || flags.has('--use-runner')) {
  (async () => {
    const { runPipeline } = require('../src/pipeline/runner');
    const { PRESETS }     = require('../src/pipeline/presets');
    const presetName = process.env.PIPELINE_PRESET || 'full';
    const steps = PRESETS[presetName] || PRESETS.full;
    const ctx = {
      issueKey: process.env.ISSUE_KEY || null,
      flags: {
        headless:        flags.has('--headless') || process.env.PW_HEADLESS === 'true',
        force:           flags.has('--force'),
        includePerf:     flags.has('--include-perf'),
        includeSecurity: flags.has('--include-security'),
        skipHeal:        flags.has('--skip-heal'),
        skipSmartHeal:   flags.has('--skip-smart-heal'),
        skipBugs:        flags.has('--skip-bugs'),
        skipGit:         flags.has('--skip-git')
      }
    };
    const result = await runPipeline(steps, ctx);
    console.log(`\nPipeline summary: ${result.passed} passed, ${result.warned} warned, ${result.failed} failed, ${result.skipped} skipped, ${(result.durationMs/1000).toFixed(1)}s total`);
    process.exit(result.failed > 0 ? 1 : 0);
  })().catch(err => { console.error(err); process.exit(1); });
  return;
}


const useHeadless    = flags.has('--headless') || process.env.PW_HEADLESS === 'true';
const useForce       = flags.has('--force');
const includePerf    = flags.has('--include-perf');
const includeSecurity = flags.has('--include-security');

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
  console.log(row(`  Perf   : ${includePerf ? 'YES — k6 performance tests enabled' : 'No (use --include-perf)'}`));
  console.log(row(`  Sec    : ${includeSecurity ? 'YES — ZAP + custom security scans enabled' : 'No (use --include-security)'}`));
  if (includePerf && includeSecurity)
    console.log(row('  ⚡      : Perf + Security will run IN PARALLEL'));
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

/** Spawn a script non-blocking; prefix every stdout/stderr line with colorPrefix.
 *  Also writes a dedicate log file under logs/ for post-run inspection. */
function runScriptAsync(relPath, colorPrefix, extraEnv = {}) {
  return new Promise(resolve => {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      process.stderr.write(`${C.red}  Script not found: ${relPath}${C.reset}\n`);
      resolve({ ok: false, exitCode: 1 });
      return;
    }
    const logsDir = path.join(ROOT, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile   = path.join(logsDir, `${path.basename(relPath, '.js')}-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });
    const child = spawn('node', [abs], {
      cwd: ROOT, env: { ...process.env, ...extraEnv }, stdio: ['ignore', 'pipe', 'pipe'],
    });
    readline.createInterface({ input: child.stdout })
      .on('line', l => { process.stdout.write(`${colorPrefix} ${l}\n`); logStream.write(l + '\n'); });
    readline.createInterface({ input: child.stderr })
      .on('line', l => { process.stdout.write(`${colorPrefix} ${C.dim}${l}${C.reset}\n`); logStream.write(l + '\n'); });
    child.on('close', code => { logStream.end(); resolve({ ok: (code ?? 1) === 0, exitCode: code ?? 1, logFile }); });
  });
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
    num: '2b', label: 'Smart Proactive Healing — patch selectors from git diff',
    desc: 'Classifies git-diff changes, resolves affected POM pages, patches selectors proactively before test run',
    script: 'scripts/smart-healer.js',
    skip: () => flags.has('--skip-smart-heal'),
    skipMsg: 'Smart proactive healing skipped  (--skip-smart-heal)',
    softFail: true,
    extraEnv: () => ({})
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
    num: '3p', label: 'Performance tests — k6 pipeline',
    desc: 'Generates k6 scripts, executes them, evaluates thresholds, syncs to Zephyr, produces perf report',
    script: 'scripts/run-perf.js',
    parallel: true,
    skip: () => !includePerf,
    skipMsg: 'Perf tests skipped  (use --include-perf)',
    softFail: true,
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false' })
  },
  {
    num: '3s', label: 'Security tests — ZAP + custom checks',
    desc: 'Runs OWASP ZAP baseline scan + 10 custom security checks, evaluates findings, produces security report',
    script: 'scripts/run-security.js',
    parallel: true,
    skip: () => !includeSecurity,
    skipMsg: 'Security tests skipped  (use --include-security)',
    softFail: true
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

  // Prefix colours used when parallel stages interleave their output
  const PAR_PREFIX = [
    `${C.bold}${C.cyan}[3p·PERF]${C.reset}`,
    `${C.bold}${C.purple}[3s·SEC ]${C.reset}`,
  ];

  let si = 0;
  let halted = false;
  while (si < STAGES.length && !halted) {
    const stage = STAGES[si];

    // ── Parallel group: collect all consecutive parallel-flagged stages ────
    if (stage.parallel) {
      const group = [];
      while (si < STAGES.length && STAGES[si].parallel) { group.push(STAGES[si]); si++; }

      const runnable = group.filter(s => !s.skip());
      const skippedG = group.filter(s => s.skip());
      for (const s of skippedG) {
        stageHeader(s.num, total, s.label, true);
        console.log(`  ${C.yellow}↷ Skipped${C.reset}  ${C.dim}${s.skipMsg || ''}${C.reset}\n`);
        summary.push({ num: s.num, label: s.label, status: 'SKIPPED', ms: 0 });
      }

      if (runnable.length === 0) continue;

      if (runnable.length === 1) {
        // Only one enabled — no parallelism needed, use normal sequential path
        const s = runnable[0];
        stageHeader(s.num, total, s.label, false);
        if (s.desc) console.log(`  ${C.dim}${s.desc}${C.reset}\n`);
        const extraEnv = s.extraEnv ? s.extraEnv() : {};
        const ts = Date.now();
        const { ok, exitCode } = runScript(s.script, extraEnv);
        const ms = Date.now() - ts;
        stageDone(s.num, s.label, ok, ms);
        const isSoft = !ok && s.softFail;
        summary.push({ num: s.num, label: s.label, status: ok ? 'PASS' : (isSoft ? 'WARN' : 'FAIL'), ms, exitCode });
        if (!ok && !isSoft) { console.error(`\n${C.red}  Pipeline halted at Stage ${s.num} (exit ${exitCode}).${C.reset}\n`); halted = true; }
        continue;
      }

      // ── True parallel execution ──────────────────────────────────────────
      const names = runnable.map(s => `Stage ${s.num}`).join(' + ');
      console.log(`\n${C.bold}${C.cyan}╔${'═'.repeat(58)}╗${C.reset}`);
      console.log(`${C.bold}${C.cyan}║  ⚡ PARALLEL — ${names} running simultaneously${C.reset}`);
      console.log(`${C.bold}${C.cyan}║  Output prefixed: ${PAR_PREFIX.slice(0, runnable.length).join('  ')}${C.reset}`);
      console.log(`${C.bold}${C.cyan}╚${'═'.repeat(58)}╝${C.reset}\n`);

      const ts = Date.now();
      const results = await Promise.all(
        runnable.map((s, idx) =>
          runScriptAsync(s.script, PAR_PREFIX[idx] || `[${s.num}]`, s.extraEnv ? s.extraEnv() : {})
            .then(r => ({ s, ...r }))
        )
      );
      const elapsed = Date.now() - ts;
      console.log(`\n${C.bold}${C.cyan}── Parallel group complete in ${(elapsed / 1000).toFixed(1)}s ──${C.reset}\n`);

      for (const { s, ok, exitCode, logFile } of results) {
        const isSoft = !ok && s.softFail;
        stageDone(s.num, s.label, ok, elapsed);
        if (logFile) console.log(`  ${C.dim}Full log: ${path.relative(ROOT, logFile)}${C.reset}`);
        summary.push({ num: s.num, label: s.label, status: ok ? 'PASS' : (isSoft ? 'WARN' : 'FAIL'), ms: elapsed, exitCode });
        if (!ok && !isSoft) { console.error(`\n${C.red}  Pipeline halted at Stage ${s.num} (exit ${exitCode}).${C.reset}\n`); halted = true; }
      }
      continue;
    }

    // ── Sequential stage ──────────────────────────────────────────────────
    const skipped = stage.skip();
    stageHeader(stage.num, total, stage.label, skipped);
    if (!skipped && stage.desc) console.log(`  ${C.dim}${stage.desc}${C.reset}\n`);

    if (skipped) {
      console.log(`  ${C.yellow}↷ Skipped${C.reset}  ${C.dim}${stage.skipMsg || ''}${C.reset}\n`);
      summary.push({ num: stage.num, label: stage.label, status: 'SKIPPED', ms: 0 });
      si++; continue;
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
      halted = true;
    }
    si++;
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
