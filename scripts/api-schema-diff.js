'use strict';
/**
 * api-schema-diff.js
 * Stage 2b — Smart Proactive Healing (backend changes only)
 *
 * Uses Playwright network interception to capture real API responses
 * while navigating each affected page, then diffs response schemas
 * against stored baselines to detect field additions, removals, type changes.
 *
 * Output → heal-artifacts/api-schema-diff.json
 */

const { chromium } = require('playwright');
const fs           = require('fs');
const path         = require('path');

const BASE_URL   = process.env.BASE_URL     || 'https://opensource-demo.orangehrmlive.com';
const USERNAME   = process.env.AUT_USERNAME || 'Admin';
const PASSWORD   = process.env.AUT_PASSWORD || 'admin123';

const PAGE_ROUTES = {
  LoginPage:        '/web/index.php/auth/login',
  AddEmployeePage:  '/web/index.php/pim/addEmployee',
  EmployeeListPage: '/web/index.php/pim/viewEmployeeList',
};

const PAGE_API_PATTERNS = {
  AddEmployeePage:  [/\/api\/v\d+\/pim\/employees/],
  EmployeeListPage: [/\/api\/v\d+\/pim\/employees/, /\/api\/v\d+\/core\/search/],
  LoginPage:        [/\/api\/v\d+\/auth/],
};

const ARTIFACT_DIR  = path.join(process.cwd(), 'heal-artifacts');
const BASELINE_DIR  = path.join(ARTIFACT_DIR, 'api-baselines');

