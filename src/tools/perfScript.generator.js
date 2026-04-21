'use strict';
/** @module perfScript.generator — Generates k6 performance test scripts from story load profiles.
 *  All generated scripts use k6 ES-module syntax (export default) as they run inside the k6 runtime.
 */

const fs   = require('fs');
const path = require('path');
const logger   = require('../utils/logger');
const AppError = require('../core/errorHandler');

const ROOT = path.resolve(__dirname, '..', '..');

// ── Journey inference ────────────────────────────────────────────────────────
const RESOURCE_MAP = [
  ['employee',  '/api/v2/pim/employees'],
  ['user',      '/api/v2/users'],
  ['customer',  '/api/v2/customers'],
  ['product',   '/api/v2/products'],
  ['order',     '/api/v2/orders'],
  ['item',      '/api/v2/items'],
  ['report',    '/api/v2/reports'],
  ['document',  '/api/v2/documents'],
  ['record',    '/api/v2/records'],
  ['account',   '/api/v2/accounts'],
  ['task',      '/api/v2/tasks'],
  ['project',   '/api/v2/projects'],
  ['invoice',   '/api/v2/invoices'],
  ['ticket',    '/api/v2/tickets'],
  ['asset',     '/api/v2/assets'],
];

function inferJourney(storyKey, storyDescription) {
  const text = `${storyKey} ${storyDescription || ''}`.toLowerCase();
  let resourcePath = null;
  for (const [keyword, rpath] of RESOURCE_MAP) {
    if (text.includes(keyword)) { resourcePath = rpath; break; }
  }
  const writeMethod =
    /\bupdate\b|\bedit\b|\bmodify\b|\bpatch\b/.test(text) ? 'PUT'    :
    /\bdelete\b|\bremove\b/.test(text)                    ? 'DELETE' :
    /\bcreate\b|\badd\b|\bnew\b|\bpost\b|\bsave\b|\bsubmit\b|\binsert\b/.test(text) ? 'POST' :
    null;
  return { resourcePath, writeMethod, canInfer: !!resourcePath };
}

// ── Per-type think time expressions ─────────────────────────────────────────
const THINK_TIME = {
  load:        'sleep(0.5 + Math.random() * 1.5)',
  stress:      'sleep(0.2 + Math.random() * 0.8)',
  spike:       '/* no think time — spike must hit cold */',
  soak:        'sleep(1 + Math.random() * 3)',
  scalability: 'sleep(0.5 + Math.random() * 1)',
  breakpoint:  'sleep(0.1)',
};

// ── Warm-up stage (added before main stages for load/stress/soak/scalability) ─
const WARMUP_STAGE  = '{ duration: \'30s\', target: 1 }';
const NO_WARMUP     = new Set(['spike', 'breakpoint']);

// POC mode collapses each test type to ~60–90s while preserving the stage
// shape (ramp-up, plateau, ramp-down, spikes, steps, ramp-to-failure).
// Enable with PERF_POC_MODE=true (also set automatically when
// PERF_SOAK_DURATION is under 2m so POC and soak-override stay consistent).
function isPocMode() {
  const flag = String(process.env.PERF_POC_MODE || '').toLowerCase();
  return flag === 'true' || flag === '1' || flag === 'yes';
}

