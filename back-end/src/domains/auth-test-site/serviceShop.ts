/**
 * The shop: a small catalog, a cart keyed by a browser cookie, and a checkout
 * that charges the typed card through the sandbox card settlement.
 *
 *   cart ──► checkout ──► not signed in, not a guest cart ──► sign_in_required
 *                     ├─► site ends the session at the first submit ──► session_expired
 *                     ├─► card refused by settlement ──► card_declined
 *                     └─► settled ──► one order per settled purchase (a repeat submit
 *                                     of the same purchase returns the same order)
 */

import { randomBytes } from '../../providers/crypto';
import {
  AgentCardSandboxSettlementError,
  settleAgentCardSandboxPayment,
} from '../../providers/agentcard/sandbox-settlement';
import { createLogger } from '../../providers/logger';
import { AUTH_TEST_SITE_NAME, SHOP_SHIPPING_CENTS, SHOP_TAX_RATE } from './config';
import { siteIdForPurchase } from './repoSites';
import { endSession, recordAttempt } from './serviceSignIn';
import type { AuthTestSite, CartLine, SiteOrder, SiteSession } from './types';

const log = createLogger('AuthTestSite');

export interface ShopItem {
  id: string;
  name: string;
  description: string;
  priceCents: number;
  imageUrl: string;
  rating: number;
  reviewCount: number;
}

export const SHOP_CATALOG: readonly ShopItem[] = [
  {
    id: 'canvas-tote',
    name: 'Canvas Tote',
    description: 'Heavy cotton canvas tote with a flat base and long handles.',
    priceCents: 1500,
    imageUrl: 'https://placehold.co/320x220/png?text=Canvas+Tote',
    rating: 4.7,
    reviewCount: 212,
  },
  {
    id: 'ceramic-mug',
    name: 'Ceramic Mug',
    description: 'Glazed 12 oz stoneware mug.',
    priceCents: 900,
    imageUrl: 'https://placehold.co/320x220/png?text=Ceramic+Mug',
    rating: 4.5,
    reviewCount: 148,
  },
  {
    id: 'aurora-notebook',
    name: 'Aurora Notebook',
    description: 'A5 dot-grid notebook, 160 pages.',
    priceCents: 1200,
    imageUrl: 'https://placehold.co/320x220/png?text=Aurora+Notebook',
    rating: 4.6,
    reviewCount: 95,
  },
  {
    id: 'desk-lamp',
    name: 'Desk Lamp',
    description: 'Adjustable LED desk lamp with a weighted base.',
    priceCents: 2200,
    imageUrl: 'https://placehold.co/320x220/png?text=Desk+Lamp',
    rating: 4.4,
    reviewCount: 61,
  },
];

export interface PricedLine {
  item: ShopItem;
  /** What this shopper pays per unit (the member price when signed in to a discount shop). */
  unitPriceCents: number;
  quantity: number;
  lineTotalCents: number;
}

export interface CartTotals {
  lines: PricedLine[];
  subtotalCents: number;
  taxCents: number;
  shippingCents: number;
  totalCents: number;
}

export interface CardInput {
  number: string;
  name: string;
  expiry: string;
  cvv: string;
  postalCode: string;
}

type Settler = (input: {
  cardNumber: string;
  amountCents: number;
  merchant: string;
}) => Promise<{ purchaseId: string }>;

let settlePayment: Settler = settleAgentCardSandboxPayment;

/** Tests swap the card settlement for a local stand-in; null restores the real one. */
export function setPaymentSettler(settler: Settler | null): void {
  settlePayment = settler ?? settleAgentCardSandboxPayment;
}

export function findItem(itemId: string): ShopItem | undefined {
  return SHOP_CATALOG.find((item) => item.id === itemId);
}

export function cartLines(site: AuthTestSite, cartToken: string | null): CartLine[] {
  if (cartToken === null) return [];
  return site.carts[cartToken] ?? [];
}