function log(msg)  { process.stdout.write(`[api-schema-diff] ${msg}\n`); }
function warn(msg) { process.stdout.write(`[api-schema-diff] WARN  ${msg}\n`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function extractSchema(obj, prefix = '') {
  const s = {};
  if (obj === null) { s[prefix || 'root'] = 'null'; return s; }
  if (Array.isArray(obj)) { s[prefix || 'root'] = 'array'; if (obj[0]) Object.assign(s, extractSchema(obj[0], `${prefix}[]`)); return s; }
  if (typeof obj === 'object') { for (const [k, v] of Object.entries(obj)) Object.assign(s, extractSchema(v, prefix ? `${prefix}.${k}` : k)); return s; }
  s[prefix] = typeof obj; return s;
}

function diffSchemas(baseline, current, endpoint) {
  const changes = [];
  const keys    = new Set([...Object.keys(baseline), ...Object.keys(current)]);
  for (const key of keys) {
    const bt = baseline[key]; const ct = current[key];
    if (bt === undefined)  changes.push({ endpoint, field: key, change: 'added',        type: ct });
    else if (ct === undefined) changes.push({ endpoint, field: key, change: 'removed',   wasType: bt });
    else if (bt !== ct)    changes.push({ endpoint, field: key, change: 'type-changed', from: bt, to: ct });
  }
  return changes;
}

function scanSpecAssertions() {
  const assertions = {};
  const specsDir   = path.join(process.cwd(), 'tests', 'specs');
  if (!fs.existsSync(specsDir)) return assertions;
  const patterns   = [/\.body\.(\w+(?:\.\w+)*)/g, /toHaveProperty\(['"`]([^'"`]+)['"`]\)/g];
  fs.readdirSync(specsDir).filter(f => f.endsWith('.spec.js')).forEach(file => {
    const content = fs.readFileSync(path.join(specsDir, file), 'utf8');
    const fields  = new Set();
    patterns.forEach(re => { let m; while ((m = re.exec(content)) !== null) fields.add(m[1]); });
    if (fields.size) assertions[file] = [...fields];
  });
  return assertions;
}

async function main() {
  ensureDir(ARTIFACT_DIR); ensureDir(BASELINE_DIR);

  const manifestPath = path.join(ARTIFACT_DIR, 'change-manifest.json');
  if (!fs.existsSync(manifestPath)) {
    log('No change-manifest.json — skipping (run classify-changes.js first)');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'api-schema-diff.json'), JSON.stringify({ skipped: true, reason: 'no-manifest', schemaDiffs: [], healingNeeded: [] }, null, 2));
    process.exit(0);
  }

  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  if (!manifest.changeTypes.hasBackend) {
    log('No backend changes — skipping API schema diff');
    fs.writeFileSync(path.join(ARTIFACT_DIR, 'api-schema-diff.json'), JSON.stringify({ skipped: true, reason: 'no-backend-changes', schemaDiffs: [], healingNeeded: [] }, null, 2));
    process.exit(0);
  }

  const targetPages = manifest.affectedPages.length > 0 ? manifest.affectedPages : Object.keys(PAGE_ROUTES);
  log(`Target pages: ${targetPages.join(', ')}`);

  const browser  = await chromium.launch({ headless: true });
  const context  = await browser.newContext();
  const authPage = await context.newPage();
  await authPage.goto(`${BASE_URL}/web/index.php/auth/login`, { waitUntil: 'domcontentloaded' });
  await authPage.fill('input[name="username"]', USERNAME);
  await authPage.fill('input[name="password"]', PASSWORD);
  await authPage.click('button[type="submit"]');
  await authPage.waitForURL(/dashboard/, { timeout: 30000 });
  await authPage.close();

  const captured = {};

  for (const pageName of targetPages) {
    const route    = PAGE_ROUTES[pageName];
    const patterns = PAGE_API_PATTERNS[pageName] || [];
    if (!route) continue;
    log(`\nIntercepting APIs for ${pageName}…`);
    const page = await context.newPage();
    page.on('response', async resp => {
      const url = resp.url();
      if (!patterns.some(p => p.test(url))) return;
      if (!resp.headers()['content-type']?.includes('application/json')) return;
      try {
        const body = await resp.json();
        const key  = `${resp.request().method()} ${new URL(url).pathname}`;
        captured[key] = { status: resp.status(), schema: extractSchema(body), sampleUrl: url, page: pageName };
        log(`  Captured: ${key} (${resp.status()})`);
      } catch {}
    });
    await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
    await page.waitForTimeout(1000);
    await page.close();
  }
  await browser.close();

  const schemaDiffs   = [];
  const healingNeeded = [];
  const specAssertions = scanSpecAssertions();

  for (const [endpoint, current] of Object.entries(captured)) {
    const safeKey  = endpoint.replace(/[^a-z0-9]/gi, '-');
    const basePath = path.join(BASELINE_DIR, `${safeKey}.json`);
    if (!fs.existsSync(basePath)) {
      log(`  Baseline created for ${endpoint}`);
      fs.writeFileSync(basePath, JSON.stringify({ status: current.status, schema: current.schema }, null, 2));
      continue;
    }
    const baseline = JSON.parse(fs.readFileSync(basePath, 'utf8'));
    const changes  = diffSchemas(baseline.schema, current.schema, endpoint);
    if (baseline.status !== current.status) changes.push({ endpoint, field: '__status__', change: 'type-changed', from: baseline.status, to: current.status });
    if (changes.length) {
      schemaDiffs.push({ endpoint, page: current.sampleUrl, changes });
      log(`  CHANGED: ${endpoint} — ${changes.length} difference(s)`);
      changes.forEach(c => log(`    ${c.change}: ${c.field}${c.from ? ` (${c.from} → ${c.to})` : ''}`));
      for (const ch of changes) {
        if (ch.change === 'removed' || ch.change === 'type-changed') {
          healingNeeded.push({
            endpoint, field: ch.field, changeType: ch.change, from: ch.from, to: ch.to,
            affectedSpecs: Object.entries(specAssertions)
              .filter(([, fields]) => fields.includes(ch.field)).map(([f]) => f),
          });
        }
      }
      fs.writeFileSync(basePath, JSON.stringify({ status: current.status, schema: current.schema }, null, 2));
    }
  }

  const out = path.join(ARTIFACT_DIR, 'api-schema-diff.json');
  fs.writeFileSync(out, JSON.stringify({ generatedAt: new Date().toISOString(), capturedApis: Object.keys(captured).length, schemaDiffs, healingNeeded }, null, 2));
  log(`\nAPI diff complete: ${schemaDiffs.length} endpoint(s) changed, ${healingNeeded.length} spec(s) need healing`);
  log(`Report → ${out}`);
  process.exit(schemaDiffs.length > 0 ? 1 : 0);
}

main().catch(err => { console.error('[api-schema-diff] FATAL:', err); process.exit(2); });
