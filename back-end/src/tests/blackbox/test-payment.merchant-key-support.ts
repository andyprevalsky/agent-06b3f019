import { TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV, stripe, type Stripe } from '../../providers/stripe';

export const FAKE_MERCHANT_KEY = 'sk_test_merchant_blackbox_never_dialed';

export function withMerchantKey<T>(key: string | undefined, fn: () => T): T {
  const previous = process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
  const restore = () => {
    if (previous === undefined) delete process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
    else process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = previous;
  };
  if (key === undefined) delete process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV];
  else process.env[TEST_PAYMENT_MERCHANT_SECRET_KEY_ENV] = key;
  try {
    const result = fn();
    if (result instanceof Promise) return result.finally(restore) as T;
    restore();
    return result;
  } catch (error) {
    restore();
    throw error;
  }
}

interface CheckoutSessionsResource {
  create: (params: unknown) => Promise<{ id: string; url: string | null }>;
  retrieve: (id: string, params?: unknown) => Promise<unknown>;
}

function checkoutSessions(client: Stripe): CheckoutSessionsResource {
  return client.checkout.sessions as unknown as CheckoutSessionsResource;
}

export interface StubbedCall {
  client: 'merchant' | 'billing';
  op: 'create' | 'retrieve';
  params?: unknown;
}

export async function withBothCheckoutClientsStubbed<T>(
  merchant: Stripe,
  session: { id: string; url: string | null; retrieved: unknown },
  fn: (calls: StubbedCall[]) => Promise<T>
): Promise<T> {
  const calls: StubbedCall[] = [];
  const targets: Array<{ label: 'merchant' | 'billing'; resource: CheckoutSessionsResource }> = [
    { label: 'merchant', resource: checkoutSessions(merchant) },
    { label: 'billing', resource: checkoutSessions(stripe) },
  ];
  const originals = targets.map(({ resource }) => ({
    create: resource.create,
    retrieve: resource.retrieve,
  }));
  for (const { label, resource } of targets) {
    resource.create = async (params) => {
      calls.push({ client: label, op: 'create', params });
      return { id: session.id, url: session.url };
    };
    resource.retrieve = async () => {
      calls.push({ client: label, op: 'retrieve' });
      return session.retrieved;
    };
  }
  try {
    return await fn(calls);
  } finally {
    targets.forEach(({ resource }, index) => {
      resource.create = originals[index].create;
      resource.retrieve = originals[index].retrieve;
    });
  }
}
