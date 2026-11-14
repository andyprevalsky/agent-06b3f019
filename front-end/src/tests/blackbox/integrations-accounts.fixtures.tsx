/**
 * Shared fixtures for the Rose Desktop integrations suites (single-account
 * rows, Gmail per-address progress): wire shapes exactly as the backend
 * emits them (lane L-CULL-INTEG: `integrations[].accounts` holds one entry
 * per row; Gmail addresses and Plaid items match their entries by id).
 */
import type { ReactNode } from 'react';
import { act, screen, within } from '@testing-library/react';
import { vi } from 'vitest';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import { Toaster } from '@/components/ui/toaster';
import {
  IntegrationHandlersProvider,
  type IntegrationHandlers,
} from '@/features/integration-handlers-context';

import { capturedRequests } from './msw/capture';
import { server } from './msw/server';
import { renderWithProviders } from './test-wrapper';

export const API_BASE = 'http://localhost:3001/api';

export function progress(overrides: Record<string, unknown> = {}) {
  return {
    pct: null,
    done: null,
    total: null,
    unit: null,
    eta_sec: null,
    phase: null,
    startedAt: null,
    updatedAt: null,
    ...overrides,
  };
}

/** IntegrationAccount as GET /api/integrations returns it. */
export function account(provider: string, accountId: string, extra: Record<string, unknown> = {}) {
  return {
    provider,
    accountId,
    label: null,
    state: 'synced',
    progress: progress({ pct: 100 }),
    lastSyncAt: null,
    lastError: null,
    ...extra,
  };
}

/** One Integration row with its account entries (one entry for single-account rows). */
export function row(
  name: string,
  accounts: unknown[] | undefined,
  extra: Record<string, unknown> = {},
) {
  return {
    id: `int-${name}`,
    name,
    type: 'DATA_SOURCE',
    status: 'CONNECTED',
    isActive: true,
    ...(accounts === undefined ? {} : { accounts }),
    ...extra,
  };
}

export interface ListBody {
  integrations: unknown[];
  accountsByProvider: Record<string, unknown[]>;
}

export interface Served {
  listCalls: number;
  progressCalls: string[];
}

/** GET /integrations (+ the cheap progress poll) from a function, so tests can change it. */
export function serveList(
  list: () => ListBody,
  onProgress?: (since: string | null) => unknown,
): Served {
  const served: Served = { listCalls: 0, progressCalls: [] };
  server.use(
    http.get(`${API_BASE}/integrations/progress`, ({ request }) => {
      const since = new URL(request.url).searchParams.get('since');
      served.progressCalls.push(since ?? '');
      return HttpResponse.json(onProgress?.(since) ?? { cursor: 'c0', changed: false });
    }),
    http.get(`${API_BASE}/integrations`, () => {
      served.listCalls += 1;
      const body = list();
      return HttpResponse.json({ ...body, count: body.integrations.length });
    }),
    http.get(`${API_BASE}/integrations/plaid/items`, () => HttpResponse.json({ items: [] })),
    http.get(`${API_BASE}/compute-accounts`, () => HttpResponse.json({ accounts: [] })),
  );
  return served;
}

/** Desktop handlers with browser cookies (cookies, passwords and LinkedIn connect). */
export function desktopHandlers(extra: IntegrationHandlers = {}): IntegrationHandlers {
  return {
    browserCookies: {
      isAvailable: true,
      getInstalledBrowsers: async () => [],
      syncBrowser: async () => {},
      syncBrowserPasswords: async () => ({ success: true }),
      storeAtlasPassword: async () => ({ success: true }),
      openKeychainAccess: async () => ({ success: true }),
    },
    ...extra,
  };
}

export function renderIntegrations(
  options: {
    roseDesktop?: boolean;
    handlers?: IntegrationHandlers;
    children?: ReactNode;
    /** Signed-in user for RoseThemeProvider (store 'dark' under its key for dark mode). */
    roseThemeUserId?: string;
  } = {},
) {
  return renderWithProviders(
    <IntegrationHandlersProvider handlers={options.handlers ?? desktopHandlers()}>
      <Integrations />
      <Toaster />
      {options.children}
    </IntegrationHandlersProvider>,
    { roseDesktop: options.roseDesktop ?? true, roseThemeUserId: options.roseThemeUserId },
  );
}

