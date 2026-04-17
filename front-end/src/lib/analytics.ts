/**
 * Canonical analytics wrapper around @amplitude/analytics-browser.
 * Domain code must import from here instead of importing amplitude directly —
 * enforced via the `no-restricted-imports` ESLint rule.
 */

import * as amplitude from '@amplitude/analytics-browser';

type TrackProperties = Record<string, unknown>;

export function track(event: string, properties?: TrackProperties): void {
  amplitude.track(event, properties);
}

export function setUserId(userId: string | undefined): void {
  amplitude.setUserId(userId);
}

export function reset(): void {
  amplitude.reset();
}

export function init(apiKey: string, options?: Parameters<typeof amplitude.init>[2]): void {
  amplitude.init(apiKey, options);
}

export function addPlugin(plugin: Parameters<typeof amplitude.add>[0]): void {
  amplitude.add(plugin);
}
