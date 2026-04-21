'use strict';
/**
 * classify-changes.js
 * Stage 1 — Smart Proactive Healing
 *
 * Reads git diff, classifies every changed file as frontend / backend / config,
 * maps files to Page Object names, extracts changed API routes and validation
 * constraints from diff text.
 *
 * Output → heal-artifacts/change-manifest.json
 */

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const RULES = [
  { type: 'frontend', pattern: /\.(html?|vue|jsx?|tsx?|css|scss|less)$/i },
  { type: 'frontend', pattern: /src[\\/](components|views|pages|ui)/i },
  { type: 'frontend', pattern: /tests[\\/]pages[\\/]\w+\.(yml|js)$/ },
  { type: 'backend',  pattern: /src[\\/](api|routes|controllers|middleware)/i },
  { type: 'backend',  pattern: /src[\\/](services|models|db|migrations)/i },
  { type: 'backend',  pattern: /openapi|swagger|graphql|schema\.json/i },
  { type: 'config',   pattern: /src[\\/](config|validation|rules|constants)/i },
  { type: 'config',   pattern: /feature.?flags?/i },
  { type: 'config',   pattern: /\.(env|env\.example)$/i },
];

const FILE_TO_PAGE = [
  { pattern: /auth|login/i,                page: 'LoginPage'        },
  { pattern: /addEmployee|pim[\\/]add/i,   page: 'AddEmployeePage'  },
  { pattern: /employeeList|viewEmployee/i, page: 'EmployeeListPage' },
  { pattern: /LoginPage\.(yml|js)/,        page: 'LoginPage'        },
  { pattern: /AddEmployeePage\.(yml|js)/,  page: 'AddEmployeePage'  },
  { pattern: /EmployeeListPage\.(yml|js)/, page: 'EmployeeListPage' },
];

const ALL_PAGES    = ['LoginPage', 'AddEmployeePage', 'EmployeeListPage'];
const ARTIFACT_DIR = path.join(process.cwd(), 'heal-artifacts');

function log(msg) { process.stdout.write(`[classify-changes] ${msg}\n`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function getChangedFiles() {
  let diff = '';
  try {
    diff = process.env.GITHUB_BASE_REF
      ? execSync(`git diff --name-only origin/${process.env.GITHUB_BASE_REF}...HEAD`, { encoding: 'utf8' })
      : execSync('git diff --name-only HEAD~1 HEAD', { encoding: 'utf8' });
  } catch {
    try {
      diff = execSync('git status --porcelain', { encoding: 'utf8' })
        .split('\n').map(l => l.slice(3)).join('\n');
    } catch { diff = ''; }
  }
  return diff.split('\n').map(f => f.trim()).filter(Boolean);
}

function getFileDiff(file) {
  try {
    return process.env.GITHUB_BASE_REF
      ? execSync(`git diff origin/${process.env.GITHUB_BASE_REF}...HEAD -- "${file}"`, { encoding: 'utf8' })
      : execSync(`git diff HEAD~1 HEAD -- "${file}"`, { encoding: 'utf8' });
  } catch { return ''; }
}

function classifyFile(file) {
  return [...new Set(RULES.filter(r => r.pattern.test(file)).map(r => r.type))];
}

function resolvePages(changedFiles) {
  const pages = new Set();
  for (const file of changedFiles) {
    FILE_TO_PAGE.forEach(({ pattern, page }) => { if (pattern.test(file)) pages.add(page); });
  }
  if (pages.size === 0 && changedFiles.some(f => classifyFile(f).includes('frontend'))) {
    ALL_PAGES.forEach(p => pages.add(p));
  }
  return [...pages];
}

function extractApiEndpoints(changedFiles) {
  const endpoints = new Set();
  const re = /(?:router|app)\.(get|post|put|patch|delete)\s*\(\s*['"`]([^'"`]+)['"`]/gi;
  for (const file of changedFiles) {
    if (!classifyFile(file).includes('backend')) continue;
    let m; const diff = getFileDiff(file);
    while ((m = re.exec(diff)) !== null) endpoints.add(`${m[1].toUpperCase()} ${m[2]}`);
  }
  return [...endpoints];
}

function extractValidationChanges(changedFiles) {
  const changes = [];
  const re = /[-+]\s*.*(maxLength|minLength|min|max|required|pattern|enum|default)\s*[:=]\s*([^\s,;]+)/gi;
  for (const file of changedFiles) {
    if (!classifyFile(file).includes('config')) continue;
    const diff = getFileDiff(file);
    for (const line of diff.split('\n')) {
      if (!line.startsWith('+') && !line.startsWith('-')) continue;
      re.lastIndex = 0;
      const m = re.exec(line);
      if (m) changes.push({
        file, rawLine: line.trim(),
        changeType: line.startsWith('+') ? 'added' : 'removed',
        constraint: m[1], value: m[2].replace(/[,;'"]/g, ''),
      });
    }
  }
  return changes;
}

function main() {
  ensureDir(ARTIFACT_DIR);
  const changedFiles = getChangedFiles();
  log(`Changed files (${changedFiles.length}): ${changedFiles.slice(0, 6).join(', ')}${changedFiles.length > 6 ? '…' : ''}`);

  const byType = { frontend: [], backend: [], config: [] };
  changedFiles.forEach(f => classifyFile(f).forEach(t => { if (byType[t]) byType[t].push(f); }));

  let issueKey = process.env.ISSUE_KEY || '';
  try {
    const sp = path.join(process.cwd(), 'scope.json');
    if (fs.existsSync(sp)) issueKey = JSON.parse(fs.readFileSync(sp, 'utf8')).issueKey || issueKey;
  } catch {}

  const manifest = {
    generatedAt:          new Date().toISOString(),
    issueKey:             issueKey || null,
    changedFiles,
    changeTypes: {
      hasFrontend: byType.frontend.length > 0,
      hasBackend:  byType.backend.length  > 0,
      hasConfig:   byType.config.length   > 0,
    },
    filesByType:          byType,
    affectedPages:        resolvePages(changedFiles),
    changedApiEndpoints:  extractApiEndpoints(changedFiles),
    validationChanges:    extractValidationChanges(changedFiles),
  };

  const out = path.join(ARTIFACT_DIR, 'change-manifest.json');
  fs.writeFileSync(out, JSON.stringify(manifest, null, 2));
  log(`Frontend: ${byType.frontend.length} files → pages: ${manifest.affectedPages.join(', ') || 'none'}`);
  log(`Backend:  ${byType.backend.length} files → endpoints: ${manifest.changedApiEndpoints.length}`);
  log(`Config:   ${byType.config.length} files → constraints: ${manifest.validationChanges.length}`);
  log(`Manifest → ${out}`);
}

main();
