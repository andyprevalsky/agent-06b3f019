#!/usr/bin/env tsx

import assert from 'node:assert';
import { buildChatTemporalStartParams } from '../../providers/chat/chatHandler';

const params = buildChatTemporalStartParams({
  agentId: 'agent-ultra',
  userId: 'user-1',
  goal: 'refined goal',
  startPhase: 'execute',
  agent: {
    goal: 'persisted goal',
    model: 'rose-labs/rose-1-ultra',
    reasoningMaxTokens: 16_000,
    verifier: { type: 'default' },
    priceLimitCents: 100,
    fastModeCacheEnabled: true,
  },
});

assert.strictEqual(params.model, 'rose-labs/rose-1-ultra');
assert.strictEqual(params.goal, 'refined goal');
assert.strictEqual(params.startPhase, 'execute');
assert.strictEqual(params.fastModeCacheEnabled, true);

process.stdout.write('PASS Temporal escalation preserves the requested Ultra model\n');
