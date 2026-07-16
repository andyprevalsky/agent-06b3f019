#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert/strict';
import { ensureAgentCardSandboxFloat } from '../../providers/agentcard/benchmark-float';

async function main(): Promise<void> {
  const calls: Array<{ url: string; method: string; body?: string; authorization: string | null }> =
    [];
  let balanceCents = 1_644;
  const fetchImpl = async (input: RequestInfo | URL, init: RequestInit = {}) => {
    const url = String(input);
    const headers = new Headers(init.headers);
    calls.push({
      url,
      method: init.method ?? 'GET',
      body: typeof init.body === 'string' ? init.body : undefined,
      authorization: headers.get('authorization'),
    });
    if (url.endsWith('/test-fund')) {
      const body = JSON.parse(String(init.body)) as { amountCents: number };
      balanceCents += body.amountCents;
      return Response.json({ sandboxWalletBalanceCents: balanceCents });
    }
    return Response.json({ settings: { sandbox_balance_cents: balanceCents } });
  };

  const admin = { apiUrl: 'https://agentcard.test', token: 'admin-token' };
  const funded = await ensureAgentCardSandboxFloat(admin, 'org-123', 50_000, fetchImpl);
  assert.deepEqual(funded, { previousCents: 1_644, balanceCents: 50_000, addedCents: 48_356 });
  assert.equal(calls[1].body, JSON.stringify({ amountCents: 48_356 }));
  assert.equal(calls[1].authorization, 'Bearer admin-token');

  const unchanged = await ensureAgentCardSandboxFloat(admin, 'org-123', 50_000, fetchImpl);
  assert.deepEqual(unchanged, { previousCents: 50_000, balanceCents: 50_000, addedCents: 0 });
  assert.equal(calls.length, 3, 'a funded pool must not make another POST');
  console.log('AgentCard benchmark sandbox float tests passed');
}

void main();
