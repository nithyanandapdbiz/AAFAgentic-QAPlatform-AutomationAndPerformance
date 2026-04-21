'use strict';
/** @module generate-perf-scripts — CLI script that generates k6 performance test scripts from a Jira story key and performance agent analysis. */

require('dotenv').config();
const path     = require('path');
const logger   = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');
const { analyze }         = require('../src/agents/performance.agent');
const { generateK6Script } = require('../src/tools/perfScript.generator');

/**
 * Core logic — can be called inline from other scripts.
 *
 * @param {object} opts - { storyKey, baseUrl, testType }
 */
async function run(opts = {}) {
  try {
    const storyKey  = opts.storyKey  || process.env.ISSUE_KEY;
    const baseUrl   = opts.baseUrl   || process.env.BASE_URL
                                     || 'https://opensource-demo.orangehrmlive.com';
    const testType  = opts.testType;

    if (!storyKey) {
      throw new AppError('ISSUE_KEY environment variable is required (or pass storyKey in opts)');
    }

    const description = process.env.PERF_STORY_DESCRIPTION || 'performance test story';

    // Construct a minimal story object for the agent
    const story = {
      summary:     storyKey,
      description: description,
      fields: {
        summary:     storyKey,
        description: description,
      },
    };

    const result = await analyze(story);

    if (!result.perfRequired) {
      logger.info('[generate-perf-scripts] No performance signals detected — skipping script generation');
      return { perfRequired: false, scripts: [] };
    }

    const { loadProfile, thresholds, thresholdsByType, testTypes } = result;

    // Filter to a single test type if requested
    const typesToGenerate = testType
      ? testTypes.filter(t => t === testType)
      : testTypes;

    if (typesToGenerate.length === 0) {
      logger.warn(`[generate-perf-scripts] No matching test type for: ${testType}`);
      return { perfRequired: true, scripts: [], thresholdsByType };
    }

    const scripts = [];
    for (const type of typesToGenerate) {
      // Use per-type thresholds if available, else fall back to global thresholds
      const typeThresholds = thresholdsByType ? (thresholdsByType[type] || thresholds) : thresholds;
      const scriptPath = generateK6Script(type, storyKey, loadProfile, typeThresholds, baseUrl, description);
      logger.info(`[generate-perf-scripts] Generated: ${scriptPath}`);
      scripts.push(scriptPath);
    }

    return { perfRequired: true, scripts, thresholdsByType };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`generate-perf-scripts failed: ${err.message}`);
  }
}

// ─── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  const args = process.argv.slice(2);

  // Parse --test-type=<type> flag
  const typeArg = args.find(a => a.startsWith('--test-type='));
  const testType = typeArg ? typeArg.split('=')[1] : undefined;

  if (!process.env.ISSUE_KEY) {
    console.error('[generate-perf-scripts] ERROR: ISSUE_KEY environment variable is required.');
    process.exit(1);
  }

  run({ testType })
    .then(result => {
      if (!result.perfRequired) {
        console.log('[generate-perf-scripts] No performance signals detected — nothing generated.');
        process.exit(0);
      }
      console.log(`[generate-perf-scripts] Generated ${result.scripts.length} script(s):`);
      for (const s of result.scripts) console.log(`  ${s}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`[generate-perf-scripts] FATAL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { run };
