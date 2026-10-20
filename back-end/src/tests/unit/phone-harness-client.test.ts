import './phone-identity-projection.cases';
import './phone-message-verifier.cases';
import './phone-settings-verification.cases';
import './phone-saved-credential.cases';
import './phone-setup-verifier.cases';
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { PhoneHarnessClient } from '../../providers/phoneHarness';

const accountKey = 'canary-account-key';
const controlToken = 'canary-control-token';
const controlUrl = 'https://api.phone-harness.com/iphone/c/canary-grant';
const future = () => Math.floor(Date.now() / 1000) + 3600;
const wireSession = () => ({
  id: 'session-1',
  platform: 'ios',
  kind: 'device',
  state: 'ready',
  expires_at: future(),
  request_key: 'request-1',
  cleanup_complete: false,
  close_requested: false,
  control: { url: controlUrl, token: controlToken, expires_at: future() },
});
function fixture(responses: (Response | Error)[]) {
  const calls: { url: string; init: RequestInit }[] = [];
  const fetchImpl: typeof fetch = async (input, init) => {
    calls.push({ url: String(input), init: init ?? {} });
    const response = responses.shift();
    if (response instanceof Error) throw response;
    assert.ok(response, 'Unexpected retry or additional request');
    return response;
  };
  return { calls, client: new PhoneHarnessClient({ apiKey: accountKey, fetchImpl }) };
}
const json = (body: unknown, status = 200) =>
  new Response(JSON.stringify(body), {
    status,
    headers: { 'Content-Type': 'application/json' },
  });

test('create explicitly selects dedicated iOS device and keeps the supplied idempotency key', async () => {
  const { client, calls } = fixture([
    json({ ...wireSession(), request_key: 'stable-request-key-0001' }),
  ]);
  const session = await client.create('device-1', 'stable-request-key-0001');
  assert.equal(session.id, 'session-1');
  assert.ok(session.expiresAt !== null && session.expiresAt > Date.now() / 1000);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].url, 'https://api.phone-harness.com/sessions');
  assert.equal(calls[0].init.method, 'POST');
  assert.equal(new Headers(calls[0].init.headers).get('Authorization'), `Bearer ${accountKey}`);
  assert.equal(
    new Headers(calls[0].init.headers).get('Idempotency-Key'),
    'stable-request-key-0001'
  );
  assert.deepEqual(JSON.parse(String(calls[0].init.body)), {
    platform: 'ios',
    kind: 'device',
    device_id: 'device-1',
    timeout_seconds: 1800,
  });
});

async function ready(client: PhoneHarnessClient) {
  return client.get('session-1');
}
async function safeFailure(action: () => Promise<unknown>, outcome?: string, status?: number) {
  await assert.rejects(action, (error: unknown) => {
    assert.ok(error instanceof Error);
    const value = error as Error & { outcome: string; status: number | null; code: string };
    assert.ok(value.code);
    if (outcome) assert.equal(value.outcome, outcome);
    if (status !== undefined) assert.equal(value.status, status);
    const exposed = `${String(error)} ${JSON.stringify(error)}`;
    for (const secret of [accountKey, controlToken, controlUrl, 'canary-input-text']) {
      assert.ok(!exposed.includes(secret), `Error leaked ${secret}`);
    }
    return true;
  });
}

test('catalog returns only physical iOS devices and safe public fields', async () => {
  const { client } = fixture([
    json({
      available: [
        {
          id: 'iphone',
          platform: 'ios',
          kind: 'device',
          label: 'Phone',
          state: 'available',
          token: controlToken,
        },
        {
          id: 'android',
          platform: 'android',
          kind: 'device',
          label: 'Android',
          state: 'available',
        },
        { id: 'sim', platform: 'ios', kind: 'simulator', label: 'Sim', state: 'available' },
      ],
    }),
  ]);
  assert.deepEqual(await client.catalog(), [{ id: 'iphone', label: 'Phone', state: 'available' }]);
});

