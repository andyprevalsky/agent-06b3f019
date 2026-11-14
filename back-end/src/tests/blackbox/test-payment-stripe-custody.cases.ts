import assert from 'node:assert/strict';
import { PurchaseSpendStatus } from '@prisma/client';
import { getTestPaymentLifecycle } from '../../domains/test-payment/lifecycle';

export async function assertAllStripeCustodyContract(base: Record<string, unknown>): Promise<void> {
  const failed = {
    id: 'p-initial',
    userId: 'rose-user',
    agentId: 'a-v2',
    status: PurchaseSpendStatus.FAILED,
    totalCents: 4396,
    stripeLivemode: false,
    stripeCustomerId: 'cus-owned',
    stripePaymentIntentId: 'pi-initial',
  };
  const paid = {
    ...failed,
    id: 'p-v2',
    status: PurchaseSpendStatus.CLEARED,
    stripePaymentIntentId: 'pi-v2',
  };
  const native = (row: typeof failed, status: string, received: number, capturable = 0) => ({
    id: row.stripePaymentIntentId,
    livemode: row.stripeLivemode,
    customer: row.stripeCustomerId,
    amount: row.totalCents,
    currency: 'usd',
    status,
    amount_received: received,
    amount_capturable: capturable,
    metadata: { userId: row.userId, agentId: row.agentId, purchaseSpendId: row.id },
  });
  const requests: string[] = [];
  let initial = native(failed, 'canceled', 0);
  let inventory = ['pi-initial', 'pi-v2'];
  let refunds = [
    { id: 're-complete', payment_intent: 'pi-initial', amount: 4396, status: 'succeeded' },
  ];
  let hasMore = false;
  let paidRefunds: typeof refunds = [];
  let listPages = false;
  let listCorruption: string | undefined;
  const listRequests: Array<[boolean, string, string | undefined]> = [];
  const deps = {
    ...base,
    includeStripeCustody: true,
    findStripePurchases: async () => [failed, paid],
    getCustodyStripeClient: (mode: boolean) => {
      return {
        paymentIntents: {
          retrieve: async (id: string) => {
            assert.equal(
              mode,
              id === 'pi-initial' ? failed.stripeLivemode : paid.stripeLivemode,
              'use immutable purchase mode'
            );
            requests.push('GET:' + id);
            return id === 'pi-initial' ? initial : native(paid, 'succeeded', 4396);
          },
          // Search is deliberately stale. It must not supply fresh custody completeness.
          search: async () => ({ data: [{ id: 'pi-initial' }], has_more: false }),
          list: async (args: { customer: string; starting_after?: string }) => {
            listRequests.push([mode, args.customer, args.starting_after]);
            const initialRow = native(failed, 'canceled', 0);
            const paidRow = native(paid, 'succeeded', 4396);
            const rows = inventory
              .map((id) =>
                id === 'pi-initial'
                  ? initialRow
                  : id === 'pi-v2'
                    ? paidRow
                    : {
                        ...initialRow,
                        id,
                        metadata: { ...initialRow.metadata, purchaseSpendId: 'p-orphan' },
                      }
              )
              .filter((row) => row.livemode === mode && row.customer === args.customer);
            if (listCorruption === 'mode') rows[0].livemode = !mode;
            if (listCorruption === 'customer') rows[0].customer = 'cus-foreign';
            if (listCorruption === 'user') rows[0].metadata.userId = 'foreign';
            if (listCorruption === 'metadata') rows[0].metadata = [] as never;
            if (listCorruption === 'duplicate') rows.push({ ...rows[0] });
            if (listCorruption === 'empty-page') return { data: [], has_more: true };
            if (listPages && !args.starting_after)
              return {
                data: [
                  {
                    ...initialRow,
                    id: 'pi-other-agent',
                    livemode: mode,
                    customer: args.customer,
                    metadata: {
                      userId: 'other-user',
                      agentId: 'other-agent',
                      purchaseSpendId: 'other-purchase',
                    },
                  },
                ],
                has_more: true,
              };
            if (listPages) assert.equal(args.starting_after, 'pi-other-agent');
            return { data: rows, has_more: false };
          },
        },
        refunds: {
          list: async (args: { payment_intent: string; starting_after?: string }) => {
            if (args.payment_intent === 'pi-v2') {
              requests.push('REFUNDS:pi-v2');
              return { data: paidRefunds, has_more: false };
            }
            assert.equal(args.payment_intent, 'pi-initial');
            requests.push('REFUNDS:' + String(args.starting_after));
            if (hasMore && !args.starting_after)
              return { data: [{ ...refunds[0], amount: 2000 }], has_more: true };
            return {
              data: hasMore ? [{ ...refunds[0], id: 're-second', amount: 2396 }] : refunds,
              has_more: false,
            };
          },
        },
      };
    },
  };
  const read = () => getTestPaymentLifecycle('a-v2', deps as never);
  const result = await read();
  assert.equal(
    result.stripeCustody?.length,
    2,
    'all persisted same-agent intents need external custody proof'
  );
  assert.equal(result.stripeCustody?.[0].outcome, 'unspent');
  assert.equal(result.stripeCustody?.[1].outcome, 'paid');
  assert.deepEqual(requests, ['GET:pi-initial', 'GET:pi-v2', 'REFUNDS:pi-v2']);
  assert.deepEqual(
    listRequests,
    [[false, 'cus-owned', undefined]],
    'complete list is scoped to immutable customer and mode'
  );
  listPages = true;
  assert.equal(
    (await read()).stripeCustody?.length,
    2,
    'paginate over unrelated agents on the same customer'
  );
  listPages = false;
  for (const bad of [
    native(failed, 'requires_capture', 0, 4396),
    native(failed, 'succeeded', 4396),
  ]) {
    initial = bad;
    refunds = [];
    await assert.rejects(
      read(),
      /custody|refund|exposure/i,
      'local FAILED must not hide active or unrefunded Stripe money'
    );
  }
  initial = native(failed, 'succeeded', 4396);
  hasMore = true;
  refunds = [{ id: 're-first', payment_intent: 'pi-initial', amount: 4396, status: 'succeeded' }];
  assert.equal(
    (await read()).stripeCustody?.[0].refundedCents,
    4396,
    'exact refunds require complete pagination'
  );
  hasMore = false;
  for (const delta of [
    { livemode: true },
    { customer: 'cus-foreign' },
    { amount: 1 },
    { metadata: { ...initial.metadata, userId: 'foreign' } },
    { metadata: { ...initial.metadata, purchaseSpendId: 'foreign' } },
    { metadata: { ...initial.metadata, agentId: 'foreign' } },
  ]) {
    initial = { ...native(failed, 'canceled', 0), ...delta };
    await assert.rejects(read(), /identity|intent|mode|customer|custody/i);
  }
  initial = native(failed, 'succeeded', 4396);
  refunds = [{ id: 're-pending', payment_intent: 'pi-initial', amount: 4396, status: 'pending' }];
  await assert.rejects(read(), /custody|refund/i);
  refunds = [{ id: 're-foreign', payment_intent: 'pi-foreign', amount: 4396, status: 'succeeded' }];
  await assert.rejects(read(), /identity|refund|custody/i);
  initial = native(failed, 'canceled', 0);
  inventory = ['pi-v2'];
  await assert.rejects(read(), /inventory|coverage|custody/i);
  inventory = ['pi-initial', 'pi-v2', 'pi-orphan'];
  await assert.rejects(read(), /inventory|coverage|custody/i);
  inventory = ['pi-initial', 'pi-v2'];
  for (listCorruption of ['mode', 'customer', 'user', 'metadata', 'duplicate', 'empty-page']) {
    await assert.rejects(
      read(),
      /inventory|custody/i,
      'malformed or incomplete customer lists cannot prove inventory'
    );
  }
  listCorruption = undefined;

  paidRefunds = [
    { id: 're-paid-pending', payment_intent: 'pi-v2', amount: 4396, status: 'pending' },
  ];
  await assert.rejects(
    read(),
    /refund|custody/i,
    'pending refund must not be called verified paid custody'
  );
  paidRefunds[0].status = 'succeeded';
  await assert.rejects(
    read(),
    /refund|custody/i,
    'returned paid funds must not be called a paid chain'
  );
  paidRefunds = [];
  paid.stripeLivemode = true;
  paid.stripeCustomerId = 'cus-live';
  const { observeStripeCustody } =
    await import('../../domains/test-payment/lifecycleStripeCustody');
  const mixed = await observeStripeCustody('a-v2', deps);
  assert.deepEqual(
    mixed.map((row) => [row.paymentIntentId, row.livemode, row.customerId]),
    [
      ['pi-initial', false, 'cus-owned'],
      ['pi-v2', true, 'cus-live'],
    ],
    'historical per-purchase modes and customers must not follow the latest user mode'
  );
  process.stdout.write('all-intents Stripe custody default lifecycle contract passed\n');
}
