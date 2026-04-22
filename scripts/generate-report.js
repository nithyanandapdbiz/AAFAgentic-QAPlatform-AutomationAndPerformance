'use strict';
/**
 * generate-report.js
 *
 * Reads test-results.json (Playwright JSON reporter output) and generates
 * a single self-contained HTML report at custom-report/index.html.
 *
 * Features:
 *  - Summary dashboard with pass/fail/blocked counts and a pie-chart
 *  - Per-test collapsible accordion cards (Pass = green, Fail = red)
 *  - Step-by-step table with duration + pass/fail badge per step
 *  - Failure step highlighted in red with inline error message
 *  - End-of-test screenshot embedded as base64 (captured for every test)
 *  - Video recording embedded as <video> element (WebM, failed tests only, body-based base64)
 *  - Step screenshots from ScreenshotHelper also shown
 *  - Allure report link in header (when allure-report/ exists)
 *
 * Usage:
 *   node scripts/generate-report.js
 */

const fs   = require('fs');
const path = require('path');
require('./ensure-dirs');  // ensure output dirs exist before report generation

const ROOT              = path.resolve(__dirname, '..');
const RESULTS_FILE      = path.join(ROOT, 'test-results.json');
const SCREENSHOTS_ROOT  = path.join(ROOT, 'test-results', 'screenshots');
const OUT_DIR           = path.join(ROOT, 'custom-report');
const OUT_FILE          = path.join(OUT_DIR, 'index.html');
const ALLURE_DIR        = path.join(ROOT, 'allure-report');

// ─── JSON walker ─────────────────────────────────────────────────────────────
/**
 * Walk Playwright JSON suites and collect flat list of test records.
 * Each record: { zephyrKey, title, status, duration, errorMsg,
 *               steps[], failureScreenshot, videoPath, screenshots[] }
 */
