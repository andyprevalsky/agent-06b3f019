/**
 * Chunk conformance test: Racing path vs Claude-auth path
 *
 * Verifies both paths produce SSE chunks with the same structure
 * (the fields that consumers actually read).
 *
 * Required fields on every content chunk:
 *   choices[0].delta.content, actual_model, requested_model, pool_name, pool_size
 *
 * Required fields on final chunk:
 *   choices[0].finish_reason, usage.{prompt_tokens, completion_tokens, total_tokens}
 *
 * Prerequisites:
 *   - Backend running on localhost:3001
 *   - Edge function running on localhost:54321
 *   - Valid Claude OAuth token synced via Mac app
 *
 * Run: node test-chunk-conformance.mjs
 */

import process from 'node:process';
const EDGE_URL = 'http://127.0.0.1:54321/functions/v1/completions';
const BACKEND_URL = 'http://localhost:3001';
const ROSE_API_KEY = 'af1ea4b12ea8dbe07c555a45a8ad4dc8';
const BACKEND_API_KEY = 'AEzycCpQcJ1QKXXECeMSsBUcwGvku9UlNWcAnCGnAag=';
const SUPABASE_ANON =
  'eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJpc3MiOiJzdXBhYmFzZSIsInJlZiI6Imt6bHVycWloemFvbGh6c2JrY3RmIiwicm9sZSI6ImFub24iLCJpYXQiOjE3NTk4ODkzMzYsImV4cCI6MjA3NTQ2NTMzNn0.oWv0CqdAbVpDsR-pBMn3A9sScgLtWKh0DYc8sXZz3XU';
const USER_ID = '1f85ff25-6e29-4c1b-8739-f917bd101a30';

// Fields consumers actually read (from agent code + backend + FE analysis)
const REQUIRED_CONTENT_FIELDS = [
  'choices',
  'actual_model',
  'requested_model',
  'pool_name',
  'pool_size',
];
const REQUIRED_DELTA_FIELD = 'content';
const _REQUIRED_FINAL_FIELDS = ['finish_reason']; // on choices[0]
const REQUIRED_USAGE_FIELDS = ['prompt_tokens', 'completion_tokens', 'total_tokens'];

// Racing-only fields that consumers don't read — allowed on racing but not required
const RACING_ONLY_FIELDS = new Set(['racing_ttft_ms', 'models_raced', 'timings']);

/** Parse SSE stream into array of data chunks */
async function parseSSE(response) {
  const text = await response.text();
  const chunks = [];
  for (const line of text.split('\n')) {
    if (!line.startsWith('data: ')) continue;
    const data = line.slice(6);
    if (data === '[DONE]') continue;
    try {
      chunks.push(JSON.parse(data));
    } catch { /* skip malformed */ }
  }
  return chunks;
}

/** Fetch Claude OAuth token from backend, or use CLAUDE_TOKEN env var */
async function fetchClaudeToken() {
  // Allow passing token directly via env var (when backend is down)
  if (process.env.CLAUDE_TOKEN) {
    return process.env.CLAUDE_TOKEN;
  }
  const res = await fetch(`${BACKEND_URL}/api/integrations/claude-code/credentials/token`, {
    headers: { 'X-API-Key': BACKEND_API_KEY, 'X-User-Id': USER_ID },
  });
  if (!res.ok) throw new Error(`Token fetch failed: ${res.status} ${await res.text()}`);
  const { accessToken } = await res.json();
  return accessToken;
}

