/** Shop pages: catalog, product, cart, the sign-in gate before checkout, checkout and receipt. */

import { AUTH_TEST_SITE_NAME, SHOP_CURRENCY } from './config';
import { publicSiteUrl, siteUrl } from './service';
import { banner, escapeHtml, layout } from './servicePages';
import { SHOP_CATALOG, memberPriceCents, type CartTotals, type ShopItem } from './serviceShop';
import type { AuthTestSite, SiteOrder, SiteSession } from './types';

export function money(cents: number): string {
  return `$${(cents / 100).toFixed(2)}`;
}

function accountBar(site: AuthTestSite, session: SiteSession | null, cartCount: number): string {
  const who =
    session === null
      ? `<a href="${siteUrl(site, '/login')}">Sign in</a>`
      : `Signed in as ${escapeHtml(session.email)} · <a href="${siteUrl(site, '/account')}">Your membership</a>`;
  return `<p>${who} · <a href="${siteUrl(site, '/cart')}">Cart (${cartCount})</a></p>`;
}

function membershipTerms(site: AuthTestSite): string {
  const fee = site.behavior.membershipFeeCents;
  return fee === 0 ? 'a free account' : `a ${money(fee)}/month membership`;
}

function memberPrice(site: AuthTestSite, item: ShopItem): string {
  if (site.behavior.memberDiscountPercent === 0) return '';
  return ` · Members pay ${money(memberPriceCents(site, item))} (${site.behavior.memberDiscountPercent}% off with ${membershipTerms(site)})`;
}

function productCard(site: AuthTestSite, item: ShopItem): string {
  return `<div class="product" data-product-id="${item.id}">
      <a href="${item.imageUrl}"><img src="${item.imageUrl}" alt="${escapeHtml(item.name)}"></a>
      <p class="image-url">Image URL: ${item.imageUrl}</p>
      <h2><a href="${siteUrl(site, `/products/${item.id}`)}">${escapeHtml(item.name)}</a></h2>
      <p>${escapeHtml(item.description)}</p>
      <p><strong>${money(item.priceCents)}</strong>${memberPrice(site, item)} · ${item.rating} stars (${item.reviewCount} reviews)</p>
      <form method="post" action="${siteUrl(site, '/cart/add')}">
        <input type="hidden" name="item" value="${item.id}">
        <button type="submit">Add to cart</button>
      </form>
    </div>`;
}

export function renderShopPage(
  site: AuthTestSite,
  session: SiteSession | null,
  cartCount: number
): string {
  return layout(
    site,
    'Shop',
    `    <h1>${AUTH_TEST_SITE_NAME}</h1>
    ${accountBar(site, session, cartCount)}
    ${SHOP_CATALOG.map((item) => productCard(site, item)).join('\n    ')}`
  );
}

export function renderProductPage(
  site: AuthTestSite,
  item: ShopItem,
  session: SiteSession | null,
  cartCount: number
): string {
  return layout(
    site,
    item.name,
    `    ${accountBar(site, session, cartCount)}
    ${productCard(site, item)}
    <p><a href="${siteUrl(site)}">Back to the shop</a></p>`
  );
}

function summaryTable(site: AuthTestSite, totals: CartTotals, removable: boolean): string {
  const rows = totals.lines
    .map((line) => {
      const remove = removable
        ? `<td><form method="post" action="${siteUrl(site, '/cart/remove')}"><input type="hidden" name="item" value="${line.item.id}"><button type="submit">Remove</button></form></td>`
        : '';
      return `<tr class="line-item" data-name="${escapeHtml(line.item.name)}" data-product-url="${publicSiteUrl(site, `/products/${line.item.id}`)}" data-image-url="${line.item.imageUrl}" data-unit-price-cents="${line.unitPriceCents}" data-quantity="${line.quantity}" data-line-total-cents="${line.lineTotalCents}" data-rating="${line.item.rating}" data-review-count="${line.item.reviewCount}">
        <td><a href="${publicSiteUrl(site, `/products/${line.item.id}`)}">${escapeHtml(line.item.name)}</a><br><a href="${line.item.imageUrl}"><img src="${line.item.imageUrl}" alt="${escapeHtml(line.item.name)}" width="80"></a><br>Image URL: ${line.item.imageUrl}<br>${line.item.rating} stars (${line.item.reviewCount} reviews)</td>
        <td>${line.quantity} × ${money(line.unitPriceCents)}</td>
        <td>${money(line.lineTotalCents)}</td>${remove}
      </tr>`;
    })
    .join('\n      ');
  return `<table>
      <tr><th>Item</th><th>Quantity</th><th>Total</th>${removable ? '<th></th>' : ''}</tr>
      ${rows}
      <tr><td colspan="2">Subtotal</td><td id="subtotal">${money(totals.subtotalCents)}</td></tr>
      <tr><td colspan="2">Tax</td><td id="tax">${money(totals.taxCents)}</td></tr>
      <tr><td colspan="2">Shipping</td><td id="shipping">${money(totals.shippingCents)}</td></tr>
      <tr><td colspan="2"><strong>Total (${SHOP_CURRENCY})</strong></td><td id="total"><strong>${money(totals.totalCents)}</strong></td></tr>
    </table>`;
}

