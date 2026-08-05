import assert from 'node:assert/strict';
import { TestPaymentError } from '../../domains/test-payment/errors';
import { classifyLifecycleError } from '../../domains/test-payment/lifecycle-errors';
import { AgentCardOrgRuntimeError } from '../../providers/agentcard/org-runtime';

// A domain error keeps its own status.
{
  const result = classifyLifecycleError(
    new TestPaymentError('agentId is required', 400),
    'fallback'
  );
  assert.equal(result.status, 400);
  assert.deepEqual(result.body, { error: 'agentId is required' });
  assert.equal(result.retryAfterSeconds, null);
}

// An org-wide AgentCard MCP rate limit arrives as an opaque transport error. It
// must read as 429 with a retry deadline, not as our own 500 — otherwise every
// caller retries straight back into the same closed window, which is exactly how
// a healthy lifecycle got reported as "cleanup did not complete".
{
  const retryAfterMs = Date.now() + 20_000;
  const result = classifyLifecycleError(
    new Error(
      `Streamable HTTP error: Error POSTing to endpoint: {"error":"Rate limit exceeded","message":"Too many requests. Limit: 120 requests per minute.","retryAfter":${retryAfterMs}}`
    ),
    'Failed to abandon test payment lifecycle'
  );
  assert.equal(result.status, 429, 'upstream rate limit must not be reported as our 500');
  assert.equal(result.body.code, 'agentcard_org_mcp_rate_limited');
  assert(
    typeof result.retryAfterSeconds === 'number' &&
      result.retryAfterSeconds > 0 &&
      result.retryAfterSeconds <= 21,
    `unexpected retryAfterSeconds: ${String(result.retryAfterSeconds)}`
  );
}

// A rate limit with no deadline is still a 429, just without a Retry-After.
{
  const result = classifyLifecycleError(new Error('Rate limit exceeded'), 'fallback');
  assert.equal(result.status, 429);
  assert.equal(result.retryAfterSeconds, null);
}

// An upstream outage keeps the upstream's status rather than flattening to 500.
{
  const result = classifyLifecycleError(
    new AgentCardOrgRuntimeError('organization MCP unavailable', 502),
    'Failed to read test payment lifecycle'
  );
  assert.equal(result.status, 502);
  assert.deepEqual(result.body, {
    error: 'organization MCP unavailable',
    code: 'agentcard_org_mcp_unavailable',
  });
}

{
  const result = classifyLifecycleError(
    new AgentCardOrgRuntimeError('gateway timeout', 504),
    'fallback'
  );
  assert.equal(result.status, 504);
}

// Anything unclassified is a 500 — but it is logged first, never swallowed.
{
  const result = classifyLifecycleError(
    new Error('boom'),
    'Failed to abandon test payment lifecycle'
  );
  assert.equal(result.status, 500);
  assert.deepEqual(result.body, { error: 'Failed to abandon test payment lifecycle' });
}

process.stdout.write('test-payment lifecycle error mapping passed\n');
