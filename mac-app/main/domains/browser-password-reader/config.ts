import path from 'path';
import { app } from 'electron';
import type { BrowserConfig, BrowserType } from './types';

/**
 * Log prefix used across browser-password-reader layers. Centralized so
 * repo / service / runtime log lines stay aligned and greppable.
 */
export const BROWSER_PASSWORD_READER_LOG_PREFIX = '[BrowserPasswordReader]';

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
 * AES-128 block size, shared by every v10 Safe Storage password entry.
 */
export const AES_BLOCK_SIZE = 16;

/**
 * Three-byte ASCII marker that prefixes Safe Storage AES-encrypted values
 * on macOS. Anything else is either plaintext or an unknown encoding.
 */
export const V10_PREFIX = 'v10';

/**
 * RSA-2048 public key used to encrypt the AES-256 payload key. The matching
 * private key is stored as `PAYMENT_DECRYPTION_KEY` on agent workers — the
 * same key pair we use for payment encryption, so passwords can be unsealed
 * in the same decryption context.
 */
export const RSA_PUBLIC_KEY_PEM = `-----BEGIN PUBLIC KEY-----
MIIBIjANBgkqhkiG9w0BAQEFAAOCAQ8AMIIBCgKCAQEAjSyJhixvre5abdAOA8QK
MZN9ftryV1ST5bQ/Ne2SsA0LUlsy/t0gVickAHf/iMAI473qBGrJIgYgEBrnQ9Vy
ak1DpYWG9rC8KNZs/AQnWHiDWKGNUwWTAbT0fZeDHbckgJXiAok2U23F7tHtA1v6
V65dHj1C+wlb8bBkJtDgSxKIcG6GMZFfR5Arzq8ILQ20mtAP2HW80SeWGiw6Ecnd
a0RL0kn3Mqzjuw8NB4Iqx7UThKuIZdEnUhdnlVcXhfpEJUngcOm6pqQGNQok+VtL
MHxsrQsQo0UMgE8zQamTXpTGJEB1G22gPaEY5FB2V8dgWs6PxBTaYZMOH9TRy2G4
EwIDAQAB
-----END PUBLIC KEY-----`;

/**
 * AES-256-GCM key / IV sizes used by the password envelope.
 */
export const AES_GCM_KEY_LENGTH = 32;
export const AES_GCM_IV_LENGTH = 12;

/**
 * Browser-scoped temp-file name for the per-invocation DB copy. Including
 * the browser type keeps concurrent reads across browsers from colliding.
 */
export function tempLoginDataFilename(browserType: BrowserType): string {
  return `LoginData-${browserType}-copy`;
}

/**
 * Per-browser wiring minus the fully-joined login-data path. `$HOME`
 * resolution happens at `getBrowserConfigs()` call time so the blackbox's
 * mocked `app.getPath('home')` value is honored.
 */
type BrowserConfigSeed = Omit<BrowserConfig, 'loginDataPathPattern'> & {
  /** Path fragment rooted at `$HOME` — joined on lookup. */
  relativeLoginDataPath: string;
};

const BROWSER_SEEDS: readonly BrowserConfigSeed[] = [
  {
    type: 'chrome',
    name: 'Chrome',
    relativeLoginDataPath: 'Library/Application Support/Google/Chrome/*/Login Data',
    keychainEntry: 'Chrome Safe Storage',
    keychainAccount: 'Chrome',
  },
  {
    type: 'edge',
    name: 'Microsoft Edge',
    relativeLoginDataPath: 'Library/Application Support/Microsoft Edge/Default/Login Data',
    keychainEntry: 'Microsoft Edge Safe Storage',
    keychainAccount: 'Microsoft Edge',
  },
  {
    type: 'brave',
    name: 'Brave',
    relativeLoginDataPath:
      'Library/Application Support/BraveSoftware/Brave-Browser/Default/Login Data',
    keychainEntry: 'Brave Safe Storage',
    keychainAccount: 'Brave',
  },
  {
    type: 'arc',
    name: 'Arc',
    relativeLoginDataPath: 'Library/Application Support/Arc/User Data/Default/Login Data',
    keychainEntry: 'Arc Safe Storage',
    keychainAccount: 'Arc',
  },
  {
    type: 'opera',
    name: 'Opera',
    relativeLoginDataPath: 'Library/Application Support/com.operasoftware.Opera/Login Data',
    keychainEntry: 'Opera Safe Storage',
    keychainAccount: 'Opera',
  },
  {
    type: 'vivaldi',
    name: 'Vivaldi',
    relativeLoginDataPath: 'Library/Application Support/Vivaldi/Default/Login Data',
    keychainEntry: 'Vivaldi Safe Storage',
    keychainAccount: 'Vivaldi',
  },
  {
    type: 'chromium',
    name: 'Chromium',
    relativeLoginDataPath: 'Library/Application Support/Chromium/Default/Login Data',
    keychainEntry: 'Chromium Safe Storage',
    keychainAccount: 'Chromium',
  },
  {
    type: 'atlas',
    name: 'ChatGPT Atlas',
    // Atlas stores passwords in browser-data/host/user-*/Login Data (wildcard for user profile).
    relativeLoginDataPath:
      'Library/Application Support/com.openai.atlas/browser-data/host/user-*/Login Data',
    keychainEntry: 'ChatGPT Safe Storage',
    keychainAccount: 'ChatGPT',
  },
];

/**
 * Build the static per-browser config map lazily. Done in a function so
 * that `app.getPath('home')` — which throws in some test environments when
 * called at module-eval time — runs under the caller's mocks.
 */
export function getBrowserConfigs(): Record<BrowserType, BrowserConfig> {
  const home = app.getPath('home');
  const entries = BROWSER_SEEDS.map(
    ({ relativeLoginDataPath, ...rest }): [BrowserType, BrowserConfig] => [
      rest.type,
      { ...rest, loginDataPathPattern: path.join(home, relativeLoginDataPath) },
    ]
  );
  return Object.fromEntries(entries) as Record<BrowserType, BrowserConfig>;
}
