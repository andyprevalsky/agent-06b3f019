import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { writeFile } from 'node:fs/promises';
import { AgentCardV2Client } from '../../providers/agentcard/api-v2';
import { AgentCardV2Provider } from '../../providers/card-provider/agentcard-v2';
import { retryWithBackoff } from '../../providers/retry';
import { AgentCardProviderError } from '../../providers/card-provider/errors';

/** Opt-in real provider proof, isolated sandbox identity, no deliverable email or real charges. */
export async function verifyLiveSandboxV2(): Promise<void> {
  const api = new AgentCardV2Client().request;
  const wallet = await api('GET', '/api/v2/company_wallet');
  assert.equal(wallet.livemode, false, 'sandbox lifecycle refuses production credentials');
  assert.equal(wallet.default_funds_source, 'company_flow');
  const runId = randomUUID();
  // .invalid cannot route email to another person. Sandbox verifies with the documented 111111.
  const attempt = await api('POST', '/api/v2/connect/start', {
    email: `rose-v2-${runId}@example.invalid`,
    external_user_id: `sandbox-contract:${runId}`,
  });
  assert.equal(typeof attempt.id, 'string');
  const connection = await api('POST', '/api/v2/connect/verify', {
    connect_id: attempt.id,
    code: '111111',
  });
  const user = connection.user as { id?: unknown } | undefined;
  assert.equal(typeof user?.id, 'string');
  const providerUserId = String(user?.id);
  await api('POST', '/api/v2/connect/consent', { user_id: providerUserId });
  const provider = new AgentCardV2Provider(providerUserId, api);
  const intent = {
    amountCents: 100,
    fundsSource: 'company_flow' as const,
    idempotencyKey: `v2-contract:${runId}`,
    expectedLivemode: false,
  };
  let cardId: string | undefined;
  let transferId: string | undefined;
  let charged = false;
  try {
    const deadline = Date.now() + 90_000;
    const waitMs = (error: unknown): number =>
      error instanceof AgentCardProviderError && typeof error.details.retryAfterSeconds === 'number'
        ? error.details.retryAfterSeconds * 1000
        : 5000;
    const isPending = (error: unknown): error is AgentCardProviderError =>
      error instanceof AgentCardProviderError &&
      error.code === 'agentcard_company_funding_in_progress';
    const minted = await retryWithBackoff(
      async () => {
        try {
          return await provider.mintCard(intent);
        } catch (error) {
          if (!isPending(error)) throw error;
          if (typeof error.details.transferId === 'string') {
            transferId = error.details.transferId;
            await api(
              'POST',
              `/api/v2/company_wallet/transfers/${encodeURIComponent(transferId)}/collection`,
              { outcome: 'succeeded' }
            );
          }
          throw error;
        }
      },
      {
        maxRetries: 20,
        component: 'AgentCardV2SandboxContract',
        isRetryable: (error) => isPending(error) && Date.now() + waitMs(error) < deadline,
        getBackoffDelayMs: waitMs,
      }
    );
    cardId = minted.cardId;
    transferId = minted.providerTransferId;
    if (process.env.AGENTCARD_V2_FIXTURE_RECEIPT)
      await writeFile(
        process.env.AGENTCARD_V2_FIXTURE_RECEIPT,
        JSON.stringify(
          { sandbox: true, providerUserId, cardId, transferId, status: 'minted', runId },
          null,
          2
        )
      );
    assert.equal(minted.status, 'OPEN');
    assert.equal(minted.balanceCents, 100);
    assert.ok(minted.pan && minted.cvv);
    const replay = await provider.mintCard(intent);
    assert.equal(replay.cardId, cardId);
    assert.equal(replay.providerTransferId, transferId);
    const transaction = await api(
      'POST',
      `/api/v2/cards/${encodeURIComponent(cardId)}/test_charge`,
      { amount_cents: 100, merchant: 'Rose v2 contract' }
    );
    assert.equal(transaction.status, 'cleared');
    assert.equal(transaction.card_id, cardId);
    assert.equal(transaction.amount_cents, 100);
    assert.equal(transaction.simulated, true);
    charged = true;
    const closed = await api('GET', `/api/v2/cards/${encodeURIComponent(cardId)}`);
    assert.equal(closed.status, 'closed');
    assert.equal(closed.balance_cents, 0);
    // Financial truth is the cleared transaction; the sandbox currently labels used cards
    // 'canceled' despite documenting 'used'. Preserve that provider discrepancy as evidence.
    if (closed.closed_reason !== 'used')
      console.log(
        `Provider discrepancy: charged sandbox card closed_reason=${String(closed.closed_reason)}`
      );
    if (process.env.AGENTCARD_V2_FIXTURE_RECEIPT)
      await writeFile(
        process.env.AGENTCARD_V2_FIXTURE_RECEIPT,
        JSON.stringify(
          {
            sandbox: true,
            providerUserId,
            cardId,
            transferId,
            status: 'cleared',
            idempotent: true,
            closedReason: closed.closed_reason,
            transactionId: transaction.id,
          },
          null,
          2
        )
      );
    console.log(
      'PASS real sandbox v2 connect, consent, card mint, same-key reuse, test charge and automatic closure'
    );
  } finally {
    if (cardId) {
      await provider.closeCard(cardId);
      if (!charged) {
        // Close and request one exact-owned recovery; never sweep other users or mint another card.
        await api(
          'POST',
          '/api/v2/company_wallet/recoveries',
          { user_id: providerUserId, amount_cents: 100 },
          `v2-contract-recovery:${runId}`
        );
      }
    } else if (transferId) {
      await api(
        'POST',
        `/api/v2/company_wallet/transfers/${encodeURIComponent(transferId)}/collection`,
        { outcome: 'failed' }
      );
    }
  }
}
