// storyKey: SCRUM-5
// testType: stress
// generated: 2026-04-21T15:41:29.491Z
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
    stress: {
      executor: 'ramping-vus',
      stages: [
          { duration: '10s', target: 1 },
          { duration: '15s', target: 25 },
          { duration: '20s', target: 25 },
          { duration: '10s', target: 50 },
          { duration: '20s', target: 50 },
          { duration: '10s', target: 0 },
      ],
    },
  },
  thresholds: {
    // Overall SLA
    'http_req_duration': ['p(95)<3000', 'p(99)<7500'],
    'http_req_failed':   ['rate<0.02'],
    // Per-step latency budgets — login
    'login_duration':    ['p(50)<1050', 'p(90)<1350', 'p(95)<1500'],
    // Per-step latency budgets — navigate
    'navigate_duration': ['p(50)<1200', 'p(90)<1620', 'p(95)<1800'],
    // Per-step latency budgets — action
    'action_duration':   ['p(50)<1800', 'p(90)<2700', 'p(95)<3000'],
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
  sleep(0.2 + Math.random() * 0.8);
}

export function teardown(data) {}

export function handleSummary(data) {
  return {
    'test-results/perf/SCRUM-5_stress-summary.json': JSON.stringify(data, null, 2),
    'test-results/perf/SCRUM-5_stress-timeseries.csv': buildCsv(data),
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
