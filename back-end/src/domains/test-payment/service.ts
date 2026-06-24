import { randomUUID } from 'node:crypto';
import { stripe } from '../../providers/stripe';
import type {
  TestPaymentConfirmInput,
  TestPaymentConfirmation,
  TestPaymentItem,
  TestPaymentLineItem,
  TestPaymentReceiptLine,
  TestPaymentTotals,
} from './types';

const TAX_BPS = 825;
const SHIPPING_CENTS = 499;
const STRIPE_VISA_TEST_PAYMENT_METHOD = 'pm_card_visa';

export class TestPaymentError extends Error {
  constructor(
    message: string,
    readonly statusCode = 400
  ) {
    super(message);
  }
}

export const TEST_PAYMENT_ITEMS: TestPaymentItem[] = [
  {
    id: 'aurora-notebook',
    name: 'Aurora Notebook',
    description: 'Hardcover planning notebook with dotted pages.',
    imageUrl: 'https://placehold.co/320x220/png?text=Aurora+Notebook',
    priceCents: 1200,
  },
  {
    id: 'copper-pen',
    name: 'Copper Pen',
    description: 'Weighted refillable pen for precise notes.',
    imageUrl: 'https://placehold.co/320x220/png?text=Copper+Pen',
    priceCents: 700,
  },
  {
    id: 'ceramic-mug',
    name: 'Ceramic Mug',
    description: 'Matte white mug for long checkout tests.',
    imageUrl: 'https://placehold.co/320x220/png?text=Ceramic+Mug',
    priceCents: 900,
  },
  {
    id: 'canvas-tote',
    name: 'Canvas Tote',
    description: 'Heavy canvas tote with reinforced handles.',
    imageUrl: 'https://placehold.co/320x220/png?text=Canvas+Tote',
    priceCents: 1500,
  },
  {
    id: 'desk-lamp',
    name: 'Desk Lamp',
    description: 'Compact LED lamp with warm dimming.',
    imageUrl: 'https://placehold.co/320x220/png?text=Desk+Lamp',
    priceCents: 2200,
  },
];

const ITEMS_BY_ID = new Map(TEST_PAYMENT_ITEMS.map((item) => [item.id, item]));

function assertCardPresent(input: TestPaymentConfirmInput): void {
  const card = input.card;
  if (!card || typeof card !== 'object') throw new TestPaymentError('card is required');
  if (typeof card.number !== 'string' || card.number.replace(/\s+/g, '').length < 12) {
    throw new TestPaymentError('card number is required');
  }
  if (typeof card.expiry !== 'string' || !/^\d{2}\s*\/?\s*\d{2,4}$/.test(card.expiry.trim())) {
    throw new TestPaymentError('card expiry is required');
  }
  if (typeof card.cvv !== 'string' || card.cvv.trim().length < 3) {
    throw new TestPaymentError('card cvv is required');
  }
  if (typeof card.name !== 'string' || card.name.trim() === '') {
    throw new TestPaymentError('card name is required');
  }
}

function normalizeExpiry(expiry: string): { expMonth: number; expYear: number } {
  const match = expiry.trim().match(/^(\d{2})\s*\/?\s*(\d{2}|\d{4})$/);
  if (!match) throw new TestPaymentError('card expiry is invalid');
  const expMonth = Number(match[1]);
  const rawYear = Number(match[2]);
  const expYear = rawYear < 100 ? 2000 + rawYear : rawYear;
  if (expMonth < 1 || expMonth > 12) throw new TestPaymentError('card expiry month is invalid');
  return { expMonth, expYear };
}

function isAgentCardSandboxPan(cardNumber: string): boolean {
  return /^424242424242\d{4}$/.test(cardNumber.replace(/\s+/g, ''));
}

