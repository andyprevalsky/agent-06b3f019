/**
 * STATE MACHINE: TestPaymentPage
 *
 * [ACCESS_GATE] -- production without lifecycle query --> [DISABLED]
 * [ACCESS_GATE] -- production lifecycle query --> [LIVE_FIXTURE]
 * [ACCESS_GATE] -- dev build --> [LOADING_ITEMS]
 * [LOADING_ITEMS] -- success --> [SHOPPING]
 * [LIVE_FIXTURE] -- static item loaded --> [CHECKOUT_READY]
 * [SHOPPING] -- user selects required items --> [CHECKOUT_READY]
 * [CHECKOUT_READY] -- live Place order --> [HOSTED_CHECKOUT_REDIRECT]
 * [HOSTED_CHECKOUT_REDIRECT] -- location.href handoff --> Stripe Checkout (leave submitting true)
 * [HOSTED_CHECKOUT_REDIRECT] -- SPA stayed put --> show Continue-to-Stripe link (same url)
 * [CHECKOUT_READY] -- live Place order (optional last4 when card number filled) --> checkout-session
 * [CHECKOUT_READY] -- submit card (sandbox) --> [CONFIRMING]
 * [CONFIRMING] -- success --> [CONFIRMED] (also persist to localStorage + ?order=)
 * [CONFIRMING] -- API/Stripe error --> [CHECKOUT_ERROR]
 * [ACCESS_GATE/LOADING] -- localStorage last confirmation present --> [CONFIRMED]
 *
 * Benchmark mode (`?benchmark=`) is latched on the tab's first paint so a browser
 * agent cannot mid-task `goto` into `agentcard-abandonment` and disable Pay.
 * fields so browser agents can use request_payment_card before Stripe hosted
 * Checkout. Live authorization happens on Stripe's page — merchant Place order
 * only creates the Checkout session. Optional card last4 is sent when the
 * number field is filled so checkout-session can disambiguate multiple HELD
 * same-total purchases; Place order must stay clickable without it so agents
 * that only fill Stripe (not this merchant form) can still redirect.
 *
 * After checkout-session returns, set location.href and do NOT clear submitting
 * in finally — clearing re-enabled Place order while Steel browsers sometimes
 * stay on /test_payment, so agents re-clicked and never completed Stripe pay.
 * A visible Continue link carries the same hosted URL as a clickable fallback.
 *
 * Sandbox Pay success persists the confirmation in localStorage and mirrors the
 * order id into `?order=` so a browser agent that opens a fresh tab still lands
 * on the receipt instead of an empty checkout form (re-Pay then looked like a
 * failure even when the first confirm had already settled).
 *
 * Each product card renders the fields a payment-line-item receipt requires:
 * name, description, imageUrl, priceCents, an absolute productUrl
 * (`${window.location.origin}${item.productUrl}`), rating, and reviewCount —
 * exposed both as visible text and as data attributes so a browser agent can
 * extract valid product_url / rating / review_count values.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, CreditCard, Loader2, ShoppingCart } from 'lucide-react';
import {
  ABANDONMENT_BENCHMARK_QUERY,
  ABANDONMENT_BENCHMARK_ITEMS,
  EMPTY_CARD_FORM,
  LIVE_LIFECYCLE_BENCHMARK_QUERY,
  LIVE_LIFECYCLE_ITEM,
  REQUIRED_ITEM_IDS,
  SHIPPING_LABEL,
  TAX_LABEL,
  TEST_PAYMENT_MERCHANT_NAME,
} from '../config';
import {
  confirmTestPayment,
  fetchTestPaymentItems,
  settleTestPaymentCheckout,
  startTestPaymentCheckout,
} from '../hooks';
import type { TestPaymentCardForm, TestPaymentConfirmation, TestPaymentItem } from '../types';

function formatCents(value: number): string {
  return `$${(value / 100).toFixed(2)}`;
}

function calculateSubtotal(items: TestPaymentItem[], selectedIds: string[]): number {
  return selectedIds.reduce(
    (sum, id) => sum + (items.find((item) => item.id === id)?.priceCents ?? 0),
    0,
  );
}

function calculateTotals(items: TestPaymentItem[], selectedIds: string[], includeFees = true) {
  const subtotalCents = calculateSubtotal(items, selectedIds);
  const taxCents = includeFees ? Math.round(subtotalCents * 0.0825) : 0;
  const shippingCents = includeFees ? 499 : 0;
  return {
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
  };
}

function DisabledPage() {
  return (
    <main className="min-h-screen bg-background p-10 text-foreground">
      <h1 className="text-2xl font-semibold">Not found</h1>
    </main>
  );
}

/** Survives new tabs in the same origin (sessionStorage is per-tab). */
const LAST_CONFIRMATION_STORAGE_KEY = 'rose.test_payment.last_confirmation';
/**
 * Latch the `benchmark=` mode from the tab's first `/test_payment` paint.
 * Browser agents that scrape this module often `goto` `?benchmark=agentcard-abandonment`
 * mid-task, which disables Pay ("This checkout is unavailable") and stalls purchase gates
 * (gate-subscription-card-mint-admin-bypass 2026-08-21). Harness start_urls that already
 * include the query still arm on first paint.
 */
