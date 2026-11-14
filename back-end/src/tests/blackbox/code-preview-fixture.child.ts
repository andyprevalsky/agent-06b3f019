/** Private process for the code-preview fixture/socket contract; never starts a backend. */
import assert from 'node:assert/strict';
import fs from 'node:fs';
import fsPromises from 'node:fs/promises';
import { once } from 'node:events';
import { syncBuiltinESMExports } from 'node:module';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Worker } from 'node:worker_threads';

async function main(): Promise<void> {
  const closed = new Int32Array(new SharedArrayBuffer(4));
  const server = new Worker(
    `
    const { parentPort, workerData } = require('node:worker_threads');
    const { createServer } = require('node:http');
    const closed = new Int32Array(workerData);
    const sockets = new Set();
    const http = createServer((req, res) => {
      res.setHeader('content-type', 'application/json');
      res.end(JSON.stringify({status:'not_running', preview_url:null}));
    });
    http.on('connection', socket => {
      sockets.add(socket);
      socket.once('close', () => sockets.delete(socket));
    });
    http.listen(0, '127.0.0.1', () => parentPort.postMessage(http.address().port));
    parentPort.on('message', () => {
      const ports = [...sockets].map(socket => socket.remotePort);
      for (const socket of sockets) socket.destroy();
      Atomics.store(closed, 0, 1);
      Atomics.notify(closed, 0);
      parentPort.postMessage({closedPorts:ports});
    });
  `,
    { eval: true, workerData: closed.buffer }
  );
  const home = fs.mkdtempSync(join(tmpdir(), 'code-preview-fixture-'));
  const syncCopy = fs.cpSync;
  const asyncCopy = fsPromises.cp;
  let observedClose = false;
  let released = false;
  try {
    const [port] = await once(server, 'message');
    const baseUrl = `http://127.0.0.1:${port}`;
    const request = async (path: string) => {
      const response = await fetch(`${baseUrl}${path}`);
      const data = await response.json();
      assert.equal(response.status, 200);
      assert.deepEqual(data, { status: 'not_running', preview_url: null });
    };
    // Populate both native pool slots before the first filesystem operation.
    await request('/warm-one');
    await request('/warm-two');
    const release = () => {
      assert.equal(released, false, 'close the idle connections once');
      released = true;
      server.postMessage('close-idle');
    };
    const closedMessage = once(server, 'message').then(([message]) => {
      assert.ok(message.closedPorts.length > 0, 'the server closed a real pooled connection');
      observedClose = true;
    });
    // Simulate the peer closing an idle connection during real filesystem I/O.
    // The synchronization is event-driven: no sleep, keepalive tweak or load loop.
    fs.cpSync = ((...args: Parameters<typeof fs.cpSync>) => {
      if (!released) {
        release();
        while (Atomics.load(closed, 0) === 0) Atomics.wait(closed, 0, 0);
      }
      return syncCopy(...args);
    }) as typeof fs.cpSync;
    fsPromises.cp = (async (...args: Parameters<typeof fsPromises.cp>) => {
      if (!released) {
        release();
        await closedMessage;
      }
      return asyncCopy(...args);
    }) as typeof fsPromises.cp;
    syncBuiltinESMExports();
    const { makeRoseFrontEndHome } = await import('./code-preview.support');
    await makeRoseFrontEndHome(home);
    // Same pre-start preview response contract as the full HMR acceptance.
    await request('/api/claude-code-session/fixture/preview');
    await closedMessage;
    assert.equal(observedClose, true);
    console.log('PASS fixture copy drains closed keepalive before preview GET');
  } finally {
    fs.cpSync = syncCopy;
    fsPromises.cp = asyncCopy;
    syncBuiltinESMExports();
    await server.terminate();
    fs.rmSync(home, { recursive: true, force: true });
  }
}

main().catch((error: unknown) => {
  console.error(error);
  process.exitCode = 1;
});
