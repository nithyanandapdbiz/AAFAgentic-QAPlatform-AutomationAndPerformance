/**
 * Screenshot Controller
 *
 * Provides REST API endpoints to:
 *   - List all captured screenshots (grouped by test)
 *   - Serve individual screenshot images
 *   - Get screenshot summary for the latest test run
 *   - Capture an on-demand screenshot via URL (utility endpoint)
 *
 * Screenshots are stored by the ScreenshotHelper during test execution at:
 *   test-results/screenshots/<test-slug>/<step>.png
 *
 * Endpoints:
 *   GET  /api/screenshots                — list all tests and their screenshots
 *   GET  /api/screenshots/:test          — list screenshots for a specific test
 *   GET  /api/screenshots/:test/:file    — serve a screenshot image
 *   GET  /api/screenshots/summary        — aggregated screenshot stats
 */
'use strict';
const fs   = require("fs");
const path = require("path");

const ROOT = path.resolve(__dirname, "..", "..");
const SCREENSHOTS_DIR = path.join(ROOT, "test-results", "screenshots");

// Also look at Playwright's default screenshot location
const PW_RESULTS_DIR = path.join(ROOT, "test-results");

/**
 * GET /api/screenshots
 * Returns all test directories and their screenshot files.
 */
function listAll(req, res) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    return res.json({ tests: [], message: "No screenshots captured yet" });
  }

  const tests = [];
  const dirs = fs.readdirSync(SCREENSHOTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory())
    .sort((a, b) => a.name.localeCompare(b.name));

  for (const dir of dirs) {
    const dirPath = path.join(SCREENSHOTS_DIR, dir.name);
    const files = fs.readdirSync(dirPath)
      .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
      .sort();
    
    tests.push({
      testName: dir.name,
      count: files.length,
      screenshots: files.map(f => ({
        filename: f,
        url: `/api/screenshots/${encodeURIComponent(dir.name)}/${encodeURIComponent(f)}`,
        step: extractStepLabel(f),
        size: fs.statSync(path.join(dirPath, f)).size,
        capturedAt: fs.statSync(path.join(dirPath, f)).mtime.toISOString()
      }))
    });
  }

  res.json({
    total: tests.reduce((sum, t) => sum + t.count, 0),
    tests
  });
}

/**
 * GET /api/screenshots/summary
 * Aggregated stats about captured screenshots.
 */
function getSummary(req, res) {
  if (!fs.existsSync(SCREENSHOTS_DIR)) {
    return res.json({ totalTests: 0, totalScreenshots: 0, totalSizeBytes: 0, tests: [] });
  }

  const dirs = fs.readdirSync(SCREENSHOTS_DIR, { withFileTypes: true })
    .filter(d => d.isDirectory());

  let totalScreenshots = 0;
  let totalSize = 0;
  const testSummaries = [];

  for (const dir of dirs) {
    const dirPath = path.join(SCREENSHOTS_DIR, dir.name);
    const files = fs.readdirSync(dirPath).filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f));
    const dirSize = files.reduce((sum, f) => sum + fs.statSync(path.join(dirPath, f)).size, 0);
    
    totalScreenshots += files.length;
    totalSize += dirSize;

    testSummaries.push({
      testName: dir.name,
      screenshotCount: files.length,
      sizeBytes: dirSize
    });
  }

  // Also count Playwright's default test-result screenshots
  let pwScreenshots = 0;
  if (fs.existsSync(PW_RESULTS_DIR)) {
    pwScreenshots = countPngRecursive(PW_RESULTS_DIR, 0);
  }

  res.json({
    totalTests: dirs.length,
    totalScreenshots,
    totalSizeBytes: totalSize,
    totalSizeMB: (totalSize / (1024 * 1024)).toFixed(2),
    playwrightDefaultScreenshots: pwScreenshots,
    tests: testSummaries.sort((a, b) => b.screenshotCount - a.screenshotCount)
  });
}

/**
 * GET /api/screenshots/:test
 * List screenshots for a specific test.
 */
function listByTest(req, res) {
  const testSlug = req.params.test;
  const dirPath = path.join(SCREENSHOTS_DIR, testSlug);

  if (!fs.existsSync(dirPath)) {
    return res.status(404).json({ error: `Test "${testSlug}" not found` });
  }

  const files = fs.readdirSync(dirPath)
    .filter(f => /\.(png|jpg|jpeg|gif|webp)$/i.test(f))
    .sort();

  res.json({
    testName: testSlug,
    count: files.length,
    screenshots: files.map(f => ({
      filename: f,
      url: `/api/screenshots/${encodeURIComponent(testSlug)}/${encodeURIComponent(f)}`,
      step: extractStepLabel(f),
      size: fs.statSync(path.join(dirPath, f)).size,
      capturedAt: fs.statSync(path.join(dirPath, f)).mtime.toISOString()
    }))
  });
}

/**
 * GET /api/screenshots/:test/:file
 * Serve a specific screenshot image.
 */
function serveScreenshot(req, res) {
  const testSlug = req.params.test;
  const fileName = req.params.file;

  const filePath = path.join(SCREENSHOTS_DIR, testSlug, fileName);
  const resolved = path.resolve(filePath);

  // Prevent path traversal — resolved path must stay within SCREENSHOTS_DIR
  if (!resolved.startsWith(path.resolve(SCREENSHOTS_DIR))) {
    return res.status(400).json({ error: "Invalid path" });
  }

  if (!fs.existsSync(filePath)) {
    return res.status(404).json({ error: "Screenshot not found" });
  }

  const ext = path.extname(fileName).toLowerCase();
  const mimeTypes = { ".png": "image/png", ".jpg": "image/jpeg", ".jpeg": "image/jpeg", ".gif": "image/gif", ".webp": "image/webp" };
  res.setHeader("Content-Type", mimeTypes[ext] || "image/png");
  res.setHeader("Cache-Control", "public, max-age=3600");
  fs.createReadStream(filePath).pipe(res);
}

// ── Helpers ─────────────────────────────────────────────────────────

function extractStepLabel(filename) {
  // step-01-open-login-page.png → "Open login page"
  const match = filename.match(/^step-\d+-(.+)\.(png|jpg|jpeg|gif|webp)$/i);
  if (match) return match[1].replace(/-/g, " ").replace(/\b\w/g, c => c.toUpperCase());
  return filename.replace(/\.(png|jpg|jpeg|gif|webp)$/i, "").replace(/-/g, " ");
}

function countPngRecursive(dir, depth) {
  if (depth > 3) return 0; // prevent deep recursion
  let count = 0;
  try {
    const entries = fs.readdirSync(dir, { withFileTypes: true });
    for (const e of entries) {
      if (e.name === "screenshots") continue; // already counted
      if (e.isFile() && /\.png$/i.test(e.name)) count++;
      if (e.isDirectory()) count += countPngRecursive(path.join(dir, e.name), depth + 1);
    }
  } catch { /* ignore permission errors */ }
  return count;
}

module.exports = { listAll, getSummary, listByTest, serveScreenshot };
