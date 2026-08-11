import type { Page } from 'playwright';

const PAYMENT_DOCUMENT_URL_MARKERS = [
  'checkout',
  'payment',
  'billing',
  '/pay',
  'purchase',
  '/cart',
] as const;

/** True when recovery must also require Stripe.js to load (checkout / pay flows). */
export function targetLooksLikePaymentDocument(url: string): boolean {
  const lowered = url.toLowerCase();
  return PAYMENT_DOCUMENT_URL_MARKERS.some((marker) => lowered.includes(marker));
}

export interface PaymentCdnProbeResult {
  paymentCdnOk: boolean;
  paymentCdnHosts: Record<string, boolean>;
}

/**
 * Probe payment CDN reachability from inside the candidate page.
 *
 * Fetch alone is insufficient: Eventim Elements stay empty when (a) api.stripe.com
 * tunnels fail after a js-only promote, or (b) fetch(js.stripe.com) succeeds while
 * `<script src="https://js.stripe.com/v3">` fails with ERR_BLOCKED_BY_ORB /
 * "Failed to load Stripe.js". paymentCdnOk requires js + api fetch AND a real
 * Stripe.js script load that defines window.Stripe.
 */
export async function probePaymentCdnReachable(page: Page): Promise<PaymentCdnProbeResult> {
  const paymentCdnHosts = await page
    .evaluate(async () => {
      const targets: Array<{ host: string; url: string }> = [
        { host: 'js.stripe.com', url: 'https://js.stripe.com/v3/' },
        { host: 'api.stripe.com', url: 'https://api.stripe.com/healthcheck' },
      ];
      const hosts: Record<string, boolean> = {};
      for (const target of targets) {
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          // mode:'no-cors' is required: api.stripe.com (and some js paths) do not
          // send ACAO for checkout.eventim.us, so a default-cors fetch throws even
          // when the proxy tunnel reached the host. Opaque success => tunnel OK.
          // Real Elements traffic runs inside Stripe iframes (stripe.com origin).
          await fetch(target.url, {
            method: 'GET',
            mode: 'no-cors',
            signal: controller.signal,
            credentials: 'omit',
          });
          clearTimeout(timer);
          hosts[target.host] = true;
        } catch {
          hosts[target.host] = false;
        }
      }
      // Script-tag load is what checkout apps use. ORB can let fetch succeed
      // while Stripe.js never defines window.Stripe. Typed without DOM lib —
      // this callback only runs inside Playwright's browser context.
      type ProbeScript = {
        src: string;
        async: boolean;
        remove: () => void;
        onload: (() => void) | null;
        onerror: (() => void) | null;
      };
      type StripeGlobal = {
        Stripe?: unknown;
        document: {
          createElement: (tag: string) => ProbeScript;
          head: { appendChild: (node: ProbeScript) => void };
        };
      };
      const root = globalThis as unknown as StripeGlobal;
      hosts['stripe.js'] = await new Promise<boolean>((resolve) => {
        if (typeof root.Stripe === 'function') {
          resolve(true);
          return;
        }
        const script = root.document.createElement('script');
        script.src = 'https://js.stripe.com/v3';
        script.async = true;
        const timer = setTimeout(() => {
          script.remove();
          resolve(false);
        }, 10_000);
        script.onload = () => {
          clearTimeout(timer);
          const stripe = (globalThis as unknown as StripeGlobal).Stripe;
          script.remove();
          resolve(typeof stripe === 'function');
        };
        script.onerror = () => {
          clearTimeout(timer);
          script.remove();
          resolve(false);
        };
        root.document.head.appendChild(script);
      });
      return hosts;
    })
    .catch(() => ({
      'js.stripe.com': false,
      'api.stripe.com': false,
      'stripe.js': false,
    }));
  const paymentCdnOk = Boolean(
    paymentCdnHosts['js.stripe.com'] &&
      paymentCdnHosts['api.stripe.com'] &&
      paymentCdnHosts['stripe.js']
  );
  return { paymentCdnOk, paymentCdnHosts };
}
