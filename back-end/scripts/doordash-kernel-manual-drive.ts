/**
 * Manual kernel DoorDash grocery drive — full credential injection, no agent harness.
 * Attempts: auth verify → Safeway store → cart inspect → add manifest items → checkout (no purchase).
 */
import fs from 'node:fs';
import type { BrowserContext, Cookie, Page } from 'playwright';
import { PrismaClient } from '@prisma/client';
import { canonicalAuthRealm } from '../src/providers/authRealm';
import { cookieSelectionWhere } from '../src/providers/browserCookies';
import { applyFingerprintInjection } from '../src/providers/browser/fingerprintInjection';
import { createKernelRecoverySession, releaseKernelRemoteSession } from '../src/providers/browser/kernel';
import { recoveryOriginStorageScript } from '../src/providers/browser/recoveryOriginStorage';
import { getFingerprintInjectionData } from '../src/providers/steel/files';
import {
  injectCacheStorageState,
  injectIndexedDBState,
  injectLocalStorageState,
  injectPermissionState,
  injectScrollbarState,
} from '../src/providers/steel/injectionState';
import { resolveBrowserAuthCredentialSource } from '../src/providers/steel/injection';
import type { ProxyGeoLocation } from '../src/providers/geoip';

const USER_ID = process.env.DOORDASH_DRIVE_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const START_URL = 'https://www.doordash.com/';
const SAFEWAY =
  'https://www.doordash.com/convenience/store/safeway-palo-alto-1741346/';
const GEO: ProxyGeoLocation = { country: 'US', state: 'CA', city: 'PALO ALTO' };
const CHROME_EPOCH_OFFSET_SECONDS = 11_644_473_600;
const ARTIFACT = '/opt/cursor/artifacts/doordash_kernel_manual_drive.json';

/** High-priority manifest search terms (subset — drive until blocked). */
const MANIFEST_SEARCHES = [
  '93/7 ground beef',
  'boneless skinless chicken breast',
  'salmon fillet',
  'liquid egg whites',
  'Fairlife Core Power Elite 42g',
  'Fage Total 0% Greek yogurt',
  'sweet potatoes',
  'dry white rice',
  'PB2 powdered peanut butter',
  'coconut aminos',
  'no salt added crushed tomatoes',
  'frozen broccoli',
  'Fairlife 2% chocolate milk',
  'Valentina hot sauce',
  'LaCroix lime sparkling water',
];

type StepRecord = {
  step: string;
  url: string;
  title: string;
  snippet: string;
  extra?: Record<string, unknown>;
};

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function chromeExpiresToEpochSeconds(expiresUtc: bigint | null): number | undefined {
  if (expiresUtc === null || expiresUtc <= 0n) return undefined;
  const epochSeconds = Math.floor(Number(expiresUtc / 1_000_000n) - CHROME_EPOCH_OFFSET_SECONDS);
  return epochSeconds > 0 ? epochSeconds : undefined;
}