const BENCHMARK_MODE_LATCH_KEY = 'rose.test_payment.benchmark_mode_latch';

function isTestPaymentConfirmation(value: unknown): value is TestPaymentConfirmation {
  if (value === null || typeof value !== 'object') return false;
  const candidate = value as Partial<TestPaymentConfirmation>;
  return (
    typeof candidate.orderId === 'string' &&
    candidate.orderId.length > 0 &&
    typeof candidate.status === 'string' &&
    candidate.receipt !== undefined &&
    typeof candidate.receipt === 'object' &&
    Array.isArray(candidate.receipt.lineItems) &&
    candidate.receipt.totals !== undefined &&
    typeof candidate.receipt.totals === 'object'
  );
}

function readStoredConfirmation(): TestPaymentConfirmation | null {
  try {
    const raw = window.localStorage.getItem(LAST_CONFIRMATION_STORAGE_KEY);
    if (raw === null || raw === '') return null;
    const parsed: unknown = JSON.parse(raw);
    return isTestPaymentConfirmation(parsed) ? parsed : null;
  } catch {
    return null;
  }
}

function persistConfirmation(confirmation: TestPaymentConfirmation): void {
  try {
    window.localStorage.setItem(LAST_CONFIRMATION_STORAGE_KEY, JSON.stringify(confirmation));
  } catch {
    // Storage may be unavailable in locked-down browser profiles; confirmation still renders in-state.
  }
  const params = new URLSearchParams(window.location.search);
  params.set('order', confirmation.orderId);
  const next = `${window.location.pathname}?${params.toString()}`;
  window.history.replaceState({}, '', next);
}

function resolveLatchedBenchmarkMode(): string | null {
  const params = new URLSearchParams(window.location.search);
  const queryMode = params.get('benchmark');
  let latched: string | null = null;
  try {
    if (window.sessionStorage.getItem(BENCHMARK_MODE_LATCH_KEY) === null) {
      window.sessionStorage.setItem(BENCHMARK_MODE_LATCH_KEY, queryMode ?? '');
    }
    latched = window.sessionStorage.getItem(BENCHMARK_MODE_LATCH_KEY);
  } catch {
    // sessionStorage unavailable — fall back to the live query (manual/dev only).
    return queryMode;
  }
  const normalizedLatch = latched === null || latched === '' ? null : latched;
  if ((queryMode ?? null) !== normalizedLatch) {
    if (normalizedLatch === null) params.delete('benchmark');
    else params.set('benchmark', normalizedLatch);
    const qs = params.toString();
    window.history.replaceState({}, '', `${window.location.pathname}${qs ? `?${qs}` : ''}`);
  }
  return normalizedLatch;
}

