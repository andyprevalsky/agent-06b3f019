/**
 * Steel provider types and error classes.
 */

import { createLogger } from "../logger";

export const log = createLogger("Steel");

/**
 * Thrown when Steel.dev returns HTTP 429 (concurrent session limit reached).
 * The agent should back off and retry rather than failing immediately.
 */
export class SteelRateLimitError extends Error {
  constructor(message: string = 'Steel session rate limit exceeded') {
    super(message);
    this.name = 'SteelRateLimitError';
  }
}

/**
 * Fingerprint data structure from mac-app
 */
export interface FingerprintData {
  navigator: {
    userAgent: string;
    platform: string;
    language: string;
    languages: string[];
    hardwareConcurrency: number;
    deviceMemory: number | null;
    maxTouchPoints: number;
    vendor: string;
    doNotTrack: string | null;
  };
  // Client Hints (navigator.userAgentData.getHighEntropyValues)
  userAgentData: {
    brands: Array<{ brand: string; version: string }>;
    mobile: boolean;
    platform: string;
    platformVersion: string;
    architecture: string;
    bitness: string;
    model: string;
    fullVersionList: Array<{ brand: string; version: string }>;
  } | null;
  screen: {
    width: number;
    height: number;
    availWidth: number;
    availHeight: number;
    colorDepth: number;
    pixelDepth: number;
    devicePixelRatio: number;
  };
  // Viewport dimensions (window.innerWidth/innerHeight)
  viewport: {
    innerWidth: number;
    innerHeight: number;
    outerWidth: number;
    outerHeight: number;
  };
  // Network Information API (navigator.connection)
  connection: {
    effectiveType: string;
    downlink: number;
    rtt: number;
    saveData: boolean;
  } | null;
  webgl: {
    vendor: string;
    renderer: string;
  };
  canvas: {
    hash: string;
  };
  audio: {
    hash: string;
  };
  timezone: string;
  // Timezone offset in minutes (for Date.getTimezoneOffset())
  timezoneOffset: number;
  fonts: string[];
  plugins: string[];
  collectedAt: string;
}

/**
 * File info returned by Steel's files.list() API
 */
export interface SteelFileInfo {
  path: string;
  size: number;
  lastModified?: string;
}
