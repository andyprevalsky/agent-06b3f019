/**
 * Apply the agent's fingerprint to a Playwright page over CDP.
 *
 * Mirrors agents/helpers/fingerprint_injection.py. Must run BEFORE navigation
 * so probe classification sees the same identity the agent will re-attach on
 * CDP reconnect (Network.setUserAgentOverride is session-scoped).
 */
import type { Page } from 'playwright';

import { createLogger } from '../logger';

const log = createLogger('FingerprintInjection');

export interface FingerprintInjectionData {
  userAgentOverride?: {
    userAgent?: string;
    acceptLanguage?: string;
    platform?: string;
    userAgentMetadata?: Record<string, unknown>;
  };
  initScript?: string;
  timezone?: string | null;
}

export async function applyFingerprintInjection(
  page: Page,
  fingerprint: FingerprintInjectionData | null | undefined
): Promise<boolean> {
  if (!fingerprint) return false;
  const userAgentOverride = fingerprint.userAgentOverride;
  if (!userAgentOverride || typeof userAgentOverride.userAgent !== 'string') {
    log.warn('Fingerprint injection missing userAgentOverride');
    return false;
  }
  try {
    const cdp = await page.context().newCDPSession(page);
    await cdp.send('Network.enable');
    await cdp.send('Network.setUserAgentOverride', userAgentOverride as never);
    const timezone = typeof fingerprint.timezone === 'string' ? fingerprint.timezone.trim() : '';
    if (timezone) {
      await cdp.send('Emulation.setTimezoneOverride', { timezoneId: timezone });
    }
    if (typeof fingerprint.initScript === 'string' && fingerprint.initScript.trim()) {
      await page.context().addInitScript(fingerprint.initScript);
    }
    await page.context().addInitScript(`
      (function () {
        const style = document.createElement('style');
        style.id = 'rose-scrollbar-hide';
        style.textContent = '*::-webkit-scrollbar{display:none!important;width:0!important;height:0!important;}*{ -ms-overflow-style:none!important;scrollbar-width:none!important;}';
        if (document.head) document.head.appendChild(style);
        else document.addEventListener('DOMContentLoaded', () => document.head.appendChild(style));
      })();
    `);
    log.info('Fingerprint injection applied before probe navigation', {
      platform:
        (userAgentOverride as { userAgentMetadata?: { platform?: string } }).userAgentMetadata
          ?.platform ??
        userAgentOverride.platform ??
        null,
      timezone: timezone || null,
    });
    return true;
  } catch (error) {
    log.error('Fingerprint injection failed', {
      error: error instanceof Error ? error.message : String(error),
    });
    return false;
  }
}
