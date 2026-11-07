import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmStall } from '../../../scripts/agentcard-confirm-stall';

const binding = {
  kind: 'agentcard-release-stall-renewal-v1',
  producer_sha256: 'test',
  card_id: 'card_fixture',
  transfer_id: 'owt_fixture',
  amount_cents: 1234,
};
function fixture() {
  const card = {
    id: 'card_fixture',
    status: 'closed',
    balance_cents: 0,
    livemode: false,
    pan: 'SECRET_PAN',
    cvv: 'SECRET_CVV',
  };
  const transfer = {
    id: 'owt_fixture',
    card_id: 'card_fixture',
    status: 'consumed',
    livemode: false,
    amount_cents: 1234,
    transferred_cents: 1234,
    released_cents: 0,
    secret: 'SECRET_OTHER',
  };
  const calls: Array<{ name: string; args: Record<string, unknown>; deadline?: number }> = [];
  const call = async (name: string, args: Record<string, unknown>, deadline?: number) => {
    calls.push({ name, args, deadline });
    if (name === 'get_card') return { structuredContent: { card } };
    if (name === 'list_transfers') return { structuredContent: { transfers: [transfer] } };
    throw new Error('Forbidden provider tool');
  };
  return { card, transfer, calls, call };
}
test('confirmation calls only two allowlisted reads with one retry deadline and redacts data', async () => {
  const f = fixture();
  const result = await confirmStall(binding, f.call);
  assert.deepEqual(
    f.calls.map((c) => [c.name, c.args]),
    [
      ['get_card', { card_id: 'card_fixture' }],
      ['list_transfers', { status: 'consumed', limit: 100 }],
    ]
  );
  assert.equal(f.calls[0].deadline, f.calls[1].deadline);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.ok(result.started_at <= result.finished_at);
  assert.equal(result.observations.transfer.amountCents, 1234);
});
test('confirmation fails closed on live, released, wrong identity and malformed metadata', async () => {
  for (const mutate of [
    (f: ReturnType<typeof fixture>) => {
      f.card.livemode = true;
    },
    (f: ReturnType<typeof fixture>) => {
      f.transfer.released_cents = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.transfer.id = 'owt_wrong';
    },
    (f: ReturnType<typeof fixture>) => {
      f.card.balance_cents = 1;
    },
    (f: ReturnType<typeof fixture>) => {
      f.transfer.transferred_cents = 0;
    },
  ]) {
    const f = fixture();
    mutate(f);
    await assert.rejects(confirmStall(binding, f.call));
  }
});
