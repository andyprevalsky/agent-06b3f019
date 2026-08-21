/**
 * Per-account Gmail health derivation, driven by a REAL captured payload.
 *
 * The fixture below is the verbatim `emailCredentials` array returned by
 * GET /api/integrations for the account this feature was built against
 * (captured 2026-08-19). It matters that it is real rather than idealized: the
 * live row set contains two half-finished OAuth attempts with `email: null`
 * that a hand-written fixture would never have included, and rendering those as
 * blank, un-reconnectable chips would be its own bug.
 */

import { describe, expect, it } from 'vitest';

import {
  gmailAccounts,
  hasDamagedGmailAccount,
} from '@/features/integrations/hooks/useIntegrationData';
import type { ConnectedIntegration } from '@/features/integrations/types';

/** Verbatim from the live API response. */
const LIVE_GMAIL: ConnectedIntegration = {
  id: '26f1b782-b056-4436-a944-a5366e161444',
  name: 'gmail',
  status: 'SYNC_FAILED',
  isActive: true,
  config: {
    connectedEmail: 'a@roselabs.ai',
    connectedEmails: ['a@roselabs.ai', 'andyprevalsky111@gmail.com'],
  },
  emailCredentials: [
    {
      id: '0e814ba1-8205-418e-b2f8-72dbd7aec90c',
      email: null,
      state: 'connected',
      lastErrorReason: null,
      lastFailedSyncAt: null,
    },
    {
      id: '5a8d7ec8-ed2e-47b9-bbdc-f1ccb0bf4f8f',
      email: null,
      state: 'connected',
      lastErrorReason: null,
      lastFailedSyncAt: null,
    },
    {
      id: '08bba989-4222-4779-bc64-0bac450e40d8',
      email: 'a@roselabs.ai',
      state: 'connected',
      lastErrorReason: null,
      lastFailedSyncAt: null,
    },
    {
      id: 'b4b2f3fc-6209-4ba3-a4d1-9aad4329f35d',
      email: 'andyprevalsky111@gmail.com',
      state: 'needs_reconnect',
      lastErrorReason: 'Access was revoked or expired. Reconnect this account to restore it.',
      lastFailedSyncAt: '2026-08-19T19:20:04.626Z',
    },
  ],
};

describe('gmailAccounts (live payload)', () => {
  it('drops credentials with no email address', () => {
    const accounts = gmailAccounts(LIVE_GMAIL);
    expect(accounts).toHaveLength(2);
    expect(accounts.map((a) => a.email)).toEqual(['a@roselabs.ai', 'andyprevalsky111@gmail.com']);
  });

  it('marks exactly the revoked account, and carries its reason', () => {
    const accounts = gmailAccounts(LIVE_GMAIL);
    const healthy = accounts.find((a) => a.email === 'a@roselabs.ai')!;
    const broken = accounts.find((a) => a.email === 'andyprevalsky111@gmail.com')!;

    expect(healthy.state).toBe('connected');
    expect(broken.state).toBe('needs_reconnect');
    expect(broken.lastErrorReason).toMatch(/revoked or expired/i);
  });

  it('reports the section as needing reconnection', () => {
    expect(hasDamagedGmailAccount([LIVE_GMAIL])).toBe(true);
  });

  it('reports a fully healthy integration as fine', () => {
    const healthy: ConnectedIntegration = {
      ...LIVE_GMAIL,
      emailCredentials: LIVE_GMAIL.emailCredentials!.map((c) => ({
        ...c,
        state: 'connected' as const,
        lastErrorReason: null,
      })),
    };
    expect(hasDamagedGmailAccount([healthy])).toBe(false);
  });

  it('falls back to the legacy email list when the API sends no credentials', () => {
    // A backend that predates per-account health must still render chips.
    const legacy: ConnectedIntegration = {
      id: 'int-gmail',
      name: 'gmail',
      status: 'CONNECTED',
      isActive: true,
      config: { connectedEmails: ['old@gmail.com'] },
    };
    expect(gmailAccounts(legacy)).toEqual([
      { email: 'old@gmail.com', state: 'connected', lastErrorReason: null },
    ]);
    expect(hasDamagedGmailAccount([legacy])).toBe(false);
  });

  it('reports nothing for a user with no gmail integration', () => {
    expect(gmailAccounts(undefined)).toEqual([]);
    expect(hasDamagedGmailAccount([])).toBe(false);
  });
});
