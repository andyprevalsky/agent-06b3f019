/** Real capture/replay boundary with a synthetic phone provider; no live credentials. */
import assert from 'node:assert/strict';
import express from 'express';
import type { Server } from 'node:http';
import { randomUUID } from 'node:crypto';
import { installFetchCapture, outboundReplayCacheKey } from '../../providers/fetchCapture';

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const oldReplay = process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
  process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = '1';
  const canary = `phone-private-${randomUUID()}`;
  const password = `${canary}-password`;
  const grantUrl = `https://api.phone-harness.com/iphone/c/${canary}`;
  let upstream = 0;
  globalThis.fetch = (async (input, init) => {
    const url = typeof input === 'string' ? input : input instanceof URL ? input.href : input.url;
    if (new URL(url).hostname === '127.0.0.1') return originalFetch(input, init);
    upstream++;
    if (url.endsWith('/error')) throw new Error(`${grantUrl} ${password}`);
    return new Response(
      JSON.stringify({
        control: { token: canary, url: grantUrl },
        watch_url: `${grantUrl}/watch`,
      }),
      { headers: { 'content-type': 'application/json' } }
    );
  }) as typeof fetch;
  let server: Server | undefined;
  try {
    const app = express();
    app.use('/captures', installFetchCapture());
    server = await new Promise<Server>((resolve) => {
      const listening = app.listen(0, '127.0.0.1', () => resolve(listening));
    });
    const address = server.address();
    assert(address !== null && typeof address === 'object');
    const base = `http://127.0.0.1:${address.port}`;
    const create = await fetch('https://api.phone-harness.com/sessions', {
      method: 'POST',
      headers: { Authorization: `Bearer ${canary}` },
      body: JSON.stringify({ platform: 'ios', kind: 'device', device_id: canary }),
    });
    assert.equal(
      (await create.json()).control.token,
      canary,
      'private response must reach its caller'
    );
    for (let index = 0; index < 2; index++) {
      await fetch(`${grantUrl}/op`, {
        method: 'POST',
        headers: { Authorization: `Bearer ${canary}` },
        body: JSON.stringify({ op: 'input.text', kw: { s: password } }),
      });
      await fetch(`https://rose-api.test/api/iphone/leases/${canary}/operations`, {
        method: 'POST',
        body: JSON.stringify({ operation: 'input.text', args: { s: password } }),
      });
    }
    await assert.rejects(fetch(`${grantUrl}/error`));
    const capture = JSON.stringify(await (await fetch(`${base}/captures`)).json());
    assert(!capture.includes(canary), 'phone capabilities and credentials leaked into capture');
    const key = outboundReplayCacheKey(`${grantUrl}/op`, 'POST', password);
    assert(!key.includes(canary), 'phone credentials leaked into replay keys');
    const firstPartyKey = outboundReplayCacheKey(
      `https://rose-api.test/api/iphone/leases/${canary}/operations`,
      'POST',
      password
    );
    assert(!firstPartyKey.includes(canary), 'phone interaction identity leaked into replay keys');
    assert.equal(upstream, 6, 'physical phone operations must never replay from fixtures');
    process.stdout.write('PASS phone capture privacy and live-operation replay exclusion\n');
  } finally {
    if (server !== undefined)
      await new Promise<void>((resolve, reject) => {
        server.close((error) => (error ? reject(error) : resolve()));
      });
    globalThis.fetch = originalFetch;
    if (oldReplay === undefined) delete process.env.BLACKBOX_TEST_REPLAY_OUTBOUND;
    else process.env.BLACKBOX_TEST_REPLAY_OUTBOUND = oldReplay;
  }
}
main().catch((error: unknown) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
