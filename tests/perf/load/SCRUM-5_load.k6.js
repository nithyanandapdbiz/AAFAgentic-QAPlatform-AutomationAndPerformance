// storyKey: SCRUM-5
// testType: load
// generated: 2026-04-21T01:41:07.232Z
// thresholds: p95=2000ms p99=5000ms errorRate=0.01

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Trend, Rate } from 'k6/metrics';

const responseTime = new Trend('response_time');
const errorRate    = new Rate('error_rate');

export const options = {
  stages: [
            {
                  "duration": "2m",
                  "target": 25
            },
            {
                  "duration": "5m",
                  "target": 25
            },
            {
                  "duration": "1m",
                  "target": 0
            }
      ],
  thresholds: {
    'http_req_duration': ['p(95)<2000', 'p(99)<5000'],
    'http_req_failed':   ['rate<0.01'],
  },
};

export default function () {
  const baseUrl = __ENV.BASE_URL || 'https://opensource-demo.orangehrmlive.com';

  const res = http.post(
    `${baseUrl}/web/index.php/auth/validateCredentials`,
    JSON.stringify({ txtUsername: 'Admin', txtPassword: 'admin123' }),
    { headers: { 'Content-Type': 'application/json' } }
  );

  check(res, {
    'login 200': (r) => r.status === 200,
  });

  responseTime.add(res.timings.duration);
  errorRate.add(res.status !== 200);

  sleep(1);
}
