#!/usr/bin/env tsx
import assert from 'node:assert/strict';
import type { CdpClient } from '../../domains/compute-grants/cdp';
import { startSignInWatcher } from '../../domains/compute-grants/connectSession.watcher';
import type {
  ConnectProviderConfig,
  PendingConnect,
} from '../../domains/compute-grants/connectSession.types';

async function main(): Promise<void> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalHandler: (() => void) | undefined;
  let intervalCleared = false;
  let browserClosed = 0;
  let browserReleased = 0;

  const timer = 91 as unknown as NodeJS.Timeout;
  Object.assign(globalThis, {
    fetch: async () => new Response('invalid authorization code', { status: 400 }),
    setInterval: ((handler: () => void) => {
      intervalHandler = handler;
      return timer;
    }) as typeof setInterval,
    clearInterval: ((candidate: NodeJS.Timeout) => {
      if (candidate === timer) intervalCleared = true;
    }) as typeof clearInterval,
  });

  const cdp = {
    evaluateAnyTarget: async () => 'not-a-real-authorization-code#state',
    syncPasskeyCeremonies: async () => undefined,
    close: () => {
      browserClosed += 1;
    },
  } as unknown as CdpClient;
  const entry: PendingConnect = {
    connectId: 'claude-connect-failure',
    userId: 'user-1',
    provider: 'claude',
    steelSessionId: null,
    cdpBase: 'ws://browser',
    liveViewUrl: 'https://live.example',
    release: async () => {
      browserReleased += 1;
    },
    cdp,
    deadline: Date.now() + 60_000,
    stage: 'awaiting_human',
    done: false,
    accountEmail: 'claude@example.com',
    authVerifier: 'verifier',
    authState: 'state',
  };
  const config: ConnectProviderConfig = {
    loginUrl: 'https://claude.ai/login',
    cookieUrls: ['https://claude.ai'],
    sessionCookie: 'sessionKey',
    profileUrl: 'https://claude.ai/settings/profile',
    authRealm: 'claude.ai',
  };

  try {
    startSignInWatcher(entry, config, 2_000);
    assert(intervalHandler !== undefined, 'watcher interval was not installed');
    intervalHandler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));

    assert.match(entry.failed ?? '', /exchange failed 400: invalid authorization code/);
    assert.equal(intervalCleared, true, 'a terminal exchange failure kept polling');
    assert.equal(browserClosed, 1, 'a terminal exchange failure left CDP open');
    assert.equal(browserReleased, 1, 'a terminal exchange failure left the browser billing');
  } finally {
    Object.assign(globalThis, {
      fetch: originalFetch,
      setInterval: originalSetInterval,
      clearInterval: originalClearInterval,
    });
  }
}

void main();