/** Send a streaming completions request */
async function sendRequest(extraBody = {}) {
  const body = {
    model: 'rose-labs/rose-1-lite',
    messages: [{ role: 'user', content: 'Say hello in one sentence.' }],
    max_tokens: 100,
    stream: true,
    stream_options: { include_usage: true },
    ...extraBody,
  };

  const res = await fetch(EDGE_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${SUPABASE_ANON}`,
      'x-api-key': ROSE_API_KEY,
    },
    body: JSON.stringify(body),
  });

  if (!res.ok) throw new Error(`Request failed: ${res.status} ${await res.text()}`);
  return parseSSE(res);
}

/** Extract the set of top-level field names, excluding racing-only fields */
function consumerFields(chunk) {
  return new Set(Object.keys(chunk).filter((k) => !RACING_ONLY_FIELDS.has(k)));
}

/** Validate a chunk array against required fields */
function validateChunks(chunks, label) {
  const errors = [];

  if (chunks.length === 0) {
    errors.push(`${label}: no chunks received`);
    return errors;
  }

  // Split into content chunks and final chunk
  const contentChunks = chunks.filter((c) => c.choices?.[0]?.delta?.content !== undefined);
  const finalChunk = chunks.find((c) => c.choices?.[0]?.finish_reason);

  if (contentChunks.length === 0) {
    errors.push(`${label}: no content chunks found`);
  }
  if (!finalChunk) {
    errors.push(`${label}: no final chunk with finish_reason found`);
  }

  // Validate content chunks
  for (let i = 0; i < contentChunks.length; i++) {
    const chunk = contentChunks[i];
    for (const field of REQUIRED_CONTENT_FIELDS) {
      if (chunk[field] === undefined) {
        errors.push(`${label} content chunk[${i}]: missing '${field}'`);
      }
    }
    const delta = chunk.choices?.[0]?.delta;
    if (delta?.[REQUIRED_DELTA_FIELD] === undefined) {
      errors.push(
        `${label} content chunk[${i}]: missing 'choices[0].delta.${REQUIRED_DELTA_FIELD}'`,
      );
    }
  }

  // Validate final chunk
  if (finalChunk) {
    if (!finalChunk.usage) {
      errors.push(`${label} final chunk: missing 'usage'`);
    } else {
      for (const field of REQUIRED_USAGE_FIELDS) {
        if (finalChunk.usage[field] === undefined) {
          errors.push(`${label} final chunk: missing 'usage.${field}'`);
        }
      }
    }
    for (const field of REQUIRED_CONTENT_FIELDS) {
      if (finalChunk[field] === undefined) {
        errors.push(`${label} final chunk: missing '${field}'`);
      }
    }
  }

  return errors;
}

async function main() {
  console.log('Chunk Conformance Test');
  console.log('='.repeat(50));
  let allPassed = true;

  // ── Test 1: Racing path ──
  console.log('\n[1] Racing path (model_seed=3 → Haiku)');
  const racingChunks = await sendRequest({ model_seed: 3 });
  console.log(`    Received ${racingChunks.length} chunks`);
  console.log(`    actual_model: ${racingChunks[0]?.actual_model}`);

  const racingErrors = validateChunks(racingChunks, 'Racing');
  if (racingErrors.length > 0) {
    racingErrors.forEach((e) => console.log(`    FAIL: ${e}`));
    allPassed = false;
  } else {
    console.log('    PASS: All required fields present');
  }

  // ── Test 2: Claude-auth path ──
  console.log('\n[2] Claude-auth path (claude_token → Sonnet)');
  let claudeToken;
  try {
    claudeToken = await fetchClaudeToken();
    console.log(`    Token fetched: ${claudeToken.slice(0, 20)}...`);
  } catch (e) {
    console.log(`    SKIP: ${e.message}`);
    console.log('    (Mac app must sync credentials first)');
    process.exit(1);
  }

  const claudeChunks = await sendRequest({ claude_token: claudeToken, model_preference: 'SMART' });
  console.log(`    Received ${claudeChunks.length} chunks`);
  console.log(`    actual_model: ${claudeChunks[0]?.actual_model}`);

  const claudeErrors = validateChunks(claudeChunks, 'Claude-auth');
  if (claudeErrors.length > 0) {
    claudeErrors.forEach((e) => console.log(`    FAIL: ${e}`));
    allPassed = false;
  } else {
    console.log('    PASS: All required fields present');
  }

  // ── Test 3: Structural comparison ──
  console.log('\n[3] Structural comparison');
  const racingContentFields = consumerFields(
    racingChunks.find((c) => c.choices?.[0]?.delta?.content !== undefined),
  );
  const claudeContentFields = consumerFields(
    claudeChunks.find((c) => c.choices?.[0]?.delta?.content !== undefined),
  );

  const racingFinal = racingChunks.find((c) => c.choices?.[0]?.finish_reason);
  const claudeFinal = claudeChunks.find((c) => c.choices?.[0]?.finish_reason);
  const racingFinalFields = racingFinal ? consumerFields(racingFinal) : new Set();
  const claudeFinalFields = claudeFinal ? consumerFields(claudeFinal) : new Set();

  // Check that claude-auth has all the fields racing has (minus racing-only)
  const missingContent = [...racingContentFields].filter((f) => !claudeContentFields.has(f));
  const missingFinal = [...racingFinalFields].filter((f) => !claudeFinalFields.has(f));

  if (missingContent.length > 0) {
    console.log(
      `    FAIL: Claude-auth content chunks missing fields present in racing: ${
        missingContent.join(', ')
      }`,
    );
    allPassed = false;
  } else {
    console.log(
      `    PASS: Content chunk fields match (${[...claudeContentFields].sort().join(', ')})`,
    );
  }

  if (missingFinal.length > 0) {
    console.log(
      `    FAIL: Claude-auth final chunk missing fields present in racing: ${
        missingFinal.join(', ')
      }`,
    );
    allPassed = false;
  } else {
    console.log(`    PASS: Final chunk fields match (${[...claudeFinalFields].sort().join(', ')})`);
  }

  // ── Test 4: Content is not raw JSON (the original display bug) ──
  console.log('\n[4] Content display check (no raw JSON in response)');
  const claudeContent = claudeChunks
    .map((c) => c.choices?.[0]?.delta?.content || '')
    .join('');

  // Parse the accumulated JSON and check response field
  try {
    const parsed = JSON.parse(claudeContent);
    const response = parsed.response || '';
    if (response.startsWith('{') && response.includes('"reasoning"')) {
      console.log(
        `    FAIL: response field contains raw JSON (display bug): ${response.slice(0, 80)}`,
      );
      allPassed = false;
    } else {
      console.log(`    PASS: response field is clean text: "${response.slice(0, 60)}..."`);
    }
  } catch {
    // Content might not be JSON (plain text wrapping) — that's fine
    console.log(`    PASS: content is plain text (no JSON to check)`);
  }

  // ── Summary ──
  console.log('\n' + '='.repeat(50));
  if (allPassed) {
    console.log('ALL TESTS PASSED');
  } else {
    console.log('SOME TESTS FAILED');
    process.exit(1);
  }
}

main().catch((e) => {
  console.error('Test error:', e);
  process.exit(1);
});
