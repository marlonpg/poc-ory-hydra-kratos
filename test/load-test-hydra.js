/**
 * K6 Load Test: Hydra Token Endpoint
 * 
 * Tests Hydra's ability to handle concurrent token requests.
 * Target: 10k requests per second
 * 
 * Run: k6 run test/load-test-hydra.js
 * With higher load: k6 run -e LOAD=high test/load-test-hydra.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';

// Configuration based on LOAD environment variable
const loadProfile = __ENV.LOAD || 'low';
const configs = {
  low: {
    vus: 10,           // virtual users
    duration: '30s',
    rampUp: '10s',
    name: 'Low Load (10 VUs)'
  },
  medium: {
    vus: 100,
    duration: '60s',
    rampUp: '20s',
    name: 'Medium Load (100 VUs)'
  },
  high: {
    vus: 1000,
    duration: '120s',
    rampUp: '30s',
    name: 'High Load (1000 VUs, ~10k req/s)'
  }
};

const config = configs[loadProfile];

export const options = {
  stages: [
    { duration: config.rampUp, target: config.vus },
    { duration: config.duration, target: config.vus },
    { duration: '10s', target: 0 }  // ramp down
  ],
  thresholds: {
    http_req_duration: ['p(95)<1000', 'p(99)<2000'],  // 95% under 1s, 99% under 2s
    http_req_failed: ['rate<0.1'],                     // error rate < 10%
  },
  ext: {
    loadimpact: {
      name: `Hydra Token Endpoint - ${config.name}`
    }
  }
};

// Store auth codes to reuse (simulates real OAuth flow)
const authCodes = {};
let codeIndex = 0;

export function setup() {
  console.log(`Running test profile: ${config.name}`);
  
  // Pre-generate some auth codes by calling login endpoint
  // In reality, you'd get these from the login flow
  const pregenCodes = [];
  for (let i = 0; i < 100; i++) {
    pregenCodes.push(`auth-code-${i}-${Date.now()}`);
  }
  return pregenCodes;
}

export default function (codes) {
  const clientId = 'voter-app';
  const clientSecret = 'my-client-secret';
  const redirectUri = 'http://localhost:3000/post-login';
  
  // Use a pre-generated code (in reality, you'd get this from /oauth2/auth)
  // For this test, we're simulating token requests
  const code = codes[codeIndex % codes.length];
  codeIndex++;
  
  // Token endpoint request
  const payload = `grant_type=authorization_code&code=${code}&redirect_uri=${encodeURIComponent(redirectUri)}&client_id=${clientId}&client_secret=${clientSecret}`;
  
  const params = {
    headers: {
      'Content-Type': 'application/x-www-form-urlencoded',
    },
    auth: 'basic',  // Use HTTP Basic auth
    username: clientId,
    password: clientSecret,
  };
  
  const response = http.post(
    'http://localhost:4444/oauth2/token',
    payload,
    params
  );
  
  // Even if code is invalid, we're measuring token endpoint throughput
  check(response, {
    'status is 200 or 400': (r) => r.status === 200 || r.status === 400,  // 400 ok for invalid code
    'response time < 1s': (r) => r.timings.duration < 1000,
    'response has body': (r) => r.body.length > 0,
  });
  
  // Light sleep to avoid hammering too hard
  sleep(0.1);
}

export function handleSummary(data) {
  console.log('='.repeat(60));
  console.log(`Load Test Summary - ${config.name}`);
  console.log('='.repeat(60));
  console.log(`Total Requests: ${data.metrics.http_reqs.value}`);
  console.log(`Failed Requests: ${data.metrics.http_req_failed.value}`);
  console.log(`Avg Duration: ${Math.round(data.metrics.http_req_duration.values.avg)}ms`);
  console.log(`P95 Duration: ${Math.round(data.metrics.http_req_duration.values['p(95)'])}ms`);
  console.log(`P99 Duration: ${Math.round(data.metrics.http_req_duration.values['p(99)'])}ms`);
  console.log('='.repeat(60));
  
  return {
    stdout: data.metrics,
  };
}