function ProductGrid({
  items,
  selectedIds,
  setSelectedIds,
}: {
  items: TestPaymentItem[];
  selectedIds: string[];
  setSelectedIds: (ids: string[]) => void;
}) {
  const toggle = (id: string) => {
    setSelectedIds(
      selectedIds.includes(id)
        ? selectedIds.filter((itemId) => itemId !== id)
        : [...selectedIds, id],
    );
  };

  return (
    <section className="grid gap-4 md:grid-cols-5" aria-label="Test payment products">
      {items.map((item) => {
        const selected = selectedIds.includes(item.id);
        const absoluteProductUrl = `${window.location.origin}${item.productUrl}`;
        return (
          <article
            key={item.id}
            data-product-id={item.id}
            data-product-name={item.name}
            data-image-url={item.imageUrl}
            data-unit-price-cents={item.priceCents}
            data-product-url={absoluteProductUrl}
            data-product-rating={item.rating}
            data-product-review-count={item.reviewCount}
            className="rounded-lg border bg-card text-card-foreground shadow-sm"
          >
            <img
              src={item.imageUrl}
              alt={`${item.name} product image`}
              data-testid={`test-payment-image-${item.id}`}
              className="h-36 w-full rounded-t-lg object-cover"
            />
            <div className="space-y-3 p-4">
              <div>
                <h2 className="text-base font-semibold">{item.name}</h2>
                <p className="mt-1 text-sm text-muted-foreground">{item.description}</p>
                <p className="mt-2 break-all text-xs text-muted-foreground">
                  Product page: {absoluteProductUrl}
                </p>
                <p className="mt-1 text-xs text-muted-foreground">Rating: {item.rating}</p>
                <p className="mt-1 text-xs text-muted-foreground">{item.reviewCount}</p>
                <p className="mt-1 break-all text-xs text-muted-foreground">
                  Image URL: {item.imageUrl}
                </p>
              </div>
              <div className="flex items-center justify-between gap-3">
                <span className="font-medium">{formatCents(item.priceCents)}</span>
                <button
                  type="button"
                  aria-pressed={selected}
                  onClick={() => toggle(item.id)}
                  className={`rounded-md border px-3 py-2 text-sm font-medium ${
                    selected ? 'bg-foreground text-background' : 'bg-background text-foreground'
                  }`}
                >
                  {selected ? 'Selected' : 'Select'}
                </button>
              </div>
            </div>
          </article>
        );
      })}
    </section>
  );
}

export function ReceiptSummary({
  items,
  selectedIds,
  includeFees = true,
}: {
  items: TestPaymentItem[];
  selectedIds: string[];
  includeFees?: boolean;
}) {
  const selected = selectedIds
    .map((id) => items.find((item) => item.id === id))
    .filter(Boolean) as TestPaymentItem[];
  const totals = calculateTotals(items, selectedIds, includeFees);
  return (
    <aside
      data-merchant={TEST_PAYMENT_MERCHANT_NAME}
      data-subtotal-cents={totals.subtotalCents}
      data-tax-cents={totals.taxCents}
      data-shipping-cents={totals.shippingCents}
      data-total-cents={totals.totalCents}
      className="space-y-4 rounded-lg border bg-card p-4 text-card-foreground"
    >
      <div className="flex items-center gap-2">
        <ShoppingCart className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Order summary</h2>
      </div>
      <p className="text-sm text-muted-foreground">Merchant: {TEST_PAYMENT_MERCHANT_NAME}</p>
      <p className="text-sm text-muted-foreground" data-testid="test-payment-checkout-reference">
        Checkout reference: TP-CART-{totals.totalCents}
      </p>
      <div className="space-y-2">
        {selected.map((item) => (
          <div
            key={item.id}
            data-line-item-id={item.id}
            data-line-item-name={item.name}
            data-image-url={item.imageUrl}
            data-unit-price-cents={item.priceCents}
            data-quantity="1"
            data-line-total-cents={item.priceCents}
            className="space-y-1 text-sm"
          >
            <div className="flex justify-between gap-4">
              <span>{item.name} x1</span>
              <span>{formatCents(item.priceCents)}</span>
            </div>
            <p className="break-all text-xs text-muted-foreground">Image URL: {item.imageUrl}</p>
          </div>
        ))}
      </div>
      <div className="space-y-2 border-t pt-3 text-sm">
        <div data-subtotal-cents={totals.subtotalCents} className="flex justify-between">
          <span>Subtotal</span>
          <span>{formatCents(totals.subtotalCents)}</span>
        </div>
        {includeFees ? (
          <>
            <div
              data-fee-label={TAX_LABEL}
              data-fee-amount-cents={totals.taxCents}
              className="flex justify-between"
            >
              <span>{TAX_LABEL}</span>
              <span>{formatCents(totals.taxCents)}</span>
            </div>
            <div
              data-fee-label={SHIPPING_LABEL}
              data-fee-amount-cents={totals.shippingCents}
              className="flex justify-between"
            >
              <span>{SHIPPING_LABEL}</span>
              <span>{formatCents(totals.shippingCents)}</span>
            </div>
          </>
        ) : null}
        <div
          data-total-cents={totals.totalCents}
          className="flex justify-between text-base font-semibold"
        >
          <span>Total</span>
          <span>{formatCents(totals.totalCents)}</span>
        </div>
      </div>
    </aside>
  );
}

