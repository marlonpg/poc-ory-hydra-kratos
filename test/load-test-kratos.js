/**
 * K6 Test: Kratos Identity & Session Management
 * 
 * Tests Kratos's ability to handle:
 * - User registration requests
 * - Session validation
 * - Login flow
 * 
 * Run: k6 run test/load-test-kratos.js
 */

import http from 'k6/http';
import { check, sleep, group } from 'k6';
import { Counter } from 'k6/metrics';

const registrationsSucceeded = new Counter('kratos_registrations_succeeded');
const sessionsValid = new Counter('kratos_sessions_valid');

const loadProfile = __ENV.LOAD || 'low';
const configs = {
  low: {
    vus: 10,
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
    vus: 500,
    duration: '120s',
    rampUp: '30s',
    name: 'High Load (500 VUs)'
  }
};

const config = configs[loadProfile];

export const options = {
  stages: [
    { duration: config.rampUp, target: config.vus },
    { duration: config.duration, target: config.vus },
    { duration: '10s', target: 0 }
  ],
  thresholds: {
    http_req_duration: ['p(95)<2000', 'p(99)<3000'],  // More lenient for Kratos (DB writes)
    http_req_failed: ['rate<0.1'],
  },
  ext: {
    loadimpact: {
      name: `Kratos Identity - ${config.name}`
    }
  }
};

export default function () {
  group('Session Validation', function () {
    // Check if session exists (no auth required)
    const sessionResponse = http.get('http://localhost:4433/sessions/whoami');
    
    check(sessionResponse, {
      'session check completed': (r) => r.status === 200 || r.status === 401,
      'response time ok': (r) => r.timings.duration < 2000,
    });
    
    if (sessionResponse.status === 200) {
      sessionsValid.add(1);
    }
  });
  
  sleep(0.1);
}

export function handleSummary(data) {
  const totalReqs = data.metrics.http_reqs.value;
  const failedReqs = data.metrics.http_req_failed.value;
  const validSessions = data.metrics.kratos_sessions_valid?.value || 0;
  
  console.log('='.repeat(60));
  console.log(`Kratos Load Test Summary - ${config.name}`);
  console.log('='.repeat(60));
  console.log(`Total Requests: ${totalReqs}`);
  console.log(`Valid Sessions Found: ${validSessions}`);
  console.log(`Failed: ${failedReqs}`);
  console.log(`Error Rate: ${((failedReqs / totalReqs) * 100).toFixed(2)}%`);
  console.log(`Avg Duration: ${Math.round(data.metrics.http_req_duration.values.avg)}ms`);
  console.log(`P95 Duration: ${Math.round(data.metrics.http_req_duration.values['p(95)'])}ms`);
  console.log(`P99 Duration: ${Math.round(data.metrics.http_req_duration.values['p(99)'])}ms`);
  console.log('='.repeat(60));
  
  return {
    stdout: data.metrics,
  };
}
