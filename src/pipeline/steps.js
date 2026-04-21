'use strict';
/**
 * pipeline/steps.js — Named async steps for the Agentic QA pipeline.
 *
 * Each step is an async function with the signature:
 *     async function step(ctx): Promise<ctx>
 *
 * `ctx` is a shared context object carrying inputs/outputs between steps:
 *   {
 *     flags:       { headless, force, includePerf, includeSecurity,
 *                    skipHeal, skipSmartHeal, skipBugs, skipGit },
 *     env:         { ...process.env overrides per step },
 *     issueKey:    'SCRUM-6',
 *     results:     { [stepName]: { status, ms, exitCode, logFile? } },
 *     artifacts:   { specsGenerated: number, ... },
 *   }
 *
 * Steps MAY throw AppError subclasses — the runner handles classification.
 * Steps MUST NOT call process.exit.
 */

const path     = require('path');
const fs       = require('fs');
const readline = require('readline');
const { spawn }= require('child_process');
const logger   = require('../utils/logger');
const {
  AppError, TimeoutError, NonZeroExitError, SpawnError, PreconditionError
} = require('../core/errorHandler');

const ROOT = path.resolve(__dirname, '..', '..');

// ─── Spawn helper (async, non-blocking, streamed output) ──────────────────
/**
 * Run a Node script and resolve with { exitCode, durationMs, logFile }.
 * Rejects with a classified AppError for: timeout | spawn-failure | non-zero exit.
 */
