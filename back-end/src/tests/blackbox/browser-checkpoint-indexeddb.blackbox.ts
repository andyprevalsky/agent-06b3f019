#!/usr/bin/env tsx
/**
 * Blackbox: a frame's IndexedDB holding a non-transferable host object
 * (CryptoKey) must not abort the browser pause checkpoint.
 *
 * RCA cement (descend H-40, 2026-11-06). anti-bot-blue-bottle-order-online
 * reached checkout and called request_payment_card; the pause-for-approval then
 * failed with `POST /api/browser-session/close -> 500 "frame.evaluate: Error:
 * Unsupported checkpoint IndexedDB value type: CryptoKey"`. The browser task
 * ended in error, so no payment approval was ever requested.
 *
 * Real Chromium, real cross-origin frame partition, exact production
 * capture/restore functions. The checkpoint must keep every transferable record,
 * record each omitted record truthfully, and preserve key generators.
 */
import assert from 'node:assert/strict';
import { chromium, type Browser, type BrowserContext, type Frame } from 'playwright';
import {
  captureFrameIndexedDB,
  restoreFrameIndexedDB,
} from '../../providers/browser/checkpointIndexedDB';

const TOP_URL = 'https://merchant.checkpoint-idb.invalid/checkout';
const FRAME_URL = 'https://payments.checkpoint-idb.invalid/frame';

async function frameIn(context: BrowserContext): Promise<Frame> {
  await context.route('https://**.checkpoint-idb.invalid/**', (route) =>
    route.fulfill({ contentType: 'text/html', body: '<!doctype html><body></body>' })
  );
  const page = await context.newPage();
  await page.goto(TOP_URL);
  await page.evaluate(async (url) => {
    await new Promise<void>((resolve) => {
      const iframe = document.createElement('iframe');
      iframe.onload = () => resolve();
      iframe.src = url;
      document.body.append(iframe);
    });
  }, FRAME_URL);
  const frame = page.frames().find((candidate) => candidate.url() === FRAME_URL);
  assert(frame, 'cross-origin payment frame exists');
  return frame;
}

async function populate(frame: Frame): Promise<void> {
  await frame.evaluate(async () => {
    const key = await crypto.subtle.generateKey({ name: 'HMAC', hash: 'SHA-256' }, false, ['sign']);
    await new Promise<void>((resolve, reject) => {
      const request = indexedDB.open('device-binding', 3);
      request.onupgradeneeded = () => {
        request.result.createObjectStore('keys');
        request.result.createObjectStore('events', { autoIncrement: true });
      };
      request.onerror = () => reject(request.error);
      request.onsuccess = () => {
        const db = request.result,
          tx = db.transaction(['keys', 'events'], 'readwrite');
        const keys = tx.objectStore('keys');
        keys.put({ name: 'kept', bytes: new Uint8Array([7, 8, 9]) }, 'plain');
        keys.put({ key, created: new Date('2026-11-06T19:34:50Z') }, 'signing');
        keys.put(key, 'raw');
        const events = tx.objectStore('events');
        events.put('first');
        events.put({ nested: [key] });
        tx.oncomplete = () => {
          db.close();
          resolve();
        };
        tx.onerror = () => {
          db.close();
          reject(tx.error);
        };
      };
    });
  });
}

// A string body: tsx would otherwise inject its `__name` helper into the page.
const READ_DEVICE_BINDING = `(async () => {
  const done = (request) => new Promise((resolve, reject) => {
    request.onsuccess = () => resolve(request.result);
    request.onerror = () => reject(request.error);
  });
  const db = await done(indexedDB.open('device-binding'));
  try {
    const tx = db.transaction(['keys', 'events'], 'readwrite');
    const keys = tx.objectStore('keys'), events = tx.objectStore('events');
    const plain = await done(keys.get('plain'));
    return {
      version: db.version,
      keyNames: (await done(keys.getAllKeys())).map(String).sort(),
      plain: { name: plain?.name, bytes: plain ? Array.from(plain.bytes) : null },
      eventKeys: (await done(events.getAllKeys())).map(Number),
      nextEventKey: Number(await done(events.add('after-restore'))),
    };
  } finally {
    db.close();
  }
})()`;

async function verifyCryptoKeyRecordsAreOmittedNotFatal(browser: Browser): Promise<void> {
  const source = await browser.newContext();
  const target = await browser.newContext();
  try {
    const sourceFrame = await frameIn(source);
    await populate(sourceFrame);
    // Pre-fix this rejected: "Unsupported checkpoint IndexedDB value type: CryptoKey".
    const saved = await captureFrameIndexedDB(sourceFrame);
    assert(saved, 'frame IndexedDB checkpoint was captured');
    const envelope = JSON.parse(saved) as {
      omitted?: Array<{ database: string; store: string; type: string; count: number }>;
    };
    assert.deepEqual(
      envelope.omitted,
      [
        { database: 'device-binding', store: 'events', type: 'CryptoKey', count: 1 },
        { database: 'device-binding', store: 'keys', type: 'CryptoKey', count: 2 },
      ],
      'every non-transferable record is recorded as omitted'
    );
    assert(!saved.includes('"raw"') && !saved.includes('signing'), 'omitted records are absent');

    const targetFrame = await frameIn(target);
    await restoreFrameIndexedDB(targetFrame, saved);
    assert.deepEqual(
      await targetFrame.evaluate(READ_DEVICE_BINDING),
      {
        version: 3,
        keyNames: ['plain'],
        plain: { name: 'kept', bytes: [7, 8, 9] },
        eventKeys: [1],
        nextEventKey: 3,
      },
      'transferable records, schema and key generators survive; CryptoKey records do not'
    );
  } finally {
    await source.close();
    await target.close();
  }
}

async function main(): Promise<void> {
  const browser = await chromium.launch({ headless: true });
  try {
    await verifyCryptoKeyRecordsAreOmittedNotFatal(browser);
    console.log('✓ browser-checkpoint-indexeddb: CryptoKey records omitted, checkpoint captured');
  } finally {
    await browser.close();
  }
}

main().catch((error) => {
  console.error('✗ browser-checkpoint-indexeddb:', error);
  process.exit(1);
});