test('control operations use only control authorization and unwrap results', async () => {
  const { client, calls } = fixture([
    json(wireSession()),
    json({ ops: ['screen.text', 'input.text'] }),
    json({ result: { text: 'visible' } }),
  ]);
  const session = await ready(client);
  assert.deepEqual(await client.operations(session), ['screen.text', 'input.text']);
  assert.deepEqual(await client.perform(session, 'input.text', { text: 'canary-input-text' }), {
    text: 'visible',
  });
  for (const call of calls.slice(1)) {
    assert.equal(new Headers(call.init.headers).get('Authorization'), `Bearer ${controlToken}`);
    assert.ok(!JSON.stringify(call).includes(accountKey));
  }
  assert.equal(calls[1].url, `${controlUrl}/ops`);
  assert.equal(calls[2].url, `${controlUrl}/op`);
  assert.deepEqual(JSON.parse(String(calls[2].init.body)), {
    op: 'input.text',
    kw: { text: 'canary-input-text' },
  });
});

test('flat receipt without grant is normalized without inventing a ready phone', async () => {
  const { client, calls } = fixture([
    json({
      id: 'old-session',
      request_key: 'key/with?chars',
      state: 'closed',
      cleanup_complete: true,
      cleanup_pending: false,
    }),
  ]);
  const receipt = await client.recover('key/with?chars');
  assert.equal(receipt.requestKey, 'key/with?chars');
  assert.equal(receipt.cleanupComplete, true);
  if (receipt.session) {
    assert.equal(receipt.session.id, 'old-session');
    assert.equal(receipt.session.control, null);
  }
  assert.equal(calls[0].url, 'https://api.phone-harness.com/sessions/requests/key%2Fwith%3Fchars');
});

test('unknown receipt is an observation failure and never starts another phone', async () => {
  const { client, calls } = fixture([json({ error: 'unknown' }, 404)]);
  await safeFailure(() => client.recover('same-key'), 'rejected', 404);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].init.method ?? 'GET', 'GET');
});

test('stop 404 acknowledges not found without asserting cleanup completion', async () => {
  const { client, calls } = fixture([json({ error: 'missing' }, 404)]);
  assert.deepEqual(await client.stop('sid/with?chars'), { notFound: true });
  assert.equal(calls[0].url, 'https://api.phone-harness.com/sessions/sid%2Fwith%3Fchars');
  assert.equal(calls[0].init.method, 'DELETE');
});

test('successful stop reports only acknowledgement', async () => {
  const { client } = fixture([new Response(null, { status: 204 })]);
  assert.deepEqual(await client.stop('session-1'), { notFound: false });
});

for (const method of ['create', 'perform'] as const) {
  test(`ambiguous ${method} transport failure never retries and redacts thrown transport secrets`, async () => {
    const failure = new Error(`${accountKey} ${controlToken} ${controlUrl} canary-input-text`);
    const { client, calls } = fixture(
      method === 'create' ? [failure] : [json(wireSession()), failure]
    );
    const session = method === 'perform' ? await ready(client) : null;
    await safeFailure(
      () =>
        method === 'create'
          ? client.create('device', 'stable-request-key-0001')
          : client.perform(session!, 'input.text', { text: 'canary-input-text' }),
      'unknown'
    );
    assert.equal(calls.length, method === 'create' ? 1 : 2);
  });
}

test('profile_running conflict is surfaced without attaching or retrying', async () => {
  const { client, calls } = fixture([
    json({ code: 'profile_running', session_id: 'someone-elses-session', detail: accountKey }, 409),
  ]);
  await safeFailure(() => client.create('device', 'valid-request-key-0001'), 'rejected', 409);
  assert.equal(calls.length, 1);
});

for (const variation of [
  'provisioning',
  'missing-grant',
  'android',
  'simulator',
  'expired-session',
  'expired-control',
  'unknown-platform',
] as const) {
  test(`${variation} cannot perform control operations`, async () => {
    const wire = wireSession() as Record<string, unknown>;
    if (variation === 'provisioning') wire.state = 'provisioning';
    if (variation === 'missing-grant') wire.control = null;
    if (variation === 'android') wire.platform = 'android';
    if (variation === 'simulator') wire.kind = 'simulator';
    if (variation === 'unknown-platform') delete wire.platform;
    if (variation === 'expired-session') wire.expires_at = Math.floor(Date.now() / 1000);
    if (variation === 'expired-control')
      wire.control = {
        url: controlUrl,
        token: controlToken,
        expires_at: Math.floor(Date.now() / 1000),
      };
    const { client, calls } = fixture([json(wire)]);
    // Parsing may fail earlier for invalid/non-iOS sessions; either boundary must prevent control I/O.
    await safeFailure(async () => client.perform(await ready(client), 'screen.text', {}));
    assert.equal(calls.length, 1);
  });
}

