'use strict';
// â”€â”€â”€ Security & Penetration Testing Report Generator â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// Produces a self-contained dark-theme HTML file with Chart.js bundled inline.
// Function signature preserved for backward-compatibility:
//   generateSecReport(findings, verdict, storyKey, outputDir, meta)

const fs   = require('fs');
const path = require('path');

try { require('dotenv').config(); } catch (_) {}

const ROOT = path.resolve(__dirname, '..');
let logger;
try { logger = require('../src/utils/logger'); } catch (_) {
  logger = { info: console.log, warn: console.warn, error: console.error };
}

// â”€â”€â”€ OWASP Top 10 2021 â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
const OWASP_TOP10 = [
  { id:'A01:2021', name:'Broken Access Control',                color:'#ff6b6b' },
  { id:'A02:2021', name:'Cryptographic Failures',               color:'#ffa726' },
  { id:'A03:2021', name:'Injection',                            color:'#ffeb3b' },
  { id:'A04:2021', name:'Insecure Design',                      color:'#66bb6a' },
  { id:'A05:2021', name:'Security Misconfiguration',            color:'#42a5f5' },
  { id:'A06:2021', name:'Vulnerable & Outdated Components',     color:'#ab47bc' },
  { id:'A07:2021', name:'Identification & Auth Failures',       color:'#ec407a' },
  { id:'A08:2021', name:'Software & Data Integrity Failures',   color:'#26c6da' },
  { id:'A09:2021', name:'Security Logging & Monitoring Failures',color:'#ffa726'},
  { id:'A10:2021', name:'Server-Side Request Forgery',          color:'#78909c' },
];

const SEV_ORDER = { critical:5, high:4, medium:3, low:2, informational:1, info:1 };
const SEV_WEIGHTS = { critical:10, high:5, medium:2, low:0.5, informational:0, info:0 };

const PENTEST_MODULES = [
  { key:'apiFuzzing',      label:'API Fuzzing',         emoji:'ðŸŽ¯' },
  { key:'authBypass',      label:'Auth Bypass',         emoji:'ðŸ”' },
  { key:'idorDetection',   label:'IDOR Detection',      emoji:'ðŸ”‘' },
  { key:'rateLimiting',    label:'Rate Limiting',        emoji:'â±ï¸' },
  { key:'sessionMgmt',     label:'Session Management',  emoji:'ðŸª' },
  { key:'cryptoWeakness',  label:'Crypto Weakness',     emoji:'ðŸ”’' },
  { key:'fileUpload',      label:'File Upload Security',emoji:'ðŸ“Ž' },
];

// â”€â”€â”€ Helpers â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function escHtml(s) {
  if (s == null) return '';
  return String(s)
    .replace(/&/g,'&amp;')
    .replace(/</g,'&lt;')
    .replace(/>/g,'&gt;')
    .replace(/"/g,'&quot;')
    .replace(/'/g,'&#39;');
}

function formatTimestamp(iso) {
  if (!iso) return 'â€”';
  try {
    return new Date(iso).toLocaleString('en-GB', {
      day:'2-digit', month:'short', year:'numeric',
      hour:'2-digit', minute:'2-digit', second:'2-digit',
    });
  } catch(_) { return String(iso); }
}

function formatDuration(secs) {
  if (!secs && secs !== 0) return 'â€”';
  const m = Math.floor(secs / 60);
  const s = Math.round(secs % 60);
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
  if (!score) return 'informational';
  if (score >= 9) return 'critical';
  if (score >= 7) return 'high';
  if (score >= 4) return 'medium';
  if (score > 0)  return 'low';
  return 'informational';
}

function calculateSecurityScore(findings) {
  const deductions = findings.reduce((sum, f) => sum + (SEV_WEIGHTS[(f.severity||'informational').toLowerCase()] || 0), 0);
  return Math.max(0, Math.min(100, Math.round(100 - deductions)));
}

function slugify(s) {
  return String(s || '').replace(/[^a-z0-9]/gi, '-').toLowerCase();
}

// â”€â”€â”€ SVG Gauge â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildSvgGauge(score) {
  const r = 54, cx = 64, cy = 64;
  const circ = 2 * Math.PI * r;
  const filled = (score / 100) * circ;
  const color = score >= 80 ? '#00ff88' : score >= 60 ? '#ffcc00' : score >= 40 ? '#ff9933' : '#ff3366';
  return `<svg viewBox="0 0 128 128" width="128" height="128" aria-label="Security posture score ${score}">
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="rgba(255,255,255,0.08)" stroke-width="10"/>
    <circle cx="${cx}" cy="${cy}" r="${r}" fill="none" stroke="${color}" stroke-width="10"
      stroke-dasharray="${filled} ${circ - filled}"
      stroke-dashoffset="${circ * 0.25}"
      stroke-linecap="round" transform="rotate(-90,${cx},${cy})"/>
    <text x="${cx}" y="${cy - 6}" text-anchor="middle" fill="${color}" font-family="Orbitron,sans-serif" font-size="22" font-weight="700">${score}</text>
    <text x="${cx}" y="${cy + 14}" text-anchor="middle" fill="rgba(168,180,209,0.8)" font-family="Inter,sans-serif" font-size="9">POSTURE SCORE</text>
  </svg>`;
}

// â”€â”€â”€ OWASP Heatmap â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildOwaspHeatmap(findings) {
  const counts = {};
  for (const f of findings) {
    const id = (f.owaspId || '').split(':')[0] + ':2021';
    counts[id] = (counts[id] || 0) + 1;
  }
  const cells = OWASP_TOP10.map(owasp => {
    const cnt = counts[owasp.id] || 0;
    const opacity = cnt === 0 ? 0.06 : Math.min(0.9, 0.2 + cnt * 0.12);
    const shortId = owasp.id.replace(':2021','');
    return `<div class="owasp-cell" style="background:${owasp.color};opacity:${opacity}" title="${escHtml(owasp.id)}: ${escHtml(owasp.name)} (${cnt} finding${cnt===1?'':'s'})">
      <div class="owasp-cell-id">${escHtml(shortId)}</div>
      <div class="owasp-cell-count">${cnt}</div>
    </div>`;
  });
  return `<div class="owasp-heatmap">${cells.join('')}</div>`;
}

// â”€â”€â”€ Pentest Module Cards â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildPentestModuleCards(pentestModules) {
  if (!pentestModules || !pentestModules.length) {
    return `<div class="no-data-msg">No automated pentest data available for this scan.</div>`;
  }
  const moduleMap = {};
  for (const m of pentestModules) moduleMap[m.name || m.key] = m;

  return PENTEST_MODULES.map(def => {
    const mod = moduleMap[def.key] || {};
    const status = mod.status || 'not-run';
    const findings = mod.findings || [];
    const endpoints = mod.endpointsTested || 0;
    const duration = mod.durationMs ? (mod.durationMs / 1000).toFixed(1) + 's' : 'â€”';
    const attackVectors = (mod.attackVectorsApplied || []).length;
    const statusClass = status === 'success' ? 'pt-status-success' : status === 'partial' ? 'pt-status-partial' : status === 'failed' ? 'pt-status-failed' : 'pt-status-notrun';
    const statusLabel = status === 'success' ? 'COMPLETED' : status === 'partial' ? 'PARTIAL' : status === 'failed' ? 'FAILED' : 'NOT RUN';

    const findingsHtml = findings.map(f => {
      const sev = (f.severity || 'info').toLowerCase();
      return `<div class="pt-finding-row">
        <span class="sev-dot sev-dot-${sev}"></span>
        <span class="pt-finding-name">${escHtml(f.name || f.id)}</span>
        <span class="pt-finding-cvss">${(f.cvss || 0).toFixed(1)}</span>
      </div>`;
    }).join('');

    return `<details class="pt-card">
      <summary>
        <span class="pt-emoji">${def.emoji}</span>
        <span class="pt-card-label">${escHtml(def.label)}</span>
        <span class="pt-badge ${statusClass}">${statusLabel}</span>
        <span class="pt-stats">${endpoints} endpoints &middot; ${attackVectors} vectors &middot; ${duration}</span>
        <span class="pt-finding-count ${findings.length > 0 ? 'has-findings' : ''}">${findings.length} finding${findings.length===1?'':'s'}</span>
        <span class="pt-chevron">&#9660;</span>
      </summary>
      <div class="pt-card-body">
        ${findings.length > 0 ? `<div class="pt-findings-list">${findingsHtml}</div>` : '<div class="no-data-msg">No findings for this module.</div>'}
        ${mod.attackVectorsApplied && mod.attackVectorsApplied.length ? `<div class="pt-vectors"><span class="field-label-dark">Attack vectors:</span> ${mod.attackVectorsApplied.map(v => `<code class="code-tag">${escHtml(v)}</code>`).join(' ')}</div>` : ''}
      </div>
    </details>`;
  }).join('');
}