export const rowEl = (key: string) => screen.getByTestId(`integration-row-${key}`);

export const chipFor = (key: string, label: string) =>
  within(rowEl(key)).getByText(label).closest('[data-tone]');

export type Row = ReturnType<typeof row>;

/** A single-account row: its one entry under the given state/progress. */
export function one(
  name: string,
  entry: Record<string, unknown>,
  extra: Record<string, unknown> = {},
) {
  return row(name, [account(name, 'default', entry)], extra);
}

export function listOf(...rows: Row[]): ListBody {
  const accountsByProvider: Record<string, unknown[]> = {};
  for (const r of rows) {
    const accounts = (r as { accounts?: unknown[] }).accounts;
    if (accounts !== undefined) accountsByProvider[r.name] = accounts;
  }
  return { integrations: rows, accountsByProvider };
}

export async function renderDesktop(options: Parameters<typeof renderIntegrations>[0] = {}) {
  renderIntegrations(options);
  return screen.findByTestId('rose-desktop-integrations');
}

export const chips = (key: string) => [...rowEl(key).querySelectorAll<HTMLElement>('[data-tone]')];
export const bars = (key: string) => within(rowEl(key)).queryAllByTestId('sync-progress');

/** The stock 34px app-icon tile of a row (DropdownIconFrame's inner frame). */
export function iconTile(key: string): HTMLElement {
  const tile = rowEl(key).querySelector<HTMLElement>('.rounded-lg.h-\\[34px\\]');
  if (tile === null) throw new Error(`no icon tile in ${key}`);
  return tile;
}

/** The glow behind a row's icon tile (connected rows only). */
export const iconGlow = (key: string) =>
  rowEl(key).querySelector<HTMLElement>('span[aria-hidden="true"].blur-sm');

export const fakeIntervals = () => vi.useFakeTimers({ toFake: ['setInterval', 'clearInterval'] });

export async function advance(ms: number) {
  await act(async () => {
    await vi.advanceTimersByTimeAsync(ms);
  });
}

export const progressCalls = () =>
  capturedRequests.filter((r) => new URL(r.url).pathname === '/api/integrations/progress');

const HOUR_MS = 3_600_000;
const isoIn = (offsetMs: number) => new Date(Date.now() + offsetMs).toISOString();

export interface ComputeAccountOverrides {
  provider?: string;
  state?: string;
  usage?: unknown;
  rateLimitedUntil?: string | null;
  /** Newer backends only; omitted keys keep the old-backend wire shape. */
  cooldown?: { until: string; reason: CooldownReason; authoritative: boolean } | null;
  nextResetAt?: string | null;
}

/** ComputeAccount as GET /api/compute-accounts returns it. */
export function computeAccount(
  accountId: string,
  accountEmail: string,
  extra: ComputeAccountOverrides = {},
) {
  return {
    provider: 'claude',
    accountId,
    accountEmail,
    state: 'connected',
    lastErrorReason: null,
    connectedAt: '2026-10-01T00:00:00Z',
    usage: null as unknown,
    rateLimitedUntil: null as string | null,
    ...extra,
  };
}

export interface UsageOverrides {
  fiveHour?: { usedPct: number; resetsAt: string | null } | null;
  observedAt?: string;
  source?: 'response' | 'rate_limit' | 'usage_endpoint' | 'code_session' | null;
  status?: 'allowed' | 'allowed_warning' | 'rejected' | null;
}

/** A usage snapshot whose 7d window is `usedPct` used; 5h is 10% used unless overridden. */
export const weekly = (usedPct: number, resetsAt: string | null, extra: UsageOverrides = {}) => ({
  fiveHour: { usedPct: 10, resetsAt: isoIn(2 * HOUR_MS) },
  sevenDay: { usedPct, resetsAt },
  observedAt: isoIn(-60_000),
  ...extra,
});

export type CooldownReason =
  'usage_window_5h' | 'usage_window_7d' | 'usage_window' | 'rate_limit' | 'stall' | 'auth';

export const cooldown = (until: string, reason: CooldownReason, authoritative: boolean) => ({
  until,
  reason,
  authoritative,
});
