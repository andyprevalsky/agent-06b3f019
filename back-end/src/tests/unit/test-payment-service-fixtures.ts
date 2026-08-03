import assert from 'node:assert/strict';
import { agentCardSummaryFromMcpResult } from '../../domains/test-payment/lifecycleProviderRecords';

export function threeItems(): Array<{ id: string; quantity: number }> {
  return [
    { id: 'aurora-notebook', quantity: 1 },
    { id: 'copper-pen', quantity: 1 },
    { id: 'ceramic-mug', quantity: 1 },
  ];
}

export function assertClosedCardMcpParsing(): void {
  const closed = { status: 'closed', balanceCents: 0 };
  assert.deepEqual(
    agentCardSummaryFromMcpResult({
      isError: true,
      structuredContent: { error: { code: 'card_closed' } },
    }),
    closed
  );
  assert.deepEqual(
    agentCardSummaryFromMcpResult({ structuredContent: { code: 'card_closed' } }),
    closed
  );
  assert.deepEqual(
    agentCardSummaryFromMcpResult({
      content: [{ type: 'text', text: JSON.stringify({ error: { code: 'card_closed' } }) }],
    }),
    closed
  );
  assert.throws(
    () =>
      agentCardSummaryFromMcpResult({
        isError: true,
        structuredContent: { error: { code: 'provider_unavailable' } },
      }),
    /AgentCard lifecycle request returned an error/
  );
}
