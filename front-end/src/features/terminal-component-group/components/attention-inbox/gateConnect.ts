/**
 * Gate primary-action dispatch — shared by every place a Gate card renders
 * (AttentionInbox, inline message stream, and the query-box gate stack).
 *
 * A source_connect gate must NOT open the pre-minted URL that rode along on the
 * gate: an OAuth `authUrl` minted at agent-run time carries a stale `state` and
 * a benchmark-internal `redirect_uri`, so clicking it later yields an "invalid
 * link". Instead we reuse the exact connect paths the Integrations page uses:
 *
 *   - Gmail / email  → mint a FRESH OAuth URL on click (returnUrl = this page),
 *     the same `startGmailOAuthApi` flow as `useGmailConnect`; open in the Mac
 *     app's system browser when embedded, else same-tab so the redirect returns.
 *   - Mac-only src   → deep-link `roselabs://connect-source?...` so the Mac app
 *     opens its native connect modal (iMessage / WhatsApp / Telegram).
 *   - subscription / kyc / other → mint a FRESH hosted link on click when possible
 *     (subscription checkout carries a stale return URL if opened from the gate
 *     action minted at raise-time). Stripe Checkout / KYC hosted links otherwise
 *     open the carried URL.
 */

import { startSubscriptionCheckoutApi } from '@/features/billing/api';
import { startGmailOAuthApi } from '@/features/integrations/api';
import { DESKTOP_OAUTH_RETURN_URL } from '@/features/integrations/config';
import { getMacAppBridge } from './macAppBridge';
import type { GateMetadata } from './types';

/** Sources connected through a Gmail-style web OAuth flow. */
const GMAIL_OAUTH_SOURCES = new Set(['gmail', 'email']);
/** Sources that connect through the Mac app (device sync / QR / login). */
const MAC_APP_CONNECT_SOURCES = new Set(['imessage', 'whatsapp', 'telegram']);

export interface GateConnectContext {
  requestId: string;
  agentId?: string | null;
}

/** Parse the concrete source from a source_connect gate ("source_connect:gmail"). */
export function gateSourceKey(gate: GateMetadata): string | null {
  const match = /^source_connect:(.+)$/.exec(gate.gateKey);
  if (!match) return null;
  const source = match[1];
  // Legacy persisted gates used `sms` before the phantom source was removed;
  // route them to the current iMessage Mac-app connect path.
  return source === 'sms' ? 'imessage' : source;
}

/**
 * Open a connect/OAuth URL for the current surface. Mac app → system browser
 * via the bridge; web → navigate in-place so the OAuth/connect redirect (and
 * `roselabs://` deep link) returns to this page.
 */
function openConnectUrl(url: string): void {
  const bridge = getMacAppBridge();
  if (bridge?.openExternal) {
    void bridge.openExternal(url);
    return;
  }
  window.location.assign(url);
}

/**
 * Open an external hosted link (Stripe Checkout / KYC). Mac app → system browser
 * via the bridge (a plain window.open('_blank') is blocked/captured into a
 * chromeless Electron window); web → a new tab so the agent view stays put and
 * the provider returns via its own success/cancel URL.
 */
function openExternalLink(url: string): void {
  const bridge = getMacAppBridge();
  if (bridge?.openExternal) {
    void bridge.openExternal(url);
    return;
  }
  window.open(url, '_blank', 'noopener,noreferrer');
}

/** Build the Mac-app connect deep link for a device-sync source. */
function connectSourceDeepLink(source: string, ctx: GateConnectContext): string {
  const params = new URLSearchParams({ source, gateId: ctx.requestId });
  if (ctx.agentId) params.set('agentId', ctx.agentId);
  return `roselabs://connect-source?${params.toString()}`;
}

/**
 * Run a Gate's primary "link" action. Returns once the connect surface has been
 * opened. Never throws: a failed fresh-mint falls back to the carried URL so the
 * button always does something.
 */
export async function runGateConnectAction(
  gate: GateMetadata,
  ctx: GateConnectContext,
): Promise<void> {
  if (gate.action.kind !== 'link') return;

  if (gate.type === 'source_connect') {
    const source = gateSourceKey(gate);
    if (source !== null && GMAIL_OAUTH_SOURCES.has(source)) {
      try {
        const returnUrl = getMacAppBridge() ? DESKTOP_OAUTH_RETURN_URL : window.location.href;
        const { authUrl } = await startGmailOAuthApi(returnUrl);
        openConnectUrl(authUrl);
      } catch {
        openConnectUrl(gate.action.url);
      }
      return;
    }
    if (source !== null && MAC_APP_CONNECT_SOURCES.has(source)) {
      openConnectUrl(connectSourceDeepLink(source, ctx));
      return;
    }
  }

  if (gate.type === 'subscription') {
    try {
      const returnUrl = getMacAppBridge() ? undefined : window.location.href;
      const { url } = await startSubscriptionCheckoutApi(returnUrl);
      openExternalLink(url);
    } catch {
      openExternalLink(gate.action.url);
    }
    return;
  }

  // kyc / other web sources: the carried URL is fresh + stable.
  openExternalLink(gate.action.url);
}
