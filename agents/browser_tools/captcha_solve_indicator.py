"""In-page CAPTCHA auto-solve indicator for Kernel/Steel live views.

Banner is driven by provider CAPTCHA telemetry (pushed via CDP), not by
captcha DOM presence alone. Keep the install script body byte-identical to
``back-end/src/providers/browser/captchaSolveIndicator.ts``.
"""

from __future__ import annotations

from typing import Any, Mapping, Optional

CAPTCHA_SOLVE_INDICATOR_DOM_ID = "rose-captcha-auto-solve-banner"
CAPTCHA_SOLVE_INDICATOR_FLAG = "__ROSE_CAPTCHA_AUTO_SOLVE__"

# Keep in sync with back-end captchaSolveIndicator.ts CAPTCHA_SOLVE_INDICATOR_SCRIPT.
CAPTCHA_SOLVE_INDICATOR_SCRIPT = r"""(() => {
  if (window.__ROSE_CAPTCHA_AUTO_SOLVE__ && window.__ROSE_CAPTCHA_AUTO_SOLVE__.__roseInstalled) return;
  const BANNER_ID = 'rose-captcha-auto-solve-banner';
  const STYLE_ID = 'rose-captcha-auto-solve-banner-style';
  const state = (window.__ROSE_CAPTCHA_AUTO_SOLVE__ = window.__ROSE_CAPTCHA_AUTO_SOLVE__ || {
    solving: false,
  });
  state.__roseInstalled = true;

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
    if (state.solving === true) showBanner();
    else hideBanner();
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
    """Fetch provider CAPTCHA telemetry and resolve banner on/off."""
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
    """Background-poll CAPTCHA telemetry into the live-view banner."""

    async def _poll() -> bool:
        return await poll_captcha_auto_solve_active(
            dom_service,
            fetch_telemetry=fetch_telemetry,
            config=config,
            task_id=task_id,
        )

    dom_service.start_captcha_telemetry_indicator(_poll)
