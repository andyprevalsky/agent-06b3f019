#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import {
  selectTreasuryRailCardholder,
  waitForIdleTreasuryRailCardholder,
} from './treasury-rails-cardholder';

type Card = { id: string; status: string };

function fakeOrg(cardsByHolder: Record<string, Card[]>): {
  listed: string[];
  callOrgTool: (name: string, args: Record<string, unknown>) => Promise<unknown>;
} {
  const listed: string[] = [];
  return {
    listed,
    callOrgTool: async (name, args) => {
      if (name !== 'list_cards') throw new Error(`Unexpected AgentCard tool ${name}`);
      const cardholderId = String(args.cardholder_id);
      listed.push(cardholderId);
      return { structuredContent: { cards: cardsByHolder[cardholderId] ?? [] } };
    },
  };
}

async function main(): Promise<void> {
  {
    // 2026-10-06: the payment-benchmark cardholder was listed first and idle, so the reclaim
    // proof minted there and a foreign lifecycle mint consumed its unused transfer.
    const org = fakeOrg({
      'ch-payment-float': [{ id: 'card-old', status: 'CLOSED' }],
      'ch-quiet': [{ id: 'card-treasury', status: 'CLOSED' }],
    });
    const selected = await selectTreasuryRailCardholder(
      ['ch-payment-float', 'ch-quiet'],
      'ch-payment-float',
      org.callOrgTool
    );
    assert.equal(selected, 'ch-quiet', 'an idle non-payment cardholder must be preferred');
    assert.deepEqual(org.listed, ['ch-quiet'], 'the shared cardholder needs no read once avoided');
  }

  {
    const org = fakeOrg({
      'ch-payment-float': [],
      'ch-quiet': [{ id: 'card-foreign', status: 'OPEN' }],
    });
    const selected = await selectTreasuryRailCardholder(
      ['ch-payment-float', 'ch-quiet'],
      'ch-payment-float',
      org.callOrgTool
    );
    assert.equal(
      selected,
      'ch-payment-float',
      'the shared cardholder remains the last idle choice'
    );
    assert.deepEqual(org.listed, ['ch-quiet', 'ch-payment-float']);
  }

  {
    const org = fakeOrg({
      'ch-payment-float': [{ id: 'card-checkout', status: 'OPEN' }],
      'ch-quiet': [{ id: 'card-foreign', status: 'OPEN' }],
    });
    const selected = await selectTreasuryRailCardholder(
      ['ch-payment-float', 'ch-quiet'],
      'ch-payment-float',
      org.callOrgTool
    );
    assert.equal(selected, undefined, 'a cardholder with an OPEN card must never be chosen');
  }

  {
    const org = fakeOrg({ 'ch-a': [{ id: 'card-a', status: 'OPEN' }], 'ch-b': [] });
    const selected = await selectTreasuryRailCardholder(
      ['ch-a', 'ch-b'],
      undefined,
      org.callOrgTool
    );
    assert.equal(selected, 'ch-b', 'without a payment cardholder, the first idle one is chosen');
  }

  {
    // 2026-10-12: a foreign workspace's payment run held an OPEN card on every sandbox
    // cardholder for a few minutes, and one immediate read failed the deploy gate. The proof
    // waits for a cardholder it observes idle instead.
    let polls = 0;
    const slept: number[] = [];
    const selected = await waitForIdleTreasuryRailCardholder(
      ['ch-payment-float', 'ch-quiet'],
      'ch-payment-float',
      async (_name, args) => {
        const cardholderId = String(args.cardholder_id);
        if (cardholderId === 'ch-quiet') polls += 1;
        const busy = polls < 3;
        return {
          structuredContent: { cards: busy ? [{ id: 'card-foreign', status: 'OPEN' }] : [] },
        };
      },
      { timeoutMs: 60_000, pollMs: 5_000, sleep: async (ms) => void slept.push(ms) }
    );
    assert.equal(selected, 'ch-quiet', 'the proof must use a cardholder once it is observed idle');
    assert.deepEqual(slept, [5_000, 5_000], 'it re-reads every poll interval until one is idle');
  }

  {
    let now = 0;
    const selected = await waitForIdleTreasuryRailCardholder(
      ['ch-a'],
      undefined,
      async () => ({ structuredContent: { cards: [{ id: 'card-a', status: 'OPEN' }] } }),
      {
        timeoutMs: 20_000,
        pollMs: 5_000,
        sleep: async (ms) => {
          now += ms;
        },
        now: () => now,
      }
    );
    assert.equal(selected, undefined, 'a cardholder that never goes idle is never chosen');
    assert.equal(now, 20_000, 'the wait is bounded by its timeout');
  }

  console.log('Treasury rails cardholder selection blackbox passed');
}

void main();
