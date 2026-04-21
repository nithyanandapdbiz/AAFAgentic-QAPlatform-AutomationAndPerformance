'use strict';
/**
 * pipeline/runner.js — Orchestrates a sequence of named steps.
 *
 * Responsibilities:
 *   - Runs steps sequentially, each receiving/returning the shared `ctx`
 *   - Classifies each outcome: PASS | WARN | FAIL | SKIPPED
 *   - Halts the pipeline if a step marked `critical: true` throws
 *   - Writes `logs/pipeline-failure-report.json` on hard failure
 *   - Returns a summary object for callers to inspect / exit-code on
 *
 * Usage:
 *   const { runPipeline } = require('./runner');
 *   const result = await runPipeline(['ensureDirs','preFlight',...], ctx);
 *   process.exitCode = result.failed > 0 ? 1 : 0;
 */

const fs   = require('fs');
const path = require('path');
const logger = require('../utils/logger');
const { STEPS } = require('./steps');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * @param {string[]} stepNames
 * @param {object}   ctx
 * @returns {Promise<{passed:number, failed:number, skipped:number, warned:number, steps:Array, halted:boolean, durationMs:number}>}
 */
async function runPipeline(stepNames, ctx = {}) {
  ctx.results = ctx.results || {};
  const t0 = Date.now();
  const out = { passed: 0, failed: 0, skipped: 0, warned: 0, steps: [], halted: false };

  for (const name of stepNames) {
    const step = STEPS[name];
    if (!step) {
      logger.warn(`runner: unknown step "${name}" — skipping`);
      out.steps.push({ name, status: 'SKIPPED', reason: 'unknown-step', ms: 0 });
      out.skipped++;
      continue;
    }

    const t = Date.now();
    logger.info(`▶ step: ${name}`);

    try {
      await step.fn(ctx);
      const ms = Date.now() - t;
      ctx.results[name] = { status: 'PASS', ms };
      out.steps.push({ name, status: 'PASS', ms });
      out.passed++;
      logger.info(`✓ ${name} (${(ms / 1000).toFixed(1)}s)`);
    } catch (err) {
      const ms = Date.now() - t;
      const classified = classifyError(err);
      ctx.results[name] = { status: classified.status, ms, error: classified };
      out.steps.push({ name, status: classified.status, ms, error: classified });

      if (step.critical) {
        out.failed++;
        out.halted = true;
        logger.error(`✗ ${name} FAILED [critical] — ${classified.message}`);
        if (classified.recoveryHint) logger.error(`   hint: ${classified.recoveryHint}`);
        writeFailureReport(out, ctx, { failingStep: name, error: classified });
        break;
      } else {
        out.warned++;
        logger.warn(`⚠ ${name} soft-failed — ${classified.message}`);
      }
    }
  }

  out.durationMs = Date.now() - t0;
  return out;
}

function classifyError(err) {
  // AppError subclasses expose .toJSON()
  if (err && typeof err.toJSON === 'function') {
    return { status: 'FAIL', ...err.toJSON() };
  }
  return {
    status:       'FAIL',
    name:         err?.name || 'Error',
    code:         err?.code || 'UNKNOWN',
    message:      err?.message || String(err),
    recoveryHint: null,
    details:      null
  };
}

function writeFailureReport(summary, ctx, { failingStep, error }) {
  try {
    const logsDir = path.join(ROOT, 'logs');
    if (!fs.existsSync(logsDir)) fs.mkdirSync(logsDir, { recursive: true });
    const report = {
      timestamp:   new Date().toISOString(),
      failingStep,
      error,
      context: {
        flags:    ctx.flags || null,
        issueKey: ctx.issueKey || process.env.ISSUE_KEY || null
      },
      summary: {
        passed:     summary.passed,
        failed:     summary.failed,
        warned:     summary.warned,
        skipped:    summary.skipped,
        steps:      summary.steps,
      }
    };
    fs.writeFileSync(
      path.join(logsDir, 'pipeline-failure-report.json'),
      JSON.stringify(report, null, 2),
      'utf-8'
    );
    logger.info('Wrote logs/pipeline-failure-report.json');
  } catch (e) {
    logger.warn(`Failed to write failure report: ${e.message}`);
  }
}

module.exports = { runPipeline };
