'use strict';
/**
 * proactive-healer.js  —  Proactive Healer Stage 2
 * ─────────────────────────────────────────────────────────────────────────────
 * Read impact-manifest.json produced by scripts/analyse-impact.js and perform
 * three parallel structural heal operations BEFORE a Playwright run:
 *
 *   A) POM locator healing     — probe each page in a headless browser,
 *                                detect broken selectors, auto-repair the
 *                                YAML, and warn on hard-coded selectors.
 *   B) Zephyr test-case update — rewrite step descriptions that reference
 *                                stale selectors and PUT them back.
 *   C) Spec file patching      — replace old selector string-literals with
 *                                healed ones in every affected .spec.js.
 *
 * A final optional "run affected specs" step re-executes only the specs that
 * were touched and writes their outcome to test-results-healed.json so the
 * main test-results.json stays intact.
 *
 * CLI flags:
 *   --dry-run        No writes — preview only
 *   --skip-zephyr    Skip Operation B
 *   --skip-pom       Skip Operation A
 *   --skip-specs     Skip Operation C
 *   --skip-run       Skip final Playwright re-run
 *
 * Usage:
 *   node scripts/proactive-healer.js
 *   node scripts/proactive-healer.js --dry-run
 */

require('dotenv').config();
const fs                = require('fs');
const path              = require('path');
const { execSync, spawn } = require('child_process');
const axios             = require('axios');

const logger            = require('../src/utils/logger');
const { zephyrHeaders } = require('../src/utils/zephyrJwt');
const config            = require('../src/core/config');

const ROOT              = path.resolve(__dirname, '..');
const MANIFEST_PATH     = path.join(ROOT, 'impact-manifest.json');
const HEALED_DIR        = path.join(ROOT, 'tests', 'healed');
const HEALED_RESULTS    = path.join(ROOT, 'test-results-healed.json');

// ─── Flag parsing ────────────────────────────────────────────────────────────
const args = process.argv.slice(2);
const flags = {
  dryRun:     args.includes('--dry-run'),
  skipZephyr: args.includes('--skip-zephyr'),
  skipPom:    args.includes('--skip-pom'),
  skipSpecs:  args.includes('--skip-specs'),
  skipRun:    args.includes('--skip-run'),
};

// ─── Page → application route ────────────────────────────────────────────────
const PAGE_ROUTES = {
  LoginPage:        '/web/index.php/auth/login',
  AddEmployeePage:  '/web/index.php/pim/addEmployee',
  EmployeeListPage: '/web/index.php/pim/viewEmployeeList',
};

// ─── Helpers ─────────────────────────────────────────────────────────────────
/**
 * Atomically write text to `filePath` via a `.tmp` sibling + rename.
 *
 * @param {string} filePath  Absolute path of the target file.
 * @param {string} contents  UTF-8 text to persist.
 */
function writeFileAtomic(filePath, contents) {
  const tmp = `${filePath}.tmp`;
  fs.writeFileSync(tmp, contents, 'utf8');
  fs.renameSync(tmp, filePath);
}

/**
 * Convert a camelCase locator key to kebab-case for `name=` / `data-testid=`
 * heuristics.  `usernameInput` → `username-input`.
 *
 * @param {string} key  Locator key from the YAML file.
 * @returns {string}    Kebab-case form.
 */
function camelToKebab(key) {
  return String(key).replace(/([a-z0-9])([A-Z])/g, '$1-$2').toLowerCase();
}

/**
 * Serialise a locator map to the project's YAML flavour (plain `key: 'value'`
 * lines, comments preserved only for healed keys via `healedKeys`).
 *
 * @param {object} locators      Final `{ key: selector }` map.
 * @param {string} pageName      Page name used in the file header comment.
 * @param {string[]} healedKeys  Keys that were auto-healed this run.
 * @returns {string}             YAML text ready to be written to disk.
 */
