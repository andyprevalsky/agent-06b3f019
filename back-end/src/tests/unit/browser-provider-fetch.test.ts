#!/usr/bin/env tsx
/* eslint-disable no-console */

import assert from 'node:assert';
import { captureScreenshot, readSessionFile } from '../../providers/browser';
import { prisma } from '../../providers/database';

const PROVIDER_TIMEOUT_MS = 15_000;

async function main(): Promise<void> {
  const originalFindUnique = prisma.browserSession.findUnique;
  const originalFetch = globalThis.fetch;
  const originalSetTimeout = globalThis.setTimeout;
  const originalApiKey = process.env.STEEL_API_KEY;

  prisma.browserSession.findUnique = (async () => ({
    provider: 'steel',
  })) as typeof originalFindUnique;
  process.env.STEEL_API_KEY = 'steel-test-key';
  globalThis.setTimeout = ((callback: TimerHandler, delay?: number, ...args: unknown[]) =>
    originalSetTimeout(
      callback,
      delay === PROVIDER_TIMEOUT_MS ? 20 : delay,
      ...args
    )) as typeof setTimeout;
  globalThis.fetch = (async (_input: string | URL | Request, init?: RequestInit) => {
    const signal = init?.signal;
    assert(signal, 'provider fetch must receive an abort signal');
    const stalledBody = <T>(): Promise<T> =>
      new Promise<T>((_resolve, reject) => {
        const rejectAbort = (): void => reject(new DOMException('Aborted', 'AbortError'));
        // Match fetch body readers: an AbortSignal remains observable even if
        // host contention lets the timer fire before this synthetic consumer
        // installs its listener.
        if (signal.aborted) rejectAbort();
        else signal.addEventListener('abort', rejectAbort, { once: true });
      });
    return {
      ok: true,
      status: 200,
      arrayBuffer: () => stalledBody<ArrayBuffer>(),
      json: () => stalledBody<unknown>(),
    } as Response;
  }) as typeof fetch;

  try {
    const operations: Array<() => Promise<unknown>> = [
      () => readSessionFile('steel-session', '/files/stalled.txt'),
      () => captureScreenshot('steel-session'),
    ];
    for (const operation of operations) {
      await assert.rejects(
        Promise.race([
          operation(),
          new Promise<never>((_resolve, reject) =>
            originalSetTimeout(() => reject(new Error('body read remained pending')), 100)
          ),
        ]),
        (error: unknown) => error instanceof DOMException && error.name === 'AbortError'
      );
    }
    console.log('PASS provider timeout remains active through binary and JSON body consumption');
  } finally {
    prisma.browserSession.findUnique = originalFindUnique;
    globalThis.fetch = originalFetch;
    globalThis.setTimeout = originalSetTimeout;
    if (originalApiKey === undefined) delete process.env.STEEL_API_KEY;
    else process.env.STEEL_API_KEY = originalApiKey;
  }
}

void main();
