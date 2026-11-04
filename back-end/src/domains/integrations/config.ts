import { type EmailProviderConfig, type EmailProviderSlug, EmailProvider } from './types';
import { GOOGLE_OAUTH_SCOPES } from './googleScopes';

export function googleClientId(): string | undefined {
  // Keep the old production env key until the new Render setting is verified.
  const id =
    process.env.GOOGLE_CLIENT_ID ??
    (process.env.NODE_ENV === 'production' ? process.env.GMAIL_WEB_CLIENT_ID : undefined);
  if (
    process.env.NODE_ENV !== 'production' &&
    id === '1089369266084-hb7bfkb80edcjjtvhdkvemkbf5ro0hp8.apps.googleusercontent.com'
  ) {
    throw new Error('Local development must use a separate Google OAuth client');
  }
  return id;
}

export function googleClientSecret(): string | undefined {
  return (
    process.env.GOOGLE_CLIENT_SECRET ??
    (process.env.NODE_ENV === 'production' ? process.env.GMAIL_WEB_CLIENT_SECRET : undefined)
  );
}

function resolveBackendBaseUrl(): string {
  const configuredUrl = process.env.BACKEND_URL ?? process.env.RENDER_EXTERNAL_URL;
  if (configuredUrl !== undefined && configuredUrl.trim() !== '') {
    return configuredUrl.trim().replace(/\/$/, '');
  }

  if (process.env.NODE_ENV === 'production') {
    throw new Error(
      'BACKEND_URL or RENDER_EXTERNAL_URL env var is required in production for email OAuth callbacks'
    );
  }

  return 'http://localhost:3001';
}

export const BACKEND_BASE_URL = resolveBackendBaseUrl();

export function isAnthropicApiKeyConfigured(): boolean {
  return Boolean(process.env.ANTHROPIC_API_KEY?.trim());
}

export function isOpenRouterApiKeyConfigured(): boolean {
  return Boolean(process.env.OPENROUTER_API_KEY?.trim());
}

export function isGptApiKeyConfigured(): boolean {
  return Boolean(process.env.GPT_API_KEY?.trim());
}

export const EMAIL_PROVIDER_CONFIG: Record<EmailProviderSlug, EmailProviderConfig> = {
  gmail: {
    provider: EmailProvider.GMAIL,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: googleClientId(),
    clientSecret: googleClientSecret(),
    scopes: [...GOOGLE_OAUTH_SCOPES],
    requiresClientSecret: false,
  },
  yahoo: {
    provider: EmailProvider.YAHOO,
    authUrl: 'https://api.login.yahoo.com/oauth2/request_auth',
    tokenUrl: 'https://api.login.yahoo.com/oauth2/get_token',
    clientId: process.env.YAHOO_CLIENT_ID,
    clientSecret: process.env.YAHOO_CLIENT_SECRET,
    scopes: ['mail-r', 'mail-w'],
    requiresClientSecret: true,
  },
};

// Each host is anchored at its end (`(?=[/?#]|$)`), so look-alike hosts such
// as `https://www.roselabs.ai.evil.com` or `http://localhost.evil.com` never match.
export const ALLOWED_REDIRECT_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?(?=[/?#]|$)/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?(?=[/?#]|$)/,
  /^https:\/\/[^/?#:@]*\.vercel\.app(?=[/?#]|$)/,
  /^https:\/\/roselabs\.ai(?=[/?#]|$)/,
  /^https:\/\/www\.roselabs\.ai(?=[/?#]|$)/,
  /^roselabs:\/\//,
];

/** The env the exact-origin redirect checks read (oauthService.isGranolaRedirectOrigin). */
export function webOriginEnvironment(): { NODE_ENV?: string; ALLOWED_ORIGINS?: string } {
  return { NODE_ENV: process.env.NODE_ENV, ALLOWED_ORIGINS: process.env.ALLOWED_ORIGINS };
}

export const VALID_BROWSERS = [
  'chrome',
  'edge',
  'brave',
  'arc',
  'opera',
  'vivaldi',
  'chromium',
  'atlas',
  'safari',
];

// Ad/tracking domains to exclude — only pure ad-tech/tracking infrastructure
// that no real user would intentionally log into
export const AD_TRACKING_DOMAINS = [
  // Google ad/analytics
  'doubleclick.net',
  'googlesyndication.com',
  'googleadservices.com',
  'analytics.google.com',
  // Social tracking pixels (not the main sites)
  'fbcdn.net',
  // Ad exchanges / SSPs / DSPs
  'adition.com',
  'adnxs.com',
  'adprime.com',
  'colossusssp.com',
  'cpmstar.com',
  'deepintent.com',
  'dianomi.com',
  'dotomi.com',
  'eqads.com',
  'extremereach.io',
  'infolinks.com',
  'krushmedia.com',
  'loopme.me',
  'mookie1.com',
  'pubmatic.com',
  'servenobid.com',
  'sharethrough.com',
  'smilewanted.com',
  'stackadapt.com',
  'taboola.com',
  'tappx.com',
  'tsyndicate.com',
  'vrtcal.com',
  'ymmobi.com',
  'connatix.com',
  'openwebmp.com',
  // Ad-tech intermediaries / cookie sync
  'bqstreamer.com',
  'medialiance.com',
  'mediawallahscript.com',
  'minutemedia-prebid.com',
  'rezync.com',
  'rkdms.com',
  'shb-sync.com',
  'tk0x1.com',
  'ib-ibi.com',
  // Tracking / analytics / fingerprinting
  'alphonso.tv',
  'clickonometrics.pl',
  'fly-metrics.net',
  'iesnare.com',
  'intentsify.io',
  'iovation.com',
  'securecafenet.com',
];

// Chromium epoch offset (Jan 1, 1601 to Jan 1, 1970 in microseconds)
export const CHROME_EPOCH_OFFSET_MICROSECONDS = 11644473600n * 1000000n;

// Cache TTL for authenticated domains (5 minutes)
export const AUTH_DOMAINS_CACHE_TTL_MS = 5 * 60 * 1000;

// Admin phone number for password integration requests — must be set in env
export function getAdminPhone(): string {
  const phone = process.env.ADMIN_PHONE?.trim();
  if (phone === undefined || phone === null || phone === '')
    throw new Error('ADMIN_PHONE env var is required');
  return phone;
}

// Multer upload limits
export const UPLOAD_LIMITS = {
  fileSize: 500 * 1024 * 1024, // 500MB max file size
  fieldSize: 200 * 1024 * 1024, // 200MB max field size (for localStorage uploads which can be large)
};

export const PLAID_SKIP_WEBHOOK_VERIFICATION = process.env.PLAID_SKIP_WEBHOOK_VERIFICATION === '1';

/** Whether an integration name is one of the OAuth email providers. */
export function isEmailProviderSlug(name: string): name is EmailProviderSlug {
  return Object.prototype.hasOwnProperty.call(EMAIL_PROVIDER_CONFIG, name);
}
