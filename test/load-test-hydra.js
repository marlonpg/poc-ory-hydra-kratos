/**
 * K6 Load Test: Hydra JWKS Endpoint
 * 
 * Tests Hydra's ability to serve JWKS (public keys) under load.
 * This is what Vote API calls to verify JWT signatures.
 * Target: 10k requests per second
 * 
 * Run: k6 run test/load-test-hydra.js
 * With higher load: k6 run -e LOAD=high test/load-test-hydra.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { textSummary } from 'https://jslib.k6.io/k6-summary/0.0.1/index.js';

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
    http_req_duration: ['p(95)<100', 'p(99)<200'],  // JWKS should be very fast (cached)
    http_req_failed: ['rate<0.01'],                  // Should have near-zero failures
  },
  ext: {
    loadimpact: {
      name: `Hydra Token Endpoint - ${config.name}`
    }
  }
};

export function setup() {
  console.log(`Running test profile: ${config.name}`);
  console.log('Testing JWKS endpoint - this is what Vote API uses to verify JWT tokens');
  return {};
}

export default function () {
  // Test JWKS endpoint (public, no auth required)
  // This is the endpoint that Vote API calls to get public keys for JWT verification
  const response = http.get('http://localhost:4444/.well-known/jwks.json');
  
  // Verify response
  check(response, {
    'JWKS endpoint responded (200)': (r) => r.status === 200,
    'response time < 100ms': (r) => r.timings.duration < 100,
    'has keys array': (r) => {
      try {
        const body = JSON.parse(r.body);
        return body.keys && Array.isArray(body.keys) && body.keys.length > 0;
      } catch (e) {
        return false;
      }
    },
  });
  
  // Light sleep to simulate realistic load
  sleep(0.1);
}

export function handleSummary(data) {
  const totalReqs = data.metrics.http_reqs ? data.metrics.http_reqs.values.count : 0;
  const failedReqs = data.metrics.http_req_failed ? data.metrics.http_req_failed.values.passes : 0;
  const avgDuration = data.metrics.http_req_duration ? data.metrics.http_req_duration.values.avg : 0;
  const p95Duration = data.metrics.http_req_duration ? data.metrics.http_req_duration.values['p(95)'] : 0;
  const p99Duration = data.metrics.http_req_duration ? (data.metrics.http_req_duration.values['p(99)'] || data.metrics.http_req_duration.values['p(95)']) : 0;
  
  console.log('='.repeat(60));
  console.log(`Hydra JWKS Endpoint Test - ${config.name}`);
  console.log('='.repeat(60));
  console.log(`Total Requests: ${totalReqs}`);
  console.log(`Failed Requests: ${failedReqs}`);
  console.log(`Avg Duration: ${Math.round(avgDuration)}ms`);
  console.log(`P95 Duration: ${Math.round(p95Duration)}ms`);
  console.log(`P99 Duration: ${Math.round(p99Duration)}ms`);
  console.log('='.repeat(60));
  
  return {
    'stdout': textSummary(data, { indent: ' ', enableColors: true }),
  };
}
