/**
 * In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.
 *
 * Neither Kernel stealth nor Steel solveCaptcha inject a visible UI while their
 * native solvers run. This script paints a high-visibility, pointer-events:none
 * chip (TakeControlChip-style bottom pill) when provider CAPTCHA telemetry says
 * auto-solve is active.
 *
 * The page does NOT infer solving from captcha DOM alone — callers poll
 * `/captcha-telemetry` (or Steel's captchas.status) and push state via
 * `captchaSolveIndicatorSetSolvingScript(true|false)`.
 *
 * Kernel has no in-flight solver flag (terminal `captcha_solve_result` only), so
 * callers synthesize `solving` for Kernel (see `resolveCaptchaAutoSolveActive`).
 *
 * Keep the script body byte-identical to
 * `agents/browser_tools/captcha_solve_indicator.py` (enforced by unit test).
 */

import type { Browser, BrowserContext } from 'playwright';
import { createLogger } from '../logger';
import type { BrowserCaptchaTelemetry } from './captchaTelemetry';

const log = createLogger('CaptchaSolveIndicator');

/** DOM id used by the injected chip — stable for tests and teardown. */
export const CAPTCHA_SOLVE_INDICATOR_DOM_ID = 'rose-captcha-auto-solve-chip';

/** Window flag the injected script reads; set by CDP evaluate from telemetry. */
export const CAPTCHA_SOLVE_INDICATOR_FLAG = '__ROSE_CAPTCHA_AUTO_SOLVE__';

/**
 * IIFE installed via Page.addScriptToEvaluateOnNewDocument / addInitScript.
 * Visual matches BrowserFullscreenOverlays TakeControlChip (bottom-center pill).
 * Must stay in sync with the Python copy (see module docstring).
 */
export const CAPTCHA_SOLVE_INDICATOR_SCRIPT = String.raw`(() => {
  if (window.__ROSE_CAPTCHA_AUTO_SOLVE__ && window.__ROSE_CAPTCHA_AUTO_SOLVE__.__roseInstalled) return;
  const CHIP_ID = 'rose-captcha-auto-solve-chip';
  const STYLE_ID = 'rose-captcha-auto-solve-chip-style';
  const state = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || {
    solving: false,
  });
  state.__roseInstalled = true;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + CHIP_ID + '{',
      '  position:fixed!important;left:50%!important;bottom:40px!important;right:auto!important;top:auto!important;',
      '  transform:translateX(-50%)!important;',
      '  z-index:2147483647!important;pointer-events:none!important;',
      '  display:flex!important;align-items:center!important;justify-content:center!important;gap:8px!important;',
      '  padding:8px 16px!important;margin:0!important;box-sizing:border-box!important;',
      '  max-width:calc(100vw - 24px)!important;',
      '  border-radius:9999px!important;border:1px solid rgba(255,255,255,0.10)!important;',
      '  background:#272725!important;color:#ffffff!important;',
      '  font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;',
      '  box-shadow:0 25px 50px -12px rgba(0,0,0,0.55)!important;',
      '  white-space:nowrap!important;',
      '}',
      '#' + CHIP_ID + ' .rose-captcha-spinner{',
      '  width:14px!important;height:14px!important;border-radius:50%!important;flex:0 0 auto!important;',
      '  border:2px solid rgba(255,255,255,0.25)!important;border-top-color:#60a5fa!important;',
      '  animation:rose-captcha-spin 0.75s linear infinite!important;',
      '}',
      '@keyframes rose-captcha-spin{to{transform:rotate(360deg)}}',
      '#' + CHIP_ID + ' .rose-captcha-label{',
      '  font-size:14px!important;font-weight:500!important;color:#ffffff!important;',
      '}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function showChip() {
    ensureStyle();
    let el = document.getElementById(CHIP_ID);
    if (el) return;
    el = document.createElement('div');
    el.id = CHIP_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-rose-captcha-auto-solve', '1');
    el.innerHTML =
      '<div class="rose-captcha-spinner" aria-hidden="true"></div>' +
      '<span class="rose-captcha-label">Auto-solving CAPTCHA</span>';
    (document.body || document.documentElement).appendChild(el);
  }

  function hideChip() {
    const el = document.getElementById(CHIP_ID);
    if (el) el.remove();
  }

  function sync() {
    if (state.solving === true) showChip();
    else hideChip();
  }

  state.setSolving = function setSolving(next) {
    state.solving = next === true;
    sync();
  };

  function start() {
    sync();
    setInterval(sync, 400);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();`;

/** CDP/Page.evaluate expression that toggles the chip from provider telemetry. */
export function captchaSolveIndicatorSetSolvingScript(solving: boolean): string {
  return (
    `(() => {` +
    `const s = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || { solving: false });` +
    `if (typeof s.setSolving === 'function') { s.setSolving(${solving ? 'true' : 'false'}); }` +
    `else { s.solving = ${solving ? 'true' : 'false'}; }` +
    `return !!s.solving;` +
    `})()`
  );
}

/**
 * Decide whether the live-view chip should be on.
 *
 * Steel exposes a real in-flight `isSolving` flag. Kernel only emits terminal
 * `captcha_solve_result` events (`isSolving` is always null), so callers may
 * pass `kernelChallengeWidgetsPresent` from a live CDP probe as the Kernel
 * stand-in for "solver is engaged on a challenge".
 */
export function resolveCaptchaAutoSolveActive(
  telemetry: Pick<BrowserCaptchaTelemetry, 'provider' | 'isSolving'>,
  options: { kernelChallengeWidgetsPresent?: boolean } = {}
): boolean {
  if (telemetry.isSolving === true) return true;
  if (telemetry.isSolving === false) return false;
  if (telemetry.provider === 'kernel') {
    return options.kernelChallengeWidgetsPresent === true;
  }
  return false;
}

/** Expression that returns whether common CAPTCHA widgets are present (Kernel synth). */
export const CAPTCHA_WIDGET_PRESENT_SCRIPT = String.raw`(() => {
  const HOST_MARKERS = [
    'hcaptcha.com', 'newassets.hcaptcha.com', 'recaptcha.net', 'recaptcha/',
    'google.com/recaptcha', 'gstatic.com/recaptcha', 'challenges.cloudflare.com',
    'turnstile', 'geetest.com', 'captcha-delivery.com', 'funcaptcha.com', 'arkoselabs.com',
  ];
  try {
    const frames = document.querySelectorAll('iframe');
    for (const frame of frames) {
      const src = String(frame.getAttribute('src') || frame.src || '').toLowerCase();
      if (HOST_MARKERS.some((m) => src.includes(m))) return true;
      const title = String(frame.getAttribute('title') || '').toLowerCase();
      if (title.includes('captcha') || title.includes('hcaptcha')) return true;
    }
    return !!(
      document.querySelector('.h-captcha, .g-recaptcha, .cf-turnstile, #cf-turnstile, [data-hcaptcha-widget-id]')
    );
  } catch (_) {
    return false;
  }
})()`;

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

/** Push the latest telemetry-derived solving state into an open Playwright page. */
export async function applyCaptchaSolveIndicatorFromTelemetry(
  browser: Browser,
  telemetry: Pick<BrowserCaptchaTelemetry, 'provider' | 'isSolving'>,
  options: { kernelChallengeWidgetsPresent?: boolean } = {}
): Promise<boolean> {
  const solving = resolveCaptchaAutoSolveActive(telemetry, options);
  const script = captchaSolveIndicatorSetSolvingScript(solving);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await page.evaluate(script).catch(() => undefined);
    }
  }
  return solving;
}
