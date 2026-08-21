import type { Page } from 'playwright';

/**
 * @deprecated Path allowlists are forbidden. Kept as a no-op export for older
 * imports/tests; always returns false.
 */
export function targetLooksLikePaymentDocument(_url: string): boolean {
  return false;
}

function hostnameOf(url: string): string {
  try {
    return new URL(url).hostname.toLowerCase();
  } catch {
    return '';
  }
}

function pathOf(url: string): string {
  try {
    return (new URL(url).pathname || '/').toLowerCase();
  } catch {
    return '';
  }
}

/** True when a blocked URL looks like a third-party script/CDN resource. */
export function resourceUrlLooksLikeScriptCdn(url: string | null | undefined): boolean {
  if (!url) return false;
  const host = hostnameOf(url);
  const path = pathOf(url);
  if (host) {
    const label = host.split('.', 1)[0] ?? '';
    // js.* CDN hosts almost always serve executable scripts.
    if (label === 'js') return true;
  }
  if (path.endsWith('.js') || path.includes('/js/')) return true;
  if (path.endsWith('/v3') || path.endsWith('/v3/')) return true;
  return false;
}

/**
 * True when the blocked resource that triggered recovery must be re-verified
 * before promote. Any absolute http(s) critical-resource URL qualifies — no
 * vendor host allowlists. Script-shaped URLs also get a ``<script>`` re-load.
 */
export function blockedResourceRequiresPaymentCdn(url: string | null | undefined): boolean {
  if (!url) return false;
  const trimmed = url.trim();
  return trimmed.startsWith('http://') || trimmed.startsWith('https://');
}

export interface PaymentCdnProbeResult {
  paymentCdnOk: boolean;
  paymentCdnHosts: Record<string, boolean>;
}

/**
 * Probe reachability of the blocked third-party resource from the candidate page.
 *
 * When ``blockedResourceUrl`` is set, fetch it (no-cors) and — if it looks like
 * a script CDN — also load it as a ``<script>`` tag. Fetch alone is insufficient:
 * some proxies allow opaque fetch while script execution is ORB-blocked.
 *
 * No vendor host allowlists: the URL that failed is the URL we re-verify.
 */
export async function probePaymentCdnReachable(
  page: Page,
  blockedResourceUrl?: string | null
): Promise<PaymentCdnProbeResult> {
  const target = (blockedResourceUrl || '').trim();
  if (!target) {
    // Sticky require without a URL cannot vendor-probe; treat as pass so CF-only
    // sticky state does not invent a hardcoded CDN list.
    return { paymentCdnOk: true, paymentCdnHosts: {} };
  }

  const host = hostnameOf(target) || 'blocked_resource';
  const asScript = resourceUrlLooksLikeScriptCdn(target);

  const paymentCdnHosts = await page
    .evaluate(
      async ({
        url,
        hostKey,
        loadAsScript,
      }: {
        url: string;
        hostKey: string;
        loadAsScript: boolean;
      }) => {
        const hosts: Record<string, boolean> = {};
        try {
          const controller = new AbortController();
          const timer = setTimeout(() => controller.abort(), 8_000);
          await fetch(url, {
            method: 'GET',
            mode: 'no-cors',
            signal: controller.signal,
            credentials: 'omit',
          });
          clearTimeout(timer);
          hosts[hostKey] = true;
        } catch {
          hosts[hostKey] = false;
        }

        if (!loadAsScript) {
          return hosts;
        }

        type ProbeScript = {
          src: string;
          async: boolean;
          remove: () => void;
          onload: (() => void) | null;
          onerror: (() => void) | null;
        };
        type DocGlobal = {
          document: {
            createElement: (tag: string) => ProbeScript;
            head: { appendChild: (node: ProbeScript) => void };
          };
        };
        const root = globalThis as unknown as DocGlobal;
        hosts['script.load'] = await new Promise<boolean>((resolve) => {
          const script = root.document.createElement('script');
          script.src = url;
          script.async = true;
          const timer = setTimeout(() => {
            script.remove();
            resolve(false);
          }, 10_000);
          script.onload = () => {
            clearTimeout(timer);
            script.remove();
            resolve(true);
          };
          script.onerror = () => {
            clearTimeout(timer);
            script.remove();
            resolve(false);
          };
          root.document.head.appendChild(script);
        });
        return hosts;
      },
      { url: target, hostKey: host, loadAsScript: asScript }
    )
    .catch(() => {
      const failed: Record<string, boolean> = { [host]: false };
      if (asScript) failed['script.load'] = false;
      return failed;
    });

  const paymentCdnOk = asScript
    ? Boolean(paymentCdnHosts[host] && paymentCdnHosts['script.load'])
    : Boolean(paymentCdnHosts[host]);
  return { paymentCdnOk, paymentCdnHosts };
}