async function loadCredentials(userId: string, startUrl: string) {
  const prisma = new PrismaClient();
  try {
    const authRealm = canonicalAuthRealm(startUrl);
    const originDomainFilter = {
      userId,
      OR: [
        { origin: { endsWith: `://${authRealm}` } },
        { origin: { contains: `://${authRealm}:` } },
        { origin: { endsWith: `.${authRealm}` } },
        { origin: { contains: `.${authRealm}:` } },
      ],
    };
    const authSource = await resolveBrowserAuthCredentialSource({
      userId,
      authRealm,
      steelContextId: null,
    });
    let cookies: Cookie[] = [];
    if (authSource.kind === 'cookie_bundle') {
      const rows = await prisma.cookie.findMany({
        where: {
          userId,
          ...cookieSelectionWhere(authRealm),
          browserSource: authSource.browserSource,
          browserProfile: authSource.browserProfile,
        },
      });
      cookies = rows.map((row) => ({
        name: row.name,
        value: row.value,
        domain: row.domain,
        path: row.path || '/',
        expires: chromeExpiresToEpochSeconds(row.expiresUtc),
        httpOnly: Boolean(row.isHttpOnly),
        secure: Boolean(row.isSecure),
        sameSite: 'Lax' as const,
      }));
    }
    const [localStorageOrigins, indexedDBOrigins, permissions, cacheStorageOrigins] =
      await Promise.all([
        prisma.localStorageOrigin.findMany({ where: originDomainFilter }),
        prisma.indexedDBOrigin.findMany({ where: originDomainFilter }),
        prisma.browserPermission.findMany({ where: originDomainFilter }),
        prisma.cacheStorageOrigin.findMany({ where: originDomainFilter }),
      ]);
    const origins = localStorageOrigins.map((o) => ({
      origin: o.origin,
      localStorage: (o.entries as Array<{ key: string; value: string }>).map((e) => ({
        name: e.key,
        value: e.value,
      })),
      indexedDB: [] as unknown[],
    }));
    for (const idb of indexedDBOrigins) {
      const hit = origins.find((o) => o.origin === idb.origin);
      const databases = idb.databases as unknown[];
      if (hit) {
        hit.indexedDB = databases;
      } else {
        origins.push({ origin: idb.origin, localStorage: [], indexedDB: databases });
      }
    }
    return {
      authSource,
      storageState: { cookies, origins },
      localStorageOrigins,
      indexedDBOrigins,
      permissions,
      cacheStorageOrigins,
    };
  } finally {
    await prisma.$disconnect();
  }
}

async function snap(page: Page, label: string, extra?: Record<string, unknown>): Promise<StepRecord> {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const snippet = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1500))
    .catch(() => '');
  const record = { step: label, url, title, snippet, extra };
  log(`[${label}] url=${url}`);
  log(`  title=${title.slice(0, 100)}`);
  log(`  text=${snippet.slice(0, 400)}`);
  return record;
}

async function injectAuth(context: BrowserContext, creds: Awaited<ReturnType<typeof loadCredentials>>) {
  const { storageState, localStorageOrigins, indexedDBOrigins, permissions, cacheStorageOrigins } =
    creds;
  if (storageState.cookies.length > 0) {
    await context.addCookies(storageState.cookies);
    log(`injected ${storageState.cookies.length} cookies`);
  }
  if (storageState.origins.length > 0) {
    await context.addInitScript(recoveryOriginStorageScript(storageState));
  }
  await injectLocalStorageState(context, localStorageOrigins, Date.now());
  await injectIndexedDBState(context, indexedDBOrigins, Date.now());
  await injectPermissionState(context, permissions, Date.now());
  await injectCacheStorageState(context, cacheStorageOrigins, Date.now());
  await injectScrollbarState(context, Date.now());
}

async function restoreStorage(page: Page) {
  await page.evaluate(async () => {
    const g = globalThis as typeof globalThis & {
      __naviRestoreRecoveryStorage?: () => Promise<void>;
    };
    await g.__naviRestoreRecoveryStorage?.();
  });
}

async function readCartBadge(page: Page): Promise<string | null> {
  return page
    .evaluate(() => {
      const text = document.body?.innerText || '';
      const m = text.match(/(\d+)\s*items?\s*in cart/i) || text.match(/Cart\s*\((\d+)\)/i);
      if (m) return m[0];
      const aria = Array.from(document.querySelectorAll('[aria-label*="cart" i]'))
        .map((el) => el.getAttribute('aria-label') || '')
        .find((l) => /\d/.test(l));
      return aria ?? null;
    })
    .catch(() => null);
}