function collectTests(suites, parentFile = '') {
  const out = [];
  for (const suite of (suites || [])) {
    const file = suite.file || parentFile;
    const keyMatch  = path.basename(file).match(/^(SCRUM-T\d+)_/i);
    const zephyrKey = keyMatch ? keyMatch[1].toUpperCase() : '–';

    if (suite.suites && suite.suites.length) {
      out.push(...collectTests(suite.suites, file));
    }

    for (const spec of (suite.specs || [])) {
      let status   = 'Not Executed';
      let duration = 0;
      let errorMsg = '';
      let steps    = [];
      let failureScreenshot = null;
      let videoPath         = null;
      let stepScreenshots   = [];   // populated from JSON body attachments below

      if (Array.isArray(spec.tests) && spec.tests.length) {
        const lastTest = spec.tests[spec.tests.length - 1];
        if (Array.isArray(lastTest.results) && lastTest.results.length) {
          const lastResult = lastTest.results[lastTest.results.length - 1];
          duration = lastResult.duration || 0;

          switch (lastResult.status) {
            case 'passed':   status = 'Pass';         break;
            case 'failed':   status = 'Fail';         break;
            case 'timedOut': status = 'Blocked';      break;
            case 'skipped':  status = 'Not Executed'; break;
            default:         status = 'Fail';
          }

          // Extract error message — include full message, snippet, and stack trace
          if (lastResult.error) {
            const errParts = [];
            const errMsg = lastResult.error.message || String(lastResult.error);
            errParts.push(errMsg);
            if (lastResult.error.snippet) {
              errParts.push('\n── Code Snippet ──\n' + lastResult.error.snippet);
            }
            if (lastResult.error.stack && lastResult.error.stack !== errMsg) {
              errParts.push('\n── Stack Trace ──\n' + lastResult.error.stack);
            }
            errorMsg = errParts.join('\n').slice(0, 4000);
          }

          // Extract steps array — flatten nested steps one level deep
          function flattenSteps(rawSteps) {
            const flat = [];
            for (const s of (rawSteps || [])) {
              flat.push(s);
              if (Array.isArray(s.steps) && s.steps.length) {
                for (const child of s.steps) flat.push(Object.assign({}, child, { _child: true }));
              }
            }
            return flat;
          }
          const rawSteps = lastResult.steps || [];
          steps = flattenSteps(rawSteps).map(s => ({
            title:    s.title || '(step)',
            duration: s.duration || 0,
            error:    s.error ? (s.error.message || String(s.error)).slice(0, 1500) : null,
            stack:    s.error && s.error.stack ? s.error.stack.slice(0, 1500) : null,
            snippet:  s.error && s.error.snippet ? s.error.snippet.slice(0, 800) : null,
            child:    !!s._child
          }));

          // Extract Playwright-generated attachments
          // Step screenshots are stored as body (base64) — NOT as file paths.
          // The Playwright auto-screenshot and video use file paths (may be
          // missing after test-results is cleaned); the afterEach fixture
          // also attaches a 'failure-screenshot' body as a reliable fallback.
          let failureScreenshotDataUrl = null;
          let failureScreenshotPath    = null;

          for (const att of (lastResult.attachments || [])) {
            const attPath = att.path || null;
            const attBody = att.body || null;  // base64 string from JSON

            if (att.contentType === 'image/png') {
              if (att.name === 'screenshot') {
                // Playwright auto-screenshot — file may not exist if cleaned
                failureScreenshotPath = attPath;
              } else if (att.name === 'failure-screenshot') {
                // Body-based screenshot from afterEach hook — always in JSON
                if (attBody && !failureScreenshotDataUrl) {
                  failureScreenshotDataUrl = 'data:image/png;base64,' + attBody;
                }
              } else if (attBody) {
                // Step screenshot from ScreenshotHelper — body-only, named
                // "01. <label>", "02. <label>", etc.
                stepScreenshots.push({
                  label:   att.name || 'screenshot',
                  dataUrl: 'data:image/png;base64,' + attBody,
                });
              }
            }

            if (att.contentType === 'video/webm' && att.name === 'video') {
              // Body-based (embedded by base.fixture.js page override) takes
              // priority; path-based is the old fallback kept for compatibility.
              if (att.body) {
                videoPath = 'data:video/webm;base64,' + att.body;
              } else if (att.path) {
                videoPath = att.path;
              }
            }
          }

          // Resolve final failure screenshot:
          //   1. prefer body from 'failure-screenshot' (always in JSON)
          //   2. fall back to Playwright path-based auto-screenshot (file must exist)
          if (failureScreenshotDataUrl) {
            failureScreenshot = failureScreenshotDataUrl;
          } else if (failureScreenshotPath) {
            const b64 = toBase64Png(failureScreenshotPath);
            if (b64) failureScreenshot = b64;
          }
        }
      } else if (typeof spec.ok === 'boolean') {
        status = spec.ok ? 'Pass' : 'Fail';
      }

      // Step screenshots already collected from JSON body attachments above.
      // Fall back to disk if the JSON had no body attachments (e.g. older runs).
      const screenshots = stepScreenshots.length
        ? stepScreenshots
        : loadScreenshots(spec.title);

      out.push({
        zephyrKey, title: spec.title, status, duration, errorMsg,
        steps, failureScreenshot, videoPath, screenshots
      });
    }
  }
  return out;
}

/**
 * Load all step screenshots for a test from
 * test-results/screenshots/<title-slug>/*.png — sorted alphabetically.
 */
function loadScreenshots(title) {
  const slug = (title || 'test')
    .replace(/[^a-z0-9]+/gi, '-')
    .replace(/^-|-$/g, '')
    .slice(0, 60)
    .toLowerCase();
  const dir = path.join(SCREENSHOTS_ROOT, slug);
  if (!fs.existsSync(dir)) return [];
  return fs.readdirSync(dir)
    .filter(f => f.endsWith('.png'))
    .sort()
    .map(f => ({
      label: f.replace(/\.png$/, '').replace(/^step-\d+-/, '').replace(/-/g, ' '),
      path:  path.join(dir, f)
    }));
}

// ─── Base64 helpers ───────────────────────────────────────────────────────────
function toBase64Png(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return 'data:image/png;base64,' + fs.readFileSync(filePath).toString('base64');
  } catch { return ''; }
}

function toBase64Webm(filePath) {
  try {
    if (!filePath || !fs.existsSync(filePath)) return '';
    return 'data:video/webm;base64,' + fs.readFileSync(filePath).toString('base64');
  } catch { return ''; }
}

// kept for backward compat (old callers used toBase64)
function toBase64(filePath) { return toBase64Png(filePath); }

// ─── Duration formatter ───────────────────────────────────────────────────────
function fmtDuration(ms) {
  if (ms >= 60000) return `${(ms / 60000).toFixed(1)}m`;
  if (ms >= 1000)  return `${(ms / 1000).toFixed(1)}s`;
  return `${ms}ms`;
}