function normalizeLineItems(items: TestPaymentLineItem[]): TestPaymentReceiptLine[] {
  if (!Array.isArray(items)) throw new TestPaymentError('items are required');
  if (items.length !== 3) throw new TestPaymentError('exactly 3 distinct test items are required');

  const seen = new Set<string>();
  return items.map((line) => {
    if (typeof line?.id !== 'string') throw new TestPaymentError('item id is required');
    if (seen.has(line.id)) throw new TestPaymentError('duplicate items are not allowed');
    seen.add(line.id);

    const item = ITEMS_BY_ID.get(line.id);
    if (!item) throw new TestPaymentError(`unknown item: ${line.id}`);
    const quantity = Number(line.quantity);
    if (!Number.isInteger(quantity) || quantity !== 1) {
      throw new TestPaymentError('each benchmark item quantity must be exactly 1');
    }
    return {
      id: item.id,
      name: item.name,
      imageUrl: item.imageUrl,
      quantity,
      unitPriceCents: item.priceCents,
      lineTotalCents: item.priceCents * quantity,
    };
  });
}

function calculateTotals(lineItems: TestPaymentReceiptLine[]): TestPaymentTotals {
  const subtotalCents = lineItems.reduce((sum, item) => sum + item.lineTotalCents, 0);
  const taxCents = Math.round((subtotalCents * TAX_BPS) / 10_000);
  const shippingCents = SHIPPING_CENTS;
  return {
    subtotalCents,
    taxCents,
    shippingCents,
    totalCents: subtotalCents + taxCents + shippingCents,
  };
}

export function getTestPaymentCatalog(): { items: TestPaymentItem[] } {
  return { items: TEST_PAYMENT_ITEMS };
}

/**
 * Resolve a publicly reachable base URL for the local test-payment site by inspecting the
 * running ngrok agent (127.0.0.1:4040). Returns the https tunnel whose addr targets THIS
 * backend's port, or null when no matching tunnel is up.
 *
 * Used so the dev "Test Agent Debit Card" querybox prompt can hand the cloud browser agent a
 * reachable URL instead of localhost (which it cannot reach). Mirrors the benchmark's
 * `_ngrok_public_url_for_port` logic.
 */
export async function resolvePublicBaseUrl(): Promise<string | null> {
  // Preferred: the stable URL exported by run.sh (e.g. a reserved ngrok domain).
  const explicit = process.env.PUBLIC_BASE_URL?.trim();
  if (explicit) return explicit.replace(/\/$/, '');

  // Fallback: discover an ad-hoc ngrok tunnel pointing at this backend's port.
  const port = String(process.env.PORT || 3001);
  try {
    const response = await fetch('http://127.0.0.1:4040/api/tunnels', {
      signal: AbortSignal.timeout(1500),
    });
    if (!response.ok) return null;
    const data = (await response.json()) as {
      tunnels?: Array<{ public_url?: string; config?: { addr?: string } }>;
    };
    for (const tunnel of data.tunnels ?? []) {
      const publicUrl = tunnel.public_url ?? '';
      const addr = tunnel.config?.addr ?? '';
      if (publicUrl.startsWith('https://') && addr.endsWith(`:${port}`)) {
        return publicUrl.replace(/\/$/, '');
      }
    }
    return null;
  } catch {
    return null;
  }
}

