/**
 * End-to-end kernel DoorDash drive: production initSession + immediate CDP control.
 * No agent harness — browser-session init only.
 */
import fs from 'node:fs';
import { randomUUID } from 'node:crypto';
import type { Page } from 'playwright';

const BACKEND = process.env.BACKEND_URL ?? 'http://localhost:3020';
const API_KEY = process.env.API_KEY ?? process.env.BACKEND_API_KEY ?? '';
const USER_ID = process.env.DOORDASH_DRIVE_USER_ID ?? '1f85ff25-6e29-4c1b-8739-f917bd101a30';
const SAFEWAY =
  'https://www.doordash.com/convenience/store/safeway-palo-alto-1741346/';
const ARTIFACT = '/opt/cursor/artifacts/doordash_kernel_cdp_drive.json';

const MANIFEST_SEARCHES = [
  '93/7 ground beef',
  'chicken breast boneless skinless',
  'salmon fillet',
  'egg whites liquid',
  'Fairlife Core Power Elite 42g',
  'Fage Total 0% Greek yogurt',
  'sweet potatoes',
  'white rice dry',
  'PB2 peanut powder',
  'coconut aminos',
  'crushed tomatoes no salt added',
  'broccoli frozen',
  'Fairlife chocolate 2% milk',
  'Valentina hot sauce',
  'LaCroix lime sparkling water',
];

function log(...args: unknown[]) {
  console.log(new Date().toISOString(), ...args);
}

function safeJson(obj: unknown) {
  return JSON.parse(JSON.stringify(obj, (_k, v) => (typeof v === 'bigint' ? v.toString() : v)));
}

async function api(path: string, init?: RequestInit) {
  const res = await fetch(`${BACKEND}${path}`, {
    ...init,
    headers: {
      'X-API-Key': API_KEY,
      'X-User-Id': USER_ID,
      'Content-Type': 'application/json',
      ...(init?.headers ?? {}),
    },
  });
  const text = await res.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    /* keep text */
  }
  if (!res.ok) throw new Error(`${path} ${res.status}: ${text.slice(0, 400)}`);
  return body as Record<string, unknown>;
}

async function snap(page: Page, step: string, extra?: Record<string, unknown>) {
  const title = await page.title().catch(() => '');
  const url = page.url();
  const snippet = await page
    .evaluate(() => (document.body?.innerText || '').replace(/\s+/g, ' ').trim().slice(0, 1800))
    .catch(() => '');
  log(`[${step}] ${url}`);
  log(`  ${snippet.slice(0, 350)}`);
  return { step, url, title, snippet, extra };
}

async function cartCount(page: Page) {
  return page
    .evaluate(() => {
      const text = document.body?.innerText || '';
      const m = text.match(/(\d+)\s*items?\s*in cart/i) || text.match(/Cart\s*\((\d+)\)/i);
      return m ? Number(m[1]) : null;
    })
    .catch(() => null);
}

async function clickPlusOnFirstProduct(page: Page) {
  return page
    .evaluate(() => {
      const selectors = [
        'button[aria-label*="Add" i]',
        'button[aria-label*="Increase" i]',
        'button[data-testid*="add" i]',
        'button[data-testid*="increment" i]',
      ];
      for (const sel of selectors) {
        const btn = document.querySelector(sel);
        if (btn instanceof HTMLElement) {
          btn.click();
          return btn.getAttribute('aria-label') || sel;
        }
      }
      const addBtn = Array.from(document.querySelectorAll('button')).find((b) => {
        const t = (b.textContent || '').trim();
        return t === '+' || t === 'Add' || /^Add\b/i.test(t);
      });
      if (addBtn instanceof HTMLElement) {
        addBtn.click();
        return addBtn.textContent?.trim() || 'Add';
      }
      return null;
    })
    .catch(() => null);
}

async function searchStore(page: Page, query: string) {
  const search = page.locator('input[placeholder*="Search" i], input[type="search"]').first();
  if ((await search.count()) === 0) return { added: false, detail: 'no search box' };
  await search.click({ timeout: 10_000 });
  await search.fill('');
  await search.fill(query);
  await page.keyboard.press('Enter');
  await page.waitForTimeout(6000);
  const clicked = await clickPlusOnFirstProduct(page);
  await page.waitForTimeout(2500);
  return { added: Boolean(clicked), detail: clicked ?? 'no plus/add on results' };
}

