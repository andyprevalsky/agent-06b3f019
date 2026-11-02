#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import { cleanupTreasuryRailCards } from './treasury-rails-card-cleanup';

async function main(): Promise<void> {
  const cards = [
    { id: 'card-created-here', status: 'OPEN' },
    { id: 'card-from-other-run', status: 'OPEN' },
  ];
  const closeCalls: string[] = [];
  const callOrgTool = async (name: string, args: Record<string, unknown>): Promise<unknown> => {
    if (name === 'list_cards') return { structuredContent: { cards } };
    if (name === 'close_card') {
      const cardId = String(args.card_id);
      closeCalls.push(cardId);
      const card = cards.find((row) => row.id === cardId);
      assert.ok(card, 'close_card must target a card returned by the provider');
      card.status = 'CLOSED';
      return { structuredContent: { status: 'CLOSED' } };
    }
    throw new Error(`Unexpected AgentCard tool ${name}`);
  };

  const closed = await cleanupTreasuryRailCards(
    'shared-cardholder',
    new Set(['card-created-here']),
    callOrgTool
  );
  assert.equal(closed, 1, 'cleanup must close its own OPEN card');
  assert.deepEqual(closeCalls, ['card-created-here'], 'cleanup must not close a foreign OPEN card');
  assert.equal(cards[1].status, 'OPEN', 'foreign OPEN card must remain usable');
  let redundantReads = 0;
  const primary = new Error('Invalid or expired organization token');
  await assert.rejects(
    async () => {
      try {
        throw primary;
      } finally {
        await cleanupTreasuryRailCards('shared-cardholder', new Set(), async () => {
          redundantReads += 1;
          throw new Error('list_cards rate limit exhausted');
        });
      }
    },
    (error: unknown) => error === primary,
    'cleanup must preserve a failure after confirmed closure'
  );
  assert.equal(redundantReads, 0, 'no unresolved owned card requires no provider lookup');
  console.log('Treasury rails owned-card cleanup blackbox passed');
}

void main();