/** Adds one unit of the item and returns the cart token (new when the browser had none). */
export function addToCart(site: AuthTestSite, cartToken: string | null, itemId: string): string {
  const token =
    cartToken !== null && site.carts[cartToken] !== undefined
      ? cartToken
      : randomBytes(18).toString('base64url');
  const lines = site.carts[token] ?? [];
  if (findItem(itemId) !== undefined) {
    const line = lines.find((candidate) => candidate.id === itemId);
    if (line === undefined) lines.push({ id: itemId, quantity: 1 });
    else line.quantity += 1;
  }
  site.carts[token] = lines;
  return token;
}

export function removeFromCart(site: AuthTestSite, cartToken: string | null, itemId: string): void {
  if (cartToken === null || site.carts[cartToken] === undefined) return;
  site.carts[cartToken] = site.carts[cartToken].filter((line) => line.id !== itemId);
}

export function memberPriceCents(site: AuthTestSite, item: ShopItem): number {
  return Math.round((item.priceCents * (100 - site.behavior.memberDiscountPercent)) / 100);
}

/** Members pay the member price; a guest (member = false) pays the list price. */
export function cartTotals(site: AuthTestSite, lines: CartLine[], member: boolean): CartTotals {
  const priced: PricedLine[] = [];
  for (const line of lines) {
    const item = findItem(line.id);
    if (item === undefined) continue;
    const unitPriceCents = member ? memberPriceCents(site, item) : item.priceCents;
    priced.push({
      item,
      unitPriceCents,
      quantity: line.quantity,
      lineTotalCents: unitPriceCents * line.quantity,
    });
  }
  const subtotalCents = priced.reduce((sum, line) => sum + line.lineTotalCents, 0);
  const taxCents = Math.round(subtotalCents * SHOP_TAX_RATE);
  const shippingCents = priced.length === 0 ? 0 : SHOP_SHIPPING_CENTS;
  return {
    lines: priced,
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
  };
}

/** A guest cart may check out without an account, on sites that allow it. */
export function markGuestCart(site: AuthTestSite, cartToken: string): void {
  if (!site.guestCartTokens.includes(cartToken)) {
    site.guestCartTokens.push(cartToken);
    recordAttempt(site, 'guest', '', 'started', null);
  }
}

export function isGuestCart(site: AuthTestSite, cartToken: string | null): boolean {
  return (
    site.behavior.guest === 'checkout' &&
    cartToken !== null &&
    site.guestCartTokens.includes(cartToken)
  );
}

function cardLooksComplete(card: CardInput): boolean {
  return (
    card.number.replace(/\D+/g, '').length >= 12 &&
    /^\d{2}\s*\/\s*(\d{2}|\d{4})$/.test(card.expiry.trim()) &&
    card.cvv.replace(/\D+/g, '').length >= 3 &&
    card.name.trim() !== ''
  );
}

export type PlaceOrderResult =
  | { ok: true; order: SiteOrder }
  | {
      ok: false;
      reason:
        'empty_cart' | 'sign_in_required' | 'session_expired' | 'invalid_card' | 'card_declined';
    };

function newOrderNumber(): string {
  return `ORD-${(randomBytes(4).readUInt32BE(0) % 90_000_000) + 10_000_000}`;
}

