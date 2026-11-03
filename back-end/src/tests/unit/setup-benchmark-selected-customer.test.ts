/** Native Stripe SDK loopback proves exact selected fixture validation; no provisioning. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import Stripe from 'stripe';
import { requireOwnedLiveFixtureCustomer } from '../../../scripts/setup-benchmark-payment-guards';

async function main(): Promise<void> {
  let customer: Record<string, unknown> = {};
  let requests = 0;
  const server = createServer((request, response) => {
    // Host port detectors probe new listeners with `HEAD /`; the Stripe SDK
    // only issues GETs here, so count and assert only those.
    if (request.method === 'HEAD') {
      response.statusCode = 405;
      response.end();
      return;
    }
    requests += 1;
    assert.equal(request.method, 'GET');
    assert.equal(request.url, '/v1/customers/cus_selected');
    response.setHeader('content-type', 'application/json');
    response.end(JSON.stringify(customer));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  const stripe = new Stripe('sk_live_local_fixture', {
    host: '127.0.0.1',
    port: address.port,
    protocol: 'http',
    maxNetworkRetries: 0,
  });
  const valid = {
    id: 'cus_selected',
    object: 'customer',
    livemode: true,
    metadata: { userId: 'fixture-user', fixture: 'agent-payment-production-lifecycle' },
  };
  try {
    customer = valid;
    assert.equal(
      await requireOwnedLiveFixtureCustomer(stripe, 'cus_selected', 'fixture-user'),
      'cus_selected'
    );
    for (const invalid of [
      { ...valid, deleted: true },
      { ...valid, livemode: false },
      { ...valid, id: 'cus_other' },
      { ...valid, metadata: { ...valid.metadata, userId: 'foreign-user' } },
      { ...valid, metadata: { userId: 'fixture-user' } },
      { ...valid, metadata: undefined },
      { ...valid, metadata: { ...valid.metadata, fixture: 'unrelated' } },
    ]) {
      customer = invalid;
      await assert.rejects(
        requireOwnedLiveFixtureCustomer(stripe, 'cus_selected', 'fixture-user'),
        /not an owned live/
      );
    }
    await assert.rejects(
      requireOwnedLiveFixtureCustomer(stripe, '', 'fixture-user'),
      /must not be blank/
    );
    assert.equal(requests, 8);
    process.stdout.write('PASS 9 selected customer controls; 8 read-only loopback SDK requests\n');
  } finally {
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${String(error)}\n`);
  process.exitCode = 1;
});
