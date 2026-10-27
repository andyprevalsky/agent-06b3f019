#!/usr/bin/env tsx
/**
 * Claude browser OAuth callback contract.
 *
 * An authorization page can contain long-lived hidden values that are not OAuth
 * authorization codes. The remote-browser watcher must ignore every DOM value
 * until Anthropic's exact manual callback page is loaded, otherwise it sends a
 * decoy value to the token endpoint and Claude rejects it as `invalid_grant`.
 */

import type { CdpClient } from '../../domains/compute-grants/cdp';
import { pollConnectSession } from '../../domains/compute-grants/connectSession';
import { releaseBrowser } from '../../domains/compute-grants/connectSession.lifecycle';
import { pending } from '../../domains/compute-grants/connectSession.state';
import type {
  ConnectProviderConfig,
  PendingConnect,
} from '../../domains/compute-grants/connectSession.types';
import { startSignInWatcher } from '../../domains/compute-grants/connectSession.watcher';
import { READ_CODE } from '../../providers/browser/claudeGrantMint';

type TestFn = () => void | Promise<void>;
const tests: Array<{ name: string; fn: TestFn }> = [];
const test = (name: string, fn: TestFn) => tests.push({ name, fn });

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

function evaluateCodeReader(options: {
  href: string;
  elementValue?: string;
  bodyText?: string;
}): string | null {
  const location = new URL(options.href);
  const element =
    options.elementValue === undefined
      ? null
      : { value: options.elementValue, textContent: options.elementValue };
  const document = {
    querySelector: (_selector: string) => element,
    body: { innerText: options.bodyText ?? '' },
  };
  return Function('location', 'document', `return ${READ_CODE}`)(location, document) as
    string | null;
}

const config: ConnectProviderConfig = {
  loginUrl: 'https://claude.ai/login',
  cookieUrls: ['https://claude.ai'],
  sessionCookie: 'sessionKey',
  profileUrl: 'https://claude.ai/settings/profile',
  authRealm: 'claude.ai',
};

let connectSequence = 0;
async function runWatcherTick(options: {
  href: string;
  elementValue?: string;
  expectedState: string;
}): Promise<{
  fetchCalls: number;
  poll: Awaited<ReturnType<typeof pollConnectSession>>;
  browserClosed: number;
  browserReleased: number;
}> {
  const originalFetch = globalThis.fetch;
  const originalSetInterval = globalThis.setInterval;
  const originalClearInterval = globalThis.clearInterval;
  let intervalHandler: (() => void) | undefined;
  let fetchCalls = 0;
  let browserClosed = 0;
  let browserReleased = 0;
  const timer = 92 as unknown as NodeJS.Timeout;
  Object.assign(globalThis, {
    fetch: async () => {
      fetchCalls += 1;
      return new Response('exchange should not succeed in this contract test', { status: 400 });
    },
    setInterval: ((handler: () => void) => {
      intervalHandler = handler;
      return timer;
    }) as typeof setInterval,
    clearInterval: ((_candidate: NodeJS.Timeout) => undefined) as typeof clearInterval,
  });

  const cdp = {
    evaluateAnyTarget: async <T>(expression: string) => {
      const value = Function(
        'location',
        'document',
        `return ${expression}`
      )(new URL(options.href), {
        querySelector: () =>
          options.elementValue === undefined
            ? null
            : { value: options.elementValue, textContent: options.elementValue },
        body: { innerText: '' },
      }) as T | null | undefined;
      return value ?? undefined;
    },
    close: () => {
      browserClosed += 1;
    },
  } as unknown as CdpClient;
  const connectId = `claude-oauth-contract-${(connectSequence += 1)}`;
  const entry: PendingConnect = {
    connectId,
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
    authState: options.expectedState,
  };
  pending.set(connectId, entry);

  try {
    startSignInWatcher(entry, config, 2_000);
    assert(intervalHandler !== undefined, 'watcher interval was not installed');
    intervalHandler();
    await new Promise<void>((resolve) => setImmediate(resolve));
    await new Promise<void>((resolve) => setImmediate(resolve));
    const poll = await pollConnectSession(entry.userId, connectId);
    return { fetchCalls, poll, browserClosed, browserReleased };
  } finally {
    pending.delete(connectId);
    await releaseBrowser(entry);
    Object.assign(globalThis, {
      fetch: originalFetch,
      setInterval: originalSetInterval,
      clearInterval: originalClearInterval,
    });
  }
}

