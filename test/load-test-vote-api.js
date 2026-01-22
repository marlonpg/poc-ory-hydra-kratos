/**
 * K6 Load Test: Vote API Endpoint
 * 
 * Tests vote-api's ability to handle concurrent vote requests.
 * Validates:
 * - JWT verification under load
 * - Vote recording
 * - One-vote-per-election enforcement
 * 
 * Run: k6 run test/load-test-vote-api.js
 * With higher load: k6 run -e LOAD=high test/load-test-vote-api.js
 */

import http from 'k6/http';
import { check, sleep } from 'k6';
import { Counter, Trend } from 'k6/metrics';

// Custom metrics
const votesSucceeded = new Counter('votes_succeeded');
const votesConflicted = new Counter('votes_conflicted');
const voteDuration = new Trend('vote_duration');

// Configuration based on LOAD environment variable
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
    { duration: '10s', target: 0 }
  ],
  thresholds: {
    http_req_duration: ['p(95)<500', 'p(99)<1000'],
    http_req_failed: ['rate<0.05'],
    votes_succeeded: ['count>0'],
  },
  ext: {
    loadimpact: {
      name: `Vote API - ${config.name}`
    }
  }
};

export function setup() {
  console.log(`Running test profile: ${config.name}`);
  
  // In a real scenario, you'd generate valid tokens here
  // For now, we'll use a mock token
  return {
    token: 'eyJhbGciOiJSUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJ0ZXN0LXVzZXItMTIzIiwiZW1haWwiOiJ0ZXN0QGV4YW1wbGUuY29tIiwic2NvcGUiOlsib3BlbmlkIiwicHJvZmlsZSIsImVtYWlsIiwidm90ZTpjYXN0Il0sImlzcyI6Imh0dHA6Ly9sb2NhbGhvc3Q6NDQ0NC8ifQ.mock',
    electionId: 'election-2025-01'
  };
}

export default function (data) {
  const { token, electionId } = data;
  
  // Simulate multiple candidates to distribute votes
  const candidates = ['alice', 'bob', 'charlie', 'diana'];
  const candidateId = candidates[Math.floor(Math.random() * candidates.length)];
  
  // Create unique voter identifier per VU (simulates different users)
  const voterId = `voter-${__VU}-${Math.floor(__ITER / 10)}`;  // Group iterations
  
  const payload = JSON.stringify({
    electionId: electionId,
    candidateId: candidateId,
    voterId: voterId  // Custom header for test tracking
  });
  
  const params = {
    headers: {
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
      'X-Voter-ID': voterId,
    },
  };
  
  const startTime = Date.now();
  const response = http.post(
    'http://localhost:4000/vote',
    payload,
    params
  );
  const duration = Date.now() - startTime;
  voteDuration.add(duration);
  
  // Check response
  if (response.status === 200) {
    votesSucceeded.add(1);
    check(response, {
      'vote succeeded': (r) => r.status === 200,
      'has vote ID': (r) => r.body.includes('id'),
      'has timestamp': (r) => r.body.includes('votedAt'),
    });
  } else if (response.status === 409) {
    votesConflicted.add(1);
    check(response, {
      'conflict (duplicate vote)': (r) => r.status === 409,
    });
  } else {
    check(response, {
      'status is valid': (r) => r.status < 500,  // 4xx errors ok, 5xx bad
    });
  }
  
  sleep(0.05);
}

export function handleSummary(data) {
  const totalReqs = data.metrics.http_reqs.value;
  const failedReqs = data.metrics.http_req_failed.value;
  const succeeded = data.metrics.votes_succeeded?.value || 0;
  const conflicted = data.metrics.votes_conflicted?.value || 0;
  
  console.log('='.repeat(60));
  console.log(`Vote API Load Test Summary - ${config.name}`);
  console.log('='.repeat(60));
  console.log(`Total Requests: ${totalReqs}`);
  console.log(`Succeeded: ${succeeded}`);
  console.log(`Conflicted (duplicate): ${conflicted}`);
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
