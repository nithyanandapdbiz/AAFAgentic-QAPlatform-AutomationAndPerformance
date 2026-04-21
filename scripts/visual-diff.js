'use strict';
/**
 * visual-diff.js
 * Stage 2a — Smart Proactive Healing (frontend changes only)
 *
 * Captures full-page screenshots with Playwright and diffs them
 * pixel-by-pixel against stored baselines using pixelmatch.
 *
 * Baselines: heal-artifacts/baselines/<PageName>.png
 * Current:   heal-artifacts/visual-diff/<PageName>-current.png
 * Diff img:  heal-artifacts/visual-diff/<PageName>-diff.png
 * Report:    heal-artifacts/visual-diff-report.json
 *
 * Flags:
 *   --pages=LoginPage,AddEmployeePage  limit scope
 *   --all                              inspect all pages
 *   --update-baseline                  overwrite baselines with current
 *
 * Exit 0 = no visual changes (or first-run baseline created)
 * Exit 1 = one or more pages visually changed
 */

const { chromium }  = require('playwright');
const fs            = require('fs');
const path          = require('path');
const { PNG }       = require('pngjs');
const pixelmatch    = require('pixelmatch');

const BASE_URL   = process.env.BASE_URL     || 'https://opensource-demo.orangehrmlive.com';
const USERNAME   = process.env.AUT_USERNAME || 'Admin';
const PASSWORD   = process.env.AUT_PASSWORD || 'admin123';
const VIEWPORT   = { width: 1280, height: 900 };
const PX_THRESH  = 0.1;   // per-pixel colour tolerance 0–1
const CHG_PCT    = 0.5;   // % of pixels that must differ to flag a page as changed

const PAGE_ROUTES = {
  LoginPage:        '/web/index.php/auth/login',
  AddEmployeePage:  '/web/index.php/pim/addEmployee',
  EmployeeListPage: '/web/index.php/pim/viewEmployeeList',
};

const ARTIFACT_DIR = path.join(process.cwd(), 'heal-artifacts');
const BASELINE_DIR = path.join(ARTIFACT_DIR, 'baselines');
const DIFF_DIR     = path.join(ARTIFACT_DIR, 'visual-diff');

