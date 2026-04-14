import type { BrowserType } from '@/features/integration-handlers-context';

export const API_BASE_URL = (
  import.meta.env.VITE_BACKEND_API_URL || 'http://localhost:3001'
).replace(/\/$/, '');

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
];

/** How long (ms) to poll for Gmail OAuth completion in Electron. */
export const GMAIL_POLL_TIMEOUT_MS = 120_000;

/** Interval (ms) between Gmail OAuth polls in Electron. */
export const GMAIL_POLL_INTERVAL_MS = 2_000;