export async function placeOrder(
  site: AuthTestSite,
  input: { cartToken: string | null; session: SiteSession | null; card: CardInput }
): Promise<PlaceOrderResult> {
  // Copy the cart first: settlement awaits a provider, and a concurrent cart
  // change must not alter what this order records against the charged total.
  const lines = cartLines(site, input.cartToken).map((line) => ({ ...line }));
  const totals = cartTotals(site, lines, input.session !== null);
  if (totals.lines.length === 0) {
    // A browser that missed the response repeats the POST against the cart the
    // first attempt already emptied; hand the purchaser back the order it paid
    // for. Anyone else holding that cart cookie only has an empty cart.
    const placed = orderForCart(site, input.cartToken);
    if (
      placed !== undefined &&
      canViewOrder(placed, { session: input.session, cartToken: input.cartToken })
    ) {
      return { ok: true, order: placed };
    }
    return { ok: false, reason: 'empty_cart' };
  }
  const buyer = input.session?.email ?? null;
  if (input.session === null && !isGuestCart(site, input.cartToken)) {
    recordAttempt(site, 'order', '', 'rejected', 'sign_in_required');
    return { ok: false, reason: 'sign_in_required' };
  }
  if (site.behavior.expireSessionAtOrder && !site.sessionExpiredAtOrder && input.session !== null) {
    site.sessionExpiredAtOrder = true;
    endSession(site, input.session);
    recordAttempt(site, 'session', input.session.email, 'rejected', 'expired_session');
    return { ok: false, reason: 'session_expired' };
  }
  if (!cardLooksComplete(input.card)) return { ok: false, reason: 'invalid_card' };

  let purchaseId: string;
  try {
    const settled = await settlePayment({
      cardNumber: input.card.number.replace(/\D+/g, ''),
      amountCents: totals.totalCents,
      merchant: AUTH_TEST_SITE_NAME,
    });
    purchaseId = settled.purchaseId;
  } catch (error) {
    log.warn('Order payment was not settled', {
      site_id: site.siteId,
      total_cents: totals.totalCents,
      error: error instanceof Error ? error.message : String(error),
    });
    // Only a refused card is the shopper's to fix. An operational failure in
    // settlement (a cleared purchase missing its hold, 502) is the route's error.
    if (error instanceof AgentCardSandboxSettlementError && error.statusCode >= 500) throw error;
    recordAttempt(site, 'order', buyer ?? '', 'rejected', 'card_declined');
    return { ok: false, reason: 'card_declined' };
  }

  const existing = site.orders.find((order) => order.purchaseId === purchaseId);
  if (existing !== undefined) return { ok: true, order: existing };
  // Settlement replays a cleared purchase for the same card and total without
  // charging again. One that already paid for another site's order has not paid
  // for this checkout.
  if (siteIdForPurchase(purchaseId) !== null) {
    recordAttempt(site, 'order', buyer ?? '', 'rejected', 'card_declined');
    return { ok: false, reason: 'card_declined' };
  }
  const order: SiteOrder = {
    orderNumber: newOrderNumber(),
    email: buyer,
    lines: lines.map((line) => ({ ...line })),
    totalCents: totals.totalCents,
    at: new Date().toISOString(),
    purchaseId,
    cartToken: input.cartToken,
  };
  site.orders.push(order);
  if (input.cartToken !== null) site.carts[input.cartToken] = [];
  recordAttempt(site, 'order', buyer ?? '', 'placed', null);
  return { ok: true, order };
}

export function findOrder(site: AuthTestSite, orderNumber: string): SiteOrder | undefined {
  return site.orders.find((order) => order.orderNumber === orderNumber);
}

/** The most recent order a cart paid for (a repeated checkout POST resolves to it). */
export function orderForCart(site: AuthTestSite, cartToken: string | null): SiteOrder | undefined {
  if (cartToken === null) return undefined;
  for (let index = site.orders.length - 1; index >= 0; index -= 1) {
    if (site.orders[index]!.cartToken === cartToken) return site.orders[index];
  }
  return undefined;
}

/** The orders this viewer may read, newest first: what the cart and account pages list. */
export function ordersFor(
  site: AuthTestSite,
  viewer: { session: SiteSession | null; cartToken: string | null }
): SiteOrder[] {
  return site.orders.filter((order) => canViewOrder(order, viewer)).reverse();
}

/**
 * Whether this request may read a receipt: a member order belongs to the
 * signed-in purchaser, a guest order to the browser holding the cart that paid
 * for it. Anyone else only knows an order number.
 */
export function canViewOrder(
  order: SiteOrder,
  viewer: { session: SiteSession | null; cartToken: string | null }
): boolean {
  if (order.email !== null) return viewer.session?.email === order.email;
  return order.cartToken !== null && viewer.cartToken === order.cartToken;
}
