/**
 * Steel host split (2026):
 * - REST API: api.steel.dev
 * - CDP / live-view: connect.steel.dev
 *
 * Legacy connect.steelbrowser.com currently fails TLS from our runners
 * (SSL_ERROR_SYSCALL) and must not be the REST default — that caused
 * Kernel→Steel rotate-proxy to fail with "Connection error" under coverage.
 */

export const STEEL_API_BASE_URL = (process.env.STEEL_BASE_URL ?? 'https://api.steel.dev').replace(
  /\/+$/,
  ''
);

export const STEEL_CDP_BASE_URL = (
  process.env.STEEL_CONNECT_URL ?? 'wss://connect.steel.dev'
).replace(/\/+$/, '');

/** HTTPS origin for Steel session player / live-view URLs. */
export const STEEL_LIVE_VIEW_BASE_URL = (
  process.env.STEEL_LIVE_VIEW_BASE_URL ?? 'https://connect.steel.dev'
).replace(/\/+$/, '');

const STEEL_CDP_HOST = new URL(STEEL_CDP_BASE_URL).host;
const STEEL_CDP_HOSTS = new Set([STEEL_CDP_HOST, 'connect.steel.dev', 'connect.steelbrowser.com']);

function isSteelCdpUrl(url: URL): boolean {
  return STEEL_CDP_HOSTS.has(url.host);
}

function removeApiKey(url: URL): void {
  for (const key of [...url.searchParams.keys()]) {
    if (key.toLowerCase() === 'apikey') url.searchParams.delete(key);
  }
}

export function steelApiUrl(path: string): string {
  return `${STEEL_API_BASE_URL}/${path.replace(/^\/+/, '')}`;
}

export function steelSessionFileUrl(sessionId: string, relativePath: string): string {
  const encodedPath = relativePath
    .split('/')
    .map((segment) => encodeURIComponent(segment))
    .join('/');
  return steelApiUrl(`v1/sessions/${encodeURIComponent(sessionId)}/files/${encodedPath}`);
}

/** Return the non-secret URL that is safe to persist and expose to workers. */
export function steelCdpUrl(sessionId: string): string {
  const url = new URL(STEEL_CDP_BASE_URL);
  removeApiKey(url);
  url.searchParams.set('sessionId', sessionId);
  return url.toString();
}

/** Remove credentials from legacy persisted Steel URLs before exposing them. */
export function steelPublicCdpUrl(wsUrl: string): string {
  let url: URL;
  try {
    url = new URL(wsUrl);
  } catch {
    return wsUrl;
  }
  if (!isSteelCdpUrl(url)) return wsUrl;
  removeApiKey(url);
  return url.toString();
}

/** Add the Steel key only at the process-local CDP connection boundary. */
export function steelCdpConnectionUrl(wsUrl: string): string {
  const url = new URL(wsUrl);
  if (!isSteelCdpUrl(url)) return wsUrl;
  const apiKey = process.env.STEEL_API_KEY?.trim();
  if (!apiKey) throw new Error('STEEL_API_KEY is required to connect to a Steel CDP session');
  removeApiKey(url);
  url.searchParams.set('apiKey', apiKey);
  return url.toString();
}

export function steelDebugUrl(debugUrl: string): string {
  const url = new URL(debugUrl);
  const apiHost = new URL(STEEL_API_BASE_URL).hostname;
  const liveViewExplicitlyConfigured = Boolean(process.env.STEEL_LIVE_VIEW_BASE_URL?.trim());
  // Normalize public API / legacy hosts onto the live-view origin. Custom
  // STEEL_BASE_URL hosts only rewrite when STEEL_LIVE_VIEW_BASE_URL is set —
  // otherwise keep the custom host (do not invent public connect.steel.dev).
  const shouldRewriteToLiveView =
    url.hostname === 'api.steel.dev' ||
    url.hostname === 'connect.steel.dev' ||
    url.hostname === 'connect.steelbrowser.com' ||
    (url.hostname === apiHost && (apiHost === 'api.steel.dev' || liveViewExplicitlyConfigured));
  if (shouldRewriteToLiveView) {
    const liveOrigin = new URL(STEEL_LIVE_VIEW_BASE_URL);
    url.protocol = liveOrigin.protocol;
    url.host = liveOrigin.host;
  }
  url.searchParams.set('interactive', 'false');
  return url.toString();
}
