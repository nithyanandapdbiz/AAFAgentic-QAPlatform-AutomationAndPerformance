'use strict';
/**
 * @deprecated Use `node scripts/run-full-pipeline.js --use-runner` (preset: functional)
 *             or call `require('../src/pipeline/runner').runPipeline(PRESETS.functional, ctx)` directly.
 *             This script is kept for backward compatibility with existing automation and will be
 *             removed in a future major release.
 *
 * qa-run.js  —  Single-command, zero-prompt, end-to-end QA pipeline
 * ─────────────────────────────────────────────────────────────────────────────
 * Runs nine pipeline stages in sequence with no human input:
 *
 *   Stage 1   Fetch Jira story → create DETAILED Zephyr test cases
 *             • Design techniques applied (BVA, EP, DT, ST, EG, UC)
 *             • Concrete test data included in every test case step
 *
 *   Stage 2   Generate Playwright spec files from Zephyr test cases
 *
 *   Stage 3   Run Playwright tests   (HEADED / UI / browser — default)
 *             → Sync Pass/Fail results to Zephyr
 *
 *   Stage 3.5 Proactive Healer — Chromium browser probe (NEW BUILD DRIFT)
 *             • Launches headless Chromium, authenticates, visits every page
 *             • Detects broken / ambiguous locators in POM YAML files
 *             • Strategies:
 *               - locator_yaml_strict : :text() substring → 4+ matches
 *               - locator_yaml_drift  : :text-is() exact  → 0 matches
 *               (label renamed in new app build)
 *             • Rewrites YAML atomically with key-derived correct labels
 *             • Updates Zephyr step descriptions + patches spec files
 *             • Runs BEFORE Stage 4 so the self-healer sees clean locators
 *
 *   Stage 4   Self-Healing Agent
 *             • Reads failing tests from test-results.json
 *             • Applies automated repair patches:
 *               - timeout, strict_mode, not_visible, navigation, selector
 *               - locator_yaml_strict (multi-match :text → :text-is)
 *               - locator_yaml_drift  (drifted label → key-derived label)
 *             • Re-runs only the healed specs to confirm fixes
 *
 *   Stage 5   Auto-Create Jira Bugs
 *             • Creates a Jira bug for every remaining failing test
 *             • Links each bug to the parent user story (ISSUE_KEY)
 *
 *   Stage 6   Generate custom HTML report with screenshots
 *
 *   Stage 7   Generate Allure report (interactive drill-down)
 *
 *   Stage 8   Git Agent — auto-commit + push all changes
 *
 * ─── Usage ───────────────────────────────────────────────────────────────────
 *   node scripts/qa-run.js                    ← full pipeline (all stages)
 *   node scripts/qa-run.js --skip-story       ← skip stage 1 (use existing Zephyr TCs)
 *   node scripts/qa-run.js --skip-generate    ← skip stages 1+2
 *   node scripts/qa-run.js --run-only         ← stages 3+ only
 *   node scripts/qa-run.js --force            ← force-recreate Zephyr test cases (stage 1)
 *   node scripts/qa-run.js --skip-proactive   ← skip stage 3.5 (proactive healer)
 *   node scripts/qa-run.js --skip-heal        ← skip stage 4 (self-healer)
 *   node scripts/qa-run.js --skip-bugs        ← skip stage 5 (bug creation)
 *   node scripts/qa-run.js --skip-git         ← skip stage 8 (git auto-commit + push)
 *   node scripts/qa-run.js --headless         ← run browser in headless CI mode
 *
 * Stage 1 dedup:  If test cases already exist in Zephyr for this story they are
 * skipped automatically. Use --force to delete and recreate them.
 *
 * All configuration is read from .env — no prompts, ever.
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { spawnSync } = require('child_process');
const fs            = require('fs');
const path          = require('path');

const ROOT   = path.resolve(__dirname, '..');
const args   = process.argv.slice(2);
const flags  = new Set(args.map(a => a.toLowerCase()));

// ─── Force-recreate flag ───────────────────────────────────────────────────
// Pass --force to make Stage 1 delete and recreate all Zephyr test cases
// even when they already exist (useful after story changes).
const useForce = flags.has('--force');

// ─── Include-perf flag ────────────────────────────────────────────────────
// Pass --include-perf to run k6 performance tests after Playwright execution.
const useIncludePerf = flags.has('--include-perf');

// ─── Include-security flag ────────────────────────────────────────────────
// Pass --include-security to run OWASP ZAP + custom security checks after Playwright.
const useIncludeSecurity = flags.has('--include-security');
const useNoZap           = flags.has('--no-zap');

// ─── Proactive healer flag ─────────────────────────────────────────────────
// Stage 3.5: probe every POM YAML page with a real Chromium browser, detect
// broken / multi-match locators (drift from new application build), and patch
// the YAML files before the self-healing Stage 4 runs.
// Skip with --skip-proactive when the AUT is unreachable or for fast-ci runs.
const skipProactive = flags.has('--skip-proactive');

// ─── Headed / headless mode ────────────────────────────────────────────────
// Default: HEADED (PW_HEADLESS=false) for full UI/browser visibility.
// Pass --headless flag or set PW_HEADLESS=true in .env to run without a UI.
const useHeadless = flags.has('--headless') || process.env.PW_HEADLESS === 'true';

// ─── ANSI ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  white:  '\x1b[97m',
};

// ─── Helpers ───────────────────────────────────────────────────────────────
function now() {
  return new Date().toLocaleTimeString('en-GB', { hour12: false });
}

function box(lines, colour = C.blue) {
  const width  = 54;
  const border = '═'.repeat(width);
  console.log(`\n${C.bold}${colour}╔${border}╗${C.reset}`);
  for (const line of lines) {
    const pad = ' '.repeat(Math.max(0, width - line.length - 1));
    console.log(`${C.bold}${colour}║  ${C.reset}${line}${pad}${C.bold}${colour}║${C.reset}`);
  }
  console.log(`${C.bold}${colour}╚${border}╝${C.reset}\n`);
}

function stageHeader(num, label, skipped = false) {
  const status = skipped ? `${C.yellow}SKIPPED${C.reset}` : `${C.cyan}RUNNING${C.reset}`;
  console.log(`\n${C.bold}${C.white}┌─ Stage ${num} ─ ${label}${C.reset}  ${status}`);
  console.log(`${C.dim}│  [${now()}]${C.reset}`);
  console.log(`${C.bold}${C.white}└${'─'.repeat(52)}${C.reset}\n`);
}

function stageDone(num, label, ok, durationMs) {
  const icon   = ok ? `${C.green}✓${C.reset}` : `${C.red}✗${C.reset}`;
  const colour = ok ? C.green : C.red;
  const dur    = (durationMs / 1000).toFixed(1);
  console.log(`\n${icon} ${C.bold}${colour}Stage ${num} — ${label}${C.reset}  (${dur}s)\n`);
}

// ─── Run one Node script ───────────────────────────────────────────────────
function runScript(relPath, extraEnv = {}) {
  const abs = path.join(ROOT, relPath);
  if (!fs.existsSync(abs)) {
    console.error(`${C.red}  Script not found: ${relPath}${C.reset}`);
    return { ok: false, exitCode: 1 };
  }
  const result = spawnSync('node', [abs], {
    cwd:   ROOT,
    stdio: 'inherit',
    env:   { ...process.env, ...extraEnv }
  });
  const exitCode = result.status ?? (result.error ? 1 : 0);
  return { ok: exitCode === 0, exitCode };
}

// ─── Pipeline definition ───────────────────────────────────────────────────
const STAGES = [
  {
    num:     1,
    label:   'Fetch Jira story → create detailed Zephyr test cases',
    desc:    'Planner applies design techniques (BVA, EP, DT, ST, EG, UC) with concrete test data',
    script:  'scripts/run-story.js',
    skip:    () => flags.has('--skip-story') || flags.has('--skip-generate') || flags.has('--run-only'),
    skipMsg: 'Using existing Zephyr test cases',
    softFail: false,
    extraEnv: () => useForce ? { FORCE_CREATE: 'true' } : {}
  },
  {
    num:     2,
    label:   'Generate Playwright spec files from Zephyr',
    desc:    'Converts Zephyr test cases into executable Playwright specs',
    script:  'scripts/generate-playwright.js',
    skip:    () => flags.has('--skip-generate') || flags.has('--run-only'),
    skipMsg: 'Using existing spec files',
    softFail: false
  },
  {
    num:     3,
    label:   `Run Playwright tests [${useHeadless ? 'HEADLESS' : 'HEADED / UI / browser'}] → sync to Zephyr`,
    desc:    `Browser UI mode: ${useHeadless ? 'headless (CI)' : 'headed (visible browser)'}. Results synced to Zephyr.`,
    script:  'scripts/run-and-sync.js',
    skip:    () => false,
    skipMsg: '',
    softFail: true,   // test failures are expected; don't halt pipeline
    extraEnv: () => ({
      PW_HEADLESS: useHeadless ? 'true' : 'false'
    })
  },
  {
    num:     4,
    label:   'Self-Healing Agent → repair & re-run failing tests',
    desc:    'Strategies: timeout · strict_mode · not_visible · navigation · locator_yaml_strict · locator_yaml_drift',
    script:  'scripts/healer.js',
    skip:    () => flags.has('--skip-heal'),
    skipMsg: 'Healer skipped (pass --skip-heal to always skip)',
    softFail: true,   // partial heal is acceptable
    extraEnv: () => ({
      PW_HEADLESS: useHeadless ? 'true' : 'false',
      HEALER_SKIP_RUN: 'false',
    })
  },
  {
    num:     5,
    label:   'Auto-Create Jira Bugs for remaining failures',
    desc:    `Creates Jira bugs for every failing test, linked to parent story ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`,
    script:  'scripts/create-jira-bugs.js',
    skip:    () => flags.has('--skip-bugs'),
    skipMsg: 'Bug creation skipped (pass --skip-bugs to always skip)',
    softFail: true    // bug-creation failure is non-fatal
  },
  {
    num:     6,
    label:   'Generate custom HTML report',
    desc:    'Builds the interactive HTML report with screenshots and test results',
    script:  'scripts/generate-report.js',
    skip:    () => false,
    skipMsg: '',
    softFail: false
  },
  {
    num:     7,
    label:   'Generate Allure report',
    desc:    'Converts allure-results/ into a rich interactive Allure HTML report',
    script:  'scripts/generate-allure-report.js',
    skip:    () => false,
    softFail: true   // non-critical — missing allure-results/ prints a warning and continues
  },
  {
    num:     8,
    label:   'Git Agent — auto-commit + push all changes',
    desc:    'Stages all modified files (specs, results, reports), commits, and pushes to current branch',
    script:  'scripts/git-sync.js',
    skip:    () => flags.has('--skip-git'),
    skipMsg: 'Git sync skipped (pass --skip-git to always skip)',
    softFail: true   // non-critical — push failure should not halt pipeline
  }
];

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  const totalStart = Date.now();

  box([
    'Agentic QA Platform  —  End-to-End Pipeline',
    '',
    'Fully autonomous. No prompts. No manual steps.',
    '',
    `  Mode       : ${useHeadless ? 'Headless (CI)' : 'Headed — UI / Browser (default)'}`,
    `  Flags      : ${args.length ? args.join('  ') : '(none — all stages)'}`,
    `  Issue      : ${process.env.ISSUE_KEY || '(set ISSUE_KEY in .env)'}`,
    `  Force      : ${useForce ? 'YES — will recreate Zephyr test cases' : 'No (dedup active)'}`,
    `  Proactive  : ${skipProactive ? 'SKIPPED (--skip-proactive)' : 'ON — Chromium locator probe'}`,
    `  Time       : ${now()}`,
    '',
    '  Stage 1    Detailed test cases  (BVA/EP/DT/ST/EG/UC + test data)',
    '  Stage 2    Generate Playwright specs',
    `  Stage 3    Run tests  [${useHeadless ? 'headless' : 'headed/UI/browser'}]  + sync Zephyr`,
    '  Stage 3.5  Proactive Healer  →  Chromium probe + YAML locator repair',
    '  Stage 4    Self-Healing Agent  →  auto-repair failures',
    '  Stage 5    Auto-create Jira bugs  →  linked to parent story',
    '  Stage 6    Generate HTML report',
    '  Stage 7    Generate Allure report',
    '  Stage 8    Git Agent  →  auto-commit + push',
  ], C.blue);

  const summary = [];

  for (const stage of STAGES) {
    const skipped = stage.skip();

    stageHeader(stage.num, stage.label, skipped);

    if (!skipped && stage.desc) {
      console.log(`  ${C.dim}${stage.desc}${C.reset}\n`);
    }

    if (skipped) {
      console.log(`  ${C.yellow}↷  Skipped${C.reset}  ${C.dim}${stage.skipMsg}${C.reset}\n`);
      summary.push({ num: stage.num, label: stage.label, status: 'SKIPPED', dur: 0 });
      continue;
    }

    const extraEnv = stage.extraEnv ? stage.extraEnv() : {};
    const t0 = Date.now();
    const { ok, exitCode } = runScript(stage.script, extraEnv);
    const dur = Date.now() - t0;

    stageDone(stage.num, stage.label, ok, dur);

    const isSoftFailure = !ok && stage.softFail;
    summary.push({
      num:    stage.num,
      label:  stage.label,
      status: ok ? 'PASS' : (isSoftFailure ? 'WARN' : 'FAIL'),
      dur,
      exitCode
    });

    if (!ok && !isSoftFailure) {
      console.error(`\n${C.red}  Pipeline halted at Stage ${stage.num} (exit ${exitCode}).${C.reset}\n`);
      break;
    }

    // ── Stage 3.5 — Proactive Healer (after Playwright run, before self-healer) ──
    // Launches a headless Chromium browser, visits every POM page, probes each
    // locator, and patches the YAML files for any broken or drifted selector.
    // This prevents the self-healer from seeing locator-related failures that
    // can be fixed without spec changes.
    if (stage.num === 3 && !skipProactive) {
      const t35 = Date.now();
      stageHeader('3.5', 'Proactive Healer — Chromium locator probe + YAML repair');
      console.log(`  ${C.dim}Strategies: locator_yaml_strict (multi-match) · locator_yaml_drift (label renamed)${C.reset}\n`);
      const ph = require('child_process').spawnSync(
        'node',
        [
          path.join(ROOT, 'scripts', 'proactive-healer.js'),
          '--standalone',
          '--skip-zephyr',
          '--skip-specs',
          '--skip-run',
          ...(useHeadless ? [] : []),   // proactive healer always runs headless
        ],
        { cwd: ROOT, stdio: 'inherit', env: { ...process.env } }
      );
      const ph35ok = (ph.status ?? 1) === 0;
      stageDone('3.5', 'Proactive Healer — Chromium locator probe + YAML repair', ph35ok, Date.now() - t35);
      summary.push({
        num: '3.5', label: 'Proactive Healer — YAML locator repair',
        status: ph35ok ? 'PASS' : 'WARN',   // non-fatal: AUT may be unreachable
        dur: Date.now() - t35,
      });
    }

    // ── Stage 3b — generate k6 perf scripts (after Playwright spec generation) ──
    if (stage.num === 2 && useIncludePerf) {
      const storyKey = process.env.ISSUE_KEY || '';
      const baseUrl  = process.env.BASE_URL  || 'https://opensource-demo.orangehrmlive.com';
      console.log(`\n${C.cyan}  Stage 3b — generating k6 performance scripts${C.reset}`);
      try {
        await require('./generate-perf-scripts').run({ storyKey, baseUrl });
      } catch (e) {
        console.error(`  ${C.yellow}Stage 3b non-fatal error: ${e.message}${C.reset}`);
      }
    }

    // ── Stage 4b + 5b — execute k6, evaluate, sync (after Playwright execution) ──
    if (stage.num === 3 && useIncludePerf) {
      console.log(`\n${C.cyan}  Stage 4b — executing k6 performance tests${C.reset}`);
      try {
        const perfResults = await require('../src/services/perf.execution.service')
          .runAll({ storyKey: process.env.ISSUE_KEY, testResultsDir: 'test-results/perf' });
        console.log(`\n${C.cyan}  Stage 5b — evaluating perf thresholds and syncing to Zephyr/Jira${C.reset}`);
        await require('../src/services/perf.execution.service')
          .syncResults(perfResults, { skipBugs: flags.has('--skip-bugs') });
      } catch (e) {
        console.error(`  ${C.yellow}Stage 4b/5b non-fatal error: ${e.message}${C.reset}`);
      }
    }

    // ── Stage 3c — generate security scan config (after Playwright spec generation) ──
    if (stage.num === 2 && useIncludeSecurity) {
      const storyKey = process.env.ISSUE_KEY || '';
      const baseUrl  = process.env.BASE_URL  || 'https://opensource-demo.orangehrmlive.com';
      console.log(`\n${C.cyan}  Stage 3c — generating security scan config${C.reset}`);
      try {
        await require('./generate-sec-scripts').run({ storyKey, baseUrl });
      } catch (e) {
        console.error(`  ${C.yellow}Stage 3c non-fatal error: ${e.message}${C.reset}`);
      }
    }

    // ── Stage 4c + 5c — execute ZAP + custom checks, sync (after Playwright execution) ──
    if (stage.num === 3 && useIncludeSecurity) {
      const storyKey  = process.env.ISSUE_KEY || '';
      const targetUrl = process.env.BASE_URL  || 'https://opensource-demo.orangehrmlive.com';
      console.log(`\n${C.cyan}  Stage 4c — running OWASP ZAP + custom security checks${C.reset}`);
      try {
        const secService   = require('../src/services/sec.execution.service');
        let zapStarted     = false;
        let zapReportPath  = null;
        const ALL_CHECKS   = [
          'missing-security-headers', 'insecure-cookie-flags', 'session-fixation',
          'open-redirect', 'sensitive-data-in-response', 'csrf-token-absence',
          'idor-employee-id', 'sql-injection-signal', 'xss-reflection-signal',
          'broken-auth-brute-force',
        ];

        if (!useNoZap) {
          try {
            const z = await secService.startZap({});
            zapStarted = z.started;
          } catch (e2) {
            console.error(`  ${C.yellow}ZAP start non-fatal: ${e2.message}${C.reset}`);
          }
        }

        if (!useNoZap && zapStarted) {
          try {
            zapReportPath = await secService.runZapScan({
              targetUrl, scanType: process.env.ZAP_SCAN_TYPE || 'baseline',
              contextName: `${storyKey}-context`, reportFormat: 'json',
            });
          } catch (e2) {
            console.error(`  ${C.yellow}ZAP scan non-fatal: ${e2.message}${C.reset}`);
          }
        }

        const customResults = await secService.runCustomChecks(ALL_CHECKS, targetUrl, '');
        const { findings }  = secService.parseFindings(zapReportPath, customResults);
        const policy        = {
          failOn: process.env.ZAP_FAIL_ON || 'high',
          warnOn: process.env.ZAP_WARN_ON || 'medium',
          maxIssues: parseInt(process.env.ZAP_MAX_ISSUES || '0', 10),
        };
        const { verdict } = secService.evaluateSeverity(findings, policy);

        console.log(`\n${C.cyan}  Stage 5c — syncing security results to Zephyr/Jira${C.reset}`);
        if (!flags.has('--skip-bugs')) {
          await secService.syncToZephyrAndJira(findings, verdict, storyKey, {});
        }

        if (!useNoZap && zapStarted) {
          try { await secService.stopZap(); } catch { /* ignore */ }
        }
      } catch (e) {
        console.error(`  ${C.yellow}Stage 4c/5c non-fatal error: ${e.message}${C.reset}`);
      }
    }
  }

  // ── Final summary table ─────────────────────────────────────────────────
  const totalDur = ((Date.now() - totalStart) / 1000).toFixed(1);

  console.log(`${C.bold}${C.white}┌── Pipeline Summary ${'─'.repeat(35)}${C.reset}`);
  for (const s of summary) {
    let icon;
    if      (s.status === 'PASS')    icon = `${C.green}✓ PASS   ${C.reset}`;
    else if (s.status === 'WARN')    icon = `${C.yellow}⚠ WARN   ${C.reset}`;
    else if (s.status === 'SKIPPED') icon = `${C.dim}↷ SKIPPED${C.reset}`;
    else                             icon = `${C.red}✗ FAIL   ${C.reset}`;
    const dur = s.status === 'SKIPPED' ? '      ' : `${(s.dur / 1000).toFixed(1)}s`.padStart(6);
    console.log(`${C.bold}│${C.reset}  Stage ${s.num}  ${icon}  ${dur}  ${s.label}`);
  }
  console.log(`${C.bold}${C.white}└── Total: ${totalDur}s ${'─'.repeat(42)}${C.reset}\n`);

  // Report path hints
  const reportPath    = path.join(ROOT, 'custom-report', 'index.html');
  const allurePath    = path.join(ROOT, 'allure-report', 'index.html');
  if (fs.existsSync(reportPath))    console.log(`  ${C.cyan}📄  Custom Report      : custom-report/index.html${C.reset}`);
  if (fs.existsSync(allurePath))    console.log(`  ${C.cyan}📊  Allure Report      : allure-report/index.html${C.reset}`);
  console.log();

  const hasFail = summary.some(s => s.status === 'FAIL');
  process.exit(hasFail ? 1 : 0);
}

main().catch(err => {
  console.error(`\n${C.red}  FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
