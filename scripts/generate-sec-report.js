/** @module generate-sec-report — Generates a standards-compliant
    security scan HTML report from ZAP and custom check findings. */
'use strict';

const fs     = require('fs');
const path   = require('path');
const logger = require('../src/utils/logger');

const ROOT = path.resolve(__dirname, '..');

// ─── OWASP Top 10 2021 ───────────────────────────────────────────────────────
const OWASP_TOP10 = [
  { id: 'A01:2021', name: 'Broken Access Control' },
  { id: 'A02:2021', name: 'Cryptographic Failures' },
  { id: 'A03:2021', name: 'Injection' },
  { id: 'A04:2021', name: 'Insecure Design' },
  { id: 'A05:2021', name: 'Security Misconfiguration' },
  { id: 'A06:2021', name: 'Vulnerable and Outdated Components' },
  { id: 'A07:2021', name: 'Identification and Authentication Failures' },
  { id: 'A08:2021', name: 'Software and Data Integrity Failures' },
  { id: 'A09:2021', name: 'Security Logging and Monitoring Failures' },
  { id: 'A10:2021', name: 'Server-Side Request Forgery' },
];

const SEV_ORDER = { critical: 5, high: 4, medium: 3, low: 2, informational: 1 };

// ─── Helpers ─────────────────────────────────────────────────────────────────

function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTimestamp(iso) {
  if (!iso) return '\u2014';
  const d = new Date(iso);
  const M = ['Jan','Feb','Mar','Apr','May','Jun','Jul','Aug','Sep','Oct','Nov','Dec'];
  const p = n => String(n).padStart(2, '0');
  return p(d.getUTCDate()) + ' ' + M[d.getUTCMonth()] + ' ' + d.getUTCFullYear()
    + ' ' + p(d.getUTCHours()) + ':' + p(d.getUTCMinutes()) + ' UTC';
}

function formatDuration(secs) {
  if (!secs) return '0 s';
  const m = Math.floor(secs / 60), s = secs % 60;
  return m > 0 ? m + ' min ' + s + ' s' : s + ' s';
}

function worstSev(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((b, f) => (SEV_ORDER[f.severity] || 0) > (SEV_ORDER[b.severity] || 0) ? f : b).severity;
}

function sevFromCvss(score) {
  if (score >= 9.0) return 'critical';
  if (score >= 7.0) return 'high';
  if (score >= 4.0) return 'medium';
  if (score >= 0.1) return 'low';
  return 'informational';
}

// ─── generateSecReport ───────────────────────────────────────────────────────

function generateSecReport(findings, verdict, storyKey, outputDir, meta) {
  const m = meta || {};

  const counts = { critical: 0, high: 0, medium: 0, low: 0, informational: 0, total: findings.length };
  for (const f of findings) { if (counts[f.severity] !== undefined) counts[f.severity]++; }

  const maxF    = findings.reduce((b, f) => (f.cvss || 0) > (b ? b.cvss || 0 : -1) ? f : b, null);
  const maxCvss = maxF ? (maxF.cvss || 0) : 0;
  const maxSev  = sevFromCvss(maxCvss);

  const owaspCoverage = OWASP_TOP10.map(cat => {
    const cf  = findings.filter(f => f.owaspId === cat.id);
    const src = new Set(cf.map(f => f.source));
    let scanMethod = 'not scanned';
    if (cf.length > 0) {
      scanMethod = (src.has('zap') && src.has('custom')) ? 'ZAP + custom'
        : src.has('zap') ? 'ZAP' : 'custom';
    } else if (m.customChecksRun > 0 || m.passiveAlerts >= 0) {
      scanMethod = 'scanned';
    }
    return { id: cat.id, name: cat.name, findingCount: cf.length,
      worstSeverity: worstSev(cf), scanMethod };
  });

  const remByOwasp = {};
  for (const f of findings) {
    const key = f.owaspId || 'Unknown';
    if (!remByOwasp[key]) remByOwasp[key] = { name: f.owaspName || key, items: [] };
    remByOwasp[key].items.push(f);
  }

  const durationStr = formatDuration(m.durationSeconds);
  const absDir = path.isAbsolute(outputDir) ? outputDir : path.join(ROOT, outputDir);
  fs.mkdirSync(absDir, { recursive: true });

  const outPath = path.join(absDir, 'index.html');
  const html = buildHtml(findings, verdict, storyKey, m, counts, maxCvss, maxF, maxSev,
    owaspCoverage, remByOwasp, durationStr);
  fs.writeFileSync(outPath, html, 'utf8');
  logger.info('[SecReport] Report written to: ' + path.relative(ROOT, outPath));
  return outPath;
}

// ─── buildHtml ───────────────────────────────────────────────────────────────

