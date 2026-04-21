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
 *   --standalone     Skip the impact-manifest; probe every YAML in tests/pages/
 *                    and heal any drift detected in the live build.
 *   --skip-zephyr    Skip Operation B
 *   --skip-pom       Skip Operation A
 *   --skip-specs     Skip Operation C
 *   --skip-run       Skip final Playwright re-run
 *
 * Usage:
 *   node scripts/proactive-healer.js
 *   node scripts/proactive-healer.js --standalone
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
  standalone: args.includes('--standalone'),
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

// ============================================================================
// FUZZY TEXT MATCHING HELPERS (Enhancement — Added 2026-04-21)
// ============================================================================

/**
 * Calculate Levenshtein distance between two strings.
 *
 * @param {string} str1
 * @param {string} str2
 * @returns {number} Edit distance (0 = identical).
 */
function levenshteinDistance(str1, str2) {
  const matrix = Array(str2.length + 1).fill(null)
    .map(() => Array(str1.length + 1).fill(null));

  for (let i = 0; i <= str1.length; i++) matrix[0][i] = i;
  for (let j = 0; j <= str2.length; j++) matrix[j][0] = j;

  for (let j = 1; j <= str2.length; j++) {
    for (let i = 1; i <= str1.length; i++) {
      const indicator = str1[i - 1] === str2[j - 1] ? 0 : 1;
      matrix[j][i] = Math.min(
        matrix[j][i - 1] + 1,           // deletion
        matrix[j - 1][i] + 1,           // insertion
        matrix[j - 1][i - 1] + indicator // substitution
      );
    }
  }

  return matrix[str2.length][str1.length];
}

/**
 * Calculate Levenshtein similarity on a 0–1 scale (1 = identical).
 *
 * @param {string} str1
 * @param {string} str2
 * @returns {number}
 */
function calculateLevenshteinSimilarity(str1, str2) {
  const longer  = str1.length >= str2.length ? str1 : str2;
  const shorter = str1.length >= str2.length ? str2 : str1;
  if (longer.length === 0) return 1.0;
  const editDistance = levenshteinDistance(longer, shorter);
  return (longer.length - editDistance) / longer.length;
}

/**
 * Attempt to recover a broken text-based locator using fuzzy text matching.
 * This is an ADDITIONAL recovery strategy that runs AFTER all existing
 * candidate-based strategies in `healPageObjects` have failed.
 *
 * Only activates for selectors containing `:text-is("…")` or `:text-matches("…")`.
 * When the best matching element's text is ≥ `HEALER_TEXT_SIMILARITY_THRESHOLD`
 * similar, the new text is substituted into the original selector.
 *
 * Configurable via environment variables:
 *   HEALER_TEXT_SIMILARITY_THRESHOLD  — float 0–1, default 0.70
 *   HEALER_TEXT_CASE_SENSITIVE        — "true"|"false", default false
 *
 * @param {import('playwright').Page} pwPage           Live Playwright page.
 * @param {string}                    originalSelector  The broken CSS/PW selector.
 * @param {string}                    locatorKey        Key name for logging only.
 * @returns {Promise<{newSelector:string, reason:string, confidence:number, method:string}|null>}
 */
