/**
 * In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.
 *
 * STATE (phase pushed from provider telemetry):
 *   idle ──► solving ──► succeeded|failed ──(hold ~2.2s)──► idle
 *
 * Steel: isSolving + terminal task status (solved / failed_to_*).
 * Kernel: widget probe for in-flight + captcha_solve_result for terminal.
 *
 * Keep the script body byte-identical to
 * `agents/browser_tools/captcha_solve_indicator.py` (enforced by unit test).
 */

import type { Browser, BrowserContext } from 'playwright';
import { createLogger } from '../logger';
import type { BrowserCaptchaTelemetry, CaptchaTerminalOutcome } from './captchaTelemetry';

const log = createLogger('CaptchaSolveIndicator');

/** DOM id used by the injected chip — stable for tests and teardown. */
export const CAPTCHA_SOLVE_INDICATOR_DOM_ID = 'rose-captcha-auto-solve-chip';

/** Window flag the injected script reads; set by CDP evaluate from telemetry. */
export const CAPTCHA_SOLVE_INDICATOR_FLAG = '__ROSE_CAPTCHA_AUTO_SOLVE__';

export type CaptchaIndicatorPhase = 'idle' | 'solving' | 'succeeded' | 'failed';

export interface CaptchaIndicatorMemory {
  lastSolving: boolean;
  lastShownOutcomeKey: string | null;
  /** Wall-clock ms — keep showing solving while we wait for a terminal outcome. */
  awaitTerminalUntil: number;
}

export function emptyCaptchaIndicatorMemory(): CaptchaIndicatorMemory {
  return { lastSolving: false, lastShownOutcomeKey: null, awaitTerminalUntil: 0 };
}

/**
 * IIFE installed via Page.addScriptToEvaluateOnNewDocument / addInitScript.
 * TakeControlChip-style pill with enter/exit + solving→terminal icon morph.
 */
