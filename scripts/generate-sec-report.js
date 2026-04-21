'use strict';
/** @module generate-sec-report â€” Generates a detailed self-contained HTML security test report from findings and OWASP checklist data. */

require('dotenv').config();
const fs     = require('fs');
const path   = require('path');
const logger = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');

const ROOT = path.resolve(__dirname, '..');

const OWASP_NAMES = {
  'A01:2021': 'Broken Access Control',
  'A02:2021': 'Cryptographic Failures',
  'A03:2021': 'Injection',
  'A04:2021': 'Insecure Design',
  'A05:2021': 'Security Misconfiguration',
  'A06:2021': 'Vulnerable and Outdated Components',
  'A07:2021': 'Identification and Authentication Failures',
  'A08:2021': 'Software and Data Integrity Failures',
  'A09:2021': 'Security Logging and Monitoring Failures',
  'A10:2021': 'Server-Side Request Forgery (SSRF)',
};

const SEV_COLOURS = {
  critical:      '#6a0dad',
  high:          '#b71c1c',
  medium:        '#e65100',
  low:           '#f9a825',
  informational: '#455a64',
};
const SEV_ORDER = ['critical','high','medium','low','informational'];

function verdictBadge(v) {
  const map = { pass:'#2e7d32', warn:'#e65100', fail:'#b71c1c' };
  const lbl = { pass:'PASS', warn:'WARN', fail:'FAIL' };
  const bg  = map[v] || '#555';
  return `<span style="background:${bg};color:#fff;padding:3px 12px;border-radius:12px;font-weight:bold;font-size:0.9em">${lbl[v]||v.toUpperCase()}</span>`;
}

function sevBadge(s) {
  const bg = SEV_COLOURS[s] || '#555';
  return `<span style="background:${bg};color:#fff;padding:2px 8px;border-radius:10px;font-size:0.78em;font-weight:bold">${(s||'').toUpperCase()}</span>`;
}

function sourcePill(src) {
  if (src === 'zap')    return `<span style="background:#e3f2fd;color:#1565c0;padding:2px 9px;border-radius:10px;font-size:0.78em;font-weight:bold">ZAP</span>`;
  return `<span style="background:#ede7f6;color:#6a0dad;padding:2px 9px;border-radius:10px;font-size:0.78em;font-weight:bold">CUSTOM</span>`;
}

function truncate(s, n) { return s && s.length > n ? s.slice(0, n) + 'â€¦' : (s || ''); }

/**
 * Generate the full security HTML report.
 *
 * @param {Array}  findings  - Normalised finding objects from parseFindings()
 * @param {string} verdict   - Overall verdict: pass|warn|fail
 * @param {string} storyKey  - Jira story key
 * @param {string} outputDir - Target directory for index.html
 * @param {object} [meta]    - Optional scan metadata { zapVersion, scanType, targetUrl, startTime, endTime, spiderUrls, activeScanAlerts, passiveScanAlerts, customRun, customPassed }
 */