async function clickFirstMatching(page: Page, patterns: RegExp[]): Promise<string | null> {
  return page
    .evaluate((pats) => {
      const patterns = pats.map((p) => new RegExp(p.source, p.flags));
      const nodes = Array.from(document.querySelectorAll('button, a, [role="button"]'));
      for (const el of nodes) {
        const label = (el.textContent || el.getAttribute('aria-label') || '').trim();
        if (!label) continue;
        if (patterns.some((re) => re.test(label))) {
          (el as HTMLElement).click();
          return label.slice(0, 120);
        }
      }
      return null;
    }, patterns.map((p) => ({ source: p.source, flags: p.flags })))
    .catch(() => null);
}

async function searchAndAdd(page: Page, query: string): Promise<{ added: boolean; detail: string }> {
  // Focus search input
  const searchSel =
    'input[placeholder*="Search" i], input[type="search"], input[name*="search" i], input[aria-label*="Search" i]';
  const input = page.locator(searchSel).first();
  if ((await input.count()) === 0) {
    return { added: false, detail: 'no search input' };
  }
  await input.click({ timeout: 15_000 }).catch(() => null);
  await input.fill('');
  await input.fill(query, { timeout: 15_000 });
  await page.keyboard.press('Enter');
  await page.waitForTimeout(5000);

  const addClicked = await page
    .evaluate(() => {
      const buttons = Array.from(document.querySelectorAll('button, [role="button"]'));
      const add = buttons.find((b) => /^\+?\s*add\b/i.test((b.textContent || '').trim()));
      if (add instanceof HTMLElement) {
        add.click();
        return (add.textContent || 'Add').trim();
      }
      const inc = buttons.find((b) => /increment|plus|^\+$/i.test(b.getAttribute('aria-label') || b.textContent || ''));
      if (inc instanceof HTMLElement) {
        inc.click();
        return 'increment';
      }
      return null;
    })
    .catch(() => null);

  await page.waitForTimeout(2500);
  return { added: Boolean(addClicked), detail: addClicked ?? 'no add button' };
}

async function tryOpenCart(page: Page): Promise<string | null> {
  const clicked = await clickFirstMatching(page, [
    /^cart$/i,
    /view cart/i,
    /items in cart/i,
    /go to cart/i,
    /checkout/i,
  ]);
  if (clicked) {
    await page.waitForTimeout(8000);
    return clicked;
  }
  // Floating cart chip
  const chip = page.locator('[data-testid*="cart" i], [aria-label*="cart" i]').first();
  if ((await chip.count()) > 0) {
    await chip.click({ timeout: 10_000 }).catch(() => null);
    await page.waitForTimeout(8000);
    return 'cart chip';
  }
  return null;
}

