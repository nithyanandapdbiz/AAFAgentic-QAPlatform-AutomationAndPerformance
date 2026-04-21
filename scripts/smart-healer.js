'use strict';
/**
 * smart-healer.js
 * Stage 3 — Smart Proactive Healing
 *
 * Reads all diff artifacts and applies three healing strategies:
 *
 *   A. Frontend  → patch Page Object YAML + .spec.js selectors
 *   B. Backend   → flag changed/removed API fields in spec assertions
 *   C. Config    → flag changed validation constraints in testData
 *
 * All three strategies also update matching Zephyr test steps.
 *
 * Flags: --dry-run (log only), --skip-zephyr
 * Exit 0 = no manual review needed  |  Exit 1 = items need human review
 */

const fs    = require('fs');
const path  = require('path');
const axios = require('axios');

const PAGES_DIR    = path.join(process.cwd(), 'tests', 'pages');
const SPECS_DIR    = path.join(process.cwd(), 'tests', 'specs');
const HEALED_DIR   = path.join(process.cwd(), 'tests', 'healed');
const ARTIFACT_DIR = path.join(process.cwd(), 'heal-artifacts');

const ZEPHYR_BASE_URL   = process.env.ZEPHYR_BASE_URL   || '';
const ZEPHYR_ACCESS_KEY = process.env.ZEPHYR_ACCESS_KEY || '';
const PROJECT_KEY       = process.env.PROJECT_KEY        || 'SCRUM';

const MIN_CONFIDENCE = 30;
const DRY_RUN        = process.argv.includes('--dry-run');
const SKIP_ZEPHYR    = process.argv.includes('--skip-zephyr');

