#!/usr/bin/env tsx

import assert from 'node:assert';
import type { Browser, BrowserContext, Page } from 'playwright';
import { resetKernelSessionTabs } from '../../providers/browser/kernel';

function mockBrowser(pageCounts: number[]): {
  browser: Browser;
  closedWith: Array<{ runBeforeUnload?: boolean }>;
  createdPages: number;
} {
  const closedWith: Array<{ runBeforeUnload?: boolean }> = [];
  let createdPages = 0;
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
    return {
      pages: () => pages,
      newPage: async () => {
        createdPages += 1;
        return {} as Page;
      },
    } as BrowserContext;
  });
  return {
    browser: { contexts: () => contexts } as Browser,
    closedWith,
    get createdPages() {
      return createdPages;
    },
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
  assert.strictEqual(restored.createdPages, 1);

  const empty = mockBrowser([0]);
  assert.strictEqual(await resetKernelSessionTabs(empty.browser), 0);
  assert.deepStrictEqual(empty.closedWith, []);
  assert.strictEqual(empty.createdPages, 1);

  process.stdout.write(
    'PASS Kernel sessions replace restored tabs while retaining the browser context\n'
  );
}

void main();
