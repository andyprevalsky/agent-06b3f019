import type { Browser } from 'playwright';
export class KernelSessionValidationError extends Error {}

/**
 * Kernel profiles persist Chromium's open pages along with cookies and storage.
 * Replace restored pages with one clean bootstrap tab. Kernel destroys the
 * Playwright context when its final page closes, so creating the clean tab
 * first is required for the caller to reuse this validated connection for
 * credential injection.
 */
export async function resetKernelSessionTabs(browser: Browser): Promise<number> {
  const primaryContext = browser.contexts()[0];
  if (primaryContext === undefined) {
    throw new KernelSessionValidationError('Kernel browser has no context after CDP validation');
  }
  const pages = browser.contexts().flatMap((context) => context.pages());
  await primaryContext.newPage();
  await Promise.all(pages.map((page) => page.close({ runBeforeUnload: false })));
  return pages.length;
}