// â”€â”€â”€ Finding Card â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildFindingCard(f, idx) {
  const sev = (f.severity || 'informational').toLowerCase();
  const src = (f.source || 'zap').toLowerCase();
  const layerLabel = src === 'pentest' ? 'PENTEST' : src === 'custom' ? 'CUSTOM' : 'ZAP';
  const layerClass = src === 'pentest' ? 'pentest' : src === 'custom' ? 'custom' : 'zap';

  const stepsHtml = (f.steps || []).map((step, i) =>
    `<div class="step-row"><div class="step-num">${i+1}</div><span>${escHtml(step)}</span></div>`
  ).join('');

  const refsHtml = (f.references || []).map(r =>
    `<a href="${escHtml(r.url)}" target="_blank" rel="noopener noreferrer" class="ref-link">${escHtml(r.label)}</a>`
  ).join(' ');

  let attackHtml = '';
  if (f.attackVector && (f.attackVector.technique || f.attackVector.payload)) {
    attackHtml = `<div class="attack-block">
      <div class="field-label-dark">Attack vector</div>
      ${f.attackVector.technique ? `<div class="meta-row-dark"><span class="meta-label-dark">Technique</span><code class="code-tag">${escHtml(f.attackVector.technique)}</code></div>` : ''}
      ${f.attackVector.payload ? `<div class="meta-row-dark"><span class="meta-label-dark">Payload</span><code class="code-tag">${escHtml(f.attackVector.payload)}</code></div>` : ''}
    </div>`;
  }

  let remHtml = '';
  if (f.remediation && (f.remediation.shortTermFix || f.remediation.permanentFix)) {
    const codeEx = f.remediation.codeExample;
    remHtml = `<div class="remediation-block">
      <div class="field-label-dark">Remediation</div>
      ${f.remediation.priority ? `<span class="priority-badge priority-${(f.remediation.priority||'').toLowerCase()}">${escHtml(f.remediation.priority)}</span>` : ''}
      ${f.remediation.shortTermFix ? `<div class="meta-row-dark"><span class="meta-label-dark">Short-term</span><span>${escHtml(f.remediation.shortTermFix)}</span></div>` : ''}
      ${f.remediation.permanentFix ? `<div class="meta-row-dark"><span class="meta-label-dark">Long-term</span><span>${escHtml(f.remediation.permanentFix)}</span></div>` : ''}
      ${codeEx && codeEx.vulnerable ? `<div class="code-compare">
        <div><div class="code-label bad">Vulnerable</div><pre class="code-block bad">${escHtml(codeEx.vulnerable)}</pre></div>
        <div><div class="code-label good">Secure</div><pre class="code-block good">${escHtml(codeEx.secure||'')}</pre></div>
      </div>` : ''}
    </div>`;
  }

  const statusBadge = f.status ? `<span class="status-badge status-${slugify(f.status)}">${escHtml(f.status)}</span>` : '';
  const jiraBug = f.jiraBug ? `<a href="#" class="jira-link" title="Jira bug">${escHtml(f.jiraBug)}</a>` : 'â€”';

  const alertHtml = sev === 'critical'
    ? `<div class="alert-critical-banner">âš  Critical â€” Immediate action required before next deployment. Raise a Jira bug now.</div>`
    : sev === 'high'
    ? `<div class="alert-high-banner">â¬† High severity â€” Schedule fix within current sprint.</div>`
    : '';

  return `<details class="finding-card" id="fc-${idx}">
    <summary>
      <span class="sev-badge-dark sev-${sev}">${sev.charAt(0).toUpperCase()+sev.slice(1)}</span>
      <span class="cvss-num">${(f.cvss||0).toFixed(1)}</span>
      <span class="finding-name-text">${escHtml(f.name)}</span>
      <span style="margin-left:auto;display:flex;align-items:center;gap:6px;flex-shrink:0">
        <span class="layer-badge ${layerClass}">${layerLabel}</span>
        <span class="owasp-id-tag">${escHtml(f.owaspId||'')}</span>
        ${statusBadge}
        <span class="chevron-icon">&#9660;</span>
      </span>
    </summary>
    <div class="finding-body-dark">
      ${alertHtml}
      <div class="finding-grid">
        <div class="finding-col">
          <div class="field-label-dark">Description</div>
          <p class="field-text-dark">${escHtml(f.description)}</p>
          <div class="field-label-dark" style="margin-top:0.75rem">Evidence</div>
          <pre class="evidence-dark">${escHtml(f.evidence)}</pre>
          <div class="field-label-dark" style="margin-top:0.75rem">Affected URL</div>
          <code class="code-tag">${escHtml(f.url)}</code>
        </div>
        <div class="finding-col">
          <div class="meta-block-dark">
            <div class="meta-row-dark"><span class="meta-label-dark">OWASP 2021</span><span>${escHtml(f.owaspId)} â€” ${escHtml(f.owaspName)}</span></div>
            <div class="meta-row-dark"><span class="meta-label-dark">CVSS v3.1</span><span>${(f.cvss||0).toFixed(1)} <code class="code-tag" style="font-size:10px">${escHtml(f.cvssVector)}</code></span></div>
            <div class="meta-row-dark"><span class="meta-label-dark">CWE</span><span>${escHtml(f.cwe)} â€” ${escHtml(f.cweName)}</span></div>
            <div class="meta-row-dark"><span class="meta-label-dark">Jira bug</span><span>${jiraBug}</span></div>
            ${f.pentestModule ? `<div class="meta-row-dark"><span class="meta-label-dark">Pentest module</span><span>${escHtml(f.pentestModule)}</span></div>` : ''}
          </div>
          ${attackHtml}
        </div>
      </div>
      ${stepsHtml ? `<div class="field-label-dark" style="margin-top:0.75rem">Remediation steps</div><div class="steps-list">${stepsHtml}</div>` : ''}
      ${remHtml}
      ${refsHtml ? `<div style="margin-top:0.6rem;font-size:11px;color:var(--text-muted)">References: ${refsHtml}</div>` : ''}
    </div>
  </details>`;
}

// â”€â”€â”€ Human Pentest Guide â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildPentestGuide() {
  const guide = [
    { title:'1. Reconnaissance', icon:'ðŸ”', steps:[
      'Map all API endpoints using ZAP spider or Burp Suite crawl.',
      'Identify authentication mechanisms (JWT, session cookies, OAuth).',
      'Enumerate user roles and privilege levels from API docs or JS.',
      'Check robots.txt, sitemap.xml, .well-known, and error pages for info leakage.',
    ]},
    { title:'2. Authentication Testing', icon:'ðŸ”', steps:[
      'Test brute-force resistance: attempt > 10 failed logins and verify 429 / lockout.',
      'Test password reset flows for token predictability and expiry.',
      'Verify JWT signature (alg:none attack), expiry enforcement, and secret strength.',
      'Test multi-factor authentication bypass scenarios.',
    ]},
    { title:'3. Authorization & IDOR', icon:'ðŸ”‘', steps:[
      'Replace your user ID in every API request with another known user ID.',
      'Test horizontal privilege escalation across all resource types.',
      'Attempt vertical privilege escalation: call admin endpoints as standard user.',
      'Test parameter manipulation: ?admin=true, ?role=admin, etc.',
    ]},
    { title:'4. Injection Testing', icon:'ðŸ’‰', steps:[
      'Test SQL injection in all query parameters, headers, and JSON body fields.',
      'Test XSS (stored, reflected, DOM) in all input fields and URL parameters.',
      'Test command injection in file upload names, paths, and form fields.',
      'Test SSTI (Server-Side Template Injection) in template-rendered fields.',
    ]},
    { title:'5. Session Management', icon:'ðŸª', steps:[
      'Capture session tokens and analyse for predictability / entropy.',
      'Test session fixation: set a pre-auth session token and verify replacement after login.',
      'Verify secure/HttpOnly/SameSite flags on all session cookies.',
      'Test session invalidation: verify tokens are rejected after logout.',
    ]},
    { title:'6. Business Logic', icon:'âš™ï¸', steps:[
      'Test negative quantities, boundary values, and unexpected data types in all forms.',
      'Replay completed transaction requests to check idempotency.',
      'Test workflow bypass: skip steps in multi-step processes.',
      'Attempt to access resources that belong to a different organisational tenant.',
    ]},
  ];
  return guide.map(section => `<div class="guide-section">
    <div class="guide-section-title">${section.icon} ${escHtml(section.title)}</div>
    <ul class="guide-steps">${section.steps.map(s => `<li>${escHtml(s)}</li>`).join('')}</ul>
  </div>`).join('');
}

// â”€â”€â”€ Compliance Section â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildComplianceSection(findings) {
  const owaspCountMap = {};
  for (const f of findings) {
    const id = (f.owaspId || 'Unknown').split(':')[0] + ':2021';
    owaspCountMap[id] = (owaspCountMap[id] || 0) + 1;
  }

  const rows = OWASP_TOP10.map(o => {
    const cnt = owaspCountMap[o.id] || 0;
    const wf = findings.filter(f => (f.owaspId||'').includes(o.id.split(':')[0]));
    const ws = worstSev(wf) || 'pass';
    const status = cnt === 0 ? 'PASS' : (SEV_ORDER[ws] >= 4 ? 'FAIL' : 'WARN');
    const statusClass = status === 'PASS' ? 'compliance-pass' : status === 'FAIL' ? 'compliance-fail' : 'compliance-warn';
    return `<tr>
      <td><span class="owasp-id-colored" style="color:${o.color}">${escHtml(o.id)}</span></td>
      <td>${escHtml(o.name)}</td>
      <td style="text-align:center">${cnt}</td>
      <td>${cnt > 0 ? `<span class="sev-badge-dark sev-${ws}">${ws.charAt(0).toUpperCase()+ws.slice(1)}</span>` : 'â€”'}</td>
      <td><span class="compliance-badge ${statusClass}">${status}</span></td>
    </tr>`;
  }).join('');

  const passed = OWASP_TOP10.filter(o => !owaspCountMap[o.id]).length;
  return `<div class="compliance-summary">
    <div class="compliance-stat"><span class="compliance-stat-val" style="color:var(--status-pass)">${passed}</span><span class="compliance-stat-lbl">OWASP categories clean</span></div>
    <div class="compliance-stat"><span class="compliance-stat-val" style="color:var(--severity-high)">${10 - passed}</span><span class="compliance-stat-lbl">categories with findings</span></div>
  </div>
  <table class="compliance-table">
    <thead><tr><th>ID</th><th>Category</th><th>Findings</th><th>Worst severity</th><th>Status</th></tr></thead>
    <tbody>${rows}</tbody>
  </table>`;
}

// â”€â”€â”€ Master HTML Builder â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function buildHtml(reportData) {
  const { findings, verdict, storyKey, meta, chartJsSrc, score } = reportData;
  const m = meta || {};
  const counts = { critical:0, high:0, medium:0, low:0, informational:0, total:0 };
  for (const f of findings) {
    const s = (f.severity || 'informational').toLowerCase();
    if (counts[s] !== undefined) counts[s]++;
    counts.total++;
  }

  const durationStr = formatDuration(m.durationSeconds);
  const verdictLabel = verdict === 'pass' ? 'âœ” PASS' : verdict === 'warn' ? 'âš  WARN' : 'âœ– FAIL';

  // Build pentest stats
  const pentestModules = m.pentestModules || [];
  const totalPentestFindings = pentestModules.reduce((sum, pm) => sum + (pm.findings || []).length, 0);
  const pentestDurationSec = m.pentestDurationMs ? (m.pentestDurationMs / 1000).toFixed(0) : null;
  const pentestTotalVectors = m.pentestTotalAttackVectors || 0;
  const pentestSuccessRate = m.pentestSuccessfulExploits && pentestTotalVectors
    ? ((m.pentestSuccessfulExploits / pentestTotalVectors) * 100).toFixed(1)
    : null;

  // Sorted findings
  const sortedFindings = [...findings].sort((a, b) => {
    const sd = (SEV_ORDER[b.severity] || 0) - (SEV_ORDER[a.severity] || 0);
    return sd !== 0 ? sd : (b.cvss || 0) - (a.cvss || 0);
  });

  // Per-layer counts for charts
  const layers = { zap: {critical:0,high:0,medium:0,low:0,informational:0}, custom: {critical:0,high:0,medium:0,low:0,informational:0}, pentest: {critical:0,high:0,medium:0,low:0,informational:0} };
  for (const f of findings) {
    const src = (f.source || 'zap').toLowerCase();
    const sev = (f.severity || 'informational').toLowerCase();
    if (layers[src] && layers[src][sev] !== undefined) layers[src][sev]++;
  }

  // Historical scan data for trend chart
  const historicalScans = m.historicalScans || [];

  // Build HTML sections
  const findingCardsHtml = sortedFindings.map((f, i) => buildFindingCard(f, i)).join('');
  const pentestModuleCardsHtml = buildPentestModuleCards(pentestModules);
  const pentestGuideHtml = buildPentestGuide();
  const complianceHtml = buildComplianceSection(findings);
  const owaspHeatmapHtml = buildOwaspHeatmap(findings);
  const svgGauge = buildSvgGauge(score);

  // JSON for inline charts (browser-side)
  const FINDINGS_JSON = JSON.stringify(findings.map(f => ({
    severity: (f.severity||'informational').toLowerCase(),
    cvss: f.cvss || 0,
    owaspId: f.owaspId || '',
    source: (f.source||'zap').toLowerCase(),
  })));
  const COUNTS_JSON = JSON.stringify(counts);
  const LAYERS_JSON = JSON.stringify(layers);
  const HISTORICAL_JSON = JSON.stringify(historicalScans);

  // Pentest module coverage data for chart
  const PENTEST_COVERAGE_JSON = JSON.stringify(PENTEST_MODULES.map(def => {
    const mod = pentestModules.find(m2 => (m2.name||m2.key) === def.key) || {};
    return { label: def.label, endpoints: mod.endpointsTested || 0, findings: (mod.findings||[]).length };
  }));

  // Scan metadata rows
  function metaRowHtml(label, value) {
    return `<div class="meta-row-dark"><span class="meta-label-dark">${escHtml(label)}</span><span>${escHtml(String(value ?? 'â€”'))}</span></div>`;
  }

  // Severity summary badges
  const sevBadgesTop = ['critical','high','medium','low','informational']
    .filter(s => counts[s] > 0)
    .map(s => `<span class="sev-badge-top sev-${s}">${counts[s]} ${s}</span>`)
    .join('');

  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="UTF-8">