async function openCartDrawer(page: Page): Promise<string | null> {
  await dismissOverlays(page);
  await page
    .locator('[data-testid="OrderCartIconButton"], button[aria-label*="open Order Cart" i]')
    .first()
    .click({ timeout: 15_000, force: true });
  await page.waitForTimeout(5000);
  return 'cart badge button';
}

async function gotoCheckout(page: Page) {
  const dialogCheckout = page.locator('[role="dialog"] >> text=Checkout').first();
  if ((await dialogCheckout.count()) > 0) {
    await dialogCheckout.click({ timeout: 15_000, force: true });
    await page.waitForTimeout(15_000);
  }

  const orderCartId = (page.url().match(/orderCartId=([a-f0-9-]{36})/i) ?? [])[1];
  if (orderCartId) {
    const checkoutUrl = `https://www.doordash.com/consumer/checkout/?lat=37.422419&lng=-122.118354&order_cart_id=${orderCartId}&overridePageType=nv_checkout`;
    await page.goto(checkoutUrl, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
    await page.waitForTimeout(20_000);
    return { url: page.url(), detail: `order_cart_id=${orderCartId}` };
  }

  return { url: page.url(), detail: 'no checkout path' };
}

async function dismissOverlays(page: Page) {
  await page.keyboard.press('Escape').catch(() => null);
  await page.waitForTimeout(500);
  await page
    .locator('button[aria-label*="Close" i], button[aria-label*="Dismiss" i]')
    .first()
    .click({ timeout: 2000, force: true })
    .catch(() => null);
}

async function clearCartToZero(page: Page): Promise<{ removed: number; detail: string }> {
  let removed = 0;
  for (let attempt = 0; attempt < 60; attempt += 1) {
    await dismissOverlays(page);
    const count = await cartCount(page);
    if (count === 0) return { removed, detail: 'cart_empty' };
    if (count === null) return { removed, detail: 'cart_count_unknown' };

    await page
      .locator('[data-testid="OrderCartIconButton"], button[aria-label*="open Order Cart" i]')
      .first()
      .click({ timeout: 10_000, force: true })
      .catch(() => null);
    await page.waitForTimeout(1500);
    await dismissOverlays(page);

    const clicked = await page
      .evaluate(() => {
        const emptyAll = Array.from(document.querySelectorAll('button, a')).find((el) => {
          const t = (el.textContent || '').trim().toLowerCase();
          return t.includes('empty cart') || t.includes('remove all') || t.includes('clear cart');
        });
        if (emptyAll instanceof HTMLElement) {
          emptyAll.click();
          return 'empty_all';
        }
        const decSelectors = [
          'button[aria-label*="Decrease" i]',
          'button[aria-label*="Remove" i]',
          'button[data-testid*="decrement" i]',
          'button[data-testid*="remove" i]',
        ];
        for (const sel of decSelectors) {
          const btn = document.querySelector(sel);
          if (btn instanceof HTMLElement) {
            btn.click();
            return sel;
          }
        }
        const minus = Array.from(document.querySelectorAll('button')).find((b) => {
          const t = (b.textContent || '').trim();
          return t === '−' || t === '-' || /remove/i.test(b.getAttribute('aria-label') || '');
        });
        if (minus instanceof HTMLElement) {
          minus.click();
          return minus.getAttribute('aria-label') || 'minus';
        }
        return null;
      })
      .catch(() => null);
    if (!clicked) {
      return { removed, detail: `stuck_with_${count}_items_no_decrement_button` };
    }
    removed += 1;
    await page.waitForTimeout(1200);
    await dismissOverlays(page);
  }
  return { removed, detail: 'max_attempts' };
}

async function main() {
  if (!API_KEY) throw new Error('Set API_KEY or BACKEND_API_KEY');
  const agentId = randomUUID();
  log(`manual kernel drive (no agent spawn) session key ${agentId}`);

  const init = (await api('/api/browser-session/init', {
    method: 'POST',
    body: JSON.stringify({
      user_id: USER_ID,
      agent_id: agentId,
      start_url: 'https://www.doordash.com/home',
    }),
  })) as {
    session_id: string;
    ws_url: string;
    debug_url: string;
    cookies_injected: boolean;
    cookies_count: number;
    auth_source: string;
  };

  log(`session ${init.session_id} cookies=${init.cookies_count} auth=${init.auth_source}`);
  log(`live=${init.debug_url}`);

  const { chromium } = await import('playwright');
  const browser = await chromium.connectOverCDP(init.ws_url, { timeout: 60_000 });
  const context = browser.contexts()[0];
  const page = context?.pages()[0] ?? (await context!.newPage());

  const steps: Array<Awaited<ReturnType<typeof snap>>> = [];
  const addResults: Array<{ query: string; added: boolean; detail: string }> = [];
  const blockers: string[] = [];

  await page.goto('https://www.doordash.com/home', { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(8000);
  steps.push(await snap(page, 'home', { cartCount: await cartCount(page) }));

  let cartClear = { removed: 0, detail: 'not_needed' };
  let initialCart = await cartCount(page);
  if (initialCart !== null && initialCart > 0) {
    cartClear = await clearCartToZero(page);
    steps.push(await snap(page, 'cart_cleared_home', { initialCart, cartClear, cartCount: await cartCount(page) }));
    log(`cleared injected cart at home: ${JSON.stringify(cartClear)}`);
  }

  await page.goto(SAFEWAY, { waitUntil: 'domcontentloaded', timeout: 90_000 });
  await page.waitForTimeout(10_000);
  steps.push(await snap(page, 'safeway', { cartCount: await cartCount(page) }));

  initialCart = await cartCount(page);
  if (initialCart !== null && initialCart > 0) {
    cartClear = await clearCartToZero(page);
    steps.push(await snap(page, 'cart_cleared_safeway', { initialCart, cartClear, cartCount: await cartCount(page) }));
    log(`cleared cart at safeway: ${JSON.stringify(cartClear)}`);
  }

  const homeText = steps.find((s) => s.step === 'home')?.snippet ?? '';
  const loggedIn = /deliver to|account|orders|profile|welcome back/i.test(homeText);
  const loggedOut = /sign in|sign up|log in/i.test(homeText);
  if (loggedOut && !loggedIn) blockers.push('logged_out_after_production_injection');

  let itemsAdded = 0;
  const skipAdds = process.env.SKIP_ADDS === '1';
  if (!skipAdds) {
    for (const query of MANIFEST_SEARCHES) {
    await page.goto(SAFEWAY, { waitUntil: 'domcontentloaded', timeout: 90_000 }).catch(() => null);
    await page.waitForTimeout(3000);
    const r = await searchStore(page, query);
    addResults.push({ query, ...r });
    log(`add "${query}": ${r.detail}`);
    if (r.added) itemsAdded += 1;
      if (itemsAdded >= 6) break;
    }
  } else {
    log('SKIP_ADDS=1 — using existing cart only');
  }

  steps.push(await snap(page, 'after_adds', { cartCount: await cartCount(page), itemsAdded }));

  const cartOpen = await openCartDrawer(page).catch((err) => {
    blockers.push(`cart_drawer_failed:${String(err).slice(0, 120)}`);
    return null;
  });
  steps.push(await snap(page, 'cart_drawer', { cartOpen, cartCount: await cartCount(page) }));

  const checkout = await gotoCheckout(page);
  steps.push(await snap(page, 'checkout', { checkoutDetail: checkout.detail }));

  const checkoutSnippet = steps[steps.length - 1]?.snippet ?? '';
  const reachedCheckout = /place order|payment method|subtotal|review order|order summary/i.test(
    checkoutSnippet
  ) && !/couldn't find the page/i.test(checkoutSnippet);
  if (!reachedCheckout) blockers.push('checkout_ui_not_reached');

  const result = safeJson({
    agentId,
    sessionId: init.session_id,
    debugUrl: init.debug_url,
    cookiesInjected: init.cookies_injected,
    cookiesCount: init.cookies_count,
    authSource: init.auth_source,
    loggedIn,
    initialCart,
    cartClear,
    itemsAdded,
    addResults,
    steps,
    reachedCheckout,
    checkoutUrl: checkout.url,
    checkoutDetail: checkout.detail,
    blockers,
  });

  fs.mkdirSync('/opt/cursor/artifacts', { recursive: true });
  fs.writeFileSync(ARTIFACT, JSON.stringify(result, null, 2));
  console.log('\n=== RESULT ===');
  console.log(JSON.stringify(result, null, 2));

  await api('/api/browser-session/close', {
    method: 'POST',
    body: JSON.stringify({ session_id: init.session_id, pause: false }),
  }).catch(() => null);
  await browser.close().catch(() => {});
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