function serialiseYaml(locators, pageName, healedKeys = []) {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [
    `# ${pageName} locators`,
    `# Auto-managed by scripts/proactive-healer.js — hand edits allowed.`,
    '',
  ];
  for (const [key, value] of Object.entries(locators)) {
    if (healedKeys.includes(key)) lines.push(`# healed: ${today}`);
    const safe = String(value).replace(/'/g, "\\'");
    lines.push(`${key}: '${safe}'`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Fail-safe reader for the impact manifest.
 * Exits 1 with a user-friendly message when the manifest is absent — this is
 * always an operator error (run `analyse-impact.js` first).
 *
 * @returns {object}  Parsed manifest contents.
 */
function readManifest() {
  if (!fs.existsSync(MANIFEST_PATH)) {
    logger.error(`[proactive-healer] Missing ${MANIFEST_PATH}. Run scripts/analyse-impact.js first.`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

// ─── Operation A — POM locator healing ───────────────────────────────────────
/**
 * Probe each affected page in a headless browser, detect broken selectors,
 * try a small set of recovery heuristics, and write the healed YAML back.
 *
 * @param {object[]} affectedPages  `affectedPages` slice of the manifest.
 * @returns {Promise<{healed:number, manual:number, detail:object[]}>}
 */
async function healPageObjects(affectedPages) {
  const detail = [];
  let healed = 0;
  let manual = 0;
  if (!affectedPages || affectedPages.length === 0) return { healed, manual, detail };

  const baseUrl = process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com';
  let chromium;
  try {
    ({ chromium } = require('playwright'));
  } catch (err) {
    logger.warn(`[proactive-healer] Playwright not installed — skipping POM heal: ${err.message}`);
    return { healed, manual, detail };
  }

  let browser;
  try {
    browser = await chromium.launch({ headless: true, timeout: 30000 });

    for (const page of affectedPages) {
      const route    = PAGE_ROUTES[page.pageName];
      const pageInfo = { pageName: page.pageName, broken: [], healedKeys: [], manualKeys: [] };
      if (!route) {
        logger.warn(`[proactive-healer] No route mapping for ${page.pageName}; skipping POM probe`);
        detail.push(pageInfo);
        continue;
      }
      const ctx     = await browser.newContext();
      const pwPage  = await ctx.newPage();

      try {
        await pwPage.goto(baseUrl + route, { timeout: 30000, waitUntil: 'domcontentloaded' });

        const newLocators = { ...page.currentLocators };
        for (const [key, selector] of Object.entries(page.currentLocators)) {
          let count = 0;
          try { count = await pwPage.locator(selector).count(); } catch { count = 0; }
          if (count > 0) continue;

          pageInfo.broken.push(key);

          // Try recovery variants in priority order
          const candidates = [
            `[aria-label="${key}"]`,
            `[name="${camelToKebab(key)}"]`,
            `[placeholder*="${key}"]`,
            `[data-testid="${key}"]`,
          ];
          let replacement = null;
          for (const sel of candidates) {
            let c = 0;
            try { c = await pwPage.locator(sel).count(); } catch { c = 0; }
            if (c > 0) { replacement = sel; break; }
          }
          if (replacement) {
            newLocators[key] = replacement;
            pageInfo.healedKeys.push({ key, from: selector, to: replacement });
            healed++;
          } else {
            pageInfo.manualKeys.push({ key, selector, healStatus: 'manual-review-needed' });
            manual++;
          }
        }

        // Write healed YAML if anything changed
        if (pageInfo.healedKeys.length > 0) {
          const ymlAbs = path.isAbsolute(page.ymlPath) ? page.ymlPath : path.join(ROOT, page.ymlPath);
          if (flags.dryRun) {
            logger.info(`[proactive-healer][dry-run] Would rewrite ${page.ymlPath} with ${pageInfo.healedKeys.length} healed locator(s)`);
          } else {
            const yamlText = serialiseYaml(newLocators, page.pageName, pageInfo.healedKeys.map(h => h.key));
            writeFileAtomic(ymlAbs, yamlText);
            logger.info(`[proactive-healer] Rewrote ${page.ymlPath} (${pageInfo.healedKeys.length} healed)`);
          }
        }

        // Scan .js for hard-coded selectors
        const jsAbs = path.isAbsolute(page.jsPath) ? page.jsPath : path.join(ROOT, page.jsPath);
        if (fs.existsSync(jsAbs)) {
          const jsText = fs.readFileSync(jsAbs, 'utf8');
          const lines  = jsText.split(/\r?\n/);
          const hardCoded = [];
          const selRegex  = /['"`]([.#\[][^'"`]{2,120})['"`]/;
          lines.forEach((line, idx) => {
            if (/loadLocators|require\(/.test(line)) return;
            if (selRegex.test(line) && /page\.locator|waitForSelector|\$\(|querySelector/.test(line)) {
              hardCoded.push(idx + 1);
            }
          });
          if (hardCoded.length > 0) {
            logger.warn(`[proactive-healer] ${page.jsPath}: hard-coded selectors on line(s) ${hardCoded.join(', ')} — manual review recommended`);
            pageInfo.hardCodedLines = hardCoded;
          }
        }

        // Expose final locator map back to downstream operations
        pageInfo.newLocators = newLocators;
      } catch (err) {
        logger.warn(`[proactive-healer] Probe failed for ${page.pageName}: ${err.message}`);
      } finally {
        await pwPage.close().catch(() => {});
        await ctx.close().catch(() => {});
      }

      detail.push(pageInfo);
    }
  } finally {
    if (browser) await browser.close().catch(() => {});
  }

  return { healed, manual, detail };
}

// ─── Operation B — Zephyr test-case update ───────────────────────────────────
/**
 * Rewrite Zephyr step descriptions that reference a now-healed locator key
 * and PUT the updated test case back to the Zephyr API.
 *
 * @param {string[]} affectedTestKeys  Zephyr keys from the manifest.
 * @param {object} zephyrTestCases     Map of key → Zephyr payload from the manifest.
 * @param {object[]} pomDetail         `detail` array from `healPageObjects()`.
 * @returns {Promise<number>}          Count of test cases successfully updated.
 */
async function updateZephyrTestCases(affectedTestKeys, zephyrTestCases, pomDetail) {
  let updated = 0;
  if (!affectedTestKeys || affectedTestKeys.length === 0) return updated;
  if (!config.zephyr || !config.zephyr.token || !config.zephyr.baseUrl) {
    logger.warn('[proactive-healer] Zephyr credentials missing — skipping Zephyr update');
    return updated;
  }

  // Aggregate all healed keys across pages: { oldSelector: newSelector, key: newSelector }
  const healMap = {};
  for (const p of pomDetail) {
    for (const h of (p.healedKeys || [])) {
      healMap[h.key]  = h.to;
      healMap[h.from] = h.to;
    }
  }
  if (Object.keys(healMap).length === 0) return updated;

  const today = new Date().toISOString().slice(0, 10);

  for (const key of affectedTestKeys) {
    const tc = zephyrTestCases && zephyrTestCases[key];
    if (!tc) continue;

    const originalSteps = Array.isArray(tc.steps) ? tc.steps : (tc.testScript && tc.testScript.steps) || [];
    if (!originalSteps.length) continue;

    let touched = false;
    const updatedSteps = originalSteps.map(step => {
      const desc = typeof step === 'string' ? step : (step.description || step.inline?.description || '');
      if (!desc) return step;

      let newDesc = desc;
      for (const [needle, replacement] of Object.entries(healMap)) {
        if (typeof needle === 'string' && needle.length > 1 && newDesc.includes(needle)) {
          newDesc = newDesc.split(needle).join(replacement);
        }
      }
      if (newDesc === desc) return step;

      touched = true;
      newDesc = `${newDesc} [auto-healed ${today}]`;
      if (typeof step === 'string') return newDesc;
      if (step.inline) return { ...step, inline: { ...step.inline, description: newDesc } };
      return { ...step, description: newDesc };
    });

    if (!touched) continue;

    if (flags.dryRun) {
      logger.info(`[proactive-healer][dry-run] Would PUT ${key} with ${updatedSteps.length} steps`);
      continue;
    }

    try {
      await axios.put(
        `${config.zephyr.baseUrl}/testcases/${key}`,
        { ...tc, steps: updatedSteps },
        { headers: zephyrHeaders(), timeout: 20000 }
      );
      logger.info(`[proactive-healer] Zephyr updated: ${key}`);
      updated++;
    } catch (err) {
      logger.warn(`[proactive-healer] Zephyr PUT failed for ${key}: ${err.message}`);
    }
  }

  return updated;
}

// ─── Operation C — Spec file patching ────────────────────────────────────────
/**
 * Replace old selector string literals inside every affected spec file,
 * prepend a heal-provenance comment, back up the original under
 * `tests/healed/` and rewrite in place.
 *
 * @param {string[]} affectedSpecFiles  `affectedSpecFiles` from the manifest.
 * @param {object[]} pomDetail          `detail` from `healPageObjects()`.
 * @returns {Promise<number>}           Count of specs successfully patched.
 */
async function patchSpecFiles(affectedSpecFiles, pomDetail) {
  let patched = 0;
  if (!affectedSpecFiles || affectedSpecFiles.length === 0) return patched;

  // Build { oldSelector: newSelector } map from all healed locators
  const selectorMap = {};
  const healedKeys  = new Set();
  for (const p of pomDetail) {
    for (const h of (p.healedKeys || [])) {
      selectorMap[h.from] = h.to;
      healedKeys.add(h.key);
    }
  }
  if (Object.keys(selectorMap).length === 0) return patched;

  if (!flags.dryRun && !fs.existsSync(HEALED_DIR)) fs.mkdirSync(HEALED_DIR, { recursive: true });

  for (const specRel of affectedSpecFiles) {
    const specAbs = path.isAbsolute(specRel) ? specRel : path.join(ROOT, specRel);
    if (!fs.existsSync(specAbs)) continue;

    const original = fs.readFileSync(specAbs, 'utf8');
    let mutated    = original;

    // Replace quoted string literals only (safer than free-form replace)
    for (const [oldSel, newSel] of Object.entries(selectorMap)) {
      for (const q of ['"', "'", '`']) {
        const needle = q + oldSel + q;
        const repl   = q + newSel + q;
        if (mutated.includes(needle)) mutated = mutated.split(needle).join(repl);
      }
    }

    if (mutated === original) continue;

    // Prepend a heal-provenance comment after any leading file-banner comment
    const commentLine = `// proactive-healed: ${new Date().toISOString()} — ${[...healedKeys].join(', ')}`;
    const lines = mutated.split(/\r?\n/);
    let insertAt = 0;
    // skip an initial contiguous block of comment / shebang lines
    while (insertAt < lines.length && /^\s*(\/\/|\/\*|\*|#!)/.test(lines[insertAt])) insertAt++;
    lines.splice(insertAt, 0, commentLine);
    mutated = lines.join('\n');

    if (flags.dryRun) {
      logger.info(`[proactive-healer][dry-run] Would patch ${specRel}`);
      patched++;
      continue;
    }

    // Back up then rewrite
    const backup = path.join(HEALED_DIR, path.basename(specAbs));
    fs.writeFileSync(backup, original, 'utf8');
    writeFileAtomic(specAbs, mutated);
    logger.info(`[proactive-healer] Patched ${specRel} (backup → ${path.relative(ROOT, backup).replace(/\\/g, '/')})`);
    patched++;
  }

  return patched;
}

// ─── Final step — run affected specs ─────────────────────────────────────────
/**
 * Re-run the affected specs with Playwright and persist the result JSON
 * to `test-results-healed.json` (never clobbers `test-results.json`).
 *
 * @param {string[]} affectedTestKeys  Zephyr keys used to build `--grep`.
 * @returns {Promise<{ran:number, passed:number, failed:number}>}
 */
async function runAffectedSpecs(affectedTestKeys) {
  const summary = { ran: 0, passed: 0, failed: 0 };
  if (!affectedTestKeys || affectedTestKeys.length === 0) return summary;

  const grep = affectedTestKeys.join('|');
  logger.info(`[proactive-healer] Re-running ${affectedTestKeys.length} healed spec(s): --grep "${grep}"`);

  await new Promise((resolve) => {
    const child = spawn(
      'npx',
      ['playwright', 'test', '--grep', grep, '--reporter=json,list'],
      {
        cwd: ROOT,
        shell: true,
        env: { ...process.env, PLAYWRIGHT_JSON_OUTPUT_NAME: HEALED_RESULTS },
        stdio: ['ignore', 'pipe', 'pipe'],
      }
    );
    let out = '';
    let err = '';
    child.stdout.on('data', d => { out += d.toString(); process.stdout.write(d); });
    child.stderr.on('data', d => { err += d.toString(); process.stderr.write(d); });
    child.on('close', () => {
      // Playwright respects PLAYWRIGHT_JSON_OUTPUT_NAME only when json reporter
      // is configured; fall back to stdout capture when the file is absent.
      if (!fs.existsSync(HEALED_RESULTS) && out.trim().startsWith('{')) {
        try { fs.writeFileSync(HEALED_RESULTS, out, 'utf8'); } catch { /* ignore */ }
      }
      resolve();
    });
    child.on('error', e => { logger.warn(`[proactive-healer] playwright spawn failed: ${e.message}`); resolve(); });
  });

  try {
    if (fs.existsSync(HEALED_RESULTS)) {
      const json  = JSON.parse(fs.readFileSync(HEALED_RESULTS, 'utf8'));
      const stats = json.stats || {};
      summary.passed = Number(stats.expected || 0);
      summary.failed = Number(stats.unexpected || 0);
      summary.ran    = summary.passed + summary.failed + Number(stats.flaky || 0);
    }
  } catch (err) {
    logger.warn(`[proactive-healer] Could not parse ${HEALED_RESULTS}: ${err.message}`);
  }
  return summary;
}

// ─── Pretty summary ──────────────────────────────────────────────────────────
/**
 * Print the final human-readable summary table.
 *
 * @param {{pomHealed:number, manual:number, zephyrUpdated:number,
 *          specsPatched:number, run:{ran:number,passed:number,failed:number},
 *          affectedPages:number}} totals
 */
function printSummary(totals) {
  const pad = (s, n) => String(s).padEnd(n);
  console.log('');
  console.log('┌─────────────────────────────────────────────────────┐');
  console.log('│  PROACTIVE HEAL SUMMARY                             │');
  console.log('├──────────────────┬──────────────────────────────────┤');
  console.log(`│ ${pad('Pages healed',   16)} │ ${pad(`${totals.pomHealed > 0 ? totals.affectedPages : 0} / ${totals.affectedPages}`, 32)} │`);
  console.log(`│ ${pad('Locators fixed', 16)} │ ${pad(`${totals.pomHealed} (${totals.manual} manual-review-needed)`, 32)} │`);
  console.log(`│ ${pad('Zephyr updated', 16)} │ ${pad(`${totals.zephyrUpdated} test cases`, 32)} │`);
  console.log(`│ ${pad('Specs patched',  16)} │ ${pad(`${totals.specsPatched} files`, 32)} │`);
  console.log(`│ ${pad('Tests run',      16)} │ ${pad(`${totals.run.ran} (${totals.run.passed} passed, ${totals.run.failed} failed)`, 32)} │`);
  console.log('└──────────────────┴──────────────────────────────────┘');
  console.log('');
}

// ─── Main ────────────────────────────────────────────────────────────────────
/**
 * Orchestrate operations A/B/C and the optional re-run.
 *
 * @returns {Promise<{pomHealed:number,manual:number,zephyrUpdated:number,specsPatched:number,run:object,affectedPages:number}>}
 */
async function proactiveHeal() {
  const manifest = readManifest();
  const affectedPages = Array.isArray(manifest.affectedPages) ? manifest.affectedPages : [];

  if (affectedPages.length === 0) {
    logger.info('[proactive-healer] impact-manifest.json reports no affected pages — nothing to heal.');
    const totals = { pomHealed: 0, manual: 0, zephyrUpdated: 0, specsPatched: 0, run: { ran: 0, passed: 0, failed: 0 }, affectedPages: 0 };
    printSummary(totals);
    return totals;
  }

  // Operation A
  const aResult = flags.skipPom
    ? { healed: 0, manual: 0, detail: [] }
    : await healPageObjects(affectedPages);

  // Operation B
  const zephyrUpdated = flags.skipZephyr
    ? 0
    : await updateZephyrTestCases(manifest.affectedTestKeys || [], manifest.zephyrTestCases || {}, aResult.detail);

  // Operation C
  const specsPatched = flags.skipSpecs
    ? 0
    : await patchSpecFiles(manifest.affectedSpecFiles || [], aResult.detail);

  // Final re-run
  const run = (flags.skipRun || flags.dryRun)
    ? { ran: 0, passed: 0, failed: 0 }
    : await runAffectedSpecs(manifest.affectedTestKeys || []);

  const totals = {
    pomHealed:     aResult.healed,
    manual:        aResult.manual,
    zephyrUpdated,
    specsPatched,
    run,
    affectedPages: affectedPages.length,
  };
  printSummary(totals);
  return totals;
}

if (require.main === module) {
  proactiveHeal()
    .then(() => process.exit(0))
    .catch(err => {
      logger.error(`[proactive-healer] FATAL: ${err.stack || err.message}`);
      process.exit(1);
    });
}

module.exports = {
  proactiveHeal,
  healPageObjects,
  updateZephyrTestCases,
  patchSpecFiles,
  runAffectedSpecs,
};
