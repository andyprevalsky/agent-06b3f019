/**
 * Mac-app IPC bridge accessor.
 *
 * The Electron preload script exposes a small IPC surface on
 * `window.api`. This helper centralizes the unsafe `window` cast so callers
 * never need `any` — they get a typed `MacAppBridge | undefined` back.
 */

import type { MacAppBridge } from './types';

export function getMacAppBridge(): MacAppBridge | undefined {
  if (typeof window === 'undefined') return undefined;
  const bridge = (window as unknown as { api?: MacAppBridge }).api;
  return bridge;
}

export function hasIMessageBridge(): boolean {
  return typeof getMacAppBridge()?.sendIMessage === 'function';
}
