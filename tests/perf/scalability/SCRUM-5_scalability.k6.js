// storyKey: SCRUM-5
// testType: scalability
// generated: 2026-04-28T00:16:47.799Z
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

export const options = {
  scenarios: {
    scalability: {
      executor: 'ramping-vus',
      stages: [
          { duration: '10s', target: 1 },
          { duration: '10s', target: 3 },
          { duration: '10s', target: 6 },
          { duration: '10s', target: 13 },
          { duration: '10s', target: 19 },
          { duration: '15s', target: 25 },
          { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Overall SLA
    'http_req_duration': ['p(95)<2600', 'p(99)<6500'],
    'http_req_failed':   ['rate<0.015'],
    // Per-step latency budgets — login
    'login_duration':    ['p(50)<910', 'p(90)<1170', 'p(95)<1300'],
    // Per-step latency budgets — navigate
    'navigate_duration': ['p(50)<1040', 'p(90)<1404', 'p(95)<1560'],
    // Per-step latency budgets — action
    'action_duration':   ['p(50)<1560', 'p(90)<2340', 'p(95)<2600'],
    // Dropped iterations
    'dropped_iterations': ['count<5'],
  },
  summaryTrendStats: ['avg', 'min', 'med', 'max', 'p(90)', 'p(95)', 'p(99)'],
};

const BASE_URL = __ENV.BASE_URL || 'https://opensource-demo.orangehrmlive.com';

export function setup() {
  const probe = http.get(BASE_URL, { timeout: '10s' });
  check(probe, { 'app reachable': (r) => r.status >= 200 && r.status < 500 });
  return { baseUrl: BASE_URL };
}

// TODO: Replace with the actual journey for SCRUM-5
export default function (data) {
  const itStart = Date.now();
  concurrentUsers.add(__VU);
  const res = http.get(data.baseUrl, { tags: { step: 'smoke' } });
  const ok  = check(res, { 'smoke 2xx': (r) => r.status >= 200 && r.status < 500 });
  errorRate.add(!ok);
  if (!ok) loginErrors.add(1);
  iterationDuration.add(Date.now() - itStart);
  sleep(0.5 + Math.random() * 1);
}

export function teardown(data) {}

export function handleSummary(data) {
  return {
    'test-results/perf/SCRUM-5_scalability-summary.json': JSON.stringify(data, null, 2),
    'test-results/perf/SCRUM-5_scalability-timeseries.csv': buildCsv(data),
    stdout: textSummary(data, { indent: ' ' }),
  };
}

function buildCsv(data) {
  const m   = data.metrics || {};
  const dur = m.http_req_duration || {};
  const v   = dur.values || dur || {};
  return [
    'metric,p50,p90,p95,p99,avg,min,max',
    `http_req_duration,${v['p(50)']||0},${v['p(90)']||0},${v['p(95)']||0},${v['p(99)']||0},${v.avg||0},${v.min||0},${v.max||0}`,
  ].join('\n');
}