<meta name="viewport" content="width=device-width, initial-scale=1.0">
<title>Security Assessment â€” ${escHtml(storyKey)}</title>
<style>
@import url('https://fonts.googleapis.com/css2?family=Orbitron:wght@700;900&family=Inter:wght@400;500;600;700;800&family=JetBrains+Mono:wght@400;500;700&display=swap');

*,*::before,*::after{box-sizing:border-box;margin:0;padding:0}

:root{
  --bg-primary:#0a0e27;
  --bg-secondary:#141b3d;
  --bg-tertiary:#1e2749;
  --bg-elevated:#2a3254;
  --text-primary:#e8edf9;
  --text-secondary:#a8b4d1;
  --text-muted:#6b7a9e;
  --severity-critical:#ff3366;
  --severity-high:#ff9933;
  --severity-medium:#ffcc00;
  --severity-low:#33ccff;
  --severity-info:#9966ff;
  --status-pass:#00ff88;
  --status-fail:#ff3366;
  --status-warning:#ffcc00;
  --accent-primary:#00ffcc;
  --border-subtle:rgba(255,255,255,0.08);
  --border-medium:rgba(255,255,255,0.15);
}

html{scroll-behavior:smooth}
body{font-family:'Inter',system-ui,sans-serif;font-size:13px;color:var(--text-primary);background:var(--bg-primary);line-height:1.5;min-height:100vh}
a{color:var(--accent-primary)}a:hover{text-decoration:underline}
.sr-only{position:absolute;width:1px;height:1px;padding:0;margin:-1px;overflow:hidden;clip:rect(0,0,0,0);white-space:nowrap;border:0}

/* â”€â”€ Top nav bar â”€â”€ */
.top-bar{position:sticky;top:0;z-index:100;background:var(--bg-secondary);border-bottom:1px solid var(--border-subtle);display:flex;align-items:center;gap:0;padding:0;min-height:44px}
.nav-brand{padding:0 1rem;font-family:'Orbitron',sans-serif;font-size:12px;font-weight:700;color:var(--accent-primary);letter-spacing:0.08em;white-space:nowrap;border-right:1px solid var(--border-subtle)}
.nav-tabs{display:flex;flex:1;overflow-x:auto}
.nav-tab{padding:0.7rem 1rem;background:none;border:none;border-bottom:2px solid transparent;cursor:pointer;color:var(--text-muted);font-family:'Inter',sans-serif;font-size:12px;font-weight:500;white-space:nowrap;transition:color .15s,border-color .15s}
.nav-tab:hover{color:var(--text-secondary)}
.nav-tab.active{color:var(--accent-primary);border-bottom-color:var(--accent-primary)}
.nav-actions{padding:0 0.75rem;display:flex;gap:0.5rem;align-items:center;border-left:1px solid var(--border-subtle)}
.btn-print{padding:0.3rem 0.75rem;border-radius:4px;border:1px solid var(--border-medium);background:transparent;color:var(--text-secondary);font-size:11px;cursor:pointer;font-family:'Inter',sans-serif;transition:all .15s}
.btn-print:hover{border-color:var(--accent-primary);color:var(--accent-primary)}

/* â”€â”€ Report header â”€â”€ */
.report-header{background:linear-gradient(135deg,var(--bg-secondary) 0%,var(--bg-tertiary) 100%);border-bottom:1px solid var(--border-subtle);padding:1.5rem 2rem}
.report-header-top{display:flex;justify-content:space-between;align-items:flex-start;gap:1rem;flex-wrap:wrap}
.report-title-block h1{font-family:'Orbitron',sans-serif;font-size:20px;font-weight:700;color:var(--text-primary);margin-bottom:0.4rem;letter-spacing:0.04em}
.report-title-block .report-subtitle{font-size:12px;color:var(--text-secondary);line-height:1.8}
.verdict-chip{padding:0.4rem 1.2rem;border-radius:20px;font-family:'Orbitron',sans-serif;font-size:13px;font-weight:700;letter-spacing:0.06em;white-space:nowrap}
.verdict-pass{background:rgba(0,255,136,0.15);color:var(--status-pass);border:1px solid rgba(0,255,136,0.3)}
.verdict-warn{background:rgba(255,204,0,0.15);color:var(--status-warning);border:1px solid rgba(255,204,0,0.3)}
.verdict-fail{background:rgba(255,51,102,0.15);color:var(--status-fail);border:1px solid rgba(255,51,102,0.3)}
.sev-badges-row{display:flex;gap:5px;flex-wrap:wrap;margin-top:0.6rem}
.sev-badge-top{font-size:11px;font-weight:600;padding:2px 10px;border-radius:12px;white-space:nowrap;font-family:'Inter',sans-serif}
.sev-badge-top.sev-critical{background:rgba(255,51,102,0.2);color:var(--severity-critical);border:1px solid rgba(255,51,102,0.4)}
.sev-badge-top.sev-high{background:rgba(255,153,51,0.2);color:var(--severity-high);border:1px solid rgba(255,153,51,0.4)}
.sev-badge-top.sev-medium{background:rgba(255,204,0,0.2);color:var(--severity-medium);border:1px solid rgba(255,204,0,0.4)}
.sev-badge-top.sev-low{background:rgba(51,204,255,0.2);color:var(--severity-low);border:1px solid rgba(51,204,255,0.4)}
.sev-badge-top.sev-informational{background:rgba(153,102,255,0.2);color:var(--severity-info);border:1px solid rgba(153,102,255,0.4)}

/* â”€â”€ Tab panels â”€â”€ */
.tab-panel{display:none}
.tab-panel.active{display:block}
.section-pad{padding:1.5rem 2rem}

/* â”€â”€ Executive summary KPI grid â”€â”€ */
.kpi-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(130px,1fr));gap:10px;margin-bottom:1.5rem}
.kpi-card{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:0.9rem;text-align:center;transition:border-color .2s}
.kpi-card:hover{border-color:var(--border-medium)}
.kpi-label{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);margin-bottom:0.35rem;font-weight:600}
.kpi-value{font-family:'Orbitron',sans-serif;font-size:24px;font-weight:700;line-height:1}
.kpi-value.kv-critical{color:var(--severity-critical)}
.kpi-value.kv-high{color:var(--severity-high)}
.kpi-value.kv-medium{color:var(--severity-medium)}
.kpi-value.kv-low{color:var(--severity-low)}
.kpi-value.kv-info{color:var(--severity-info)}
.kpi-value.kv-total{color:var(--text-primary)}
.kpi-value.kv-score{color:var(--accent-primary)}

/* â”€â”€ Gauge + charts layout â”€â”€ */
.exec-dashboard{display:grid;grid-template-columns:auto 1fr 1fr;gap:20px;align-items:start;margin-bottom:1.5rem}
.gauge-block{display:flex;flex-direction:column;align-items:center;background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:1.2rem 1.5rem;gap:0.5rem}
.gauge-label{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--text-muted);font-weight:600}
.chart-card{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:1rem 1.2rem}
.chart-card-title{font-size:11px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);font-weight:600;margin-bottom:0.75rem}
.chart-wrap{position:relative}

/* â”€â”€ OWASP Heatmap â”€â”€ */
.owasp-heatmap{display:grid;grid-template-columns:repeat(5,1fr);gap:6px;margin-top:0.5rem}
.owasp-cell{border-radius:6px;padding:0.6rem 0.4rem;text-align:center;cursor:default;transition:opacity .2s}
.owasp-cell:hover{opacity:1!important}
.owasp-cell-id{font-size:10px;font-weight:700;font-family:'JetBrains Mono',monospace;color:rgba(255,255,255,0.9)}
.owasp-cell-count{font-family:'Orbitron',sans-serif;font-size:18px;font-weight:700;color:#fff;line-height:1.2}

/* â”€â”€ Severity badges (dark) â”€â”€ */
.sev-badge-dark{display:inline-block;font-size:11px;font-weight:600;padding:2px 9px;border-radius:10px;white-space:nowrap;letter-spacing:0.02em}
.sev-badge-dark.sev-critical{background:rgba(255,51,102,0.2);color:var(--severity-critical)}
.sev-badge-dark.sev-high{background:rgba(255,153,51,0.2);color:var(--severity-high)}
.sev-badge-dark.sev-medium{background:rgba(255,204,0,0.2);color:var(--severity-medium)}
.sev-badge-dark.sev-low{background:rgba(51,204,255,0.2);color:var(--severity-low)}
.sev-badge-dark.sev-informational,
.sev-badge-dark.sev-info{background:rgba(153,102,255,0.2);color:var(--severity-info)}

/* â”€â”€ Layer badges â”€â”€ */
.layer-badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 7px;border-radius:8px;letter-spacing:0.04em}
.layer-badge.zap{background:rgba(139,92,246,0.15);color:rgb(139,92,246)}
.layer-badge.custom{background:rgba(251,146,60,0.15);color:rgb(251,146,60)}
.layer-badge.pentest{background:rgba(236,72,153,0.15);color:rgb(236,72,153)}

