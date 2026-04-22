'use strict';
/**
 * @deprecated Use `node scripts/run-full-pipeline.js --use-runner --include-perf --include-security`
 *             (preset: full) — the consolidated runner in `src/pipeline/runner.js`.
 *             This script is kept for backward compatibility and will be removed in a future release.
 *
 * run-e2e.js  —  Complete End-to-End QA Run
 * ─────────────────────────────────────────────────────────────────────────────
 * Single-command, zero-config entry point for the full 3-pillar QA journey:
 *
 *   Functional  → Performance  → Security
 *
 *  ┌─────────────────────────────────────────────────────────────────────────┐
 *  │  Phase A  — PREPARE                                                     │
 *  │   Stage 1  Ensure all output directories exist                          │
 *  │   Stage 2  Analyse Jira story → AI test plan → create Zephyr TCs       │
 *  │   Stage 3  Generate Playwright spec files from Zephyr TCs               │
 *  │   Stage 4  Generate k6 performance scripts                              │
 *  │   Stage 5  Generate OWASP ZAP + custom security scan config             │
 *  │                                                                         │
 *  │  Phase B  — EXECUTE                                                     │
 *  │   Stage 6  Run Playwright functional tests → sync Zephyr / Jira        │
 *  │   Stage 7  Self-Healing Agent → repair failing specs + re-run          │
 *  │   Stage 8  Auto-create Jira bugs for remaining failures                 │
 *  │   Stage 9  Run k6 performance tests → evaluate SLAs → sync Zephyr     │
 *  │   Stage 10 Start ZAP → run security scans → evaluate findings          │
 *  │                                                                         │
 *  │  Phase C  — REPORT                                                      │
 *  │   Stage 11 Generate functional HTML report                              │
 *  │   Stage 12 Generate performance HTML report (Chart.js)                  │
 *  │   Stage 13 Generate security HTML report   (Chart.js)                   │ *  │   Stage 13b Generate pentest HTML report                                │ *  │   Stage 14 Generate Allure interactive report                           │
 *  │   Stage 15 Git Agent — auto-commit + push all outputs                  │
 *  └─────────────────────────────────────────────────────────────────────────┘
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/run-e2e.js                        ← full e2e (all 3 pillars)
 *   node scripts/run-e2e.js --headless             ← CI / headless browser
 *   node scripts/run-e2e.js --skip-pentest        ← skip pentest pillar
 *   node scripts/run-e2e.js --skip-perf            ← skip performance pillar
 *   node scripts/run-e2e.js --skip-security        ← skip security pillar
 *   node scripts/run-e2e.js --no-zap               ← custom checks only (no ZAP)
 *   node scripts/run-e2e.js --skip-story           ← skip story analysis (TCs exist)
 *   node scripts/run-e2e.js --skip-heal            ← skip reactive self-healer
 *   node scripts/run-e2e.js --skip-smart-heal       ← skip proactive smart-healer
 *   node scripts/run-e2e.js --skip-bugs            ← skip Jira bug creation
 *   node scripts/run-e2e.js --skip-git             ← skip git auto-commit + push
 *   node scripts/run-e2e.js --force                ← recreate Zephyr TCs
 *
 * All configuration is read from .env  (ISSUE_KEY, JIRA_*, ZEPHYR_*, ZAP_*)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT  = path.resolve(__dirname, '..');
const args  = process.argv.slice(2);
const flags = new Set(args.map(a => a.toLowerCase()));

// ─── Flags ────────────────────────────────────────────────────────────────────
const useHeadless    = flags.has('--headless')    || process.env.PW_HEADLESS === 'true';
const useForce       = flags.has('--force');
const skipStory      = flags.has('--skip-story');
const skipPerf       = flags.has('--skip-perf');
const skipSecurity   = flags.has('--skip-security');
const skipPentest    = flags.has('--skip-pentest');
const noZap          = flags.has('--no-zap');
const skipHeal       = flags.has('--skip-heal');
const skipSmartHeal  = flags.has('--skip-smart-heal');
const skipBugs       = flags.has('--skip-bugs');
const skipGit        = flags.has('--skip-git');

// ─── ANSI colours ────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',  bold:  '\x1b[1m',  dim:    '\x1b[2m',
  green:  '\x1b[32m', yellow:'\x1b[33m', red:    '\x1b[31m',
  cyan:   '\x1b[36m', blue:  '\x1b[34m', white:  '\x1b[97m',
  purple: '\x1b[35m', orange:'\x1b[38;5;214m',
};

// ─── Helpers ──────────────────────────────────────────────────────────────────
function now()      { return new Date().toLocaleTimeString('en-GB', { hour12: false }); }
function elapsed(t) { return ((Date.now() - t) / 1000).toFixed(1); }

function banner() {
  const W = 70;
  const B = '═'.repeat(W);
  const pad = s => s + ' '.repeat(Math.max(0, W - s.length - 1));
  const row = (s, colour = C.reset) => `${C.bold}${C.purple}║  ${colour}${pad(s)}${C.reset}${C.bold}${C.purple}║${C.reset}`;

  console.log(`\n${C.bold}${C.purple}╔${B}╗${C.reset}`);
  console.log(row('Agentic QA Platform  —  Complete End-to-End Run', C.white));
  console.log(row(''));
  console.log(row('  Phase A: Prepare  →  Phase B: Execute  →  Phase C: Report', C.dim));
  console.log(row(`  Pillars: Functional  +  ${skipPerf ? C.dim + '(Perf skipped)' : C.cyan + 'Performance'}${C.reset}${C.bold}${C.purple}  +  ${skipSecurity ? C.dim + '(Security skipped)' : C.orange + 'Security'}${C.reset}${C.bold}${C.purple}  +  ${skipPentest ? C.dim + '(Pentest skipped)' : C.red + 'Pentest'}`, ''));
  console.log(row(`  Healing: Proactive (smart-healer)  +  Reactive (healer)${skipSmartHeal ? C.dim + '  [--skip-smart-heal]' : ''}`, C.dim));
  console.log(row(''));
  console.log(row(`  Story  : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`, C.white));
  console.log(row(`  Mode   : ${useHeadless ? 'Headless (CI)' : 'Headed — visible browser'}`, C.white));
  console.log(row(`  Time   : ${now()}`, C.dim));
  console.log(`${C.bold}${C.purple}╚${B}╝${C.reset}\n`);
}

/**
 * Run a child script and return { ok, exitCode, ms }.
 * Prints the script's output live (stdio: inherit).
 */