function buildHtml(findings, verdict, storyKey, m, counts, maxCvss, maxF, maxSev,
  owaspCoverage, remByOwasp, durationStr) {

  const verdictText = verdict === 'pass' ? 'PASS \u2014 all checks clean'
    : verdict === 'warn' ? 'WARN \u2014 medium findings present'
    : 'FAIL \u2014 critical findings present';

  const sortedFindings = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0);
    return sd !== 0 ? sd : (b.cvss || 0) - (a.cvss || 0);
  });
  const cvssFindings = [...findings].sort((a, b) => (b.cvss || 0) - (a.cvss || 0));

  function owaspStatus(row) {
    if (row.findingCount === 0 && row.scanMethod === 'not scanned') return 'N/A';
    if (row.findingCount === 0) return 'PASS';
    if (row.worstSeverity === 'low' || row.worstSeverity === 'informational') return 'WARN';
    return 'FAIL';
  }

  function sevBadge(sev) {
    if (!sev) return '<span style="color:#888">\u2014</span>';
    const L = { critical:'Critical', high:'High', medium:'Medium', low:'Low', informational:'Info' };
    return '<span class="sev-badge sev-' + sev + '">' + (L[sev] || sev) + '</span>';
  }

  function srcPill(src) {
    return '<span class="src-pill ' + (src === 'zap' ? 'src-zap' : 'src-custom') + '">'
      + (src === 'zap' ? 'ZAP' : 'Custom') + '</span>';
  }

  function cvssBar(score, sev) {
    const pct = Math.min(100, Math.round(((score || 0) / 10) * 100));
    return '<div style="display:flex;align-items:center;gap:5px">'
      + '<span style="min-width:28px;font-size:12px">' + (score || 0).toFixed(1) + '</span>'
      + '<div style="width:56px;height:4px;background:rgba(0,0,0,0.1);border-radius:2px;overflow:hidden">'
      + '<div style="width:' + pct + '%;height:100%;background:var(--bar-' + (sev || 'informational') + ',#888);border-radius:2px"></div>'
      + '</div></div>';
  }

  // OWASP rows
  let owaspRows = '';
  for (const row of owaspCoverage) {
    const status = owaspStatus(row);
    let rowStyle = '', firstPad = '';
    if (row.findingCount > 0) {
      rowStyle = 'style="background:var(--sev-bg-' + row.worstSeverity + ',#fff);border-left:3px solid var(--sev-border-' + row.worstSeverity + ',#ccc)"';
      firstPad = 'style="padding-left:9px"';
    } else if (row.scanMethod !== 'not scanned') {
      rowStyle = 'style="border-left:3px solid #639922"';
      firstPad = 'style="padding-left:9px"';
    } else {
      rowStyle = 'style="opacity:0.45"';
    }
    const sb = status === 'FAIL'  ? '<span class="sev-badge sev-high">FAIL</span>'
             : status === 'WARN'  ? '<span class="sev-badge sev-medium">WARN</span>'
             : status === 'PASS'  ? '<span class="sev-badge sev-low">PASS</span>'
             : '<span class="sev-badge sev-informational">N/A</span>';
    owaspRows += '<tr ' + rowStyle + '>'
      + '<td ' + firstPad + '>' + escHtml(row.id) + '</td>'
      + '<td>' + escHtml(row.name) + '</td>'
      + '<td>' + escHtml(row.scanMethod) + '</td>'
      + '<td>' + (row.findingCount > 0 ? '<strong>' + row.findingCount + '</strong>' : '0') + '</td>'
      + '<td>' + (row.worstSeverity ? sevBadge(row.worstSeverity) : '<span style="color:#888">\u2014</span>') + '</td>'
      + '<td>' + sb + '</td>'
      + '</tr>';
  }

  // All findings rows
  let allRows = '';
  for (const f of cvssFindings) {
    allRows += '<tr>'
      + '<td title="' + escHtml(f.name) + '" style="overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(f.name) + '</td>'
      + '<td>' + srcPill(f.source) + '</td>'
      + '<td style="white-space:nowrap">' + escHtml(f.owaspId || '\u2014') + '</td>'
      + '<td>' + sevBadge(f.severity) + '</td>'
      + '<td>' + cvssBar(f.cvss, f.severity) + '</td>'
      + '<td style="color:var(--text-secondary);overflow:hidden;text-overflow:ellipsis;white-space:nowrap" title="' + escHtml(f.url) + '">' + escHtml(f.url) + '</td>'
      + '</tr>';
  }

  // Detail panels
  let detailPanels = '';
  for (const f of sortedFindings) {
    let alertBox = '';
    if (f.severity === 'critical') {
      alertBox = '<div class="alert-box alert-critical"><strong>Immediate action required</strong> \u2014 exploitable without elevated privilege. Raise Jira bug before next deployment.</div>';
    } else if (f.severity === 'high') {
      alertBox = '<div class="alert-box alert-high"><strong>High severity</strong> \u2014 raise Jira bug and schedule fix within current sprint.</div>';
    }
    const stepsHtml = (f.steps || []).map(function(step, i) {
      return '<div style="display:flex;gap:8px;margin-bottom:0.45rem;font-size:12px;line-height:1.5;align-items:flex-start">'
        + '<div style="width:18px;height:18px;min-width:18px;border-radius:50%;background:#E6F1FB;color:#0C447C;font-size:10px;font-weight:500;display:flex;align-items:center;justify-content:center">' + (i + 1) + '</div>'
        + '<span>' + escHtml(step) + '</span>'
        + '</div>';
    }).join('');
    const refsHtml = (f.references || []).map(function(r) {
      return '<a href="' + escHtml(r.url) + '" target="_blank" rel="noopener noreferrer" style="color:var(--text-secondary);text-decoration:none">' + escHtml(r.label) + '</a>';
    }).join(', ');

    detailPanels += '<details class="finding-detail">'
      + '<summary>'
      + '<span class="sev-badge sev-' + f.severity + '" style="flex-shrink:0">' + f.severity.charAt(0).toUpperCase() + f.severity.slice(1) + '</span>'
      + '<span style="font-size:12px;color:var(--text-secondary);flex-shrink:0">' + (f.cvss || 0).toFixed(1) + '</span>'
      + '<span style="flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">' + escHtml(f.name) + '</span>'
      + '<span style="margin-left:auto;display:flex;align-items:center;gap:7px;flex-shrink:0">'
      + srcPill(f.source)
      + '<span style="font-size:11px;color:var(--text-secondary)">' + escHtml(f.owaspId || '') + '</span>'
      + '<span class="chevron" style="font-size:10px;transition:transform 0.18s ease">&#9660;</span>'
      + '</span></summary>'
      + '<div class="finding-body">'
      + alertBox
      + '<div class="field-grid">'
      + '<span class="field-label">Description</span><span>' + escHtml(f.description) + '</span>'
      + '<span class="field-label">Evidence</span><code class="evidence-box">' + escHtml(f.evidence) + '</code>'
      + '<span class="field-label">Affected URL</span><span style="color:var(--text-secondary)">' + escHtml(f.url) + '</span>'
      + '<span class="field-label">OWASP 2021</span><span>' + escHtml(f.owaspId) + ' \u2014 ' + escHtml(f.owaspName) + '</span>'
      + '<span class="field-label">CVSS v3.1</span><span>' + (f.cvss || 0).toFixed(1) + ' &nbsp;<code style="font-family:monospace;font-size:11px;background:#f1efe8;padding:1px 4px;border-radius:3px">' + escHtml(f.cvssVector) + '</code></span>'
      + '<span class="field-label">CWE</span><span>' + escHtml(f.cwe) + ' \u2014 ' + escHtml(f.cweName) + '</span>'
      + '<span class="field-label">Jira bug</span><span style="color:var(--text-secondary)">' + (f.jiraBug ? escHtml(f.jiraBug) : '\u2014') + '</span>'
      + '</div>'
      + '<div class="solution-box">'
      + '<div class="section-label" style="margin-bottom:0.5rem">Solution \u2014 step-by-step remediation</div>'
      + stepsHtml
      + (refsHtml ? '<div style="margin-top:0.5rem;font-size:11px;color:var(--text-secondary)">References: ' + refsHtml + '</div>' : '')
      + '</div>'
      + '</div></details>';
  }

  const sevBadgesHtml = ['critical','high','medium','low','informational']
    .filter(function(s) { return counts[s] > 0; })
    .map(function(s) { return '<span class="sev-badge sev-' + s + '">' + counts[s] + ' ' + s + '</span>'; })
    .join(' ');

  const owaspWithFindings = owaspCoverage.filter(function(c) { return c.findingCount > 0; }).length;
  const riskDesc = maxF
    ? '"' + escHtml(maxF.name) + '" has the highest CVSS score of ' + maxCvss.toFixed(1) + '. '
    + owaspWithFindings + ' of 10 OWASP categories have findings. '
    + ((maxSev === 'critical' || maxSev === 'high')
        ? 'Immediate remediation required before next deployment.'
        : 'Schedule remediation within the current sprint.')
    : 'No findings detected.';

  function metaRow(label, value) {
    return '<div class="meta-row"><span class="meta-label">' + label + '</span><span>' + escHtml(String(value || '\u2014')) + '</span></div>';
  }

  const FINDINGS_JSON = JSON.stringify(findings);
  const SUMMARY_JSON  = JSON.stringify(counts);

  const css = [
    '*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}',
    'body{font-family:system-ui,-apple-system,"Segoe UI",sans-serif;font-size:13px;color:#1a1a18;background:#fff;line-height:1.5}',
    'a{color:#1a6699}a:hover{text-decoration:underline}',
    '.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}',
    ':root{',
    '  --text-primary:#1a1a18;--text-secondary:#5f5e5a;--text-muted:#888780;',
    '  --surface:#f8f8f6;--border:rgba(0,0,0,0.12);--border-sec:rgba(0,0,0,0.18);',
    '  --sev-bg-critical:#FCEBEB;--sev-text-critical:#791F1F;--sev-border-critical:#E24B4A;--bar-critical:#E24B4A;',
    '  --sev-bg-high:#FAECE7;--sev-text-high:#712B13;--sev-border-high:#D85A30;--bar-high:#D85A30;',
    '  --sev-bg-medium:#FAEEDA;--sev-text-medium:#633806;--sev-border-medium:#EF9F27;--bar-medium:#EF9F27;',
    '  --sev-bg-low:#EAF3DE;--sev-text-low:#27500A;--sev-border-low:#639922;--bar-low:#639922;',
    '  --sev-bg-informational:#F1EFE8;--sev-text-informational:#5f5e5a;--sev-border-informational:#B4B2A9;--bar-informational:#888780;',
    '  --verdict-pass-bg:#EAF3DE;--verdict-pass-text:#27500A;',
    '  --verdict-warn-bg:#FAEEDA;--verdict-warn-text:#633806;',
    '  --verdict-fail-bg:#FCEBEB;--verdict-fail-text:#791F1F;',
    '}',
    '@media(prefers-color-scheme:dark){',
    '  body{background:#1a1a18;color:#e8e6df}',
    '  :root{--text-primary:#e8e6df;--text-secondary:#9c9a92;--surface:#252523;--border:rgba(255,255,255,0.12)}',
    '  .report-header,.tab-bar{background:#1a1a18}',
    '  .finding-body{background:#252523}',
    '  .solution-box,.evidence-box{background:#1a1a18}',
    '  .metric-card{background:#252523}',
    '}',
    '.section-pad{padding:1.25rem 1.5rem}',
    '.section-label{font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-secondary);margin-bottom:0.75rem}',
    '.report-header{display:flex;justify-content:space-between;align-items:flex-start;padding:1rem 1.5rem;border-bottom:1px solid var(--border);gap:1rem;background:#fff}',
    '.report-header h1{font-size:18px;font-weight:500;margin-bottom:0.3rem}',
    '.header-meta{font-size:11px;color:var(--text-secondary);line-height:1.8}',
    '.header-right{display:flex;flex-direction:column;align-items:flex-end;gap:0.5rem}',
    '.verdict-badge{font-size:13px;font-weight:600;padding:0.35rem 1rem;border-radius:20px;white-space:nowrap}',
    '.verdict-pass{background:var(--verdict-pass-bg);color:var(--verdict-pass-text)}',
    '.verdict-warn{background:var(--verdict-warn-bg);color:var(--verdict-warn-text)}',
    '.verdict-fail{background:var(--verdict-fail-bg);color:var(--verdict-fail-text)}',
    '.sev-badges-row{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}',
    '.sev-badge{display:inline-block;font-size:11px;font-weight:500;padding:2px 8px;border-radius:20px;white-space:nowrap}',
    '.sev-critical{background:var(--sev-bg-critical);color:var(--sev-text-critical)}',
    '.sev-high{background:var(--sev-bg-high);color:var(--sev-text-high)}',
    '.sev-medium{background:var(--sev-bg-medium);color:var(--sev-text-medium)}',
    '.sev-low{background:var(--sev-bg-low);color:var(--sev-text-low)}',
    '.sev-informational{background:var(--sev-bg-informational);color:var(--sev-text-informational)}',
    '.src-pill{font-size:10px;padding:2px 7px;border-radius:10px;white-space:nowrap;font-weight:500}',
    '.src-zap{background:#dbeeff;color:#1a4f7a}',
    '.src-custom{background:#ede9ff;color:#3d2b8c}',
    '.metric-grid{display:grid;grid-template-columns:repeat(6,1fr);gap:8px;margin-bottom:1rem}',
    '.metric-card{background:var(--surface);border-radius:8px;padding:0.65rem 0.5rem;text-align:center}',
    '.metric-label{font-size:11px;color:var(--text-secondary);margin-bottom:0.2rem}',
    '.metric-value{font-size:22px;font-weight:500}',
    '.metric-value.val-critical{color:#791F1F}.metric-value.val-high{color:#712B13}',
    '.metric-value.val-medium{color:#633806}.metric-value.val-low{color:#27500A}',
    '.metric-value.val-informational{color:var(--text-secondary)}.metric-value.val-total{color:var(--text-primary)}',
    '.risk-panel{display:flex;gap:16px;align-items:flex-start;border:1px solid var(--border);border-radius:8px;padding:0.85rem 1rem}',
    '.cvss-circle{width:72px;height:72px;min-width:72px;border-radius:50%;display:flex;flex-direction:column;align-items:center;justify-content:center;line-height:1.2;border-width:2px;border-style:solid}',
    '.cvss-circle .cvss-val{font-size:18px;font-weight:600}',
    '.cvss-circle .cvss-lbl{font-size:10px}',
    '.risk-text h3{font-size:14px;font-weight:600;margin-bottom:0.35rem}',
    '.risk-text p{font-size:12px;color:var(--text-secondary);line-height:1.6}',
    '.analytics-grid{display:grid;grid-template-columns:160px 1fr 1fr;gap:16px;align-items:start}',
    '.chart-block{display:flex;flex-direction:column}',
    '.chart-label{font-size:11px;color:var(--text-secondary);margin-bottom:6px}',
    '.donut-wrap{position:relative;height:120px;width:120px}',
    '.custom-legend{font-size:10px;margin-top:8px;display:flex;flex-direction:column;gap:3px}',
    '.legend-item{display:flex;align-items:center;gap:5px}',
    '.legend-sq{width:8px;height:8px;border-radius:1px;flex-shrink:0}',
    '.src-legend{display:flex;gap:12px;font-size:11px;margin-bottom:5px}',
    '.src-legend-item{display:flex;align-items:center;gap:4px}',
    '.src-sq{width:10px;height:10px;border-radius:2px}',
    '.chart-note{font-size:10px;color:var(--text-muted);margin-top:4px}',
    '.tab-bar{position:sticky;top:0;z-index:10;background:#fff;border-bottom:1px solid var(--border);display:flex;padding:0 1.5rem}',
    '.tab{font-size:12px;padding:0.55rem 0.9rem;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--text-secondary);white-space:nowrap}',
    '.tab:hover{color:var(--text-primary)}',
    '.tab.active{color:var(--text-primary);border-bottom-color:#1a1a18;font-weight:500}',
    '.tab-panel{display:none}.tab-panel.active{display:block}',
    '.owasp-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}',
    '.owasp-table th{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);border-bottom:1px solid var(--border);padding:0.4rem 0.5rem;text-align:left;font-weight:400}',
    '.owasp-table td{padding:0.45rem 0.5rem;border-bottom:0.5px solid var(--border);vertical-align:middle}',
    '.owasp-table tr:last-child td{border-bottom:none}',
    '.owasp-legend{display:flex;gap:16px;font-size:12px;margin-top:0.75rem;flex-wrap:wrap}',
    '.owasp-legend-item{display:flex;align-items:center;gap:5px}',
    '.owasp-legend-sq{width:10px;height:10px;border-radius:2px}',
    '.findings-table{width:100%;border-collapse:collapse;table-layout:fixed;font-size:12px}',
    '.findings-table th{font-size:11px;text-transform:uppercase;letter-spacing:0.05em;color:var(--text-secondary);border-bottom:1px solid var(--border);padding:0.4rem 0.5rem;text-align:left;font-weight:400}',
    '.findings-table td{padding:0.4rem 0.5rem;border-bottom:0.5px solid var(--border);vertical-align:middle}',
    '.findings-table tr:hover td{background:var(--surface)}',
    '.findings-table tr:last-child td{border-bottom:none}',
    '.finding-detail{border:0.5px solid var(--border);border-radius:10px;margin-bottom:8px;overflow:hidden}',
    '.finding-detail[open]{border-color:var(--border-sec)}',
    '.finding-detail summary{padding:0.8rem 1rem;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;list-style:none;user-select:none}',
    '.finding-detail summary::-webkit-details-marker{display:none}',
    '.finding-detail[open] summary .chevron{transform:rotate(180deg)}',
    '.finding-body{padding:0.85rem 1rem;border-top:1px solid var(--border);background:var(--surface);font-size:12px}',
    '.alert-box{border-radius:7px;padding:0.6rem 0.8rem;margin-bottom:0.75rem;font-size:12px;border-left-width:3px;border-left-style:solid}',
    '.alert-critical{background:var(--sev-bg-critical);color:var(--sev-text-critical);border-left-color:var(--sev-border-critical)}',
    '.alert-high{background:var(--sev-bg-high);color:var(--sev-text-high);border-left-color:var(--sev-border-high)}',
    '.field-grid{display:grid;grid-template-columns:130px 1fr;gap:4px;margin-bottom:0.45rem;align-items:baseline}',
    '.field-label{font-size:11px;color:var(--text-secondary);font-weight:500;padding-top:1px}',
    '.evidence-box{font-family:monospace;font-size:11px;background:#fff;border:1px solid var(--border);border-radius:5px;padding:4px 8px;word-break:break-all;white-space:pre-wrap;display:block}',
    '.solution-box{border:0.5px solid var(--border-sec);border-radius:7px;padding:0.75rem 0.9rem;margin-top:0.6rem;background:#fff}',
    '.rem-counter{font-size:12px;color:var(--text-secondary);margin-bottom:1rem}',
    '.rem-group-header{font-size:12px;font-weight:500;padding:0.3rem 0.5rem;border-radius:5px;margin-bottom:4px;margin-top:0.75rem}',
    '.rem-item{display:flex;gap:8px;align-items:flex-start;padding:0.45rem 0.5rem;border-bottom:0.5px solid var(--border);font-size:12px;line-height:1.5}',
    '.rem-item:last-child{border-bottom:none}',
    '.rem-cb{width:15px;height:15px;min-width:15px;border:0.5px solid var(--border-sec);border-radius:3px;margin-top:2px;cursor:pointer;position:relative;flex-shrink:0}',
    '.rem-cb.done{background:#639922;border-color:#3B6D11}',
    '.rem-cb.done::after{content:"";position:absolute;width:8px;height:5px;border-left:2px solid white;border-bottom:2px solid white;transform:rotate(-45deg) translate(1px,-1px);display:block;top:3px;left:2px}',
    '.rem-text{flex:1}.rem-text strong{display:block}',
    '.rem-fix{font-size:11px;color:var(--text-secondary)}',
    '.rem-text.done{text-decoration:line-through;color:var(--text-secondary)}',
    '.meta-grid{display:grid;grid-template-columns:1fr 1fr;gap:1rem}',
    '.meta-section-label{font-size:11px;text-transform:uppercase;letter-spacing:0.06em;color:var(--text-secondary);margin-bottom:0.5rem}',
    '.meta-row{display:flex;justify-content:space-between;gap:1rem;padding:0.3rem 0;border-bottom:0.5px solid var(--border);font-size:12px}',
    '.meta-row:last-child{border-bottom:none}',
    '.meta-label{color:var(--text-secondary);white-space:nowrap}',
    '.report-footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding:0.85rem 1.5rem;font-size:11px;color:var(--text-secondary);flex-wrap:wrap;gap:0.5rem}',
    '.report-footer a{color:var(--text-secondary);text-decoration:none}',
    '.report-footer a:hover{text-decoration:underline}',
  ].join('\n');

  const js = [
    'var SEV_ORDER_JS={critical:5,high:4,medium:3,low:2,informational:1};',
    'var SEV_COLORS={critical:"#E24B4A",high:"#D85A30",medium:"#EF9F27",low:"#639922",informational:"#888780"};',
    'var CHART_GRID="rgba(128,128,128,0.12)";',
    'var TICK_FONT={size:10};',
    '',
    'function showTab(id,btnEl){',
    '  document.querySelectorAll(".tab-panel").forEach(function(p){p.classList.remove("active")});',
    '  document.querySelectorAll(".tab").forEach(function(b){b.classList.remove("active")});',
    '  var panel=document.getElementById("tab-"+id);',
    '  if(panel)panel.classList.add("active");',
    '  if(btnEl)btnEl.classList.add("active");',
    '}',
    '',
    '(function(){',
    '  var sevs=["critical","high","medium","low","informational"];',
    '  var data=sevs.map(function(s){return SUMMARY[s]||0});',
    '  if(data.every(function(d){return d===0}))return;',
    '  new Chart(document.getElementById("donutChart"),{',
    '    type:"doughnut",',
    '    data:{labels:["Critical","High","Medium","Low","Info"],datasets:[{data:data,backgroundColor:sevs.map(function(s){return SEV_COLORS[s]}),borderWidth:0}]},',
    '    options:{responsive:false,maintainAspectRatio:false,cutout:"62%",plugins:{legend:{display:false}}}',
    '  });',
    '  var leg=document.getElementById("donutLegend");',
    '  sevs.forEach(function(s,i){',
    '    if(!data[i])return;',
    '    var item=document.createElement("div");item.className="legend-item";',
    '    item.innerHTML=\'<div class="legend-sq" style="background:\'+SEV_COLORS[s]+\'"></div><span>\'+["Critical","High","Medium","Low","Info"][i]+" \u2014 "+data[i]+"</span>";',
    '    leg.appendChild(item);',
    '  });',
    '})();',
    '',
    '(function(){',
    '  var sevs=["critical","high","medium","low","informational"];',
    '  var labels={critical:"Critical",high:"High",medium:"Medium",low:"Low",informational:"Info"};',
    '  var present=sevs.filter(function(s){return FINDINGS.some(function(f){return f.severity===s})});',
    '  if(!present.length)return;',
    '  new Chart(document.getElementById("srcChart"),{',
    '    type:"bar",',
    '    data:{',
    '      labels:present.map(function(s){return labels[s]}),',
    '      datasets:[',
    '        {label:"ZAP",data:present.map(function(s){return FINDINGS.filter(function(f){return f.severity===s&&f.source==="zap"}).length}),backgroundColor:"#378ADD",borderRadius:3},',
    '        {label:"Custom",data:present.map(function(s){return FINDINGS.filter(function(f){return f.severity===s&&f.source!=="zap"}).length}),backgroundColor:"#7F77DD",borderRadius:3}',
    '      ]',
    '    },',
    '    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},',
    '      scales:{x:{grid:{display:false},ticks:{font:TICK_FONT}},y:{grid:{color:CHART_GRID},ticks:{font:TICK_FONT,stepSize:1},beginAtZero:true}}}',
    '  });',
    '})();',
    '',
    '(function(){',
    '  var bands=[{l:"0\u20133.9",min:0,max:3.9,c:"#639922"},{l:"4\u20136.9",min:4,max:6.9,c:"#EF9F27"},{l:"7\u20138.9",min:7,max:8.9,c:"#D85A30"},{l:"9\u201310",min:9,max:10,c:"#E24B4A"}];',
    '  new Chart(document.getElementById("cvssChart"),{',
    '    type:"bar",',
    '    data:{',
    '      labels:bands.map(function(b){return b.l}),',
    '      datasets:[{data:bands.map(function(b){return FINDINGS.filter(function(f){return(f.cvss||0)>=b.min&&(f.cvss||0)<=b.max}).length}),backgroundColor:bands.map(function(b){return b.c}),borderRadius:3}]',
    '    },',
    '    options:{responsive:true,maintainAspectRatio:false,plugins:{legend:{display:false}},',
    '      scales:{x:{grid:{display:false},ticks:{font:TICK_FONT}},y:{grid:{color:CHART_GRID},ticks:{font:TICK_FONT,stepSize:1},beginAtZero:true}}}',
    '  });',
    '})();',
    '',
    '(function(){',
    '  var sevBg={critical:"#FCEBEB",high:"#FAECE7",medium:"#FAEEDA",low:"#EAF3DE",informational:"#F1EFE8"};',
    '  var sevText={critical:"#791F1F",high:"#712B13",medium:"#633806",low:"#27500A",informational:"#5f5e5a"};',
    '  var groups={};',
    '  FINDINGS.forEach(function(f){',
    '    var key=f.owaspId||"Unknown";',
    '    if(!groups[key])groups[key]={name:f.owaspName||key,items:[]};',
    '    groups[key].items.push(f);',
    '  });',
    '  var sorted=Object.entries(groups).sort(function(a,b){',
    '    var wa=Math.max.apply(null,a[1].items.map(function(f){return SEV_ORDER_JS[f.severity]||0}));',
    '    var wb=Math.max.apply(null,b[1].items.map(function(f){return SEV_ORDER_JS[f.severity]||0}));',
    '    return wb-wa;',
    '  });',
    '  var total=0;',
    '  var container=document.getElementById("rem-container");',
    '  sorted.forEach(function(entry){',
    '    var owaspId=entry[0],group=entry[1];',
    '    var ws=group.items.reduce(function(b,f){return(SEV_ORDER_JS[f.severity]||0)>(SEV_ORDER_JS[b.severity]||0)?f:b}).severity;',
    '    var hdr=document.createElement("div");hdr.className="rem-group-header";',
    '    hdr.style.background=sevBg[ws]||"#f1efe8";hdr.style.color=sevText[ws]||"#333";',
    '    hdr.textContent=owaspId.replace(":2021","")+" \u2014 "+group.name;',
    '    container.appendChild(hdr);',
    '    group.items.forEach(function(f){',
    '      total++;',
    '      var row=document.createElement("div");row.className="rem-item";',
    '      var cb=document.createElement("div");cb.className="rem-cb";',
    '      var txt=document.createElement("div");txt.className="rem-text";',
    '      var s=document.createElement("strong");s.textContent="Fix: "+f.name;',
    '      var fix=document.createElement("div");fix.className="rem-fix";',
    '      var hint=(f.steps&&f.steps[0])?f.steps[0].slice(0,120)+(f.steps[0].length>120?"\u2026":""):(f.solution||"");',
    '      fix.textContent=hint;',
    '      txt.appendChild(s);txt.appendChild(fix);',
    '      cb.addEventListener("click",function(){',
    '        cb.classList.toggle("done");txt.classList.toggle("done");',
    '        document.getElementById("rem-done").textContent=document.querySelectorAll(".rem-cb.done").length;',
    '      });',
    '      row.appendChild(cb);row.appendChild(txt);container.appendChild(row);',
    '    });',
    '  });',
    '  document.getElementById("rem-total").textContent=total;',
    '})();',
    '',
    'document.addEventListener("DOMContentLoaded",function(){',
    '  showTab("owasp",document.getElementById("tab-btn-owasp"));',
    '});',
  ].join('\n');

  const parts = [
    '<!DOCTYPE html>',
    '<html lang="en">',
    '<head>',
    '<meta charset="UTF-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1.0">',
    '<title>Security scan report \u2014 ' + escHtml(storyKey) + '</title>',
    '<style>' + css + '</style>',
    '</head>',
    '<body>',

    // Header
    '<div class="report-header">',
    '  <div>',
    '    <h1>Security scan report</h1>',
    '    <div class="header-meta">',
    '      Story: <strong>' + escHtml(storyKey) + '</strong> &nbsp;&middot;&nbsp;',
    '      Target: ' + escHtml(m.targetUrl || '\u2014') + ' &nbsp;&middot;&nbsp;',
    '      Scan: ' + formatTimestamp(m.startTime),
    '      <br>',
    '      Engine: OWASP ZAP ' + escHtml(m.zapVersion || '\u2014') + ' (' + escHtml(m.scanType || '\u2014') + ') + ' + (m.customChecksRun || 0) + ' custom OWASP checks &nbsp;&middot;&nbsp;',
    '      Standard: OWASP Top 10 (2021) &nbsp;&middot;&nbsp; CVSS v3.1',
    '    </div>',
    '  </div>',
    '  <div class="header-right">',
    '    <span class="verdict-badge verdict-' + verdict + '">' + escHtml(verdictText) + '</span>',
    '    <div class="sev-badges-row">' + sevBadgesHtml + '</div>',
    '  </div>',
    '</div>',

    // Finding summary
    '<div class="section-pad" style="border-bottom:1px solid var(--border)">',
    '  <div class="section-label">Finding summary</div>',
    '  <div class="metric-grid">',
    '    <div class="metric-card"><div class="metric-label">Critical</div><div class="metric-value val-critical">' + counts.critical + '</div></div>',
    '    <div class="metric-card"><div class="metric-label">High</div><div class="metric-value val-high">' + counts.high + '</div></div>',
    '    <div class="metric-card"><div class="metric-label">Medium</div><div class="metric-value val-medium">' + counts.medium + '</div></div>',
    '    <div class="metric-card"><div class="metric-label">Low</div><div class="metric-value val-low">' + counts.low + '</div></div>',
    '    <div class="metric-card"><div class="metric-label">Informational</div><div class="metric-value val-informational">' + counts.informational + '</div></div>',
    '    <div class="metric-card"><div class="metric-label">Total</div><div class="metric-value val-total">' + counts.total + '</div></div>',
    '  </div>',
    '  <div class="risk-panel">',
    '    <div class="cvss-circle" style="border-color:var(--sev-border-' + maxSev + ');background:var(--sev-bg-' + maxSev + ');color:var(--sev-text-' + maxSev + ')">',
    '      <span class="cvss-val">' + maxCvss.toFixed(1) + '</span>',
    '      <span class="cvss-lbl">CVSS max</span>',
    '    </div>',
    '    <div class="risk-text">',
    '      <h3 style="color:var(--sev-text-' + maxSev + ')">Overall risk: ' + maxSev.charAt(0).toUpperCase() + maxSev.slice(1) + '</h3>',
    '      <p>' + riskDesc + '</p>',
    '    </div>',
    '  </div>',
    '</div>',

    // Visual analytics
    '<div class="section-pad" style="border-bottom:1px solid var(--border)">',
    '  <div class="section-label">Visual analytics</div>',
    '  <div class="analytics-grid">',
    '    <div class="chart-block">',
    '      <div class="chart-label">By severity</div>',
    '      <div class="donut-wrap"><canvas id="donutChart" style="width:120px;height:120px"></canvas></div>',
    '      <div class="custom-legend" id="donutLegend"></div>',
    '    </div>',
    '    <div class="chart-block">',
    '      <div class="chart-label">Findings by source</div>',
    '      <div class="src-legend">',
    '        <div class="src-legend-item"><div class="src-sq" style="background:#378ADD"></div><span>ZAP</span></div>',
    '        <div class="src-legend-item"><div class="src-sq" style="background:#7F77DD"></div><span>Custom checks</span></div>',
    '      </div>',
    '      <div style="position:relative;height:160px"><canvas id="srcChart" style="height:160px"></canvas></div>',
    '    </div>',
    '    <div class="chart-block">',
    '      <div class="chart-label">CVSS score distribution</div>',
    '      <div style="position:relative;height:160px"><canvas id="cvssChart" style="height:160px"></canvas></div>',
    '      <div class="chart-note">Bars coloured by risk level</div>',
    '    </div>',
    '  </div>',
    '</div>',

    // Tab bar
    '<div class="tab-bar">',
    '  <button class="tab active" id="tab-btn-owasp"     onclick="showTab(\'owasp\',   this)">OWASP coverage</button>',
    '  <button class="tab"        id="tab-btn-findings"  onclick="showTab(\'findings\', this)">All findings</button>',
    '  <button class="tab"        id="tab-btn-details"   onclick="showTab(\'details\',  this)">Finding details + solutions</button>',
    '  <button class="tab"        id="tab-btn-tracker"   onclick="showTab(\'tracker\',  this)">Remediation tracker</button>',
    '  <button class="tab"        id="tab-btn-meta"      onclick="showTab(\'meta\',     this)">Scan metadata</button>',
    '</div>',

    // Tab 1: OWASP
    '<div id="tab-owasp" class="tab-panel active section-pad">',
    '  <table class="owasp-table">',
    '    <colgroup><col style="width:90px"><col><col style="width:120px"><col style="width:70px"><col style="width:110px"><col style="width:70px"></colgroup>',
    '    <thead><tr><th>OWASP ID</th><th>Category name</th><th>Scan method</th><th>Findings</th><th>Worst severity</th><th>Status</th></tr></thead>',
    '    <tbody>' + owaspRows + '</tbody>',
    '  </table>',
    '  <div class="owasp-legend">',
    '    <div class="owasp-legend-item"><div class="owasp-legend-sq" style="background:#FCEBEB;border:1px solid #E24B4A"></div><span>Findings present</span></div>',
    '    <div class="owasp-legend-item"><div class="owasp-legend-sq" style="background:#EAF3DE;border:1px solid #639922"></div><span>Clean \u2014 no findings</span></div>',
    '    <div class="owasp-legend-item"><div class="owasp-legend-sq" style="background:#f1efe8;border:1px solid #ccc;opacity:0.5"></div><span>Not in scope</span></div>',
    '  </div>',
    '</div>',

    // Tab 2: All findings
    '<div id="tab-findings" class="tab-panel section-pad">',
    '  <div style="overflow-x:auto">',
    '  <table class="findings-table">',
    '    <colgroup><col style="width:220px"><col style="width:70px"><col style="width:80px"><col style="width:85px"><col style="width:100px"><col></colgroup>',
    '    <thead><tr><th>Finding</th><th>Source</th><th>OWASP</th><th>Severity</th><th>CVSS</th><th>Affected URL</th></tr></thead>',
    '    <tbody>' + allRows + '</tbody>',
    '  </table>',
    '  </div>',
    '</div>',

    // Tab 3: Details
    '<div id="tab-details" class="tab-panel section-pad">',
    detailPanels,
    '</div>',

    // Tab 4: Tracker
    '<div id="tab-tracker" class="tab-panel section-pad">',
    '  <div class="rem-counter">Remediated: <span id="rem-done">0</span> of <span id="rem-total">0</span> items</div>',
    '  <div id="rem-container"></div>',
    '</div>',

    // Tab 5: Metadata
    '<div id="tab-meta" class="tab-panel section-pad">',
    '  <div class="meta-grid">',
    '    <div>',
    '      <div class="meta-section-label">ZAP scan details</div>',
    metaRow('ZAP version',    m.zapVersion),
    metaRow('Scan type',      m.scanType),
    metaRow('Spider URLs',    m.spiderUrls),
    metaRow('Passive alerts', m.passiveAlerts),
    metaRow('Active alerts',  m.activeAlerts != null ? m.activeAlerts + ' alerts' : '\u2014'),
    '    </div>',
    '    <div>',
    '      <div class="meta-section-label">Run details</div>',
    metaRow('Custom checks run',    m.customChecksRun),
    metaRow('Custom checks passed', m.customChecksPassed),
    metaRow('Start time',           formatTimestamp(m.startTime)),
    metaRow('End time',             formatTimestamp(m.endTime)),
    metaRow('Duration',             durationStr),
    metaRow('OWASP standard',       'OWASP Top 10 (2021)'),
    metaRow('CVSS standard',        'CVSS v3.1'),
    '    </div>',
    '  </div>',
    '</div>',

    // Footer
    '<div class="report-footer">',
    '  <div>',
    '    Jira: <a href="' + escHtml(m.jiraStoryUrl || '#') + '" target="_blank" rel="noopener noreferrer">' + escHtml(storyKey) + '</a>',
    '    &nbsp;&middot;&nbsp; Zephyr: <a href="' + escHtml(m.zephyrCycleUrl || '#') + '" target="_blank" rel="noopener noreferrer">View cycle</a>',
    '    &nbsp;&middot;&nbsp; ZAP: <a href="' + escHtml(m.zapReportPath || '#') + '" target="_blank" rel="noopener noreferrer">Download JSON</a>',
    '  </div>',
    '  <div>Generated ' + formatTimestamp(new Date().toISOString()) + ' &nbsp;&middot;&nbsp; Agentic QA Platform v1.1.0</div>',
    '</div>',

    // Scripts
    '<script src="https://cdnjs.cloudflare.com/ajax/libs/Chart.js/4.4.1/chart.umd.js"></script>',
    '<script>',
    'var FINDINGS = ' + FINDINGS_JSON + ';',
    'var SUMMARY  = ' + SUMMARY_JSON  + ';',
    js,
    '</script>',
    '</body>',
    '</html>',
  ];

  return parts.join('\n');
}