/* â”€â”€ Finding cards â”€â”€ */
.finding-card{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;margin-bottom:8px;overflow:hidden;transition:border-color .2s}
.finding-card[open]{border-color:var(--border-medium)}
.finding-card summary{padding:0.85rem 1rem;cursor:pointer;display:flex;align-items:center;gap:8px;font-size:13px;font-weight:500;list-style:none;user-select:none}
.finding-card summary::-webkit-details-marker{display:none}
.finding-card[open] summary .chevron-icon{transform:rotate(180deg)}
.chevron-icon{font-size:10px;transition:transform .18s ease;color:var(--text-muted);flex-shrink:0}
.finding-name-text{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cvss-num{font-family:'JetBrains Mono',monospace;font-size:12px;color:var(--text-muted);flex-shrink:0}
.owasp-id-tag{font-size:10px;color:var(--text-muted);font-family:'JetBrains Mono',monospace}
.finding-body-dark{padding:1rem 1.2rem;border-top:1px solid var(--border-subtle);background:var(--bg-tertiary);font-size:12px}
.finding-grid{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem;margin-top:0.5rem}
.finding-col{}
.field-label-dark{font-size:10px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);font-weight:600;margin-bottom:0.35rem}
.field-text-dark{font-size:12px;color:var(--text-secondary);line-height:1.6}
.evidence-dark{font-family:'JetBrains Mono',monospace;font-size:11px;background:var(--bg-primary);border:1px solid var(--border-subtle);border-radius:6px;padding:0.6rem 0.8rem;word-break:break-all;white-space:pre-wrap;color:var(--accent-primary);overflow-x:auto;margin-top:0.35rem;max-height:180px}
.meta-block-dark{background:var(--bg-elevated);border-radius:8px;padding:0.75rem;display:flex;flex-direction:column;gap:0.5rem}
.meta-row-dark{display:flex;justify-content:space-between;gap:1rem;font-size:12px;align-items:baseline;flex-wrap:wrap}
.meta-label-dark{color:var(--text-muted);white-space:nowrap;flex-shrink:0;min-width:100px}
.code-tag{font-family:'JetBrains Mono',monospace;font-size:11px;background:rgba(0,255,204,0.07);color:var(--accent-primary);padding:1px 5px;border-radius:4px;word-break:break-all}
.attack-block,.remediation-block{margin-top:0.75rem;background:var(--bg-elevated);border-radius:8px;padding:0.75rem;display:flex;flex-direction:column;gap:0.4rem}
.steps-list{display:flex;flex-direction:column;gap:0.4rem;margin-top:0.35rem}
.step-row{display:flex;gap:8px;align-items:flex-start;font-size:12px;line-height:1.5;color:var(--text-secondary)}
.step-num{width:20px;height:20px;min-width:20px;border-radius:50%;background:rgba(0,255,204,0.1);color:var(--accent-primary);font-size:10px;font-weight:700;display:flex;align-items:center;justify-content:center;flex-shrink:0}
.alert-critical-banner{background:rgba(255,51,102,0.12);border:1px solid rgba(255,51,102,0.3);border-radius:6px;padding:0.5rem 0.75rem;font-size:12px;color:var(--severity-critical);margin-bottom:0.75rem}
.alert-high-banner{background:rgba(255,153,51,0.12);border:1px solid rgba(255,153,51,0.3);border-radius:6px;padding:0.5rem 0.75rem;font-size:12px;color:var(--severity-high);margin-bottom:0.75rem}
.jira-link{color:var(--accent-primary);text-decoration:none}
.jira-link:hover{text-decoration:underline}
.ref-link{color:var(--accent-primary);font-size:11px}
.status-badge{display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;font-weight:600}
.status-badge.status-new{background:rgba(0,255,136,0.12);color:var(--status-pass)}
.status-badge.status-recurring{background:rgba(255,153,51,0.12);color:var(--severity-high)}
.status-badge.status-regression{background:rgba(255,51,102,0.12);color:var(--severity-critical)}
.status-badge.status-suppressed{background:rgba(107,122,158,0.2);color:var(--text-muted)}
.priority-badge{display:inline-block;font-size:10px;padding:1px 7px;border-radius:8px;font-weight:700;margin-bottom:0.4rem}
.priority-badge.priority-p0{background:rgba(255,51,102,0.2);color:var(--severity-critical)}
.priority-badge.priority-p1{background:rgba(255,153,51,0.2);color:var(--severity-high)}
.priority-badge.priority-p2{background:rgba(255,204,0,0.2);color:var(--severity-medium)}
.priority-badge.priority-p3{background:rgba(51,204,255,0.2);color:var(--severity-low)}
.code-compare{display:grid;grid-template-columns:1fr 1fr;gap:8px;margin-top:0.5rem}
.code-label{font-size:10px;font-weight:700;margin-bottom:3px;padding:2px 6px;border-radius:4px 4px 0 0}
.code-label.bad{background:rgba(255,51,102,0.2);color:var(--severity-critical)}
.code-label.good{background:rgba(0,255,136,0.2);color:var(--status-pass)}
.code-block{font-family:'JetBrains Mono',monospace;font-size:10px;background:var(--bg-primary);border-radius:0 4px 4px 4px;padding:0.5rem;overflow-x:auto;white-space:pre-wrap;line-height:1.5}
.code-block.bad{color:#ff8fab;border:1px solid rgba(255,51,102,0.2)}
.code-block.good{color:#00ff88;border:1px solid rgba(0,255,136,0.2)}

/* â”€â”€ Sev dot (pentest) â”€â”€ */
.sev-dot{display:inline-block;width:8px;height:8px;border-radius:50%;flex-shrink:0}
.sev-dot-critical{background:var(--severity-critical)}
.sev-dot-high{background:var(--severity-high)}
.sev-dot-medium{background:var(--severity-medium)}
.sev-dot-low{background:var(--severity-low)}
.sev-dot-informational,.sev-dot-info{background:var(--severity-info)}

/* â”€â”€ Pentest cards â”€â”€ */
.pt-card{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;margin-bottom:8px;overflow:hidden;transition:border-color .2s}
.pt-card[open]{border-color:var(--border-medium)}
.pt-card summary{padding:0.85rem 1rem;cursor:pointer;display:flex;align-items:center;gap:10px;font-size:13px;list-style:none;user-select:none;flex-wrap:wrap}
.pt-card summary::-webkit-details-marker{display:none}
.pt-card[open] summary .pt-chevron{transform:rotate(180deg)}
.pt-chevron{font-size:10px;transition:transform .18s ease;color:var(--text-muted);margin-left:auto;flex-shrink:0}
.pt-emoji{font-size:18px;flex-shrink:0}
.pt-card-label{font-weight:600;flex-shrink:0}
.pt-stats{font-size:11px;color:var(--text-muted)}
.pt-finding-count{font-size:11px;font-weight:700;padding:2px 8px;border-radius:8px;background:var(--bg-elevated);color:var(--text-muted)}
.pt-finding-count.has-findings{background:rgba(255,51,102,0.15);color:var(--severity-critical)}
.pt-badge{font-size:10px;font-weight:700;padding:2px 8px;border-radius:8px;letter-spacing:0.04em}
.pt-status-success{background:rgba(0,255,136,0.12);color:var(--status-pass)}
.pt-status-partial{background:rgba(255,204,0,0.12);color:var(--status-warning)}
.pt-status-failed{background:rgba(255,51,102,0.12);color:var(--status-fail)}
.pt-status-notrun{background:rgba(107,122,158,0.15);color:var(--text-muted)}
.pt-card-body{padding:1rem 1.2rem;border-top:1px solid var(--border-subtle);background:var(--bg-tertiary);font-size:12px}
.pt-findings-list{display:flex;flex-direction:column;gap:5px;margin-bottom:0.75rem}
.pt-finding-row{display:flex;align-items:center;gap:8px;padding:0.35rem 0.5rem;background:var(--bg-elevated);border-radius:6px}
.pt-finding-name{flex:1;color:var(--text-primary)}
.pt-finding-cvss{font-family:'JetBrains Mono',monospace;font-size:11px;color:var(--text-muted)}
.pt-vectors{margin-top:0.5rem;display:flex;flex-wrap:wrap;gap:5px;align-items:center}

/* â”€â”€ Guide â”€â”€ */
.guide-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:16px}
.guide-section{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:1rem 1.2rem}
.guide-section-title{font-size:14px;font-weight:700;color:var(--text-primary);margin-bottom:0.75rem}
.guide-steps{padding-left:1.2rem;display:flex;flex-direction:column;gap:0.4rem}
.guide-steps li{font-size:12px;color:var(--text-secondary);line-height:1.6}

/* â”€â”€ Compliance table â”€â”€ */
.compliance-summary{display:flex;gap:20px;margin-bottom:1.2rem;flex-wrap:wrap}
.compliance-stat{display:flex;flex-direction:column;align-items:center;background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:0.8rem 1.5rem}
.compliance-stat-val{font-family:'Orbitron',sans-serif;font-size:28px;font-weight:700}
.compliance-stat-lbl{font-size:11px;color:var(--text-muted);margin-top:0.2rem;text-align:center}
.compliance-table{width:100%;border-collapse:collapse;font-size:12px}
.compliance-table th{font-size:10px;text-transform:uppercase;letter-spacing:0.07em;color:var(--text-muted);border-bottom:1px solid var(--border-subtle);padding:0.5rem 0.75rem;text-align:left;font-weight:600}
.compliance-table td{padding:0.5rem 0.75rem;border-bottom:1px solid var(--border-subtle);vertical-align:middle}
.compliance-table tr:last-child td{border-bottom:none}
.compliance-badge{display:inline-block;font-size:10px;font-weight:700;padding:2px 10px;border-radius:10px;letter-spacing:0.04em}
.compliance-pass{background:rgba(0,255,136,0.12);color:var(--status-pass)}
.compliance-fail{background:rgba(255,51,102,0.12);color:var(--status-fail)}
.compliance-warn{background:rgba(255,204,0,0.12);color:var(--status-warning)}
.owasp-id-colored{font-family:'JetBrains Mono',monospace;font-size:11px;font-weight:700}

/* â”€â”€ Scan metadata â”€â”€ */
.meta-2col{display:grid;grid-template-columns:1fr 1fr;gap:1.5rem}
.meta-section{background:var(--bg-secondary);border:1px solid var(--border-subtle);border-radius:10px;padding:1rem 1.2rem}
.meta-section-title{font-size:10px;text-transform:uppercase;letter-spacing:0.08em;color:var(--accent-primary);font-weight:700;margin-bottom:0.75rem}

/* â”€â”€ No data â”€â”€ */
.no-data-msg{color:var(--text-muted);font-size:12px;padding:1rem;text-align:center;background:var(--bg-tertiary);border-radius:8px}

/* â”€â”€ Filter toolbar â”€â”€ */
.filter-bar{display:flex;gap:8px;margin-bottom:1rem;flex-wrap:wrap}
.filter-btn{padding:0.3rem 0.8rem;border-radius:16px;border:1px solid var(--border-subtle);background:transparent;color:var(--text-muted);font-size:11px;cursor:pointer;transition:all .15s;font-family:'Inter',sans-serif}
.filter-btn:hover,.filter-btn.active{border-color:var(--accent-primary);color:var(--accent-primary);background:rgba(0,255,204,0.07)}
.filter-btn.f-critical.active{border-color:var(--severity-critical);color:var(--severity-critical);background:rgba(255,51,102,0.07)}
.filter-btn.f-high.active{border-color:var(--severity-high);color:var(--severity-high);background:rgba(255,153,51,0.07)}
.filter-btn.f-medium.active{border-color:var(--severity-medium);color:var(--severity-medium);background:rgba(255,204,0,0.07)}
.filter-btn.f-low.active{border-color:var(--severity-low);color:var(--severity-low);background:rgba(51,204,255,0.07)}

/* â”€â”€ Remediation tracker â”€â”€ */
.tracker-counter{font-size:13px;color:var(--text-secondary);margin-bottom:1rem;display:flex;align-items:center;gap:0.75rem}
.tracker-progress{flex:1;max-width:300px;height:6px;background:var(--bg-elevated);border-radius:3px;overflow:hidden}
.tracker-progress-fill{height:100%;background:var(--status-pass);border-radius:3px;transition:width .3s ease}
.rem-group-hdr{font-size:11px;font-weight:700;padding:0.3rem 0.75rem;border-radius:6px;margin-bottom:4px;margin-top:0.9rem;text-transform:uppercase;letter-spacing:0.05em}
.rem-item{display:flex;gap:10px;align-items:flex-start;padding:0.5rem 0.75rem;border:1px solid var(--border-subtle);border-radius:8px;margin-bottom:4px;background:var(--bg-secondary);transition:opacity .2s}
.rem-item.done{opacity:0.4}
.rem-cb{width:16px;height:16px;min-width:16px;border:1px solid var(--border-medium);border-radius:4px;margin-top:2px;cursor:pointer;position:relative;flex-shrink:0;background:transparent;transition:all .15s}
.rem-cb.checked{background:var(--status-pass);border-color:var(--status-pass)}
.rem-cb.checked::after{content:"";position:absolute;width:9px;height:5px;border-left:2px solid #0a0e27;border-bottom:2px solid #0a0e27;transform:rotate(-45deg);top:3px;left:2px}
.rem-text strong{display:block;font-size:12px;color:var(--text-primary)}
.rem-hint{font-size:11px;color:var(--text-muted)}

/* â”€â”€ Footer â”€â”€ */
.report-footer{display:flex;justify-content:space-between;align-items:center;border-top:1px solid var(--border-subtle);padding:1rem 2rem;font-size:11px;color:var(--text-muted);flex-wrap:wrap;gap:0.5rem;background:var(--bg-secondary)}
.report-footer a{color:var(--text-muted);text-decoration:none}
.report-footer a:hover{color:var(--accent-primary)}

/* â”€â”€ Section headers â”€â”€ */
.section-hdr{font-size:10px;text-transform:uppercase;letter-spacing:0.1em;color:var(--text-muted);font-weight:700;margin-bottom:1rem;display:flex;align-items:center;gap:0.5rem}
.section-hdr::after{content:"";flex:1;height:1px;background:var(--border-subtle)}

/* â”€â”€ Print â”€â”€ */
@media print{
  .top-bar,.nav-actions,.filter-bar,.btn-print{display:none!important}
  .tab-panel{display:block!important}
  .finding-card[open] summary .chevron-icon,.pt-card[open] summary .pt-chevron{transform:none}
  body{background:#fff;color:#111}
  :root{--bg-primary:#fff;--bg-secondary:#f8f8f8;--bg-tertiary:#f0f0f0;--bg-elevated:#e8e8e8;--text-primary:#111;--text-secondary:#444;--text-muted:#777;--border-subtle:rgba(0,0,0,0.12);--border-medium:rgba(0,0,0,0.2)}
  .sev-badge-dark{border:1px solid currentColor}
}

@media(max-width:768px){
  .exec-dashboard{grid-template-columns:1fr}
  .finding-grid{grid-template-columns:1fr}
  .meta-2col{grid-template-columns:1fr}
  .owasp-heatmap{grid-template-columns:repeat(5,1fr)}
}
</style>
</head>
<body>

<!-- â”€â”€ Navigation â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
<nav class="top-bar" role="navigation" aria-label="Report sections">
  <div class="nav-brand">CYBERSEC COMMAND</div>
  <div class="nav-tabs">
    <button class="nav-tab active" id="ntab-exec"       onclick="showTab('exec',this)"       aria-controls="tab-exec">Executive Summary</button>
    <button class="nav-tab"        id="ntab-owasp"      onclick="showTab('owasp',this)"      aria-controls="tab-owasp">OWASP Top 10</button>
    <button class="nav-tab"        id="ntab-pentest"    onclick="showTab('pentest',this)"    aria-controls="tab-pentest">Pentest Results</button>
    <button class="nav-tab"        id="ntab-guide"      onclick="showTab('guide',this)"      aria-controls="tab-guide">Human Pentest Guide</button>
    <button class="nav-tab"        id="ntab-findings"   onclick="showTab('findings',this)"   aria-controls="tab-findings">All Findings</button>
    <button class="nav-tab"        id="ntab-compliance" onclick="showTab('compliance',this)" aria-controls="tab-compliance">Compliance</button>
    <button class="nav-tab"        id="ntab-meta"       onclick="showTab('meta',this)"       aria-controls="tab-meta">Scan Details</button>
  </div>
  <div class="nav-actions">
    <button class="btn-print" onclick="window.print()">Print / PDF</button>
  </div>
</nav>

<!-- â”€â”€ Report header â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
<header class="report-header">
  <div class="report-header-top">
    <div class="report-title-block">
      <h1>Security &amp; Penetration Testing Assessment</h1>
      <div class="report-subtitle">
        Story: <strong>${escHtml(storyKey)}</strong> &nbsp;&middot;&nbsp;
        Target: ${escHtml(m.targetUrl || 'â€”')} &nbsp;&middot;&nbsp;
        Scan: ${formatTimestamp(m.startTime)}<br>
        Engine: OWASP ZAP ${escHtml(m.zapVersion || 'â€”')} (${escHtml(m.scanType || 'â€”')}) + ${m.customChecksRun || 0} custom OWASP checks
        ${pentestModules.length ? ` + ${pentestModules.length} automated pentest modules` : ''}
        &nbsp;&middot;&nbsp; OWASP Top 10 (2021) &nbsp;&middot;&nbsp; CVSS v3.1
      </div>
    </div>
    <div>
      <span class="verdict-chip verdict-${verdict}">${escHtml(verdictLabel)}</span>
      <div class="sev-badges-row">${sevBadgesTop}</div>
    </div>
  </div>
</header>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 1 â€” EXECUTIVE SUMMARY
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-exec" class="tab-panel active section-pad" role="tabpanel" aria-labelledby="ntab-exec">
  <div class="section-hdr">Security posture &amp; key metrics</div>

  <!-- KPI grid -->
  <div class="kpi-grid">
    <div class="kpi-card"><div class="kpi-label">Security Score</div><div class="kpi-value kv-score">${score}</div></div>
    <div class="kpi-card"><div class="kpi-label">Critical</div><div class="kpi-value kv-critical">${counts.critical}</div></div>
    <div class="kpi-card"><div class="kpi-label">High</div><div class="kpi-value kv-high">${counts.high}</div></div>
    <div class="kpi-card"><div class="kpi-label">Medium</div><div class="kpi-value kv-medium">${counts.medium}</div></div>
    <div class="kpi-card"><div class="kpi-label">Low</div><div class="kpi-value kv-low">${counts.low}</div></div>
    <div class="kpi-card"><div class="kpi-label">Informational</div><div class="kpi-value kv-info">${counts.informational}</div></div>
    <div class="kpi-card"><div class="kpi-label">Total Findings</div><div class="kpi-value kv-total">${counts.total}</div></div>
    ${pentestTotalVectors ? `<div class="kpi-card"><div class="kpi-label">Attack Vectors</div><div class="kpi-value kv-info">${pentestTotalVectors}</div></div>` : ''}
    ${pentestSuccessRate !== null ? `<div class="kpi-card"><div class="kpi-label">Exploit Rate</div><div class="kpi-value kv-critical">${pentestSuccessRate}%</div></div>` : ''}
  </div>

  <!-- Gauge + charts -->
  <div class="exec-dashboard">
    <div class="gauge-block">
      <div class="gauge-label">Security Posture</div>
      ${svgGauge}
    </div>
    <div class="chart-card">
      <div class="chart-card-title">Findings by severity</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-severity-donut" aria-label="Severity distribution donut chart"></canvas></div>
    </div>
    <div class="chart-card">
      <div class="chart-card-title">Findings by layer (stacked)</div>
      <div class="chart-wrap" style="height:180px"><canvas id="chart-layer-bar" aria-label="Layer bar chart"></canvas></div>
    </div>
  </div>

  <!-- OWASP Heatmap mini preview -->
  <div class="section-hdr" style="margin-top:1.5rem">OWASP Top 10 heatmap</div>
  ${owaspHeatmapHtml}
  <p style="font-size:11px;color:var(--text-muted);margin-top:0.5rem">Cell opacity scales with finding count. Click "OWASP Top 10" tab for full breakdown.</p>

  <!-- Trend chart -->
  <div class="section-hdr" style="margin-top:1.5rem">Historical trend</div>
  <div class="chart-card" style="margin-bottom:1rem">
    <div class="chart-card-title">Findings per severity over last scans</div>
    <div class="chart-wrap" style="height:180px"><canvas id="chart-trend-line" aria-label="Trend line chart"></canvas></div>
  </div>

  <!-- CVSS scatter -->
  <div class="chart-card">
    <div class="chart-card-title">CVSS score distribution (scatter)</div>
    <div class="chart-wrap" style="height:180px"><canvas id="chart-cvss-scatter" aria-label="CVSS scatter chart"></canvas></div>
  </div>
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 2 â€” OWASP Top 10
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-owasp" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-owasp">
  <div class="section-hdr">OWASP Top 10 (2021) coverage</div>
  ${owaspHeatmapHtml}
  <div style="margin-top:1.5rem">
    <div class="chart-card">
      <div class="chart-card-title">Findings per OWASP category</div>
      <div class="chart-wrap" style="height:260px"><canvas id="chart-findings-by-owasp" aria-label="Findings by OWASP category"></canvas></div>
    </div>
  </div>
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 3 â€” PENTEST RESULTS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-pentest" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-pentest">
  <div class="section-hdr">Automated pentest module results</div>
  <div style="display:flex;gap:12px;margin-bottom:1.2rem;flex-wrap:wrap">
    <div class="kpi-card" style="min-width:120px"><div class="kpi-label">Modules Run</div><div class="kpi-value kv-total">${pentestModules.length}</div></div>
    ${totalPentestFindings ? `<div class="kpi-card" style="min-width:120px"><div class="kpi-label">PT Findings</div><div class="kpi-value kv-critical">${totalPentestFindings}</div></div>` : ''}
    ${pentestDurationSec ? `<div class="kpi-card" style="min-width:120px"><div class="kpi-label">PT Duration</div><div class="kpi-value kv-score">${pentestDurationSec}s</div></div>` : ''}
    ${pentestTotalVectors ? `<div class="kpi-card" style="min-width:120px"><div class="kpi-label">Vectors Used</div><div class="kpi-value kv-info">${pentestTotalVectors}</div></div>` : ''}
  </div>

  <!-- Coverage chart -->
  <div class="chart-card" style="margin-bottom:1.2rem">
    <div class="chart-card-title">Endpoints tested per module</div>
    <div class="chart-wrap" style="height:200px"><canvas id="chart-pentest-coverage" aria-label="Pentest coverage horizontal bar"></canvas></div>
  </div>

  ${pentestModuleCardsHtml}
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 4 â€” HUMAN PENTEST GUIDE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-guide" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-guide">
  <div class="section-hdr">Manual penetration testing playbook</div>
  <div class="guide-grid">
    ${pentestGuideHtml}
  </div>
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 5 â€” ALL FINDINGS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-findings" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-findings">
  <div class="section-hdr">All findings (${counts.total} total)</div>
  <div class="filter-bar" role="group" aria-label="Filter by severity">
    <button class="filter-btn active" data-filter="all" onclick="filterFindings(this,'all')">All</button>
    ${counts.critical > 0 ? `<button class="filter-btn f-critical" data-filter="critical" onclick="filterFindings(this,'critical')">Critical (${counts.critical})</button>` : ''}
    ${counts.high > 0 ? `<button class="filter-btn f-high" data-filter="high" onclick="filterFindings(this,'high')">High (${counts.high})</button>` : ''}
    ${counts.medium > 0 ? `<button class="filter-btn f-medium" data-filter="medium" onclick="filterFindings(this,'medium')">Medium (${counts.medium})</button>` : ''}
    ${counts.low > 0 ? `<button class="filter-btn f-low" data-filter="low" onclick="filterFindings(this,'low')">Low (${counts.low})</button>` : ''}
    <button class="filter-btn" data-filter="zap" onclick="filterFindings(this,'zap')">ZAP only</button>
    <button class="filter-btn" data-filter="custom" onclick="filterFindings(this,'custom')">Custom only</button>
    <button class="filter-btn" data-filter="pentest" onclick="filterFindings(this,'pentest')">Pentest only</button>
  </div>
  <div id="findings-list">
    ${findingCardsHtml || '<div class="no-data-msg">No findings recorded for this scan.</div>'}
  </div>
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 6 â€” COMPLIANCE
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-compliance" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-compliance">
  <div class="section-hdr">OWASP Top 10 compliance status</div>
  ${complianceHtml}
</section>

<!-- â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•
     TAB 7 â€” SCAN DETAILS
     â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â•â• -->
<section id="tab-meta" class="tab-panel section-pad" role="tabpanel" aria-labelledby="ntab-meta">
  <div class="section-hdr">Scan &amp; environment details</div>
  <div class="meta-2col">
    <div class="meta-section">
      <div class="meta-section-title">ZAP scan details</div>
      ${metaRowHtml('ZAP version',     m.zapVersion)}
      ${metaRowHtml('Scan type',       m.scanType)}
      ${metaRowHtml('Target URL',      m.targetUrl)}
      ${metaRowHtml('Spider URLs',     m.spiderUrls)}
      ${metaRowHtml('Passive alerts',  m.passiveAlerts)}
      ${metaRowHtml('Active alerts',   m.activeAlerts != null ? m.activeAlerts + ' alerts' : null)}
      ${metaRowHtml('ZAP report',      m.zapReportPath)}
    </div>
    <div class="meta-section">
      <div class="meta-section-title">Run details</div>
      ${metaRowHtml('Custom checks run',    m.customChecksRun)}
      ${metaRowHtml('Custom checks passed', m.customChecksPassed)}
      ${metaRowHtml('Start time',           formatTimestamp(m.startTime))}
      ${metaRowHtml('End time',             formatTimestamp(m.endTime))}
      ${metaRowHtml('Duration',             durationStr)}
      ${metaRowHtml('OWASP standard',       'OWASP Top 10 (2021)')}
      ${metaRowHtml('CVSS standard',        'CVSS v3.1')}
      ${metaRowHtml('Jira story',           m.jiraStoryUrl)}
      ${metaRowHtml('Zephyr cycle',         m.zephyrCycleUrl)}
    </div>
    ${pentestModules.length ? `<div class="meta-section">
      <div class="meta-section-title">Pentest details</div>
      ${metaRowHtml('Modules run',          pentestModules.length)}
      ${metaRowHtml('Total findings',       totalPentestFindings)}
      ${metaRowHtml('Duration',             pentestDurationSec ? pentestDurationSec + 's' : null)}
      ${metaRowHtml('Total attack vectors', pentestTotalVectors || null)}
      ${metaRowHtml('Successful exploits',  m.pentestSuccessfulExploits || null)}
      ${metaRowHtml('Exploit success rate', pentestSuccessRate !== null ? pentestSuccessRate + '%' : null)}
    </div>` : ''}
  </div>
</section>

<!-- â”€â”€ Footer â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
<footer class="report-footer">
  <div>
    ${m.jiraStoryUrl ? `Jira: <a href="${escHtml(m.jiraStoryUrl)}" target="_blank" rel="noopener noreferrer">${escHtml(storyKey)}</a> &nbsp;&middot;&nbsp; ` : ''}
    ${m.zephyrCycleUrl ? `Zephyr: <a href="${escHtml(m.zephyrCycleUrl)}" target="_blank" rel="noopener noreferrer">View cycle</a> &nbsp;&middot;&nbsp; ` : ''}
    ${m.zapReportPath ? `ZAP: <a href="${escHtml(m.zapReportPath)}" target="_blank" rel="noopener noreferrer">Download JSON</a>` : ''}
  </div>
  <div>Generated ${formatTimestamp(new Date().toISOString())} &nbsp;&middot;&nbsp; Agentic QA Platform v2.0.0</div>
</footer>

<!-- â”€â”€ Inline Chart.js â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
<script>${chartJsSrc}</script>

<!-- â”€â”€ Report runtime â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€ -->
<script>
(function(){
'use strict';
var FINDINGS = ${FINDINGS_JSON};
var COUNTS   = ${COUNTS_JSON};
var LAYERS   = ${LAYERS_JSON};
var HIST     = ${HISTORICAL_JSON};
var PT_COV   = ${PENTEST_COVERAGE_JSON};

var SEV_COLORS = {
  critical:'#ff3366', high:'#ff9933', medium:'#ffcc00',
  low:'#33ccff', informational:'#9966ff', info:'#9966ff'
};
var SEV_ORDER  = {critical:5,high:4,medium:3,low:2,informational:1,info:1};
var GRID_COLOR = 'rgba(255,255,255,0.05)';
var TICK_FONT  = {family:'Inter,sans-serif',size:10,color:'#6b7a9e'};
var CHART_DEFAULTS = {
  responsive:true, maintainAspectRatio:false,
  plugins:{legend:{display:false}},
};

function merge(a,b){return Object.assign({},a,b);}

// â”€â”€ Tab switching â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.showTab = function(id, btn) {
  document.querySelectorAll('.tab-panel').forEach(function(p){ p.classList.remove('active'); });
  document.querySelectorAll('.nav-tab').forEach(function(b){ b.classList.remove('active'); });
  var panel = document.getElementById('tab-'+id);
  if (panel) panel.classList.add('active');
  if (btn) btn.classList.add('active');
};

// â”€â”€ Finding filter â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
window.filterFindings = function(btn, filter) {
  document.querySelectorAll('.filter-btn').forEach(function(b){ b.classList.remove('active'); });
  btn.classList.add('active');
  document.querySelectorAll('.finding-card').forEach(function(card) {
    var sev = card.querySelector('.sev-badge-dark');
    var layer = card.querySelector('.layer-badge');
    var sevText = sev ? sev.textContent.trim().toLowerCase() : '';
    var layerText = layer ? layer.textContent.trim().toLowerCase() : '';
    var show = filter === 'all'
      || filter === sevText
      || filter === layerText;
    card.style.display = show ? '' : 'none';
  });
};

// â”€â”€ Severity donut chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-severity-donut');
  if (!canvas) return;
  var sevs = ['critical','high','medium','low','informational'];
  var data = sevs.map(function(s){ return COUNTS[s] || 0; });
  if (data.every(function(d){ return d === 0; })) return;
  new Chart(canvas, {
    type:'doughnut',
    data:{
      labels:['Critical','High','Medium','Low','Info'],
      datasets:[{
        data:data,
        backgroundColor:sevs.map(function(s){ return SEV_COLORS[s]; }),
        borderWidth:0, hoverOffset:4
      }]
    },
    options:merge(CHART_DEFAULTS, {
      cutout:'65%',
      plugins:{
        legend:{display:true, position:'right',
          labels:{color:'#a8b4d1',font:{family:'Inter,sans-serif',size:10},
            filter:function(item){ return data[item.index] > 0; }}}
      }
    })
  });
})();

// â”€â”€ Layer stacked bar chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-layer-bar');
  if (!canvas) return;
  var sevs = ['critical','high','medium','low','informational'];
  var layers = ['zap','custom','pentest'];
  var layerLabels = ['ZAP','Custom','Pentest'];
  var layerColors = ['#8b5cf6','#fb923c','#ec4899'];
  var datasets = layers.map(function(lyr, i){
    return {
      label: layerLabels[i],
      data: sevs.map(function(s){ return (LAYERS[lyr] && LAYERS[lyr][s]) || 0; }),
      backgroundColor: layerColors[i],
      borderRadius: 3,
    };
  });
  new Chart(canvas, {
    type:'bar',
    data:{ labels:['Crit','High','Med','Low','Info'], datasets:datasets },
    options:merge(CHART_DEFAULTS, {
      plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#a8b4d1', font:{ family:'Inter,sans-serif', size:10 }}}},
      scales:{
        x:{ stacked:true, grid:{ display:false }, ticks:{ font:TICK_FONT }},
        y:{ stacked:true, grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT, stepSize:1 }, beginAtZero:true }
      }
    })
  });
})();

