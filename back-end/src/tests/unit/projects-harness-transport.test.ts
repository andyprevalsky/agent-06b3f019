/** Exercise the real HTTP helper through dropped sockets; writes never retry. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import { once } from 'node:events';

async function main() {
  const counts = new Map<string, number>();
  const server = createServer((req, res) => {
    const path = req.url ?? '/';
    const key = `${req.method}:${path}`;
    const count = (counts.get(key) ?? 0) + 1;
    counts.set(key, count);
    if ((path === '/read' || path === '/head') && count === 1) {
      req.socket.destroy();
      return;
    }
    if (path === '/write' || path === '/always-drop') {
      req.socket.destroy();
      return;
    }
    res.writeHead(path === '/server-error' ? 503 : 200, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ ok: true }));
  });
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  const address = server.address();
  assert(address && typeof address !== 'string');
  process.env.TEST_BASE_URL = `http://127.0.0.1:${address.port}`;
  process.env.DATABASE_URL = 'postgresql://fixture:fixture@127.0.0.1:5432/fixture';
  const { call } = await import('../blackbox/projects-harness');
  try {
    await call('/warm');
    await new Promise((resolve) => setImmediate(resolve));
    assert.equal((await call('/read')).status, 200);
    assert.equal(counts.get('GET:/read'), 2);
    assert.equal((await call('/head', { method: 'HEAD' })).status, 200);
    assert.equal(counts.get('HEAD:/head'), 2);
    await assert.rejects(call('/write', { method: 'POST', body: { write: true } }), /fetch failed/);
    assert.equal(
      counts.get('POST:/write'),
      1,
      'write must never be duplicated after ambiguous delivery'
    );
    assert.equal((await call('/server-error')).status, 503);
    assert.equal(counts.get('GET:/server-error'), 1, 'HTTP errors are not transport retries');
    await assert.rejects(call('/always-drop'), /fetch failed/);
    assert.equal(counts.get('GET:/always-drop'), 2, 'read reconnect is bounded to one retry');
    const original = globalThis.fetch;
    let genericCalls = 0;
    globalThis.fetch = async () => {
      genericCalls += 1;
      throw new TypeError('fetch failed', { cause: { code: 'ENOTFOUND' } });
    };
    try {
      await assert.rejects(call('/dns-failure'), /fetch failed/);
    } finally {
      globalThis.fetch = original;
    }
    assert.equal(genericCalls, 1, 'unrelated fetch errors are not retried');
    process.stdout.write(
      'Projects HTTP harness: GET/HEAD socket reconnect, single-attempt POST/HTTP/DNS failures, bounded retry passed\n'
    );
  } finally {
    server.closeAllConnections();
    await new Promise<void>((resolve, reject) =>
      server.close((error) => (error ? reject(error) : resolve()))
    );
  }
}
main().catch((error) => {
  process.stderr.write(`${error instanceof Error ? error.stack : String(error)}\n`);
  process.exitCode = 1;
});
