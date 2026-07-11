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
 *     opens its native connect modal (iMessage / SMS / WhatsApp / Telegram).
 *   - subscription / kyc / other → open the carried URL (Stripe Checkout / KYC
 *     hosted links are minted fresh at raise-time and stay valid).
 */

import { startGmailOAuthApi } from '@/features/integrations/api';
import { getMacAppBridge } from './macAppBridge';
import type { GateMetadata } from './types';

/** Sources connected through a Gmail-style web OAuth flow. */
const GMAIL_OAUTH_SOURCES = new Set(['gmail', 'email']);
/** Sources that connect through the Mac app (device sync / QR / login). */
const MAC_APP_CONNECT_SOURCES = new Set(['imessage', 'sms', 'whatsapp', 'telegram']);

export interface GateConnectContext {
  requestId: string;
  agentId?: string | null;
}

/** Parse the concrete source from a source_connect gate ("source_connect:gmail"). */
export function gateSourceKey(gate: GateMetadata): string | null {
  const match = /^source_connect:(.+)$/.exec(gate.gateKey);
  return match ? match[1] : null;
}

/** Open a URL the right way for the current surface (Mac app vs web). */
function openConnectUrl(url: string): void {
  const bridge = getMacAppBridge();
  if (bridge?.openExternal) {
    void bridge.openExternal(url);
    return;
  }
  // Web: navigate in-place so the OAuth/connect redirect returns to this page.
  window.location.assign(url);
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
        const returnUrl = getMacAppBridge() ? undefined : window.location.href;
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

  // subscription / kyc / other web sources: the carried URL is fresh + stable.
  window.open(gate.action.url, '_blank', 'noopener,noreferrer');
}
