import type { MeetingNotesProvider, IntegrationCatalogKey } from './types';
import type { BrowserType } from '@/features/integration-handlers-context';
import { BACKEND_BASE_URL } from '@/lib/backendUrl';

/** Shared provider metadata for the meeting note taker category. */

export const MEETING_NOTES_TITLE = 'Meeting note taker';
export const MEETING_NOTES_PUBLIC_ORIGIN = 'https://www.roselabs.ai';
export const MEETING_NOTES_PROVIDERS = ['granola', 'fireflies'] as const;

export const meetingNotesProviders = {
  granola: { name: 'Granola', domain: 'granola.ai', meetingDocument: 'granola_note' },
  fireflies: { name: 'Fireflies', domain: 'fireflies.ai', meetingDocument: 'fireflies_note' },
} as const;

export const meetingNotesCallbackPath = (provider: MeetingNotesProvider) =>
  `/integrations/${provider}/callback`;
export const meetingNotesReturnKey = (provider: MeetingNotesProvider) =>
  `rose.${provider}.returnPath`;

export const INTEGRATION_CATALOG = {
  iphone: { title: 'Phone', aliases: 'cloud iphone ios android mobile phone apps device' },
  browsers: {
    title: 'Browser Cookies',
    aliases:
      'chrome safari edge brave arc opera vivaldi chromium atlas browser cookies sessions websites login',
  },
  passwords: {
    title: 'Passwords',
    aliases: 'chrome apple icloud keychain passkeys credentials atlas passwords autofill',
  },
  messages: {
    title: 'Messages',
    aliases: 'imessage gmail google mail email whatsapp telegram messenger chat messages inbox',
  },
  compute: {
    title: 'Compute',
    aliases:
      'claude anthropic claude.ai chatgpt codex openai chatgpt.com gemini google subscriptions models ai coding',
  },
  banks: {
    title: 'Banks & Financial Accounts',
    aliases: 'plaid plaid.com bank financial accounts money transactions balance',
  },
  socials: {
    title: 'Socials',
    aliases: 'x twitter x.com linkedin linkedin.com instagram instagram.com social contacts',
  },
  files: { title: 'File System', aliases: 'files folders documents disk mac local filesystem' },
  meetingNotes: {
    title: MEETING_NOTES_TITLE,
    aliases: `${Object.values(meetingNotesProviders)
      .map(({ name, domain }) => `${name} ${domain}`)
      .join(' ')} meeting notes transcript transcripts summary summaries recording calls`,
  },
  projects: {
    title: 'Projects',
    aliases:
      'projects github gh git repository repositories repo code import computer local env dotenv secrets folders',
  },
  pebble: {
    title: 'Wearables',
    aliases: 'pebble index 01 ring wearable wearables audio recording webhook other',
  },
  other: {
    title: 'Other',
    aliases: 'other request new integration missing not listed suggest add',
  },
  clis: {
    title: 'CLIs',
    aliases: 'cli command line terminal tools github gh vercel fly stripe supabase',
  },
  mcp: {
    title: 'MCP servers',
    aliases: 'mcp model context protocol tools context7 server servers remote oauth api key',
  },
} as const satisfies Record<IntegrationCatalogKey, { title: string; aliases: string }>;

export const API_BASE_URL = BACKEND_BASE_URL;

export const API_BASE_WITH_PATH = `${API_BASE_URL}/api`;

export const VALID_BROWSER_TYPES: BrowserType[] = [
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

/** How long (ms) to poll for Gmail OAuth completion in Electron. */
export const GMAIL_POLL_TIMEOUT_MS = 120_000;

/** Interval (ms) between Gmail OAuth polls in Electron. */
export const GMAIL_POLL_INTERVAL_MS = 2_000;

// ─── Plaid (consolidated from former features/plaid) ────────────────────────

/**
 * LocalStorage key holding the Plaid `link_token` while the user is mid-flow
 * through an OAuth-bank redirect. The OAuth-return page reads this back and
 * resumes Link with `receivedRedirectUri` so the user does not have to retype
 * credentials.
 */
export const PLAID_OAUTH_LINK_TOKEN_STORAGE_KEY = 'rose:plaid:oauth:link_token';
export const PLAID_OAUTH_CONTEXT_STORAGE_KEY = 'rose:plaid:oauth:context';

/**
 * In-app route that Plaid redirects OAuth banks back to. Must be registered in
 * the Plaid Dashboard (Team Settings → API → Allowed redirect URIs) for the
 * relevant environment.
 */
export const PLAID_OAUTH_REDIRECT_PATH = '/plaid-oauth-redirect';

/**
 * Rose page Granola returns the browser to after sign-in. It posts the code to
 * the backend with the signed-in user's own session (never an unauthenticated
 * callback). The Mac app opens sign-in in the system browser, so it returns to
 * the public site.
 */
export const GRANOLA_CALLBACK_PATH = meetingNotesCallbackPath('granola');
export const GRANOLA_RETURN_KEY = meetingNotesReturnKey('granola');
export const GRANOLA_PUBLIC_ORIGIN = MEETING_NOTES_PUBLIC_ORIGIN;

/**
 * Rose page an MCP server's OAuth sign-in returns the browser to. It posts the
 * code with the signed-in user's own session, then goes back to the page that
 * started sign-in (remembered under MCP_RETURN_KEY).
 */
export const MCP_CALLBACK_PATH = '/integrations/mcp/callback';
export const MCP_RETURN_KEY = 'rose.mcp.returnPath';

/** The backend redirects here after Google's consent, reopening the desktop app. */
export const DESKTOP_OAUTH_RETURN_URL = 'roselabs://oauth-complete';
