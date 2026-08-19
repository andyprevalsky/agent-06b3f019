import { type EmailProviderConfig, type EmailProviderSlug, EmailProvider } from './types';

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

export const EMAIL_PROVIDER_CONFIG: Record<EmailProviderSlug, EmailProviderConfig> = {
  gmail: {
    provider: EmailProvider.GMAIL,
    authUrl: 'https://accounts.google.com/o/oauth2/v2/auth',
    tokenUrl: 'https://oauth2.googleapis.com/token',
    clientId: process.env.GMAIL_WEB_CLIENT_ID,
    clientSecret: process.env.GMAIL_WEB_CLIENT_SECRET,
    scopes: [
      'https://www.googleapis.com/auth/gmail.readonly',
      'https://www.googleapis.com/auth/gmail.send',
      'https://www.googleapis.com/auth/userinfo.email',
    ],
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

export const ALLOWED_REDIRECT_PATTERNS = [
  /^https?:\/\/localhost(:\d+)?/,
  /^https?:\/\/127\.0\.0\.1(:\d+)?/,
  /^https:\/\/[^/]*\.vercel\.app/,
  /^https:\/\/roselabs\.ai/,
  /^roselabs:\/\//,
];

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

// Auth cookie name patterns that indicate a logged-in session
export const AUTH_COOKIE_PATTERNS = [
  'session',
  'sess',
  'auth',
  'token',
  'login',
  'logged',
  'user',
  'usr',
  'sso',
  'jwt',
  'bearer',
  'access',
  'refresh',
  'credential',
  'identity',
  'account',
  'member',
  'subscriber',
];

// False positive patterns (tracking cookies, not auth)
export const FALSE_POSITIVE_COOKIES = [
  'cf_clearance',
  '_ga',
  '_gid',
  '_gcl',
  '_fbp',
  '_fbc',
  'mp_',
  '_hp5_',
  '_hjSession',
  'OptanonConsent',
  '_pin_unauth',
  'intercom-',
  '__stripe_mid',
  '_rdt_uuid',
  '_tt_enable_cookie',
  '_ttp',
  '_uetvid',
  'hubspotutk',
  '__hstc',
  '__kla_id',
  'ajs_anonymous_id',
  'ph_phc_',
  '_clck',
  '_clsk',
  '_scid',
  '_sctr',
  'FPID',
  'FPAU',
  '_derived_epik',
  '_zitok',
  'receive-cookie-deprecation',
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
