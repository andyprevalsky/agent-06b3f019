#!/usr/bin/env tsx
/**
 * Take-control Google autofill: when a human takes control of a live browser,
 * the watcher drives Google's password challenge over real CDP (the same
 * attachCdp production uses), submitting every saved password for the shown
 * account until one is accepted or the user hands control back.
 */
import assert from 'node:assert/strict';
import { createServer } from 'node:net';
import { chromium } from '@playwright/test';
import { attachCdp, type CdpClient } from '../../domains/compute-grants/cdp';
import {
  startTakeControlAutofill,
  userHoldsControl,
} from '../../domains/browser-session/googleAutofillWatch';

const PWD_PAGE = `<!doctype html><body>
<div data-profile-identifier>andy@example.com</div>
<input type="password" name="Passwd" />
<div id="passwordNext"><button type="button" onclick="window.__submitted = document.querySelector('[name=Passwd]').value">Next</button></div>
</body>`;

async function freePort(): Promise<number> {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as { port: number };
  await new Promise((resolve) => server.close(resolve));
  return port;
}

/** The lease rule matches getBrowserControlState: an expired USER lease is the agent's. */
function leaseExpiryEndsControl(): void {
  const now = Date.parse('2026-11-05T00:00:00Z');
  const user = (lease: Date | null) => ({
    status: 'ACTIVE',
    controlState: 'USER',
    controlLeaseExpiresAt: lease,
  });
  assert.equal(userHoldsControl(user(new Date(now + 60_000)), now), true);
  assert.equal(userHoldsControl(user(null), now), true);
  assert.equal(
    userHoldsControl(user(new Date(now - 1)), now),
    false,
    'expired lease still autofilled'
  );
  assert.equal(userHoldsControl({ ...user(null), controlState: 'AGENT' }, now), false);
  assert.equal(userHoldsControl({ ...user(null), status: 'CLOSED' }, now), false);
  assert.equal(userHoldsControl(null, now), false);
}

/**
 * Only CONSECUTIVE failures stop the watcher: four failures, one healthy tick,
 * four more must not add up to the five-failure give-up.
 */
async function intermittentFailuresDoNotAccumulate(): Promise<void> {
  const outcomes = ['fail', 'fail', 'fail', 'fail', 'ok', 'fail', 'fail', 'fail', 'fail', 'ok'];
  let ticks = 0;
  let controlling = true;
  let closed = 0;
  const done = new Promise<void>((resolve) => {
    startTakeControlAutofill('task-intermittent', 'user-1', 'ws://unused', {
      isUserControlling: async () => {
        ticks += 1;
        if (ticks > outcomes.length) {
          controlling = false;
          resolve();
        }
        return controlling;
      },
      attach: async () =>
        ({
          evaluateAnyTarget: async () => {
            if (outcomes[ticks - 1] === 'fail') throw new Error('cdp read failed');
            return '';
          },
          close: () => {
            closed += 1;
          },
        }) as unknown as CdpClient,
      pollMs: 10,
    });
  });
  await done;
  assert.equal(ticks, outcomes.length + 1, 'watcher gave up on non-consecutive failures');
  assert.ok(closed >= 8, 'each failed tick drops its socket');
}

async function main(): Promise<void> {
  leaseExpiryEndsControl();
  await intermittentFailuresDoNotAccumulate();
  const port = await freePort();
  const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
  try {
    // Browser-level websocket, like the Kernel/Steel endpoints production stores.
    const version = (await (await fetch(`http://127.0.0.1:${port}/json/version`)).json()) as {
      webSocketDebuggerUrl: string;
    };
    const wsUrl = version.webSocketDebuggerUrl;
    const page = await browser.newPage();
    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: PWD_PAGE })
    );
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');

    let controlling = true;
    let onClosed: () => void = () => undefined;
    const stopped = new Promise<void>((resolve) => {
      onClosed = resolve;
    });
    const lookups: string[] = [];
    startTakeControlAutofill('task-1', 'user-1', wsUrl, {
      isUserControlling: async () => controlling,
      attach: async (url) => {
        const cdp = await attachCdp(url);
        const close = cdp.close.bind(cdp);
        cdp.close = () => {
          onClosed();
          close();
        };
        return cdp;
      },
      lookup: async (_user, email) => {
        lookups.push(email);
        return ['pw-newest', 'pw-older'];
      },
      pollMs: 50,
    });
    // A second start for the same task must not create a second watcher.
    startTakeControlAutofill('task-1', 'user-1', wsUrl);

    await page.waitForFunction("window.__submitted === 'pw-newest'", undefined, {
      timeout: 10_000,
    });
    assert.deepEqual(lookups, ['andy@example.com']);

    // Google rejected the first one: the re-rendered empty field gets the next.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    await page.waitForFunction("window.__submitted === 'pw-older'", undefined, { timeout: 10_000 });
    assert.deepEqual(lookups, ['andy@example.com']);

    // Handing control back stops the watcher and releases its CDP socket.
    controlling = false;
    await stopped;
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  throw error;
});