// â”€â”€ Trend line chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-trend-line');
  if (!canvas) return;
  if (!HIST || !HIST.length) {
    canvas.parentElement.innerHTML = '<div class="no-data-msg">No historical scan data available.</div>';
    return;
  }
  var sevs = ['critical','high','medium','low'];
  var labels = HIST.map(function(h){ return h.date || ''; });
  var datasets = sevs.map(function(s){
    return {
      label: s.charAt(0).toUpperCase()+s.slice(1),
      data: HIST.map(function(h){ return h[s] || 0; }),
      borderColor: SEV_COLORS[s],
      backgroundColor: SEV_COLORS[s]+'22',
      tension:0.3, pointRadius:3, borderWidth:2, fill:false
    };
  });
  new Chart(canvas, {
    type:'line',
    data:{ labels:labels, datasets:datasets },
    options:merge(CHART_DEFAULTS, {
      plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#a8b4d1', font:{ family:'Inter,sans-serif', size:10 }}}},
      scales:{
        x:{ grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT }},
        y:{ grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT, stepSize:1 }, beginAtZero:true }
      }
    })
  });
})();

// â”€â”€ CVSS scatter chart â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-cvss-scatter');
  if (!canvas) return;
  var sevs = ['critical','high','medium','low','informational'];
  var datasets = sevs.map(function(s){
    var pts = FINDINGS.filter(function(f){ return (f.severity||'informational') === s && f.cvss > 0; });
    return {
      label: s,
      data: pts.map(function(f,i){ return { x: f.cvss, y: i + Math.random()*0.4 - 0.2 }; }),
      backgroundColor: SEV_COLORS[s]+'cc',
      pointRadius: 6, pointHoverRadius: 8
    };
  }).filter(function(ds){ return ds.data.length > 0; });
  if (!datasets.length) { canvas.parentElement.innerHTML = '<div class="no-data-msg">No CVSS data available.</div>'; return; }
  new Chart(canvas, {
    type:'scatter',
    data:{ datasets:datasets },
    options:merge(CHART_DEFAULTS, {
      plugins:{ legend:{ display:true, position:'right',
        labels:{ color:'#a8b4d1', font:{ family:'Inter,sans-serif', size:10 }}}},
      scales:{
        x:{ min:0, max:10, grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT },
          title:{ display:true, text:'CVSS Score', color:'#6b7a9e', font:{ size:10 }}},
        y:{ display:false }
      }
    })
  });
})();

