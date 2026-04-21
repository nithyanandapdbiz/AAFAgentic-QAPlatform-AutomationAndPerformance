'use strict';
/** @module secScript.generator — Generates a JSON security scan config file for a given story key and ZAP/custom check configuration. */

const fs   = require('fs');
const path = require('path');
const logger   = require('../utils/logger');
const AppError = require('../core/errorHandler');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Generates a security scan config JSON and writes it to tests/security/<storyKey>-scan-config.json.
 *
 * @param {string}   storyKey       - Jira story key, e.g. "SCRUM-5"
 * @param {object}   zapConfig      - ZAP scan configuration object
 * @param {Array}    owaspChecklist - OWASP category array from security agent
 * @param {string[]} checkNames     - Custom check names to run
 * @returns {string}                - Absolute path of the written config file
 */
function generateSecScanConfig(storyKey, zapConfig, owaspChecklist, checkNames) {
  try {
    const outDir = path.join(ROOT, 'tests', 'security');
    fs.mkdirSync(outDir, { recursive: true });

    const fileName   = `${storyKey}-scan-config.json`;
    const configPath = path.join(outDir, fileName);

    const config = {
      storyKey,
      generated:      new Date().toISOString(),
      targetUrl:      process.env.BASE_URL || 'https://opensource-demo.orangehrmlive.com',
      zapConfig,
      owaspChecklist,
      customChecks:   checkNames,
      zapApiUrl:      process.env.ZAP_API_URL || 'http://localhost:8080',
      // Always mask the API key in the written file — never write the real value to disk
      zapApiKey:      '***',
    };

    fs.writeFileSync(configPath, JSON.stringify(config, null, 2), 'utf8');
    logger.info(`[SecScriptGenerator] Config written: ${configPath}`);
    return configPath;
  } catch (err) {
    throw new AppError(`secScript.generator failed for ${storyKey}: ${err.message}`);
  }
}

module.exports = { generateSecScanConfig };