test('the Claude authorize page never treats a hidden value as an authorization code', () => {
  const result = evaluateCodeReader({
    href: 'https://claude.ai/oauth/authorize?code=true&state=expected-state',
    elementValue: 'authorize-page-csrf-value-123456789',
  });
  assert(result === null, `authorize-page value was captured as a code: ${String(result)}`);
});

test('a lookalike callback on another origin is rejected', () => {
  const result = evaluateCodeReader({
    href: 'https://attacker.example/oauth/code/callback?code=attacker-code',
    elementValue: 'attacker-code-12345678901234567890#attacker-state',
  });
  assert(result === null, `untrusted callback origin was accepted: ${String(result)}`);
});

test('a non-callback path on the Anthropic origin is rejected', () => {
  const result = evaluateCodeReader({
    href: 'https://platform.claude.com/oauth/authorize?code=wrong&state=wrong',
    elementValue: 'authorization-code-12345678901234567890#wrong-state',
  });
  assert(result === null, `non-callback Anthropic path was accepted: ${String(result)}`);
});

test('the exact Anthropic manual callback URL preserves query code and state', () => {
  const result = evaluateCodeReader({
    href: 'https://platform.claude.com/oauth/code/callback?code=one-time-code&state=expected-state',
  });
  assert(
    result === 'one-time-code#expected-state',
    `callback query code and state were not captured: ${String(result)}`
  );
});

test('the exact Anthropic manual callback page yields a rendered code with embedded state', () => {
  const expected = 'authorization-code-12345678901234567890#embedded-state';
  const result = evaluateCodeReader({
    href: 'https://platform.claude.com/oauth/code/callback',
    elementValue: expected,
  });
  assert(result === expected, `rendered callback code was not captured: ${String(result)}`);
});

test('the watcher leaves an authorize-page decoy pending without exchanging it', async () => {
  const result = await runWatcherTick({
    href: 'https://claude.ai/oauth/authorize?code=true&state=expected-state',
    elementValue: 'authorize-page-csrf-value-123456789',
    expectedState: 'expected-state',
  });
  assert(result.fetchCalls === 0, 'authorize-page decoy reached the token endpoint');
  assert(result.poll.state === 'pending', `connect poll became ${result.poll.state}`);
});

test('the watcher rejects a stale callback state before token exchange', async () => {
  const result = await runWatcherTick({
    href: 'https://platform.claude.com/oauth/code/callback?code=one-time-code&state=stale-state',
    expectedState: 'expected-state',
  });
  assert(result.fetchCalls === 0, 'state-mismatched code reached the token endpoint');
  assert(result.poll.state === 'unknown', `connect poll became ${result.poll.state}`);
  assert(
    /state mismatch/i.test(result.poll.reason ?? ''),
    'poll omitted the state mismatch reason'
  );
  assert(result.browserClosed === 1, 'state mismatch left CDP open');
  assert(result.browserReleased === 1, 'state mismatch left the browser billing');
});

async function main(): Promise<void> {
  let passed = 0;
  const failures: string[] = [];
  console.log('\nClaude browser OAuth\n');
  for (const item of tests) {
    try {
      await item.fn();
      passed += 1;
      console.log(`  PASS  ${item.name}`);
    } catch (error) {
      failures.push(item.name);
      console.log(
        `  FAIL  ${item.name}\n        ${error instanceof Error ? error.message : String(error)}`
      );
    }
  }
  console.log(`\nRESULTS: ${passed}/${tests.length} passed`);
  if (failures.length > 0) process.exit(1);
}

if (process.argv[1]?.includes('compute-claude-oauth')) void main();