test('provisioning session can be observed without a grant', async () => {
  const { client } = fixture([json({ ...wireSession(), state: 'provisioning', control: null })]);
  const session = await ready(client);
  assert.equal(session.state, 'provisioning');
  assert.equal(session.control, null);
});

for (const code of ['unsupported_operation', 'phone_locked', 'session_expired']) {
  test(`host ${code} is rejected safely without replay`, async () => {
    const { client, calls } = fixture([
      json(wireSession()),
      json(
        {
          error: {
            code,
            message: `${code} ${accountKey} ${controlToken} ${controlUrl} canary-input-text`,
          },
        },
        400
      ),
    ]);
    const session = await ready(client);
    await safeFailure(
      () => client.perform(session, 'input.text', { text: 'canary-input-text' }),
      'rejected',
      400
    );
    assert.equal(calls.length, 2);
  });
}

test('unsupported operation result in successful HTTP envelope still rejects', async () => {
  const { client } = fixture([
    json(wireSession()),
    json({ error: { code: 'unsupported_operation', message: controlToken } }),
  ]);
  const session = await ready(client);
  await safeFailure(() => client.perform(session, 'screen.text', {}));
});

for (const body of ['not json', '{}', 'null', JSON.stringify({ id: 'session', state: 42 })]) {
  test(`malformed session response is rejected (${body.slice(0, 15)})`, async () => {
    const { client } = fixture([
      new Response(body, { headers: { 'Content-Type': 'application/json' } }),
    ]);
    await safeFailure(() => ready(client));
  });
}

test('oversized JSON response fails closed', async () => {
  const { client } = fixture([json({ available: [], padding: 'x'.repeat(1024 * 1024 + 1) })]);
  await safeFailure(() => client.catalog());
});

const png = Uint8Array.from(
  Buffer.from(
    'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAQAAAC1HAwCAAAAC0lEQVR42mP8/x8AAwMCAO+jWZkAAAAASUVORK5CYII=',
    'base64'
  )
);

test('frame uses PNG API and returns bytes with control authorization only', async () => {
  const { client, calls } = fixture([
    json(wireSession()),
    new Response(png, { headers: { 'Content-Type': 'image/png' } }),
  ]);
  const session = await ready(client);
  assert.deepEqual(await client.frame(session), png);
  assert.equal(calls[1].url, `${controlUrl}/frame.png`);
  assert.equal(new Headers(calls[1].init.headers).get('Authorization'), `Bearer ${controlToken}`);
});
for (const variation of ['wrong-type', 'wrong-signature', 'oversized'] as const) {
  test(`frame rejects ${variation}`, async () => {
    const bytes =
      variation === 'oversized'
        ? new Uint8Array(8 * 1024 * 1024 + 1)
        : variation === 'wrong-signature'
          ? new Uint8Array([1, 2, 3])
          : png;
    const { client } = fixture([
      json(wireSession()),
      new Response(bytes, {
        headers: { 'Content-Type': variation === 'wrong-type' ? 'text/html' : 'image/png' },
      }),
    ]);
    const session = await ready(client);
    await safeFailure(() => client.frame(session));
  });
}

for (const apiUrl of [
  'http://api.phone-harness.com',
  'https://localhost',
  'https://127.0.0.1',
  'https://10.0.0.1',
  'https://169.254.169.254',
  'https://[::1]',
  'https://user:password@example.com',
  'https://example.com/?key=secret',
  'https://example.com/#secret',
]) {
  test(`rejects unsafe configured API origin ${apiUrl}`, async () => {
    await assert.rejects(
      async () =>
        new PhoneHarnessClient({
          apiKey: accountKey,
          apiUrl,
          fetchImpl: async () => {
            throw new Error('must not fetch');
          },
        })
    );
  });
}
for (const url of [
  'https://evil.example/control',
  'http://api.phone-harness.com/control',
  'https://127.0.0.1/control',
  'https://user:password@api.phone-harness.com/control',
  'https://api.phone-harness.com/control?token=secret',
]) {
  test(`rejects unsafe provider control grant ${url}`, async () => {
    const { client, calls } = fixture([
      json({ ...wireSession(), control: { url, token: controlToken, expires_at: future() } }),
    ]);
    await safeFailure(async () => client.perform(await ready(client), 'screen.text', {}));
    assert.equal(calls.length, 1);
  });
}

