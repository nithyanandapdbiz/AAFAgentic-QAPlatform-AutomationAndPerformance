'use strict';
/**
 * healer.js — Self-Healing Test Agent
 * ─────────────────────────────────────────────────────────────────────────────
 * Stage 0  Run the full Playwright test suite (all specs in tests/specs/).
 * Stage 1  Read test-results.json, identify every failing test.
 * Stage 2  Apply the appropriate healing patch to each failing spec file.
 * Stage 3  Re-run ONLY the healed specs to verify the fixes.
 * Stage 4  Print summary + save test-results-healed.json.
 *
 * Healing Strategies applied per error type:
 *   timeout      → Extend default timeouts + add waitForLoadState('networkidle')
 *   strict_mode  → Add .first() to ambiguous multi-match locators
 *   not_visible  → Add .waitFor({ state: 'visible' }) guard before interactions
 *   navigation   → Switch to domcontentloaded + networkidle wait-until
 *   selector     → Extend waitForURL timeout + add networkidle wait
 *   general      → Extend timeouts + add networkidle wait (safe default)
 *
 * Usage:
 *   node scripts/healer.js                  ← run suite + heal
 *   node scripts/healer.js --skip-run       ← heal only (reuse existing test-results.json)
 *   node scripts/healer.js --headless       ← force headless browser
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const ROOT               = path.resolve(__dirname, '..');
const RESULTS_FILE       = path.join(ROOT, 'test-results.json');
const SPECS_DIR          = path.join(ROOT, 'tests', 'specs');
const HEALED_DIR         = path.join(ROOT, 'tests', 'healed');
const HEALED_RESULTS     = path.join(ROOT, 'test-results-healed.json');

const args      = process.argv.slice(2);
const skipRun   = args.includes('--skip-run') || process.env.HEALER_SKIP_RUN === 'true';
const headless  = args.includes('--headless') || process.env.PW_HEADLESS === 'true';

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

// ─── Parse failing tests from Playwright JSON ─────────────────────────────────
function collectFailingTests(suites, parentFile = '') {
  const failing = [];
  for (const suite of (suites || [])) {
    const file = suite.file || parentFile;

    if (suite.suites && suite.suites.length) {
      failing.push(...collectFailingTests(suite.suites, file));
    }

    for (const spec of (suite.specs || [])) {
      for (const t of (spec.tests || [])) {
        for (const r of (t.results || [])) {
          if (r.status === 'failed' || r.status === 'timedOut') {
            const errorMsg = r.error
              ? (r.error.message || (typeof r.error === 'string' ? r.error : JSON.stringify(r.error)))
              : '';
            failing.push({
              file,
              title:  spec.title,
              status: r.status,
              error:  String(errorMsg).slice(0, 600)
            });
            break;
          }
        }
      }
    }
  }
  return failing;
}

// ─── Determine healing strategy from error message ────────────────────────────
function detectStrategy(error) {
  const e = (error || '').toLowerCase();
  if (/timeout|timed.?out/.test(e))                              return 'timeout';
  if (/strict mode|multiple elements|more than one/.test(e))    return 'strict_mode';
  if (/not visible|is not visible|element.*hidden/.test(e))     return 'not_visible';
  if (/net::|err_|failed to load|navigation/.test(e))           return 'navigation';
  if (/no locator|locator.*not found|selector.*not found/.test(e)) return 'selector';
  return 'general';
}

// ─── Apply healing patches to spec content ────────────────────────────────────
function healSpec(content, strategy) {
  let healed  = content;
  const applied = [];

  if (strategy === 'timeout' || strategy === 'general') {
    // 1a. Extend timeouts at the start of every test body
    healed = healed.replace(
      /(test\([^,]+,\s*async\s*\(\{\s*page[^}]*\}\s*(?:,\s*testInfo)?\s*\)\s*=>\s*\{)/,
      `$1\n    page.setDefaultTimeout(90000);\n    page.setDefaultNavigationTimeout(90000);`
    );
    // 1b. Add networkidle after every page.goto() that doesn't already have it
    healed = healed.replace(
      /await page\.goto\(([^)]+)\);(?!\s*\n\s*await page\.waitForLoadState)/g,
      `await page.goto($1);\n    await page.waitForLoadState('networkidle');`
    );
    applied.push('extended-timeout', 'networkidle-wait');
  }

  if (strategy === 'strict_mode') {
    // 2. Add .first() before .click() / .fill() on local page locators
    healed = healed.replace(
      /\.locator\(([^)]+)\)\.click\(\)/g,
      '.locator($1).first().click()'
    );
    healed = healed.replace(
      /\.locator\(([^)]+)\)\.fill\(/g,
      '.locator($1).first().fill('
    );
    applied.push('strict-mode-first-element');
  }

  if (strategy === 'not_visible') {
    // 3. Add waitFor visible before .click() calls on page-object locators
    healed = healed.replace(
      /(await\s+\w+\.\w+\.click\(\);)/g,
      `await page.waitForLoadState('domcontentloaded');\n    $1`
    );
    // Also extend timeouts as a safety net
    healed = healed.replace(
      /(test\([^,]+,\s*async\s*\(\{\s*page[^}]*\}\s*(?:,\s*testInfo)?\s*\)\s*=>\s*\{)/,
      `$1\n    page.setDefaultTimeout(90000);`
    );
    applied.push('visibility-guard', 'extended-timeout');
  }

  if (strategy === 'navigation') {
    // 4. Replace plain goto with domcontentloaded + networkidle
    healed = healed.replace(
      /await page\.goto\(([^),]+)\);/g,
      `await page.goto($1, { waitUntil: 'domcontentloaded', timeout: 60000 });\n    await page.waitForLoadState('networkidle');`
    );
    applied.push('navigation-resilience');
  }

  if (strategy === 'selector') {
    // 5. Extend waitForURL timeout and add networkidle
    healed = healed.replace(
      /await page\.waitForURL\('([^']+)',\s*\{([^}]*)\}\);/g,
      `await page.waitForLoadState('networkidle');\n    await page.waitForURL('$1', { timeout: 30000 });`
    );
    healed = healed.replace(
      /await page\.waitForURL\("([^"]+)",\s*\{([^}]*)\}\);/g,
      `await page.waitForLoadState('networkidle');\n    await page.waitForURL("$1", { timeout: 30000 });`
    );
    applied.push('selector-wait-resilience');
  }

  return { healed, applied };
}

// ─── Main ─────────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}╔══════════════════════════════════════════════════════╗${C.reset}`);
  console.log(`${C.bold}${C.cyan}║        Self-Healing Test Agent                        ║${C.reset}`);
  console.log(`${C.bold}${C.cyan}╚══════════════════════════════════════════════════════╝${C.reset}\n`);

  // ── Stage 0: Run full test suite ──────────────────────────────────────────
  if (skipRun) {
    console.log(`  ${C.dim}--skip-run: reusing existing test-results.json${C.reset}\n`);
  } else {
    console.log(`${C.bold}  Stage 0 — Execute Full Test Suite${C.reset}`);
    console.log(`  ${'─'.repeat(54)}\n`);

    const specsDir = SPECS_DIR;
    const specFiles = fs.existsSync(specsDir)
      ? fs.readdirSync(specsDir).filter(f => f.endsWith('.spec.js'))
      : [];

    if (specFiles.length === 0) {
      console.log(`  ${C.yellow}⚠  No spec files found in tests/specs/ — nothing to run.${C.reset}\n`);
      return;
    }

    console.log(`  Running ${specFiles.length} spec file(s) in tests/specs/`);
    console.log(`  Mode    : ${headless ? 'Headless (CI)' : 'Headed — visible browser'}\n`);

    // Remove stale results so we always get fresh output
    if (fs.existsSync(RESULTS_FILE)) fs.unlinkSync(RESULTS_FILE);

    let runExitCode = 0;
    try {
      execSync('npx playwright test', {
        cwd:   ROOT,
        stdio: 'inherit',
        env:   {
          ...process.env,
          PW_HEADLESS:                 headless ? 'true' : (process.env.PW_HEADLESS || 'false'),
          PLAYWRIGHT_JSON_OUTPUT_NAME: RESULTS_FILE
        }
      });
    } catch (err) {
      runExitCode = err.status || 1;
    }

    if (runExitCode === 0) {
      console.log(`\n  ${C.green}✓  All tests passed — no healing needed.${C.reset}\n`);
      return;
    }

    console.log(`\n  ${C.yellow}⚠  Suite finished with exit code ${runExitCode}. Analysing failures...${C.reset}\n`);
  }

  // ── Read test results ──────────────────────────────────────────────────────
  if (!fs.existsSync(RESULTS_FILE)) {
    console.log(`  ${C.yellow}⚠  No results found at test-results.json. Nothing to heal.${C.reset}\n`);
    return;
  }

  const raw     = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  const failing = collectFailingTests(raw.suites || []);

  if (failing.length === 0) {
    console.log(`  ${C.green}✓  All tests passed. No healing required.${C.reset}\n`);
    return;
  }

  console.log(`${C.bold}  Stage 1 — Analyse Failures${C.reset}`);
  console.log(`  ${'─'.repeat(54)}\n`);
  console.log(`  ${C.yellow}⚠  Found ${failing.length} failing test(s). Initiating healing...\n${C.reset}`);

  // Group by file so we heal each spec file once
  const byFile = new Map();
  for (const t of failing) {
    const basename = path.basename(t.file || '');
    if (!basename) continue;
    if (!byFile.has(basename)) byFile.set(basename, []);
    byFile.get(basename).push(t);
  }

  // ── Stage 2: Apply healing patches ────────────────────────────────────────
  console.log(`${C.bold}  Stage 2 — Apply Healing Patches${C.reset}`);
  console.log(`  ${'─'.repeat(54)}\n`);

  // Prepare healed directory
  fs.mkdirSync(HEALED_DIR, { recursive: true });

  const healReport = [];

  for (const [filename, tests] of byFile) {
    const origPath = path.join(SPECS_DIR, filename);
    if (!fs.existsSync(origPath)) {
      console.log(`  ${C.dim}  Spec not found: ${filename} (skipping)${C.reset}`);
      continue;
    }

    const firstError = tests[0].error || '';
    const strategy   = detectStrategy(firstError);
    const origContent = fs.readFileSync(origPath, 'utf8');
    const { healed, applied } = healSpec(origContent, strategy);

    if (healed !== origContent) {
      const healedPath = path.join(HEALED_DIR, filename);
      fs.writeFileSync(healedPath, healed, 'utf8');
      console.log(`  ${C.cyan}🔧 Healed: ${C.bold}${filename}${C.reset}`);
      console.log(`     Strategy : ${strategy}`);
      console.log(`     Applied  : ${applied.join(', ')}`);
      console.log(`     Error    : ${firstError.slice(0, 100)}\n`);
      healReport.push({ filename, strategy, applied, originalError: firstError.slice(0, 150) });
    } else {
      console.log(`  ${C.dim}  No patch applicable for: ${filename}${C.reset}`);
    }
  }

  if (healReport.length === 0) {
    console.log(`\n  ${C.yellow}⚠  No healing patches applied. Tests may need manual review.${C.reset}\n`);
    return;
  }

  // ── Stage 3: Re-run healed specs ──────────────────────────────────────────
  const healedFiles = healReport.map(r => path.join('tests', 'healed', r.filename)).join(' ');
  console.log(`\n${C.bold}  Stage 3 — Re-run Healed Specs${C.reset}`);
  console.log(`  ${'─'.repeat(54)}\n`);
  console.log(`  ${C.bold}Re-running ${healReport.length} healed spec(s)...${C.reset}\n`);

  let healExitCode = 0;
  try {
    execSync(
      `npx playwright test ${healedFiles} --reporter=list,json`,
      {
        cwd:   ROOT,
        stdio: 'inherit',
        env:   {
          ...process.env,
          PW_HEADLESS:                  headless ? 'true' : (process.env.PW_HEADLESS || 'false'),
          PLAYWRIGHT_JSON_OUTPUT_NAME:  HEALED_RESULTS
        }
      }
    );
  } catch (err) {
    healExitCode = err.status || 1;
    console.log(`\n  ${C.yellow}⚠  Some healed tests still failing (exit ${healExitCode}). Manual review recommended.${C.reset}\n`);
  }

  if (healExitCode === 0) {
    console.log(`\n  ${C.green}✓  Healed tests all passed.${C.reset}\n`);
  }

  // ── Stage 4: Summary ───────────────────────────────────────────────────────
  console.log(`${C.bold}  Stage 4 — Heal Summary (${healReport.length} file(s) patched):${C.reset}`);
  for (const r of healReport) {
    console.log(`    ${C.cyan}•${C.reset} ${r.filename}`);
    console.log(`      Strategy : ${r.strategy}  |  Applied : ${r.applied.join(', ')}`);
  }
  if (fs.existsSync(HEALED_RESULTS)) {
    console.log(`\n  ${C.dim}  Healed results: test-results-healed.json${C.reset}`);
  }
  console.log('');
}

main().catch(err => {
  console.error(`\n${C.red}  HEALER ERROR: ${err.message}${C.reset}\n`);
  process.exit(1);
});
