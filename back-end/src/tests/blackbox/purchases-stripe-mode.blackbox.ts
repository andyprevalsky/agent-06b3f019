/** Real canonical Stripe clients + real customer helper; loopback HTTP only. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';

async function main(): Promise<void> {
  process.env.STRIPE_SECRET_KEY = 'sk_test_local_mode_fixture';
  process.env.STRIPE_SECRET_KEY_LIVE = 'sk_live_local_mode_fixture';
  const requests: Array<{ objectMode: boolean; keyMode: boolean }> = [];
  const server = createServer((request, response) => {
    const objectMode = request.url?.includes('cus_live') ?? false;
    const credential = Buffer.from(
      (request.headers.authorization ?? '').replace(/^Basic /, ''),
      'base64'
    ).toString();
    const keyMode =
      request.headers.authorization?.startsWith('Bearer sk_live_') === true ||
      credential.startsWith('sk_live_');
    requests.push({ objectMode, keyMode });
    response.setHeader('content-type', 'application/json');
    if (objectMode !== keyMode) {
      response.writeHead(404);
      response.end(
        JSON.stringify({
          error: {
            type: 'invalid_request_error',
            code: 'resource_missing',
            message: 'Customer belongs to the other local fixture mode',
          },
        })
      );
      return;
    }
    response.end(
      JSON.stringify({
        id: objectMode ? 'cus_live' : 'cus_test',
        object: 'customer',
        livemode: objectMode,
        invoice_settings: { default_payment_method: objectMode ? 'pm_live' : 'pm_test' },
      })
    );
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const failures: string[] = [];
  try {
    const { getStripeClientForLivemode } = await import('../../providers/stripe');
    for (const mode of [false, true]) {
      const client = getStripeClientForLivemode(mode) as unknown as {
        _setApiField: (name: string, value: unknown) => void;
      };
      client._setApiField('host', '127.0.0.1');
      client._setApiField('port', address.port);
      client._setApiField('protocol', 'http');
    }
    const { getCustomerDefaultPaymentMethodId } =
      await import('../../domains/purchases/stripeCustomer');
    for (const stripeLivemode of [false, true]) {
      try {
        // Mode comes from the persisted Subscription contract, not the global key.
        const subscription = {
          stripeCustomerId: stripeLivemode ? 'cus_live' : 'cus_test',
          stripeLivemode,
        };
        const method = await getCustomerDefaultPaymentMethodId(
          subscription.stripeCustomerId,
          undefined,
          subscription.stripeLivemode
        );
        assert.equal(method, stripeLivemode ? 'pm_live' : 'pm_test');
        assert.deepEqual(requests.at(-1), { objectMode: stripeLivemode, keyMode: stripeLivemode });
        console.log(`PASS persisted subscription mode ${stripeLivemode}`);
      } catch (error) {
        failures.push(
          `mode ${stripeLivemode}: ${error instanceof Error ? error.message : String(error)}`
        );
      }
    }
    assert.deepEqual(failures, []);
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
void main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