test('cloud GET transport failures are safe observation errors', async () => {
  const { client, calls } = fixture([new Error(`${accountKey} ${controlToken}`)]);
  await safeFailure(() => ready(client), 'rejected');
  assert.equal(calls.length, 1);
});

test('empty explicit account credential fails without network or fallback', async () => {
  let calls = 0;
  await assert.rejects(async () => {
    const client = new PhoneHarnessClient({
      apiKey: '',
      fetchImpl: async () => {
        calls++;
        throw new Error('unexpected');
      },
    });
    await client.catalog();
  });
  assert.equal(calls, 0);
});

test('configured public HTTPS origin permits only same-origin control and uses bounded signals', async () => {
  const calls: { url: string; init: RequestInit }[] = [];
  const responses = [
    json({
      ...wireSession(),
      control: {
        url: 'https://phone-api.example.com/iphone/c/grant',
        token: controlToken,
        expires_at: future(),
      },
    }),
    json({ result: true }),
  ];
  const client = new PhoneHarnessClient({
    apiKey: accountKey,
    apiUrl: 'https://phone-api.example.com',
    fetchImpl: async (input, init) => {
      calls.push({ url: String(input), init: init ?? {} });
      return responses.shift()!;
    },
  });
  const session = await ready(client);
  assert.equal(
    await client.perform(session, 'apps.launch', { bundle_id: 'com.example.app' }),
    true
  );
  assert.equal(calls[0].url, 'https://phone-api.example.com/sessions/session-1');
  assert.equal(calls[1].url, 'https://phone-api.example.com/iphone/c/grant/op');
  for (const call of calls) {
    assert.ok(
      call.init.signal instanceof AbortSignal,
      'Every request must have a bounded abort signal'
    );
    assert.equal(call.init.redirect, 'error', 'Never follow a redirect carrying authorization');
  }
});

test('get encodes the entire session id as one path segment', async () => {
  const { client, calls } = fixture([json(wireSession())]);
  await client.get('a/b?c#d');
  assert.equal(calls[0].url, 'https://api.phone-harness.com/sessions/a%2Fb%3Fc%23d');
});

test('normalized observation never exposes owner viewer capability fields', async () => {
  const { client } = fixture([
    json({
      ...wireSession(),
      viewer_url: 'https://viewer.example/canary-owner',
      owner_token: 'canary-owner',
    }),
  ]);
  const session = await ready(client);
  assert.ok(!JSON.stringify(session).includes('canary-owner'));
});

for (const malformed of [{ ops: [42] }, { operations: ['screen.text'] }, null]) {
  test(`malformed advertised operations reject ${JSON.stringify(malformed)}`, async () => {
    const { client } = fixture([json(wireSession()), json(malformed)]);
    const session = await ready(client);
    await safeFailure(() => client.operations(session));
  });
}

test('missing result in successful operation response is not reported as success', async () => {
  const { client } = fixture([json(wireSession()), json({})]);
  const session = await ready(client);
  await safeFailure(() => client.perform(session, 'screen.text', {}));
});

test('malformed catalog is not silently an empty device pool', async () => {
  const { client } = fixture([json({ available: 'not-an-array' })]);
  await safeFailure(() => client.catalog());
});

test('mismatched create receipt key is ambiguous and cannot silently bind another allocation', async () => {
  const { client, calls } = fixture([
    json({ ...wireSession(), request_key: 'different-request-key-0001' }),
  ]);
  await safeFailure(() => client.create('device', 'original-request-key-0001'), 'unknown');
  assert.equal(calls.length, 1);
});

