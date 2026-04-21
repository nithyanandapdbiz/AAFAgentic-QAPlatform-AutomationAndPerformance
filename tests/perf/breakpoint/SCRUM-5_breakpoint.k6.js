// storyKey: SCRUM-5
// testType: breakpoint
// generated: 2026-04-21T11:35:17.886Z
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
    breakpoint: {
      executor: 'ramping-vus',
        gracefulStop: '60s',
      stages: [
          { duration: '60s', target: 50 },
      ],
    },
  },
  thresholds: {
    // breakpoint — thresholds are informational only; abortOnFail triggers on error rate
    'http_req_failed': ['rate<1'],
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
  sleep(0.1);
}

export function teardown(data) {}

export function handleSummary(data) {
  return {
    'test-results/perf/SCRUM-5_breakpoint-summary.json': JSON.stringify(data, null, 2),
    'test-results/perf/SCRUM-5_breakpoint-timeseries.csv': buildCsv(data),
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
