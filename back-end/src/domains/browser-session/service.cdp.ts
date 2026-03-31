/**
 * CDP injection helpers — extracted to keep service.ts under max-lines.
 */

import { createLogger } from '../../providers/logger';
import { CdpInjectionError } from './types';

const log = createLogger('BrowserSessionCdp');

export async function injectLocalStorageViaCdp(
  wsUrl: string,
  entries: { key: string; value: string }[],
  origin: string,
): Promise<void> {
  // eslint-disable-next-line @typescript-eslint/consistent-type-imports -- dynamic import type
  let browser: Awaited<ReturnType<typeof import('playwright')['chromium']['connectOverCDP']>> | null = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP(wsUrl);
    const contexts = browser.contexts();
    if (contexts.length === 0) {
      throw new CdpInjectionError('No browser contexts available');
    }
    const context = contexts[0];
    const pages = context.pages();
    if (pages.length === 0) {
      throw new CdpInjectionError('No pages available in browser context');
    }
    const page = pages[0];

    await page.evaluate((items: { key: string; value: string }[]) => {
      for (const { key, value } of items) {
        try {
          localStorage.setItem(key, value);
        } catch (e) {
          // eslint-disable-next-line no-console -- runs in browser context via CDP
          console.warn(`Failed to set localStorage key ${key}:`, e);
        }
      }
    }, entries);

    log.info('Injected localStorage entries', { origin, count: entries.length });
  } catch (cdpError) {
    if (cdpError instanceof CdpInjectionError) throw cdpError;
    log.error('Failed to inject via CDP', { error: cdpError instanceof Error ? cdpError.message : String(cdpError) });
    throw new CdpInjectionError(cdpError instanceof Error ? cdpError.message : 'Unknown error');
  } finally {
    if (browser) {
      try {
        await browser.close();
      } catch {
        // Best-effort cleanup — ignore close errors
      }
    }
  }
}
