'use strict';
// ─── Security & Penetration Testing Report Generator — Enterprise Edition ─────
// Produces a publication-quality, self-contained light-theme HTML report.
// Function signature: generateSecReport(findings, verdict, storyKey, outputDir, meta)

const fs   = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (_) {}

const ROOT = path.resolve(__dirname, '..');
let logger;
try { logger = require('../src/utils/logger'); } catch (_) {
  logger = { info: console.log, warn: console.warn, error: console.error };
}

// ─── OWASP Top 10 2021 ────────────────────────────────────────────────────────
const OWASP_TOP10 = [
  { id:'A01:2021', name:'Broken Access Control',                   color:'#dc2626' },
  { id:'A02:2021', name:'Cryptographic Failures',                  color:'#ea580c' },
  { id:'A03:2021', name:'Injection',                               color:'#d97706' },
  { id:'A04:2021', name:'Insecure Design',                         color:'#65a30d' },
  { id:'A05:2021', name:'Security Misconfiguration',               color:'#0284c7' },
  { id:'A06:2021', name:'Vulnerable & Outdated Components',        color:'#7c3aed' },
  { id:'A07:2021', name:'Identification & Auth Failures',          color:'#db2777' },
  { id:'A08:2021', name:'Software & Data Integrity Failures',      color:'#0891b2' },
  { id:'A09:2021', name:'Security Logging & Monitoring Failures',  color:'#b45309' },
  { id:'A10:2021', name:'Server-Side Request Forgery',             color:'#475569' },
];

const SEV_ORDER   = { critical:5, high:4, medium:3, low:2, informational:1, info:1 };
const SEV_WEIGHTS = { critical:10, high:5, medium:2, low:0.5, informational:0, info:0 };

const PENTEST_MODULES = [
  { key:'apiFuzzing',     label:'API Fuzzing',          icon:'&#128251;' },
  { key:'authBypass',     label:'Auth Bypass',          icon:'&#128274;' },
  { key:'idorDetection',  label:'IDOR Detection',       icon:'&#128273;' },
  { key:'rateLimiting',   label:'Rate Limiting',        icon:'&#9201;'   },
  { key:'sessionMgmt',    label:'Session Management',  icon:'&#127823;' },
  { key:'cryptoWeakness', label:'Crypto Weakness',     icon:'&#128275;' },
  { key:'fileUpload',     label:'File Upload Security', icon:'&#128206;' },
];

// ─── Helpers ──────────────────────────────────────────────────────────────────
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}

function formatTimestamp(iso) {
  if (!iso) return '\u2014';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit',
    });
  } catch (_) { return String(iso); }
}

function formatDuration(secs) {
  if (!secs && secs !== 0) return '\u2014';
  const m = Math.floor(secs / 60), s = Math.round(secs % 60);
  return m > 0 ? `${m}m ${s}s` : `${s}s`;
}

function worstSev(arr) {
  if (!arr || !arr.length) return null;
  return arr.reduce((best, f) => {
    const s = (f.severity || '').toLowerCase();
    return (SEV_ORDER[s] || 0) > (SEV_ORDER[best] || 0) ? s : best;
  }, 'informational');
}

function sevFromCvss(score) {
  if (!score)     return 'informational';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0)  return 'low';
  return 'informational';
}

function calculateSecurityScore(findings) {
  const d = findings.reduce(
    (sum, f) => sum + (SEV_WEIGHTS[(f.severity || 'informational').toLowerCase()] || 0), 0
  );
  return Math.max(0, Math.min(100, Math.round(100 - d)));
}

