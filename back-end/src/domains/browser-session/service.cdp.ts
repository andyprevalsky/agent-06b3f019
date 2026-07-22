/**
 * CDP injection helpers — extracted to keep service.ts under max-lines.
 */

import { createLogger } from '../../providers/logger';
import { steelCdpConnectionUrl } from '../../providers/steel/urls';
import type { Browser } from 'playwright';
import { CdpInjectionError } from './types';

const log = createLogger('BrowserSessionCdp');

export async function injectLocalStorageViaCdp(
  wsUrl: string,
  entries: { key: string; value: string }[],
  origin: string
): Promise<void> {
  let browser: Browser | null = null;
  try {
    const { chromium } = await import('playwright');
    browser = await chromium.connectOverCDP(steelCdpConnectionUrl(wsUrl));
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

    const failedKeys = await page.evaluate((items: { key: string; value: string }[]) => {
      const failures: string[] = [];
      for (const { key, value } of items) {
        try {
          localStorage.setItem(key, value);
        } catch {
          failures.push(key);
        }
      }
      return failures;
    }, entries);

    if (failedKeys.length > 0) {
      log.warn('Failed to set localStorage keys', { origin, failedKeys });
    }

    log.info('Injected localStorage entries', { origin, count: entries.length });
  } catch (cdpError) {
    if (cdpError instanceof CdpInjectionError) throw cdpError;
    log.error('Failed to inject via CDP', {
      error: cdpError instanceof Error ? cdpError.message : String(cdpError),
    });
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
