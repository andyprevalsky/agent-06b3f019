import assert from 'node:assert/strict';
import { test } from 'node:test';
import { confirmationProof, confirmStall } from '../../../scripts/agentcard-confirm-stall';

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
  assert.equal(result.observations.card.livemode, false);
});
test('confirmation accepts absent card mode without fabricating it', async () => {
  const f = fixture();
  Reflect.deleteProperty(f.card, 'livemode');
  const result = await confirmStall(binding, f.call);
  assert.equal(Object.hasOwn(result.observations.card, 'livemode'), false);
  assert.deepEqual(result.observations.card, {
    id: 'card_fixture',
    status: 'CLOSED',
    balanceCents: 0,
  });
  assert.equal(result.observations.transfer.livemode, false);
  assert.ok(!JSON.stringify(result).includes('SECRET'));
  assert.deepEqual(
    f.calls.map((c) => c.name),
    ['get_card', 'list_transfers']
  );
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

test('optional card mode cannot hide explicit live or malformed card or transfer mode', async () => {
  for (const value of [true, null, undefined, 0, 1, 'false', [], {}]) {
    const f = fixture();
    Reflect.set(f.card, 'livemode', value);
    await assert.rejects(confirmStall(binding, f.call));
  }
  for (const includeCardMode of [true, false]) {
    for (const value of [true, null, undefined, 0, 1, 'false', [], {}]) {
      const f = fixture();
      if (!includeCardMode) Reflect.deleteProperty(f.card, 'livemode');
      Reflect.set(f.transfer, 'livemode', value);
      await assert.rejects(confirmStall(binding, f.call));
    }
    const f = fixture();
    if (!includeCardMode) Reflect.deleteProperty(f.card, 'livemode');
    Reflect.deleteProperty(f.transfer, 'livemode');
    await assert.rejects(confirmStall(binding, f.call));
  }
});

test('a full newer provider page preserves unknown transfer state without leaking other records', async () => {
  const native_finished_at = Date.now() / 1000 - 3600;
  const f = fixture();
  const rows = Array.from({ length: 100 }, (_, i) => ({
    id: `owt_new_${i}`,
    created_at: new Date(Date.now() - 1000 * i).toISOString(),
    private: 'SECRET_OTHER',
    status: 'consumed',
  }));
  const call = async (name: string, args: Record<string, unknown>, deadline?: number) =>
    name === 'list_transfers'
      ? { structuredContent: { transfers: rows } }
      : f.call(name, args, deadline);
  const proof = await confirmationProof({ ...binding, native_finished_at }, call);
  assert.ok('transfer_page' in proof.observations);
  assert.equal(Object.hasOwn(proof.observations, 'transfer'), false);
  assert.equal(proof.observations.transfer_page.row_count, 100);
  assert.ok(proof.observations.transfer_page.oldest_created_at > native_finished_at);
  assert.ok(!JSON.stringify(proof).includes('owt_new_'));
  assert.ok(!JSON.stringify(proof).includes('SECRET'));
  for (const change of [
    (r: typeof rows) => r.pop(),
    (r: typeof rows) => {
      r[0].id = r[1].id;
    },
    (r: typeof rows) => {
      r[0].created_at = new Date(native_finished_at * 1000).toISOString();
    },
    (r: typeof rows) => {
      r[0].created_at = 'invalid';
    },
    (r: typeof rows) => {
      r[0].id = binding.transfer_id;
    },
  ]) {
    const altered = structuredClone(rows);
    change(altered);
    await assert.rejects(
      confirmationProof({ ...binding, native_finished_at }, async (name, args, deadline) =>
        name === 'list_transfers'
          ? { structuredContent: { transfers: altered } }
          : f.call(name, args, deadline)
      )
    );
  }
});
