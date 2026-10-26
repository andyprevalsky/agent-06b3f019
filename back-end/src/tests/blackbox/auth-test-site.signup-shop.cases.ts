/**
 * Rose Shop sign-up and shop cases: creating an account, the duplicate and
 * failing sign-up paths, and checkout as a member, as a guest, and across a
 * session that expires at the order.
 */

import { AUTH_TEST_SITE_BASE_PATH } from '../../domains/auth-test-site/config';
import {
  assert,
  attemptTrail as trail,
  cartWithTote,
  cleanup,
  createMintedIdentity,
  createUser,
  fetchReport,
  getPage,
  lastMailTo,
  type Manifest,
  pagePath,
  postForm,
  savedPasswordsInListedOrder,
  seedShop as seed,
  sessionCookie,
  SHOP_CARD as CARD,
  test,
  withLocalSite,
  withSettler,
} from './auth-test-site.testkit';

/** Canvas Tote 15.00 + 8.25% tax 1.24 + shipping 4.99. */
const TOTE_TOTAL_CENTS = 2123;

async function signUpAndVerify(
  base: string,
  manifest: Manifest,
  sentMail: Array<Record<string, string>>,
  email: string,
  form: Record<string, string> = {},
  cookie = ''
) {
  const submitted = await postForm(
    base,
    pagePath(manifest, '/signup'),
    { name: 'Rose Cedar', email, password: 'correct-horse-7', ...form },
    cookie
  );
  assert(
    (submitted.headers.get('location') ?? '').includes('/signup/verify'),
    `sign-up must lead to verification, got ${submitted.status} ${submitted.headers.get('location')}`
  );
  const code = /verification code is (\d{6})/.exec(lastMailTo(sentMail, email))?.[1] ?? '';
  assert(code !== '', 'verification code must be emailed');
  return postForm(base, pagePath(manifest, '/signup/verify'), { email, code, ...form }, cookie);
}