/** The viewer's orders, each linking its receipt; empty when there are none. */
export function renderOrderHistory(site: AuthTestSite, orders: SiteOrder[]): string {
  if (orders.length === 0) return '';
  const rows = orders
    .map(
      (order) =>
        `<li data-order-number="${order.orderNumber}"><a href="${siteUrl(site, `/orders/${order.orderNumber}`)}">Order ${order.orderNumber}</a> · ${money(order.totalCents)} · ${order.at.slice(0, 10)}</li>`
    )
    .join('\n      ');
  return `<h2>Your orders</h2>
    <ul id="order-history">
      ${rows}
    </ul>`;
}

export function renderCartPage(
  site: AuthTestSite,
  totals: CartTotals,
  session: SiteSession | null,
  orders: SiteOrder[] = []
): string {
  const cartCount = totals.lines.reduce((sum, line) => sum + line.quantity, 0);
  const body =
    totals.lines.length === 0
      ? '<p>Your cart is empty.</p>'
      : `${summaryTable(site, totals, true)}
    <p><a href="${siteUrl(site, '/checkout')}">Check out</a></p>`;
  return layout(
    site,
    'Your cart',
    `    <h1>Your cart</h1>
    ${accountBar(site, session, cartCount)}
    ${body}
    ${renderOrderHistory(site, orders)}
    <p><a href="${siteUrl(site)}">Keep shopping</a></p>`
  );
}

/** Shown when a signed-out shopper tries to check out. */
export function renderCheckoutGatePage(site: AuthTestSite, notice?: string): string {
  const signUp =
    site.behavior.signUp === 'off'
      ? ''
      : `<p><a href="${siteUrl(site, '/signup')}&next=checkout">Create an account</a></p>`;
  const guest =
    site.behavior.guest === 'checkout'
      ? `<form method="post" action="${siteUrl(site, '/checkout/guest')}"><button type="submit">Continue as guest</button></form>`
      : '';
  const memberOffer =
    site.behavior.memberDiscountPercent === 0
      ? ''
      : `<p>Members pay ${site.behavior.memberDiscountPercent}% less with ${membershipTerms(site)}. Guests pay the full price.</p>`;
  return layout(
    site,
    'Check out',
    `    <h1>Check out</h1>
    ${banner('notice', notice)}
    <p>${site.behavior.guest === 'checkout' ? 'Sign in, create an account, or check out as a guest.' : `You need a ${AUTH_TEST_SITE_NAME} account to check out.`}</p>
    <p><a href="${siteUrl(site, '/login')}&next=checkout">Sign in</a></p>
    ${memberOffer}
    ${signUp}
    ${guest}`
  );
}

export function renderCheckoutPage(
  site: AuthTestSite,
  totals: CartTotals,
  options: { buyer: string | null; error?: string }
): string {
  const who =
    options.buyer === null
      ? 'Checking out as a guest'
      : `Checking out as ${escapeHtml(options.buyer)}`;
  return layout(
    site,
    'Check out',
    `    <h1>Check out</h1>
    <p>${who}</p>
    ${banner('error', options.error)}
    <section id="order-summary" data-merchant="${AUTH_TEST_SITE_NAME}" data-currency="${SHOP_CURRENCY}" data-subtotal-cents="${totals.subtotalCents}" data-tax-cents="${totals.taxCents}" data-shipping-cents="${totals.shippingCents}" data-total-cents="${totals.totalCents}">
    <h2>Order summary — ${AUTH_TEST_SITE_NAME}</h2>
    ${summaryTable(site, totals, false)}
    </section>
    <h2>Payment</h2>
    <form method="post" action="${siteUrl(site, '/checkout')}">
      <label for="card-number">Card number</label>
      <input id="card-number" name="cardNumber" inputmode="numeric" autocomplete="cc-number" required>
      <label for="card-name">Name on card</label>
      <input id="card-name" name="cardName" autocomplete="cc-name" required>
      <label for="card-expiry">Expiry (MM/YY)</label>
      <input id="card-expiry" name="cardExpiry" autocomplete="cc-exp" placeholder="MM/YY" required>
      <label for="card-cvv">Security code</label>
      <input id="card-cvv" name="cardCvv" inputmode="numeric" autocomplete="cc-csc" required>
      <label for="postal-code">Billing ZIP code</label>
      <input id="postal-code" name="postalCode" autocomplete="postal-code" value="94105" required>
      <button type="submit">Place order — ${money(totals.totalCents)}</button>
    </form>`
  );
}

export function renderOrderPage(site: AuthTestSite, order: SiteOrder, totals: CartTotals): string {
  return layout(
    site,
    'Order confirmed',
    `    <h1>Thank you — your order is confirmed</h1>
    <p class="notice" id="order-confirmation" data-order-number="${order.orderNumber}">Order number <strong>${order.orderNumber}</strong> was paid successfully.</p>
    <p>${order.email === null ? 'Guest order' : `Ordered by ${escapeHtml(order.email)}`}</p>
    ${summaryTable(site, totals, false)}
    <p><a href="${siteUrl(site)}">Back to the shop</a></p>`
  );
}
