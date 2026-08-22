"""In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.

Chip is driven by provider CAPTCHA telemetry (pushed via CDP), not by
captcha DOM presence alone. Keep the install script body byte-identical to
``back-end/src/providers/browser/captchaSolveIndicator.ts``.
"""

from __future__ import annotations

from typing import Any, Mapping

CAPTCHA_SOLVE_INDICATOR_DOM_ID = "rose-captcha-auto-solve-chip"
CAPTCHA_SOLVE_INDICATOR_FLAG = "__ROSE_CAPTCHA_AUTO_SOLVE__"

# Keep in sync with back-end captchaSolveIndicator.ts CAPTCHA_SOLVE_INDICATOR_SCRIPT.
CAPTCHA_SOLVE_INDICATOR_SCRIPT = r"""(() => {
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


def captcha_solve_indicator_set_solving_script(solving: bool) -> str:
    flag = "true" if solving else "false"
    return (
        "(() => {"
        "const s = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || { solving: false });"
        f"if (typeof s.setSolving === 'function') {{ s.setSolving({flag}); }}"
        f"else {{ s.solving = {flag}; }}"
        "return !!s.solving;"
        "})()"
    )


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


async def poll_captcha_auto_solve_active(
    dom_service: Any,
    *,
    fetch_telemetry: Any,
    config: Any,
    task_id: str,
) -> bool:
    """Fetch provider CAPTCHA telemetry and resolve chip on/off."""
    telemetry = await fetch_telemetry(config, task_id)
    widgets = False
    if telemetry.get("isSolving") is None and telemetry.get("provider") == "kernel":
        widgets = await dom_service.probe_captcha_widgets_present()
    return resolve_captcha_auto_solve_active(
        telemetry,
        kernel_challenge_widgets_present=widgets,
    )


def start_captcha_telemetry_indicator_for_task(
    dom_service: Any,
    *,
    fetch_telemetry: Any,
    config: Any,
    task_id: str,
) -> None:
    """Background-poll CAPTCHA telemetry into the live-view chip."""

    async def _poll() -> bool:
        return await poll_captcha_auto_solve_active(
            dom_service,
            fetch_telemetry=fetch_telemetry,
            config=config,
            task_id=task_id,
        )

    dom_service.start_captcha_telemetry_indicator(_poll)