async function tryCheckout(page: Page): Promise<{ url: string; detail: string }> {
  const clicked = await clickFirstMatching(page, [
    /checkout/i,
    /review order/i,
    /continue to checkout/i,
  ]);
  if (clicked) {
    await page.waitForTimeout(12_000);
    return { url: page.url(), detail: `clicked: ${clicked}` };
  }
  // Extract order_cart_id from page/network if present
  const cartId = await page
    .evaluate(() => {
      const html = document.documentElement.innerHTML;
      const m = html.match(/order_cart_id[=:"']([a-f0-9-]{36})/i);
      return m?.[1] ?? null;
    })
    .catch(() => null);
  if (cartId) {
    const checkoutUrl = `https://www.doordash.com/consumer/checkout/?order_cart_id=${cartId}&overridePageType=nv_checkout`;
    await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
    await page.waitForTimeout(10_000);
    return { url: page.url(), detail: `direct checkout cart_id=${cartId}` };
  }
  return { url: page.url(), detail: 'no checkout control' };
}

async function main() {
  const steps: StepRecord[] = [];
  const addResults: Array<{ query: string; added: boolean; detail: string }> = [];

  log(`loading credentials for ${USER_ID}`);
  const creds = await loadCredentials(USER_ID, START_URL);
  log(`auth source=${creds.authSource.kind} cookies=${creds.storageState.cookies.length}`);

  const fingerprint = await getFingerprintInjectionData(USER_ID).catch(() => null);
  const session = await createKernelRecoverySession('doordash-kernel-manual-drive', GEO, {
    type: 'residential',
    specificity: 'city',
  });
  log(`kernel session ${session.sessionId} live=${session.liveViewUrl}`);

  const result: Record<string, unknown> = {
    userId: USER_ID,
    liveViewUrl: session.liveViewUrl,
    sessionId: session.sessionId,
    authSource: creds.authSource,
    cookieCount: creds.storageState.cookies.length,
    steps,
    addResults,
    reachedCheckout: false,
    blockers: [] as string[],
  };

  try {
    const context = session.validationBrowser.contexts()[0];
    if (!context) throw new Error('no browser context');
    const page = context.pages()[0] ?? (await context.newPage());
    await injectAuth(context, creds);
    await applyFingerprintInjection(page, fingerprint);

    await page.goto(START_URL, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(8000);
    await restoreStorage(page);
    await page.reload({ waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
    await page.waitForTimeout(6000);
    steps.push(await snap(page, 'home_after_auth'));

    const bodyText = steps[steps.length - 1]?.snippet ?? '';
    if (/log in|sign in|create account/i.test(bodyText) && !/account|orders|profile/i.test(bodyText)) {
      (result.blockers as string[]).push('appears logged out after auth injection');
    }

    await page.goto(SAFEWAY, { waitUntil: 'domcontentloaded', timeout: 90_000 });
    await page.waitForTimeout(12_000);
    await restoreStorage(page);
    steps.push(await snap(page, 'safeway_store', { cartBadge: await readCartBadge(page) }));

    // Try opening cart before adding
    const cartOpen = await tryOpenCart(page);
    if (cartOpen) {
      steps.push(await snap(page, 'cart_drawer_or_page', { cartOpen }));
    }

    // Add manifest items (bounded subset for probe runtime)
    for (const query of MANIFEST_SEARCHES) {
      log(`search add: ${query}`);
      await page.goto(SAFEWAY, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
      await page.waitForTimeout(4000);
      const r = await searchAndAdd(page, query);
      addResults.push({ query, ...r });
      log(`  => added=${r.added} detail=${r.detail}`);
      if (addResults.length >= 8 && addResults.filter((x) => x.added).length >= 3) {
        log('enough adds for probe — continuing to checkout');
        break;
      }
    }

    steps.push(await snap(page, 'after_adds', { cartBadge: await readCartBadge(page) }));

    const cartOpen2 = await tryOpenCart(page);
    steps.push(await snap(page, 'cart_before_checkout', { cartOpen: cartOpen2 }));

    const checkout = await tryCheckout(page);
    steps.push(
      await snap(page, 'checkout_attempt', {
        checkoutDetail: checkout.detail,
      })
    );

    const checkoutText = steps[steps.length - 1]?.snippet ?? '';
    const reachedCheckout = /checkout|payment|place order|subtotal|delivery|review order|tip/i.test(
      checkoutText + checkout.url
    );
    result.reachedCheckout = reachedCheckout;
    result.checkoutUrl = checkout.url;
    result.checkoutDetail = checkout.detail;
    result.stripeSeen = await page
      .evaluate(() =>
        performance.getEntriesByType('resource').some((e) =>
          String((e as PerformanceResourceTiming).name).includes('js.stripe.com')
        )
      )
      .catch(() => false);

    if (!reachedCheckout) {
      (result.blockers as string[]).push('did not reach checkout UI');
    }
    if (/cloudflare|verify you are human|access denied/i.test(checkoutText)) {
      (result.blockers as string[]).push('cloudflare/challenge on checkout');
    }

    fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
    fs.writeFileSync(ARTIFACT, JSON.stringify(result, null, 2));
    console.log('\n=== RESULT ===');
    console.log(JSON.stringify(result, null, 2));
  } finally {
    await session.validationBrowser.close().catch(() => {});
    await releaseKernelRemoteSession(session.sessionId).catch(() => {});
  }
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