export const CAPTCHA_SOLVE_INDICATOR_SCRIPT = String.raw`(() => {
  if (window.__ROSE_CAPTCHA_AUTO_SOLVE__ && window.__ROSE_CAPTCHA_AUTO_SOLVE__.__roseInstalled) return;
  const CHIP_ID = 'rose-captcha-auto-solve-chip';
  const STYLE_ID = 'rose-captcha-auto-solve-chip-style';
  const HOLD_MS = 2200;
  const EXIT_MS = 280;
  const state = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || {
    phase: 'idle',
    solving: false,
  });
  state.__roseInstalled = true;
  state.holdingUntil = 0;
  state.hideTimer = 0;
  state.exitTimer = 0;

  function ensureStyle() {
    if (document.getElementById(STYLE_ID)) return;
    const style = document.createElement('style');
    style.id = STYLE_ID;
    style.textContent = [
      '#' + CHIP_ID + '{',
      '  position:fixed!important;left:50%!important;bottom:40px!important;right:auto!important;top:auto!important;',
      '  transform:translateX(-50%) translateY(10px)!important;',
      '  opacity:0!important;',
      '  z-index:2147483647!important;pointer-events:none!important;',
      '  display:flex!important;align-items:center!important;justify-content:center!important;gap:8px!important;',
      '  padding:8px 16px!important;margin:0!important;box-sizing:border-box!important;',
      '  max-width:calc(100vw - 24px)!important;',
      '  border-radius:9999px!important;border:1px solid rgba(255,255,255,0.10)!important;',
      '  background:#272725!important;color:#ffffff!important;',
      '  font:500 14px/1.2 -apple-system,BlinkMacSystemFont,"Segoe UI",sans-serif!important;',
      '  box-shadow:0 25px 50px -12px rgba(0,0,0,0.55)!important;',
      '  white-space:nowrap!important;',
      '  transition:opacity 220ms ease,transform 220ms ease!important;',
      '}',
      '#' + CHIP_ID + '[data-visible="1"]{',
      '  opacity:1!important;transform:translateX(-50%) translateY(0)!important;',
      '}',
      '#' + CHIP_ID + '[data-phase="succeeded"]{',
      '  border-color:rgba(74,222,128,0.35)!important;',
      '}',
      '#' + CHIP_ID + '[data-phase="failed"]{',
      '  border-color:rgba(248,113,113,0.40)!important;',
      '}',
      '#' + CHIP_ID + ' .rose-captcha-spinner{',
      '  width:14px!important;height:14px!important;border-radius:50%!important;flex:0 0 auto!important;',
      '  border:2px solid rgba(255,255,255,0.25)!important;border-top-color:#60a5fa!important;',
      '  animation:rose-captcha-spin 0.75s linear infinite!important;',
      '}',
      '@keyframes rose-captcha-spin{to{transform:rotate(360deg)}}',
      '#' + CHIP_ID + ' .rose-captcha-mark{',
      '  width:14px!important;height:14px!important;flex:0 0 auto!important;',
      '  display:inline-flex!important;align-items:center!important;justify-content:center!important;',
      '  font-size:12px!important;font-weight:700!important;line-height:1!important;',
      '  animation:rose-captcha-pop 280ms ease!important;',
      '}',
      '#' + CHIP_ID + ' .rose-captcha-mark.ok{color:#4ade80!important;}',
      '#' + CHIP_ID + ' .rose-captcha-mark.bad{color:#f87171!important;}',
      '@keyframes rose-captcha-pop{from{transform:scale(0.4);opacity:0}to{transform:scale(1);opacity:1}}',
      '#' + CHIP_ID + ' .rose-captcha-label{',
      '  font-size:14px!important;font-weight:500!important;color:#ffffff!important;',
      '}',
    ].join('');
    (document.head || document.documentElement).appendChild(style);
  }

  function clearTimers() {
    if (state.hideTimer) { clearTimeout(state.hideTimer); state.hideTimer = 0; }
    if (state.exitTimer) { clearTimeout(state.exitTimer); state.exitTimer = 0; }
  }

  function iconHtml(phase) {
    if (phase === 'succeeded') return '<span class="rose-captcha-mark ok" aria-hidden="true">✓</span>';
    if (phase === 'failed') return '<span class="rose-captcha-mark bad" aria-hidden="true">✕</span>';
    return '<div class="rose-captcha-spinner" aria-hidden="true"></div>';
  }

  function labelFor(phase) {
    if (phase === 'succeeded') return 'CAPTCHA solved';
    if (phase === 'failed') return 'CAPTCHA solve failed';
    return 'Auto-solving CAPTCHA';
  }

  function ensureChip() {
    ensureStyle();
    let el = document.getElementById(CHIP_ID);
    if (el) return el;
    el = document.createElement('div');
    el.id = CHIP_ID;
    el.setAttribute('role', 'status');
    el.setAttribute('aria-live', 'polite');
    el.setAttribute('data-rose-captcha-auto-solve', '1');
    el.setAttribute('data-visible', '0');
    (document.body || document.documentElement).appendChild(el);
    return el;
  }

  function paint(phase) {
    const el = ensureChip();
    el.setAttribute('data-phase', phase);
    el.innerHTML = iconHtml(phase) + '<span class="rose-captcha-label">' + labelFor(phase) + '</span>';
    requestAnimationFrame(function () {
      el.setAttribute('data-visible', '1');
    });
  }

  function hideChip() {
    const el = document.getElementById(CHIP_ID);
    if (!el) return;
    el.setAttribute('data-visible', '0');
    state.exitTimer = setTimeout(function () {
      const cur = document.getElementById(CHIP_ID);
      if (cur && cur.getAttribute('data-visible') === '0') cur.remove();
      state.exitTimer = 0;
    }, EXIT_MS);
  }

  function applyPhase(phase) {
    state.phase = phase;
    state.solving = phase === 'solving';
    if (phase === 'idle') {
      clearTimers();
      state.holdingUntil = 0;
      hideChip();
      return;
    }
    clearTimers();
    paint(phase);
    if (phase === 'succeeded' || phase === 'failed') {
      state.holdingUntil = Date.now() + HOLD_MS;
      state.hideTimer = setTimeout(function () {
        state.hideTimer = 0;
        state.holdingUntil = 0;
        state.phase = 'idle';
        state.solving = false;
        hideChip();
      }, HOLD_MS);
    } else {
      state.holdingUntil = 0;
    }
  }

  state.setPhase = function setPhase(next) {
    const phase =
      next === 'solving' || next === 'succeeded' || next === 'failed' || next === 'idle'
        ? next
        : 'idle';
    if (phase === 'idle' && Date.now() < (state.holdingUntil || 0)) {
      return state.phase;
    }
    if (phase === state.phase && phase !== 'idle') return state.phase;
    applyPhase(phase);
    return state.phase;
  };

  // Back-compat for older callers that only toggle solving.
  state.setSolving = function setSolving(next) {
    return state.setPhase(next === true ? 'solving' : 'idle');
  };

  function start() {
    if (state.phase && state.phase !== 'idle') applyPhase(state.phase);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', start, { once: true });
  } else {
    start();
  }
})();`;

/** CDP/Page.evaluate expression that sets the chip phase from provider telemetry. */
export function captchaSolveIndicatorSetPhaseScript(phase: CaptchaIndicatorPhase): string {
  const safe =
    phase === 'solving' || phase === 'succeeded' || phase === 'failed' || phase === 'idle'
      ? phase
      : 'idle';
  return (
    `(() => {` +
    `const s = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || { phase: 'idle', solving: false });` +
    `if (typeof s.setPhase === 'function') { return s.setPhase(${JSON.stringify(safe)}); }` +
    `s.phase = ${JSON.stringify(safe)}; s.solving = ${safe === 'solving' ? 'true' : 'false'};` +
    `return s.phase;` +
    `})()`
  );
}

/** @deprecated Prefer captchaSolveIndicatorSetPhaseScript. */
export function captchaSolveIndicatorSetSolvingScript(solving: boolean): string {
  return captchaSolveIndicatorSetPhaseScript(solving ? 'solving' : 'idle');
}