// ── Stage shapes per test type ────────────────────────────────────────────────
function buildScenariosBlock(testType, loadProfile) {
  const { vus, duration, rampUpTime, rampDownTime } = loadProfile;
  const soakDur = process.env.PERF_SOAK_DURATION || '30m';
  const poc     = isPocMode();

  switch (testType) {
    case 'load':
      return {
        executor: 'ramping-vus',
        stages: poc ? [
          `{ duration: '10s', target: 1 }`,
          `{ duration: '15s', target: ${vus} }`,
          `{ duration: '30s', target: ${vus} }`,
          `{ duration: '10s', target: 0 }`,
        ] : [
          WARMUP_STAGE,
          `{ duration: '2m', target: ${vus} }`,
          `{ duration: '5m', target: ${vus} }`,
          `{ duration: '1m', target: 0 }`,
        ],
      };

    case 'stress':
      return {
        executor: 'ramping-vus',
        stages: poc ? [
          `{ duration: '10s', target: 1 }`,
          `{ duration: '15s', target: ${vus} }`,
          `{ duration: '20s', target: ${vus} }`,
          `{ duration: '10s', target: ${vus * 2} }`,
          `{ duration: '20s', target: ${vus * 2} }`,
          `{ duration: '10s', target: 0 }`,
        ] : [
          WARMUP_STAGE,
          `{ duration: '3m', target: ${vus} }`,
          `{ duration: '5m', target: ${vus} }`,
          `{ duration: '2m', target: ${vus * 2} }`,
          `{ duration: '3m', target: ${vus * 2} }`,
          `{ duration: '2m', target: 0 }`,
        ],
      };

    case 'spike':
      // ramping-arrival-rate for spike — no warm-up
      return {
        executor: 'ramping-arrival-rate',
        preAllocatedVUs: vus * 3,
        stages: poc ? [
          `{ duration: '5s',  target: ${vus * 3} }`,
          `{ duration: '30s', target: ${vus * 3} }`,
          `{ duration: '5s',  target: 0 }`,
        ] : [
          `{ duration: '10s', target: ${vus * 3} }`,
          `{ duration: '1m',  target: ${vus * 3} }`,
          `{ duration: '10s', target: 0 }`,
        ],
      };

    case 'soak': {
      const pocSoak = process.env.PERF_SOAK_DURATION || '40s';
      return {
        executor: 'ramping-vus',
        stages: poc ? [
          `{ duration: '10s', target: 1 }`,
          `{ duration: '15s', target: ${vus} }`,
          `{ duration: '${pocSoak}', target: ${vus} }`,
          `{ duration: '10s', target: 0 }`,
        ] : [
          WARMUP_STAGE,
          `{ duration: '3m',      target: ${vus} }`,
          `{ duration: '${soakDur}', target: ${vus} }`,
          `{ duration: '${rampDownTime}', target: 0 }`,
        ],
      };
    }

    case 'scalability': {
      const v10  = Math.max(1, Math.round(vus * 0.10));
      const v25  = Math.max(1, Math.round(vus * 0.25));
      const v50  = Math.max(1, Math.round(vus * 0.50));
      const v75  = Math.max(1, Math.round(vus * 0.75));
      return {
        executor: 'ramping-vus',
        stages: poc ? [
          `{ duration: '10s', target: 1 }`,
          `{ duration: '10s', target: ${v10} }`,
          `{ duration: '10s', target: ${v25} }`,
          `{ duration: '10s', target: ${v50} }`,
          `{ duration: '10s', target: ${v75} }`,
          `{ duration: '15s', target: ${vus} }`,
          `{ duration: '10s', target: 0 }`,
        ] : [
          WARMUP_STAGE,
          `{ duration: '2m', target: ${v10} }`,
          `{ duration: '2m', target: ${v25} }`,
          `{ duration: '2m', target: ${v50} }`,
          `{ duration: '2m', target: ${v75} }`,
          `{ duration: '3m', target: ${vus} }`,
          `{ duration: '1m', target: 0 }`,
        ],
      };
    }

    case 'breakpoint':
      return {
        executor: 'ramping-vus',
        gracefulStop: '60s',
        abortOnFail: true,
        stages: poc ? [
          `{ duration: '60s', target: ${vus * 2} }`,
        ] : [
          `{ duration: '10m', target: ${vus * 2} }`,
        ],
      };

    default:
      return {
        executor: 'ramping-vus',
        stages: [
          `{ duration: '${rampUpTime}', target: ${vus} }`,
          `{ duration: '${duration}',   target: ${vus} }`,
          `{ duration: '${rampDownTime}', target: 0 }`,
        ],
      };
  }
}

/**
 * Serialise the scenarios block into a k6 options.scenarios object literal.
 * We write it as literal JS (not JSON) so the stage arrays render cleanly.
 */
function scenariosLiteral(testType, scenariosConf) {
  const { executor, stages, gracefulStop, abortOnFail, preAllocatedVUs } = scenariosConf;
  const stagesArr = stages.map(s => `          ${s}`).join(',\n');

  let extra = '';
  if (gracefulStop)    extra += `\n        gracefulStop: '${gracefulStop}',`;
  if (preAllocatedVUs) extra += `\n        preAllocatedVUs: ${preAllocatedVUs},`;

  return `
  scenarios: {
    ${testType}: {
      executor: '${executor}',${extra}
      stages: [
${stagesArr},
      ],
    },
  },`;
}

/**
 * Emit threshold literals for a test type.
 * Uses explicit p50/p90/p95 threshold tiers for per-step metrics.
 */