export function renderTestPaymentPage(): string {
  return `<!doctype html>
<html lang="en">
<head>
  <meta charset="utf-8" />
  <meta name="viewport" content="width=device-width, initial-scale=1" />
  <title>Rose Labs Test Payment</title>
  <style>
    body { margin: 0; font-family: Arial, sans-serif; color: #171717; background: #f7f7f8; }
    main { max-width: 1120px; margin: 0 auto; padding: 28px 20px 48px; }
    h1 { margin: 6px 0 4px; font-size: 32px; }
    .eyebrow { font-size: 12px; text-transform: uppercase; color: #666; }
    .merchant { color: #555; margin: 0 0 24px; }
    .grid { display: grid; grid-template-columns: repeat(5, minmax(150px, 1fr)); gap: 14px; }
    .product { background: #fff; border: 1px solid #ddd; border-radius: 8px; overflow: hidden; }
    .product img { width: 100%; height: 128px; object-fit: cover; background: #ddd; display: block; }
    .product-body { padding: 14px; display: grid; gap: 8px; }
    .row { display: flex; align-items: center; justify-content: space-between; gap: 12px; }
    button { border: 1px solid #ccc; background: #fff; border-radius: 8px; padding: 9px 14px; cursor: pointer; }
    button.selected, button.primary { background: #111; color: #fff; border-color: #111; }
    .checkout { display: grid; grid-template-columns: minmax(0, 1fr) 360px; gap: 20px; margin-top: 22px; }
    .panel { background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 16px; }
    label { display: grid; gap: 6px; margin: 10px 0; font-size: 13px; font-weight: 600; }
    input { border: 1px solid #ccc; border-radius: 8px; padding: 12px; font-size: 16px; }
    .two { display: grid; grid-template-columns: 1fr 1fr; gap: 12px; }
    .muted { color: #666; font-size: 13px; }
    .summary-line { display: grid; grid-template-columns: 1fr auto; gap: 10px; margin: 10px 0; }
    .total { border-top: 1px solid #ddd; padding-top: 12px; font-weight: 700; }
    .confirmation { max-width: 680px; margin: 88px auto; background: #fff; border: 1px solid #ddd; border-radius: 8px; padding: 28px; }
    @media (max-width: 900px) { .grid, .checkout { grid-template-columns: 1fr; } }
  </style>
</head>
<body>
  <main>
    <div class="eyebrow">Dev-only checkout</div>
    <h1>Test Payment</h1>
    <p class="merchant">Merchant: <span id="merchant-name">Rose Labs Test Payment</span></p>
    <section id="products" class="grid" aria-label="Products"></section>
    <section class="checkout">
      <form id="payment-form" class="panel">
        <h2>Payment details</h2>
        <label>Name on card <input id="card-name" autocomplete="cc-name" /></label>
        <label>Card number <input id="card-number" inputmode="numeric" autocomplete="cc-number" /></label>
        <div class="two">
          <label>Expiration date <input id="card-expiry" autocomplete="cc-exp" placeholder="MM/YY" /></label>
          <label>Security code <input id="card-cvv" autocomplete="cc-csc" /></label>
        </div>
        <label>Postal code <input id="postal-code" autocomplete="postal-code" value="94105" /></label>
        <button id="pay-button" class="primary" type="submit">Pay $43.96</button>
        <p id="error" class="muted" role="alert"></p>
      </form>
      <aside id="receipt" class="panel" data-merchant="Rose Labs Test Payment" aria-label="Order summary">
        <h2>Order summary</h2>
        <p class="muted">Merchant: Rose Labs Test Payment</p>
        <div id="receipt-lines"></div>
        <div class="summary-line"><span>Subtotal</span><span id="subtotal">$0.00</span></div>
        <div class="summary-line"><span>Tax</span><span id="tax">$0.00</span></div>
        <div class="summary-line"><span>Shipping</span><span id="shipping">$0.00</span></div>
        <div class="summary-line total"><span>Total</span><span id="total">$0.00</span></div>
      </aside>
    </section>
  </main>
  <script>
    const merchant = 'Rose Labs Test Payment';
    const selected = new Set(['aurora-notebook', 'ceramic-mug', 'canvas-tote']);
    let items = [];
    const cents = (value) => '$' + (value / 100).toFixed(2);
    const selectedItems = () => items.filter((item) => selected.has(item.id));
    const totals = () => {
      const subtotalCents = selectedItems().reduce((sum, item) => sum + item.priceCents, 0);
      const taxCents = Math.round(subtotalCents * 0.0825);
      const shippingCents = 499;
      return { subtotalCents, taxCents, shippingCents, totalCents: subtotalCents + taxCents + shippingCents };
    };
    function render() {
      document.getElementById('products').innerHTML = items.map((item) => {
        const isSelected = selected.has(item.id);
        return '<article class="product" data-product-id="' + item.id + '" data-product-name="' + item.name + '" data-image-url="' + item.imageUrl + '" data-unit-price-cents="' + item.priceCents + '">' +
          '<img src="' + item.imageUrl + '" alt="' + item.name + '" />' +
          '<div class="product-body"><strong>' + item.name + '</strong><span class="muted">' + item.description + '</span><span class="muted">Image URL: ' + item.imageUrl + '</span>' +
          '<div class="row"><span>' + cents(item.priceCents) + '</span><button type="button" class="' + (isSelected ? 'selected' : '') + '" aria-pressed="' + isSelected + '" data-select-id="' + item.id + '">' + (isSelected ? 'Selected' : 'Select') + '</button></div></div></article>';
      }).join('');
      const receiptLines = selectedItems().map((item) => '<div class="summary-line" data-line-item-id="' + item.id + '" data-line-item-name="' + item.name + '" data-line-item-image-url="' + item.imageUrl + '" data-line-item-unit-price-cents="' + item.priceCents + '" data-line-item-quantity="1" data-line-item-total-cents="' + item.priceCents + '"><span><strong>' + item.name + ' x1</strong><br><span class="muted">Image URL: ' + item.imageUrl + '</span></span><span>' + cents(item.priceCents) + '</span></div>').join('');
      const t = totals();
      const receipt = document.getElementById('receipt');
      receipt.dataset.subtotalCents = String(t.subtotalCents);
      receipt.dataset.taxCents = String(t.taxCents);
      receipt.dataset.shippingCents = String(t.shippingCents);
      receipt.dataset.totalCents = String(t.totalCents);
      document.getElementById('receipt-lines').innerHTML = receiptLines;
      document.getElementById('subtotal').textContent = cents(t.subtotalCents);
      document.getElementById('tax').textContent = cents(t.taxCents);
      document.getElementById('shipping').textContent = cents(t.shippingCents);
      document.getElementById('total').textContent = cents(t.totalCents);
      document.getElementById('pay-button').textContent = 'Pay ' + cents(t.totalCents);
    }
    document.addEventListener('click', (event) => {
      const button = event.target.closest('[data-select-id]');
      if (!button) return;
      const id = button.dataset.selectId;
      selected.has(id) ? selected.delete(id) : selected.add(id);
      render();
    });
    document.getElementById('payment-form').addEventListener('submit', async (event) => {
      event.preventDefault();
      document.getElementById('error').textContent = '';
      const response = await fetch('/api/test-payment/confirm', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          items: selectedItems().map((item) => ({ id: item.id, quantity: 1 })),
          card: {
            name: document.getElementById('card-name').value,
            number: document.getElementById('card-number').value,
            expiry: document.getElementById('card-expiry').value,
            cvv: document.getElementById('card-cvv').value,
            postalCode: document.getElementById('postal-code').value
          }
        })
      });
      const result = await response.json();
      if (!response.ok) {
        document.getElementById('error').textContent = result.error || 'Payment failed';
        return;
      }
      document.body.innerHTML = '<main><section class="confirmation"><div class="eyebrow">Test confirmation</div><h1>Payment confirmed</h1><p>Order ID: <strong id="order-id">' + result.orderId + '</strong></p><p class="muted">Merchant: ' + merchant + '</p></section></main>';
    });
    fetch('/api/test-payment/items').then((res) => res.json()).then((data) => {
      items = data.items;
      render();
    });
  </script>
</body>
</html>`;
}

