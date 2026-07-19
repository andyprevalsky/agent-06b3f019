#!/usr/bin/env tsx

import assert from 'node:assert';
import type { Browser, BrowserContext, Page } from 'playwright';
import { resetKernelSessionTabs } from '../../providers/browser/kernel';

function mockBrowser(pageCounts: number[]): {
  browser: Browser;
  closedWith: Array<{ runBeforeUnload?: boolean }>;
} {
  const closedWith: Array<{ runBeforeUnload?: boolean }> = [];
  const contexts = pageCounts.map((pageCount) => {
    const pages = Array.from(
      { length: pageCount },
      () =>
        ({
          close: async (options?: { runBeforeUnload?: boolean }) => {
            closedWith.push(options ?? {});
          },
        }) as Page
    );
    return { pages: () => pages } as BrowserContext;
  });
  return {
    browser: { contexts: () => contexts } as Browser,
    closedWith,
  };
}

async function main(): Promise<void> {
  const restored = mockBrowser([2, 1]);
  const closedTabCount = await resetKernelSessionTabs(restored.browser);

  assert.strictEqual(closedTabCount, 3);
  assert.deepStrictEqual(restored.closedWith, [
    { runBeforeUnload: false },
    { runBeforeUnload: false },
    { runBeforeUnload: false },
  ]);

  const empty = mockBrowser([0]);
  assert.strictEqual(await resetKernelSessionTabs(empty.browser), 0);
  assert.deepStrictEqual(empty.closedWith, []);

  process.stdout.write(
    'PASS Kernel sessions discard restored tabs without replacing the browser context\n'
  );
}

void main();
