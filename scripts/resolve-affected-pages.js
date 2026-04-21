'use strict';
/**
 * resolve-affected-pages.js
 * Stage 1b — Smart Proactive Healing
 *
 * Maps changed source files to Page Object names and spec files.
 * Output → heal-artifacts/affected-pages.json
 */

const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');

const FILE_TO_PAGE_MAP = [
  { pattern: /auth|login/i,                page: 'LoginPage'        },
  { pattern: /addEmployee|pim[\\/]add/i,   page: 'AddEmployeePage'  },
  { pattern: /employeeList|viewEmployee/i, page: 'EmployeeListPage' },
  { pattern: /LoginPage\.(yml|js)/,        page: 'LoginPage'        },
  { pattern: /AddEmployeePage\.(yml|js)/,  page: 'AddEmployeePage'  },
  { pattern: /EmployeeListPage\.(yml|js)/, page: 'EmployeeListPage' },
  { pattern: /tests[\\/]fixtures/,         page: '__ALL__'          },
  { pattern: /playwright\.config/,         page: '__ALL__'          },
];

const ALL_PAGES    = ['LoginPage', 'AddEmployeePage', 'EmployeeListPage'];
const SPECS_DIR    = path.join(process.cwd(), 'tests', 'specs');
const ARTIFACT_DIR = path.join(process.cwd(), 'heal-artifacts');

function log(msg) { process.stdout.write(`[resolve-affected-pages] ${msg}\n`); }
function ensureDir(d) { if (!fs.existsSync(d)) fs.mkdirSync(d, { recursive: true }); }

function getChangedFiles() {
  try {
    const cmd = process.env.GITHUB_BASE_REF
      ? `git diff --name-only origin/${process.env.GITHUB_BASE_REF}...HEAD`
      : 'git diff --name-only HEAD~1 HEAD';
    return execSync(cmd, { encoding: 'utf8' }).split('\n').map(f => f.trim()).filter(Boolean);
  } catch { return []; }
}

function resolveAffectedPages(changedFiles) {
  const pages = new Set();
  for (const file of changedFiles) {
    for (const { pattern, page } of FILE_TO_PAGE_MAP) {
      if (pattern.test(file)) {
        if (page === '__ALL__') ALL_PAGES.forEach(p => pages.add(p));
        else pages.add(page);
      }
    }
  }
  return [...pages];
}

function resolveSpecFiles(pages, issueKey) {
  const specs = [];
  if (!fs.existsSync(SPECS_DIR)) return specs;
  const allSpecs = fs.readdirSync(SPECS_DIR).filter(f => f.endsWith('.spec.js'));
  for (const page of pages) {
    const key = page.replace('Page', '').toLowerCase();
    allSpecs.filter(f => f.toLowerCase().includes(key) || (issueKey && f.toLowerCase().includes(issueKey.toLowerCase())))
      .forEach(f => { const fp = path.join(SPECS_DIR, f); if (!specs.includes(fp)) specs.push(fp); });
  }
  return specs;
}

function main() {
  ensureDir(ARTIFACT_DIR);
  let issueKey = process.env.ISSUE_KEY || '';
  try {
    const sp = path.join(process.cwd(), 'scope.json');
    if (fs.existsSync(sp)) issueKey = JSON.parse(fs.readFileSync(sp, 'utf8')).issueKey || issueKey;
  } catch {}

  const changedFiles = getChangedFiles();
  const pages        = resolveAffectedPages(changedFiles);
  const specFiles    = resolveSpecFiles(pages, issueKey);

  log(`Changed: ${changedFiles.length} files`);
  log(`Pages:   ${pages.join(', ') || 'none'}`);
  log(`Specs:   ${specFiles.length}`);

  const out = path.join(ARTIFACT_DIR, 'affected-pages.json');
  fs.writeFileSync(out, JSON.stringify({ resolvedAt: new Date().toISOString(), issueKey: issueKey || null, changedFiles, pages, specFiles }, null, 2));
  log(`Written → ${out}`);
}

main();
