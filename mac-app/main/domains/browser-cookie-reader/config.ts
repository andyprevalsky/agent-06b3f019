import path from 'path';
import { app } from 'electron';
import type { BrowserConfig, BrowserType } from './types';

/**
 * Log prefix used across browser-cookie-reader layers. Centralized so repo /
 * service / runtime log lines stay aligned and greppable.
 */
export const BROWSER_COOKIE_READER_LOG_PREFIX = '[BrowserCookieReader]';

/**
 * PBKDF2 parameters every Chromium-family browser uses on macOS to derive
 * the AES-128 key from the Safe Storage password. Fixed by Chromium — do
 * not change.
 */
export const PBKDF2_SALT = 'saltysalt';
export const PBKDF2_ITERATIONS = 1003;
export const PBKDF2_KEY_LENGTH = 16;
export const PBKDF2_DIGEST = 'sha1';

/**
 * AES-128 block size, shared by every v10 Safe Storage cookie.
 */
export const AES_BLOCK_SIZE = 16;

/**
 * Chrome on macOS prepends 32 bytes of random data before the actual cookie
 * value during encryption. After decryption, we need to skip these 32 bytes.
 * Format: [32 bytes random] + [actual value] + [PKCS7 padding]
 */
export const CHROME_PREFIX_LENGTH = 32;

/**
 * Three-byte ASCII marker that prefixes Safe Storage AES-encrypted cookies
 * on macOS. Anything else is either plaintext or an unknown encoding.
 */
export const V10_PREFIX = 'v10';

/**
 * Browser-scoped temp-file name for the per-invocation DB copy. Including
 * the browser type keeps concurrent reads across browsers from colliding.
 */
export function tempDbFilename(browserType: BrowserType): string {
  return `Cookies-${browserType}-copy`;
}

/**
 * Threshold above which we treat a very low decryption success rate as a
 * "wrong password" signal. Atlas (Data Protection keychain) is the canonical
 * case — if the user typed the wrong keychain password, most rows fail.
 */
export const WRONG_PASSWORD_ROW_THRESHOLD = 10;
export const WRONG_PASSWORD_SUCCESS_RATIO = 0.1;

/**
 * Per-browser wiring minus the fully-joined cookie path. `$HOME` resolution
 * happens at `getBrowserConfigs()` call time so the blackbox's mocked
 * `app.getPath('home')` value is honored.
 */
type BrowserConfigSeed = Omit<BrowserConfig, 'cookiePathPattern'> & {
  /** Path fragment rooted at `$HOME` — joined on lookup. */
  relativeCookiePath: string;
};

const BROWSER_SEEDS: readonly BrowserConfigSeed[] = [
  {
    type: 'chrome',
    name: 'Chrome',
    relativeCookiePath: 'Library/Application Support/Google/Chrome/*/Cookies',
    keychainEntry: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'edge',
    name: 'Microsoft Edge',
    relativeCookiePath: 'Library/Application Support/Microsoft Edge/Default/Cookies',
    keychainEntry: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'brave',
    name: 'Brave',
    relativeCookiePath: 'Library/Application Support/BraveSoftware/Brave-Browser/Default/Cookies',
    keychainEntry: 'Brave Safe Storage',
    keychainAccount: 'Brave',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'arc',
    name: 'Arc',
    relativeCookiePath: 'Library/Application Support/Arc/User Data/Default/Cookies',
    keychainEntry: 'Arc Safe Storage',
    keychainAccount: 'Arc',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'opera',
    name: 'Opera',
    relativeCookiePath: 'Library/Application Support/com.operasoftware.Opera/Cookies',
    keychainEntry: 'Opera Safe Storage',
    keychainAccount: 'Opera',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'vivaldi',
    name: 'Vivaldi',
    relativeCookiePath: 'Library/Application Support/Vivaldi/Default/Cookies',
    keychainEntry: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'chromium',
    name: 'Chromium',
    relativeCookiePath: 'Library/Application Support/Chromium/Default/Cookies',
    keychainEntry: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
    needsManualPassword: false,
    cookieStore: 'sqlite',
  },
  {
    type: 'atlas',
    name: 'ChatGPT Atlas',
    relativeCookiePath:
      'Library/Application Support/com.openai.atlas/browser-data/host/user-*/Cookies',
    keychainEntry: 'ChatGPT Safe Storage',
    keychainAccount: 'ChatGPT',
    needsManualPassword: true,
    cookieStore: 'sqlite',
  },
  {
    type: 'safari',
    name: 'Safari',
    relativeCookiePath:
      'Library/Containers/com.apple.Safari/Data/Library/Cookies/Cookies.binarycookies',
    keychainEntry: '',
    keychainAccount: '',
    needsManualPassword: false,
    cookieStore: 'safariBinary',
  },
];

/**
 * Build the static per-browser config map lazily. Done in a function so that
 * `app.getPath('home')` — which throws in some test environments when called
 * at module-eval time — runs under the caller's mocks.
 */
export function getBrowserConfigs(): Record<BrowserType, BrowserConfig> {
  const home = app.getPath('home');
  const entries = BROWSER_SEEDS.map(
    ({ relativeCookiePath, ...rest }): [BrowserType, BrowserConfig] => [
      rest.type,
      { ...rest, cookiePathPattern: path.join(home, relativeCookiePath) },
    ]
  );
  return Object.fromEntries(entries) as Record<BrowserType, BrowserConfig>;
}
