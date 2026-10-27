/** The actual lifecycle setup must not release its caller at registration-ready alone. */
import assert from 'node:assert/strict';
import { createServer } from 'node:http';
import {
  launchLifecycleNative,
  registerLifecycleServiceWorker,
  within,
} from './browser-session-lifecycle.fixture-support';

function barrier() {
  let release!: () => void;
  const promise = new Promise<void>((resolve) => {
    release = resolve;
  });
  return { promise, release };
}

(async () => {
  const claimEntered = barrier();
  const claimAllowed = barrier();
  let actions = 0;
  const server = createServer(async (request, response) => {
    if (request.url === '/worker.js') {
      response.setHeader('Content-Type', 'application/javascript');
      response.end(
        `self.addEventListener('install',()=>self.skipWaiting());self.addEventListener('activate',e=>e.waitUntil(fetch('/claim-barrier').then(()=>self.clients.claim())));self.addEventListener('fetch',e=>{if(new URL(e.request.url).pathname.startsWith('/.rose-checkpoint-'))e.respondWith(fetch('/checkpoint-origin-action').then(()=>new Response('<!doctype html>')));});`
      );
      return;
    }
    if (request.url === '/claim-barrier') {
      claimEntered.release();
      await claimAllowed.promise;
      response.end('claim');
      return;
    }
    if (request.url === '/checkpoint-origin-action') actions++;
    response.setHeader('Content-Type', 'text/html');
    response.end('<!doctype html>');
  });
  let owned: Awaited<ReturnType<typeof launchLifecycleNative>> | undefined;
  let setup: Promise<void> | undefined;
  try {
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const address = server.address();
    assert(address && typeof address !== 'string');
    owned = await launchLifecycleNative();
    const context = owned.browser.contexts()[0]!;
    const page = context.pages()[0] ?? (await context.newPage());
    await page.goto(`http://127.0.0.1:${address.port}`);
    let setupSettled = false;
    setup = registerLifecycleServiceWorker(page);
    void setup.then(
      () => {
        setupSettled = true;
      },
      () => {
        setupSettled = true;
      }
    );
    await within(claimEntered.promise);
    // This later page command observes ready after the setup callback subscribed
    // to it. Browser microtasks and the ordered CDP response are a phase receipt,
    // not a delay chosen to guess whether clients.claim has finished.
    const beforeClaim = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      await Promise.resolve();
      return {
        active: registration.active?.state,
        controlled: navigator.serviceWorker.controller !== null,
      };
    });
    await Promise.resolve();
    assert.equal(beforeClaim.active, 'activating');
    assert.equal(beforeClaim.controlled, false);
    assert.equal(
      setupSettled,
      false,
      'ready must not release setup before this page is controlled'
    );
    claimAllowed.release();
    await within(setup);
    const afterClaim = await page.evaluate(async () => {
      const registration = await navigator.serviceWorker.ready;
      return {
        active: navigator.serviceWorker.controller?.state,
        exact: navigator.serviceWorker.controller === registration.active,
      };
    });
    assert.equal(afterClaim.active, 'activated');
    assert.equal(afterClaim.exact, true);
    await page.evaluate(() =>
      fetch('/.rose-checkpoint-control').then((response) => response.text())
    );
    assert.equal(actions, 1, 'control proves the origin service worker is active');
    // An already controlled page is a valid immediate completion, with the same worker.
    await within(registerLifecycleServiceWorker(page));
    actions = 0;
    await page.evaluate(() =>
      fetch('/.rose-checkpoint-control').then((response) => response.text())
    );
    assert.equal(actions, 1, 'capture must not disable the original tab service worker');
    console.log('PASS lifecycle service-worker setup waits for exact activated page controller');
  } finally {
    claimAllowed.release();
    try {
      if (setup) await within(setup);
    } finally {
      try {
        await owned?.browser.close();
      } finally {
        server.closeAllConnections();
        await new Promise<void>((resolve) => server.close(() => resolve()));
      }
    }
  }
})().catch((error) => {
  console.error(error);
  process.exitCode = 1;
});