function generateSecReport(findings, verdict, storyKey, outputDir, meta) {
  try {
    fs.mkdirSync(outputDir, { recursive: true });

    const generated = new Date().toISOString();
    const m         = meta || {};
    const jiraUrl   = (process.env.JIRA_URL || '').replace(/\/$/, '');
    const zephyrUrl = process.env.ZEPHYR_BASE_URL || '';
    const targetUrl = m.targetUrl || process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com';
    const scanType  = m.scanType  || process.env.ZAP_SCAN_TYPE || 'baseline';

    const counts = {
      critical:      findings.filter(f => f.severity === 'critical').length,
      high:          findings.filter(f => f.severity === 'high').length,
      medium:        findings.filter(f => f.severity === 'medium').length,
      low:           findings.filter(f => f.severity === 'low').length,
      informational: findings.filter(f => f.severity === 'informational').length,
    };
    const total = findings.length;

    // â”€â”€ Chart data â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const donutData    = JSON.stringify([counts.critical, counts.high, counts.medium, counts.low, counts.informational]);
    const donutColours = JSON.stringify(['#6a0dad','#b71c1c','#e65100','#f9a825','#455a64']);
    const donutLabels  = JSON.stringify(['Critical','High','Medium','Low','Info']);

    const zapFindings  = findings.filter(f => f.source === 'zap');
    const custFindings = findings.filter(f => f.source !== 'zap');
    const srcBarData   = JSON.stringify([
      [zapFindings.filter(f=>f.severity==='critical').length, custFindings.filter(f=>f.severity==='critical').length],
      [zapFindings.filter(f=>f.severity==='high').length,     custFindings.filter(f=>f.severity==='high').length],
      [zapFindings.filter(f=>f.severity==='medium').length,   custFindings.filter(f=>f.severity==='medium').length],
      [zapFindings.filter(f=>f.severity==='low').length,      custFindings.filter(f=>f.severity==='low').length],
      [zapFindings.filter(f=>f.severity==='informational').length, custFindings.filter(f=>f.severity==='informational').length],
    ]);
    const cvssRanges = [
      findings.filter(f => f.cvss < 4).length,
      findings.filter(f => f.cvss >= 4 && f.cvss < 7).length,
      findings.filter(f => f.cvss >= 7 && f.cvss < 9).length,
      findings.filter(f => f.cvss >= 9).length,
    ];
    const cvssData = JSON.stringify(cvssRanges);

    // â”€â”€ OWASP Coverage Matrix â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const owaspRows = Object.entries(OWASP_NAMES).map(([id, name]) => {
      const matching = findings.filter(f => f.owaspId === id);
      const cnt = matching.length;
      const worst = matching.reduce((best, f) => {
        return SEV_ORDER.indexOf(f.severity) < SEV_ORDER.indexOf(best) ? f.severity : best;
      }, 'informational');
      const rowStyle = cnt > 0
        ? 'border-left:3px solid #b71c1c;background:#fff5f5'
        : 'background:#f9f9f9';
      const scanMethod = cnt > 0
        ? (matching.some(f => f.source === 'zap') && matching.some(f => f.source === 'custom') ? 'ZAP + Custom' : matching[0].source === 'zap' ? 'ZAP' : 'Custom')
        : 'â€”';
      return `<tr style="${rowStyle}">
        <td><code>${id}</code></td>
        <td>${name}</td>
        <td>${scanMethod}</td>
        <td style="text-align:center">${cnt}</td>
        <td>${cnt > 0 ? sevBadge(worst) : 'â€”'}</td>
        <td>${cnt > 0 ? '<span style="background:#b71c1c;color:#fff;padding:1px 8px;border-radius:8px;font-size:0.78em">FAIL</span>' : '<span style="background:#2e7d32;color:#fff;padding:1px 8px;border-radius:8px;font-size:0.78em">PASS</span>'}</td>
      </tr>`;
    }).join('');

    // â”€â”€ All Findings Table â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const sorted = [...findings].sort((a, b) => (b.cvss || 0) - (a.cvss || 0));
    const findingRows = sorted.map(f => {
      const cvssW = 80;
      const cvssP = Math.min(100, Math.round(((f.cvss || 0) / 10) * 100));
      const cvssCol = f.cvss >= 9 ? '#b71c1c' : f.cvss >= 7 ? '#e65100' : f.cvss >= 4 ? '#f9a825' : '#2e7d32';
      return `<tr class="hover-row">
        <td>${f.name}</td>
        <td>${sourcePill(f.source)}</td>
        <td><code style="font-size:0.8em">${f.owaspId || 'â€”'}</code></td>
        <td>${sevBadge(f.severity)}</td>
        <td>
          <span style="font-weight:bold;margin-right:6px">${(f.cvss||0).toFixed(1)}</span>
          <span style="display:inline-block;width:${cvssW}px;height:8px;background:#e0e0e0;border-radius:4px;vertical-align:middle">
            <span style="display:block;width:${cvssP}%;height:100%;background:${cvssCol};border-radius:4px"></span>
          </span>
        </td>
        <td title="${f.url||''}">${truncate(f.url || 'â€”', 40)}</td>
      </tr>`;
    }).join('');

    // â”€â”€ Finding Details â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const detailCards = sorted.map(f => {
      const urgent = (f.severity === 'critical' || f.severity === 'high')
        ? `<div style="background:#fdecea;border-left:4px solid #b71c1c;padding:10px 14px;border-radius:4px;margin-bottom:12px">
             <strong>&#9888; Immediate remediation required â€” create Jira bug if not already done.</strong>
           </div>` : '';
      return `
        <details class="detail-card">
          <summary>
            ${sevBadge(f.severity)} &nbsp; CVSS ${(f.cvss||0).toFixed(1)} &nbsp;|&nbsp;
            <strong>${f.name}</strong> &nbsp;
            ${sourcePill(f.source)} &nbsp; <code style="font-size:0.8em">${f.owaspId||'â€”'}</code>
            <span class="chevron">&#9660;</span>
          </summary>
          <div class="detail-body">
            ${urgent}
            <table class="inner">
              <tbody>
                <tr><th>Description</th><td>${f.description || 'â€”'}</td></tr>
                <tr><th>Evidence</th><td><code style="font-size:0.8em;word-break:break-all">${truncate(f.evidence || 'â€”', 400)}</code></td></tr>
                <tr><th>Affected URL</th><td><a href="${f.url||'#'}" target="_blank" style="word-break:break-all">${f.url || 'â€”'}</a></td></tr>
                <tr><th>OWASP ID</th><td>${f.owaspId||'â€”'} â€” ${OWASP_NAMES[f.owaspId]||'Unknown'}</td></tr>
                <tr><th>CVSS v3.1 Score</th><td><strong>${(f.cvss||0).toFixed(1)}</strong></td></tr>
                <tr><th>Solution</th><td>${f.solution || 'â€”'}</td></tr>
                ${f.jiraBugKey ? `<tr><th>Jira Bug</th><td><a href="${jiraUrl}/browse/${f.jiraBugKey}" target="_blank">${f.jiraBugKey}</a></td></tr>` : ''}
              </tbody>
            </table>
          </div>
        </details>`;
    }).join('');

    // â”€â”€ Remediation Checklist â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const grouped = {};
    for (const f of sorted) {
      const key = f.owaspId || 'Other';
      if (!grouped[key]) grouped[key] = [];
      grouped[key].push(f);
    }
    let checklistHtml = '';
    let checklistCount = 0;
    for (const [owaspId, items] of Object.entries(grouped)) {
      const catCol = SEV_COLOURS[items[0]?.severity] || '#333';
      checklistHtml += `<div style="margin-bottom:16px">
        <div style="font-weight:bold;color:${catCol};margin-bottom:6px;border-bottom:2px solid ${catCol};padding-bottom:4px">${owaspId} â€” ${OWASP_NAMES[owaspId]||owaspId}</div>
        <ul style="list-style:none;padding:0">`;
      for (const item of items) {
        checklistCount++;
        checklistHtml += `<li style="margin:6px 0" id="ci${checklistCount}">
          <input type="checkbox" id="cb${checklistCount}" onchange="toggleCheck(${checklistCount})" style="cursor:pointer">
          <label for="cb${checklistCount}" style="cursor:pointer"> <strong>${item.name}</strong> â€” ${item.solution || 'Review and remediate this finding.'}</label>
        </li>`;
      }
      checklistHtml += '</ul></div>';
    }
    if (!checklistHtml) checklistHtml = '<p style="color:#888">No findings requiring remediation.</p>';

    // â”€â”€ Scan Metadata â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const metaHtml = `
      <table class="inner" style="max-width:600px">
        <tbody>
          <tr><th>ZAP Version</th><td>${m.zapVersion||'N/A'}</td></tr>
          <tr><th>Scan Type</th><td>${scanType}</td></tr>
          <tr><th>Target URL</th><td>${targetUrl}</td></tr>
          <tr><th>Start Time</th><td>${m.startTime||generated}</td></tr>
          <tr><th>End Time</th><td>${m.endTime||generated}</td></tr>
          <tr><th>Spider URLs visited</th><td>${m.spiderUrls||'N/A'}</td></tr>
          <tr><th>Active scan alerts</th><td>${m.activeScanAlerts||0}</td></tr>
          <tr><th>Passive scan alerts</th><td>${m.passiveScanAlerts||0}</td></tr>
          <tr><th>Custom checks run</th><td>${m.customRun||0}</td></tr>
          <tr><th>Custom checks passed</th><td>${m.customPassed||0}</td></tr>
        </tbody>
      </table>`;

    const zapReportPath = path.join(ROOT, 'test-results', 'security', `${storyKey}-zap-report.json`);
    const zapDownloadExists = fs.existsSync(zapReportPath);

    // â”€â”€ Full HTML â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
    const html = `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8"/>
  <meta name="viewport" content="width=device-width,initial-scale=1.0"/>
  <title>Security Test Report â€” ${storyKey}</title>
  <script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>
  <style>
    *,*::before,*::after{box-sizing:border-box}
    body{font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',sans-serif;margin:0;padding:24px;background:#f0f2f5;color:#212121}
    h1{font-size:2rem;margin:0 0 4px}
    h2{font-size:1.1rem;margin:28px 0 12px;border-bottom:2px solid #b71c1c;padding-bottom:4px;color:#b71c1c;text-transform:uppercase;letter-spacing:.05em}
    h4{font-size:0.85rem;margin:12px 0 4px;color:#555}
    .header-meta{color:#888;font-size:0.85rem;margin-bottom:16px}
    .badge-row{display:flex;gap:10px;align-items:center;flex-wrap:wrap;margin-bottom:20px}

    /* Summary cards */
    .sev-cards{display:flex;gap:14px;flex-wrap:wrap;margin-bottom:28px}
    .sev-card{background:#fff;border-radius:10px;padding:14px 20px;box-shadow:0 2px 6px rgba(0,0,0,.1);min-width:110px;text-align:center}
    .sev-card .snum{font-size:2rem;font-weight:bold}
    .sev-card .slbl{font-size:0.73rem;text-transform:uppercase;letter-spacing:.05em;color:#888}

    /* Visual analytics */
    .analytics-row{display:grid;grid-template-columns:repeat(3,1fr);gap:16px;margin-bottom:28px}
    .analytics-panel{background:#fff;border-radius:8px;padding:16px;box-shadow:0 1px 4px rgba(0,0,0,.1)}
    .analytics-panel h4{margin:0 0 12px;font-size:0.85rem;color:#555;text-align:center}

    /* Tabs */
    .tab-bar{display:flex;gap:0;border-bottom:2px solid #b71c1c;margin-bottom:20px}
    .tab-btn{padding:10px 20px;cursor:pointer;border:none;background:transparent;font-size:0.88rem;color:#555;border-bottom:3px solid transparent;margin-bottom:-2px;font-weight:500}
    .tab-btn.active{color:#b71c1c;border-bottom-color:#b71c1c;font-weight:700}
    .tab-btn:hover{background:#fdecea}
    .tab-pane{display:none}.tab-pane.active{display:block}

    /* Tables */
    table{border-collapse:collapse;width:100%;background:#fff;border-radius:8px;overflow:hidden;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-bottom:20px}
    th{background:#b71c1c;color:#fff;padding:10px 14px;text-align:left;font-size:0.82rem}
    td{padding:8px 14px;border-bottom:1px solid #e8e8e8;font-size:0.87rem;vertical-align:middle}
    tr:last-child td{border-bottom:none}
    .hover-row:hover td{background:#fdecea}
    table.inner{box-shadow:none;border:1px solid #e0e0e0}
    table.inner th{background:#b71c1c;padding:8px 12px}

    /* Detail cards */
    .detail-card{background:#fff;border-radius:8px;box-shadow:0 1px 4px rgba(0,0,0,.1);padding:13px 17px;margin-bottom:10px}
    .detail-card summary{cursor:pointer;user-select:none;outline:none;display:flex;align-items:center;gap:8px;flex-wrap:wrap}
    .detail-card summary .chevron{margin-left:auto;transition:transform .2s}
    .detail-card[open] summary .chevron{transform:rotate(180deg)}
    .detail-body{padding-top:12px}

    /* Checklist */
    #checklist-counter{font-size:0.82rem;color:#888;margin-top:12px;padding-top:8px;border-top:1px solid #e0e0e0}
    .done-item label{text-decoration:line-through;color:#aaa}

    footer{margin-top:40px;padding-top:16px;border-top:1px solid #e0e0e0;font-size:0.78rem;color:#888;display:flex;gap:20px;flex-wrap:wrap}
    footer a{color:#b71c1c;text-decoration:none}
    @media(max-width:700px){.analytics-row{grid-template-columns:1fr}.sev-cards{gap:8px}}
  </style>
</head>
<body>
  <!-- â”€â”€ HEADER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h1>&#128737; Security test report</h1>
  <div class="header-meta">
    Story: <strong>${storyKey}</strong> &nbsp;|&nbsp;
    Scan: <strong>${generated}</strong> &nbsp;|&nbsp;
    Type: <strong>ZAP ${scanType} + custom checks</strong> &nbsp;|&nbsp;
    Target: <strong>${targetUrl}</strong>
  </div>
  <div class="badge-row">
    <span>Overall verdict:</span> ${verdictBadge(verdict)}
  </div>

  <!-- â”€â”€ SECTION 1: FINDING SUMMARY â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h2>Finding Summary</h2>
  <div class="sev-cards">
    <div class="sev-card"><div class="snum" style="color:#6a0dad">${counts.critical}</div><div class="slbl">Critical</div></div>
    <div class="sev-card"><div class="snum" style="color:#b71c1c">${counts.high}</div><div class="slbl">High</div></div>
    <div class="sev-card"><div class="snum" style="color:#e65100">${counts.medium}</div><div class="slbl">Medium</div></div>
    <div class="sev-card"><div class="snum" style="color:#f9a825">${counts.low}</div><div class="slbl">Low</div></div>
    <div class="sev-card"><div class="snum" style="color:#455a64">${counts.informational}</div><div class="slbl">Info</div></div>
    <div class="sev-card"><div class="snum" style="color:#212121">${total}</div><div class="slbl">Total</div></div>
  </div>

  <!-- â”€â”€ SECTION 2: VISUAL ANALYTICS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <h2>Visual Analytics</h2>
  <div class="analytics-row">
    <div class="analytics-panel"><h4>Findings by Severity</h4><canvas id="donutChart"></canvas></div>
    <div class="analytics-panel"><h4>Findings by Source (ZAP vs Custom)</h4><canvas id="srcChart"></canvas></div>
    <div class="analytics-panel"><h4>CVSS Score Distribution</h4><canvas id="cvssChart"></canvas></div>
  </div>

  <!-- â”€â”€ TABS â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <div class="tab-bar">
    <button class="tab-btn active" onclick="showTab('s1',this)">OWASP Top 10 Coverage</button>
    <button class="tab-btn"        onclick="showTab('s2',this)">All Findings</button>
    <button class="tab-btn"        onclick="showTab('s3',this)">Finding Details</button>
    <button class="tab-btn"        onclick="showTab('s4',this)">Remediation Checklist</button>
  </div>

  <!-- TAB 1: OWASP COVERAGE MATRIX -->
  <div id="s1" class="tab-pane active">
    <table>
      <thead>
        <tr><th>OWASP ID</th><th>Category Name</th><th>Scan Method</th><th>Findings</th><th>Worst Severity</th><th>Status</th></tr>
      </thead>
      <tbody>${owaspRows}</tbody>
    </table>
  </div>

  <!-- TAB 2: ALL FINDINGS TABLE -->
  <div id="s2" class="tab-pane">
    <table>
      <thead>
        <tr><th>Finding Name</th><th>Source</th><th>OWASP ID</th><th>Severity</th><th>CVSS Score</th><th>Affected URL</th></tr>
      </thead>
      <tbody>
        ${findingRows || '<tr><td colspan="6" style="text-align:center;color:#888">No findings recorded.</td></tr>'}
      </tbody>
    </table>
  </div>

  <!-- TAB 3: FINDING DETAILS -->
  <div id="s3" class="tab-pane">
    ${detailCards || '<p style="color:#888">No findings recorded.</p>'}
  </div>

  <!-- TAB 4: REMEDIATION CHECKLIST -->
  <div id="s4" class="tab-pane">
    <div id="checklist-body">${checklistHtml}</div>
    <div id="checklist-counter">0 of ${checklistCount} items remediated</div>
  </div>

  <!-- â”€â”€ SCAN METADATA â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <details style="background:#fff;border-radius:8px;padding:14px 18px;box-shadow:0 1px 4px rgba(0,0,0,.1);margin-top:28px">
    <summary style="cursor:pointer;font-weight:bold;color:#555">Scan Metadata</summary>
    <div style="padding-top:12px">${metaHtml}</div>
  </details>

  <!-- â”€â”€ FOOTER â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
  <footer>
    ${jiraUrl && storyKey ? `<a href="${jiraUrl}/browse/${storyKey}" target="_blank">&#128279; Jira Story</a>` : ''}
    ${zephyrUrl ? `<a href="${zephyrUrl}" target="_blank">&#128279; Zephyr Cycle</a>` : ''}
    ${zapDownloadExists ? `<a href="../../test-results/security/${storyKey}-zap-report.json" download>&#11015; ZAP JSON Report</a>` : ''}
    <span>&#128336; ${generated}</span>
    <span>Generated by Agentic QA Platform</span>
  </footer>

  <script>
    function showTab(id, btn) {
      document.querySelectorAll('.tab-pane').forEach(p => p.classList.remove('active'));
      document.querySelectorAll('.tab-btn').forEach(b  => b.classList.remove('active'));
      document.getElementById(id).classList.add('active');
      btn.classList.add('active');
    }

    // Checklist counter
    let doneCt = 0;
    const totalItems = ${checklistCount};
    function toggleCheck(n) {
      const cb = document.getElementById('cb' + n);
      const li = document.getElementById('ci' + n);
      if (cb.checked) { li.classList.add('done-item');    doneCt++; }
      else            { li.classList.remove('done-item'); doneCt--; }
      document.getElementById('checklist-counter').textContent = doneCt + ' of ' + totalItems + ' items remediated';
    }

    // Chart data (embedded)
    const DONUT_DATA    = ${donutData};
    const DONUT_COLOURS = ${donutColours};
    const DONUT_LABELS  = ${donutLabels};
    const SRC_DATA      = ${srcBarData};
    const CVSS_DATA     = ${cvssData};

    new Chart(document.getElementById('donutChart'), {
      type: 'doughnut',
      data: { labels: DONUT_LABELS, datasets: [{ data: DONUT_DATA, backgroundColor: DONUT_COLOURS }] },
      options: { responsive: true, plugins: { legend: { position: 'bottom' } } }
    });

    new Chart(document.getElementById('srcChart'), {
      type: 'bar',
      data: {
        labels: ['Critical','High','Medium','Low','Info'],
        datasets: [
          { label: 'ZAP',    data: SRC_DATA.map(d=>d[0]), backgroundColor: '#1565c0' },
          { label: 'Custom', data: SRC_DATA.map(d=>d[1]), backgroundColor: '#6a0dad' },
        ]
      },
      options: { responsive: true, scales: { x: { stacked: false }, y: { beginAtZero: true } }, plugins: { legend: { position: 'top' } } }
    });

    new Chart(document.getElementById('cvssChart'), {
      type: 'bar',
      data: {
        labels: ['0â€“3.9 (Low)','4â€“6.9 (Med)','7â€“8.9 (High)','9â€“10 (Crit)'],
        datasets: [{ data: CVSS_DATA, backgroundColor: ['#2e7d32','#f9a825','#e65100','#b71c1c'] }]
      },
      options: { responsive: true, plugins: { legend: { display: false } }, scales: { y: { beginAtZero: true } } }
    });
  </script>
</body>
</html>`;

    const outFile = path.join(outputDir, 'index.html');
    fs.writeFileSync(outFile, html, 'utf8');
    logger.info(`[SecReport] Report written to: ${path.relative(ROOT, outFile)}`);
    return outFile;
  } catch (err) {
    throw new AppError(`generateSecReport failed: ${err.message}`);
  }
}

// â”€â”€â”€ Standalone CLI â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
if (require.main === module) {
  const storyKey  = process.env.ISSUE_KEY || 'UNKNOWN';
  const outputDir = path.join(ROOT, 'custom-report', 'security');

  const { parseFindings, evaluateSeverity } = require('../src/services/sec.execution.service');

  const resultsDir = path.join(ROOT, 'test-results', 'security');
  let findings = [];
  let verdict  = 'pass';

  if (fs.existsSync(resultsDir)) {
    const files = fs.readdirSync(resultsDir)
      .filter(f => f.endsWith('-zap-report.json') || f.endsWith('.json'))
      .map(f => ({ name: f, mtime: fs.statSync(path.join(resultsDir, f)).mtimeMs }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length > 0) {
      const latest = path.join(resultsDir, files[0].name);
      const parsed = parseFindings(latest, []);
      findings = parsed.findings;
      const policy = { failOn: process.env.ZAP_FAIL_ON || 'high', warnOn: process.env.ZAP_WARN_ON || 'medium', maxIssues: 0 };
      ({ verdict } = evaluateSeverity(findings, policy));
    }
  }

  try {
    const out = generateSecReport(findings, verdict, storyKey, outputDir);
    console.log(`[generate-sec-report] Written: ${out}`);
    process.exit(0);
  } catch (err) {
    console.error('[generate-sec-report] FATAL:', err.message);
    process.exit(1);
  }
}

module.exports = { generateSecReport };