// â”€â”€ Findings by OWASP (horizontal bar) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-findings-by-owasp');
  if (!canvas) return;
  var owaspDefs = [
    {id:'A01:2021',label:'A01 Broken Access Control',color:'#ff6b6b'},
    {id:'A02:2021',label:'A02 Crypto Failures',color:'#ffa726'},
    {id:'A03:2021',label:'A03 Injection',color:'#ffeb3b'},
    {id:'A04:2021',label:'A04 Insecure Design',color:'#66bb6a'},
    {id:'A05:2021',label:'A05 Security Misconfiguration',color:'#42a5f5'},
    {id:'A06:2021',label:'A06 Outdated Components',color:'#ab47bc'},
    {id:'A07:2021',label:'A07 Auth Failures',color:'#ec407a'},
    {id:'A08:2021',label:'A08 Integrity Failures',color:'#26c6da'},
    {id:'A09:2021',label:'A09 Logging Failures',color:'#ffa726'},
    {id:'A10:2021',label:'A10 SSRF',color:'#78909c'},
  ];
  var counts = owaspDefs.map(function(o){
    return FINDINGS.filter(function(f){
      return (f.owaspId||'').indexOf(o.id.split(':')[0]) !== -1;
    }).length;
  });
  new Chart(canvas, {
    type:'bar',
    data:{
      labels: owaspDefs.map(function(o){ return o.label; }),
      datasets:[{
        data:counts,
        backgroundColor:owaspDefs.map(function(o){ return o.color+'bb'; }),
        borderColor:owaspDefs.map(function(o){ return o.color; }),
        borderWidth:1, borderRadius:4
      }]
    },
    options:merge(CHART_DEFAULTS, {
      indexAxis:'y',
      scales:{
        x:{ grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT, stepSize:1 }, beginAtZero:true },
        y:{ grid:{ display:false }, ticks:{ font:{ family:'Inter,sans-serif', size:10, color:'#a8b4d1' }}}
      }
    })
  });
})();

