"""In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.

Chip is driven by provider CAPTCHA telemetry (pushed via CDP), not by
captcha DOM presence alone. Keep the install script body byte-identical to
``back-end/src/providers/browser/captchaSolveIndicator.ts``.
"""

from __future__ import annotations

import json
import time
from typing import Any, Mapping, MutableMapping, TypedDict

CAPTCHA_SOLVE_INDICATOR_DOM_ID = "rose-captcha-auto-solve-chip"
CAPTCHA_SOLVE_INDICATOR_FLAG = "__ROSE_CAPTCHA_AUTO_SOLVE__"

# Keep in sync with back-end captchaSolveIndicator.ts CAPTCHA_SOLVE_INDICATOR_SCRIPT.
CAPTCHA_SOLVE_INDICATOR_SCRIPT = r"""(() => {
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
})();"""

CAPTCHA_WIDGET_PRESENT_SCRIPT = r"""(() => {
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
})()"""


class CaptchaIndicatorMemory(TypedDict):
    last_solving: bool
    last_shown_outcome_key: str | None
    await_terminal_until: float


def empty_captcha_indicator_memory() -> CaptchaIndicatorMemory:
    return {
        "last_solving": False,
        "last_shown_outcome_key": None,
        "await_terminal_until": 0.0,
    }


def captcha_solve_indicator_set_phase_script(phase: str) -> str:
    safe = phase if phase in {"idle", "solving", "succeeded", "failed"} else "idle"
    encoded = json.dumps(safe)
    solving_js = "true" if safe == "solving" else "false"
    return (
        "(() => {"
        "const s = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || { phase: 'idle', solving: false });"
        f"if (typeof s.setPhase === 'function') {{ return s.setPhase({encoded}); }}"
        f"s.phase = {encoded}; s.solving = {solving_js};"
        "return s.phase;"
        "})()"
    )


def captcha_solve_indicator_set_solving_script(solving: bool) -> str:
    return captcha_solve_indicator_set_phase_script("solving" if solving else "idle")


def resolve_captcha_auto_solve_active(
    telemetry: Mapping[str, Any],
    *,
    kernel_challenge_widgets_present: bool = False,
) -> bool:
    """Mirror of back-end resolveCaptchaAutoSolveActive."""
    is_solving = telemetry.get("isSolving")
    if is_solving is True:
        return True
    if is_solving is False:
        return False
    if telemetry.get("provider") == "kernel":
        return kernel_challenge_widgets_present is True
    return False


def _outcome_key(outcome: Mapping[str, Any]) -> str:
    return "|".join(
        [
            str(outcome.get("status") or ""),
            str(outcome.get("timestampMicros") if outcome.get("timestampMicros") is not None else ""),
            str(outcome.get("websiteHost") or ""),
            str(outcome.get("durationMs") if outcome.get("durationMs") is not None else ""),
            str(outcome.get("errorCode") or ""),
        ]
    )


def _map_outcome_status_to_phase(status: str) -> str | None:
    normalized = status.lower()
    if normalized in {"success", "solved"}:
        return "succeeded"
    if normalized in {
        "failure",
        "timeout",
        "abandoned",
        "failed_to_solve",
        "validation_failed",
        "failed_to_detect",
    }:
        return "failed"
    return None


TERMINAL_AWAIT_MS = 5_000
FRESH_OUTCOME_MS = 15_000


def resolve_captcha_indicator_phase(
    telemetry: Mapping[str, Any],
    *,
    kernel_challenge_widgets_present: bool = False,
    memory: CaptchaIndicatorMemory | None = None,
) -> tuple[str, CaptchaIndicatorMemory]:
    """Mirror of back-end resolveCaptchaIndicatorPhase."""
    mem = memory or empty_captcha_indicator_memory()
    solving = resolve_captcha_auto_solve_active(
        telemetry,
        kernel_challenge_widgets_present=kernel_challenge_widgets_present,
    )
    outcome = telemetry.get("latestOutcome")
    key = _outcome_key(outcome) if isinstance(outcome, Mapping) else None
    now_ms = time.time() * 1000.0

    if solving:
        return "solving", {
            "last_solving": True,
            "last_shown_outcome_key": mem["last_shown_outcome_key"],
            "await_terminal_until": 0.0,
        }

    await_until = float(mem.get("await_terminal_until") or 0.0)
    last_solving = bool(mem.get("last_solving"))
    if last_solving:
        await_until = now_ms + TERMINAL_AWAIT_MS
        last_solving = False

    if key and key != mem.get("last_shown_outcome_key") and isinstance(outcome, Mapping):
        terminal = _map_outcome_status_to_phase(str(outcome.get("status") or ""))
        if terminal:
            ts = outcome.get("timestampMicros")
            age_ms = (now_ms - (float(ts) / 1000.0)) if ts is not None else float("inf")
            fresh = age_ms >= 0 and age_ms < FRESH_OUTCOME_MS
            awaited = now_ms < await_until
            if awaited or fresh:
                return terminal, {
                    "last_solving": False,
                    "last_shown_outcome_key": key,
                    "await_terminal_until": 0.0,
                }

    if now_ms < await_until:
        return "solving", {
            "last_solving": False,
            "last_shown_outcome_key": mem["last_shown_outcome_key"],
            "await_terminal_until": await_until,
        }

    return "idle", {
        "last_solving": False,
        "last_shown_outcome_key": mem["last_shown_outcome_key"],
        "await_terminal_until": 0.0,
    }


async def poll_captcha_indicator_phase(
    dom_service: Any,
    *,
    fetch_telemetry: Any,
    config: Any,
    task_id: str,
    memory: MutableMapping[str, Any],
) -> str:
    """Fetch provider CAPTCHA telemetry and resolve chip phase."""
    telemetry = await fetch_telemetry(config, task_id)
    widgets = False
    if telemetry.get("isSolving") is None and telemetry.get("provider") == "kernel":
        widgets = await dom_service.probe_captcha_widgets_present()
    mem: CaptchaIndicatorMemory = {
        "last_solving": bool(memory.get("last_solving", False)),
        "last_shown_outcome_key": memory.get("last_shown_outcome_key"),
        "await_terminal_until": float(memory.get("await_terminal_until") or 0.0),
    }
    phase, next_mem = resolve_captcha_indicator_phase(
        telemetry,
        kernel_challenge_widgets_present=widgets,
        memory=mem,
    )
    memory.update(next_mem)
    return phase


def start_captcha_telemetry_indicator_for_task(
    dom_service: Any,
    *,
    fetch_telemetry: Any,
    config: Any,
    task_id: str,
) -> None:
    """Background-poll CAPTCHA telemetry into the live-view chip."""
    memory: dict[str, Any] = dict(empty_captcha_indicator_memory())

    async def _poll() -> str:
        return await poll_captcha_indicator_phase(
            dom_service,
            fetch_telemetry=fetch_telemetry,
            config=config,
            task_id=task_id,
            memory=memory,
        )

    dom_service.start_captcha_telemetry_indicator(_poll)
