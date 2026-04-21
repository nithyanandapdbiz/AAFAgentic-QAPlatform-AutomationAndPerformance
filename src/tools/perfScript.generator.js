'use strict';
/** @module perfScript.generator — Generates k6 JavaScript load test scripts from story load profiles and thresholds. */

const fs   = require('fs');
const path = require('path');
const logger   = require('../utils/logger');
const AppError = require('../core/errorHandler');
const { buildStages } = require('../agents/performance.agent');

const ROOT = path.resolve(__dirname, '..', '..');

/**
 * Generates a valid k6 script and writes it to tests/perf/<testType>/<storyKey>_<testType>.k6.js
 *
 * @param {string} testType     - One of: load|stress|spike|soak|scalability|breakpoint
 * @param {string} storyKey     - Jira story key, e.g. "SCRUM-5"
 * @param {object} loadProfile  - { vus, duration, rampUpTime, rampDownTime, thinkTime }
 * @param {object} thresholds   - { p95, p99, errorRate }
 * @param {string} baseUrl      - Target base URL for the test
 * @returns {string}            - Absolute path of the written script
 */
function generateK6Script(testType, storyKey, loadProfile, thresholds, baseUrl) {
  try {
    const outDir = path.join(ROOT, 'tests', 'perf', testType);
    fs.mkdirSync(outDir, { recursive: true });

    const fileName   = `${storyKey}_${testType}.k6.js`;
    const scriptPath = path.join(outDir, fileName);
    const generated  = new Date().toISOString();

    // Build stages array for this test type
    const stages = buildStages(testType, loadProfile);
    const stagesJson = JSON.stringify(stages, null, 6)
      .split('\n')
      .map((line, i) => (i === 0 ? line : '      ' + line))
      .join('\n');

    const { p95, p99, errorRate, thinkTime: profileThinkTime } = { ...loadProfile, ...thresholds };
    const thinkTime = loadProfile.thinkTime !== undefined ? loadProfile.thinkTime : 1;

    const script = `// storyKey: ${storyKey}
// testType: ${testType}
// generated: ${generated}
// thresholds: p95=${thresholds.p95}ms p99=${thresholds.p99}ms errorRate=${thresholds.errorRate}

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const responseTime = new Trend('response_time');
const errorRate    = new Rate('error_rate');

export const options = {
  stages: ${stagesJson},
  thresholds: {
    'http_req_duration': ['p(95)<${thresholds.p95}', 'p(99)<${thresholds.p99}'],
    'http_req_failed':   ['rate<${thresholds.errorRate}'],
  },
};

export default function () {
  const baseUrl = __ENV.BASE_URL || '${baseUrl}';

  const res = http.post(
    \`\${baseUrl}/web/index.php/auth/validateCredentials\`,
    JSON.stringify({ txtUsername: 'Admin', txtPassword: 'admin123' }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'login 200': (r) => r.status === 200,
  });

  responseTime.add(res.timings.duration);
  errorRate.add(res.status !== 200);

  sleep(${thinkTime});
}
`;

    fs.writeFileSync(scriptPath, script, 'utf8');
    logger.info(`[PerfScriptGenerator] Written: ${scriptPath}`);
    return scriptPath;
  } catch (err) {
    throw new AppError(`perfScript.generator failed for ${testType}/${storyKey}: ${err.message}`);
  }
}

module.exports = { generateK6Script };
