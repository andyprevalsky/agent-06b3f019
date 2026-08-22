/**
 * In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.
 *
 * Neither Kernel stealth nor Steel solveCaptcha inject a visible UI while their
 * native solvers run — solving is transparent. Users watching a live view (browser
 * agent panel or compute-token connect) therefore see a naked challenge with no
 * signal that auto-solve is underway.
 *
 * This script watches the page for known CAPTCHA widgets / challenge iframes and
 * paints a high-visibility, pointer-events:none banner so the live view itself
 * shows the state. Backend session creation installs it via Playwright; the agent
 * CDP attach path and compute-grant CDP client re-install it because Playwright
 * init scripts registered on a short-lived validation connection do not reliably
 * survive for the agent's later CDP session.
 *
 * Keep the script body byte-identical to
 * `agents/browser_tools/captcha_solve_indicator.py` (enforced by unit test).
 */

import type { Browser, BrowserContext } from 'playwright';
import { createLogger } from '../logger';

const log = createLogger('CaptchaSolveIndicator');

/** DOM id used by the injected banner — stable for tests and teardown. */
export const CAPTCHA_SOLVE_INDICATOR_DOM_ID = 'rose-captcha-auto-solve-banner';

/**
 * IIFE installed via Page.addScriptToEvaluateOnNewDocument / addInitScript.
 * Must stay in sync with the Python copy (see module docstring).
 */
export const CAPTCHA_SOLVE_INDICATOR_SCRIPT = String.raw`(() => {
  const BANNER_ID = 'rose-captcha-auto-solve-banner';
  const STYLE_ID = 'rose-captcha-auto-solve-banner-style';
  const HOST_MARKERS = [
    'hcaptcha.com',
    'newassets.hcaptcha.com',
    'recaptcha.net',
    'recaptcha/',
    'google.com/recaptcha',
    'gstatic.com/recaptcha',
    'challenges.cloudflare.com',
    'turnstile',
    'geetest.com',
    'captcha-delivery.com',
    'funcaptcha.com',
    'arkoselabs.com',
  ];
  const SELECTORS = [
    'iframe[src*="hcaptcha.com"]',
    'iframe[src*="recaptcha"]',
    'iframe[src*="challenges.cloudflare.com"]',
    'iframe[src*="turnstile"]',
    'iframe[src*="geetest"]',
    'iframe[src*="funcaptcha"]',
    'iframe[src*="arkoselabs"]',
    'iframe[title*="captcha" i]',
    'iframe[title*="hCaptcha" i]',
    '.h-captcha',
    '.g-recaptcha',
    '.cf-turnstile',
    '#cf-turnstile',
    '[data-hcaptcha-widget-id]',
    '[data-callback][data-sitekey]',
  ];

  function frameLooksLikeCaptcha(el) {
    try {
      const src = String(el.getAttribute('src') || el.src || '').toLowerCase();
      if (HOST_MARKERS.some((m) => src.includes(m))) return true;
      const title = String(el.getAttribute('title') || '').toLowerCase();
      if (title.includes('captcha') || title.includes('hcaptcha')) return true;
      const name = String(el.getAttribute('name') || '').toLowerCase();
      if (name.includes('captcha') || name.includes('hcaptcha') || name.includes('recaptcha')) return true;
    } catch (_) {}
    return false;
  }

  function captchaVisible() {
    try {
      if (SELECTORS.some((sel) => document.querySelector(sel))) return true;
      const frames = document.querySelectorAll('iframe');
      for (const frame of frames) {
        if (frameLooksLikeCaptcha(frame)) return true;
      }
    } catch (_) {}
    return false;
  }

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + BANNER_ID + '{',
      '  position:fixed!important;top:0!important;left:0!important;right:0!important;',
      '  z-index:2147483647!important;pointer-events:none!important;',
      '  display:flex!important;align-items:center!important;justify-content:center!important;gap:12px!important;',
      '  padding:14px 18px!important;margin:0!important;box-sizing:border-box!important;',
      '  background:linear-gradient(90deg,#111827 0%,#1f2937 50%,#111827 100%)!important;',
      '  color:#fde68a!important;font:700 16px/1.35 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;',
      '  letter-spacing:0.02em!important;text-align:center!important;',
      '  border-bottom:3px solid #f59e0b!important;',
      '  box-shadow:0 8px 24px rgba(0,0,0,0.45)!important;',
      '}',
      '#' + BANNER_ID + ' .rose-captcha-spinner{',
      '  width:16px!important;height:16px!important;border-radius:50%!important;flex:0 0 auto!important;',
      '  border:2px solid rgba(253,230,138,0.35)!important;border-top-color:#fbbf24!important;',
      '  animation:rose-captcha-spin 0.8s linear infinite!important;',
      '}',
      '@keyframes rose-captcha-spin{to{transform:rotate(360deg)}}',
      '#' + BANNER_ID + ' .rose-captcha-copy{',
      '  display:flex!important;flex-direction:column!important;align-items:center!important;gap:2px!important;',
      '}',
      '#' + BANNER_ID + ' .rose-captcha-title{',
      '  font-size:16px!important;font-weight:800!important;color:#fde68a!important;',
      '  text-transform:uppercase!important;',
      '}',
      '#' + BANNER_ID + ' .rose-captcha-sub{',
      '  font-size:12px!important;font-weight:600!important;color:#fef3c7!important;opacity:0.95!important;',
      '}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function showBanner() {
    ensureStyle();
    let el = document.getElementById(BANNER_ID);
    if (el) return;
    el = document.createElement('div');
    el.id = BANNER_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-rose-captcha-auto-solve', '1');
    el.innerHTML =
      '<div class="rose-captcha-spinner" aria-hidden="true"></div>' +
      '<div class="rose-captcha-copy">' +
      '<div class="rose-captcha-title">Auto-solving CAPTCHA</div>' +
      '<div class="rose-captcha-sub">Please wait — do not click the challenge</div>' +
      '</div>';
    (document.body || document.documentElement).appendChild(el);
  }

  function hideBanner() {
    const el = document.getElementById(BANNER_ID);
    if (el) el.remove();
  }

  function sync() {
    if (captchaVisible()) showBanner();
    else hideBanner();
  }

  function start() {
    sync();
    try {
      const root = document.documentElement || document.body;
      if (root) {
        const mo = new MutationObserver(() => sync());
        mo.observe(root, { childList: true, subtree: true, attributes: true });
      }
    } catch (_) {}
    setInterval(sync, 750);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();`;

async function installOnContext(context: BrowserContext): Promise<void> {
  await context.addInitScript(CAPTCHA_SOLVE_INDICATOR_SCRIPT);
  for (const page of context.pages()) {
    await page.evaluate(CAPTCHA_SOLVE_INDICATOR_SCRIPT).catch(() => {
      // Cross-origin / detached pages can refuse evaluate; init script still covers next nav.
    });
  }
}

/** Register the indicator on every context of an already-open Playwright browser. */
export async function installCaptchaSolveIndicator(browser: Browser): Promise<void> {
  const contexts = browser.contexts();
  await Promise.all(contexts.map((context) => installOnContext(context)));
  log.info('Installed CAPTCHA auto-solve indicator', { contextCount: contexts.length });
}