function log(msg)  { process.stdout.write(`[visual-diff] ${msg}\n`); }
function warn(msg) { process.stdout.write(`[visual-diff] WARN  ${msg}\n`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function resolvePages(argv) {
  if (argv.includes('--all')) return Object.keys(PAGE_ROUTES);
  const f = argv.find(a => a.startsWith('--pages'));
  if (!f) return Object.keys(PAGE_ROUTES);
  return f.replace(/^--pages[= ]/, '').split(',').map(p => p.trim()).filter(p => PAGE_ROUTES[p]);
}

async function screenshot(page, route, out) {
  await page.goto(`${BASE_URL}${route}`, { waitUntil: 'networkidle', timeout: 60000 });
  await page.waitForTimeout(800);
  await page.screenshot({ path: out, fullPage: true });
  log(`  screenshot → ${path.basename(out)}`);
}

function diffPngs(baselinePath, currentPath, diffOut) {
  const b = PNG.sync.read(fs.readFileSync(baselinePath));
  const c = PNG.sync.read(fs.readFileSync(currentPath));
  const w = Math.max(b.width,  c.width);
  const h = Math.max(b.height, c.height);

  function pad(img) {
    if (img.width === w && img.height === h) return img;
    const p = new PNG({ width: w, height: h }); p.data.fill(255);
    PNG.bitblt(img, p, 0, 0, img.width, img.height, 0, 0); return p;
  }

  const bp = pad(b); const cp = pad(c);
  const diff = new PNG({ width: w, height: h });
  const count = pixelmatch(bp.data, cp.data, diff.data, w, h, {
    threshold: PX_THRESH, includeAA: false,
    diffColor: [255, 0, 0], diffColorAlt: [0, 0, 255],
  });
  fs.writeFileSync(diffOut, PNG.sync.write(diff));

  const pct = (count / (w * h)) * 100;
  let minX = w, minY = h, maxX = 0, maxY = 0, any = false;
  for (let y = 0; y < h; y++) for (let x = 0; x < w; x++) {
    const i = (y * w + x) * 4;
    if (diff.data[i] > 200 && diff.data[i + 1] < 50) {
      any = true; minX = Math.min(minX, x); minY = Math.min(minY, y);
      maxX = Math.max(maxX, x); maxY = Math.max(maxY, y);
    }
  }
  return {
    diffPixels: count, totalPixels: w * h,
    changePct: parseFloat(pct.toFixed(2)), isChanged: pct > CHG_PCT,
    dimensions: { width: w, height: h },
    changedRegion: any
      ? { x: Math.max(0, minX - 20), y: Math.max(0, minY - 20), w: Math.min(w, maxX - minX + 40), h: Math.min(h, maxY - minY + 40) }
      : null,
  };
}

async function main() {
  const argv          = process.argv.slice(2);
  const targetPages   = resolvePages(argv);
  const updateBase    = argv.includes('--update-baseline');

  ensureDir(ARTIFACT_DIR); ensureDir(BASELINE_DIR); ensureDir(DIFF_DIR);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({ viewport: VIEWPORT });

  // authenticate
  log(`Authenticating at ${BASE_URL}…`);
  const ap = await context.newPage();
  await ap.goto(`${BASE_URL}/web/index.php/auth/login`, { waitUntil: 'domcontentloaded' });
  await ap.fill('input[name="username"]', USERNAME);
  await ap.fill('input[name="password"]', PASSWORD);
  await ap.click('button[type="submit"]');
  await ap.waitForURL(/dashboard/, { timeout: 30000 });
  await ap.close();
  log('Authenticated');

  const report = { generatedAt: new Date().toISOString(), pages: {}, summary: { changed: 0, unchanged: 0, baseline: 0 } };

  for (const pageName of targetPages) {
    const route = PAGE_ROUTES[pageName];
    if (!route) { warn(`No route for ${pageName}`); continue; }
    log(`\nProcessing ${pageName}…`);

    const basePath = path.join(BASELINE_DIR, `${pageName}.png`);
    const curPath  = path.join(DIFF_DIR,     `${pageName}-current.png`);
    const diffPath = path.join(DIFF_DIR,     `${pageName}-diff.png`);

    const pg = await context.newPage();
    await screenshot(pg, route, curPath);
    await pg.close();

    if (!fs.existsSync(basePath) || updateBase) {
      fs.copyFileSync(curPath, basePath);
      log(`  Baseline ${updateBase ? 'updated' : 'created'}: ${basePath}`);
      report.pages[pageName] = { status: 'baseline-created', isChanged: false };
      report.summary.baseline++;
      continue;
    }

    const r = diffPngs(basePath, curPath, diffPath);
    log(`  Pixel diff: ${r.diffPixels}/${r.totalPixels} (${r.changePct}%) — changed: ${r.isChanged}`);
    if (r.changedRegion) { const cr = r.changedRegion; log(`  Region: x=${cr.x} y=${cr.y} w=${cr.w} h=${cr.h}`); }

    report.pages[pageName] = {
      status:        r.isChanged ? 'changed' : 'unchanged',
      isChanged:     r.isChanged, changePct: r.changePct,
      diffPixels:    r.diffPixels, totalPixels: r.totalPixels,
      dimensions:    r.dimensions, changedRegion: r.changedRegion,
      baselinePath:  path.relative(process.cwd(), basePath),
      currentPath:   path.relative(process.cwd(), curPath),
      diffPath:      r.isChanged ? path.relative(process.cwd(), diffPath) : null,
    };
    if (r.isChanged) report.summary.changed++; else report.summary.unchanged++;
  }

  await browser.close();

  const rp = path.join(ARTIFACT_DIR, 'visual-diff-report.json');
  fs.writeFileSync(rp, JSON.stringify(report, null, 2));
  log(`\nChanged: ${report.summary.changed}  Unchanged: ${report.summary.unchanged}  Baselines: ${report.summary.baseline}`);
  log(`Report → ${rp}`);

  // auto-ratchet baselines on main when all clear
  if (process.env.GITHUB_REF_NAME === 'main' && report.summary.changed === 0) {
    targetPages.forEach(p => {
      const cur = path.join(DIFF_DIR, `${p}-current.png`);
      const base = path.join(BASELINE_DIR, `${p}.png`);
      if (fs.existsSync(cur)) fs.copyFileSync(cur, base);
    });
    log('Baselines auto-updated on main branch');
  }

  process.exit(report.summary.changed > 0 ? 1 : 0);
}

main().catch(err => { console.error('[visual-diff] FATAL:', err); process.exit(2); });
