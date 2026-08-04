#!/usr/bin/env tsx

/**
 * Key-agnostic structured-output GMV extraction.
 * Requires USD amount + confirmation/order id; rejects payment-boundary falses.
 */

import assert from 'node:assert/strict';

import { extractStructuredGmv } from '../../domains/purchases/structuredGmvExtract';

assert.equal(
  extractStructuredGmv({
    merchant: 'Blue Bottle Coffee',
    checkout_total: '$18.50',
    order_confirmation_id: 'BB-998877',
  })?.totalCents,
  1850
);

assert.equal(
  extractStructuredGmv({
    result: { payment: { total_cents: 2499, confirmation_code: 'tp_abcdef12' } },
  })?.confirmationId,
  'tp_abcdef12'
);

assert.equal(
  extractStructuredGmv({
    merchant: 'DoorDash',
    checkout_total: 32.1,
    // no confirmation id
  }),
  null
);

assert.equal(
  extractStructuredGmv({
    order_total: 12.0,
    order_id: 'ORD-12345',
    order_placed: false,
  }),
  null
);

assert.equal(
  extractStructuredGmv({
    amount: 'see cart',
    order_id: 'ORD-999',
  }),
  null
);

assert.equal(
  extractStructuredGmv({
    total_cents: 100,
    confirmation_code: 'n/a',
  }),
  null
);

const amazon = extractStructuredGmv({
  order_confirmation_id: '111-2222222-3333333',
  item_price_usd: 14.99,
  merchant: 'Amazon',
});
assert.ok(amazon !== null);
assert.equal(amazon.totalCents, 1499);
assert.equal(amazon.confirmationId, '111-2222222-3333333');
assert.equal(amazon.merchant, 'Amazon');

const beanie = extractStructuredGmv({
  purchase_completed: true,
  order_confirmation_id: '106-8124526-2047424',
  selected_beanie_price_usd: 19.99,
  selected_beanie_title: 'Carhartt Mens Knit Cuffed Beanie Hat, Black',
});
assert.ok(beanie !== null);
assert.equal(beanie.totalCents, 1999);
assert.equal(beanie.confirmationId, '106-8124526-2047424');

// Card PAN fields are payment instruments, not order confirmations.
assert.equal(
  extractStructuredGmv({
    checkout_total: 43.96,
    one_time_payment_card_number: '4242424242426755',
  }),
  null
);

// Prose "no confirmation" must not count as an order id.
assert.equal(
  extractStructuredGmv({
    item_subtotal_usd: 42.44,
    order_confirmation_id: 'No confirmation ID—order was not placed.',
  }),
  null
);

process.stdout.write('structured gmv extract: passed\n');