// â”€â”€ Pentest coverage horizontal bar â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
(function(){
  var canvas = document.getElementById('chart-pentest-coverage');
  if (!canvas) return;
  if (!PT_COV || !PT_COV.some(function(p){ return p.endpoints > 0; })) {
    canvas.parentElement.innerHTML = '<div class="no-data-msg">No pentest coverage data.</div>'; return;
  }
  new Chart(canvas, {
    type:'bar',
    data:{
      labels: PT_COV.map(function(p){ return p.label; }),
      datasets:[
        { label:'Endpoints tested', data:PT_COV.map(function(p){ return p.endpoints; }), backgroundColor:'#8b5cf6aa', borderRadius:3 },
        { label:'Findings',         data:PT_COV.map(function(p){ return p.findings; }),  backgroundColor:'#ff3366aa', borderRadius:3 }
      ]
    },
    options:merge(CHART_DEFAULTS, {
      indexAxis:'y',
      plugins:{ legend:{ display:true, position:'top',
        labels:{ color:'#a8b4d1', font:{ family:'Inter,sans-serif', size:10 }}}},
      scales:{
        x:{ grid:{ color:GRID_COLOR }, ticks:{ font:TICK_FONT }, beginAtZero:true },
        y:{ grid:{ display:false }, ticks:{ font:{ family:'Inter,sans-serif', size:10, color:'#a8b4d1' }}}
      }
    })
  });
})();

