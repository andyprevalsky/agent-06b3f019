/**
 * STATE MACHINE: TestPaymentPage
 *
 * [DEV_GATE] -- production build --> [DISABLED]
 * [DEV_GATE] -- dev build --> [LOADING_ITEMS]
 * [LOADING_ITEMS] -- success --> [SHOPPING]
 * [SHOPPING] -- user selects required items --> [CHECKOUT_READY]
 * [CHECKOUT_READY] -- submit card --> [CONFIRMING]
 * [CONFIRMING] -- success --> [CONFIRMED]
 * [CONFIRMING] -- API/Stripe error --> [CHECKOUT_ERROR]
 *
 * This page is a local benchmark merchant. It intentionally exposes real card
 * fields so browser agents must use request_payment_card and produce a full
 * receipt approval before filling the one-time card.
 */

import { useEffect, useMemo, useState } from 'react';
import { Check, CreditCard, Loader2, ShoppingCart } from 'lucide-react';
import { confirmTestPayment, fetchTestPaymentItems } from '../api';
import {
  EMPTY_CARD_FORM,
  REQUIRED_ITEM_IDS,
  SHIPPING_LABEL,
  TAX_LABEL,
  TEST_PAYMENT_MERCHANT_NAME,
} from '../config';
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

function calculateTotals(items: TestPaymentItem[], selectedIds: string[]) {
  const subtotalCents = calculateSubtotal(items, selectedIds);
  const taxCents = Math.round(subtotalCents * 0.0825);
  const shippingCents = 499;
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
        return (
          <article
            key={item.id}
            data-product-id={item.id}
            data-product-name={item.name}
            data-image-url={item.imageUrl}
            data-unit-price-cents={item.priceCents}
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

function ReceiptSummary({
  items,
  selectedIds,
}: {
  items: TestPaymentItem[];
  selectedIds: string[];
}) {
  const selected = selectedIds
    .map((id) => items.find((item) => item.id === id))
    .filter(Boolean) as TestPaymentItem[];
  const totals = calculateTotals(items, selectedIds);
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

function Confirmation({ confirmation }: { confirmation: TestPaymentConfirmation }) {
  return (
    <main className="min-h-screen bg-background p-8 text-foreground">
      <section
        data-testid="payment-confirmation"
        className="mx-auto max-w-2xl rounded-lg border bg-card p-8 text-card-foreground"
      >
        <div className="mb-4 flex items-center gap-3">
          <Check className="h-7 w-7 text-emerald-600" />
          <h1 className="text-3xl font-semibold">Payment confirmed</h1>
        </div>
        <p className="text-muted-foreground">Order {confirmation.orderId} was paid successfully.</p>
        <p className="mt-4 text-sm">
          Total charged: {formatCents(confirmation.receipt.totals.totalCents)}
        </p>
      </section>
    </main>
  );
}

export default function TestPaymentPage() {
  const isDev = import.meta.env.DEV === true;
  const [items, setItems] = useState<TestPaymentItem[]>([]);
  const [selectedIds, setSelectedIds] = useState<string[]>([...REQUIRED_ITEM_IDS]);
  const [card, setCard] = useState<TestPaymentCardForm>(EMPTY_CARD_FORM);
  const [confirmation, setConfirmation] = useState<TestPaymentConfirmation | null>(null);
  const [loading, setLoading] = useState(true);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (!isDev) return;
    fetchTestPaymentItems()
      .then(setItems)
      .catch((err) => setError(err instanceof Error ? err.message : String(err)))
      .finally(() => setLoading(false));
  }, [isDev]);

  const totals = useMemo(() => calculateTotals(items, selectedIds), [items, selectedIds]);
  const canSubmit = selectedIds.length === 3 && !submitting && items.length === 5;

  if (!isDev) return <DisabledPage />;
  if (confirmation) return <Confirmation confirmation={confirmation} />;

  return (
    <main className="min-h-screen bg-background p-6 text-foreground">
      <div className="mx-auto max-w-7xl space-y-6">
        <header className="space-y-2">
          <p className="text-sm font-medium uppercase text-muted-foreground">Dev-only checkout</p>
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
          <ReceiptSummary items={items} selectedIds={selectedIds} />
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
            try {
              setConfirmation(await confirmTestPayment(selectedIds, card));
            } catch (err) {
              setError(err instanceof Error ? err.message : String(err));
            } finally {
              setSubmitting(false);
            }
          }}
          className="inline-flex items-center rounded-md bg-foreground px-5 py-3 font-medium text-background disabled:cursor-not-allowed disabled:opacity-50"
        >
          {submitting ? <Loader2 className="mr-2 h-4 w-4 animate-spin" /> : null}
          Pay {formatCents(totals.totalCents)}
        </button>
      </div>
    </main>
  );
}
