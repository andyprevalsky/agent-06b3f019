import assert from 'node:assert/strict';
import Kernel from '@onkernel/sdk';
import { createRequire } from 'node:module';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

async function main() {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ items: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const require = createRequire(import.meta.url);
    const { isKernelProxyCreate } = require('../../../scripts/blackbox-kernel-proxy-custody.cjs');
    const kernel = new Kernel({ apiKey: 'fixture', maxRetries: 0 });
    await assert.rejects(
      kernel.proxies.create({ type: 'mobile', name: 'fixture', config: { country: 'US' } }),
      /Blackbox proxy reuse required/
    );
    assert.equal(calls, 0, 'actual SDK create must be refused before provider fetch');
    await kernel.proxies.list({ query: 'existing', limit: 100 });
    assert.equal(calls, 1, 'listing shared proxies remains available');
    await kernel.proxies.retrieve('shared');
    assert.equal(calls, 2, 'retrieving shared proxy remains available');
    assert.equal(isKernelProxyCreate('https://api.onkernel.com/proxies', { method: 'GET' }), false);
    assert.equal(
      isKernelProxyCreate('https://api.onkernel.com/proxies/?scope=live', { method: 'POST' }),
      true
    );
    for (const script of ['run-blackbox-tests.sh', 'run-coverage.sh']) {
      const source = readFileSync(resolve(__dirname, '../../../scripts', script), 'utf8');
      assert(
        source.includes(
          'NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$SCRIPT_DIR/blackbox-kernel-proxy-custody.cjs"'
        ),
        `${script} must preload custody while retaining caller Node options`
      );
    }
    assert.equal(
      isKernelProxyCreate(new Request('https://api.onkernel.com/proxies', { method: 'POST' })),
      true
    );
    assert.equal(
      isKernelProxyCreate('https://unrelated.example/proxies', { method: 'POST' }),
      false
    );
    process.stdout.write(
      'Isolated blackbox Kernel custody: SDK allocation refused before network; reuse reads preserved\n'
    );
  } finally {
    globalThis.fetch = original;
  }
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
