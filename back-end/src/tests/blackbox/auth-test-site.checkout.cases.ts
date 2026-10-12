/**
 * Rose Shop checkout integrity cases: what a payment that did not settle, or
 * that already paid for another checkout, leaves behind. Registered by
 * auth-test-site.blackbox.ts.
 */

import {
  assert,
  attemptTrail as trail,
  cartWithTote,
  cleanup,
  createMintedIdentity,
  createUser,
  fetchReport,
  pagePath,
  postForm,
  seedShop as seed,
  SHOP_CARD as CARD,
  test,
  withLocalSite,
  withSettler,
} from './auth-test-site.testkit';

test("a settlement outage is the route's error, not a declined card", async () => {
  // Only a refused card asks the shopper to fix their card details. A cleared
  // purchase missing its Stripe hold (502) must surface as an error, never as
  // "card_declined" guidance to retype a valid card.
  const userId = await createUser();
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async (charges) => {
        const manifest = await seed(base, userId, 'guest_purchase');
        const cart = await cartWithTote(base, manifest);
        await postForm(base, pagePath(manifest, '/checkout/guest'), {}, cart);
        const outage = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert(
          outage.status >= 500,
          `an operational settlement failure must not read as a declined card: ${outage.status}`
        );
        const report = await fetchReport(base, manifest.siteId);
        assert(report.orders.length === 0, 'no order may exist after a settlement outage');
        assert(
          !report.attempts.some((attempt) => attempt.reason === 'card_declined'),
          `outage recorded as card_declined: ${JSON.stringify(report.attempts)}`
        );
        assert(charges.length === 1, 'settlement was attempted once');
      }, 'outage');
    });
  } finally {
    await cleanup(userId);
  }
});

test('a settled purchase pays for one checkout: another site cannot order against it', async () => {
  // Settlement replays a cleared purchase for the same card and total without
  // charging again. That replay belongs to the checkout that was charged; a
  // second site presenting the same card and total used to get a paid order
  // with no second charge.
  const userId = await createUser();
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async () => {
        const first = await seed(base, userId, 'guest_purchase');
        const firstCart = await cartWithTote(base, first);
        await postForm(base, pagePath(first, '/checkout/guest'), {}, firstCart);
        const paid = await postForm(base, pagePath(first, '/checkout'), CARD, firstCart);
        assert((paid.headers.get('location') ?? '').includes('/orders/ORD-'), 'first order placed');

        const second = await seed(base, userId, 'guest_purchase');
        assert(second.siteId !== first.siteId, 'the second checkout is a different site');
        const secondCart = await cartWithTote(base, second);
        await postForm(base, pagePath(second, '/checkout/guest'), {}, secondCart);
        const replayed = await postForm(base, pagePath(second, '/checkout'), CARD, secondCart);
        assert(
          !(replayed.headers.get('location') ?? '').includes('/orders/'),
          `a purchase another site already ordered against must not pay here: ${replayed.status} ${replayed.headers.get('location')}`
        );
        const secondReport = await fetchReport(base, second.siteId);
        assert(
          secondReport.orders.length === 0,
          `no order may exist without its own charge: ${JSON.stringify(secondReport.orders)}`
        );
        assert(
          secondReport.attempts.some((attempt) => attempt.reason === 'card_declined'),
          `the unpaid checkout must read as a declined card: ${JSON.stringify(secondReport.attempts)}`
        );
        const firstReport = await fetchReport(base, first.siteId);
        assert(firstReport.orders.length === 1, 'the paid order is untouched');
      });
    });
  } finally {
    await cleanup(userId);
  }
});

test('a declined card places no order', async () => {
  const userId = await createUser();
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async () => {
        const manifest = await seed(base, userId, 'guest_purchase');
        const cart = await cartWithTote(base, manifest);
        await postForm(base, pagePath(manifest, '/checkout/guest'), {}, cart);
        const incomplete = await postForm(
          base,
          pagePath(manifest, '/checkout'),
          { ...CARD, cardNumber: '42' },
          cart
        );
        assert(
          (await incomplete.text()).includes('Enter the card number'),
          'card must be complete'
        );
        const declined = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert((await declined.text()).includes('card was declined'), 'decline must be shown');
        const report = await fetchReport(base, manifest.siteId);
        assert(report.orders.length === 0, 'a declined card places no order');
        assert(trail(report).includes('order:rejected:card_declined'), `trail ${trail(report)}`);
      }, 'decline');
    });
  } finally {
    await cleanup(userId);
  }
});
