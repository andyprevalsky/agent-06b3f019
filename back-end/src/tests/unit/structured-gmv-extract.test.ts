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

// *_cents keys with formatted strings must stay in cents (not *100).
assert.equal(
  extractStructuredGmv({
    total_cents: '1,250',
    order_id: 'ORD-CENTS-FMT',
  })?.totalCents,
  1250
);
assert.equal(
  extractStructuredGmv({
    total_cents: '$1250',
    confirmation_code: 'CONF-CENTS-DOLLAR',
  })?.totalCents,
  1250
);

// List-nested structured outputs must yield amount + confirmation.
const listNested = extractStructuredGmv({
  result: [{ order_id: 'ORD-A1', total: 42.0 }],
});
assert.ok(listNested !== null);
assert.equal(listNested.totalCents, 4200);
assert.equal(listNested.confirmationId, 'ORD-A1');

// setup-resume / browser completion shape: total_amount_paid must win over
// purchased_products[].price (otherwise GMV records $12 + "unknown merchant").
const setupResume = extractStructuredGmv({
  total_amount_paid: 43.96,
  purchased_products: [
    { name: 'Aurora Notebook', price: 12 },
    { name: 'Ceramic Mug', price: 9 },
    { name: 'Canvas Tote', price: 15 },
  ],
  order_confirmation_id: 'tp_60b2f90f',
});
assert.ok(setupResume !== null);
assert.equal(setupResume.totalCents, 4396);
assert.equal(setupResume.confirmationId, 'tp_60b2f90f');
assert.equal(setupResume.amountKey, 'total_amount_paid');

const totalPaid = extractStructuredGmv({
  total_paid: '$43.96',
  purchased_products: ['Aurora Notebook', 'Ceramic Mug', 'Canvas Tote'],
  order_confirmation_id: 'tp_66930a77',
});
assert.ok(totalPaid !== null);
assert.equal(totalPaid.totalCents, 4396);
assert.equal(totalPaid.amountKey, 'total_paid');

// Prod 2026-10-07: Amazon checkout reported price_usd 14.94 + total_usd 16.23;
// GMV is the charged total, not the unit price.
const crest = extractStructuredGmv({
  price_usd: 14.94,
  tax_usd: 1.29,
  total_usd: 16.23,
  order_placed: true,
  order_confirmation: '106-0856574-8904222',
});
assert.ok(crest !== null);
assert.equal(crest.totalCents, 1623);

// Prod 2026-09-28: an order-history lookup listed past orders; a list of
// per-order totals is not one checkout, so it is never GMV.
assert.equal(
  extractStructuredGmv({
    items: [
      { title: 'Ice Cube Tray', order_total: '$10.85', order_id: '114-1111111-1111111' },
      { title: 'Bath Mat', order_total: '$30.39', order_id: '114-2222222-2222222' },
    ],
  }),
  null
);

process.stdout.write('structured gmv extract: passed\n');
