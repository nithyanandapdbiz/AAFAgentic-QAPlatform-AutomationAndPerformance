'use strict';
/** @module security.controller — Express handler for the GET /api/security/summary endpoint. */

const fs   = require('fs');
const path = require('path');

const ROOT           = path.resolve(__dirname, '..', '..');
const SEC_RESULTS_DIR = path.join(ROOT, 'test-results', 'security');

/**
 * GET /api/security/summary
 * Returns the latest security scan summary from stored JSON results.
 */
function getSecuritySummary(req, res) {
  try {
    if (!fs.existsSync(SEC_RESULTS_DIR)) {
      return res.status(404).json({ message: 'No security scan results found' });
    }

    // Find the most recently modified ZAP report
    const files = fs.readdirSync(SEC_RESULTS_DIR)
      .filter(f => f.endsWith('-zap-report.json'))
      .map(f => ({
        name: f,
        mtime: fs.statSync(path.join(SEC_RESULTS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      return res.status(404).json({ message: 'No security scan results found' });
    }

    const latestFile = path.join(SEC_RESULTS_DIR, files[0].name);
    const raw        = fs.readFileSync(latestFile, 'utf8');

    // Parse findings using the service
    const { parseFindings, evaluateSeverity } = require('../services/sec.execution.service');
    const { findings, summary } = parseFindings(latestFile, []);

    const severityPolicy = {
      failOn:    process.env.ZAP_FAIL_ON || 'high',
      warnOn:    process.env.ZAP_WARN_ON || 'medium',
      maxIssues: 0,
    };
    const { verdict } = evaluateSeverity(findings, severityPolicy);

    const stat = fs.statSync(latestFile);

    return res.json({
      verdict,
      critical:      summary.critical,
      high:          summary.high,
      medium:        summary.medium,
      low:           summary.low,
      info:          summary.informational,
      scanTimestamp: new Date(stat.mtimeMs).toISOString(),
      reportFile:    files[0].name,
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to parse security results: ${err.message}` });
  }
}

module.exports = { getSecuritySummary };
