import { readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';

const SOURCE_ROOT = join(dirname(new URL(import.meta.url).pathname), '../..');

function readSource(relativePath: string): string {
  return readFileSync(join(SOURCE_ROOT, relativePath), 'utf-8');
}

function assert(condition: boolean, message: string): void {
  if (!condition) throw new Error(message);
}

export function assertMerchantClientIsolation(): void {
  const checkoutSource = readSource('domains/test-payment/checkout.ts');
  assert(
    checkoutSource.includes('getTestPaymentMerchantStripeClient'),
    'checkout.ts must acquire through the merchant client'
  );
  const stripeImport = /import \{([^}]*)\} from '\.\.\/\.\.\/providers\/stripe';/.exec(
    checkoutSource
  );
  assert(stripeImport !== null, 'checkout.ts should import from providers/stripe');
  const bindings = (stripeImport?.[1] ?? '')
    .split(',')
    .map((binding) => binding.replace(/^type\s+/, '').trim());
  assert(
    !bindings.includes('stripe'),
    'checkout.ts must not bind the billing `stripe` singleton; every Stripe call in the ' +
      'checkout path is an acquirer call and belongs on the merchant client'
  );
  for (const billingPath of [
    'domains/billing/service.ts',
    'domains/purchases/charge.ts',
    'domains/test-payment/lifecycle.ts',
    'domains/test-payment/service.ts',
    'providers/agentcard/checkout-settlement.ts',
    'domains/webhooks/service.ts',
  ]) {
    const source = readSource(billingPath);
    assert(
      !source.includes('getTestPaymentMerchantStripeClient('),
      `${billingPath} is a BILLING-side call site and must never use the merchant client: ` +
        'subscriptions, customers, and personal purchase holds live on STRIPE_SECRET_KEY'
    );
  }
  const billingService = readSource('domains/billing/service.ts');
  assert(
    billingService.includes('checkout.sessions.create'),
    'billing subscription checkout must still mint Stripe Checkout sessions'
  );
  assert(
    billingService.includes('getStripeClientForSecretKey') ||
      billingService.includes('stripe.checkout.sessions.create'),
    'billing subscription checkout must mint via the billing/live Stripe client, ' +
      'never the merchant acquirer client'
  );
}
