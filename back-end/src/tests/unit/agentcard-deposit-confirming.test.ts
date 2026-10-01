#!/usr/bin/env tsx

import assert from 'node:assert';
import { AgentCardOrgMcpProvider, AgentCardProviderError } from '../../providers/card-provider';

async function main(): Promise<void> {
  const provider = new AgentCardOrgMcpProvider('cardholder-123', async () => ({
    structuredContent: { status: 'deposit_confirming', retryAfterSeconds: 7 },
    content: [{ type: 'text', text: 'deposit_confirming' }],
  }));

  await assert.rejects(
    () =>
      provider.mintCard({
        amountCents: 4396,
        fundsSource: 'company_flow',
        idempotencyKey: 'purchase:deposit-confirming',
      }),
    (error: unknown) =>
      error instanceof AgentCardProviderError &&
      error.code === 'agentcard_company_funding_in_progress' &&
      error.details?.agentcardStatus === 'deposit_confirming' &&
      error.details?.retryAfterSeconds === 7
  );
}

main().catch((error) => {
  throw error;
});