test('signup: a new account is verified by its emailed code and gets a member number', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'signup');
      assert(manifest.authOptionsPreview.mintedEmail === minted.email, 'minted must be offered');
      assert(manifest.expectedSignInEmail === null, 'no account exists yet');
      const weak = await postForm(base, pagePath(manifest, '/signup'), {
        name: 'Rose Cedar',
        email: minted.email,
        password: 'short',
      });
      assert((await weak.text()).includes('at least 8 characters'), 'weak password is refused');
      const early = await postForm(base, pagePath(manifest, '/login'), {
        email: minted.email,
        password: 'correct-horse-7',
      });
      assert(early.status === 200, 'nobody can sign in before the account exists');
      const verified = await signUpAndVerify(base, manifest, sentMail, minted.email);
      assert(verified.status === 303, 'verification must sign the new member in');
      const account = await (
        await getPage(base, pagePath(manifest, '/account'), sessionCookie(verified))
      ).text();
      const memberNumber = /id="member-number">(RS-\d{8})</.exec(account)?.[1] ?? '';
      assert(memberNumber !== '', 'the new account must have a member number');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.signInEmail === minted.email, `signInEmail ${report.signInEmail}`);
      assert(
        JSON.stringify(report.accounts) ===
          JSON.stringify([{ email: minted.email, memberNumber, origin: 'signup', verified: true }]),
        `unexpected accounts ${JSON.stringify(report.accounts)}`
      );
      assert(
        JSON.stringify(trail(report)) ===
          JSON.stringify([
            'password:rejected:unknown_account',
            'signup:pending',
            'signup_verify:code_sent',
            'signup_verify:signed_in',
          ]),
        `unexpected trail ${trail(report)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('signup_already_registered: sign-up is refused and the emailed code signs in', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const manifest = await seed(base, userId, 'signup_already_registered');
      const refused = await postForm(base, pagePath(manifest, '/signup'), {
        name: 'Rose Cedar',
        email: minted.email,
        password: 'correct-horse-7',
      });
      assert((await refused.text()).includes('already exists'), 'duplicate sign-up is refused');
      await postForm(base, pagePath(manifest, '/login/code'), { email: minted.email });
      const code = /sign-in code is (\d{6})/.exec(lastMailTo(sentMail, minted.email))?.[1] ?? '';
      const verified = await postForm(base, pagePath(manifest, '/login/code/verify'), {
        email: minted.email,
        code,
      });
      assert(verified.status === 303, 'the existing account signs in by code');
      const report = await fetchReport(base, manifest.siteId);
      assert(report.accounts.length === 1 && report.accounts[0]?.origin === 'seed', 'one account');
      assert(trail(report)[0] === 'signup:rejected:already_registered', `trail ${trail(report)}`);
    });
  } finally {
    await cleanup(userId);
  }
});

test('created_account_reused: sign-up leaves a password-only account', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      const reused = await seed(base, userId, 'created_account_reused');
      const codeLink = await getPage(base, pagePath(reused, '/login/code'));
      assert(codeLink.status === 303, 'a password-only site has no emailed-code sign-in');
      const verified = await signUpAndVerify(base, reused, sentMail, minted.email);
      await postForm(base, pagePath(reused, '/logout'), {}, sessionCookie(verified));
      const back = await postForm(base, pagePath(reused, '/login'), {
        email: minted.email,
        password: 'correct-horse-7',
      });
      assert(back.status === 303, 'the password chosen at sign-up signs in later');
      const report = await fetchReport(base, reused.siteId);
      assert(
        report.sessions.map((session) => session.method).join() === 'signup,password',
        `unexpected sessions ${JSON.stringify(report.sessions)}`
      );
    });
  } finally {
    await cleanup(userId);
  }
});

test('signup_purchase: checkout needs an account, and one settled order belongs to it', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      await withSettler(async (charges) => {
        const manifest = await seed(base, userId, 'signup_purchase');
        const shop = await (await getPage(base, pagePath(manifest, '/'))).text();
        assert(shop.includes('Canvas Tote') && shop.includes('Add to cart'), 'catalog expected');
        const cart = await cartWithTote(base, manifest);
        const gate = await (await getPage(base, pagePath(manifest, '/checkout'), cart)).text();
        assert(gate.includes('You need a Rose Shop account'), 'checkout must require an account');
        assert(!gate.includes('Continue as guest'), 'no guest checkout on this site');
        const blocked = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert(blocked.status === 200 && charges.length === 0, 'no charge without an account');

        const verified = await signUpAndVerify(
          base,
          manifest,
          sentMail,
          minted.email,
          { next: 'checkout' },
          cart
        );
        assert(
          (verified.headers.get('location') ?? '').includes('/checkout'),
          `sign-up from checkout must return there: ${verified.headers.get('location')}`
        );
        const cookies = `${cart}; ${sessionCookie(verified)}`;
        const checkout = await (
          await getPage(base, pagePath(manifest, '/checkout'), cookies)
        ).text();
        assert(checkout.includes(`data-total-cents="${TOTE_TOTAL_CENTS}"`), 'total must be exact');
        assert(checkout.includes('data-merchant="Rose Shop"'), 'merchant must be named');
        assert(
          checkout.includes(
            `data-product-url="${base}${AUTH_TEST_SITE_BASE_PATH}/${manifest.siteId}/products/canvas-tote?`
          ),
          'line items must carry an absolute product URL'
        );
        const placed = await postForm(base, pagePath(manifest, '/checkout'), CARD, cookies);
        const receiptPath = placed.headers.get('location') ?? '';
        assert(/\/orders\/ORD-\d{8}\?/.test(receiptPath), `expected a receipt, got ${receiptPath}`);
        const receipt = await (await getPage(base, receiptPath, cookies)).text();
        const orderNumber = /data-order-number="(ORD-\d{8})"/.exec(receipt)?.[1] ?? '';
        assert(
          orderNumber !== '' && receipt.includes(minted.email),
          'receipt names order and buyer'
        );
        // Only the purchaser reads the receipt: an order number alone sends a
        // stranger (no cookies, or a different browser's cart) back to the shop.
        const stranger = await getPage(base, receiptPath, '');
        assert(
          stranger.status === 303 && !(stranger.headers.get('location') ?? '').includes('/orders/'),
          `a receipt must not render for a request without the purchaser's session: ${stranger.status}`
        );
        // A browser whose checkout response was lost in transit (a proxy 502
        // after the order was placed) must find the outcome by browsing, without
        // resubmitting payment: the emptied checkout leads to the cart, and the
        // cart and the account page both link the purchaser's receipt.
        const orderLink = `/orders/${orderNumber}?`;
        const lostCheckout = await getPage(base, pagePath(manifest, '/checkout'), cookies);
        assert(
          (lostCheckout.headers.get('location') ?? '').includes('/cart'),
          `an emptied checkout leads to the cart: ${lostCheckout.headers.get('location')}`
        );
        const cartAfter = await (await getPage(base, pagePath(manifest, '/cart'), cookies)).text();
        assert(cartAfter.includes(orderLink), 'the cart must link the order it just paid for');
        const account = await (await getPage(base, pagePath(manifest, '/account'), cookies)).text();
        assert(account.includes(orderLink), "the account page must list the member's orders");
        const strangerCart = await (await getPage(base, pagePath(manifest, '/cart'), '')).text();
        assert(!strangerCart.includes(orderNumber), "a stranger's cart must not list the order");
        // A browser that missed the redirect repeats the POST against the cart the
        // order already emptied; it must get the paid order back, not "empty cart".
        const replayed = await postForm(base, pagePath(manifest, '/checkout'), CARD, cookies);
        assert(
          (replayed.headers.get('location') ?? '').includes(orderNumber),
          `a repeated checkout POST must resolve to the placed order: ${replayed.headers.get('location')}`
        );
        // The repeat resolves only for the purchaser: the same cart cookie without
        // the member's session is not handed the member's order.
        const signedOut = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert(
          !(signedOut.headers.get('location') ?? '').includes('/orders/'),
          `a repeated checkout POST without the purchaser's session must not resolve to the order: ${signedOut.status} ${signedOut.headers.get('location')}`
        );
        // A malformed session cookie reads as signed out, not as a 500.
        const malformed = await getPage(base, pagePath(manifest, ''), 'rose_shop_session=%E0');
        assert(malformed.status === 200, `malformed cookie must not 500: ${malformed.status}`);

        await cartWithToteInto(base, manifest, cart);
        const repeat = await postForm(base, pagePath(manifest, '/checkout'), CARD, cookies);
        assert(
          (repeat.headers.get('location') ?? '').includes(orderNumber),
          'the same settled purchase must return the same order'
        );
        const report = await fetchReport(base, manifest.siteId);
        assert(
          report.orders.length === 1 &&
            report.orders[0]?.email === minted.email &&
            report.orders[0]?.totalCents === TOTE_TOTAL_CENTS &&
            report.orders[0]?.itemIds.join() === 'canvas-tote',
          `exactly one order by the new account expected: ${JSON.stringify(report.orders)}`
        );
        assert(
          charges.every(
            (charge) => charge.merchant === 'Rose Shop' && charge.amountCents === TOTE_TOTAL_CENTS
          ),
          `charges ${JSON.stringify(charges)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});

async function cartWithToteInto(base: string, manifest: Manifest, cart: string): Promise<void> {
  await postForm(base, pagePath(manifest, '/cart/add'), { item: 'canvas-tote' }, cart);
}

const TOTE_MEMBER_TOTAL_CENTS = 1960;

test('member_discount_purchase: a member pays less than a guest for the same cart', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base, sentMail }) => {
      await withSettler(async (charges) => {
        const manifest = await seed(base, userId, 'member_discount_purchase');
        const shop = await (await getPage(base, pagePath(manifest, '/'))).text();
        assert(shop.includes('Members pay $13.50 (10% off'), 'the member price must be shown');
        const cart = await cartWithTote(base, manifest);
        const gate = await (await getPage(base, pagePath(manifest, '/checkout'), cart)).text();
        assert(
          gate.includes('Continue as guest') && gate.includes('Members pay 10% less'),
          'the gate offers guest checkout and states the member price'
        );
        const guestCart = await (await getPage(base, pagePath(manifest, '/cart'), cart)).text();
        assert(guestCart.includes('$21.23'), 'a guest sees the full total');

        const verified = await signUpAndVerify(
          base,
          manifest,
          sentMail,
          minted.email,
          { next: 'checkout' },
          cart
        );
        const cookies = `${cart}; ${sessionCookie(verified)}`;
        const checkout = await (
          await getPage(base, pagePath(manifest, '/checkout'), cookies)
        ).text();
        assert(
          checkout.includes(`data-total-cents="${TOTE_MEMBER_TOTAL_CENTS}"`) &&
            checkout.includes('data-unit-price-cents="1350"'),
          'a member checks out at the member price'
        );
        const placed = await postForm(base, pagePath(manifest, '/checkout'), CARD, cookies);
        const receipt = await (
          await getPage(base, placed.headers.get('location') ?? '', cookies)
        ).text();
        assert(receipt.includes('$19.60'), 'the receipt keeps the member total');
        const report = await fetchReport(base, manifest.siteId);
        assert(
          report.orders.length === 1 &&
            report.orders[0]?.email === minted.email &&
            report.orders[0]?.totalCents === TOTE_MEMBER_TOTAL_CENTS,
          `one member-priced order expected: ${JSON.stringify(report.orders)}`
        );
        assert(
          charges.length === 1 && charges[0]?.amountCents === TOTE_MEMBER_TOTAL_CENTS,
          `charges ${JSON.stringify(charges)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});

