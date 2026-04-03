import { type EmailProviderConfig, type EmailProviderSlug, EmailProvider } from './types';

export const BACKEND_BASE_URL = (process.env.BACKEND_URL ?? 'http://localhost:3001').replace(
  /\/$/,
  ''
);

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

// RSA-2048 Public Key - same as in browserPasswordReader.ts (mac-app)
// The corresponding private key is stored as PAYMENT_DECRYPTION_KEY on agent workers
export const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjSyJhixvre5abdAOA8QK
MZN9ftryV1ST5bQ/Ne2SsA0LUlsy/t0gVickAHf/iMAI473qBGrJIgYgEBrnQ9Vy
ak1DpYWG9rC8KNZs/AQnWHiDWKGNUwWTAbT0fZeDHbckgJXiAok2U23F7tHtA1v6
V65dHj1C+wlb8bBkJtDgSxKIcG6GMZFfR5Arzq8ILQ20mtAP2HW80SeWGiw6Ecnd
a0RL0kn3Mqzjuw8NB4Iqx7UThKuIZdEnUhdnlVcXhfpEJUngcOm6pqQGNQok+VtL
MHxsrQsQo0UMgE8zQamTXpTGJEB1G22gPaEY5FB2V8dgWs6PxBTaYZMOH9TRy2G4
EwIDAQAB
-----END PUBLIC KEY-----`;
