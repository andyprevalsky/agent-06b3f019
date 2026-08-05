/**
 * Fingerprint timezone format contract: format()/toLocaleString must follow
 * the user's location TZ, not the Kernel host TZ (America/New_York).
 *
 * Regression for agent 15508426-8fbc-4ae7-a4e1-0ee77b63cf47 — Fever labeled a
 * 7:30 PM PT session as 10:30 PM and payment approval copied that string.
 */
import { buildFingerprintScript } from '../../providers/steel/injectionScripts';
import type { FingerprintData } from '../../providers/steel/types';

function assert(condition: unknown, message: string): void {
  if (!condition) throw new Error(message);
}

export async function testFingerprintTimezoneFormatUsesUserLocation(
  makeFingerprint: () => FingerprintData
): Promise<void> {
  const { chromium } = await import('playwright');
  const fp: FingerprintData = {
    ...makeFingerprint(),
    timezone: 'America/Los_Angeles',
    timezoneOffset: 420,
  };
  const script = buildFingerprintScript(fp);
  const browser = await chromium.launch({ headless: true });
  try {
    const context = await browser.newContext();
    const page = await context.newPage();
    const cdp = await context.newCDPSession(page);
    // Host/default TZ is Eastern — the Kernel VM failure mode.
    await cdp.send('Emulation.setTimezoneOverride', { timezoneId: 'America/New_York' });
    await context.addInitScript(script);
    await page.goto('about:blank');
    const result = await page.evaluate(() => {
      const instant = new Date('2026-08-06T19:30:00-07:00');
      return {
        resolved: Intl.DateTimeFormat().resolvedOptions().timeZone,
        offsetMinutes: new Date().getTimezoneOffset(),
        formatted: new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
        }).format(instant),
        withZoneName: new Intl.DateTimeFormat('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'short',
        }).format(instant),
        toLocaleString: instant.toLocaleString('en-US', {
          hour: 'numeric',
          minute: '2-digit',
          hour12: true,
          timeZoneName: 'short',
        }),
      };
    });

    assert(
      result.resolved === 'America/Los_Angeles',
      `resolvedOptions.timeZone should be user location, got ${result.resolved}`
    );
    assert(
      result.offsetMinutes === 420,
      `getTimezoneOffset should match user fingerprint, got ${result.offsetMinutes}`
    );
    // Without a working format spoof this is "10:30 PM" (EDT). User location is PT → 7:30.
    assert(
      /\b7:30\b/.test(result.formatted),
      `Intl format must use user location TZ (expected 7:30 PM PT, not host 10:30 PM ET); got ${JSON.stringify(result.formatted)}`
    );
    assert(
      /\b7:30\b/.test(result.withZoneName) &&
        /\bPDT\b|\bGMT-7\b|\bUTC-7\b/.test(result.withZoneName),
      `format with timeZoneName must show PT, got ${JSON.stringify(result.withZoneName)}`
    );
    assert(
      /\b7:30\b/.test(result.toLocaleString),
      `toLocaleString must use user location TZ, got ${JSON.stringify(result.toLocaleString)}`
    );
  } finally {
    await browser.close();
  }
}