function runScript(relPath, extraEnv = {}, extraArgs = []) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  [E2E] Script not found: ${relPath}${C.reset}`);
    return { ok: false, exitCode: 1, ms: 0 };
  }
  const ts = Date.now();
  const r  = spawnSync('node', [abs, ...extraArgs], {
    cwd:   ROOT,
    stdio: 'inherit',
    env:   { ...process.env, ...extraEnv },
  });
  const exitCode = r.status ?? (r.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode, ms: Date.now() - ts };
}

function phaseHeader(label, colour = C.cyan) {
  const line = '─'.repeat(70);
  console.log(`\n${C.bold}${colour}┌${line}┐${C.reset}`);
  console.log(`${C.bold}${colour}│  ${label.padEnd(69)}│${C.reset}`);
  console.log(`${C.bold}${colour}└${line}┘${C.reset}\n`);
}

function stageHeader(num, label, skipped = false) {
  const tag = skipped ? `${C.yellow}SKIP${C.reset}` : `${C.cyan}RUN${C.reset}`;
  const ts  = `${C.dim}[${now()}]${C.reset}`;
  console.log(`\n${C.bold}${C.white}Stage ${String(num).padEnd(3)} — ${label}${C.reset}  ${tag}  ${ts}`);
  console.log(`${C.dim}${'─'.repeat(65)}${C.reset}`);
}

function stageDone(num, label, ok, ms) {
  const icon = ok ? `${C.green}✓${C.reset}` : `${C.yellow}⚠${C.reset}`;
  console.log(`${icon} ${C.bold}Stage ${num} ${ok ? C.green + 'DONE' : C.yellow + 'WARN'} (${ms / 1000 | 0}s)${C.reset}  ${C.dim}${label}${C.reset}`);
}

// ─── Stage definitions ────────────────────────────────────────────────────────
// Each stage:  { num, label, phase, script, skip, softFail, extraEnv, extraArgs }
const STAGES = [
  // ── PHASE A: PREPARE ───────────────────────────────────────────────────────
  {
    num: 1, label: 'Ensure output directories',
    phase: 'A',
    script: null,          // inline — no child process needed
    skip: () => false,
    softFail: true,
  },
  {
    num: 2, label: 'Analyse story → AI test plan → create Zephyr TCs',
    phase: 'A',
    script: 'scripts/run-story.js',
    skip: () => skipStory,
    skipMsg: 'Story analysis skipped  (--skip-story)',
    softFail: false,
    extraEnv: () => useForce ? { FORCE_CREATE: 'true' } : {},
  },
  {
    num: 3, label: 'Generate Playwright spec files from Zephyr TCs',
    phase: 'A',
    script: 'scripts/generate-playwright.js',
    skip: () => false,
    softFail: false,
  },
  {
    num: 4, label: 'Generate k6 performance scripts',
    phase: 'A',
    script: 'scripts/generate-perf-scripts.js',
    skip: () => skipPerf,
    skipMsg: 'Perf script generation skipped  (--skip-perf)',
    softFail: true,
  },
  {
    num: 5, label: 'Generate security scan config',
    phase: 'A',
    script: 'scripts/generate-sec-scripts.js',
    skip: () => skipSecurity,
    skipMsg: 'Security config generation skipped  (--skip-security)',
    softFail: true,
  },
  {
    num: '5b', label: 'Smart Proactive Healing — patch selectors from git diff',
    phase: 'A',
    script: 'scripts/smart-healer.js',
    skip: () => skipSmartHeal,
    skipMsg: 'Smart proactive healing skipped  (--skip-smart-heal)',
    softFail: true,
    extraArgs: () => ['--skip-zephyr'],
  },

  // ── PHASE B: EXECUTE ───────────────────────────────────────────────────────
  {
    num: 6, label: `Run Playwright functional tests [${useHeadless ? 'HEADLESS' : 'HEADED'}] → sync Zephyr`,
    phase: 'B',
    script: 'scripts/run-and-sync.js',
    skip: () => false,
    softFail: true,   // test failures must not halt the full pipeline
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false' }),
  },
  {
    num: 7, label: 'Self-Healing Agent → repair failures + re-run',
    phase: 'B',
    script: 'scripts/healer.js',
    skip: () => skipHeal,
    skipMsg: 'Self-healer skipped  (--skip-heal)',
    softFail: true,
    extraEnv: () => ({ PW_HEADLESS: useHeadless ? 'true' : 'false', HEALER_SKIP_RUN: 'true' }),
  },
  {
    num: 8, label: 'Auto-create Jira bugs for remaining failures',
    phase: 'B',
    script: 'scripts/create-jira-bugs.js',
    skip: () => skipBugs,
    skipMsg: 'Bug creation skipped  (--skip-bugs)',
    softFail: true,
  },
  {
    num: 9, label: 'Run k6 performance tests → evaluate SLAs → sync Zephyr',
    phase: 'B',
    script: 'scripts/run-perf.js',
    skip: () => skipPerf,
    skipMsg: 'Performance testing skipped  (--skip-perf)',
    softFail: true,
    extraArgs: () => ['--skip-report', '--skip-git'],
  },
  {
    num: 10, label: 'Run OWASP ZAP + custom security scans → evaluate findings',
    phase: 'B',
    script: 'scripts/run-security.js',
    skip: () => skipSecurity,
    skipMsg: 'Security testing skipped  (--skip-security)',
    softFail: true,
    extraArgs: () => [
      '--skip-report', '--skip-git', '--skip-pentest',
      ...(noZap ? ['--no-zap'] : []),
    ],
  },
  {
    num: '10b', label: 'Run penetration tests (Nuclei · SQLMap · ffuf · ZAP-Auth)',
    phase: 'B',
    script: 'scripts/run-pentest.js',
    skip: () => skipPentest || process.env.PENTEST_ENABLED !== 'true',
    skipMsg: process.env.PENTEST_ENABLED !== 'true'
      ? 'Pentest skipped  (set PENTEST_ENABLED=true in .env)'
      : 'Pentest skipped  (--skip-pentest)',
    softFail: true,
    extraArgs: () => ['--skip-report', '--skip-git', '--skip-sync', '--no-pause'],
  },

  // ── PHASE C: REPORT ────────────────────────────────────────────────────────
  {
    num: 11, label: 'Generate functional HTML report',
    phase: 'C',
    script: 'scripts/generate-report.js',
    skip: () => false,
    softFail: true,
  },
  {
    num: 12, label: 'Generate performance HTML report (Chart.js)',
    phase: 'C',
    script: 'scripts/generate-perf-report.js',
    skip: () => skipPerf,
    skipMsg: 'Perf report skipped  (--skip-perf)',
    softFail: true,
  },
  {
    num: 13, label: 'Generate security HTML report (Chart.js)',
    phase: 'C',
    script: 'scripts/generate-sec-report.js',
    skip: () => skipSecurity,
    skipMsg: 'Security report skipped  (--skip-security)',
    softFail: true,
  },
  {
    num: '13b', label: 'Generate pentest HTML report',
    phase: 'C',
    script: 'scripts/generate-pentest-report.js',
    skip: () => skipPentest || process.env.PENTEST_ENABLED !== 'true',
    skipMsg: 'Pentest report skipped  (--skip-pentest / PENTEST_ENABLED not true)',
    softFail: true,
  },
  {
    num: 14, label: 'Generate Allure interactive report',
    phase: 'C',
    script: 'scripts/generate-allure-report.js',
    skip: () => false,
    softFail: true,
  },
  {
    num: 15, label: 'Git Agent — auto-commit + push all outputs',
    phase: 'C',
    script: 'scripts/git-sync.js',
    skip: () => skipGit,
    skipMsg: 'Git sync skipped  (--skip-git)',
    softFail: true,
  },
];

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  const t0 = Date.now();
  banner();

  const summary = [];
  let lastPhase = '';

  for (const stage of STAGES) {
    // Print phase header when phase changes
    if (stage.phase !== lastPhase) {
      const phaseLabels = {
        A: 'PHASE A — PREPARE  (generate scripts & configs)',
        B: 'PHASE B — EXECUTE  (run tests across all 3 pillars)',
        C: 'PHASE C — REPORT   (generate & publish all reports)',
      };
      const phaseColours = { A: C.blue, B: C.orange, C: C.purple };
      phaseHeader(phaseLabels[stage.phase], phaseColours[stage.phase]);
      lastPhase = stage.phase;
    }

    const skipped = stage.skip();
    stageHeader(stage.num, stage.label, skipped);

    if (skipped) {
      console.log(`  ${C.yellow}↷ ${stage.skipMsg || 'Skipped'}${C.reset}\n`);
      summary.push({ num: stage.num, label: stage.label, phase: stage.phase, status: 'SKIPPED', ms: 0 });
      continue;
    }

    // Stage 1 is inline (no child script)
    if (stage.num === 1) {
      const ts = Date.now();
      try {
        require('./ensure-dirs').ensureDirs();
        const ms = Date.now() - ts;
        console.log(`  ${C.green}✓ Directories ready${C.reset}`);
        stageDone(stage.num, stage.label, true, ms);
        summary.push({ num: stage.num, label: stage.label, phase: stage.phase, status: 'PASS', ms });
      } catch (err) {
        const ms = Date.now() - ts;
        console.error(`  ${C.yellow}⚠ ensure-dirs warning: ${err.message}${C.reset}`);
        stageDone(stage.num, stage.label, false, ms);
        summary.push({ num: stage.num, label: stage.label, phase: stage.phase, status: 'WARN', ms });
      }
      continue;
    }

    const extraEnv  = stage.extraEnv  ? stage.extraEnv()  : {};
    const extraArgs = stage.extraArgs ? stage.extraArgs() : [];
    const { ok, exitCode, ms } = runScript(stage.script, extraEnv, extraArgs);

    stageDone(stage.num, stage.label, ok, ms);

    const status = ok ? 'PASS' : (stage.softFail ? 'WARN' : 'FAIL');
    summary.push({ num: stage.num, label: stage.label, phase: stage.phase, status, ms, exitCode });

    if (!ok && !stage.softFail) {
      console.error(`\n${C.red}${C.bold}  Pipeline halted at Stage ${stage.num} (exit ${exitCode}).${C.reset}\n`);
      printSummary(summary, t0);
      process.exit(1);
    }
  }

  printSummary(summary, t0);

  const overallFail = summary.some(s => s.status === 'FAIL');
  process.exit(overallFail ? 1 : 0);
}

// ─── Summary table ────────────────────────────────────────────────────────────
function printSummary(summary, t0) {
  const totalSec = elapsed(t0);

  const phaseColour = { A: C.blue, B: C.orange, C: C.purple };
  let lastPhase = '';

  console.log(`\n${C.bold}${C.white}╔══ End-to-End Run Summary ${'═'.repeat(46)}╗${C.reset}`);

  for (const s of summary) {
    if (s.phase !== lastPhase) {
      const phaseLabel = { A: 'PHASE A — PREPARE', B: 'PHASE B — EXECUTE', C: 'PHASE C — REPORT' };
      console.log(`${C.bold}${phaseColour[s.phase]}╟── ${phaseLabel[s.phase]} ${'─'.repeat(50 - phaseLabel[s.phase].length)}╢${C.reset}`);
      lastPhase = s.phase;
    }

    const icon = s.status === 'PASS'    ? `${C.green}✓ PASS   ${C.reset}`
               : s.status === 'WARN'    ? `${C.yellow}⚠ WARN   ${C.reset}`
               : s.status === 'SKIPPED' ? `${C.dim}↷ SKIPPED${C.reset}`
               :                          `${C.red}✗ FAIL   ${C.reset}`;

    const dur = s.status === 'SKIPPED' ? '     ' : `${(s.ms / 1000).toFixed(1)}s`.padStart(5);
    console.log(`${C.bold}║${C.reset}  Stage ${String(s.num).padEnd(3)} ${icon}  ${dur}  ${C.dim}${s.label}${C.reset}`);
  }

  const passCount    = summary.filter(s => s.status === 'PASS').length;
  const warnCount    = summary.filter(s => s.status === 'WARN').length;
  const failCount    = summary.filter(s => s.status === 'FAIL').length;
  const skippedCount = summary.filter(s => s.status === 'SKIPPED').length;
  const overall      = failCount > 0 ? `${C.red}FAIL` : warnCount > 0 ? `${C.yellow}WARN` : `${C.green}PASS`;

  console.log(`${C.bold}${C.white}╠${'═'.repeat(72)}╣${C.reset}`);
  console.log(`${C.bold}║${C.reset}  Pass: ${C.green}${passCount}${C.reset}  Warn: ${C.yellow}${warnCount}${C.reset}  Fail: ${C.red}${failCount}${C.reset}  Skipped: ${C.dim}${skippedCount}${C.reset}  Total time: ${C.white}${totalSec}s${C.reset}`);
  console.log(`${C.bold}║${C.reset}  Overall: ${C.bold}${overall}${C.reset}`);
  console.log(`${C.bold}${C.white}╚${'═'.repeat(72)}╝${C.reset}\n`);

  // Output file locations
  const outputs = [
    ['custom-report/index.html',          '📄  Functional Report'],
    ['custom-report/perf/index.html',     '📈  Performance Report'],
    ['custom-report/security/index.html', '🛡️   Security Report'],
    ['custom-report/pentest/index.html',  '🔐  Pentest Report'],
    ['allure-report/index.html',          '📊  Allure Report'],
  ];
  let hasOutputs = false;
  for (const [rel, label] of outputs) {
    if (fs.existsSync(path.join(ROOT, rel))) {
      if (!hasOutputs) { console.log(`  ${C.bold}Reports:${C.reset}`); hasOutputs = true; }
      console.log(`  ${C.cyan}${label} : ${rel}${C.reset}`);
    }
  }
  if (hasOutputs) console.log();
}

main().catch(err => {
  console.error(`\n${C.red}${C.bold}FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