// ─── HTML builder ─────────────────────────────────────────────────────────────
function buildHtml(tests, runDate, totalDuration) {
  const total    = tests.length;
  const passed   = tests.filter(t => t.status === 'Pass').length;
  const failed   = tests.filter(t => t.status === 'Fail').length;
  const blocked  = tests.filter(t => t.status === 'Blocked').length;
  const notExec  = tests.filter(t => t.status === 'Not Executed').length;
  const passRate = total ? Math.round((passed / total) * 100) : 0;

  // ── Pie chart % (CSS conic-gradient) ──────────────────────────────────────
  const pPass    = total ? (passed  / total) * 360 : 0;
  const pFail    = total ? (failed  / total) * 360 : 0;
  const pBlocked = total ? (blocked / total) * 360 : 0;

  const pieGrad = [
    `#4caf50 0deg ${pPass}deg`,
    `#f44336 ${pPass}deg ${pPass + pFail}deg`,
    `#ff9800 ${pPass + pFail}deg ${pPass + pFail + pBlocked}deg`,
    `#9e9e9e ${pPass + pFail + pBlocked}deg 360deg`
  ].join(', ');

  const allureLink = fs.existsSync(ALLURE_DIR)
    ? `<a href="../allure-report/index.html" target="_blank" class="allure-btn">View Allure Report →</a>`
    : '';

  // ── Test cards HTML ────────────────────────────────────────────────────────
  const cards = tests.map((t, idx) => {
    const statusClass = {
      Pass: 'pass', Fail: 'fail', Blocked: 'blocked', 'Not Executed': 'not-exec'
    }[t.status] || 'not-exec';

    const statusIcon = { Pass: '✓', Fail: '✗', Blocked: '⊘', 'Not Executed': '○' }[t.status] || '○';

    // ── Step table ──────────────────────────────────────────────────────────
    let stepTableHtml = '';
    if (t.steps && t.steps.length) {
      const rows = t.steps.map((s, si) => {
        const isFailed = !!s.error;
        const rowClass = isFailed ? 'step-fail' : 'step-pass';
        const badge    = isFailed
          ? `<span class="step-badge fail">✗ FAILED</span>`
          : `<span class="step-badge pass">✓ Pass</span>`;
        const indent   = s.child ? 'style="padding-left:28px;color:#546e7a;"' : '';
        // Build detailed error block with snippet and stack
        let errRow = '';
        if (isFailed) {
          const errParts = [`<pre class="step-error">${escHtml(s.error)}</pre>`];
          if (s.snippet) {
            errParts.push(`<details class="step-err-details"><summary>Code Snippet</summary><pre class="step-error step-snippet">${escHtml(s.snippet)}</pre></details>`);
          }
          if (s.stack) {
            errParts.push(`<details class="step-err-details"><summary>Stack Trace</summary><pre class="step-error step-stack">${escHtml(s.stack)}</pre></details>`);
          }
          errRow = `<tr class="step-err-row"><td colspan="4">${errParts.join('\n')}</td></tr>`;
        }
        return `<tr class="${rowClass}">
          <td class="step-num">${si + 1}</td>
          <td class="step-title" ${indent}>${escHtml(s.title)}</td>
          <td class="step-dur">${fmtDuration(s.duration)}</td>
          <td class="step-status">${badge}</td>
        </tr>${errRow}`;
      }).join('');

      stepTableHtml = `
      <div class="steps-section">
        <h4>Test Steps (${t.steps.filter(s => !s.child).length})</h4>
        <table class="steps-table">
          <thead><tr>
            <th>#</th><th>Step</th><th>Duration</th><th>Status</th>
          </tr></thead>
          <tbody>${rows}</tbody>
        </table>
      </div>`;
    }

    // ── End-of-test / failure screenshot ─────────────────────────────────────────────────
    // t.failureScreenshot is already a data URL (resolved during collection)
    let failureScreenshotHtml = '';
    if (t.failureScreenshot) {
      const isPass  = t.status === 'Pass';
      const caption = isPass ? 'Final state at test end' : 'Captured at point of failure';
      const figClass = isPass ? 'screenshot-figure end-shot' : 'screenshot-figure failure-shot';
      failureScreenshotHtml = `
      <div class="failure-media">
        <h4>Screenshot</h4>
        <figure class="${figClass}">
          <img src="${t.failureScreenshot}" alt="End-of-test screenshot" loading="lazy" onclick="openLightbox(this)">
          <figcaption>${caption}</figcaption>
        </figure>
      </div>`;
    }

    // ── Video recording (failed/blocked tests only) ──────────────────────────────────────────
    let videoHtml = '';
    if (t.videoPath && t.status !== 'Pass') {
      // videoPath is already a data URL when the body was embedded by base.fixture.js;
      // for legacy runs where only the file path was recorded, fall back to reading disk.
      let videoSrc = '';
      if (t.videoPath.startsWith('data:')) {
        videoSrc = t.videoPath;                  // body-based — always available
      } else {
        const b64 = toBase64Webm(t.videoPath);   // path-based — file must still exist
        if (b64) videoSrc = b64;
      }

      if (videoSrc) {
        videoHtml = `
      <div class="failure-media">
        <h4>Video Recording</h4>
        <video class="test-video" controls preload="metadata">
          <source src="${videoSrc}" type="video/webm">
          Your browser does not support WebM video.
        </video>
      </div>`;
      } else {
        // File was cleaned from disk after test run — show informational notice
        const shortName = t.videoPath.split(/[\\/]/).pop();
        videoHtml = `
      <div class="failure-media">
        <h4>Video Recording</h4>
        <div class="video-missing">
          ⚠️ Video file not available — re-run tests to regenerate.
          <code>${escHtml(shortName)}</code>
        </div>
      </div>`;
      }
    }

    // ── Step screenshots (from ScreenshotHelper, body-based in JSON) ───────────
    const screenshotHtml = t.screenshots.length
      ? `<div class="steps-section">
          <h4>Step Screenshots (${t.screenshots.length})</h4>
          <div class="screenshots">
          ${t.screenshots.map(s => {
            // dataUrl is pre-populated from JSON body; path is disk fallback
            const imgSrc = s.dataUrl || toBase64(s.path);
            return imgSrc
              ? `<figure class="screenshot-figure">
                  <img src="${imgSrc}" alt="${escHtml(s.label)}" loading="lazy" onclick="openLightbox(this)">
                  <figcaption>${escHtml(s.label)}</figcaption>
                </figure>`
              : '';
          }).join('')}
          </div>
        </div>`
      : '';

    const errorHtml = t.errorMsg
      ? `<div class="error-section">
          <pre class="error-block">${escHtml(t.errorMsg)}</pre>
        </div>`
      : '';

    return `
    <details class="test-card ${statusClass}" id="test-${idx}">
      <summary>
        <span class="status-badge ${statusClass}">${statusIcon} ${t.status}</span>
        <span class="tc-key">${t.zephyrKey}</span>
        <span class="tc-title">${escHtml(t.title)}</span>
        <span class="tc-duration">${fmtDuration(t.duration)}</span>
      </summary>
      <div class="card-body">
        ${errorHtml}
        ${stepTableHtml}
        ${failureScreenshotHtml}
        ${videoHtml}
        ${screenshotHtml}
      </div>
    </details>`;
  }).join('\n');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>OrangeHRM — Playwright Test Report</title>
<style>
  *, *::before, *::after { box-sizing: border-box; margin: 0; padding: 0; }
  body { font-family: -apple-system, BlinkMacSystemFont, 'Segoe UI', Roboto, sans-serif;
         background: #f0f2f5; color: #212121; }

  /* ── Header ────────────────────────────────────────────────────────────── */
  header {
    background: linear-gradient(135deg, #1a237e 0%, #283593 100%);
    color: #fff;
    padding: 24px 32px;
    display: flex;
    justify-content: space-between;
    align-items: center;
    box-shadow: 0 2px 8px rgba(0,0,0,.3);
  }
  header h1 { font-size: 1.5rem; font-weight: 700; }
  header h1 span { font-weight: 300; opacity: .75; font-size: 1rem; display: block; }
  header .meta { text-align: right; font-size: .82rem; opacity: .8; line-height: 1.6; }
  .allure-btn {
    display: inline-block; margin-top: 8px; padding: 6px 14px;
    background: #7c4dff; color: #fff; border-radius: 6px; font-size: .8rem;
    font-weight: 600; text-decoration: none; letter-spacing: .03em;
    transition: background .2s;
  }
  .allure-btn:hover { background: #651fff; }

  /* ── Steps table ────────────────────────────────────────────────────────── */
  .steps-section { margin-bottom: 20px; }
  .steps-section h4 { font-size: .85rem; color: #546e7a; margin-bottom: 10px;
                      text-transform: uppercase; letter-spacing: .05em; }
  .steps-table { width: 100%; border-collapse: collapse; font-size: .82rem; }
  .steps-table thead tr { background: #eceff1; }
  .steps-table th {
    text-align: left; padding: 8px 10px; font-size: .75rem;
    text-transform: uppercase; letter-spacing: .04em; color: #546e7a;
    border-bottom: 2px solid #cfd8dc;
  }
  .steps-table td { padding: 8px 10px; border-bottom: 1px solid #f5f5f5; vertical-align: top; }
  .steps-table .step-num { width: 36px; text-align: center; color: #9e9e9e; font-weight: 700; }
  .steps-table .step-dur { width: 80px; text-align: right; color: #78909c; white-space: nowrap; }
  .steps-table .step-status { width: 100px; text-align: center; }
  .steps-table tr.step-fail td { background: #fff5f5; }
  .steps-table tr.step-pass:hover td { background: #f9fbe7; }
  .step-badge { padding: 2px 8px; border-radius: 10px; font-size: .7rem;
                font-weight: 700; text-transform: uppercase; }
  .step-badge.pass  { background: #e8f5e9; color: #1b5e20; }
  .step-badge.fail  { background: #ffebee; color: #b71c1c; }
  .step-err-row td { padding: 4px 10px 10px 46px; border-bottom: 1px solid #f5f5f5; }
  .step-error { font-size: .76rem; color: #b71c1c; white-space: pre-wrap;
                word-break: break-word; background: #fff0f0; padding: 8px;
                border-radius: 4px; border: 1px solid #ffcdd2; }
  .step-err-details { margin-top: 6px; }
  .step-err-details summary { cursor: pointer; font-size: .74rem; color: #546e7a;
                              font-weight: 600; margin-bottom: 4px; }
  .step-snippet { background: #fff8e1; border-color: #ffe082; color: #e65100; }
  .step-stack   { background: #f3e5f5; border-color: #ce93d8; color: #4a148c; font-size: .7rem; }

  /* ── Failure media ───────────────────────────────────────────────────────── */
  .failure-media { margin-bottom: 20px; }
  .failure-media h4 { font-size: .85rem; color: #546e7a; margin-bottom: 10px;
                       text-transform: uppercase; letter-spacing: .05em; }
  .failure-shot img { max-height: 400px; width: auto; border: 2px solid #f44336; border-radius: 4px; }
  .end-shot img     { max-height: 400px; width: auto; border: 2px solid #4caf50; border-radius: 4px; }
  .test-video { width: 100%; max-width: 720px; border-radius: 6px;
                border: 1px solid #e0e0e0; background: #000; display: block; }
  .video-missing { display: inline-flex; align-items: center; gap: 10px;
                   background: #fff8e1; border: 1px solid #ffe082; border-radius: 6px;
                   padding: 10px 16px; font-size: .82rem; color: #795548; }
  .video-missing code { background: #f5f5f5; padding: 2px 6px; border-radius: 3px;
                        font-size: .78rem; color: #455a64; }

  /* ── Summary bar ────────────────────────────────────────────────────────── */
  .summary-bar {
    display: flex;
    flex-wrap: wrap;
    gap: 16px;
    padding: 24px 32px;
    background: #fff;
    border-bottom: 1px solid #e0e0e0;
  }
  .stat-card {
    flex: 1 1 100px;
    background: #fafafa;
    border: 1px solid #e0e0e0;
    border-radius: 10px;
    padding: 14px 20px;
    text-align: center;
  }
  .stat-card .stat-value { font-size: 2rem; font-weight: 700; line-height: 1; }
  .stat-card .stat-label { font-size: .75rem; text-transform: uppercase;
                           letter-spacing: .06em; color: #757575; margin-top: 4px; }
  .stat-card.pass   { border-color: #4caf50; }
  .stat-card.pass   .stat-value { color: #4caf50; }
  .stat-card.fail   { border-color: #f44336; }
  .stat-card.fail   .stat-value { color: #f44336; }
  .stat-card.blocked{ border-color: #ff9800; }
  .stat-card.blocked .stat-value { color: #ff9800; }
  .stat-card.total  { border-color: #1a237e; }
  .stat-card.total  .stat-value { color: #1a237e; }

  /* ── Pie chart ──────────────────────────────────────────────────────────── */
  .pie-wrap { display: flex; align-items: center; gap: 16px; }
  .pie {
    width: 90px; height: 90px; border-radius: 50%;
    background: conic-gradient(${pieGrad});
    flex-shrink: 0;
  }
  .pie-legend { font-size: .78rem; line-height: 2; }
  .pie-legend span { display: inline-block; width: 10px; height: 10px;
                     border-radius: 2px; margin-right: 5px; vertical-align: middle; }
  .pass-dot { background: #4caf50; }
  .fail-dot { background: #f44336; }
  .blocked-dot { background: #ff9800; }
  .notexec-dot { background: #9e9e9e; }

  /* ── Progress bar ───────────────────────────────────────────────────────── */
  .progress-wrap { padding: 0 32px 16px; background: #fff; }
  .progress-bar-outer { height: 8px; background: #e0e0e0; border-radius: 4px; overflow: hidden; }
  .progress-bar-inner { height: 100%; background: #4caf50;
                        width: ${passRate}%; transition: width .5s; border-radius: 4px; }
  .progress-label { font-size: .8rem; color: #757575; margin-top: 4px; }

  /* ── Test cards ─────────────────────────────────────────────────────────── */
  .tests-section { padding: 24px 32px; }
  .tests-section h2 { font-size: 1.1rem; color: #37474f; margin-bottom: 16px; border-bottom: 2px solid #eceff1; padding-bottom: 8px; }

  details.test-card {
    background: #fff;
    border-radius: 10px;
    margin-bottom: 10px;
    border-left: 5px solid #9e9e9e;
    box-shadow: 0 1px 4px rgba(0,0,0,.08);
    overflow: hidden;
    transition: box-shadow .2s;
  }
  details.test-card:hover { box-shadow: 0 3px 10px rgba(0,0,0,.12); }
  details.test-card.pass    { border-left-color: #4caf50; }
  details.test-card.fail    { border-left-color: #f44336; }
  details.test-card.blocked { border-left-color: #ff9800; }

  details.test-card > summary {
    display: flex;
    align-items: center;
    gap: 14px;
    padding: 14px 18px;
    cursor: pointer;
    user-select: none;
    list-style: none;
  }
  details.test-card > summary::-webkit-details-marker { display: none; }
  details[open] > summary { border-bottom: 1px solid #eceff1; }

  .status-badge {
    padding: 3px 10px;
    border-radius: 12px;
    font-size: .72rem;
    font-weight: 700;
    text-transform: uppercase;
    letter-spacing: .05em;
    white-space: nowrap;
    flex-shrink: 0;
  }
  .status-badge.pass     { background: #e8f5e9; color: #1b5e20; }
  .status-badge.fail     { background: #ffebee; color: #b71c1c; }
  .status-badge.blocked  { background: #fff3e0; color: #e65100; }
  .status-badge.not-exec { background: #f5f5f5; color: #616161; }

  .tc-key      { font-size: .8rem; font-weight: 700; color: #1a237e; flex-shrink: 0; }
  .tc-title    { flex: 1; font-size: .88rem; color: #212121; }
  .tc-duration { font-size: .78rem; color: #9e9e9e; flex-shrink: 0; }

  /* ── Card body ──────────────────────────────────────────────────────────── */
  .card-body { padding: 18px 20px; }
  .card-body h4 { font-size: .85rem; color: #546e7a; margin-bottom: 12px; text-transform: uppercase; letter-spacing: .05em; }

  .error-block {
    background: #fff5f5;
    border: 1px solid #ffcdd2;
    border-radius: 6px;
    padding: 12px;
    font-size: .78rem;
    color: #b71c1c;
    white-space: pre-wrap;
    word-break: break-word;
    margin-bottom: 16px;
  }

  /* ── Screenshots ────────────────────────────────────────────────────────── */
  .screenshots {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(260px, 1fr));
    gap: 16px;
  }
  .screenshot-figure {
    border: 1px solid #e0e0e0;
    border-radius: 8px;
    overflow: hidden;
    background: #fafafa;
  }
  .screenshot-figure img {
    width: 100%;
    display: block;
    cursor: zoom-in;
    transition: opacity .2s;
  }
  .screenshot-figure img:hover { opacity: .9; }
  .screenshot-figure figcaption {
    padding: 6px 10px;
    font-size: .72rem;
    color: #546e7a;
    background: #f5f5f5;
    border-top: 1px solid #e0e0e0;
    text-transform: capitalize;
  }
  .no-screenshots { font-size: .82rem; color: #9e9e9e; font-style: italic; }

  /* ── Lightbox ───────────────────────────────────────────────────────────── */
  #lightbox {
    display: none;
    position: fixed; inset: 0;
    background: rgba(0,0,0,.85);
    z-index: 1000;
    align-items: center;
    justify-content: center;
    cursor: zoom-out;
  }
  #lightbox.open { display: flex; }
  #lightbox img { max-width: 90vw; max-height: 90vh; border-radius: 6px;
                  box-shadow: 0 8px 40px rgba(0,0,0,.5); }

  /* ── Footer ─────────────────────────────────────────────────────────────── */
  footer { text-align: center; padding: 20px; font-size: .75rem; color: #9e9e9e; }
</style>
</head>
<body>

<header>
  <div>
    <h1>OrangeHRM Playwright Test Report
      <span>PIM → Add Employee | SCRUM-5</span>
    </h1>
  </div>
  <div class="meta">
    <div>Run date: ${runDate}</div>
    <div>Total duration: ${fmtDuration(totalDuration)}</div>
    <div>Environment: https://opensource-demo.orangehrmlive.com</div>
    <div>${allureLink}</div>
  </div>
</header>

<div class="summary-bar">
  <div class="stat-card total">
    <div class="stat-value">${total}</div>
    <div class="stat-label">Total</div>
  </div>
  <div class="stat-card pass">
    <div class="stat-value">${passed}</div>
    <div class="stat-label">Passed</div>
  </div>
  <div class="stat-card fail">
    <div class="stat-value">${failed}</div>
    <div class="stat-label">Failed</div>
  </div>
  <div class="stat-card blocked">
    <div class="stat-value">${blocked}</div>
    <div class="stat-label">Blocked / Not Exec</div>
  </div>
  <div class="pie-wrap">
    <div class="pie" title="Pass ${passRate}%"></div>
    <div class="pie-legend">
      <div><span class="pass-dot"></span>Pass &nbsp;${passed}</div>
      <div><span class="fail-dot"></span>Fail &nbsp;${failed}</div>
      <div><span class="blocked-dot"></span>Blocked &nbsp;${blocked}</div>
      <div><span class="notexec-dot"></span>Not Exec &nbsp;${notExec}</div>
    </div>
  </div>
</div>

<div class="progress-wrap">
  <div class="progress-bar-outer">
    <div class="progress-bar-inner"></div>
  </div>
  <div class="progress-label">Pass rate: ${passRate}% (${passed}/${total})</div>
</div>

<section class="tests-section">
  <h2>Test Results (${total} tests)</h2>
  ${cards}
</section>

<!-- Lightbox overlay -->
<div id="lightbox" onclick="closeLightbox()">
  <img id="lightbox-img" src="" alt="screenshot">
</div>

<footer>Generated by scripts/generate-report.js &nbsp;·&nbsp; ${runDate}</footer>

${buildAgentDecisionsSection()}

<script>
  function openLightbox(img) {
    document.getElementById('lightbox-img').src = img.src;
    document.getElementById('lightbox').classList.add('open');
    event.stopPropagation();
  }
  function closeLightbox() {
    document.getElementById('lightbox').classList.remove('open');
  }
  document.addEventListener('keydown', e => {
    if (e.key === 'Escape') closeLightbox();
  });
</script>
</body>
</html>`;
}

// ─── Agent Decisions section (collapsed) ─────────────────────────────────
function buildAgentDecisionsSection() {
  try {
    const { readDecisions } = require('../src/agents/agentDecisionLog');
    const entries = readDecisions({ limit: 100 });
    if (!entries || entries.length === 0) return '';

    // Group by agent
    const byAgent = {};
    for (const e of entries) {
      (byAgent[e.agentName] = byAgent[e.agentName] || []).push(e);
    }

    const agentBlocks = Object.keys(byAgent).sort().map(agent => {
      const rows = byAgent[agent].slice(0, 20).map(e => {
        const reasoning = e.reasoning || {};
        const output    = e.output || {};
        const techniques = Array.isArray(reasoning.techniquesApplied)
          ? reasoning.techniquesApplied.join(', ')
          : (Array.isArray(output.designTechniques) ? output.designTechniques.join(', ') : '—');
        const confidence = (typeof output.overallConfidence === 'number')
          ? output.overallConfidence.toFixed(2)
          : (typeof reasoning.plannerConfidence === 'number' ? reasoning.plannerConfidence.toFixed(2) : '—');
        return `<tr>
          <td>${escHtml(new Date(e.timestamp).toLocaleString())}</td>
          <td>${escHtml(techniques)}</td>
          <td>${escHtml(String(confidence))}</td>
          <td><code>${escHtml(JSON.stringify(output).slice(0, 140))}</code></td>
        </tr>`;
      }).join('');
      return `
        <details style="margin:8px 0;">
          <summary><strong>${escHtml(agent)}</strong> — ${byAgent[agent].length} decision(s)</summary>
          <table style="width:100%;border-collapse:collapse;margin-top:8px;font-size:12px;">
            <thead><tr style="background:#f4f4f4;">
              <th style="text-align:left;padding:6px;">Timestamp</th>
              <th style="text-align:left;padding:6px;">Techniques</th>
              <th style="text-align:left;padding:6px;">Confidence</th>
              <th style="text-align:left;padding:6px;">Output (truncated)</th>
            </tr></thead>
            <tbody>${rows}</tbody>
          </table>
        </details>`;
    }).join('');

    return `
      <section style="margin:24px;padding:16px;border:1px solid #ddd;border-radius:8px;background:#fafafa;">
        <details>
          <summary style="cursor:pointer;font-size:16px;font-weight:600;">
            🤖 Agent Decisions (${entries.length} recent) — techniques &amp; confidence
          </summary>
          <div style="margin-top:12px;">${agentBlocks}</div>
        </details>
      </section>`;
  } catch (e) {
    return `<!-- agent-decisions section skipped: ${String(e.message).replace(/-->/g, '--&gt;')} -->`;
  }
}

// ─── HTML escape ─────────────────────────────────────────────────────────────
function escHtml(str) {
  return String(str || '')
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}

// ─── Main ─────────────────────────────────────────────────────────────────────
function main() {
  console.log('\n╔══════════════════════════════════════════════════╗');
  console.log('║   Custom HTML Report Generator                   ║');
  console.log('╚══════════════════════════════════════════════════╝\n');

  if (!fs.existsSync(RESULTS_FILE)) {
    console.error(`  ERROR: ${RESULTS_FILE} not found. Run tests first.`);
    process.exit(1);
  }

  const raw  = JSON.parse(fs.readFileSync(RESULTS_FILE, 'utf8'));
  const tests = collectTests(raw.suites || []);

  // Calculate total duration from stats
  const totalDuration = (raw.stats && raw.stats.duration) || 0;
  const runDate       = (raw.stats && raw.stats.startTime)
    ? new Date(raw.stats.startTime).toLocaleString()
    : new Date().toLocaleString();

  const total  = tests.length;
  const passed = tests.filter(t => t.status === 'Pass').length;
  const failed = tests.filter(t => t.status === 'Fail').length;

  console.log(`  Tests: ${total}  |  Passed: ${passed}  |  Failed: ${failed}`);

  // Count screenshots, steps, videos found
  const totalShots  = tests.reduce((acc, t) => acc + t.screenshots.length, 0);
  const totalSteps  = tests.reduce((acc, t) => acc + t.steps.length, 0);
  const totalVideos = tests.filter(t => t.videoPath && t.status !== 'Pass').length;
  const totalFShots = tests.filter(t => t.failureScreenshot).length;
  console.log(`  Steps collected: ${totalSteps}  |  Failure screenshots: ${totalFShots}  |  Videos (failed): ${totalVideos}`);
  console.log(`  Step screenshots embedded: ${totalShots}`);

  fs.mkdirSync(OUT_DIR, { recursive: true });
  const html = buildHtml(tests, runDate, totalDuration);
  fs.writeFileSync(OUT_FILE, html, 'utf8');

  const sizekb = Math.round(fs.statSync(OUT_FILE).size / 1024);
  console.log(`\n  ✓ Report written: custom-report/index.html  (${sizekb} KB)`);
  console.log(`\n  Open: custom-report/index.html\n`);
}

main();