// ─── Standalone execution ─────────────────────────────────────────────────────

if (require.main === module) {
  const samplePath = path.join(ROOT, 'tests', 'security', 'sample-findings.json');
  let findings, verdict, storyKey, outputDir, meta;

  if (fs.existsSync(samplePath)) {
    try {
      const raw = JSON.parse(fs.readFileSync(samplePath, 'utf8'));
      findings  = raw.findings  || raw;
      verdict   = raw.verdict   || 'fail';
      storyKey  = raw.storyKey  || 'SCRUM-6';
      outputDir = raw.outputDir || 'custom-report/security';
      meta      = raw.meta      || {};
    } catch (e) {
      logger.warn('[generate-sec-report] Could not parse sample-findings.json \u2014 using built-in sample');
    }
  }

  if (!findings) {
    storyKey  = 'SCRUM-6';
    verdict   = 'fail';
    outputDir = 'custom-report/security';
    meta = {
      zapVersion:'2.14.0', scanType:'baseline',
      targetUrl:'https://opensource-demo.orangehrmlive.com',
      startTime:'2026-04-20T15:10:04Z', endTime:'2026-04-20T15:22:51Z',
      durationSeconds:767, spiderUrls:148, passiveAlerts:11, activeAlerts:0,
      customChecksRun:10, customChecksPassed:3,
      jiraStoryUrl:'https://yourorg.atlassian.net/browse/SCRUM-6',
      zephyrCycleUrl:'https://yourorg.atlassian.net/jira/software/projects/SCRUM/boards',
      zapReportPath:'test-results/security/SCRUM-6-zap-report.json',
    };
    findings = [
      { id:'SEC-001', source:'custom', name:'IDOR \u2014 employee ID enumerable', severity:'critical', cvss:9.8,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', cwe:'CWE-639',
        cweName:'Authorization Bypass Through User-Controlled Key',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'The employee API accepts sequential integer resource IDs with no ownership validation.',
        evidence:'GET /web/index.php/api/v2/employee/2 HTTP/1.1\nAuthorization: Bearer <token>\n\nHTTP/1.1 200 OK\n{"firstName":"Jane","salary":75000}',
        url:'/web/index.php/api/v2/employee/{id}',
        solution:'Add ownership check in the employee API controller.',
        steps:[
          'Add an ownership check: verify the requesting user owns the employee record or holds the HR_ADMIN role.',
          'Replace sequential integer IDs with UUID v4 in the public-facing API.',
          'Add an integration test asserting HTTP 403 when Employee A requests Employee B record.',
          'Enable audit logging for all 403 responses and alert on > 5 consecutive 403s from one session.',
        ],
        references:[
          {label:'OWASP A01:2021',url:'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'},
          {label:'CWE-639',url:'https://cwe.mitre.org/data/definitions/639.html'},
        ], jiraBug:'SCRUM-201' },
      { id:'SEC-002', source:'custom', name:'CSRF token absent on state-changing forms', severity:'high', cvss:8.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N', cwe:'CWE-352',
        cweName:'Cross-Site Request Forgery',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'State-changing forms do not include a CSRF synchroniser token.',
        evidence:'GET /web/index.php/pim/addEmployee -> 200\ngrep csrf response.html -> no match',
        url:'/web/index.php/pim/addEmployee',
        solution:'Generate a per-session CSRF token and validate it on every state-changing endpoint.',
        steps:[
          'Generate a cryptographically random CSRF token per session (min 128 bits).',
          'Embed the token in every form and validate it server-side on POST/PUT/DELETE.',
          'Return HTTP 403 if the token is absent or mismatched.',
        ],
        references:[
          {label:'OWASP A01:2021',url:'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'},
          {label:'CSRF Prevention Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html'},
        ], jiraBug:'SCRUM-202' },
      { id:'SEC-003', source:'custom', name:'No brute-force lockout on login endpoint', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-307',
        cweName:'Improper Restriction of Excessive Authentication Attempts',
        owaspId:'A07:2021', owaspName:'Identification and Authentication Failures',
        description:'The login endpoint accepts unlimited credential-guessing attempts with no lockout.',
        evidence:'POST /auth/validateCredentials {wrong_password} x5\nAll 5: HTTP 200 {success:false}\nNo 429 / no Retry-After',
        url:'/web/index.php/auth/validateCredentials',
        solution:'Implement progressive account lockout and IP-level rate limiting.',
        steps:[
          'Lock account after 5 failed attempts; return HTTP 429 with Retry-After.',
          'Add IP-level rate limiting: max 10 login requests/min per IP.',
          'Log all failed attempts and alert when > 20 failures/min from one IP.',
        ],
        references:[
          {label:'OWASP A07:2021',url:'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/'},
          {label:'CWE-307',url:'https://cwe.mitre.org/data/definitions/307.html'},
        ], jiraBug:'SCRUM-203' },
      { id:'SEC-004', source:'custom', name:'Sensitive data exposed in API response', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-200',
        cweName:'Exposure of Sensitive Information to an Unauthorized Actor',
        owaspId:'A02:2021', owaspName:'Cryptographic Failures',
        description:'Employee search API returns salary and internal tokens to any authenticated user.',
        evidence:'GET /api/v2/employee/search?name=Admin\nHTTP 200: {"salary":85000,"internalToken":"abc123"}',
        url:'/web/index.php/api/v2/employee/search',
        solution:'Remove sensitive fields from API responses. Apply field-level access control.',
        steps:[
          'Define an API response schema \u2014 strip all unlisted fields server-side before serialising.',
          'Apply RBAC: only HR_ADMIN role may request salary data via a separate audited endpoint.',
          'Add a CI response-body scanner that flags salary/token patterns in non-admin responses.',
        ],
        references:[
          {label:'OWASP A02:2021',url:'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/'},
          {label:'CWE-200',url:'https://cwe.mitre.org/data/definitions/200.html'},
        ], jiraBug:'SCRUM-204' },
      { id:'SEC-005', source:'zap', name:'Missing Content-Security-Policy header', severity:'medium', cvss:6.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'No Content-Security-Policy header present on any page.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no Content-Security-Policy header)',
        url:'All application pages',
        solution:'Add Content-Security-Policy header to the web server configuration.',
        steps:[
          'Add to nginx: add_header Content-Security-Policy "default-src \'self\'" always',
          'Start in report-only mode to identify violations before enforcing.',
          'Tighten over time \u2014 remove unsafe-inline by migrating to nonce-based scripts.',
        ],
        references:[
          {label:'OWASP A05:2021',url:'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/'},
          {label:'CSP Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html'},
        ], jiraBug:null },
      { id:'SEC-006', source:'zap', name:'X-Frame-Options header missing', severity:'medium', cvss:5.4,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:N/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'X-Frame-Options not set \u2014 allows clickjacking via malicious iframe embedding.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no X-Frame-Options header)',
        url:'All application pages',
        solution:'Add X-Frame-Options: DENY header to the web server.',
        steps:[
          'Add to nginx: add_header X-Frame-Options DENY always',
          'Or use frame-ancestors \'none\' in the CSP header.',
          'Verify the app cannot be embedded in an iframe using browser dev tools.',
        ],
        references:[
          {label:'Clickjacking Defense Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Clickjacking_Defense_Cheat_Sheet.html'},
        ], jiraBug:null },
      { id:'SEC-007', source:'custom', name:'Session cookie missing HttpOnly flag', severity:'medium', cvss:5.3,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:L/I:N/A:N', cwe:'CWE-1004',
        cweName:'Sensitive Cookie Without HttpOnly Flag',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'Session cookie issued without HttpOnly \u2014 JS can read it, enabling XSS session theft.',
        evidence:'Set-Cookie: orangehrm=abc123; path=/; (no HttpOnly)',
        url:'/web/index.php/auth/login',
        solution:'Set HttpOnly on all session cookies.',
        steps:[
          'In php.ini: set session.cookie_httponly = 1',
          'Verify: check Set-Cookie response header includes HttpOnly after login.',
        ],
        references:[
          {label:'Session Management Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Session_Management_Cheat_Sheet.html'},
          {label:'CWE-1004',url:'https://cwe.mitre.org/data/definitions/1004.html'},
        ], jiraBug:null },
      { id:'SEC-008', source:'custom', name:'Login failures not logged', severity:'low', cvss:2.7,
        cvssVector:'AV:N/AC:H/PR:N/UI:N/S:U/C:N/I:N/A:L', cwe:'CWE-778',
        cweName:'Insufficient Logging',
        owaspId:'A09:2021', owaspName:'Security Logging and Monitoring Failures',
        description:'Failed login attempts are not written to any log.',
        evidence:'5 failed logins performed. Log files inspected \u2014 no failed login entries found.',
        url:'/web/index.php/auth/validateCredentials',
        solution:'Log all failed authentication attempts with sufficient detail.',
        steps:[
          'Log every failed login: timestamp, source IP, username (hashed), failure reason.',
          'Use structured JSON logs for SIEM ingestion.',
          'Alert when > 10 failures in 5 min from a single IP or account.',
        ],
        references:[
          {label:'OWASP A09:2021',url:'https://owasp.org/Top10/A09_2021-Security_Logging_and_Monitoring_Failures/'},
          {label:'Logging Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html'},
        ], jiraBug:null },
    ];
  }

  const outPath = generateSecReport(findings, verdict, storyKey, outputDir, meta);
  const stat    = fs.statSync(outPath);
  const lines   = fs.readFileSync(outPath, 'utf8').split('\n').length;
  logger.info('[generate-sec-report] File size: ' + (stat.size / 1024).toFixed(1) + ' KB (' + lines + ' lines)');
}

module.exports = { generateSecReport };