// â”€â”€ Remediation tracker (tab-findings re-use for now) â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
// (Tracker is built dynamically via the finding cards' checkbox interaction)

})();
</script>
</body>
</html>`;
}

// â”€â”€â”€ Main Entry Point â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
function generateSecReport(findings, verdict, storyKey, outputDir, meta) {
  findings  = Array.isArray(findings) ? findings : [];
  verdict   = verdict || 'fail';
  storyKey  = storyKey || 'SEC-REPORT';
  outputDir = outputDir || 'custom-report/security';
  meta      = meta || {};

  const score = calculateSecurityScore(findings);

  // Load Chart.js inline
  const chartJsPath = path.join(ROOT, 'node_modules', 'chart.js', 'dist', 'chart.umd.js');
  let chartJsSrc = '';
  if (fs.existsSync(chartJsPath)) {
    chartJsSrc = fs.readFileSync(chartJsPath, 'utf8');
  } else {
    logger.warn('[generate-sec-report] Chart.js not found at node_modules/chart.js/dist/chart.umd.js â€” charts will not render');
    chartJsSrc = '/* Chart.js not found â€” run: npm install chart.js */';
  }

  const html = buildHtml({ findings, verdict, storyKey, meta, chartJsSrc, score });

  const absOutputDir = path.isAbsolute(outputDir) ? outputDir : path.join(ROOT, outputDir);
  fs.mkdirSync(absOutputDir, { recursive: true });
  const outFile = path.join(absOutputDir, 'index.html');
  fs.writeFileSync(outFile, html, 'utf8');

  const kb = Math.round(Buffer.byteLength(html, 'utf8') / 1024);
  logger.info(`[generate-sec-report] Report written â†’ ${outFile} (${kb} KB, ${findings.length} findings, score ${score})`);
  return outFile;
}

// â”€â”€â”€ CLI standalone â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€â”€
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
      logger.warn('[generate-sec-report] Could not parse sample-findings.json â€” using built-in sample data');
    }
  }

  if (!findings) {
    storyKey  = 'SCRUM-6';
    verdict   = 'fail';
    outputDir = 'custom-report/security';
    meta = {
      zapVersion: '2.14.0', scanType: 'full-active',
      targetUrl: 'https://opensource-demo.orangehrmlive.com',
      startTime: '2026-04-20T15:10:04Z', endTime: '2026-04-20T15:38:22Z',
      durationSeconds: 1698, spiderUrls: 148, passiveAlerts: 11, activeAlerts: 6,
      customChecksRun: 10, customChecksPassed: 3,
      jiraStoryUrl: 'https://yourorg.atlassian.net/browse/SCRUM-6',
      zephyrCycleUrl: 'https://yourorg.atlassian.net/jira/software/projects/SCRUM/boards',
      zapReportPath: 'test-results/security/SCRUM-6-zap-report.json',
      pentestTotalAttackVectors: 3847,
      pentestSuccessfulExploits: 89,
      pentestDurationMs: 2538000,
      historicalScans: [
        { date: '2026-01-15', critical: 4, high: 8, medium: 12, low: 18, info: 5 },
        { date: '2026-02-10', critical: 3, high: 7, medium: 10, low: 15, info: 4 },
        { date: '2026-03-05', critical: 3, high: 6, medium:  9, low: 14, info: 6 },
        { date: '2026-04-01', critical: 2, high: 5, medium:  8, low: 12, info: 3 },
        { date: '2026-04-20', critical: 2, high: 5, medium:  7, low: 10, info: 3 },
      ],
      pentestModules: [
        { name: 'apiFuzzing',     status: 'success', endpointsTested: 47, findings: [
            { id:'PT-001', name:'SQL Injection in /api/v2/employee/search', severity:'critical', cvss:9.8,
              owaspId:'A03:2021', owaspName:'Injection', source:'pentest', pentestModule:'apiFuzzing',
              description:'Parameterised query not used in employee search endpoint. Raw string concatenation allows full DB extraction.',
              evidence:"GET /api/v2/employee/search?name=' OR 1=1--\nHTTP/1.1 200 OK\n[... all 487 employees returned ...]",
              url:'/api/v2/employee/search', cwe:'CWE-89', cweName:'SQL Injection',
              cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H',
              steps:['Replace string concatenation with parameterised queries / PreparedStatement.','Add input validation layer rejecting SQL metacharacters.','Enable ORM query logging to detect raw SQL.'],
              attackVector:{ technique:'SQL Injection', payload:"' OR 1=1--" },
              remediation:{ priority:'P0', effortEstimate:2, shortTermFix:'Add input sanitisation on name parameter.', permanentFix:'Migrate to ORM parameterised queries.',
                codeExample:{ vulnerable:"db.query(\"SELECT * FROM employee WHERE name='\" + name + \"'\")",
                  secure:"db.prepare('SELECT * FROM employee WHERE name = ?').execute(name)" }},
              status:'new', jiraBug:'SCRUM-210', references:[{label:'OWASP A03:2021',url:'https://owasp.org/Top10/A03_2021-Injection/'}] },
          ],
          attackVectorsApplied:['SQL Injection','NoSQL Injection','XPath Injection','LDAP Injection','OS Command Injection'], durationMs: 402000 },
        { name: 'authBypass',     status: 'success', endpointsTested: 12, findings: [], attackVectorsApplied:['JWT alg:none','Token forging','Forced browse'], durationMs: 198000 },
        { name: 'idorDetection',  status: 'partial', endpointsTested: 23, findings: [], attackVectorsApplied:['Integer ID enumeration','UUID prediction','Parameter pollution'], durationMs: 310000 },
        { name: 'rateLimiting',   status: 'success', endpointsTested:  8, findings: [], attackVectorsApplied:['Burst requests','IP rotation'], durationMs: 187000 },
        { name: 'sessionMgmt',    status: 'success', endpointsTested: 15, findings: [], attackVectorsApplied:['Session fixation','Cookie theft','Token reuse after logout'], durationMs: 290000 },
        { name: 'cryptoWeakness', status: 'success', endpointsTested:  6, findings: [], attackVectorsApplied:['Weak cipher detection','MD5/SHA1 usage check','Key length analysis'], durationMs: 89000 },
        { name: 'fileUpload',     status: 'not-run', endpointsTested:  0, findings: [], attackVectorsApplied:[], durationMs: 0 },
      ],
    };
    findings = [
      { id:'SEC-001', source:'custom', name:'IDOR â€” employee ID enumerable', severity:'critical', cvss:9.8,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H', cwe:'CWE-639',
        cweName:'Authorization Bypass Through User-Controlled Key',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'The employee API accepts sequential integer resource IDs with no ownership validation, allowing any authenticated user to read any employee record.',
        evidence:'GET /web/index.php/api/v2/employee/2 HTTP/1.1\nAuthorization: Bearer <attacker-token>\n\nHTTP/1.1 200 OK\n{"firstName":"Jane","salary":75000,"ssn":"123-45-6789"}',
        url:'/web/index.php/api/v2/employee/{id}',
        solution:'Add ownership check in the employee API controller.',
        steps:[
          'Verify the requesting user owns the employee record or holds HR_ADMIN role before returning data.',
          'Replace sequential integer IDs with UUID v4 in the public-facing API.',
          'Add an integration test asserting HTTP 403 when Employee A requests Employee B\'s record.',
          'Enable audit logging for all 403 responses and alert on > 5 consecutive 403s from one session.',
        ],
        references:[{label:'OWASP A01:2021',url:'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'},{label:'CWE-639',url:'https://cwe.mitre.org/data/definitions/639.html'}],
        jiraBug:'SCRUM-201', status:'new' },
      { id:'SEC-002', source:'custom', name:'CSRF token absent on state-changing forms', severity:'high', cvss:8.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:U/C:H/I:H/A:N', cwe:'CWE-352', cweName:'Cross-Site Request Forgery',
        owaspId:'A01:2021', owaspName:'Broken Access Control',
        description:'State-changing forms do not include a CSRF synchroniser token, enabling cross-site request forgery attacks.',
        evidence:'GET /web/index.php/pim/addEmployee -> 200\ngrep csrf response.html -> no match',
        url:'/web/index.php/pim/addEmployee',
        solution:'Generate a per-session CSRF token and validate it on every state-changing endpoint.',
        steps:[
          'Generate a cryptographically random CSRF token per session (min 128 bits).',
          'Embed the token in every form as a hidden field and in AJAX headers.',
          'Validate the token server-side on all POST/PUT/DELETE requests; return HTTP 403 if absent or mismatched.',
        ],
        references:[{label:'OWASP A01:2021',url:'https://owasp.org/Top10/A01_2021-Broken_Access_Control/'},{label:'CSRF Prevention Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Cross-Site_Request_Forgery_Prevention_Cheat_Sheet.html'}],
        jiraBug:'SCRUM-202', status:'recurring' },
      { id:'SEC-003', source:'custom', name:'No brute-force lockout on login endpoint', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-307',
        cweName:'Improper Restriction of Excessive Authentication Attempts',
        owaspId:'A07:2021', owaspName:'Identification and Authentication Failures',
        description:'The login endpoint accepts unlimited credential-guessing attempts with no lockout or rate limiting.',
        evidence:'POST /auth/validateCredentials {wrong_password} x5\nAll 5: HTTP 200 {success:false}\nNo 429 / no Retry-After header observed',
        url:'/web/index.php/auth/validateCredentials',
        solution:'Implement progressive account lockout and IP-level rate limiting.',
        steps:[
          'Lock account after 5 failed attempts and return HTTP 429 with Retry-After header.',
          'Add IP-level rate limiting: max 10 login requests/minute per IP.',
          'Log all failed attempts and alert when > 20 failures/minute from one IP.',
        ],
        references:[{label:'OWASP A07:2021',url:'https://owasp.org/Top10/A07_2021-Identification_and_Authentication_Failures/'},{label:'CWE-307',url:'https://cwe.mitre.org/data/definitions/307.html'}],
        jiraBug:'SCRUM-203', status:'new' },
      { id:'SEC-004', source:'custom', name:'Sensitive data exposed in API response', severity:'high', cvss:7.5,
        cvssVector:'AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N', cwe:'CWE-200',
        cweName:'Exposure of Sensitive Information to an Unauthorized Actor',
        owaspId:'A02:2021', owaspName:'Cryptographic Failures',
        description:'Employee search API returns salary and internal tokens to any authenticated user regardless of their access level.',
        evidence:'GET /api/v2/employee/search?name=Admin\nHTTP 200: {"salary":85000,"internalToken":"abc123","ssn":"555-12-3456"}',
        url:'/web/index.php/api/v2/employee/search',
        solution:'Remove sensitive fields from API responses and apply field-level access control.',
        steps:[
          'Define an API response schema â€” strip all unlisted fields server-side before serialising.',
          'Apply RBAC: only HR_ADMIN role may request salary data via a separate audited endpoint.',
          'Add CI response-body scanner that flags salary/token patterns in non-admin test responses.',
        ],
        references:[{label:'OWASP A02:2021',url:'https://owasp.org/Top10/A02_2021-Cryptographic_Failures/'},{label:'CWE-200',url:'https://cwe.mitre.org/data/definitions/200.html'}],
        jiraBug:'SCRUM-204', status:'new' },
      { id:'SEC-005', source:'zap', name:'Missing Content-Security-Policy header', severity:'medium', cvss:6.1,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'No Content-Security-Policy header is present on any application page, increasing XSS and clickjacking risk.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no Content-Security-Policy header in response)',
        url:'All application pages',
        solution:'Add Content-Security-Policy header to the web server configuration.',
        steps:[
          'Add to nginx: add_header Content-Security-Policy "default-src \'self\'" always',
          'Deploy in report-only mode first to identify violations before enforcing.',
          'Progressively tighten â€” remove unsafe-inline by migrating to nonce-based scripts.',
        ],
        references:[{label:'OWASP A05:2021',url:'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/'},{label:'CSP Cheat Sheet',url:'https://cheatsheetseries.owasp.org/cheatsheets/Content_Security_Policy_Cheat_Sheet.html'}],
        jiraBug:null, status:'new' },
      { id:'SEC-006', source:'zap', name:'X-Frame-Options header missing', severity:'medium', cvss:5.4,
        cvssVector:'AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:N/A:N', cwe:'CWE-1021',
        cweName:'Improper Restriction of Rendered UI Layers or Frames',
        owaspId:'A05:2021', owaspName:'Security Misconfiguration',
        description:'The application does not set X-Frame-Options, making it susceptible to clickjacking attacks.',
        evidence:'GET / HTTP/1.1\nHTTP/1.1 200 OK\n(no X-Frame-Options header)',
        url:'All application pages',
        solution:'Set X-Frame-Options: DENY or SAMEORIGIN on all responses.',
        steps:['Add to nginx: add_header X-Frame-Options SAMEORIGIN always;','Alternatively use CSP frame-ancestors directive.'],
        references:[{label:'OWASP A05:2021',url:'https://owasp.org/Top10/A05_2021-Security_Misconfiguration/'}],
        jiraBug:null, status:'new' },
      { id:'SEC-007', source:'zap', name:'Cookies without Secure/HttpOnly flags', severity:'low', cvss:4.3,
        cvssVector:'AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:L/A:N', cwe:'CWE-614',
        cweName:'Sensitive Cookie in HTTPS Session Without Secure Attribute',
        owaspId:'A07:2021', owaspName:'Identification and Authentication Failures',
        description:'Session cookies do not have Secure and HttpOnly flags set, exposing them to theft via JS or plain-HTTP interception.',
        evidence:'Set-Cookie: PHPSESSID=abc123; Path=/ (missing Secure; HttpOnly)',
        url:'/web/index.php/auth/validate',
        solution:'Set Secure and HttpOnly flags on all session cookies.',
        steps:['Update PHP session config: session.cookie_secure=1, session.cookie_httponly=1.','Add SameSite=Strict to prevent CSRF via cookie.'],
        references:[{label:'CWE-614',url:'https://cwe.mitre.org/data/definitions/614.html'}],
        jiraBug:null, status:'new' },
      { id:'PT-001', source:'pentest', name:'SQL Injection in /api/v2/employee/search', severity:'critical', cvss:9.8,
        cvssVector:'AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H', cwe:'CWE-89', cweName:'SQL Injection',
        owaspId:'A03:2021', owaspName:'Injection',
        pentestModule:'apiFuzzing',
        description:'Parameterised query not used in employee search endpoint. Raw string concatenation allows full DB extraction.',
        evidence:"GET /api/v2/employee/search?name=' OR 1=1--\nHTTP/1.1 200 OK\n[... all 487 employees returned ...]",
        url:'/api/v2/employee/search',
        solution:'Use parameterised queries.',
        steps:['Replace string concatenation with PreparedStatement.','Add WAF rule blocking SQL metacharacters in search parameters.'],
        attackVector:{ technique:'SQL Injection', payload:"' OR 1=1--", steps:["Send payload in name query param","Observe all records returned"] },
        impact:{ businessRisk:'Full employee database exfiltration', affectedUsers:487, dataAtRisk:['salary','SSN','contact details'] },
        remediation:{ priority:'P0', effortEstimate:2, shortTermFix:'Add input sanitisation on name parameter.', permanentFix:'Migrate to ORM parameterised queries.',
          codeExample:{ vulnerable:"db.query(\"SELECT * FROM employee WHERE name='\" + name + \"'\")",
            secure:"db.prepare('SELECT * FROM employee WHERE name = ?').execute(name)" }},
        references:[{label:'OWASP A03:2021',url:'https://owasp.org/Top10/A03_2021-Injection/'}],
        jiraBug:'SCRUM-210', status:'new' },
    ];
  }

  generateSecReport(findings, verdict, storyKey, outputDir, meta);
}

module.exports = { generateSecReport };