function outcomeKey(outcome: CaptchaTerminalOutcome): string {
  return [
    outcome.status,
    outcome.timestampMicros ?? '',
    outcome.websiteHost ?? '',
    outcome.durationMs ?? '',
    outcome.errorCode ?? '',
  ].join('|');
}

function mapOutcomeStatusToPhase(status: string): CaptchaIndicatorPhase | null {
  const normalized = status.toLowerCase();
  if (normalized === 'success' || normalized === 'solved') return 'succeeded';
  if (
    normalized === 'failure' ||
    normalized === 'timeout' ||
    normalized === 'abandoned' ||
    normalized === 'failed_to_solve' ||
    normalized === 'validation_failed' ||
    normalized === 'failed_to_detect'
  ) {
    return 'failed';
  }
  return null;
}

/**
 * Decide whether the live-view chip should be on (solving only).
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
  // Kernel and Tilion (cdp_observe) expose no in-flight solve flag, so a live
  // challenge-widget probe stands in for "solver is engaged".
  if (telemetry.provider === 'kernel' || telemetry.provider === 'tilion') {
    return options.kernelChallengeWidgetsPresent === true;
  }
  return false;
}

const TERMINAL_AWAIT_MS = 5_000;
const FRESH_OUTCOME_MS = 15_000;

/**
 * Resolve idle|solving|succeeded|failed with stable off-solve transitions.
 *
 * Callers keep `memory` across polls. When solving ends we wait briefly for a
 * terminal outcome (Steel task status / Kernel captcha_solve_result) before
 * falling to idle so the chip can animate success/fail instead of vanishing.
 */
export function resolveCaptchaIndicatorPhase(
  telemetry: Pick<BrowserCaptchaTelemetry, 'provider' | 'isSolving' | 'latestOutcome'>,
  options: { kernelChallengeWidgetsPresent?: boolean } = {},
  memory: CaptchaIndicatorMemory = emptyCaptchaIndicatorMemory()
): { phase: CaptchaIndicatorPhase; memory: CaptchaIndicatorMemory } {
  const solving = resolveCaptchaAutoSolveActive(telemetry, options);
  const outcome = telemetry.latestOutcome;
  const key = outcome ? outcomeKey(outcome) : null;
  const now = Date.now();

  if (solving) {
    return {
      phase: 'solving',
      memory: {
        lastSolving: true,
        lastShownOutcomeKey: memory.lastShownOutcomeKey,
        awaitTerminalUntil: 0,
      },
    };
  }

  let awaitUntil = memory.awaitTerminalUntil;
  let lastSolving = memory.lastSolving;
  if (lastSolving) {
    // Solving just dropped — hold a short window for the terminal event to land.
    awaitUntil = now + TERMINAL_AWAIT_MS;
    lastSolving = false;
  }

  if (key && key !== memory.lastShownOutcomeKey && outcome) {
    const terminal = mapOutcomeStatusToPhase(outcome.status);
    if (terminal) {
      const ageMs =
        typeof outcome.timestampMicros === 'number'
          ? now - outcome.timestampMicros / 1000
          : Number.POSITIVE_INFINITY;
      const fresh = Number.isFinite(ageMs) && ageMs >= 0 && ageMs < FRESH_OUTCOME_MS;
      const awaited = now < awaitUntil;
      if (awaited || fresh) {
        return {
          phase: terminal,
          memory: {
            lastSolving: false,
            lastShownOutcomeKey: key,
            awaitTerminalUntil: 0,
          },
        };
      }
    }
  }

  if (now < awaitUntil) {
    return {
      phase: 'solving',
      memory: {
        lastSolving: false,
        lastShownOutcomeKey: memory.lastShownOutcomeKey,
        awaitTerminalUntil: awaitUntil,
      },
    };
  }

  return {
    phase: 'idle',
    memory: {
      lastSolving: false,
      lastShownOutcomeKey: memory.lastShownOutcomeKey,
      awaitTerminalUntil: 0,
    },
  };
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

/** Push the latest telemetry-derived phase into an open Playwright page. */
export async function applyCaptchaSolveIndicatorFromTelemetry(
  browser: Browser,
  telemetry: Pick<BrowserCaptchaTelemetry, 'provider' | 'isSolving' | 'latestOutcome'>,
  options: { kernelChallengeWidgetsPresent?: boolean } = {},
  memory: CaptchaIndicatorMemory = emptyCaptchaIndicatorMemory()
): Promise<{ phase: CaptchaIndicatorPhase; memory: CaptchaIndicatorMemory }> {
  const resolved = resolveCaptchaIndicatorPhase(telemetry, options, memory);
  const script = captchaSolveIndicatorSetPhaseScript(resolved.phase);
  for (const context of browser.contexts()) {
    for (const page of context.pages()) {
      await page.evaluate(script).catch(() => undefined);
    }
  }
  return resolved;
}
