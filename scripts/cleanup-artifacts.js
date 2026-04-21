#!/usr/bin/env node
'use strict';
/**
 * cleanup-artifacts.js — Delete old run artifacts (screenshots, videos, traces,
 * reports, allure-results) whose mtime is older than ARTIFACT_RETENTION_DAYS.
 *
 * Usage:
 *   node scripts/cleanup-artifacts.js               # live run
 *   node scripts/cleanup-artifacts.js --dry-run     # list candidates, delete nothing
 *   node scripts/cleanup-artifacts.js --aggressive  # retention / 2
 *
 * Preserves:
 *   • logs/ directory (managed separately by logger rotation)
 *   • Any file named .gitkeep
 *
 * Writes a JSON summary to logs/cleanup-report.json (rolling last 100 runs).
 */
const fs   = require('fs');
const path = require('path');

const ROOT = path.resolve(__dirname, '..');
const args = new Set(process.argv.slice(2));
const DRY  = args.has('--dry-run');
let RETENTION_DAYS = parseInt(process.env.ARTIFACT_RETENTION_DAYS || '30', 10);
if (args.has('--aggressive')) RETENTION_DAYS = Math.max(1, Math.floor(RETENTION_DAYS / 2));

const TARGETS = [
  'test-results',
  'playwright-report',
  'allure-results',
  'allure-report',
  'custom-report',
  'screenshots',
  'heal-artifacts',
];

const PRESERVE_NAMES = new Set(['.gitkeep']);

const cutoff = Date.now() - (RETENTION_DAYS * 86_400_000);
let scanned = 0, deleted = 0, bytesFreed = 0;
const candidates = [];

function walk(dir) {
  let entries;
  try { entries = fs.readdirSync(dir, { withFileTypes: true }); }
  catch (_e) { return; }

  for (const e of entries) {
    if (PRESERVE_NAMES.has(e.name)) continue;
    const full = path.join(dir, e.name);
    if (e.isDirectory()) {
      walk(full);
      // Remove empty directory if now empty AND old.
      try {
        const remaining = fs.readdirSync(full);
        if (remaining.length === 0) {
          const st = fs.statSync(full);
          if (st.mtimeMs < cutoff) {
            if (!DRY) fs.rmdirSync(full);
            deleted++;
          }
        }
      } catch (_e) {}
    } else if (e.isFile()) {
      scanned++;
      let st;
      try { st = fs.statSync(full); } catch (_e) { continue; }
      if (st.mtimeMs >= cutoff) continue;
      candidates.push({ path: path.relative(ROOT, full), sizeBytes: st.size, mtime: new Date(st.mtimeMs).toISOString() });
      if (!DRY) {
        try { fs.unlinkSync(full); deleted++; bytesFreed += st.size; }
        catch (_e) {}
      } else {
        deleted++; bytesFreed += st.size;
      }
    }
  }
}

for (const t of TARGETS) {
  const dir = path.join(ROOT, t);
  if (fs.existsSync(dir)) walk(dir);
}

// ── Report ─────────────────────────────────────────────────────────────
const summary = {
  timestamp: new Date().toISOString(),
  dryRun: DRY,
  retentionDays: RETENTION_DAYS,
  scannedFiles: scanned,
  removedFiles: deleted,
  bytesFreed,
  sampleCandidates: candidates.slice(0, 25),
};

const logsDir = path.join(ROOT, 'logs');
if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
const reportPath = path.join(logsDir, 'cleanup-report.json');

let history = [];
try {
  if (fs.existsSync(reportPath)) {
    const parsed = JSON.parse(fs.readFileSync(reportPath, 'utf8'));
    if (Array.isArray(parsed)) history = parsed;
  }
} catch (_e) {}
history.push(summary);
if (history.length > 100) history = history.slice(-100);
fs.writeFileSync(reportPath, JSON.stringify(history, null, 2));

const prefix = DRY ? '[DRY-RUN] ' : '';
console.log(
  `${prefix}cleanup-artifacts: scanned=${scanned} ${DRY ? 'would-remove' : 'removed'}=${deleted} ` +
  `freed=${(bytesFreed/1024/1024).toFixed(2)}MB retention=${RETENTION_DAYS}d`
);
process.exit(0);
