'use strict';
/**
 * git-sync.js  —  Git Agent: Auto-commit + push all pipeline changes
 * ─────────────────────────────────────────────────────────────────────────────
 * Stages all modified/new files (specs, test results, reports, screenshots),
 * commits with an auto-generated message, and pushes to the current branch.
 *
 * Commit message format:
 *   chore(qa-pipeline): auto-run <ISSUE_KEY> — <pass>/<total> passed — <timestamp>
 *
 * Safety:
 *   • Checks for a valid git repo before proceeding
 *   • Skips commit if working tree is clean (nothing to push)
 *   • Uses --no-verify to avoid pre-commit hooks blocking CI pipelines
 *   • softFail-safe — exits 0 on push failure so the pipeline is not halted
 *
 * Usage:
 *   node scripts/git-sync.js                   ← auto-commit + push
 *   node scripts/git-sync.js --skip-push       ← commit only, do not push
 *   node scripts/git-sync.js --dry-run         ← show what would be committed
 *
 * All configuration is read from .env  (ISSUE_KEY)
 * ─────────────────────────────────────────────────────────────────────────────
 */

require('dotenv').config();
const { execSync } = require('child_process');
const fs           = require('fs');
const path         = require('path');
const os           = require('os');

const ROOT      = path.resolve(__dirname, '..');
const ISSUE_KEY = process.env.ISSUE_KEY || 'UNKNOWN';
const args      = process.argv.slice(2);
const flags     = new Set(args.map(a => a.toLowerCase()));
const skipPush  = flags.has('--skip-push');
const dryRun    = flags.has('--dry-run');

// ─── ANSI ──────────────────────────────────────────────────────────────────
const C = {
  reset:  '\x1b[0m', bold:  '\x1b[1m', dim:   '\x1b[2m',
  green:  '\x1b[32m', yellow: '\x1b[33m', red: '\x1b[31m',
  cyan:   '\x1b[36m', white:  '\x1b[97m',
};

function run(cmd, opts = {}) {
  return execSync(cmd, { cwd: ROOT, encoding: 'utf8', stdio: 'pipe', ...opts }).trim();
}

function log(msg) { console.log(`  ${msg}`); }

// ─── Build commit message from test-results.json (if available) ────────────
function buildCommitMessage() {
  const ts = new Date().toISOString().slice(0, 19).replace('T', ' ');
  let stats = '';

  const resultsFile = path.join(ROOT, 'test-results.json');
  if (fs.existsSync(resultsFile)) {
    try {
      const raw = JSON.parse(fs.readFileSync(resultsFile, 'utf8'));
      const suites = raw.suites || [];
      let passed = 0, total = 0;
      (function walk(arr) {
        for (const s of arr) {
          if (s.suites) walk(s.suites);
          for (const spec of (s.specs || [])) {
            total++;
            if (spec.ok) passed++;
          }
        }
      })(suites);
      stats = ` -- ${passed}/${total} passed`;
    } catch { /* ignore parse errors */ }
  }

  return `chore(qa-pipeline): auto-run ${ISSUE_KEY}${stats} -- ${ts}`;
}

// ─── Main ──────────────────────────────────────────────────────────────────
async function main() {
  console.log(`\n${C.bold}${C.cyan}┌── Git Agent ─ Auto-Commit + Push ${'─'.repeat(28)}${C.reset}`);
  console.log(`${C.bold}│${C.reset}  Issue : ${ISSUE_KEY}`);
  console.log(`${C.bold}│${C.reset}  Mode  : ${dryRun ? 'DRY-RUN (no changes)' : skipPush ? 'Commit only (no push)' : 'Commit + Push'}`);
  console.log(`${C.bold}${C.cyan}└${'─'.repeat(62)}${C.reset}\n`);

  // ── Verify git repo ──────────────────────────────────────────────────────
  try {
    run('git rev-parse --is-inside-work-tree');
  } catch {
    console.error(`  ${C.red}Not a git repository — skipping git sync.${C.reset}\n`);
    process.exit(0);
  }

  // ── Get current branch ───────────────────────────────────────────────────
  let branch;
  try {
    branch = run('git rev-parse --abbrev-ref HEAD');
  } catch {
    branch = '(detached)';
  }
  log(`${C.dim}Branch : ${branch}${C.reset}`);

  // ── Stage all changes ────────────────────────────────────────────────────
  log(`${C.dim}Staging all changes...${C.reset}`);
  if (!dryRun) {
    run('git add -A');
  }

  // ── Check if there's anything to commit ──────────────────────────────────
  const status = run('git status --porcelain');
  if (!status) {
    log(`${C.green}Working tree clean — nothing to commit.${C.reset}\n`);
    process.exit(0);
  }

  // Show what will be committed
  const changedFiles = status.split('\n').filter(Boolean);
  log(`${C.bold}${changedFiles.length} file(s) staged:${C.reset}`);
  for (const f of changedFiles.slice(0, 20)) {
    log(`  ${C.dim}${f}${C.reset}`);
  }
  if (changedFiles.length > 20) {
    log(`  ${C.dim}... and ${changedFiles.length - 20} more${C.reset}`);
  }

  if (dryRun) {
    log(`\n${C.yellow}DRY-RUN — no commit or push performed.${C.reset}\n`);
    process.exit(0);
  }

  // ── Commit ───────────────────────────────────────────────────────────────
  const msg = buildCommitMessage();
  log(`\n${C.dim}Committing: ${msg}${C.reset}`);
  // Write commit message to a temp file to avoid shell encoding issues (em-dash, etc.)
  const tmpMsg = path.join(os.tmpdir(), `git-commit-msg-${Date.now()}.txt`);
  try {
    fs.writeFileSync(tmpMsg, msg, 'utf8');
    run(`git commit -F "${tmpMsg}" --no-verify`);
    log(`${C.green}✓ Committed successfully.${C.reset}`);
  } catch (err) {
    console.error(`  ${C.red}Commit failed: ${err.message}${C.reset}\n`);
    process.exit(1);
  } finally {
    try { fs.unlinkSync(tmpMsg); } catch { /* ignore */ }
  }

  // ── Push ─────────────────────────────────────────────────────────────────
  if (skipPush) {
    log(`${C.yellow}↷ Push skipped (--skip-push).${C.reset}\n`);
    process.exit(0);
  }

  log(`${C.dim}Pushing to origin/${branch}...${C.reset}`);
  try {
    run(`git push origin ${branch}`);
    log(`${C.green}✓ Pushed to origin/${branch}.${C.reset}\n`);
  } catch (err) {
    // Non-fatal — pipeline should not fail because of push issues
    console.error(`  ${C.yellow}⚠ Push failed (non-fatal): ${err.message}${C.reset}`);
    log(`${C.yellow}Commit was saved locally. Push manually with: git push${C.reset}\n`);
    process.exit(0);  // softFail
  }
}

main().catch(err => {
  console.error(`\n${C.red}  FATAL: ${err.message}${C.reset}\n`);
  process.exit(1);
});
