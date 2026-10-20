/**
 * Shared fixtures for the Rose Desktop multi-account integrations suites
 * (Gmail I3, LinkedIn I4, passwords I7, WhatsApp I2): wire shapes exactly as
 * back-end/src/domains/integrations/service.accountsView.ts emits them.
 */
import type { ReactNode } from 'react';
import { screen, within } from '@testing-library/react';
import { http, HttpResponse } from 'msw';

import Integrations from '@/pages/Integrations';
import { Toaster } from '@/components/ui/toaster';
import {
  IntegrationHandlersProvider,
  type IntegrationHandlers,
} from '@/features/integration-handlers-context';

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

/** One Integration row; every row of a provider carries that provider's whole account list. */
export function row(name: string, accounts: unknown[], extra: Record<string, unknown> = {}) {
  return {
    id: `int-${name}-${String(extra.accountId ?? '')}`,
    name,
    type: 'DATA_SOURCE',
    status: 'CONNECTED',
    isActive: true,
    accountId: '',
    accounts,
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

/** Desktop handlers with browser cookies (LinkedIn connect) and an optional WhatsApp bridge. */
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
  options: { roseDesktop?: boolean; handlers?: IntegrationHandlers; children?: ReactNode } = {},
) {
  return renderWithProviders(
    <IntegrationHandlersProvider handlers={options.handlers ?? desktopHandlers()}>
      <Integrations />
      <Toaster />
      {options.children}
    </IntegrationHandlersProvider>,
    { roseDesktop: options.roseDesktop ?? true },
  );
}

export const rowEl = (key: string) => screen.getByTestId(`integration-row-${key}`);

export const chipFor = (key: string, label: string) =>
  within(rowEl(key)).getByText(label).closest('[data-tone]');