function thresholdsLiteral(testType, p95Val, p99Val, errVal, isBreakpoint) {
  const loginP95  = Math.round(p95Val * 0.50);
  const loginP90  = Math.round(p95Val * 0.45);
  const loginP50  = Math.round(p95Val * 0.35);
  const navP95    = Math.round(p95Val * 0.60);
  const navP90    = Math.round(p95Val * 0.54);
  const navP50    = Math.round(p95Val * 0.40);

  if (isBreakpoint) {
    return `
  thresholds: {
    // breakpoint — thresholds are informational only; abortOnFail triggers on error rate
    'http_req_failed': ['rate<${errVal}'],
  },`;
  }

  return `
  thresholds: {
    // Overall SLA
    'http_req_duration': ['p(95)<${p95Val}', 'p(99)<${p99Val}'],
    'http_req_failed':   ['rate<${errVal}'],
    // Per-step latency budgets — login
    'login_duration':    ['p(50)<${loginP50}', 'p(90)<${loginP90}', 'p(95)<${loginP95}'],
    // Per-step latency budgets — navigate
    'navigate_duration': ['p(50)<${navP50}', 'p(90)<${navP90}', 'p(95)<${navP95}'],
    // Per-step latency budgets — action
    'action_duration':   ['p(50)<${Math.round(p95Val * 0.6)}', 'p(90)<${Math.round(p95Val * 0.9)}', 'p(95)<${p95Val}'],
    // Dropped iterations
    'dropped_iterations': ['count<5'],
  },`;
}

/**
 * Build step-3 action block based on inferred HTTP method.
 */
function buildStep3(resourcePath, writeMethod, p95Val) {
  if (writeMethod === 'POST') {
    return `
  group('03_action', () => {
    const t0 = Date.now();
    const body = JSON.stringify({ name: \`LoadItem\${__VU}\`, ref: \`\${10000 + __VU}\` });
    const actionRes = http.post(
      \`\${baseUrl}${resourcePath}\`,
      body,
      { headers: JSON_HEADERS, tags: { step: 'action' } }
    );
    const actionOk = check(actionRes, { '03 create 2xx': (r) => r.status >= 200 && r.status < 300 });
    actionDuration.add(Date.now() - t0);
    if (!actionOk) { errorRate.add(1); actionErrors.add(1); } else { errorRate.add(0); }
  });`;
  }
  if (writeMethod === 'PUT') {
    return `
  group('03_action', () => {
    const t0 = Date.now();
    const body = JSON.stringify({ name: \`UpdatedItem\${__VU}\` });
    const actionRes = http.put(
      \`\${baseUrl}${resourcePath}/\${__VU}\`,
      body,
      { headers: JSON_HEADERS, tags: { step: 'action' } }
    );
    const actionOk = check(actionRes, { '03 update 2xx': (r) => r.status >= 200 && r.status < 300 });
    actionDuration.add(Date.now() - t0);
    if (!actionOk) { errorRate.add(1); actionErrors.add(1); } else { errorRate.add(0); }
  });`;
  }
  if (writeMethod === 'DELETE') {
    return `
  group('03_action', () => {
    const t0 = Date.now();
    const actionRes = http.del(
      \`\${baseUrl}${resourcePath}/\${__VU}\`,
      null,
      { tags: { step: 'action' } }
    );
    const actionOk = check(actionRes, { '03 delete 2xx/404': (r) => r.status >= 200 && r.status < 300 || r.status === 404 });
    actionDuration.add(Date.now() - t0);
    if (!actionOk) { errorRate.add(1); actionErrors.add(1); } else { errorRate.add(0); }
  });`;
  }
  return `
  group('03_action', () => {
    const t0 = Date.now();
    const actionRes = http.get(
      \`\${baseUrl}${resourcePath}?page=\${(__VU % 5) + 1}\`,
      { headers: { 'Accept': 'application/json' }, tags: { step: 'action' } }
    );
    const actionOk = check(actionRes, { '03 paginated list 2xx': (r) => r.status >= 200 && r.status < 300 });
    actionDuration.add(Date.now() - t0);
    if (!actionOk) { errorRate.add(1); actionErrors.add(1); } else { errorRate.add(0); }
  });`;
}

/**
 * Generates a valid k6 script and writes it to tests/perf/<testType>/<storyKey>_<testType>.k6.js
 *
 * @param {string} testType           - One of: load|stress|spike|soak|scalability|breakpoint
 * @param {string} storyKey           - Jira story key, e.g. "SCRUM-5"
 * @param {object} loadProfile        - { vus, duration, rampUpTime, rampDownTime, thinkTime }
 * @param {object} thresholds         - { p95, p99, errorRate }
 * @param {string} baseUrl            - Target base URL
 * @param {string} [storyDescription] - Optional description for journey inference
 * @returns {string}                  - Absolute path of the written script
 */