test('phone locked remains a useful safe error without reflecting provider detail', async () => {
  const { client } = fixture([
    json(wireSession()),
    json({ code: 'phone_locked', error: `${controlToken} canary-input-text` }, 423),
  ]);
  const session = await ready(client);
  await assert.rejects(
    () => client.perform(session, 'screen.text', {}),
    (error: unknown) => {
      assert.ok(error instanceof Error);
      assert.match(error.message, /locked/i);
      assert.ok(!`${error.message} ${JSON.stringify(error)}`.includes(controlToken));
      return true;
    }
  );
});

for (const variation of [
  'header-only',
  'invalid-chunk-length',
  'missing-iend',
  'missing-idat',
] as const) {
  test(`frame rejects structurally invalid PNG ${variation}`, async () => {
    let bytes = png.slice();
    if (variation === 'header-only') bytes = bytes.slice(0, 24);
    if (variation === 'invalid-chunk-length')
      new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength).setUint32(33, 0x7fffffff);
    if (variation === 'missing-iend') bytes = bytes.slice(0, -12);
    if (variation === 'missing-idat')
      bytes = Uint8Array.from([...bytes.slice(0, 33), ...bytes.slice(-12)]);
    const { client } = fixture([
      json(wireSession()),
      new Response(bytes, { headers: { 'Content-Type': 'image/png' } }),
    ]);
    const session = await ready(client);
    await safeFailure(() => client.frame(session));
  });
}

for (const body of [null, 42, [], ['value']]) {
  test(`malformed successful mutation result ${JSON.stringify(body)} has unknown outcome without replay`, async () => {
    const { client, calls } = fixture([json(wireSession()), json(body)]);
    const session = await ready(client);
    await safeFailure(
      () => client.perform(session, 'input.text', { text: 'canary-input-text' }),
      'unknown'
    );
    assert.equal(calls.length, 2);
  });
}

for (const failure of [
  json({ error: `${accountKey} ${controlToken}` }, 500),
  new Error(`${accountKey} ${controlToken}`),
]) {
  test(`stop ${failure instanceof Error ? 'transport' : 'HTTP500'} ambiguity never retries`, async () => {
    const { client, calls } = fixture([failure]);
    await safeFailure(() => client.stop('session-1'), 'unknown');
    assert.equal(calls.length, 1);
    assert.equal(calls[0].init.method, 'DELETE');
  });
}

test('stop successful JSON null is not confused with a real 404 acknowledgement', async () => {
  const { client, calls } = fixture([json(null)]);
  await safeFailure(() => client.stop('session-1'), 'unknown');
  assert.equal(calls.length, 1);
});

for (const apiUrl of [
  'https://localhost.',
  'https://foo.localhost.',
  'https://localhost.localdomain',
]) {
  test(`rejects loopback hostname variant ${apiUrl}`, async () => {
    await assert.rejects(
      async () =>
        new PhoneHarnessClient({
          apiKey: accountKey,
          apiUrl,
          fetchImpl: async () => {
            throw new Error('must not fetch');
          },
        })
    );
  });
}

for (const requestKey of [
  'shortkey',
  'contains whitespace 0001',
  'contains/slash-0001',
  'nonASCII-é-key-0001',
  'x'.repeat(129),
]) {
  test(`invalid allocation idempotency key rejects before fetch (${requestKey.slice(0, 25)})`, async () => {
    const { client, calls } = fixture([json(wireSession())]);
    await safeFailure(() => client.create('device', requestKey), 'rejected');
    assert.equal(calls.length, 0);
  });
}

test('real transport rejects custom DNS alias API origins without network', async () => {
  assert.throws(
    () => new PhoneHarnessClient({ apiKey: accountKey, apiUrl: 'https://127.0.0.1.nip.io' })
  );
});

for (const requestKey of ['a'.repeat(16), 'z'.repeat(128)]) {
  test(`allocation accepts documented key length boundary ${requestKey.length}`, async () => {
    const { client, calls } = fixture([json({ ...wireSession(), request_key: requestKey })]);
    assert.equal((await client.create('device', requestKey)).requestKey, requestKey);
    assert.equal(calls.length, 1);
    assert.equal(new Headers(calls[0].init.headers).get('Idempotency-Key'), requestKey);
  });
}