test('member price shops state the membership terms, and a refused sign-up still leaves guest checkout', async () => {
  const userId = await createUser();
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async (charges) => {
        const paid = await seed(base, userId, 'paid_membership_purchase');
        const paidShop = await (await getPage(base, pagePath(paid, '/'))).text();
        assert(
          paidShop.includes('Members pay $13.50 (10% off with a $9.99/month membership)'),
          'a paid membership must be priced on the product'
        );

        const manifest = await seed(base, userId, 'member_discount_signup_fails_purchase');
        const cart = await cartWithTote(base, manifest);
        const gate = await (await getPage(base, pagePath(manifest, '/checkout'), cart)).text();
        assert(
          gate.includes('Members pay 10% less with a free account') &&
            gate.includes('Continue as guest'),
          'the gate states free membership and still offers guest checkout'
        );
        const refused = await postForm(
          base,
          pagePath(manifest, '/signup'),
          { name: 'Rose Cedar', email: 'rose.cedar@mail.example', password: 'correct-horse-7' },
          cart
        );
        assert(
          !(refused.headers.get('location') ?? '').includes('/signup/verify'),
          'sign-up must be refused on this site'
        );
        await postForm(base, pagePath(manifest, '/checkout/guest'), {}, cart);
        const placed = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert(
          (placed.headers.get('location') ?? '').includes('/orders/ORD-'),
          'guest order placed'
        );
        const guestReceiptPath = placed.headers.get('location') ?? '';
        const withCart = await getPage(base, guestReceiptPath, cart);
        assert(withCart.status === 200, 'the guest browser reads its own receipt');
        const guestOrderNumber = /\/orders\/(ORD-\d{8})\?/.exec(guestReceiptPath)?.[1] ?? '';
        const guestCart = await (await getPage(base, pagePath(manifest, '/cart'), cart)).text();
        assert(
          guestOrderNumber !== '' && guestCart.includes(`/orders/${guestOrderNumber}?`),
          'the guest cart must link the order it paid for'
        );
        const withoutCart = await getPage(base, guestReceiptPath, '');
        assert(
          withoutCart.status === 303,
          `a guest receipt needs the cart that paid for it: ${withoutCart.status}`
        );
        const report = await fetchReport(base, manifest.siteId);
        assert(
          report.orders.length === 1 &&
            report.orders[0]?.email === null &&
            report.orders[0]?.totalCents === TOTE_TOTAL_CENTS,
          `one full-price guest order expected: ${JSON.stringify(report.orders)}`
        );
        assert(report.accounts.length === 0, 'no account may exist after a refused sign-up');
        assert(
          charges.length === 1 && charges[0]?.amountCents === TOTE_TOTAL_CENTS,
          `charges ${JSON.stringify(charges)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});

test('guest_purchase: a guest cart checks out with no account', async () => {
  const userId = await createUser();
  try {
    await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async () => {
        const manifest = await seed(base, userId, 'guest_purchase');
        const cart = await cartWithTote(base, manifest);
        const gate = await (await getPage(base, pagePath(manifest, '/checkout'), cart)).text();
        assert(gate.includes('Continue as guest'), 'guest checkout must be offered');
        await postForm(base, pagePath(manifest, '/checkout/guest'), {}, cart);
        const checkout = await (await getPage(base, pagePath(manifest, '/checkout'), cart)).text();
        assert(checkout.includes('Checking out as a guest'), 'guest checkout page expected');
        const placed = await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        assert((placed.headers.get('location') ?? '').includes('/orders/ORD-'), 'order placed');
        const report = await fetchReport(base, manifest.siteId);
        assert(report.orders.length === 1 && report.orders[0]?.email === null, 'one guest order');
        assert(report.sessions.length === 0 && report.accounts.length === 0, 'no account was used');
        assert(
          JSON.stringify(trail(report)) === JSON.stringify(['guest:started', 'order:placed']),
          `unexpected trail ${trail(report)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});

test('signup_fails_purchase: with sign-up down nothing is ordered or charged', async () => {
  const userId = await createUser();
  try {
    const minted = await createMintedIdentity(userId);
    await withLocalSite(async ({ base }) => {
      await withSettler(async (charges) => {
        const manifest = await seed(base, userId, 'signup_fails_purchase');
        const cart = await cartWithTote(base, manifest);
        const refused = await postForm(
          base,
          pagePath(manifest, '/signup'),
          {
            name: 'Rose Cedar',
            email: minted.email,
            password: 'correct-horse-7',
            next: 'checkout',
          },
          cart
        );
        assert(
          (await refused.text()).includes('is not accepting new accounts'),
          'sign-up must error'
        );
        await postForm(base, pagePath(manifest, '/checkout'), CARD, cart);
        const report = await fetchReport(base, manifest.siteId);
        assert(report.orders.length === 0 && charges.length === 0, 'no order and no charge');
        assert(
          JSON.stringify(trail(report)) ===
            JSON.stringify([
              'signup:rejected:signup_unavailable',
              'order:rejected:sign_in_required',
            ]),
          `unexpected trail ${trail(report)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});

test('session_expires_at_checkout: the first submit signs the member out and charges nothing', async () => {
  const userId = await createUser('Avery Ross');
  try {
    await withLocalSite(async ({ base }) => {
      await withSettler(async (charges) => {
        const manifest = await seed(base, userId, 'session_expires_at_checkout');
        const [saved] = await savedPasswordsInListedOrder(userId, manifest);
        assert(saved, 'one saved login expected');
        const cart = await cartWithTote(base, manifest);
        const signIn = () =>
          postForm(
            base,
            pagePath(manifest, '/login'),
            { email: saved.username, password: saved.password, next: 'checkout' },
            cart
          );
        const first = await signIn();
        assert((first.headers.get('location') ?? '').includes('/checkout'), 'lands on checkout');
        const expired = await postForm(
          base,
          pagePath(manifest, '/checkout'),
          CARD,
          `${cart}; ${sessionCookie(first)}`
        );
        assert((await expired.text()).includes('session has expired'), 'must ask to sign in again');
        assert(charges.length === 0, 'an expired session must not be charged');
        const stillOut = await getPage(base, pagePath(manifest, '/account'), sessionCookie(first));
        assert(stillOut.status === 303, 'the old session is over');

        const second = await signIn();
        const placed = await postForm(
          base,
          pagePath(manifest, '/checkout'),
          CARD,
          `${cart}; ${sessionCookie(second)}`
        );
        assert((placed.headers.get('location') ?? '').includes('/orders/ORD-'), 'order placed');
        const report = await fetchReport(base, manifest.siteId);
        assert(report.orders.length === 1 && charges.length === 1, 'exactly one order, one charge');
        assert(
          JSON.stringify(trail(report)) ===
            JSON.stringify([
              'password:signed_in',
              'session:rejected:expired_session',
              'password:signed_in',
              'order:placed',
            ]),
          `unexpected trail ${trail(report)}`
        );
      });
    });
  } finally {
    await cleanup(userId);
  }
});
