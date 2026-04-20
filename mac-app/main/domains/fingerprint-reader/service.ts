/**
 * Service layer for fingerprint-reader.
 *
 * Orchestrates the full fingerprint-collection flow:
 *   1. Discover Chrome executable (repo)
 *   2. Create a disposable temp user-data-dir (repo)
 *   3. Launch puppeteer-core in headful mode so screen metrics are real
 *   4. Navigate to a real page so all browser APIs unlock
 *   5. Evaluate the fingerprint-collection script inside the page context
 *   6. Always close the browser and remove the temp dir (finally block)
 *
 * Return contract is strict: the evaluated payload is returned verbatim; any
 * error (Chrome missing, launch failure, navigation failure, evaluate throw)
 * resolves to null so the upstream sync can keep going without fingerprint.
 *
 * Note: the browser-side fingerprint script lives in `./page-script` as a
 * string constant. Puppeteer accepts a string directly — we pass it in and
 * the whole payload is evaluated in one round-trip, preserving the legacy
 * "evaluate returns the full FingerprintData verbatim" contract the
 * blackbox tests assert on.
 */

import puppeteer, { type Browser } from 'puppeteer-core';
import {
  FINGERPRINT_CHROME_ARGS,
  FINGERPRINT_NAV_TIMEOUT_MS,
  FINGERPRINT_NAV_URL,
  LOG_COMPONENT,
} from './config';
import { FINGERPRINT_PAGE_SCRIPT } from './page-script';
import { createTempUserDataDir, findChromeExecutable, removeTempUserDataDir } from './repo';
import type { FingerprintData } from './types';

/**
 * Launch Chrome under puppeteer-core against the supplied temp user-data-dir.
 * Headful is required — headless reports fake screen metrics and a
 * "HeadlessChrome" userAgent that poisons the fingerprint.
 */
async function launchFingerprintBrowser(
  chromePath: string,
  tempUserDataDir: string
): Promise<Browser> {
  return puppeteer.launch({
    executablePath: chromePath,
    headless: false,
    args: [`--user-data-dir=${tempUserDataDir}`, ...FINGERPRINT_CHROME_ARGS],
  });
}

/**
 * Navigate a fresh page to the fingerprint target URL and evaluate the
 * in-page fingerprint script. Returns the payload verbatim — the string
 * script resolves to a full `FingerprintData` object.
 */
async function evaluateFingerprintInBrowser(browser: Browser): Promise<FingerprintData> {
  const page = await browser.newPage();
  await page.goto(FINGERPRINT_NAV_URL, {
    waitUntil: 'domcontentloaded',
    timeout: FINGERPRINT_NAV_TIMEOUT_MS,
  });
  return (await page.evaluate(FINGERPRINT_PAGE_SCRIPT)) as FingerprintData;
}

/**
 * Collect fingerprint data from the user's system via Chrome.
 * Uses a temporary profile since fingerprint is based on system
 * characteristics, not profile data (hardware, GPU, screen, fonts are
 * system-level).
 */
export async function collectFingerprint(): Promise<FingerprintData | null> {
  const chromePath = findChromeExecutable();
  if (chromePath === null) {
    console.log(`[${LOG_COMPONENT}] Chrome not found`);
    return null;
  }

  const tempUserDataDir = createTempUserDataDir();

  let browser: Browser | undefined;
  try {
    console.log(`[${LOG_COMPONENT}] Launching Chrome to collect fingerprint...`);
    browser = await launchFingerprintBrowser(chromePath, tempUserDataDir);
    const fingerprint = await evaluateFingerprintInBrowser(browser);
    console.log(`[${LOG_COMPONENT}] ✅ Fingerprint collected successfully`);
    return fingerprint;
  } catch (error) {
    console.error(`[${LOG_COMPONENT}] Error collecting fingerprint:`, error);
    return null;
  } finally {
    if (browser !== undefined) {
      await browser.close();
    }
    removeTempUserDataDir(tempUserDataDir);
  }
}
