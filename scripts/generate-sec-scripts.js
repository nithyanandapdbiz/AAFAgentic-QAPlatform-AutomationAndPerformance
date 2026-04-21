'use strict';
/** @module generate-sec-scripts — CLI script that generates a security scan config from a Jira story key and security agent analysis. */

require('dotenv').config();
const path     = require('path');
const logger   = require('../src/utils/logger');
const AppError = require('../src/core/errorHandler');
const { analyze }              = require('../src/agents/security.agent');
const { generateSecScanConfig } = require('../src/tools/secScript.generator');

/**
 * Core logic — callable inline from other scripts.
 * @param {object} opts - { storyKey, baseUrl }
 */
async function run(opts = {}) {
  try {
    const storyKey   = opts.storyKey || process.env.ISSUE_KEY;
    const baseUrl    = opts.baseUrl  || process.env.BASE_URL
                                     || 'https://opensource-demo.orangehrmlive.com';

    if (!storyKey) {
      throw new AppError('ISSUE_KEY environment variable is required (or pass storyKey in opts)');
    }

    const description = process.env.SEC_STORY_DESCRIPTION || 'security test story';

    const story = {
      key:         storyKey,
      summary:     storyKey,
      description,
      fields: {
        summary:     storyKey,
        description,
      },
    };

    const result = await analyze(story);

    if (!result.securityRequired) {
      logger.info('[generate-sec-scripts] No security signals detected — skipping config generation');
      return { securityRequired: false, configPath: null };
    }

    const { owaspChecklist, zapConfig, customCheckNames } = result;

    const configPath = generateSecScanConfig(storyKey, zapConfig, owaspChecklist, customCheckNames);
    logger.info(`[generate-sec-scripts] Config written: ${configPath}`);

    return { securityRequired: true, configPath };
  } catch (err) {
    if (err instanceof AppError) throw err;
    throw new AppError(`generate-sec-scripts failed: ${err.message}`);
  }
}

// ─── Standalone CLI ──────────────────────────────────────────────────────────
if (require.main === module) {
  if (!process.env.ISSUE_KEY) {
    console.error('[generate-sec-scripts] ERROR: ISSUE_KEY environment variable is required.');
    process.exit(1);
  }

  run()
    .then(result => {
      if (!result.securityRequired) {
        console.log('[generate-sec-scripts] No security signals detected — nothing generated.');
        process.exit(0);
      }
      console.log(`[generate-sec-scripts] Config written: ${result.configPath}`);
      process.exit(0);
    })
    .catch(err => {
      console.error(`[generate-sec-scripts] FATAL: ${err.message}`);
      process.exit(1);
    });
}

module.exports = { run };
