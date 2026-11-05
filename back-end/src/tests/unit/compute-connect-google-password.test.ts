#!/usr/bin/env tsx
/**
 * Connect-session Google password autofill.
 *
 * Runs the real in-page scripts in Chromium against a routed
 * accounts.google.com password challenge (no network), through the same
 * `autofillGooglePassword` the sign-in watcher calls each tick.
 */
import assert from 'node:assert/strict';
import { chromium, type Page } from '@playwright/test';
import type { CdpClient } from '../../domains/compute-grants/cdp';
import { autofillGooglePassword } from '../../domains/compute-grants/connectSession.googlePassword';
import { googlePasswordCandidates } from '../../providers/phoneSavedPassword';
import type { PendingConnect } from '../../domains/compute-grants/connectSession.types';

const PWD_PAGE = `<!doctype html><html><body>
<div data-profile-identifier>Andy@Example.com</div>
<form id="f" onsubmit="event.preventDefault()">
  <input type="password" name="Passwd" />
  <div id="passwordNext"><button type="button" onclick="window.__submitted = document.querySelector('[name=Passwd]').value">Next</button></div>
</form></body></html>`;

function entryFor(page: Page): PendingConnect {
  const cdp = {
    evaluateAnyTarget: async <T>(expression: string) =>
      ((await page.evaluate(expression)) as T | null) ?? undefined,
  } as unknown as CdpClient;
  return {
    connectId: 'codex-google-pwd',
    userId: 'user-1',
    provider: 'codex',
    steelSessionId: null,
    cdpBase: 'ws://browser',
    liveViewUrl: null,
    release: null,
    cdp,
    deadline: Date.now() + 60_000,
    stage: 'awaiting_human',
    done: false,
  };
}

/** The DB query orders newest-used first BEFORE its 32-row limit. */
async function queryOrdersBeforeLimit(): Promise<void> {
  let args: { orderBy?: unknown; take?: number } | undefined;
  const tx = {
    browserPassword: {
      findMany: async (a: typeof args) => {
        args = a;
        return [];
      },
    },
  } as unknown as Parameters<typeof googlePasswordCandidates>[0];
  await googlePasswordCandidates(tx, 'user-1', 'andy@example.com');
  assert.equal(args?.take, 32);
  assert.deepEqual(args?.orderBy, [
    { dateLastUsed: { sort: 'desc', nulls: 'last' } },
    { dateCreated: { sort: 'desc', nulls: 'last' } },
  ]);
}

async function main(): Promise<void> {
  await queryOrdersBeforeLimit();
  const browser = await chromium.launch();
  try {
    const page = await browser.newPage();
    await page.route('https://accounts.google.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: PWD_PAGE })
    );
    await page.route('https://chatgpt.com/**', (route) =>
      route.fulfill({ contentType: 'text/html', body: PWD_PAGE })
    );

    // Every saved password for the shown account, newest-used first. The lookup
    // runs once per account; later ticks advance through the cached list.
    const lookups: string[] = [];
    const lookup = async (_userId: string, email: string) => {
      lookups.push(email);
      return email === 'andy@example.com' ? ['newest"pw', 'older-pw'] : [];
    };

    // Not Google: never fills, never looks a password up.
    await page.goto('https://chatgpt.com/auth/login');
    assert.equal(await autofillGooglePassword(entryFor(page), lookup), false);
    assert.deepEqual(lookups, []);

    // Google password challenge: submits the newest-used password first.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    const entry = entryFor(page);
    assert.equal(await autofillGooglePassword(entry, lookup), true);
    assert.deepEqual(lookups, ['andy@example.com']);
    assert.equal(await page.evaluate('window.__submitted'), 'newest"pw');

    // Google rejected it (empty field again): try the NEXT saved password, with
    // no second DB lookup for the same account.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    assert.equal(await autofillGooglePassword(entry, lookup), true);
    assert.deepEqual(lookups, ['andy@example.com']);
    assert.equal(await page.evaluate('window.__submitted'), 'older-pw');

    // Both exhausted: stop, leave the field to the human.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    assert.equal(await autofillGooglePassword(entry, lookup), false);
    assert.equal(await page.evaluate("document.querySelector('[name=Passwd]').value"), '');

    // A failed lookup (null) is not "nothing stored": the next tick retries.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    let flaky = 0;
    const flakyLookup = async () => (++flaky === 1 ? null : ['after-retry']);
    const retryEntry = entryFor(page);
    assert.equal(await autofillGooglePassword(retryEntry, flakyLookup), false);
    assert.equal(await page.evaluate("document.querySelector('[name=Passwd]').value"), '');
    assert.equal(await autofillGooglePassword(retryEntry, flakyLookup), true);
    assert.equal(await page.evaluate('window.__submitted'), 'after-retry');

    // A fill that no-ops (challenge changed mid-tick) keeps its candidate.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    const noopEntry = entryFor(page);
    const realCdp = noopEntry.cdp!;
    let noop = true;
    noopEntry.cdp = {
      evaluateAnyTarget: async <T>(expression: string) =>
        noop && expression.includes('only-one')
          ? ('' as unknown as T)
          : realCdp.evaluateAnyTarget<T>(expression),
    } as unknown as typeof realCdp;
    const single = async () => ['only-one'];
    assert.equal(await autofillGooglePassword(noopEntry, single), false);
    noop = false;
    assert.equal(await autofillGooglePassword(noopEntry, single), true);
    assert.equal(await page.evaluate('window.__submitted'), 'only-one');

    // A different account with no saved password is also left alone.
    await page.goto('https://accounts.google.com/v3/signin/challenge/pwd');
    await page.evaluate(
      "document.querySelector('[data-profile-identifier]').textContent = 'other@example.com'"
    );
    assert.equal(await autofillGooglePassword(entryFor(page), lookup), false);
    assert.equal(await page.evaluate("document.querySelector('[name=Passwd]').value"), '');
  } finally {
    await browser.close();
  }
}

main().catch((error: unknown) => {
  process.exitCode = 1;
  throw error;
});