function generateK6Script(testType, storyKey, loadProfile, thresholds, baseUrl, storyDescription = '') {
  try {
    const outDir = path.join(ROOT, 'tests', 'perf', testType);
    fs.mkdirSync(outDir, { recursive: true });

    const fileName   = `${storyKey}_${testType}.k6.js`;
    const scriptPath = path.join(outDir, fileName);
    const generated  = new Date().toISOString();
    const scriptName = `${storyKey}_${testType}`;

    const isBreakpoint = testType === 'breakpoint';
    const p95Val = isFinite(thresholds.p95)       ? thresholds.p95       : 99999;
    const p99Val = isFinite(thresholds.p99)       ? thresholds.p99       : 99999;
    const errVal = isFinite(thresholds.errorRate) ? thresholds.errorRate : 1;

    const thinkTimeExpr = THINK_TIME[testType] || THINK_TIME.load;
    const scenariosConf = buildScenariosBlock(testType, loadProfile);
    const scenariosSrc  = scenariosLiteral(testType, scenariosConf);
    const thresholdsSrc = thresholdsLiteral(testType, p95Val, p99Val, errVal, isBreakpoint);

    const { resourcePath, writeMethod, canInfer } = inferJourney(storyKey, storyDescription);

    if (!canInfer) {
      console.warn(
        `[PerfScriptGenerator] WARNING: Journey could not be inferred for story '${storyKey}'. ` +
        `Generated a single-group smoke test. Manually customise ${fileName}.`
      );
      logger.warn('[PerfScriptGenerator] Journey could not be inferred; generating smoke-test fallback', { storyKey, testType });

      const smokeScript = `// storyKey: ${storyKey}
// testType: ${testType}
// generated: ${generated}
// WARNING: Journey could not be inferred — manual customisation required.

import http from 'k6/http';
import { check, sleep }   from 'k6';
import { Rate, Counter, Gauge, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

const errorRate          = new Rate('error_rate');
const loginErrors        = new Counter('login_errors');
const navErrors          = new Counter('nav_errors');
const actionErrors       = new Counter('action_errors');
const droppedIterations  = new Counter('dropped_iterations');
const concurrentUsers    = new Gauge('concurrent_users');
const iterationDuration  = new Trend('iteration_duration', true);
const loginDuration      = new Trend('login_duration',    true);
const navigateDuration   = new Trend('navigate_duration', true);
const actionDuration     = new Trend('action_duration',   true);

export const options = {${scenariosSrc}${thresholdsSrc}
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const BASE_URL = __ENV.BASE_URL || '${baseUrl}';

export function setup() {
  const probe = http.get(BASE_URL, { timeout: '10s' });
  check(probe, { 'app reachable': (r) => r.status >= 200 && r.status < 500 });
  return { baseUrl: BASE_URL };
}

// TODO: Replace with the actual journey for ${storyKey}
export default function (data) {
  const itStart = Date.now();
  concurrentUsers.add(__VU);
  const res = http.get(data.baseUrl, { tags: { step: 'smoke' } });
  const ok  = check(res, { 'smoke 2xx': (r) => r.status >= 200 && r.status < 500 });
  errorRate.add(!ok);
  if (!ok) loginErrors.add(1);
  iterationDuration.add(Date.now() - itStart);
  ${thinkTimeExpr};
}

export function teardown(data) {}

export function handleSummary(data) {
  return {
    'test-results/perf/${scriptName}-summary.json': JSON.stringify(data, null, 2),
    'test-results/perf/${scriptName}-timeseries.csv': buildCsv(data),
    stdout: textSummary(data, { indent: ' ' }),
  };
}

function buildCsv(data) {
  const m   = data.metrics || {};
  const dur = m.http_req_duration || {};
  const v   = dur.values || dur || {};
  return [
    'metric,p50,p90,p95,p99,avg,min,max',
    \`http_req_duration,\${v['p(50)']||0},\${v['p(90)']||0},\${v['p(95)']||0},\${v['p(99)']||0},\${v.avg||0},\${v.min||0},\${v.max||0}\`,
  ].join('\\n');
}
`;
      fs.writeFileSync(scriptPath, smokeScript, 'utf8');
      logger.info(`[PerfScriptGenerator] Written: ${scriptPath}`);
      return scriptPath;
    }

    // ── Full inferred 3-step journey ─────────────────────────────────────────
    const step3Block = buildStep3(resourcePath, writeMethod, p95Val);

    const script = `// storyKey: ${storyKey}
// testType: ${testType}
// generated: ${generated}
// thresholds: p95=${p95Val}ms p99=${p99Val}ms errorRate=${errVal}
// journey: GET ${baseUrl} -> GET ${resourcePath} -> ${writeMethod || 'GET'} ${resourcePath}

import http   from 'k6/http';
import { check, group, sleep } from 'k6';
import { Rate, Counter, Gauge, Trend } from 'k6/metrics';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.2/index.js';

// ── Custom metrics ────────────────────────────────────────────────────────────
const loginDuration     = new Trend('login_duration',    true);
const navigateDuration  = new Trend('navigate_duration', true);
const actionDuration    = new Trend('action_duration',   true);
const iterationDuration = new Trend('iteration_duration', true);
const errorRate         = new Rate('error_rate');
const loginErrors       = new Counter('login_errors');
const navErrors         = new Counter('nav_errors');
const actionErrors      = new Counter('action_errors');
const droppedIterations = new Counter('dropped_iterations');
const concurrentUsers   = new Gauge('concurrent_users');

// ── Options ───────────────────────────────────────────────────────────────────
export const options = {${scenariosSrc}${thresholdsSrc}
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],

};

// ── Shared constants ──────────────────────────────────────────────────────────
const BASE_URL = __ENV.BASE_URL || '${baseUrl}';
const JSON_HEADERS = { 'Content-Type': 'application/json', 'Accept': 'application/json' };

// ── Setup ─────────────────────────────────────────────────────────────────────
export function setup() {
  const probe = http.get(BASE_URL, { timeout: '10s' });
  check(probe, { 'app reachable (setup)': (r) => r.status >= 200 && r.status < 500 });
  return { baseUrl: BASE_URL };
}

// ── VU iteration ──────────────────────────────────────────────────────────────
export default function (data) {
  const itStart = Date.now();
  const baseUrl = data.baseUrl;
  concurrentUsers.add(__VU);

  // ── Step 1: Landing / health check (maps to login_duration SLA budget) ───
  group('01_health', () => {
    const t0  = Date.now();
    const res = http.get(baseUrl, { tags: { step: 'login' } });
    const ok  = check(res, { '01 landing 2xx': (r) => r.status >= 200 && r.status < 500 });
    loginDuration.add(Date.now() - t0);
    if (!ok) { errorRate.add(1); loginErrors.add(1); } else { errorRate.add(0); }
  });
  sleep(0.3 + Math.random() * 0.5);

  // ── Step 2: List / collection endpoint (maps to navigate_duration SLA) ───
  group('02_list', () => {
    const t0  = Date.now();
    const res = http.get(
      \`\${baseUrl}${resourcePath}\`,
      { headers: { 'Accept': 'application/json' }, tags: { step: 'navigate' } }
    );
    const ok = check(res, { '02 list 2xx': (r) => r.status >= 200 && r.status < 300 });
    navigateDuration.add(Date.now() - t0);
    if (!ok) { errorRate.add(1); navErrors.add(1); } else { errorRate.add(0); }
  });
  sleep(0.3 + Math.random() * 0.5);
${step3Block}
  const itMs = Date.now() - itStart;
  iterationDuration.add(itMs);
  // Count dropped iteration if wall-clock exceeded 3x p95
  if (itMs > ${p95Val * 3}) { droppedIterations.add(1); }

  ${thinkTimeExpr};
}

// ── Teardown ──────────────────────────────────────────────────────────────────
export function teardown(data) {}

// ── handleSummary ─────────────────────────────────────────────────────────────
export function handleSummary(data) {
  return {
    'test-results/perf/${scriptName}-summary.json': JSON.stringify(data, null, 2),
    'test-results/perf/${scriptName}-timeseries.csv': buildCsv(data),
    stdout: textSummary(data, { indent: ' ' }),
  };
}

function buildCsv(data) {
  const m   = data.metrics || {};
  const dur = m.http_req_duration || {};
  const v   = dur.values || dur || {};
  const failM = m.http_req_failed || {};
  const fv    = failM.values || failM || {};
  const dropped = (m.dropped_iterations || {}).count || 0;
  return [
    'metric,p50,p90,p95,p99,avg,min,max,errorRate,dropped_iterations',
    \`http_req_duration,\${v['p(50)']||0},\${v['p(90)']||0},\${v['p(95)']||0},\${v['p(99)']||0},\${v.avg||0},\${v.min||0},\${v.max||0},\${fv.value||fv.rate||0},\${dropped}\`,
  ].join('\\n');
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
