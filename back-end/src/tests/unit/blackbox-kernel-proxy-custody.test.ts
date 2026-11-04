import assert from 'node:assert/strict';
import Kernel from '@onkernel/sdk';
import { createRequire } from 'node:module';
import { readFileSync, mkdtempSync, copyFileSync, rmSync } from 'node:fs';
import { resolve, join } from 'node:path';
import { tmpdir } from 'node:os';
import { execFileSync } from 'node:child_process';
import { createServer } from 'node:http';

async function main() {
  const original = globalThis.fetch;
  const originalBase = process.env.KERNEL_BASE_URL;
  let calls = 0;
  globalThis.fetch = async () => {
    calls += 1;
    return new Response(JSON.stringify({ items: [] }), {
      headers: { 'content-type': 'application/json' },
    });
  };
  try {
    const require = createRequire(import.meta.url);
    const {
      isKernelProxyCreate,
      installKernelProxyCustody,
    } = require('../../../scripts/blackbox-kernel-proxy-custody.cjs');
    // NODE_OPTIONS may have loaded the module before this test replaced fetch.
    installKernelProxyCustody(globalThis.fetch);
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
        source.includes('NODE_OPTIONS="${NODE_OPTIONS:+$NODE_OPTIONS }--require=$(node -p'),
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
    process.env.KERNEL_BASE_URL = 'https://gateway.example.com/kernel/';
    const prefixed = new Kernel({ apiKey: 'fixture', maxRetries: 0 });
    await assert.rejects(
      prefixed.proxies.create({ type: 'mobile', name: 'fixture', config: { country: 'US' } }),
      /Blackbox proxy reuse required/
    );
    assert.equal(calls, 2, 'configured gateway cannot bypass the allocation guard');
    assert.equal(
      isKernelProxyCreate('https://gateway.example.com/kernel/proxies/', { method: 'POST' }),
      true
    );
    assert.equal(
      isKernelProxyCreate('https://gateway.example.com/kernel/proxies', { method: 'GET' }),
      false
    );
    assert.equal(
      isKernelProxyCreate('https://gateway.example.com/other/proxies', { method: 'POST' }),
      false
    );

    const folder = mkdtempSync(join(tmpdir(), 'rose custody with spaces '));
    try {
      const preload = join(folder, 'guard.cjs');
      copyFileSync(
        resolve(__dirname, '../../../scripts/blackbox-kernel-proxy-custody.cjs'),
        preload
      );
      const result = execFileSync(
        process.execPath,
        [
          '-e',
          'if (!globalThis[Symbol.for("rose.test.kernelProxyCustody")]) process.exit(1); console.log("guarded")',
        ],
        {
          env: {
            ...process.env,
            NODE_OPTIONS: `--no-warnings --require=${JSON.stringify(preload)}`,
          },
          encoding: 'utf8',
        }
      );
      assert.match(result, /guarded/);
    } finally {
      rmSync(folder, { recursive: true, force: true });
    }

    const {
      verifyKernelProxyCustody,
    } = require('../../../scripts/verify-kernel-proxy-custody.cjs');
    // Use the genuine fetch for local HTTP proof; no provider network is accessed.
    globalThis.fetch = original;
    let guarded = false;
    const server = createServer((_req, res) => {
      if (guarded) res.setHeader('x-rose-kernel-proxy-custody', 'enforced-v1');
      res.end('{}');
    });
    await new Promise<void>((done) => server.listen(0, '127.0.0.1', done));
    try {
      const address = server.address();
      assert.ok(address && typeof address === 'object');
      const url = `http://127.0.0.1:${address.port}`;
      await assert.rejects(verifyKernelProxyCustody(url), /must preload/);
      guarded = true;
      await verifyKernelProxyCustody(url);
    } finally {
      await new Promise<void>((done) => server.close(() => done()));
    }
    process.stdout.write(
      'Isolated blackbox Kernel custody: SDK allocation refused before network; reuse reads preserved\n'
    );
  } finally {
    globalThis.fetch = original;
    if (originalBase === undefined) delete process.env.KERNEL_BASE_URL;
    else process.env.KERNEL_BASE_URL = originalBase;
  }
}
main().catch((error) => {
  process.stderr.write(String(error));
  process.exitCode = 1;
});