function slugify(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

function hexToRgba(hex, alpha) {
  const r = parseInt(hex.slice(1, 3), 16);
  const g = parseInt(hex.slice(3, 5), 16);
  const b = parseInt(hex.slice(5, 7), 16);
  return `rgba(${r},${g},${b},${alpha})`;
}

// ─── SVG Risk Gauge (light theme) ─────────────────────────────────────────────
function buildSvgGauge(score) {
  const r = 52, cx = 60, cy = 60;
  const circ   = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color  = score >= 80 ? '#166534' : score >= 60 ? '#92400e' : score >= 40 ? '#c2410c' : '#991b1b';
  const grade  = score >= 80 ? 'LOW RISK' : score >= 60 ? 'MODERATE' : score >= 40 ? 'HIGH RISK' : 'CRITICAL';
  return `<svg viewBox="0 0 120 128" width="120" height="128" aria-label="Security posture score: ${score} — ${grade}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="#e2e8f0" stroke-width="9"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="9"
      stroke-dasharray="${filled.toFixed(2)} ${(circ - filled).toFixed(2)}"
      stroke-dashoffset="${(circ * 0.25).toFixed(2)}"
      stroke-linecap="round" transform="rotate(-90,${cx},${cy})"/>
    <text x="${cx}" y="${cy - 4}" text-anchor="middle" fill="${color}"
      font-family="Inter,sans-serif" font-size="26" font-weight="700">${score}</text>
    <text x="${cx}" y="${cy + 13}" text-anchor="middle" fill="#64748b"
      font-family="Inter,sans-serif" font-size="9" font-weight="600" letter-spacing="0.08em">RISK SCORE</text>
    <text x="${cx}" y="${cy + 27}" text-anchor="middle" fill="${color}"
      font-family="Inter,sans-serif" font-size="9" font-weight="700" letter-spacing="0.06em">${grade}</text>
  </svg>`;
}

// ─── OWASP Heatmap ────────────────────────────────────────────────────────────
function buildOwaspHeatmap(findings) {
  const counts = {};
  for (const f of findings) {
    const id = (f.owaspId || '').split(':')[0] + ':2021';
    counts[id] = (counts[id] || 0) + 1;
  }
  const cells = OWASP_TOP10.map(owasp => {
    const cnt      = counts[owasp.id] || 0;
    const bgAlpha  = cnt === 0 ? 0.06 : Math.min(0.22, 0.07 + cnt * 0.04);
    const brAlpha  = cnt === 0 ? 0.12 : Math.min(0.45, 0.18 + cnt * 0.08);
    const bg       = hexToRgba(owasp.color, bgAlpha);
    const br       = hexToRgba(owasp.color, brAlpha);
    const shortId  = owasp.id.replace(':2021', '');
    return `<div class="owasp-cell" style="background:${bg};border:1px solid ${br}"
      title="${escHtml(owasp.id)}: ${escHtml(owasp.name)} (${cnt} finding${cnt === 1 ? '' : 's'})">
      <div class="owasp-cell-id" style="color:${owasp.color}">${escHtml(shortId)}</div>
      <div class="owasp-cell-count" style="color:${cnt > 0 ? owasp.color : '#94a3b8'}">${cnt}</div>
    </div>`;
  });
  return `<div class="owasp-heatmap">${cells.join('')}</div>`;
}

// ─── Pentest Module Cards ─────────────────────────────────────────────────────
function buildPentestModuleCards(pentestModules) {
  if (!pentestModules || !pentestModules.length) {
    return `<div class="no-data-msg">No automated pentest data available for this scan.</div>`;
  }
  const moduleMap = {};
  for (const m of pentestModules) moduleMap[m.name || m.key] = m;

  return PENTEST_MODULES.map(def => {
    const mod           = moduleMap[def.key] || {};
    const status        = mod.status || 'not-run';
    const findings      = mod.findings || [];
    const endpoints     = mod.endpointsTested || 0;
    const duration      = mod.durationMs ? (mod.durationMs / 1000).toFixed(1) + 's' : '\u2014';
    const attackVectors = (mod.attackVectorsApplied || []).length;
    const statusClass   = status === 'success' ? 'pt-status-success'
                        : status === 'partial'  ? 'pt-status-partial'
                        : status === 'failed'   ? 'pt-status-failed'
                        : 'pt-status-notrun';
    const statusLabel   = status === 'success' ? 'Completed' : status === 'partial' ? 'Partial'
                        : status === 'failed'  ? 'Failed' : 'Not Run';

    const findingsHtml = findings.map(f => {
      const sev = (f.severity || 'info').toLowerCase();
      return `<div class="pt-finding-row">
        <span class="sev-dot sev-dot-${sev}"></span>
        <span class="pt-finding-name">${escHtml(f.name || f.id)}</span>
        <span class="pt-finding-cvss">CVSS ${(f.cvss || 0).toFixed(1)}</span>
      </div>`;
    }).join('');

    return `<details class="pt-card">
      <summary>
        <span class="pt-icon">${def.icon}</span>
        <span class="pt-card-label">${escHtml(def.label)}</span>
        <span class="pt-badge ${statusClass}">${statusLabel}</span>
        <span class="pt-stats">${endpoints} endpoints &middot; ${attackVectors} vectors &middot; ${duration}</span>
        <span class="pt-finding-count ${findings.length > 0 ? 'has-findings' : ''}">${findings.length} finding${findings.length === 1 ? '' : 's'}</span>
        <span class="pt-chevron">&#9660;</span>
      </summary>
      <div class="pt-card-body">
        ${findings.length > 0
          ? `<div class="pt-findings-list">${findingsHtml}</div>`
          : '<div class="no-data-msg">No findings identified by this module.</div>'}
        ${mod.attackVectorsApplied && mod.attackVectorsApplied.length
          ? `<div class="pt-vectors"><span class="field-label-e">Attack vectors: </span>${mod.attackVectorsApplied.map(v => `<code class="code-tag">${escHtml(v)}</code>`).join(' ')}</div>`
          : ''}
      </div>
    </details>`;
  }).join('');
}

// ─── Finding Card ─────────────────────────────────────────────────────────────
function buildFindingCard(f, idx) {
  const sev       = (f.severity || 'informational').toLowerCase();
  const src       = (f.source   || 'zap').toLowerCase();
  const layerLabel = src === 'pentest' ? 'Pentest' : src === 'custom' ? 'Custom' : 'ZAP';
  const layerClass = src === 'pentest' ? 'pentest' : src === 'custom' ? 'custom' : 'zap';

  const sevLabel  = { critical:'Critical', high:'High', medium:'Medium', low:'Low', informational:'Informational' };

  const stepsHtml = (f.steps || []).map((step, i) =>
    `<div class="step-row"><div class="step-num">${i + 1}</div><span>${escHtml(step)}</span></div>`
  ).join('');

  const refsHtml = (f.references || []).map(r =>
    `<a href="${escHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="ref-link">${escHtml(r.label)}</a>`
  ).join(' &middot; ');

  let attackHtml = '';
  if (f.attackVector && (f.attackVector.technique || f.attackVector.payload)) {
    attackHtml = `<div class="detail-block">
      <div class="field-label-e">Attack Vector</div>
      ${f.attackVector.technique ? `<div class="meta-row-e"><span class="meta-lbl-e">Technique</span><code class="code-tag">${escHtml(f.attackVector.technique)}</code></div>` : ''}
      ${f.attackVector.payload   ? `<div class="meta-row-e"><span class="meta-lbl-e">Payload</span><code class="code-tag">${escHtml(f.attackVector.payload)}</code></div>` : ''}
    </div>`;
  }

  let remHtml = '';
  if (f.remediation && (f.remediation.shortTermFix || f.remediation.permanentFix)) {
    const codeEx = f.remediation.codeExample;
    remHtml = `<div class="detail-block" style="margin-top:0.75rem">
      <div class="field-label-e">Remediation Guidance</div>
      ${f.remediation.priority
        ? `<span class="priority-badge priority-${slugify(f.remediation.priority)}">${escHtml(f.remediation.priority)} Priority</span>`
        : ''}
      ${f.remediation.shortTermFix
        ? `<div class="meta-row-e"><span class="meta-lbl-e">Immediate action</span><span>${escHtml(f.remediation.shortTermFix)}</span></div>` : ''}
      ${f.remediation.permanentFix
        ? `<div class="meta-row-e"><span class="meta-lbl-e">Long-term fix</span><span>${escHtml(f.remediation.permanentFix)}</span></div>` : ''}
      ${codeEx && codeEx.vulnerable ? `<div class="code-compare">
        <div><div class="code-label bad">Vulnerable</div><pre class="code-block bad">${escHtml(codeEx.vulnerable)}</pre></div>
        <div><div class="code-label good">Secure</div><pre class="code-block good">${escHtml(codeEx.secure || '')}</pre></div>
      </div>` : ''}
    </div>`;
  }

  const statusBadge = f.status
    ? `<span class="status-badge status-${slugify(f.status)}">${escHtml(f.status)}</span>` : '';
  const jiraBug = f.jiraBug
    ? `<a href="#" class="jira-link">${escHtml(f.jiraBug)}</a>` : '\u2014';

  const alertHtml = sev === 'critical'
    ? `<div class="alert-banner alert-critical"><strong>Critical severity</strong> \u2014 Immediate action required before next deployment.</div>`
    : sev === 'high'
    ? `<div class="alert-banner alert-high"><strong>High severity</strong> \u2014 Schedule remediation within the current sprint.</div>`
    : '';

  return `<details class="finding-card fc-${sev}" id="fc-${idx}">
    <summary>
      <span class="sev-badge-dark sev-${sev}">${sevLabel[sev] || sev}</span>
      <span class="cvss-pill">CVSS ${(f.cvss || 0).toFixed(1)}</span>
      <span class="finding-name-text">${escHtml(f.name)}</span>
      <span class="fc-meta">
        <span class="layer-badge ${layerClass}">${escHtml(layerLabel)}</span>
        <span class="owasp-id-tag">${escHtml(f.owaspId || '')}</span>
        ${statusBadge}
        <span class="chevron-icon">&#9660;</span>
      </span>
    </summary>
    <div class="finding-body-dark">
      ${alertHtml}
      <div class="finding-grid">
        <div class="finding-col">
          <div class="field-label-e">Description</div>
          <p class="field-text-e">${escHtml(f.description)}</p>
          <div class="field-label-e" style="margin-top:1rem">Evidence</div>
          <pre class="evidence-dark">${escHtml(f.evidence)}</pre>
          <div class="field-label-e" style="margin-top:0.75rem">Affected URL</div>
          <code class="code-tag" style="display:block;word-break:break-all;padding:0.35rem 0.6rem">${escHtml(f.url)}</code>
        </div>
        <div class="finding-col">
          <div class="meta-block-e">
            <div class="meta-row-e"><span class="meta-lbl-e">OWASP 2021</span><span>${escHtml(f.owaspId)} \u2014 ${escHtml(f.owaspName)}</span></div>
            <div class="meta-row-e"><span class="meta-lbl-e">CVSS v3.1</span><span>${(f.cvss || 0).toFixed(1)} &nbsp;<code class="code-tag">${escHtml(f.cvssVector)}</code></span></div>
            <div class="meta-row-e"><span class="meta-lbl-e">CWE</span><span>${escHtml(f.cwe)} \u2014 ${escHtml(f.cweName)}</span></div>
            <div class="meta-row-e"><span class="meta-lbl-e">Jira Bug</span><span>${jiraBug}</span></div>
            ${f.pentestModule ? `<div class="meta-row-e"><span class="meta-lbl-e">Pentest Module</span><span>${escHtml(f.pentestModule)}</span></div>` : ''}
          </div>
          ${attackHtml}
        </div>
      </div>
      ${stepsHtml
        ? `<div class="field-label-e" style="margin-top:1rem">Step-by-step Remediation</div><div class="steps-list">${stepsHtml}</div>`
        : ''}
      ${remHtml}
      ${refsHtml
        ? `<div class="refs-row">References: ${refsHtml}</div>` : ''}
    </div>
  </details>`;
}

// ─── Human Pentest Guide ──────────────────────────────────────────────────────
function buildPentestGuide() {
  const sections = [
    { title:'Reconnaissance', num:'01', steps:[
      'Map all API endpoints using ZAP spider or Burp Suite crawl.',
      'Identify authentication mechanisms: JWT, session cookies, OAuth tokens.',
      'Enumerate user roles and privilege levels from API documentation or client-side JS.',
      'Review robots.txt, sitemap.xml, .well-known endpoints for information leakage.',
    ]},
    { title:'Authentication Testing', num:'02', steps:[
      'Test brute-force resistance: attempt >10 failed logins and verify 429/lockout response.',
      'Test password reset flows for token predictability and expiry enforcement.',
      'Verify JWT signature: attempt alg:none attack; check expiry and secret strength.',
      'Test multi-factor authentication bypass, recovery code exhaustion, and session persistence.',
    ]},
    { title:'Authorization & IDOR', num:'03', steps:[
      'Replace your user ID in every API request with another known user ID and observe response.',
      'Test horizontal privilege escalation across all resource types (employees, documents, orders).',
      'Attempt vertical privilege escalation: call admin endpoints as a standard user.',
      'Test parameter manipulation: ?admin=true, ?role=admin, X-User-ID header injection.',
    ]},
    { title:'Injection Testing', num:'04', steps:[
      'Test SQL injection in all query parameters, request headers, and JSON body fields.',
      'Test XSS (stored, reflected, DOM-based) in all input fields and URL parameters.',
      'Test command injection in file upload names, URL paths, and dynamic form fields.',
      'Test SSTI in template-rendered fields and error messages.',
    ]},
    { title:'Session Management', num:'05', steps:[
      'Capture session tokens and analyse for predictability, entropy, and pattern.',
      'Test session fixation: set a pre-authentication token and verify replacement post-login.',
      'Verify Secure, HttpOnly, and SameSite=Strict flags on all authentication cookies.',
      'Test session invalidation: verify all tokens are rejected server-side after logout.',
    ]},
    { title:'Business Logic', num:'06', steps:[
      'Test negative quantities, boundary values, and unexpected data types in all forms.',
      'Replay completed transaction requests to verify idempotency enforcement.',
      'Attempt workflow bypass: skip steps in multi-step processes (checkout, approval flows).',
      'Attempt cross-tenant access: access resources belonging to a different organisational tenant.',
    ]},
  ];
  return sections.map(s => `<div class="guide-section">
    <div class="guide-section-hdr">
      <span class="guide-num">${s.num}</span>
      <span class="guide-section-title">${escHtml(s.title)}</span>
    </div>
    <ul class="guide-steps">${s.steps.map(step => `<li>${escHtml(step)}</li>`).join('')}</ul>
  </div>`).join('');
}

// ─── Compliance Section ───────────────────────────────────────────────────────
function buildComplianceSection(findings) {
  const owaspCountMap = {};
  for (const f of findings) {
    const id = (f.owaspId || 'Unknown').split(':')[0] + ':2021';
    owaspCountMap[id] = (owaspCountMap[id] || 0) + 1;
  }
  const rows = OWASP_TOP10.map(o => {
    const cnt  = owaspCountMap[o.id] || 0;
    const wf   = findings.filter(f => (f.owaspId || '').includes(o.id.split(':')[0]));
    const ws   = worstSev(wf) || 'informational';
    const status   = cnt === 0 ? 'PASS' : (SEV_ORDER[ws] >= 4 ? 'FAIL' : 'WARN');
    const stClass  = status === 'PASS' ? 'compliance-pass' : status === 'FAIL' ? 'compliance-fail' : 'compliance-warn';
    const sevLabel = { critical:'Critical', high:'High', medium:'Medium', low:'Low', informational:'Info' };
    return `<tr>
      <td><span class="owasp-id-colored" style="color:${o.color}">${escHtml(o.id)}</span></td>
      <td>${escHtml(o.name)}</td>
      <td class="tc">${cnt > 0 ? `<strong>${cnt}</strong>` : '0'}</td>
      <td>${cnt > 0 ? `<span class="sev-badge-dark sev-${ws}">${sevLabel[ws] || ws}</span>` : '\u2014'}</td>
      <td><span class="compliance-badge ${stClass}">${status}</span></td>
    </tr>`;
  }).join('');

  const passed = OWASP_TOP10.filter(o => !owaspCountMap[o.id]).length;
  const failed = OWASP_TOP10.filter(o => {
    if (!owaspCountMap[o.id]) return false;
    const wf = findings.filter(f => (f.owaspId || '').includes(o.id.split(':')[0]));
    return (SEV_ORDER[worstSev(wf)] || 0) >= 4;
  }).length;

  return `<div class="compliance-summary">
    <div class="compliance-stat"><span class="compliance-stat-val" style="color:var(--s-pass)">${passed}</span><span class="compliance-stat-lbl">Categories with no findings</span></div>
    <div class="compliance-stat"><span class="compliance-stat-val" style="color:var(--s-warn)">${10 - passed - failed}</span><span class="compliance-stat-lbl">Categories — warnings</span></div>
    <div class="compliance-stat"><span class="compliance-stat-val" style="color:var(--s-fail)">${failed}</span><span class="compliance-stat-lbl">Categories — failed</span></div>
  </div>
  <table class="compliance-table">
    <thead><tr><th>OWASP ID</th><th>Category</th><th class="tc">Findings</th><th>Worst Severity</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// ─── Master HTML Builder ──────────────────────────────────────────────────────
function buildHtml(reportData) {
  const { findings, verdict, storyKey, meta, chartJsSrc, score } = reportData;
  const m = meta || {};

  const counts = { critical:0, high:0, medium:0, low:0, informational:0, total:0 };
  for (const f of findings) {
    const s = (f.severity || 'informational').toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    counts.total++;
  }

  const durationStr    = formatDuration(m.durationSeconds);
  const verdictText    = verdict === 'pass' ? 'Assessment Passed'
                       : verdict === 'warn' ? 'Action Recommended'
                       : 'Immediate Action Required';
  const verdictSubtext = verdict === 'pass' ? 'No critical or high severity issues found'
                       : verdict === 'warn' ? 'Medium severity findings require attention'
                       : 'Critical or high severity findings demand immediate remediation';

  const pentestModules      = m.pentestModules || [];
  const totalPentestFindgs  = pentestModules.reduce((sum, pm) => sum + (pm.findings || []).length, 0);
  const pentestDurationSec  = m.pentestDurationMs ? (m.pentestDurationMs / 1000).toFixed(0) : null;
  const pentestTotalVectors = m.pentestTotalAttackVectors || 0;
  const pentestSuccessRate  = m.pentestSuccessfulExploits && pentestTotalVectors
    ? ((m.pentestSuccessfulExploits / pentestTotalVectors) * 100).toFixed(1) : null;

  const sortedFindings = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0);
    return sd !== 0 ? sd : (b.cvss || 0) - (a.cvss || 0);
  });

  const layers = {
    zap:     { critical:0, high:0, medium:0, low:0, informational:0 },
    custom:  { critical:0, high:0, medium:0, low:0, informational:0 },
    pentest: { critical:0, high:0, medium:0, low:0, informational:0 },
  };
  for (const f of findings) {
    const src = (f.source || 'zap').toLowerCase();
    const sev = (f.severity || 'informational').toLowerCase();
    if (layers[src] && layers[src][sev] !== undefined) layers[src][sev]++;
  }

  const historicalScans = m.historicalScans || [];

  const findingCardsHtml   = sortedFindings.map((f, i) => buildFindingCard(f, i)).join('');
  const pentestModuleCards = buildPentestModuleCards(pentestModules);
  const pentestGuideHtml   = buildPentestGuide();
  const complianceHtml     = buildComplianceSection(findings);
  const owaspHeatmapHtml   = buildOwaspHeatmap(findings);
  const svgGauge           = buildSvgGauge(score);

  const FINDINGS_JSON         = JSON.stringify(findings.map(f => ({
    severity: (f.severity || 'informational').toLowerCase(),
    cvss:     f.cvss || 0,
    owaspId:  f.owaspId || '',
    source:   (f.source || 'zap').toLowerCase(),
  })));
  const COUNTS_JSON           = JSON.stringify(counts);
  const LAYERS_JSON           = JSON.stringify(layers);
  const HISTORICAL_JSON       = JSON.stringify(historicalScans);
  const PENTEST_COVERAGE_JSON = JSON.stringify(PENTEST_MODULES.map(def => {
    const mod = pentestModules.find(pm => (pm.name || pm.key) === def.key) || {};
    return { label: def.label, endpoints: mod.endpointsTested || 0, findings: (mod.findings || []).length };
  }));

  function metaRowHtml(label, value) {
    if (value == null || value === '' || value === '\u2014') return '';
    return `<div class="meta-row-e"><span class="meta-lbl-e">${escHtml(label)}</span><span>${escHtml(String(value))}</span></div>`;
  }

  const sevBadgesTop = ['critical', 'high', 'medium', 'low', 'informational']
    .filter(s => counts[s] > 0)
    .map(s => `<span class="sev-badge-top sev-${s}">${counts[s]} ${s.charAt(0).toUpperCase() + s.slice(1)}</span>`)
    .join('');

  const maxCvss    = findings.reduce((mx, f) => Math.max(mx, f.cvss || 0), 0);
  const owaspCount = new Set(findings.filter(f => f.owaspId).map(f => f.owaspId.split(':')[0])).size;

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width,initial-scale=1.0">
<title>Security Assessment \u2014 ${escHtml(storyKey)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Inter:ital,wght@0,300;0,400;0,500;0,600;0,700;0,800;1,400&family=JetBrains+Mono:wght@400;500&display=swap');
*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}
:root{
  --white:#ffffff; --g50:#f8fafc; --g100:#f1f5f9; --g200:#e2e8f0; --g300:#cbd5e1;
  --g400:#94a3b8; --g500:#64748b; --g600:#475569; --g700:#334155; --g800:#1e293b; --g900:#0f172a;
  --brand:#1e3a5f; --brand2:#162d49; --accent:#2563eb; --accent-l:#dbeafe;
  --c-c:#b91c1c; --c-c-bg:#fef2f2; --c-c-br:#fca5a5;
  --c-h:#c2410c; --c-h-bg:#fff7ed; --c-h-br:#fdba74;
  --c-m:#92400e; --c-m-bg:#fffbeb; --c-m-br:#fcd34d;
  --c-l:#1e40af; --c-l-bg:#eff6ff; --c-l-br:#93c5fd;
  --c-i:#5b21b6; --c-i-bg:#f5f3ff; --c-i-br:#c4b5fd;
  --s-pass:#166534; --s-pass-bg:#f0fdf4; --s-pass-br:#86efac;
  --s-warn:#92400e; --s-warn-bg:#fffbeb; --s-warn-br:#fcd34d;
  --s-fail:#991b1b; --s-fail-bg:#fef2f2; --s-fail-br:#fca5a5;
  --bg:#f1f5f9; --card:#ffffff; --border:#e2e8f0; --border2:#cbd5e1;
  --shadow:0 1px 3px rgba(15,23,42,.06),0 1px 2px rgba(15,23,42,.04);
  --shadow2:0 4px 12px rgba(15,23,42,.08),0 2px 4px rgba(15,23,42,.04);
  --r:8px; --r2:12px;
}
html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;font-size:13px;color:var(--g900);background:var(--bg);line-height:1.6;min-height:100vh;-webkit-font-smoothing:antialiased}
a{color:var(--accent);text-decoration:none}
a:hover{text-decoration:underline}

/* Classification */
.cls-bar{background:var(--brand);color:rgba(255,255,255,.9);font-size:10px;font-weight:600;letter-spacing:.09em;padding:5px 2rem;display:flex;justify-content:space-between;align-items:center;text-transform:uppercase}
.cls-label{background:rgba(255,255,255,.18);padding:2px 10px;border-radius:3px;letter-spacing:.14em;color:#fff;font-weight:700}

/* Nav */
.top-nav{position:sticky;top:0;z-index:100;background:var(--brand2);border-bottom:2px solid rgba(255,255,255,.06);display:flex;align-items:stretch;min-height:46px}
.nav-logo{padding:0 1.25rem;display:flex;align-items:center;gap:9px;border-right:1px solid rgba(255,255,255,.1);flex-shrink:0}
.nav-logo-mark{width:24px;height:24px;background:var(--accent);border-radius:5px;display:flex;align-items:center;justify-content:center;font-size:13px;font-weight:800;color:#fff;flex-shrink:0}
.nav-logo-text{font-size:12px;font-weight:700;color:#fff;white-space:nowrap}
.nav-tabs{display:flex;flex:1;overflow-x:auto}
.nav-tab{padding:0 1rem;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;color:rgba(255,255,255,.5);font-family:'Inter',sans-serif;font-size:12px;font-weight:500;white-space:nowrap;transition:color .15s,border-color .15s;height:46px;align-self:stretch;display:flex;align-items:center}
.nav-tab:hover{color:rgba(255,255,255,.85)}
.nav-tab.active{color:#fff;border-bottom-color:var(--accent)}
.nav-actions{padding:0 1rem;display:flex;gap:8px;align-items:center;border-left:1px solid rgba(255,255,255,.1)}
.btn-action{padding:.35rem .9rem;border-radius:5px;border:1px solid rgba(255,255,255,.2);background:rgba(255,255,255,.08);color:rgba(255,255,255,.9);font-size:11px;font-weight:600;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s;white-space:nowrap}
.btn-action:hover{background:rgba(255,255,255,.16);border-color:rgba(255,255,255,.35)}

/* Report header */
.report-header{background:var(--card);border-bottom:1px solid var(--border);box-shadow:var(--shadow)}
.rh-inner{display:flex;justify-content:space-between;align-items:flex-start;gap:2rem;flex-wrap:wrap;padding:2rem;max-width:1440px;margin:0 auto}
.rh-type{font-size:11px;font-weight:700;color:var(--accent);text-transform:uppercase;letter-spacing:.08em;margin-bottom:.45rem;display:flex;align-items:center;gap:8px}
.rh-type-line{display:inline-block;width:18px;height:2px;background:var(--accent);border-radius:1px}
.rh-title{font-size:22px;font-weight:700;color:var(--g900);line-height:1.25;margin-bottom:.65rem}
.rh-meta{font-size:12px;color:var(--g500);line-height:2}
.rh-meta strong{color:var(--g700);font-weight:600}
.rh-right{display:flex;flex-direction:column;align-items:flex-end;gap:.8rem;min-width:200px}
.verdict-chip{padding:.5rem 1.4rem;border-radius:6px;font-size:12px;font-weight:700;letter-spacing:.04em;white-space:nowrap;border-width:1px;border-style:solid;text-align:center}
.verdict-chip small{display:block;font-size:10px;font-weight:400;letter-spacing:.01em;margin-top:2px;opacity:.85}
.verdict-pass{background:var(--s-pass-bg);color:var(--s-pass);border-color:var(--s-pass-br)}
.verdict-warn{background:var(--s-warn-bg);color:var(--s-warn);border-color:var(--s-warn-br)}
.verdict-fail{background:var(--s-fail-bg);color:var(--s-fail);border-color:var(--s-fail-br)}
.sev-badges-row{display:flex;gap:5px;flex-wrap:wrap;justify-content:flex-end}
.sev-badge-top{font-size:11px;font-weight:600;padding:3px 10px;border-radius:5px;white-space:nowrap;border-width:1px;border-style:solid}
.sev-badge-top.sev-critical{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.sev-badge-top.sev-high{background:var(--c-h-bg);color:var(--c-h);border-color:var(--c-h-br)}
.sev-badge-top.sev-medium{background:var(--c-m-bg);color:var(--c-m);border-color:var(--c-m-br)}
.sev-badge-top.sev-low{background:var(--c-l-bg);color:var(--c-l);border-color:var(--c-l-br)}
.sev-badge-top.sev-informational{background:var(--c-i-bg);color:var(--c-i);border-color:var(--c-i-br)}

/* Tabs */
.tab-panel{display:none}
.tab-panel.active{display:block}
.section-pad{padding:1.75rem 2rem;max-width:1440px;margin:0 auto}

/* Section heading */
.section-hdr{font-size:11px;font-weight:700;color:var(--g500);text-transform:uppercase;letter-spacing:.09em;margin-bottom:1.25rem;display:flex;align-items:center;gap:.6rem}
.section-hdr::after{content:"";flex:1;height:1px;background:var(--border)}

/* KPI */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(120px,1fr));gap:10px;margin-bottom:1.5rem}
.kpi-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:.95rem 1rem;text-align:center;box-shadow:var(--shadow);transition:box-shadow .2s,transform .2s}
.kpi-card:hover{box-shadow:var(--shadow2);transform:translateY(-1px)}
.kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--g400);margin-bottom:.3rem;font-weight:600}
.kpi-value{font-size:28px;font-weight:700;line-height:1.1;letter-spacing:-.01em}
.kpi-value.kv-critical{color:var(--c-c)} .kpi-value.kv-high{color:var(--c-h)} .kpi-value.kv-medium{color:var(--c-m)}
.kpi-value.kv-low{color:var(--c-l)} .kpi-value.kv-info{color:var(--c-i)} .kpi-value.kv-total{color:var(--g800)} .kpi-value.kv-score{color:var(--brand)}

/* Dashboard */
.exec-dashboard{display:grid;grid-template-columns:auto 1fr 1fr;gap:16px;align-items:start;margin-bottom:1.5rem}
.gauge-block{display:flex;flex-direction:column;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:1.25rem 1.5rem;gap:.35rem;box-shadow:var(--shadow)}
.gauge-lbl{font-size:10px;text-transform:uppercase;letter-spacing:.08em;color:var(--g400);font-weight:600}
.chart-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:1.1rem 1.25rem;box-shadow:var(--shadow)}
.chart-card-title{font-size:10px;font-weight:700;color:var(--g400);text-transform:uppercase;letter-spacing:.07em;margin-bottom:.75rem}
.chart-wrap{position:relative}

/* OWASP heatmap */
.owasp-heatmap{display:grid;grid-template-columns:repeat(5,1fr);gap:5px}
.owasp-cell{border-radius:6px;padding:.6rem .35rem;text-align:center;cursor:default;transition:transform .15s,box-shadow .15s}
.owasp-cell:hover{transform:translateY(-2px);box-shadow:var(--shadow2)}
.owasp-cell-id{font-size:9px;font-weight:700;font-family:'JetBrains Mono',monospace;margin-bottom:2px}
.owasp-cell-count{font-size:20px;font-weight:700;line-height:1.1}

/* Severity badges */
.sev-badge-dark{display:inline-block;font-size:10px;font-weight:700;padding:3px 9px;border-radius:4px;white-space:nowrap;border-width:1px;border-style:solid}
.sev-badge-dark.sev-critical{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.sev-badge-dark.sev-high{background:var(--c-h-bg);color:var(--c-h);border-color:var(--c-h-br)}
.sev-badge-dark.sev-medium{background:var(--c-m-bg);color:var(--c-m);border-color:var(--c-m-br)}
.sev-badge-dark.sev-low{background:var(--c-l-bg);color:var(--c-l);border-color:var(--c-l-br)}
.sev-badge-dark.sev-informational,.sev-badge-dark.sev-info{background:var(--c-i-bg);color:var(--c-i);border-color:var(--c-i-br)}

/* Layer badges */
.layer-badge{display:inline-block;font-size:10px;font-weight:600;padding:2px 8px;border-radius:4px;border-width:1px;border-style:solid}
.layer-badge.zap{background:#f0eeff;color:#5b21b6;border-color:#c4b5fd}
.layer-badge.custom{background:#fff4e6;color:#c2410c;border-color:#fdba74}
.layer-badge.pentest{background:#fdf2f8;color:#be185d;border-color:#f9a8d4}

/* Finding cards */
.finding-card{background:var(--card);border:1px solid var(--border);border-left-width:4px;border-radius:var(--r);margin-bottom:8px;overflow:hidden;box-shadow:var(--shadow);transition:box-shadow .2s}
.finding-card:hover{box-shadow:var(--shadow2)}
.finding-card.fc-critical{border-left-color:var(--c-c)} .finding-card.fc-high{border-left-color:var(--c-h)}
.finding-card.fc-medium{border-left-color:var(--c-m)} .finding-card.fc-low{border-left-color:var(--c-l)}
.finding-card.fc-informational,.finding-card.fc-info{border-left-color:var(--c-i)}
.finding-card summary{padding:.85rem 1rem .85rem .9rem;cursor:pointer;display:flex;align-items:center;gap:8px;list-style:none;user-select:none}
.finding-card summary::-webkit-details-marker{display:none}
.finding-card[open] summary{border-bottom:1px solid var(--border)}
.finding-card[open] summary .chevron-icon{transform:rotate(180deg)}
.chevron-icon{font-size:10px;transition:transform .18s ease;color:var(--g300);flex-shrink:0}
.finding-name-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-weight:500;color:var(--g800);font-size:13px}
.cvss-pill{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--g400);flex-shrink:0;background:var(--g100);padding:2px 7px;border-radius:4px;border:1px solid var(--border)}
.owasp-id-tag{font-size:10px;color:var(--g400);font-family:'JetBrains Mono',monospace;flex-shrink:0}
.fc-meta{margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0}
.finding-body-dark{padding:1.25rem;background:var(--g50);font-size:12px}
.finding-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:.5rem}
.field-label-e{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--g400);font-weight:700;margin-bottom:.35rem}
.field-text-e{font-size:12px;color:var(--g600);line-height:1.65}
.evidence-dark{font-family:'JetBrains Mono',monospace;font-size:10.5px;background:var(--g900);color:#cbd5e1;border-radius:var(--r);padding:.7rem .9rem;word-break:break-all;white-space:pre-wrap;overflow-x:auto;margin-top:.35rem;max-height:160px;line-height:1.6}
.meta-block-e{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:.8rem;display:flex;flex-direction:column;gap:.5rem;box-shadow:var(--shadow)}
.meta-row-e{display:flex;justify-content:space-between;gap:1rem;font-size:12px;align-items:baseline;flex-wrap:wrap;padding-bottom:.4rem;border-bottom:1px solid var(--g100)}
.meta-row-e:last-child{border-bottom:none;padding-bottom:0}
.meta-lbl-e{color:var(--g400);white-space:nowrap;flex-shrink:0;min-width:100px;font-weight:500}
.code-tag{font-family:'JetBrains Mono',monospace;font-size:10px;background:var(--g100);color:var(--accent);padding:1px 5px;border-radius:3px;word-break:break-all;border:1px solid var(--border)}
.detail-block{margin-top:.75rem;background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:.8rem;display:flex;flex-direction:column;gap:.4rem;box-shadow:var(--shadow)}
.steps-list{display:flex;flex-direction:column;gap:.4rem;margin-top:.35rem}
.step-row{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.55;color:var(--g600)}
.step-num{width:20px;height:20px;min-width:20px;border-radius:50%;background:var(--accent);color:#fff;font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0;margin-top:1px}
.alert-banner{border-radius:5px;padding:.55rem .8rem;font-size:12px;font-weight:500;margin-bottom:.75rem;border-width:1px;border-left-width:3px;border-style:solid}
.alert-critical{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.alert-high{background:var(--c-h-bg);color:var(--c-h);border-color:var(--c-h-br)}
.jira-link{color:var(--accent);font-weight:500}
.ref-link{color:var(--accent);font-size:11px}
.refs-row{margin-top:.6rem;font-size:11px;color:var(--g400);padding-top:.6rem;border-top:1px solid var(--border)}
.status-badge{display:inline-block;font-size:10px;padding:2px 7px;border-radius:4px;font-weight:600;border-width:1px;border-style:solid}
.status-badge.status-new{background:var(--s-pass-bg);color:var(--s-pass);border-color:var(--s-pass-br)}
.status-badge.status-recurring{background:var(--c-h-bg);color:var(--c-h);border-color:var(--c-h-br)}
.status-badge.status-regression{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.status-badge.status-suppressed{background:var(--g100);color:var(--g400);border-color:var(--border)}
.priority-badge{display:inline-block;font-size:10px;padding:2px 9px;border-radius:4px;font-weight:700;border-width:1px;border-style:solid;margin-bottom:.4rem}
.priority-badge.priority-p0{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.priority-badge.priority-p1{background:var(--c-h-bg);color:var(--c-h);border-color:var(--c-h-br)}
.priority-badge.priority-p2{background:var(--c-m-bg);color:var(--c-m);border-color:var(--c-m-br)}
.priority-badge.priority-p3{background:var(--c-l-bg);color:var(--c-l);border-color:var(--c-l-br)}
.code-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:.5rem}
.code-label{font-size:10px;font-weight:700;padding:3px 8px;border-radius:4px 4px 0 0}
.code-label.bad{background:var(--c-c-bg);color:var(--c-c)} .code-label.good{background:var(--s-pass-bg);color:var(--s-pass)}
.code-block{font-family:'JetBrains Mono',monospace;font-size:10px;border-radius:0 4px 4px 4px;padding:.5rem;overflow-x:auto;white-space:pre-wrap;line-height:1.5}
.code-block.bad{background:#fff8f8;color:var(--c-c);border:1px solid var(--c-c-br)}
.code-block.good{background:var(--s-pass-bg);color:var(--s-pass);border:1px solid var(--s-pass-br)}

/* Sev dots */
.sev-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sev-dot-critical{background:var(--c-c)} .sev-dot-high{background:var(--c-h)} .sev-dot-medium{background:var(--c-m)}
.sev-dot-low{background:var(--c-l)} .sev-dot-informational,.sev-dot-info{background:var(--c-i)}

/* Pentest cards */
.pt-card{background:var(--card);border:1px solid var(--border);border-radius:var(--r);margin-bottom:8px;overflow:hidden;box-shadow:var(--shadow);transition:box-shadow .2s}
.pt-card:hover{box-shadow:var(--shadow2)}
.pt-card[open]{border-color:var(--border2)}
.pt-card summary{padding:.85rem 1rem;cursor:pointer;display:flex;align-items:center;gap:10px;list-style:none;user-select:none;flex-wrap:wrap}
.pt-card summary::-webkit-details-marker{display:none}
.pt-card[open] summary{border-bottom:1px solid var(--border)}
.pt-card[open] summary .pt-chevron{transform:rotate(180deg)}
.pt-chevron{font-size:10px;transition:transform .18s ease;color:var(--g300);margin-left:auto;flex-shrink:0}
.pt-icon{font-size:16px;flex-shrink:0;line-height:1}
.pt-card-label{font-weight:600;color:var(--g800);flex-shrink:0;font-size:13px}
.pt-stats{font-size:11px;color:var(--g400)}
.pt-finding-count{font-size:11px;font-weight:700;padding:2px 9px;border-radius:4px;background:var(--g100);color:var(--g500);border:1px solid var(--border)}
.pt-finding-count.has-findings{background:var(--c-c-bg);color:var(--c-c);border-color:var(--c-c-br)}
.pt-badge{font-size:10px;font-weight:700;padding:2px 9px;border-radius:4px;border-width:1px;border-style:solid}
.pt-status-success{background:var(--s-pass-bg);color:var(--s-pass);border-color:var(--s-pass-br)}
.pt-status-partial{background:var(--s-warn-bg);color:var(--s-warn);border-color:var(--s-warn-br)}
.pt-status-failed{background:var(--s-fail-bg);color:var(--s-fail);border-color:var(--s-fail-br)}
.pt-status-notrun{background:var(--g100);color:var(--g400);border-color:var(--border)}
.pt-card-body{padding:1rem 1.2rem;background:var(--g50);font-size:12px}
.pt-findings-list{display:flex;flex-direction:column;gap:5px;margin-bottom:.75rem}
.pt-finding-row{display:flex;align-items:center;gap:8px;padding:.4rem .7rem;background:var(--card);border:1px solid var(--border);border-radius:var(--r);box-shadow:var(--shadow)}
.pt-finding-name{flex:1;color:var(--g700);font-weight:500}
.pt-finding-cvss{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--g400);flex-shrink:0}
.pt-vectors{margin-top:.5rem;display:flex;flex-wrap:wrap;gap:5px;align-items:center}

/* Guide */
.guide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:14px}
.guide-section{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:1.1rem 1.2rem;box-shadow:var(--shadow)}
.guide-section-hdr{display:flex;align-items:center;gap:10px;margin-bottom:.75rem;padding-bottom:.65rem;border-bottom:1px solid var(--border)}
.guide-num{width:26px;height:26px;border-radius:50%;background:var(--accent);color:#fff;font-size:11px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.guide-section-title{font-size:13px;font-weight:700;color:var(--g800)}
.guide-steps{padding-left:1.2rem;display:flex;flex-direction:column;gap:.45rem}
.guide-steps li{font-size:12px;color:var(--g600);line-height:1.65}

/* Compliance */
.compliance-summary{display:flex;gap:12px;margin-bottom:1.25rem;flex-wrap:wrap}
.compliance-stat{display:flex;flex-direction:column;align-items:center;background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:1rem 1.75rem;box-shadow:var(--shadow);min-width:130px}
.compliance-stat-val{font-size:32px;font-weight:700;line-height:1}
.compliance-stat-lbl{font-size:11px;color:var(--g400);margin-top:.3rem;text-align:center}
.compliance-table{width:100%;border-collapse:collapse;font-size:12px;border-radius:var(--r);overflow:hidden;box-shadow:var(--shadow)}
.compliance-table th{font-size:10px;text-transform:uppercase;letter-spacing:.06em;color:var(--g500);background:var(--g50);border-bottom:1px solid var(--border);padding:.6rem .9rem;text-align:left;font-weight:700}
.compliance-table td{padding:.6rem .9rem;border-bottom:1px solid var(--border);vertical-align:middle;background:var(--card)}
.compliance-table tr:last-child td{border-bottom:none}
.compliance-table tbody tr:hover td{background:var(--g50)}
.compliance-badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 10px;border-radius:4px;border-width:1px;border-style:solid}
.compliance-pass{background:var(--s-pass-bg);color:var(--s-pass);border-color:var(--s-pass-br)}
.compliance-fail{background:var(--s-fail-bg);color:var(--s-fail);border-color:var(--s-fail-br)}
.compliance-warn{background:var(--s-warn-bg);color:var(--s-warn);border-color:var(--s-warn-br)}
.owasp-id-colored{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700}
.tc{text-align:center}

/* Meta */
.meta-2col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.meta-section{background:var(--card);border:1px solid var(--border);border-radius:var(--r2);padding:1.1rem 1.25rem;box-shadow:var(--shadow)}
.meta-section-title{font-size:10px;font-weight:700;text-transform:uppercase;letter-spacing:.07em;color:var(--accent);margin-bottom:.75rem;padding-bottom:.5rem;border-bottom:1px solid var(--border)}

/* Risk stats */
.risk-panel{display:grid;grid-template-columns:1fr 1fr 1fr;gap:12px;margin-bottom:1.5rem}
.risk-stat{background:var(--card);border:1px solid var(--border);border-radius:var(--r);padding:.85rem 1rem;box-shadow:var(--shadow)}
.risk-stat-label{font-size:10px;text-transform:uppercase;letter-spacing:.07em;color:var(--g400);font-weight:600;margin-bottom:.3rem}
.risk-stat-value{font-size:18px;font-weight:700;color:var(--g800)}
.risk-stat-sub{font-size:11px;color:var(--g500);margin-top:.2rem}

/* No data */
.no-data-msg{color:var(--g400);font-size:12px;padding:1.5rem;text-align:center;background:var(--g50);border:1px dashed var(--border2);border-radius:var(--r)}

/* Filters */
.filter-bar{display:flex;gap:6px;margin-bottom:1rem;flex-wrap:wrap}
.filter-btn{padding:.3rem .85rem;border-radius:5px;border:1px solid var(--border);background:var(--card);color:var(--g500);font-size:11px;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif;font-weight:500}
.filter-btn:hover,.filter-btn.active{border-color:var(--accent);color:var(--accent);background:var(--accent-l)}
.filter-btn.f-critical.active{border-color:var(--c-c);color:var(--c-c);background:var(--c-c-bg)}
.filter-btn.f-high.active{border-color:var(--c-h);color:var(--c-h);background:var(--c-h-bg)}
.filter-btn.f-medium.active{border-color:var(--c-m);color:var(--c-m);background:var(--c-m-bg)}
.filter-btn.f-low.active{border-color:var(--c-l);color:var(--c-l);background:var(--c-l-bg)}

/* Footer */
.report-footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border);padding:1rem 2rem;font-size:11px;color:var(--g400);flex-wrap:wrap;gap:.5rem;background:var(--card)}
.footer-conf{font-size:10px;font-weight:600;letter-spacing:.06em;color:var(--g300);text-transform:uppercase}

/* Print */
@media print{
  .cls-bar,.top-nav,.filter-bar,.btn-action{display:none!important}
  .tab-panel{display:block!important}
  body{background:#fff}
  .report-header,.chart-card,.kpi-card,.meta-section,.guide-section,.finding-card,.pt-card,.compliance-table{box-shadow:none!important}
  .evidence-dark{background:#f1f5f9!important;color:#334155!important;border:1px solid #e2e8f0}
  .finding-card,.pt-card{page-break-inside:avoid}
}
@media(max-width:768px){
  .exec-dashboard,.finding-grid,.meta-2col,.risk-panel{grid-template-columns:1fr}
  .rh-inner,.section-pad{padding:1.25rem}
}
</style>
</head>
<body>

<!-- Classification ribbon -->
<div class="cls-bar" role="banner">
  <span class="cls-label">Confidential</span>
  <span>Security &amp; Penetration Testing Assessment &mdash; ${escHtml(storyKey)}</span>
  <span>Agentic QA Platform &middot; ${formatTimestamp(new Date().toISOString())}</span>
</div>

<!-- Navigation -->
<nav class="top-nav" role="navigation" aria-label="Report sections">
  <div class="nav-logo">
    <div class="nav-logo-mark">S</div>
    <span class="nav-logo-text">Security Assessment</span>
  </div>
  <div class="nav-tabs" role="tablist">
    <button class="nav-tab active" id="ntab-exec"       role="tab" aria-selected="true"  aria-controls="tab-exec"       onclick="showTab('exec',this)">Executive Summary</button>
    <button class="nav-tab"        id="ntab-owasp"      role="tab" aria-selected="false" aria-controls="tab-owasp"      onclick="showTab('owasp',this)">OWASP Top 10</button>
    <button class="nav-tab"        id="ntab-pentest"    role="tab" aria-selected="false" aria-controls="tab-pentest"    onclick="showTab('pentest',this)">Pentest Results</button>
    <button class="nav-tab"        id="ntab-guide"      role="tab" aria-selected="false" aria-controls="tab-guide"      onclick="showTab('guide',this)">Pentest Guide</button>
    <button class="nav-tab"        id="ntab-findings"   role="tab" aria-selected="false" aria-controls="tab-findings"   onclick="showTab('findings',this)">All Findings</button>
    <button class="nav-tab"        id="ntab-compliance" role="tab" aria-selected="false" aria-controls="tab-compliance" onclick="showTab('compliance',this)">Compliance</button>
    <button class="nav-tab"        id="ntab-meta"       role="tab" aria-selected="false" aria-controls="tab-meta"       onclick="showTab('meta',this)">Scan Details</button>
  </div>
  <div class="nav-actions">
    <button class="btn-action" onclick="window.print()">Export PDF</button>
  </div>
</nav>

<!-- Report header -->
<header class="report-header">
  <div class="rh-inner">
    <div class="rh-left">
      <div class="rh-type"><span class="rh-type-line"></span>Security Assessment Report</div>
      <h1 class="rh-title">Security &amp; Penetration Testing Assessment</h1>
      <div class="rh-meta">
        Story: <strong>${escHtml(storyKey)}</strong> &nbsp;&middot;&nbsp;
        Target: <strong>${escHtml(m.targetUrl || '\u2014')}</strong> &nbsp;&middot;&nbsp;
        Assessed: <strong>${formatTimestamp(m.startTime)}</strong><br>
        Engine: OWASP ZAP ${escHtml(m.zapVersion || '\u2014')} (${escHtml(m.scanType || '\u2014')})
        &nbsp;+&nbsp; ${m.customChecksRun || 0} custom checks
        ${pentestModules.length ? ` &nbsp;+&nbsp; ${pentestModules.length} pentest modules` : ''}
        &nbsp;&middot;&nbsp; OWASP Top&nbsp;10 (2021) &nbsp;&middot;&nbsp; CVSS&nbsp;v3.1
      </div>
    </div>
    <div class="rh-right">
      <span class="verdict-chip verdict-${verdict}">
        ${escHtml(verdictText)}
        <small>${escHtml(verdictSubtext)}</small>
      </span>
      <div class="sev-badges-row">${sevBadgesTop}</div>
    </div>
  </div>
</header>

<!-- ══ TAB 1: EXECUTIVE SUMMARY ══════════════════════════════════════════════ -->
<section id="tab-exec" class="tab-panel active section-pad" role="tabpanel" aria-labelledby="ntab-exec">
  <div class="section-hdr">Key metrics</div>
  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-label">Risk Score</div><div class="kpi-value kv-score">${score}</div></div>
    <div class="kpi-card"><div class="kpi-label">Critical</div><div class="kpi-value kv-critical">${counts.critical}</div></div>
    <div class="kpi-card"><div class="kpi-label">High</div><div class="kpi-value kv-high">${counts.high}</div></div>
    <div class="kpi-card"><div class="kpi-label">Medium</div><div class="kpi-value kv-medium">${counts.medium}</div></div>
    <div class="kpi-card"><div class="kpi-label">Low</div><div class="kpi-value kv-low">${counts.low}</div></div>
    <div class="kpi-card"><div class="kpi-label">Informational</div><div class="kpi-value kv-info">${counts.informational}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Findings</div><div class="kpi-value kv-total">${counts.total}</div></div>
    ${pentestTotalVectors ? `<div class="kpi-card"><div class="kpi-label">Attack Vectors</div><div class="kpi-value kv-info">${pentestTotalVectors.toLocaleString()}</div></div>` : ''}
    ${pentestSuccessRate !== null ? `<div class="kpi-card"><div class="kpi-label">Exploit Rate</div><div class="kpi-value kv-critical">${pentestSuccessRate}%</div></div>` : ''}
  </div>

  <div class="risk-panel">
    <div class="risk-stat">
      <div class="risk-stat-label">Maximum CVSS</div>
      <div class="risk-stat-value">${maxCvss.toFixed(1)}</div>
      <div class="risk-stat-sub">Highest individual finding score</div>
    </div>
    <div class="risk-stat">
      <div class="risk-stat-label">OWASP Categories Affected</div>
      <div class="risk-stat-value">${owaspCount} of 10</div>
      <div class="risk-stat-sub">Categories with at least one finding</div>
    </div>
    <div class="risk-stat">
      <div class="risk-stat-label">Scan Duration</div>
      <div class="risk-stat-value">${durationStr}</div>
      <div class="risk-stat-sub">${formatTimestamp(m.startTime)} &rarr; ${formatTimestamp(m.endTime)}</div>
    </div>
  </div>

  <div class="section-hdr">Security posture &amp; distribution</div>
  <div class="exec-dashboard">
    <div class="gauge-block">
      <div class="gauge-lbl">Posture Score</div>
      ${svgGauge}
    </div>
    <div class="chart-card">
      <div class="chart-card-title">Findings by severity</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-severity-donut"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-card-title">Findings by testing layer</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-layer-bar"></canvas></div>
    </div>
  </div>

  <div class="section-hdr">OWASP Top 10 exposure heatmap</div>
  <div class="chart-card" style="margin-bottom:1.5rem">
    ${owaspHeatmapHtml}
    <p style="font-size:11px;color:var(--g400);margin-top:.75rem">Cell intensity scales with finding count. See the OWASP Top 10 tab for full category breakdown.</p>
  </div>

  <div class="section-hdr">Historical scan trend</div>
  <div class="chart-card" style="margin-bottom:1.5rem">
    <div class="chart-card-title">Finding counts over recent scans</div>
    <div class="chart-wrap" style="height:180px"><canvas id="chart-trend-line"></canvas></div>
  </div>

  <div class="chart-card">
    <div class="chart-card-title">CVSS score distribution</div>
    <div class="chart-wrap" style="height:180px"><canvas id="chart-cvss-scatter"></canvas></div>
  </div>
</section>

<!-- ══ TAB 2: OWASP TOP 10 ════════════════════════════════════════════════════ -->
<section id="tab-owasp" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-owasp">
  <div class="section-hdr">OWASP Top 10 (2021) exposure heatmap</div>
  <div class="chart-card" style="margin-bottom:1.5rem">${owaspHeatmapHtml}</div>
  <div class="section-hdr">Findings by OWASP category</div>
  <div class="chart-card">
    <div class="chart-card-title">Finding count per category</div>
    <div class="chart-wrap" style="height:280px"><canvas id="chart-findings-by-owasp"></canvas></div>
  </div>
</section>

<!-- ══ TAB 3: PENTEST RESULTS ════════════════════════════════════════════════ -->
<section id="tab-pentest" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-pentest">
  <div class="section-hdr">Automated pentest summary</div>
  <div class="kpi-grid" style="grid-template-columns:repeat(auto-fill,minmax(140px,1fr))">
    <div class="kpi-card"><div class="kpi-label">Modules Run</div><div class="kpi-value kv-total">${pentestModules.length}</div></div>
    ${totalPentestFindgs > 0 ? `<div class="kpi-card"><div class="kpi-label">PT Findings</div><div class="kpi-value kv-critical">${totalPentestFindgs}</div></div>` : ''}
    ${pentestDurationSec ? `<div class="kpi-card"><div class="kpi-label">Duration</div><div class="kpi-value kv-score">${pentestDurationSec}s</div></div>` : ''}
    ${pentestTotalVectors ? `<div class="kpi-card"><div class="kpi-label">Vectors Used</div><div class="kpi-value kv-info">${pentestTotalVectors.toLocaleString()}</div></div>` : ''}
  </div>
  <div class="section-hdr">Endpoint coverage by module</div>
  <div class="chart-card" style="margin-bottom:1.5rem">
    <div class="chart-card-title">Endpoints tested vs findings per module</div>
    <div class="chart-wrap" style="height:210px"><canvas id="chart-pentest-coverage"></canvas></div>
  </div>
  <div class="section-hdr">Module results</div>
  ${pentestModuleCards}
</section>

<!-- ══ TAB 4: PENTEST GUIDE ══════════════════════════════════════════════════ -->
<section id="tab-guide" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-guide">
  <div class="section-hdr">Manual penetration testing methodology</div>
  <div class="guide-grid">${pentestGuideHtml}</div>
</section>

<!-- ══ TAB 5: ALL FINDINGS ════════════════════════════════════════════════════ -->
<section id="tab-findings" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-findings">
  <div class="section-hdr">All findings &mdash; ${counts.total} total</div>
  <div class="filter-bar" role="group" aria-label="Filter findings by severity">
    <button class="filter-btn active" data-filter="all"       onclick="filterFindings(this,'all')">All (${counts.total})</button>
    ${counts.critical > 0 ? `<button class="filter-btn f-critical" data-filter="critical" onclick="filterFindings(this,'critical')">Critical (${counts.critical})</button>` : ''}
    ${counts.high     > 0 ? `<button class="filter-btn f-high"     data-filter="high"     onclick="filterFindings(this,'high')">High (${counts.high})</button>` : ''}
    ${counts.medium   > 0 ? `<button class="filter-btn f-medium"   data-filter="medium"   onclick="filterFindings(this,'medium')">Medium (${counts.medium})</button>` : ''}
    ${counts.low      > 0 ? `<button class="filter-btn f-low"      data-filter="low"      onclick="filterFindings(this,'low')">Low (${counts.low})</button>` : ''}
    <button class="filter-btn" data-filter="zap"     onclick="filterFindings(this,'zap')">ZAP only</button>
    <button class="filter-btn" data-filter="custom"  onclick="filterFindings(this,'custom')">Custom only</button>
    <button class="filter-btn" data-filter="pentest" onclick="filterFindings(this,'pentest')">Pentest only</button>
  </div>
  <div id="findings-list">
    ${findingCardsHtml || '<div class="no-data-msg">No findings recorded for this assessment.</div>'}
  </div>
</section>

<!-- ══ TAB 6: COMPLIANCE ══════════════════════════════════════════════════════ -->
<section id="tab-compliance" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-compliance">
  <div class="section-hdr">OWASP Top 10 (2021) compliance status</div>
  ${complianceHtml}
</section>

<!-- ══ TAB 7: SCAN DETAILS ════════════════════════════════════════════════════ -->
<section id="tab-meta" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-meta">
  <div class="section-hdr">Assessment &amp; environment details</div>
  <div class="meta-2col">
    <div class="meta-section">
      <div class="meta-section-title">ZAP Scan Details</div>
      ${metaRowHtml('ZAP version',    m.zapVersion)}
      ${metaRowHtml('Scan type',      m.scanType)}
      ${metaRowHtml('Target URL',     m.targetUrl)}
      ${metaRowHtml('Spider URLs',    m.spiderUrls)}
      ${metaRowHtml('Passive alerts', m.passiveAlerts)}
      ${m.activeAlerts != null ? metaRowHtml('Active alerts', m.activeAlerts + ' alerts') : ''}
      ${metaRowHtml('ZAP report',     m.zapReportPath)}
    </div>
    <div class="meta-section">
      <div class="meta-section-title">Run Details</div>
      ${metaRowHtml('Custom checks run',    m.customChecksRun)}
      ${metaRowHtml('Custom checks passed', m.customChecksPassed)}
      ${metaRowHtml('Start time',           formatTimestamp(m.startTime))}
      ${metaRowHtml('End time',             formatTimestamp(m.endTime))}
      ${metaRowHtml('Duration',             durationStr)}
      ${metaRowHtml('Standard',             'OWASP Top 10 (2021) / CVSS v3.1')}
      ${metaRowHtml('Jira story',           m.jiraStoryUrl)}
      ${metaRowHtml('Zephyr cycle',         m.zephyrCycleUrl)}
    </div>
    ${pentestModules.length ? `<div class="meta-section">
      <div class="meta-section-title">Pentest Details</div>
      ${metaRowHtml('Modules run',         pentestModules.length)}
      ${metaRowHtml('Total PT findings',   totalPentestFindgs)}
      ${pentestDurationSec ? metaRowHtml('Duration', pentestDurationSec + 's') : ''}
      ${metaRowHtml('Attack vectors used', pentestTotalVectors || null)}
      ${metaRowHtml('Successful exploits', m.pentestSuccessfulExploits || null)}
      ${pentestSuccessRate !== null ? metaRowHtml('Exploit success rate', pentestSuccessRate + '%') : ''}
    </div>` : ''}
  </div>
</section>

<!-- Footer -->
<footer class="report-footer">
  <div style="display:flex;gap:1rem;align-items:center;flex-wrap:wrap">
    ${m.jiraStoryUrl   ? `<a href="${escHtml(m.jiraStoryUrl)}"   target="_blank" rel="noopener noreferrer">Jira: ${escHtml(storyKey)}</a>` : ''}
    ${m.zephyrCycleUrl ? `<a href="${escHtml(m.zephyrCycleUrl)}" target="_blank" rel="noopener noreferrer">Zephyr cycle</a>` : ''}
    ${m.zapReportPath  ? `<a href="${escHtml(m.zapReportPath)}"  target="_blank" rel="noopener noreferrer">ZAP report</a>` : ''}
  </div>
  <span class="footer-conf">Confidential &mdash; Internal Use Only</span>
  <div>Generated ${formatTimestamp(new Date().toISOString())} &middot; Agentic QA Platform v2.0</div>
</footer>

<!-- Chart.js (inline) -->
<script>${chartJsSrc}</script>

<!-- Report runtime -->
<script>
(function(){
'use strict';
var F     = ${FINDINGS_JSON};
var CNT   = ${COUNTS_JSON};
var LAY   = ${LAYERS_JSON};
var HIST  = ${HISTORICAL_JSON};
var PTCOV = ${PENTEST_COVERAGE_JSON};

var SC   = { critical:'#b91c1c', high:'#c2410c', medium:'#d97706', low:'#1e40af', informational:'#5b21b6', info:'#5b21b6' };
var GRID = 'rgba(100,116,139,0.08)';
var TF   = { family:"'Inter',sans-serif", size:10, color:'#94a3b8' };
var BASE = { responsive:true, maintainAspectRatio:false, plugins:{ legend:{ display:false } } };
function mx(a,b){ return Object.assign({},a,b); }

window.showTab = function(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(b){ b.classList.remove('active'); b.setAttribute('aria-selected','false'); });
  var panel = document.getElementById('tab-'+id);
  if (panel) panel.classList.add('active');
  if (btn)  { btn.classList.add('active'); btn.setAttribute('aria-selected','true'); }
};

window.filterFindings = function(btn, filter) {
  document.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.finding-card').forEach(function(card) {
    var sev   = card.querySelector('.sev-badge-dark');
    var layer = card.querySelector('.layer-badge');
    var st    = sev   ? sev.textContent.trim().toLowerCase()   : '';
    var lt    = layer ? layer.textContent.trim().toLowerCase() : '';
    card.style.display = (filter === 'all' || filter === st || filter === lt) ? '' : 'none';
  });
};

/* Severity donut */
(function(){
  var el = document.getElementById('chart-severity-donut'); if(!el) return;
  var sevs = ['critical','high','medium','low','informational'];
  var data = sevs.map(function(s){ return CNT[s]||0; });
  if(data.every(function(d){ return d===0; })) return;
  new Chart(el, {
    type:'doughnut',
    data:{ labels:['Critical','High','Medium','Low','Info'],
      datasets:[{ data:data, backgroundColor:sevs.map(function(s){ return SC[s]; }), borderWidth:2, borderColor:'#ffffff', hoverOffset:4 }] },
    options:mx(BASE,{ cutout:'66%',
      plugins:{ legend:{ display:true, position:'right',
        labels:{ color:'#475569', font:{ family:"'Inter',sans-serif", size:11 },
          filter:function(item){ return data[item.index]>0; }, padding:10 }}} })
  });
})();

/* Layer bar */
(function(){
  var el = document.getElementById('chart-layer-bar'); if(!el) return;
  var sevs   = ['critical','high','medium','low','informational'];
  var labels = ['Critical','High','Medium','Low','Info'];
  var layerDefs = [
    { key:'zap',     label:'ZAP',     color:'#5b21b6' },
    { key:'custom',  label:'Custom',  color:'#c2410c' },
    { key:'pentest', label:'Pentest', color:'#be185d' },
  ];
  var datasets = layerDefs.map(function(l){
    return { label:l.label, data:sevs.map(function(s){ return(LAY[l.key]&&LAY[l.key][s])||0; }),
      backgroundColor:l.color, borderRadius:3, borderSkipped:false };
  });
  new Chart(el, {
    type:'bar', data:{ labels:labels, datasets:datasets },
    options:mx(BASE,{ plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#475569', font:{ family:"'Inter',sans-serif", size:10 }, padding:10 }}},
      scales:{ x:{ stacked:true, grid:{ display:false }, ticks:{ font:TF }},
               y:{ stacked:true, grid:{ color:GRID }, ticks:{ font:TF, stepSize:1 }, beginAtZero:true }}})
  });
})();

/* Trend line */
(function(){
  var el = document.getElementById('chart-trend-line'); if(!el) return;
  if(!HIST||!HIST.length){ el.parentElement.innerHTML='<div class="no-data-msg">No historical scan data available.</div>'; return; }
  var sevs = ['critical','high','medium','low'];
  var datasets = sevs.map(function(s){
    return { label:s.charAt(0).toUpperCase()+s.slice(1),
      data:HIST.map(function(h){ return h[s]||0; }),
      borderColor:SC[s], backgroundColor:SC[s]+'18', tension:0.35,
      pointRadius:3, pointHoverRadius:5, borderWidth:2, fill:false };
  });
  new Chart(el, {
    type:'line', data:{ labels:HIST.map(function(h){ return h.date||''; }), datasets:datasets },
    options:mx(BASE,{ plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#475569', font:{ family:"'Inter',sans-serif", size:10 }, padding:10 }}},
      scales:{ x:{ grid:{ color:GRID }, ticks:{ font:TF }},
               y:{ grid:{ color:GRID }, ticks:{ font:TF, stepSize:1 }, beginAtZero:true }}})
  });
})();

/* CVSS scatter */
(function(){
  var el = document.getElementById('chart-cvss-scatter'); if(!el) return;
  var sevs = ['critical','high','medium','low','informational'];
  var datasets = sevs.map(function(s){
    var pts = F.filter(function(f){ return (f.severity||'informational')===s&&f.cvss>0; });
    return { label:s.charAt(0).toUpperCase()+s.slice(1),
      data:pts.map(function(f,i){ return{ x:f.cvss, y:i+Math.random()*0.3-0.15 }; }),
      backgroundColor:SC[s]+'cc', pointRadius:7, pointHoverRadius:9 };
  }).filter(function(ds){ return ds.data.length>0; });
  if(!datasets.length){ el.parentElement.innerHTML='<div class="no-data-msg">No CVSS data available.</div>'; return; }
  new Chart(el, {
    type:'scatter', data:{ datasets:datasets },
    options:mx(BASE,{ plugins:{ legend:{ display:true, position:'right',
        labels:{ color:'#475569', font:{ family:"'Inter',sans-serif", size:10 }, padding:10 }}},
      scales:{ x:{ min:0, max:10, grid:{ color:GRID }, ticks:{ font:TF },
          title:{ display:true, text:'CVSS Score', color:'#94a3b8', font:{ size:10 }}},
               y:{ display:false }}})
  });
})();

/* OWASP bar */
(function(){
  var el = document.getElementById('chart-findings-by-owasp'); if(!el) return;
  var cats = [
    {id:'A01:2021',label:'A01 — Broken Access Control',      color:'#dc2626'},
    {id:'A02:2021',label:'A02 — Cryptographic Failures',     color:'#ea580c'},
    {id:'A03:2021',label:'A03 — Injection',                  color:'#d97706'},
    {id:'A04:2021',label:'A04 — Insecure Design',            color:'#65a30d'},
    {id:'A05:2021',label:'A05 — Security Misconfiguration',  color:'#0284c7'},
    {id:'A06:2021',label:'A06 — Outdated Components',        color:'#7c3aed'},
    {id:'A07:2021',label:'A07 — Auth Failures',              color:'#db2777'},
    {id:'A08:2021',label:'A08 — Integrity Failures',         color:'#0891b2'},
    {id:'A09:2021',label:'A09 — Logging Failures',           color:'#b45309'},
    {id:'A10:2021',label:'A10 — SSRF',                       color:'#475569'},
  ];
  var counts = cats.map(function(c){
    return F.filter(function(f){ return (f.owaspId||'').indexOf(c.id.split(':')[0])!==-1; }).length;
  });
  new Chart(el, {
    type:'bar',
    data:{ labels:cats.map(function(c){ return c.label; }),
      datasets:[{ data:counts, backgroundColor:cats.map(function(c){ return c.color+'bb'; }),
        borderColor:cats.map(function(c){ return c.color; }), borderWidth:1, borderRadius:4 }] },
    options:mx(BASE,{ indexAxis:'y',
      scales:{ x:{ grid:{ color:GRID }, ticks:{ font:TF, stepSize:1 }, beginAtZero:true },
               y:{ grid:{ display:false }, ticks:{ font:{ family:"'Inter',sans-serif", size:10, color:'#475569' }}}}})
  });
})();

/* Pentest coverage */
(function(){
  var el = document.getElementById('chart-pentest-coverage'); if(!el) return;
  if(!PTCOV||!PTCOV.some(function(p){ return p.endpoints>0; })){
    el.parentElement.innerHTML='<div class="no-data-msg">No pentest coverage data available.</div>'; return;
  }
  new Chart(el, {
    type:'bar',
    data:{ labels:PTCOV.map(function(p){ return p.label; }),
      datasets:[
        { label:'Endpoints tested', data:PTCOV.map(function(p){ return p.endpoints; }), backgroundColor:'#5b21b6bb', borderRadius:3 },
        { label:'Findings',         data:PTCOV.map(function(p){ return p.findings; }),  backgroundColor:'#b91c1cbb', borderRadius:3 }
      ]},
    options:mx(BASE,{ indexAxis:'y',
      plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#475569', font:{ family:"'Inter',sans-serif", size:10 }, padding:10 }}},
      scales:{ x:{ grid:{ color:GRID }, ticks:{ font:TF }, beginAtZero:true },
               y:{ grid:{ display:false }, ticks:{ font:{ family:"'Inter',sans-serif", size:10, color:'#475569' }}}}})
  });
})();

})();
</script>
</body>
</html>`;
}

// ─── Main Entry Point ─────────────────────────────────────────────────────────
function generateSecReport(findings, verdict, storyKey, outputDir, meta) {
  findings  = Array.isArray(findings) ? findings : [];
  verdict   = verdict   || 'fail';
  storyKey  = storyKey  || 'SEC-REPORT';
  outputDir = outputDir || 'custom-report/security';
  meta      = meta      || {};

  const score       = calculateSecurityScore(findings);
  const chartJsPath = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  let   chartJsSrc  = '';
  if (fs.existsSync(chartJsPath)) {
    chartJsSrc = fs.readFileSync(chartJsPath, 'utf8');
  } else {
    logger.warn('[generate-sec-report] Chart.js not found \u2014 run: npm install chart.js');
    chartJsSrc = '/* Chart.js not found */';
  }

  const html       = buildHtml({ findings, verdict, storyKey, meta, chartJsSrc, score });
  const absOutDir  = path.isAbsolute(outputDir) ? outputDir : path.join(ROOT, outputDir);
  fs.mkdirSync(absOutDir, { recursive: true });
  const outFile    = path.join(absOutDir, 'index.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  logger.info(`[generate-sec-report] Report written \u2192 ${outFile} (${kb} KB, ${findings.length} findings, score ${score})`);
  return outFile;
}

// ─── CLI standalone ───────────────────────────────────────────────────────────
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
      logger.warn('[generate-sec-report] Could not parse sample-findings.json \u2014 using built-in data');
    }
  }

  if (!findings) {
    storyKey  = 'SCRUM-6';
    verdict   = 'fail';
    outputDir = 'custom-report/security';
    meta = {
      zapVersion:'2.14.0', scanType:'full-active',
      targetUrl:'https://opensource-demo.orangehrmlive.com',
      startTime:'2026-04-20T15:10:04Z', endTime:'2026-04-20T15:38:22Z',
      durationSeconds:1698, spiderUrls:148, passiveAlerts:11, activeAlerts:6,
      customChecksRun:10, customChecksPassed:3,
      jiraStoryUrl:'https://yourorg.atlassian.net/browse/SCRUM-6',
      zephyrCycleUrl:'https://yourorg.atlassian.net/jira/software/projects/SCRUM/boards',
      zapReportPath:'test-results/security/SCRUM-6-zap-report.json',
      pentestTotalAttackVectors:3847, pentestSuccessfulExploits:89, pentestDurationMs:2538000,
      historicalScans:[
        { date:'2026-01-15', critical:4, high:8, medium:12, low:18, info:5 },
        { date:'2026-02-10', critical:3, high:7, medium:10, low:15, info:4 },
        { date:'2026-03-05', critical:3, high:6, medium:9,  low:14, info:6 },
        { date:'2026-04-01', critical:2, high:5, medium:8,  low:12, info:3 },
        { date:'2026-04-20', critical:2, high:5, medium:7,  low:10, info:3 },
      ],
      pentestModules:[
        { name:'apiFuzzing',     status:'success', endpointsTested:47,
          findings:[{ id:'PT-001', name:'SQL Injection in /api/v2/employee/search', severity:'critical', cvss:9.8 }],
          attackVectorsApplied:['SQL Injection','NoSQL Injection','XPath Injection','OS Command Injection'], durationMs:402000 },
        { name:'authBypass',     status:'success', endpointsTested:12, findings:[],
          attackVectorsApplied:['JWT alg:none','Token forging','Forced browse'], durationMs:198000 },
        { name:'idorDetection',  status:'partial',  endpointsTested:23, findings:[],
          attackVectorsApplied:['Integer ID enumeration','UUID prediction'], durationMs:310000 },
        { name:'rateLimiting',   status:'success', endpointsTested:8,  findings:[],
          attackVectorsApplied:['Burst requests','IP rotation'], durationMs:187000 },
        { name:'sessionMgmt',    status:'success', endpointsTested:15, findings:[],
          attackVectorsApplied:['Session fixation','Cookie theft','Token reuse'], durationMs:290000 },
        { name:'cryptoWeakness', status:'success', endpointsTested:6,  findings:[],
          attackVectorsApplied:['Weak cipher detection','MD5/SHA1 check'], durationMs:89000 },
        { name:'fileUpload',     status:'not-run', endpointsTested:0,  findings:[], attackVectorsApplied:[], durationMs:0 },
      ],
    };
    findings = [
      { id:'SEC-001', source:'custom', name:'IDOR \u2014 Employee ID Enumerable', severity:'critical', cvss:9.8,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', cwe:'CWE-639',
        cweName:'Authorization Bypass Through User-Controlled Key',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'The employee API accepts sequential integer IDs with no ownership validation, allowing any authenticated user to read any employee record including salary and PII.',
        evidence:'GET /web/index.php/api/v2/employee/2\nAuthorization: Bearer <attacker-token>\n\nHTTP/1.1 200 OK\n{"firstName":"Jane","salary":75000,"ssn":"123-45-6789"}',
        url:'/web/index.php/api/v2/employee/{id}',
        steps:[
          'Verify the requesting user owns the employee record or holds HR_ADMIN role before returning data.',
          'Replace sequential integer IDs with UUID v4 in the public-facing API.',
          'Add an integration test asserting HTTP 403 when Employee A requests Employee B record.',
          'Enable audit logging for all 403 responses; alert on > 5 consecutive 403s from one session.',
        ],
        references:[{label:'OWASP A01:2021',url:'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'},{label:'CWE-639',url:'https://cwe.mitre.org/data/definitions/639.html'}],
        jiraBug:'SCRUM-201', status:'new' },
      { id:'SEC-002', source:'custom', name:'CSRF Token Absent on State-Changing Forms', severity:'high', cvss:8.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N', cwe:'CWE-352', cweName:'Cross-Site Request Forgery',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'State-changing forms do not include a CSRF synchroniser token, enabling cross-site request forgery attacks from any malicious site.',
        evidence:'GET /web/index.php/pim/addEmployee -> 200\nNo CSRF token found in form hidden fields or custom headers.',
        url:'/web/index.php/pim/addEmployee',
        steps:[
          'Generate a cryptographically random CSRF token per session (minimum 128 bits entropy).',
          'Embed the token in every HTML form and in AJAX request headers.',
          'Validate the token server-side on all POST/PUT/DELETE requests; return HTTP 403 on mismatch.',
        ],
        references:[{label:'CSRF Prevention Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html'}],
        jiraBug:'SCRUM-202', status:'recurring' },
      { id:'SEC-003', source:'custom', name:'No Brute-Force Lockout on Login Endpoint', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-307',
        cweName:'Improper Restriction of Excessive Authentication Attempts',
        owaspId:'A07:2021', owaspName:'Identification and Authentication Failures',
        description:'The login endpoint accepts unlimited credential-guessing attempts with no lockout or rate limiting.',
        evidence:'POST /auth/validateCredentials {wrong_password} x5 -> all 5: HTTP 200 {success:false}\nNo HTTP 429 / No Retry-After header observed.',
        url:'/web/index.php/auth/validateCredentials',
        steps:[
          'Lock account after 5 failed attempts; return HTTP 429 with Retry-After header.',
          'Add IP-level rate limiting: maximum 10 login requests per minute per IP.',
          'Alert when > 20 failures per minute from one IP.',
        ],
        references:[{label:'OWASP A07:2021',url:'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/'},{label:'CWE-307',url:'https://cwe.mitre.org/data/definitions/307.html'}],
        jiraBug:'SCRUM-203', status:'new' },
      { id:'SEC-004', source:'custom', name:'Sensitive Data Exposed in API Response', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-200',
        cweName:'Exposure of Sensitive Information to an Unauthorized Actor',
        owaspId:'A02:2021', owaspName:'Cryptographic Failures',
        description:'The employee search API returns salary, SSN, and internal session tokens to any authenticated user regardless of access level.',
        evidence:'GET /api/v2/employee/search?name=Admin\nHTTP 200: {"salary":85000,"internalToken":"abc123","ssn":"555-12-3456"}',
        url:'/web/index.php/api/v2/employee/search',
        steps:[
          'Define an explicit API response schema; strip all unlisted fields before serialisation.',
          'Apply RBAC: only HR_ADMIN role may request salary data via a separate audited endpoint.',
        ],
        references:[{label:'OWASP A02:2021',url:'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/'}],
        jiraBug:'SCRUM-204', status:'new' },
      { id:'SEC-005', source:'zap', name:'Missing Content-Security-Policy Header', severity:'medium', cvss:6.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'No Content-Security-Policy header is present, increasing exposure to XSS, data injection, and clickjacking attacks.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no Content-Security-Policy header)',
        url:'All application pages',
        steps:['Add nginx: add_header Content-Security-Policy "default-src \'self\'" always','Deploy in report-only mode first to capture violations before enforcing.'],
        references:[{label:'CSP Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html'}],
        jiraBug:null, status:'new' },
      { id:'SEC-006', source:'zap', name:'X-Frame-Options Header Missing', severity:'medium', cvss:5.4,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:N/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'The application does not set X-Frame-Options, making it susceptible to clickjacking attacks.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no X-Frame-Options header)',
        url:'All application pages',
        steps:['Add nginx: add_header X-Frame-Options SAMEORIGIN always;'],
        references:[{label:'OWASP A05:2021',url:'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/'}],
        jiraBug:null, status:'new' },
      { id:'SEC-007', source:'zap', name:'Session Cookies Missing Secure/HttpOnly Flags', severity:'low', cvss:4.3,
        cvssVector:'AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N', cwe:'CWE-614',
        cweName:'Sensitive Cookie in HTTPS Session Without Secure Attribute',
        owaspId:'A07:2021', owaspName:'Identification and Authentication Failures',
        description:'Session cookies do not have Secure and HttpOnly flags, exposing them to theft via JavaScript or plain-HTTP interception.',
        evidence:'Set-Cookie: PHPSESSID=abc123; Path=/ (missing Secure; HttpOnly; SameSite)',
        url:'/web/index.php/auth/validate',
        steps:['Update PHP: session.cookie_secure=1, session.cookie_httponly=1','Add SameSite=Strict to prevent CSRF exploitation.'],
        references:[{label:'CWE-614',url:'https://cwe.mitre.org/data/definitions/614.html'}],
        jiraBug:null, status:'new' },
      { id:'PT-001', source:'pentest', name:'SQL Injection in /api/v2/employee/search', severity:'critical', cvss:9.8,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe:'CWE-89', cweName:'SQL Injection',
        owaspId:'A03:2021', owaspName:'Injection', pentestModule:'apiFuzzing',
        description:'Raw string concatenation in the query builder allows full database extraction. No parameterised queries used.',
        evidence:"GET /api/v2/employee/search?name=' OR 1=1--\nHTTP/1.1 200 OK\n[all 487 employee records returned including salary and PII]",
        url:'/api/v2/employee/search',
        steps:[
          'Replace raw string concatenation with PreparedStatement or ORM query builder.',
          'Add a WAF rule blocking SQL metacharacters as a defence-in-depth measure.',
          'Add regression test: send \' OR 1=1-- as name parameter and assert HTTP 400 or empty result.',
        ],
        attackVector:{ technique:'SQL Injection', payload:"' OR 1=1--" },
        remediation:{ priority:'P0',
          shortTermFix:'Add input sanitisation and validation on the name query parameter.',
          permanentFix:'Migrate all database queries to ORM parameterised queries.',
          codeExample:{
            vulnerable:"db.query(\"SELECT * FROM employee WHERE name='\" + name + \"'\")",
            secure:"db.prepare('SELECT * FROM employee WHERE name = ?').execute(name)" }},
        references:[{label:'OWASP A03:2021',url:'https://owasp.org/Top10/A03_2021-Injection/'},{label:'CWE-89',url:'https://cwe.mitre.org/data/definitions/89.html'}],
        jiraBug:'SCRUM-210', status:'new' },
    ];
  }

  generateSecReport(findings, verdict, storyKey, outputDir, meta);
}

module.exports = { generateSecReport };