export async function confirmTestPayment(
  input: TestPaymentConfirmInput
): Promise<TestPaymentConfirmation> {
  const lineItems = normalizeLineItems(input.items);
  assertCardPresent(input);
  const totals = calculateTotals(lineItems);
  const { expMonth, expYear } = normalizeExpiry(input.card.expiry);
  const normalizedCardNumber = input.card.number.replace(/\s+/g, '');

  const paymentMethodId = isAgentCardSandboxPan(normalizedCardNumber)
    ? STRIPE_VISA_TEST_PAYMENT_METHOD
    : (
        await stripe.paymentMethods.create({
          type: 'card',
          card: {
            number: normalizedCardNumber,
            exp_month: expMonth,
            exp_year: expYear,
            cvc: input.card.cvv.trim(),
          },
          billing_details: {
            name: input.card.name.trim(),
            address: input.card.postalCode
              ? { postal_code: input.card.postalCode.trim() }
              : undefined,
          },
        })
      ).id;

  const paymentIntent = await stripe.paymentIntents.create({
    amount: totals.totalCents,
    currency: 'usd',
    payment_method: paymentMethodId,
    payment_method_types: ['card'],
    confirm: true,
    metadata: {
      testPayment: 'true',
      itemIds: lineItems.map((item) => item.id).join(','),
    },
  });

  if (paymentIntent.status !== 'succeeded') {
    throw new TestPaymentError(`Stripe test payment did not succeed: ${paymentIntent.status}`, 402);
  }

  return {
    orderId: `tp_${randomUUID().slice(0, 8)}`,
    status: paymentIntent.status,
    paymentIntentId: paymentIntent.id,
    receipt: { lineItems, totals },
  };
}