function log(msg)  { process.stdout.write(`[smart-healer] ${msg}\n`); }
function warn(msg) { process.stdout.write(`[smart-healer] WARN  ${msg}\n`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function loadJSON(file, fallback) {
  const p = path.join(ARTIFACT_DIR, file);
  if (!fs.existsSync(p)) { warn(`${file} not found — using defaults`); return fallback; }
  try { return JSON.parse(fs.readFileSync(p, 'utf8')); } catch { return fallback; }
}

function safeWrite(filePath, content, label) {
  if (DRY_RUN) { log(`  DRY-RUN would write: ${label}`); return; }
  if (fs.existsSync(filePath)) fs.writeFileSync(`${filePath}.bak`, fs.readFileSync(filePath));
  fs.writeFileSync(filePath, content);
  log(`  Written: ${label}`);
}

function replaceAll(str, from, to) { return str.split(from).join(to); }

// ── Zephyr helpers ────────────────────────────────────────────────────────────
function zHeaders() { return { Authorization: `Bearer ${ZEPHYR_ACCESS_KEY}`, 'Content-Type': 'application/json' }; }

async function fetchTestCases() {
  if (SKIP_ZEPHYR || !ZEPHYR_ACCESS_KEY) return [];
  try {
    const r = await axios.get(`${ZEPHYR_BASE_URL}/testcases`, { headers: zHeaders(), params: { projectKey: PROJECT_KEY, maxResults: 500 }, timeout: 20000 });
    return r.data?.values || [];
  } catch (e) { warn(`Zephyr fetch failed: ${e.message}`); return []; }
}

async function fetchSteps(key) {
  try {
    const r = await axios.get(`${ZEPHYR_BASE_URL}/testcases/${key}/teststeps`, { headers: zHeaders(), timeout: 10000 });
    return r.data?.values || [];
  } catch { return []; }
}

async function putSteps(key, steps) {
  if (DRY_RUN) { log(`  DRY-RUN would PUT steps for ${key}`); return; }
  try {
    await axios.put(`${ZEPHYR_BASE_URL}/testcases/${key}/teststeps`,
      { mode: 'OVERWRITE', steps: steps.map(s => ({ inline: s.inline })) },
      { headers: zHeaders(), timeout: 15000 });
    log(`  Zephyr ${key} steps updated`);
  } catch (e) { warn(`Zephyr PUT failed for ${key}: ${e.message}`); }
}

// ── Strategy A: patch YAML locators ──────────────────────────────────────────
function patchYaml(pageName, broken) {
  const ymlPath = path.join(PAGES_DIR, `${pageName}.yml`);
  if (!fs.existsSync(ymlPath)) return [];
  let content = fs.readFileSync(ymlPath, 'utf8');
  const changes = [];
  for (const b of broken) {
    const { key, oldSelector, topCandidate } = b;
    if (!topCandidate || topCandidate.confidenceScore < MIN_CONFIDENCE) {
      warn(`  YAML skip "${key}" — confidence ${topCandidate?.confidenceScore ?? 0} < ${MIN_CONFIDENCE}`);
      continue;
    }
    const newSel = topCandidate.selector;
    const esc    = oldSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const re     = new RegExp(`(^${key}\\s*:\\s*)(['"]?)${esc}(['"]?)`, 'm');
    if (re.test(content)) {
      content = content.replace(re, `$1$2${newSel}$3`);
      changes.push({ file: ymlPath, key, oldSelector, newSelector: newSel, strategy: topCandidate.strategy, confidence: topCandidate.confidenceScore });
      log(`  YAML  "${key}": ${oldSelector}  →  ${newSel}  (${topCandidate.strategy}, score ${topCandidate.confidenceScore})`);
    } else {
      warn(`  YAML  "${key}": pattern not matched in file`);
    }
  }
  if (changes.length) safeWrite(ymlPath, content, `${pageName}.yml`);
  return changes;
}

// ── Strategy A: patch spec selectors ─────────────────────────────────────────
function patchSpecSelectors(pageName, broken) {
  const changes = []; ensureDir(HEALED_DIR);
  const pageKey = pageName.replace('Page', '').toLowerCase();
  const files   = fs.readdirSync(SPECS_DIR)
    .filter(f => f.endsWith('.spec.js') && f.toLowerCase().includes(pageKey))
    .map(f => path.join(SPECS_DIR, f));
  for (const specPath of files) {
    let content = fs.readFileSync(specPath, 'utf8');
    let modified = false; const fileChanges = [];
    for (const b of broken) {
      if (!b.topCandidate || b.topCandidate.confidenceScore < MIN_CONFIDENCE) continue;
      const { oldSelector, topCandidate: { selector: newSel } } = b;
      const count = (content.match(new RegExp(oldSelector.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g')) || []).length;
      if (count) {
        content = replaceAll(content, oldSelector, newSel);
        modified = true;
        fileChanges.push({ oldSelector, newSelector: newSel, count });
        log(`  SPEC  ${path.basename(specPath)} → "${b.key}" (${count} occ) ${oldSelector} → ${newSel}`);
      }
    }
    if (modified) {
      const header = `// SMART HEAL [FRONTEND] — ${new Date().toISOString()}\n`;
      const final  = content.startsWith('// SMART HEAL') ? content : header + content;
      safeWrite(path.join(HEALED_DIR, path.basename(specPath)), final, `healed/${path.basename(specPath)}`);
      safeWrite(specPath, final, path.basename(specPath));
      changes.push({ file: specPath, changes: fileChanges });
    }
  }
  return changes;
}

// ── Strategy B: flag removed/changed API fields ───────────────────────────────
function patchSpecAssertions(healingNeeded) {
  const changes = []; if (!healingNeeded?.length) return changes;
  ensureDir(HEALED_DIR);
  for (const item of healingNeeded) {
    const { field, changeType, from, to, affectedSpecs } = item;
    for (const specFile of (affectedSpecs || [])) {
      const specPath = path.join(SPECS_DIR, specFile);
      if (!fs.existsSync(specPath)) continue;
      let content = fs.readFileSync(specPath, 'utf8'); let modified = false;
      if (changeType === 'removed') {
        const patched = content.replace(new RegExp(`(expect\\([^)]+\\.${field}\\)[^;\\n]+)`, 'g'), `/* HEAL: field '${field}' removed from API — $1 */`);
        if (patched !== content) { content = patched; modified = true; changes.push({ file: specPath, field, changeType, action: 'commented-out' }); log(`  SPEC  ${specFile} — commented field "${field}" (removed)`); }
      }
      if (changeType === 'type-changed' && from && to) {
        const patched = content.replace(new RegExp(`(expect\\([^)]+\\.${field}\\)\\.toBe\\()([^)]+)(\\))`, 'g'), `$1/* HEAL: was ${from}, now ${to} */ $2$3`);
        if (patched !== content) { content = patched; modified = true; changes.push({ file: specPath, field, changeType, action: 'flagged', from, to }); log(`  SPEC  ${specFile} — flagged type change "${field}" (${from}→${to})`); }
      }
      if (modified) {
        const final = content.startsWith('// SMART HEAL') ? content : `// SMART HEAL [BACKEND] — ${new Date().toISOString()}\n` + content;
        safeWrite(path.join(HEALED_DIR, path.basename(specPath)), final, `healed/${path.basename(specPath)}`);
        safeWrite(specPath, final, path.basename(specPath));
      }
    }
  }
  return changes;
}

// ── Strategy C: flag validation constraint changes ────────────────────────────
function patchSpecTestData(validationChanges) {
  const changes = []; if (!validationChanges?.length) return changes;
  ensureDir(HEALED_DIR);
  const files = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.spec.js')).map(f => path.join(SPECS_DIR, f));
  for (const ch of validationChanges) {
    for (const specPath of files) {
      let content = fs.readFileSync(specPath, 'utf8');
      const patched = content.replace(new RegExp(`(testData.*?${ch.constraint}[^\\n]+)`, 'gi'),
        `$1 /* HEAL: ${ch.constraint} ${ch.changeType === 'added' ? 'now' : 'was'} ${ch.value} — review testData */`);
      if (patched !== content) {
        content = patched; changes.push({ file: specPath, constraint: ch.constraint, value: ch.value, changeType: ch.changeType });
        log(`  SPEC  ${path.basename(specPath)} — flagged constraint "${ch.constraint}" (${ch.changeType}: ${ch.value})`);
        const final = content.startsWith('// SMART HEAL') ? content : `// SMART HEAL [CONFIG] — ${new Date().toISOString()}\n` + content;
        safeWrite(path.join(HEALED_DIR, path.basename(specPath)), final, `healed/${path.basename(specPath)}`);
        safeWrite(specPath, final, path.basename(specPath));
      }
    }
  }
  return changes;
}

// ── Zephyr: unified pass ──────────────────────────────────────────────────────
async function healZephyrSteps(frontendBroken, apiHealingNeeded, configChanges) {
  if (SKIP_ZEPHYR || !ZEPHYR_ACCESS_KEY) { log('  Zephyr skipped'); return []; }
  const testCases = await fetchTestCases();
  log(`  Fetched ${testCases.length} test cases from Zephyr`);
  const zChanges = [];
  for (const tc of testCases) {
    const steps = await fetchSteps(tc.key); let tcChanged = false;
    const updated = steps.map(step => {
      let action = step.inline?.action || ''; let expected = step.inline?.expected || ''; let testData = step.inline?.testData || ''; let changed = false;
      for (const b of (frontendBroken || [])) {
        if (!b.topCandidate || b.topCandidate.confidenceScore < MIN_CONFIDENCE) continue;
        const { oldSelector, topCandidate: { selector: newSel } } = b;
        if (action.includes(oldSelector) || expected.includes(oldSelector)) {
          action = replaceAll(action, oldSelector, newSel); expected = replaceAll(expected, oldSelector, newSel);
          changed = true; zChanges.push({ testKey: tc.key, type: 'frontend', old: oldSelector, new: newSel });
        }
      }
      for (const item of (apiHealingNeeded || [])) {
        if (expected.includes(item.field)) {
          expected = `[HEAL: field '${item.field}' ${item.changeType}] ${expected}`;
          changed = true; zChanges.push({ testKey: tc.key, type: 'backend', field: item.field, changeType: item.changeType });
        }
      }
      for (const cfg of (configChanges || [])) {
        if (testData.toLowerCase().includes(cfg.constraint.toLowerCase())) {
          testData = `[HEAL: ${cfg.constraint} ${cfg.changeType === 'added' ? 'now' : 'was'} ${cfg.value}] ${testData}`;
          changed = true; zChanges.push({ testKey: tc.key, type: 'config', constraint: cfg.constraint, value: cfg.value });
        }
      }
      if (changed) tcChanged = true;
      return { ...step, inline: { ...step.inline, action, expected, testData } };
    });
    if (tcChanged) await putSteps(tc.key, updated);
  }
  return zChanges;
}

// ── Main ──────────────────────────────────────────────────────────────────────
async function main() {
  if (DRY_RUN) log('DRY-RUN mode active — nothing will be written');
  ensureDir(ARTIFACT_DIR); ensureDir(HEALED_DIR);

  const manifest    = loadJSON('change-manifest.json',  { changeTypes: {}, affectedPages: [], validationChanges: [] });
  const locatorDiff = loadJSON('locator-diff.json',      {});
  const apiDiff     = loadJSON('api-schema-diff.json',   { healingNeeded: [] });

  const report = { generatedAt: new Date().toISOString(), dryRun: DRY_RUN, strategies: {}, zephyrChanges: [], summary: { yamlChanges: 0, specChanges: 0, zephyrChanges: 0, manualReview: 0 } };
  const frontendBroken = [];

  // Strategy A — Frontend
  if (manifest.changeTypes.hasFrontend) {
    log('\n─── Strategy A: Frontend (locator patch) ───');
    let yamlTotal = 0; let specTotal = 0;
    for (const [pageName, { broken = [] }] of Object.entries(locatorDiff)) {
      if (!broken.length) continue;
      const yml  = patchYaml(pageName, broken);
      const spec = patchSpecSelectors(pageName, broken);
      yamlTotal += yml.length; specTotal += spec.reduce((n, f) => n + f.changes.length, 0);
      frontendBroken.push(...broken.filter(b => b.topCandidate?.confidenceScore >= MIN_CONFIDENCE));
      report.summary.manualReview += broken.filter(b => !b.topCandidate || b.topCandidate.confidenceScore < MIN_CONFIDENCE).length;
    }
    report.strategies.frontend = { yamlChanges: yamlTotal, specChanges: specTotal };
    report.summary.yamlChanges += yamlTotal; report.summary.specChanges += specTotal;
  } else log('\nStrategy A skipped — no frontend changes');

  // Strategy B — Backend
  if (manifest.changeTypes.hasBackend) {
    log('\n─── Strategy B: Backend (assertion flag) ───');
    const bc = patchSpecAssertions(apiDiff.healingNeeded);
    report.strategies.backend = { specChanges: bc.length };
    report.summary.specChanges += bc.length;
  } else log('\nStrategy B skipped — no backend changes');

  // Strategy C — Config
  if (manifest.changeTypes.hasConfig) {
    log('\n─── Strategy C: Config (testData flag) ───');
    const cc = patchSpecTestData(manifest.validationChanges);
    report.strategies.config = { specChanges: cc.length };
    report.summary.specChanges += cc.length;
  } else log('\nStrategy C skipped — no config changes');

  // Zephyr unified pass
  log('\n─── Zephyr sync ───');
  const zc = await healZephyrSteps(frontendBroken, apiDiff.healingNeeded, manifest.validationChanges);
  report.zephyrChanges = zc; report.summary.zephyrChanges = zc.length;

  const reportPath = path.join(ARTIFACT_DIR, 'smart-healing-report.json');
  if (!DRY_RUN) fs.writeFileSync(reportPath, JSON.stringify(report, null, 2));

  log('\n─────────────────────────────────────────');
  log(`Healing ${DRY_RUN ? '(DRY-RUN)' : 'complete'}`);
  log(`  YAML:    ${report.summary.yamlChanges}`);
  log(`  Specs:   ${report.summary.specChanges}`);
  log(`  Zephyr:  ${report.summary.zephyrChanges}`);
  log(`  Manual:  ${report.summary.manualReview}`);
  if (!DRY_RUN) log(`  Report:  ${reportPath}`);
  process.exit(report.summary.manualReview > 0 ? 1 : 0);
}

main().catch(err => { console.error('[smart-healer] FATAL:', err); process.exit(2); });