function runNodeScript(relPath, { extraEnv = {}, timeoutMs = 0, label = '' } = {}) {
  return new Promise((resolve, reject) => {
    const abs = path.join(ROOT, relPath);
    if (!fs.existsSync(abs)) {
      return reject(new PreconditionError(`Pipeline script missing: ${relPath}`, {
        recoveryHint: `Restore or generate ${relPath}.`
      }));
    }

    const logsDir = path.join(ROOT, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const logFile   = path.join(logsDir, `${path.basename(relPath, '.js')}-${Date.now()}.log`);
    const logStream = fs.createWriteStream(logFile, { flags: 'a' });

    const started = Date.now();
    let timedOut  = false;
    const child = spawn('node', [abs], {
      cwd: ROOT,
      env: { ...process.env, ...extraEnv },
      stdio: ['ignore', 'pipe', 'pipe']
    });

    const timer = timeoutMs > 0
      ? setTimeout(() => { timedOut = true; try { child.kill('SIGTERM'); } catch (_) {} }, timeoutMs)
      : null;

    const prefix = label ? `[${label}] ` : '';
    readline.createInterface({ input: child.stdout })
      .on('line', l => { process.stdout.write(`${prefix}${l}\n`); logStream.write(l + '\n'); });
    readline.createInterface({ input: child.stderr })
      .on('line', l => { process.stderr.write(`${prefix}${l}\n`); logStream.write(l + '\n'); });

    child.on('error', (err) => {
      if (timer) clearTimeout(timer);
      logStream.end();
      reject(new SpawnError(`Failed to spawn ${relPath}: ${err.message}`, {
        details: { spawnCode: err.code, logFile }
      }));
    });

    child.on('close', (code, signal) => {
      if (timer) clearTimeout(timer);
      logStream.end();
      const durationMs = Date.now() - started;

      if (timedOut) {
        return reject(new TimeoutError(`Step exceeded ${timeoutMs}ms: ${relPath}`, {
          details: { exitCode: code, signal, logFile, durationMs }
        }));
      }
      if (code === 0) return resolve({ exitCode: 0, durationMs, logFile });

      return reject(new NonZeroExitError(`${relPath} exited with code ${code}`, {
        details: { exitCode: code, signal, logFile, durationMs }
      }));
    });
  });
}

// ─── Individual step implementations ──────────────────────────────────────

async function ensureDirs(ctx) {
  for (const rel of ['logs', 'tests/specs', 'perf/scripts', 'perf/results',
                     'security/scripts', 'security/reports', 'playwright-report']) {
    const p = path.join(ROOT, rel);
    if (!fs.existsSync(p)) fs.mkdirSync(p, { recursive: true });
  }
  return ctx;
}

async function preFlight(ctx) {
  await runNodeScript('scripts/pre-flight.js', { label: 'pre-flight' });
  return ctx;
}

async function fetchStory(ctx) {
  const extraEnv = ctx.flags?.force ? { FORCE_CREATE: 'true' } : {};
  await runNodeScript('scripts/run-story.js', { extraEnv, label: 'story' });
  return ctx;
}

async function generateSpecs(ctx) {
  try {
    const r = await runNodeScript('scripts/generate-playwright.js', { label: 'specs' });
    ctx.results = ctx.results || {};
    ctx.results.generateSpecs = { ...ctx.results.generateSpecs, ...r };
    return ctx;
  } catch (err) {
    // Exit code 2 from generate-playwright = ZERO SPECS generated. Hard-abort.
    const exitCode = err.details?.exitCode;
    if (err instanceof NonZeroExitError && exitCode === 2) {
      throw new PreconditionError(
        'ABORT: No Playwright specs were generated for this story.',
        {
          recoveryHint:
            'Re-run scripts/run-story.js to create Zephyr test cases first, or check generate-playwright.js output.',
          details: { originalError: err.toJSON?.() || { message: err.message } }
        }
      );
    }
    throw err;
  }
}

async function proactiveHeal(ctx) {
  if (ctx.flags?.skipSmartHeal) return ctx;
  try { await runNodeScript('scripts/smart-healer.js', { label: 'smart-heal' }); }
  catch (e) { logger.warn(`Smart healer soft-failed: ${e.message}`); }
  return ctx;
}

async function executeFunctional(ctx) {
  const extraEnv = { PW_HEADLESS: ctx.flags?.headless ? 'true' : 'false' };
  await runNodeScript('scripts/run-and-sync.js', { extraEnv, label: 'functional' });
  return ctx;
}

async function executePerformance(ctx) {
  if (!ctx.flags?.includePerf) return ctx;
  await runNodeScript('scripts/run-perf.js', {
    extraEnv: { PW_HEADLESS: ctx.flags?.headless ? 'true' : 'false' },
    label: 'perf'
  });
  return ctx;
}

async function executeSecurity(ctx) {
  if (!ctx.flags?.includeSecurity) return ctx;
  await runNodeScript('scripts/run-security.js', { label: 'security' });
  return ctx;
}

async function reactiveHeal(ctx) {
  if (ctx.flags?.skipHeal) return ctx;
  try {
    await runNodeScript('scripts/healer.js', {
      extraEnv: {
        PW_HEADLESS:      ctx.flags?.headless ? 'true' : 'false',
        HEALER_SKIP_RUN:  'true'
      },
      label: 'heal'
    });
  } catch (e) { logger.warn(`Reactive healer soft-failed: ${e.message}`); }
  return ctx;
}

async function createBugs(ctx) {
  if (ctx.flags?.skipBugs) return ctx;
  try { await runNodeScript('scripts/create-jira-bugs.js', { label: 'bugs' }); }
  catch (e) { logger.warn(`Bug creation soft-failed: ${e.message}`); }
  return ctx;
}

async function generateReports(ctx) {
  await runNodeScript('scripts/generate-report.js', { label: 'report' });
  try { await runNodeScript('scripts/generate-allure-report.js', { label: 'allure' }); }
  catch (e) { logger.warn(`Allure report soft-failed: ${e.message}`); }
  return ctx;
}

async function syncGit(ctx) {
  if (ctx.flags?.skipGit) return ctx;
  try { await runNodeScript('scripts/git-sync.js', { label: 'git' }); }
  catch (e) { logger.warn(`Git sync soft-failed: ${e.message}`); }
  return ctx;
}

// ─── Step registry: name → { fn, critical } ───────────────────────────────
// `critical: true` means the runner will halt the pipeline if the step throws.
const STEPS = {
  ensureDirs:         { fn: ensureDirs,             critical: true  },
  preFlight:          { fn: preFlight,              critical: true  },
  fetchStory:         { fn: fetchStory,             critical: true  },
  generateSpecs:      { fn: generateSpecs,          critical: true  },
  proactiveHeal:      { fn: proactiveHeal,          critical: false },
  executeFunctional:  { fn: executeFunctional,      critical: false },
  executePerformance: { fn: executePerformance,     critical: false },
  executeSecurity:    { fn: executeSecurity,        critical: false },
  reactiveHeal:       { fn: reactiveHeal,           critical: false },
  createBugs:         { fn: createBugs,             critical: false },
  generateReports:    { fn: generateReports,        critical: false },
  syncGit:            { fn: syncGit,                critical: false },
};

module.exports = { STEPS, runNodeScript };
