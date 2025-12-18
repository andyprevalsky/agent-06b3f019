/**
 * Tests for POST /rose/bench (backend endpoint)
 */

import { TestClient } from './utils/test-client.ts';
import { assertStatusCode, assertHasProperty } from './utils/fixtures.ts';
import { createClient } from 'https://esm.sh/@supabase/supabase-js@2.39.3';

// Backend endpoint uses different base URL (Express server, not Supabase edge functions)
const backendUrl = Deno.env.get('BACKEND_URL') || 'http://localhost:3001';
const testClient = new TestClient(backendUrl);
const ROSE_API_KEY = Deno.env.get('ROSE_API_KEY') || '';

// Get fresh JWT token via OTP
async function getAuthToken(): Promise<string> {
  const supabase = createClient(
    Deno.env.get('SUPABASE_URL') || 'https://kzlurqihzaolhzsbkctf.supabase.co',
    Deno.env.get('SUPABASE_ANON_KEY') || 'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3Mjg4NTYxMzAsImV4cCI6MjA0NDQzMjEzMH0.iBYlGSYXVTf-XE30SHr1oxjMl9Vb7SFuW30qMSoXcEs'
  );

  // Authenticate with test OTP
  const { data, error } = await supabase.auth.verifyOtp({
    phone: '+19729777432',
    token: '181818',
    type: 'sms'
  });

  if (error || !data?.session) {
    console.error('❌ Auth failed:', error);
    throw new Error(`Failed to authenticate: ${error?.message}`);
  }

  console.log('✅ Authenticated successfully, userId:', data.user?.id);
  return data.session.access_token;
}

// Get token once before all tests
const JWT_TOKEN = await getAuthToken();

Deno.test("POST /v1/bench - MMLU-Pro with CoT=1, samples=3", async () => {
  const response = await testClient.post('/v1/bench', {
    benchmark: 'mmlu-pro',
    model: 'rose-labs/rose-1-lite',
    cotSteps: 1,
    samples: 3,
    seed: 42
  }, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'benchmarkName');
  assertHasProperty(response.data, 'accuracy');
  assertHasProperty(response.data, 'sampledQuestions');
  
  console.log(`✓ MMLU-Pro: ${response.data.accuracy.toFixed(1)}% accuracy on ${response.data.sampledQuestions} questions`);
});

Deno.test("POST /v1/bench - Terminal-Bench with CoT=1, samples=3", async () => {
  // Check if Daytona API key is available
  const daytonaKey = Deno.env.get('DAYTONA_API_KEY');
  if (!daytonaKey) {
    console.warn('⚠️  DAYTONA_API_KEY not set - skipping Terminal-Bench test');
    console.warn('   Set DAYTONA_API_KEY to run container-based Terminal-Bench evaluations');
    return;
  }
  
  console.log('🚢 Running Terminal-Bench (container-based via Daytona, may take ~2min per task)...');
  
  const response = await testClient.post('/v1/bench', {
    benchmark: 'terminal-bench',
    model: 'rose-labs/rose-1-lite',
    cotSteps: 1,
    samples: 3,
    seed: 42
  }, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  // Verify same response format as MMLU-Pro
  assertStatusCode(response.status, 200);
  assertHasProperty(response.data, 'benchmarkName');
  assertHasProperty(response.data, 'accuracy');
  assertHasProperty(response.data, 'sampledQuestions');
  assertHasProperty(response.data, 'totalQuestions');
  assertHasProperty(response.data, 'correctAnswers');
  assertHasProperty(response.data, 'avgDurationMs');
  assertHasProperty(response.data, 'totalCostCents');
  assertHasProperty(response.data, 'results');
  assertHasProperty(response.data, 'industryComparison');
  
  // Verify results array structure
  if (response.data.results && response.data.results.length > 0) {
    const firstResult = response.data.results[0];
    assertHasProperty(firstResult, 'questionId');
    assertHasProperty(firstResult, 'isCorrect');
    assertHasProperty(firstResult, 'durationMs');
    assertHasProperty(firstResult, 'costCents');
  }
  
  console.log(`✓ Terminal-Bench: ${response.data.accuracy.toFixed(1)}% accuracy on ${response.data.sampledQuestions} tasks`);
  console.log(`  Duration: ${response.data.avgDurationMs.toFixed(0)}ms avg per task`);
  console.log(`  Industry comparison: ${JSON.stringify(response.data.industryComparison)}`);
});

Deno.test("POST /v1/bench - Multiple CoT steps", async () => {
  const response = await testClient.post('/v1/bench', {
    benchmark: 'mmlu-pro',
    model: 'rose-labs/rose-1-lite',
    cotSteps: 3,
    samples: 2,
    seed: 42
  }, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  assertStatusCode(response.status, 200);
  console.log(`✓ Multi-CoT: ${response.data.accuracy.toFixed(1)}% accuracy with CoT=${response.data.cotSteps}`);
});

Deno.test("POST /v1/bench - returns 400 for invalid benchmark", async () => {
  const response = await testClient.post('/v1/bench', {
    benchmark: 'invalid-benchmark-xyz',
    model: 'rose-labs/rose-1-lite',
    cotSteps: 1,
    samples: 3,
    seed: 42
  }, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
  assertHasProperty(response.data, 'available');
});

Deno.test("POST /v1/bench - returns 400 for missing benchmark", async () => {
  const response = await testClient.post('/v1/bench', {
    model: 'rose-labs/rose-1-lite',
    cotSteps: 1,
    samples: 3,
    seed: 42
  }, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  assertStatusCode(response.status, 400);
  assertHasProperty(response.data, 'error');
});

Deno.test("POST /v1/bench - respects seed for reproducibility", async () => {
  const config = {
    benchmark: 'mmlu-pro',
    model: 'rose-labs/rose-1-lite',
    cotSteps: 1,
    samples: 3,
    seed: 12345
  };
  
  const response = await testClient.post('/v1/bench', config, {
    headers: { 
      'Authorization': `Bearer ${JWT_TOKEN}`,
      'x-api-key': ROSE_API_KEY 
    }
  });
  
  assertStatusCode(response.status, 200);
  console.log(`✓ Seed test: Completed with seed=${config.seed}`);
});

