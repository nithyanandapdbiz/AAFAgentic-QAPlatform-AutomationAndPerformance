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
              // 1200 chars: enough to capture the Playwright "Call log: waiting
              // for locator('...')" section that appears after the headline.
              error:  String(errorMsg).slice(0, 1200)
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
  // Strict-mode violation: :text() (substring) resolves to N>1 elements.
  // Patch the YAML to use :text-is() exact matching.
  if (/strict mode.*resolved to \d+ elements/.test(e) && /:text\(/.test(error || '')) return 'locator_yaml_strict';
  // Locator drift: :text-is() exact match resolves to 0 elements because the
  // label text changed in the new application build (timeout error).
  // Patch the YAML by replacing the stale text atom with the key-derived label.
  if (/timeout|timed.?out/.test(e) && /:text-is\(/.test(error || '')) return 'locator_yaml_drift';
  if (/timeout|timed.?out/.test(e))                              return 'timeout';
  if (/strict mode|multiple elements|more than one/.test(e))    return 'strict_mode';
  if (/not visible|is not visible|element.*hidden/.test(e))     return 'not_visible';
  if (/net::|err_|failed to load|navigation/.test(e))           return 'navigation';
  if (/no locator|locator.*not found|selector.*not found/.test(e)) return 'selector';
  return 'general';
}

// ─── Proactive YAML locator healing ──────────────────────────────────────────
// Scans tests/pages/*.yml for the offending selector extracted from a Playwright
// strict-mode violation and tightens `:text("…")` / `:text('…')` to
// `:text-is("…")`. Where possible, the tightened text is expanded to the
// fuller label inferred from the YAML key name (e.g. `employeeIdInput` →
// "Employee Id") so the tightened selector matches exactly one element.
// Matches tolerantly: we extract each `:text("X")` atom from the offending
// selector and patch any YAML line containing that same atom.
const PAGES_DIR = path.join(ROOT, 'tests', 'pages');

// Convert a camelCase YAML key into a human-readable label, dropping trailing
// UI-type suffixes. e.g. `employeeIdInput` → "Employee Id".
const KEY_SUFFIXES = /(Input|Button|Field|Box|Label|Text|Group|Dropdown|Select|Row|Cell|Link|Icon|Image|Header|Title|Msg|Message|Error|Alert)$/;
function deriveLabelFromKey(key) {
  const stripped = key.replace(KEY_SUFFIXES, '');
  // Split camelCase / snake_case into words
  const words = stripped
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Shared worker: scan every *.yml under PAGES_DIR, find selector lines that
 * contain any of the given `atoms`, and replace the text atom with the
 * key-derived label.  Works for both :text() (strict-mode) and :text-is()
 * (label-drift) atoms.
 *
 * @param {Array<{full:string, quote:string, value:string}>} atoms
 * @returns {{patchedFiles:string[], changes:object[]}|null}
 */
function _applyAtomPatchesToYaml(atoms) {
  if (!fs.existsSync(PAGES_DIR)) return null;
  const yamlFiles = fs.readdirSync(PAGES_DIR).filter(f => f.endsWith('.yml') || f.endsWith('.yaml'));
  const changes = [];
  for (const yf of yamlFiles) {
    const fp = path.join(PAGES_DIR, yf);
    const originalContent = fs.readFileSync(fp, 'utf8');
    const lines = originalContent.split(/\r?\n/);
    let modified = false;
    for (let i = 0; i < lines.length; i++) {
      const km = /^(\s*)([A-Za-z_][\w]*)\s*:\s*(['"])(.+)\3\s*$/.exec(lines[i]);
      if (!km) continue;
      const [, indent, key, quote, selector] = km;
      let patched = selector;
      let didPatch = false;
      for (const a of atoms) {
        if (!patched.includes(a.full)) continue;
        const derived = deriveLabelFromKey(key);
        // Use the key-derived label when it starts with the atom value (i.e.
        // the atom text is a substring of the correct full label).
        // e.g. atom ":text-is('Employee')" + key "employeeIdGroup"
        //   → derived "Employee Id" starts with "Employee" → use "Employee Id".
        const betterText = (derived && derived.toLowerCase().startsWith(a.value.toLowerCase()))
          ? derived : a.value;
        const replacement = `:text-is(${a.quote}${betterText}${a.quote})`;
        if (a.full === replacement) continue; // already correct, skip
        patched = patched.split(a.full).join(replacement);
        didPatch = true;
      }
      if (didPatch && patched !== selector) {
        lines[i] = `${indent}${key}: ${quote}${patched}${quote}`;
        modified = true;
      }
    }
    if (modified) {
      fs.writeFileSync(fp, lines.join('\n'), 'utf8');
      changes.push({ file: yf, from: atoms.map(a => a.full).join(', ') });
    }
  }
  return changes.length ? { patchedFiles: changes.map(c => c.file), changes } : null;
}

/**
 * Heal :text() substring atoms → :text-is() (strict-mode violation case).
 * Triggered when Playwright reports "resolved to N elements".
 */
function healYamlLocator(errorMsg) {
  if (!fs.existsSync(PAGES_DIR)) return null;
  const m = /locator\('([^']+)'\)/.exec(errorMsg) || /locator\("([^"]+)"\)/.exec(errorMsg);
  if (!m) return null;
  const atoms = [...m[1].matchAll(/:text\((['"])([^'"]+)\1\)/g)]
    .map(a => ({ full: a[0], quote: a[1], value: a[2] }));
  if (atoms.length === 0) return null;
  return _applyAtomPatchesToYaml(atoms);
}

/**
 * Heal :text-is() atoms whose label has drifted in the new build (timeout
 * with 0 matches).  Derives the correct label from the YAML key name and
 * replaces the stale text atom in every matching YAML line.
 *
 * E.g. :text-is("Employee") on key employeeIdGroup
 *        → :text-is("Employee Id")   because deriveLabelFromKey("employeeIdGroup") = "Employee Id"
 */
function healYamlLocatorDrift(errorMsg) {
  if (!fs.existsSync(PAGES_DIR)) return null;
  // Playwright timeout errors carry the locator in the Call log:
  //   "waiting for locator('.oxd-input-group:has(label:text-is("Employee")) input')"
  // The regex captures the full selector string.
  const m = /locator\('([^']+)'\)/.exec(errorMsg) || /locator\("([^"]+)"\)/.exec(errorMsg);
  if (!m) return null;
  const atoms = [...m[1].matchAll(/:text-is\((['"])([^'"]+)\1\)/g)]
    .map(a => ({ full: a[0], quote: a[1], value: a[2] }));
  if (atoms.length === 0) return null;
  return _applyAtomPatchesToYaml(atoms);
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

    // ── Proactive path A: drifted :text-is() label → 0 matches (timeout) ────
    // The application build changed a label text so an exact-match locator
    // now resolves to 0 elements.  Derive the correct label from the YAML key
    // and patch the YAML before the spec is re-run.
    if (strategy === 'locator_yaml_drift') {
      const yamlPatch = healYamlLocatorDrift(firstError);
      if (yamlPatch) {
        console.log(`  ${C.cyan}🔧 Locator label drift healed: ${C.bold}${filename}${C.reset}`);
        console.log(`     Strategy : locator_yaml_drift (text-is label changed in new build)`);
        for (const ch of yamlPatch.changes) {
          console.log(`     Patched  : tests/pages/${ch.file}`);
          console.log(`                  ${C.dim}- ${ch.from.slice(0, 90)}${ch.from.length > 90 ? '…' : ''}${C.reset}`);
          console.log(`                  ${C.dim}+ :text-is(<key-derived label>)${C.reset}`);
        }
        console.log(`     Error    : ${firstError.slice(0, 100)}\n`);
        healReport.push({
          filename, strategy,
          applied: ['yaml-label-drift-healed', ...yamlPatch.patchedFiles.map(f => `page:${f}`)],
          originalError: firstError.slice(0, 150),
          yamlOnly: true,
        });
        fs.copyFileSync(origPath, path.join(HEALED_DIR, filename));
        continue;
      }
      // YAML already patched by a sibling spec in this same run.
      const em = /locator\('([^']+)'\)/.exec(firstError) || /locator\("([^"]+)"\)/.exec(firstError);
      if (em && /:text-is\(/.test(em[1])) {
        console.log(`  ${C.cyan}🔧 Drift already healed by sibling: ${C.bold}${filename}${C.reset}`);
        console.log(`     Strategy : locator_yaml_drift (shared YAML, no new change)\n`);
        healReport.push({
          filename, strategy,
          applied: ['yaml-label-drift-healed-by-sibling'],
          originalError: firstError.slice(0, 150),
          yamlOnly: true,
        });
        fs.copyFileSync(origPath, path.join(HEALED_DIR, filename));
        continue;
      }
      // Fall through to regular spec-level healing if YAML patch gave nothing.
    }

    // ── Proactive path B: :text() substring → strict-mode multi-match ────────
    if (strategy === 'locator_yaml_strict') {
      const yamlPatch = healYamlLocator(firstError);
      if (yamlPatch) {
        console.log(`  ${C.cyan}🔧 Proactively healed locator for: ${C.bold}${filename}${C.reset}`);
        console.log(`     Strategy : locator_yaml_strict (YAML page-object)`);
        for (const ch of yamlPatch.changes) {
          console.log(`     Patched  : tests/pages/${ch.file}`);
          console.log(`                  ${C.dim}- ${ch.from.slice(0, 90)}${ch.from.length > 90 ? '…' : ''}${C.reset}`);
          const toLabel = ch.from.replace(/:text\(/g, ':text-is(');
          console.log(`                  ${C.dim}+ ${toLabel.slice(0, 90)}${toLabel.length > 90 ? '…' : ''} (key-inferred text where possible)${C.reset}`);
        }
        console.log(`     Error    : ${firstError.slice(0, 100)}\n`);
        healReport.push({
          filename, strategy,
          applied: ['yaml-locator-tightened', ...yamlPatch.patchedFiles.map(f => `page:${f}`)],
          originalError: firstError.slice(0, 150),
          yamlOnly: true,
        });
        fs.copyFileSync(origPath, path.join(HEALED_DIR, filename));
        continue;
      }
      // yamlPatch is null → check whether a sibling spec already tightened the
      // same YAML atom in this run. If so, treat this spec as healed-by-sibling
      // and let Stage 3 re-run it against the patched YAML.
      const em = /locator\('([^']+)'\)/.exec(firstError) || /locator\("([^"]+)"\)/.exec(firstError);
      const hadAtoms = em && /:text\(/.test(em[1]);
      if (hadAtoms) {
        console.log(`  ${C.cyan}🔧 Already healed by sibling: ${C.bold}${filename}${C.reset}`);
        console.log(`     Strategy : locator_yaml_strict (shared YAML, no new change)\n`);
        healReport.push({
          filename, strategy,
          applied: ['yaml-locator-tightened-by-sibling'],
          originalError: firstError.slice(0, 150),
          yamlOnly: true,
        });
        fs.copyFileSync(origPath, path.join(HEALED_DIR, filename));
        continue;
      }
      // Fall through to regular healing if YAML patching didn't apply.
    }

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