function CardForm({
  card,
  setCard,
  disabled,
}: {
  card: TestPaymentCardForm;
  setCard: (card: TestPaymentCardForm) => void;
  disabled: boolean;
}) {
  const update = (field: keyof TestPaymentCardForm, value: string) =>
    setCard({ ...card, [field]: value });
  return (
    <section className="space-y-3 rounded-lg border bg-card p-4 text-card-foreground">
      <div className="flex items-center gap-2">
        <CreditCard className="h-5 w-5" />
        <h2 className="text-lg font-semibold">Payment details</h2>
      </div>
      <p className="text-sm text-muted-foreground">
        Live checkout charges on Stripe&apos;s hosted page. Filling the card number here is optional
        — it only helps disambiguate leftover holds via last4.
      </p>
      <label className="block text-sm font-medium" htmlFor="card-number">
        Card number
      </label>
      <input
        id="card-number"
        inputMode="numeric"
        autoComplete="cc-number"
        value={card.number}
        disabled={disabled}
        onChange={(e) => update('number', e.target.value)}
        className="w-full rounded-md border px-3 py-2"
      />
      <label className="block text-sm font-medium" htmlFor="card-name">
        Name on card
      </label>
      <input
        id="card-name"
        value={card.name}
        disabled={disabled}
        onChange={(e) => update('name', e.target.value)}
        className="w-full rounded-md border px-3 py-2"
      />
      <div className="grid grid-cols-2 gap-3">
        <div>
          <label className="block text-sm font-medium" htmlFor="card-expiry">
            Expiration date
          </label>
          <input
            id="card-expiry"
            autoComplete="cc-exp"
            placeholder="MM/YY"
            value={card.expiry}
            disabled={disabled}
            onChange={(e) => update('expiry', e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2"
          />
        </div>
        <div>
          <label className="block text-sm font-medium" htmlFor="card-cvv">
            Security code
          </label>
          <input
            id="card-cvv"
            autoComplete="cc-csc"
            value={card.cvv}
            disabled={disabled}
            onChange={(e) => update('cvv', e.target.value)}
            className="mt-1 w-full rounded-md border px-3 py-2"
          />
        </div>
      </div>
      <label className="block text-sm font-medium" htmlFor="postal-code">
        Postal code
      </label>
      <input
        id="postal-code"
        autoComplete="postal-code"
        value={card.postalCode}
        disabled={disabled}
        onChange={(e) => update('postalCode', e.target.value)}
        className="w-full rounded-md border px-3 py-2"
      />
    </section>
  );
}

export function Confirmation({ confirmation }: { confirmation: TestPaymentConfirmation }) {
  const { lineItems, totals } = confirmation.receipt;
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <section
        data-testid="payment-confirmation"
        data-order-id={confirmation.orderId}
        className="mx-auto max-w-2xl space-y-6 rounded-lg border bg-card p-8 text-card-foreground"
      >
        <div>
          <div className="mb-2 flex items-center gap-3">
            <Check className="h-7 w-7 text-emerald-600" />
            <h1 className="text-3xl font-semibold">Payment confirmed</h1>
          </div>
          <p className="text-muted-foreground">
            Order {confirmation.orderId} was paid successfully.
          </p>
          <p data-testid="payment-confirmation-merchant" className="text-sm text-muted-foreground">
            Merchant: {TEST_PAYMENT_MERCHANT_NAME}
          </p>
        </div>

        <div data-testid="payment-confirmation-receipt" className="space-y-3 border-t pt-5">
          <h2 className="text-lg font-semibold">Receipt</h2>
          <ul className="space-y-3">
            {lineItems.map((line) => (
              <li
                key={line.id}
                data-line-item-id={line.id}
                data-line-item-name={line.name}
                data-quantity={line.quantity}
                data-line-total-cents={line.lineTotalCents}
                className="flex items-center gap-3 text-sm"
              >
                <img
                  src={line.imageUrl}
                  alt={`${line.name} purchased`}
                  data-testid={`receipt-image-${line.id}`}
                  className="h-12 w-12 rounded-md border object-cover"
                />
                <div className="flex-1">
                  <p className="font-medium">{line.name}</p>
                  <p className="text-xs text-muted-foreground">
                    Qty {line.quantity} &middot; {formatCents(line.unitPriceCents)} each
                  </p>
                </div>
                <span className="font-medium">{formatCents(line.lineTotalCents)}</span>
              </li>
            ))}
          </ul>
        </div>

        <div className="space-y-2 border-t pt-4 text-sm">
          <div className="flex justify-between">
            <span>Subtotal</span>
            <span>{formatCents(totals.subtotalCents)}</span>
          </div>
          <div className="flex justify-between">
            <span>Tax</span>
            <span>{formatCents(totals.taxCents)}</span>
          </div>
          <div className="flex justify-between">
            <span>Shipping</span>
            <span>{formatCents(totals.shippingCents)}</span>
          </div>
          <div
            data-testid="payment-confirmation-total"
            className="flex justify-between border-t pt-2 text-base font-semibold"
          >
            <span>Total charged</span>
            <span>{formatCents(totals.totalCents)}</span>
          </div>
        </div>
      </section>
    </main>
  );
}

export default function TestPaymentPage() {
  const isDev = import.meta.env.DEV === true;
  const benchmarkMode = resolveLatchedBenchmarkMode();
  const isLiveLifecycleFixture = benchmarkMode === LIVE_LIFECYCLE_BENCHMARK_QUERY;
  const isAbandonmentFixture = isDev && benchmarkMode === ABANDONMENT_BENCHMARK_QUERY;
  const isEnabled = isDev || isLiveLifecycleFixture;
  const [items, setItems] = useState<TestPaymentItem[]>(
    isLiveLifecycleFixture
      ? [LIVE_LIFECYCLE_ITEM]
      : isAbandonmentFixture
        ? ABANDONMENT_BENCHMARK_ITEMS
        : [],
  );
  const [selectedIds, setSelectedIds] = useState<string[]>(
    isLiveLifecycleFixture ? [LIVE_LIFECYCLE_ITEM.id] : [...REQUIRED_ITEM_IDS],
  );
  const [card, setCard] = useState<TestPaymentCardForm>(EMPTY_CARD_FORM);
  const [confirmation, setConfirmation] = useState<TestPaymentConfirmation | null>(() =>
    typeof window === 'undefined' ? null : readStoredConfirmation(),
  );
  const [loading, setLoading] = useState(!isLiveLifecycleFixture && !isAbandonmentFixture);
  const [submitting, setSubmitting] = useState(false);
  // Hosted Checkout URL after Place order — kept when location.href handoff does not unload
  // the SPA (observed on Steel fleet sessions) so agents still have a clickable Stripe target.
  const [hostedCheckoutUrl, setHostedCheckoutUrl] = useState<string | null>(null);
  const [error, setError] = useState<string | null>(null);

  // Return leg of the hosted Stripe Checkout. Stripe has already captured by the time it sends the
  // shopper back, so this only reconciles that authorization onto the Rose purchase record.
  useEffect(() => {
    const checkoutSessionId = new URLSearchParams(window.location.search).get(
      'checkout_session_id',
    );
    if (checkoutSessionId === null || checkoutSessionId === '') return;
    setSubmitting(true);
    settleTestPaymentCheckout(checkoutSessionId)
      .then((result) => {
        persistConfirmation(result);
        setConfirmation(result);
      })
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setSubmitting(false));
  }, []);

  useEffect(() => {
    if (!isDev || isLiveLifecycleFixture || isAbandonmentFixture) return;
    fetchTestPaymentItems()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isAbandonmentFixture, isDev, isLiveLifecycleFixture]);

  const totals = useMemo(
    () => calculateTotals(items, selectedIds, !isLiveLifecycleFixture),
    [isLiveLifecycleFixture, items, selectedIds],
  );
  const expectedItemCount = isLiveLifecycleFixture ? 1 : 3;
  // Live Place order must stay enabled without a merchant-form PAN: authorization happens on
  // Stripe Checkout, and browser agents often skip this form (fleet evidence: only #card-name
  // filled → disabled button → zero checkout-session calls). Optional last4 is still sent when
  // the number field has ≥4 digits.
  const canSubmit = selectedIds.length === expectedItemCount && !submitting && items.length > 0;

  if (!isEnabled) return <DisabledPage />;
  if (confirmation) return <Confirmation confirmation={confirmation} />;

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm font-medium uppercase text-muted-foreground">Rose Labs Checkout</p>
          <h1 className="text-4xl font-semibold">Test Payment</h1>
          <p className="max-w-2xl text-muted-foreground">Merchant: {TEST_PAYMENT_MERCHANT_NAME}</p>
        </header>

        {loading ? (
          <div className="flex items-center gap-2 text-muted-foreground">
            <Loader2 className="h-4 w-4 animate-spin" />
            Loading products
          </div>
        ) : (
          <ProductGrid items={items} selectedIds={selectedIds} setSelectedIds={setSelectedIds} />
        )}

        <div className="grid gap-5 lg:grid-cols-[1fr_360px]">
          <CardForm card={card} setCard={setCard} disabled={submitting} />
          <ReceiptSummary
            items={items}
            selectedIds={selectedIds}
            includeFees={!isLiveLifecycleFixture}
          />
        </div>

        {error && (
          <p className="rounded-md border border-destructive/40 bg-destructive/10 p-3 text-sm text-destructive">
            {error}
          </p>
        )}

        <button
          type="button"
          disabled={!canSubmit}
          onClick={async () => {
            setSubmitting(true);
            setError(null);
            setHostedCheckoutUrl(null);
            let handingOffToHostedCheckout = false;
            try {
              // The abandonment fixture must NEVER submit — the whole point of that benchmark is
              // that the minted card is left unspent so the reclaim/refund path can be asserted.
              if (isAbandonmentFixture) {
                throw new Error('This checkout is unavailable');
              }
              // Live fixture: hand off to a REAL hosted Stripe Checkout. A live Rose-minted card
              // cannot be charged any other way — AgentCard's test_charge is sandbox-only and
              // Stripe blocks live-mode raw-PAN tokenization — so this is what makes the page an
              // actual merchant rather than a fixture.
              if (isLiveLifecycleFixture) {
                const cardLast4 = card.number.replace(/\D/g, '').slice(-4);
                const { url } = await startTestPaymentCheckout(
                  selectedIds,
                  cardLast4.length === 4 ? cardLast4 : undefined,
                );
                // Keep submitting=true through unload. Clearing it in finally re-enabled Place
                // order while Steel sometimes stayed on /test_payment after location.assign, so
                // agents re-clicked and never completed Stripe Checkout (fleet 4a2ff6aa).
                handingOffToHostedCheckout = true;
                setHostedCheckoutUrl(url);
                window.location.href = url;
                return;
              }
              const confirmed = await confirmTestPayment(selectedIds, card);
              persistConfirmation(confirmed);
              setConfirmation(confirmed);
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              if (!handingOffToHostedCheckout) {
                setSubmitting(false);
              }
            }
          }}
          className="inline-flex items-center rounded-md bg-foreground px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          {isLiveLifecycleFixture ? 'Place order' : 'Pay'} {formatCents(totals.totalCents)}
        </button>

        {hostedCheckoutUrl ? (
          <p className="text-sm text-muted-foreground">
            Continuing to Stripe Checkout… If this page stays put, open{' '}
            <a
              href={hostedCheckoutUrl}
              data-testid="test-payment-hosted-checkout-link"
              className="font-medium text-foreground underline"
            >
              Continue to Stripe Checkout
            </a>
            .
          </p>
        ) : null}
      </div>
    </main>
  );
}