async function recoverTextBasedLocator(pwPage, originalSelector, locatorKey) {
  // Only attempt recovery for text-based selectors
  const textMatch = originalSelector.match(/:text-is\("([^"]+)"\)|:text-matches\("([^"]+)"\)/);
  if (!textMatch) {
    logger.debug(`[Fuzzy Text Recovery] Skipping ${locatorKey} — not a text-based selector`);
    return null;
  }

  const originalText = textMatch[1] || textMatch[2];
  const baseSelector = originalSelector.split(/:text-is\(|:text-matches\(/)[0];

  logger.info(`[Fuzzy Text Recovery] Attempting recovery for "${locatorKey}"`);
  logger.debug(`[Fuzzy Text Recovery] Original text: "${originalText}"`);
  logger.debug(`[Fuzzy Text Recovery] Base selector: "${baseSelector}"`);

  try {
    const candidates = await pwPage.locator(baseSelector).all();
    logger.debug(`[Fuzzy Text Recovery] Found ${candidates.length} candidate element(s)`);

    if (candidates.length === 0) {
      logger.warn(`[Fuzzy Text Recovery] No elements found with base selector "${baseSelector}"`);
      return null;
    }

    const threshold     = parseFloat(process.env.HEALER_TEXT_SIMILARITY_THRESHOLD || '0.70');
    const caseSensitive = process.env.HEALER_TEXT_CASE_SENSITIVE === 'true';

    let bestMatch      = null;
    let bestSimilarity = 0;

    for (const candidate of candidates) {
      const rawText   = await candidate.textContent();
      const cleanText = (rawText || '').trim();
      if (!cleanText) continue;

      const s1 = caseSensitive ? cleanText      : cleanText.toLowerCase();
      const s2 = caseSensitive ? originalText   : originalText.toLowerCase();
      const similarity = calculateLevenshteinSimilarity(s1, s2);

      logger.debug(
        `[Fuzzy Text Recovery] Candidate: "${cleanText}" ` +
        `(similarity: ${(similarity * 100).toFixed(1)}%)`
      );

      if (similarity > bestSimilarity && similarity >= threshold) {
        bestMatch      = cleanText;
        bestSimilarity = similarity;
      }
    }

    if (bestMatch) {
      // Preserve the exact original selector shape — only swap the text atom.
      const newSelector = originalSelector
        .replace(/:text-is\("[^"]+"\)/,    `:text-is("${bestMatch}")`)
        .replace(/:text-matches\("[^"]+"\)/, `:text-is("${bestMatch}")`);

      logger.info(
        `[Fuzzy Text Recovery] ✓ Recovery successful: ` +
        `"${originalText}" → "${bestMatch}" ` +
        `(${(bestSimilarity * 100).toFixed(1)}% similarity)`
      );

      return {
        newSelector,
        reason:     `Text changed from "${originalText}" to "${bestMatch}"`,
        confidence: bestSimilarity,
        method:     'fuzzy-text-match',
      };
    }

    logger.warn(
      `[Fuzzy Text Recovery] ✗ No match found for "${originalText}" ` +
      `(threshold: ${(threshold * 100).toFixed(0)}%)`
    );
    return null;

  } catch (err) {
    logger.warn(`[Fuzzy Text Recovery] Error during recovery for "${locatorKey}": ${err.message}`);
    return null;
  }
}

// ============================================================================
// END OF FUZZY TEXT MATCHING ENHANCEMENT
// ============================================================================


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

// UI-type suffixes stripped when deriving labels/name-attrs from keys.
const KEY_SUFFIXES = /(Input|Button|Field|Box|Label|Text|Group|Dropdown|Select|Row|Cell|Link|Icon|Image|Header|Title|Msg|Message|Error|Alert)$/;

/**
 * Derive a human label from a locator key, stripping UI-type suffixes and
 * converting camelCase into Title Case words. `employeeIdInput` → "Employee Id".
 *
 * @param {string} key
 * @returns {string|null}
 */
function deriveLabelFromKey(key) {
  const stripped = String(key).replace(KEY_SUFFIXES, '');
  const words = stripped
    .replace(/[_-]+/g, ' ')
    .replace(/([a-z0-9])([A-Z])/g, '$1 $2')
    .trim()
    .split(/\s+/)
    .filter(Boolean);
  if (!words.length) return null;
  return words.map(w => w.charAt(0).toUpperCase() + w.slice(1).toLowerCase()).join(' ');
}

/**
 * Derive a camelCase name-attribute value from a locator key by stripping the
 * UI-type suffix. `firstNameInput` → `firstName`.
 *
 * @param {string} key
 * @returns {string}
 */
function deriveNameAttr(key) {
  return String(key).replace(KEY_SUFFIXES, '') || key;
}

/**
 * Serialise a locator map to the project's YAML flavour. Preserves the
 * original file's leading comment block (header documentation) so
 * hand-written context like route/application/notes is retained.
 *
 * @param {object} locators      Final `{ key: selector }` map.
 * @param {string} pageName      Page name used in the file header comment.
 * @param {string[]} healedKeys  Keys that were auto-healed this run.
 * @param {string} [existingText] Prior YAML text (used to extract header comments).
 * @returns {string}             YAML text ready to be written to disk.
 */
function serialiseYaml(locators, pageName, healedKeys = [], existingText = '') {
  const today = new Date().toISOString().slice(0, 10);
  const lines = [];

  // Preserve leading comment block from the original file.
  if (existingText) {
    for (const ln of existingText.split(/\r?\n/)) {
      if (ln.trim().startsWith('#') || ln.trim() === '') {
        lines.push(ln);
      } else {
        break;
      }
    }
  }
  if (lines.length === 0) {
    lines.push(
      `# ${pageName} locators`,
      `# Auto-managed by scripts/proactive-healer.js — hand edits allowed.`,
      ''
    );
  }

  for (const [key, value] of Object.entries(locators)) {
    if (healedKeys.includes(key)) lines.push(`# healed: ${today}`);
    const safe = String(value).replace(/'/g, "\\'");
    lines.push(`${key}: '${safe}'`);
  }
  return lines.join('\n') + '\n';
}

/**
 * Fail-safe reader for the impact manifest.  When `--standalone` is set we
 * instead build a synthetic manifest from every `tests/pages/*.yml` found so
 * the healer can probe a fresh application build without a pre-computed
 * impact analysis.
 *
 * @returns {object}  Parsed manifest contents.
 */
function readManifest() {
  if (flags.standalone) {
    return buildStandaloneManifest();
  }
  if (!fs.existsSync(MANIFEST_PATH)) {
    logger.error(`[proactive-healer] Missing ${MANIFEST_PATH}. Run scripts/analyse-impact.js first (or pass --standalone).`);
    process.exit(1);
  }
  return JSON.parse(fs.readFileSync(MANIFEST_PATH, 'utf8'));
}

/**
 * Build a minimal manifest by discovering YAML page-objects under
 * `tests/pages/`. Each file becomes an affectedPages entry using `PAGE_ROUTES`.
 * Pages without a known route are skipped with a warning.
 *
 * @returns {object}
 */
function buildStandaloneManifest() {
  const pagesDir = path.join(ROOT, 'tests', 'pages');
  if (!fs.existsSync(pagesDir)) return { affectedPages: [], affectedSpecFiles: [], affectedTestKeys: [] };

  const affectedPages = [];
  for (const f of fs.readdirSync(pagesDir)) {
    if (!/\.ya?ml$/.test(f)) continue;
    const pageName = f.replace(/\.ya?ml$/, '');
    if (!PAGE_ROUTES[pageName]) {
      logger.warn(`[proactive-healer] No route mapping for ${pageName}; add it to PAGE_ROUTES to probe.`);
      continue;
    }
    const ymlPath = path.join('tests', 'pages', f);
    const jsPath  = path.join('tests', 'pages', `${pageName}.js`);
    const text    = fs.readFileSync(path.join(ROOT, ymlPath), 'utf8');
    const currentLocators = {};
    for (const line of text.split(/\r?\n/)) {
      const t = line.trim();
      if (!t || t.startsWith('#')) continue;
      const idx = t.indexOf(':');
      if (idx < 1) continue;
      const k = t.slice(0, idx).trim();
      let v = t.slice(idx + 1).trim();
      if ((v.startsWith("'") && v.endsWith("'")) || (v.startsWith('"') && v.endsWith('"'))) v = v.slice(1, -1);
      currentLocators[k] = v;
    }
    affectedPages.push({ pageName, ymlPath, jsPath, currentLocators });
  }

  // Discover affected specs = every spec file (proactive = scan the world).
  const specsDir = path.join(ROOT, 'tests', 'specs');
  const affectedSpecFiles = fs.existsSync(specsDir)
    ? fs.readdirSync(specsDir)
        .filter(f => /\.spec\.js$/.test(f))
        .map(f => path.join('tests', 'specs', f))
    : [];

  return { affectedPages, affectedSpecFiles, affectedTestKeys: [], zephyrTestCases: {} };
}

/**
 * If the route requires an authenticated session, run the OrangeHRM login
 * flow using credentials from `tests/data/testData.js`. Silently returns if
 * the page is already on a post-login route or if the login page itself is
 * being probed.
 *
 * @param {import('playwright').Page} pwPage
 * @param {string} baseUrl
 * @param {string} route
 */
async function authenticateIfNeeded(pwPage, baseUrl, route) {
  if (/\/auth\/login/i.test(route)) return;
  let creds;
  try {
    ({ CREDENTIALS: creds } = require('../tests/data/testData'));
  } catch {
    return; // no creds available — caller will see the broken probe
  }
  const user = creds && creds.admin;
  if (!user) return;

  await pwPage.goto(baseUrl + '/web/index.php/auth/login', {
    timeout: 30000, waitUntil: 'domcontentloaded',
  });
  // Use the known-good login selectors. These are in LoginPage.yml but we
  // hard-code the classic OrangeHRM names here so login cannot itself drift.
  try {
    await pwPage.fill('input[name="username"]', user.username, { timeout: 10000 });
    await pwPage.fill('input[name="password"]', user.password, { timeout: 10000 });
    await Promise.all([
      pwPage.waitForURL(/\/dashboard\//, { timeout: 20000 }).catch(() => {}),
      pwPage.click('button[type="submit"]'),
    ]);
  } catch (err) {
    logger.warn(`[proactive-healer] Pre-probe login failed: ${err.message}`);
  }
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
        await authenticateIfNeeded(pwPage, baseUrl, route);
        await pwPage.goto(baseUrl + route, { timeout: 30000, waitUntil: 'domcontentloaded' });
        await pwPage.waitForLoadState('networkidle', { timeout: 15000 }).catch(() => {});

        const newLocators = { ...page.currentLocators };
        for (const [key, selector] of Object.entries(page.currentLocators)) {
          let count = 0;
          try { count = await pwPage.locator(selector).count(); } catch { count = 0; }
          if (count === 1) continue; // healthy — exactly one match

          // Skip conditional/collection locators whose count legitimately
          // varies with page state (errors shown only on failure, tables with
          // N rows, etc). Heal only when the *structural* selector is drifting.
          const COLLECTION_RE   = /(Rows|Items|List|Results|Cells|Options|Links|Errors|Tabs|Cards|Groups|Entries|Records)$/;
          const CONDITIONAL_RE  = /(Alert|Error|Notification|Toast|Warning|Empty|NoRecords|Success|Msg|Message|Loader|Spinner|Modal|Popup|Tooltip)$/i;
          if (count === 0 && CONDITIONAL_RE.test(key))  continue;
          if (count >  1 && COLLECTION_RE.test(key))     continue;

          pageInfo.broken.push({ key, count, selector });

          const label = deriveLabelFromKey(key);
          const nameAttr = deriveNameAttr(key);
          const isGroup  = /Group$/.test(key);
          const isInput  = /Input$/.test(key);
          const isButton = /Button$/.test(key);

          // Build candidate selectors in priority order. Each candidate is
          // validated to resolve to exactly ONE element in the live DOM before
          // being accepted.
          const candidates = [];

          // (1) Same-structure rewrite: keep the existing selector shape but
          //     replace every :text(…) / :text-is(…) atom with the key-derived
          //     label. This preserves semantics (group vs input vs button).
          if (label && /:text(-is)?\(/.test(selector)) {
            candidates.push(
              selector.replace(/:text(?:-is)?\((['"])[^'"]+\1\)/g, `:text-is("${label}")`)
            );
          }
          // (2) Strict-mode recovery — tighten :text to :text-is without
          //     changing the inner value (useful when label drift is not the
          //     cause and the text is already correct).
          if (count > 1 && /:text\(/.test(selector)) {
            candidates.push(selector.replace(/:text\(/g, ':text-is('));
          }

          // (3) Structural templates by key suffix (fallback when the current
          //     selector cannot be repaired in-place).
          if (isGroup && label) {
            candidates.push(`.oxd-input-group:has(label:text-is("${label}"))`);
          }
          if (isInput && label) {
            candidates.push(`.oxd-input-group:has(label:text-is("${label}")) input`);
            candidates.push(`.oxd-input-group:has(label:text-is("${label}")) input.oxd-input`);
          }
          if (isButton && label) {
            candidates.push(`button:has-text("${label}")`);
            candidates.push(`role=button[name="${label}"]`);
          }

          // (4) Attribute fallbacks derived from the key.
          candidates.push(`input[name="${nameAttr}"]`);
          candidates.push(`[data-testid="${nameAttr}"]`);
          candidates.push(`[data-testid="${camelToKebab(key)}"]`);
          candidates.push(`[aria-label="${label || nameAttr}"]`);
          candidates.push(`[placeholder*="${label || nameAttr}" i]`);

          let replacement = null;
          for (const sel of candidates) {
            let c = 0;
            try { c = await pwPage.locator(sel).count(); } catch { c = 0; }
            if (c === 1) { replacement = sel; break; }
          }

          // Fuzzy text-matching recovery — activates ONLY when all structured
          // candidates above have failed and the selector contains :text-is/matches.
          if (!replacement) {
            const fuzzy = await recoverTextBasedLocator(pwPage, selector, key);
            if (fuzzy) {
              let c = 0;
              try { c = await pwPage.locator(fuzzy.newSelector).count(); } catch { c = 0; }
              if (c === 1) replacement = fuzzy.newSelector;
            }
          }

          if (replacement) {
            newLocators[key] = replacement;
            pageInfo.healedKeys.push({ key, from: selector, to: replacement, reason: count > 1 ? `strict-${count}` : 'missing' });
            healed++;
          } else {
            // No healthy replacement found.
            //   count === 0: likely a conditional element not currently on the
            //     page (validation error, empty-state banner). Demote to info.
            //   count  >  1: genuine ambiguity — warn loudly so the team can
            //     disambiguate manually.
            pageInfo.manualKeys.push({ key, selector, count, healStatus: 'manual-review-needed' });
            const msg = `[proactive-healer] ${page.pageName}.${key} (matches=${count}) selector=${selector}`;
            if (count > 1) logger.warn(`${msg} — manual review`);
            else           logger.info(`${msg} — element not on page (conditional?); skipping`);
            manual++;
          }
        }

        // Write healed YAML if anything changed
        if (pageInfo.healedKeys.length > 0) {
          const ymlAbs = path.isAbsolute(page.ymlPath) ? page.ymlPath : path.join(ROOT, page.ymlPath);
          if (flags.dryRun) {
            logger.info(`[proactive-healer][dry-run] Would rewrite ${page.ymlPath} with ${pageInfo.healedKeys.length} healed locator(s)`);
          } else {
            const prior = fs.existsSync(ymlAbs) ? fs.readFileSync(ymlAbs, 'utf8') : '';
            const yamlText = serialiseYaml(newLocators, page.pageName, pageInfo.healedKeys.map(h => h.key), prior);
            writeFileAtomic(ymlAbs, yamlText);
            logger.info(`[proactive-healer] Rewrote ${page.ymlPath} (${pageInfo.healedKeys.length} healed)`);
            for (const h of pageInfo.healedKeys) {
              logger.info(`    • ${h.key}: ${h.reason || 'fix'}`);
              logger.info(`        - ${h.from}`);
              logger.info(`        + ${h.to}`);
            }
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
  // Exported for unit testing (fuzzy text-matching enhancement)
  levenshteinDistance,
  calculateLevenshteinSimilarity,
  recoverTextBasedLocator,
};
