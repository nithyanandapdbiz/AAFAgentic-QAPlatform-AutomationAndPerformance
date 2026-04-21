'use strict';
/** @module perf.controller — Express handler for the GET /api/perf/summary endpoint. */

const fs   = require('fs');
const path = require('path');

const ROOT            = path.resolve(__dirname, '..', '..');
const PERF_RESULTS_DIR = path.join(ROOT, 'test-results', 'perf');

/**
 * GET /api/perf/summary
 * Reads all k6 JSON result files from test-results/perf/ and returns
 * an aggregated performance summary.
 *
 * @param {import('express').Request}  req
 * @param {import('express').Response} res
 */
function getPerfSummary(req, res) {
  try {
    if (!fs.existsSync(PERF_RESULTS_DIR)) {
      return res.status(404).json({ message: 'No performance test results found' });
    }

    const files = fs.readdirSync(PERF_RESULTS_DIR)
      .filter(f => f.endsWith('.json'))
      .map(f => ({
        name:  f,
        mtime: fs.statSync(path.join(PERF_RESULTS_DIR, f)).mtimeMs,
      }))
      .sort((a, b) => b.mtime - a.mtime);

    if (files.length === 0) {
      return res.status(404).json({ message: 'No performance test results found' });
    }

    let total          = 0;
    let pass           = 0;
    let warn           = 0;
    let fail           = 0;
    let worstP95       = 0;
    let highestErrorRate = 0;
    let scanTimestamp  = null;

    const p95Threshold   = parseFloat(process.env.PERF_THRESHOLDS_P95  || '2000');
    const errorThreshold = parseFloat(process.env.PERF_THRESHOLDS_ERROR_RATE || '0.01');

    for (const fileInfo of files) {
      const filePath = path.join(PERF_RESULTS_DIR, fileInfo.name);
      try {
        const raw  = fs.readFileSync(filePath, 'utf8');
        const data = JSON.parse(raw);

        // Support both flat metrics and k6 summary JSON formats
        const metrics = data.metrics || data;

        const p95 = (
          metrics.http_req_duration?.values?.['p(95)'] ||
          metrics['http_req_duration{expected_response:true}']?.values?.['p(95)'] ||
          metrics.p95 ||
          0
        );
        const errorRate = (
          metrics.http_req_failed?.values?.rate ||
          metrics.errorRate ||
          0
        );

        total += 1;
        if (p95 > worstP95)             worstP95 = p95;
        if (errorRate > highestErrorRate) highestErrorRate = errorRate;

        // Verdict logic
        if (p95 > p95Threshold || errorRate > errorThreshold) {
          fail += 1;
        } else if (p95 > p95Threshold * 0.9) {
          warn += 1;
        } else {
          pass += 1;
        }

        if (!scanTimestamp) {
          scanTimestamp = new Date(fileInfo.mtime).toISOString();
        }
      } catch (_) {
        // Skip malformed result files
      }
    }

    return res.json({
      total,
      pass,
      warn,
      fail,
      worstP95:         Math.round(worstP95),
      highestErrorRate: parseFloat(highestErrorRate.toFixed(4)),
      scanTimestamp:    scanTimestamp || new Date().toISOString(),
    });
  } catch (err) {
    return res.status(500).json({ error: `Failed to parse perf results: ${err.message}` });
  }
}

module.exports = { getPerfSummary };
