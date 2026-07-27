/**
 * Admin user-directory client.
 *
 * Lives in lib/ rather than in a feature because two features consume it and
 * cross-feature imports are banned: the admin Users page (features/admin-health)
 * and the always-on account switcher (features/admin-account-switcher).
 *
 * Every call is signed with getAdminAccessToken(), NOT the active session — while
 * impersonating, the active session belongs to the target account and would be
 * rejected by the admin gate, stranding the admin inside the switched account.
 */

import type { Session, User } from '@supabase/supabase-js';

import { backendApiUrl } from './backendUrl';
import {
  beginImpersonation,
  endImpersonation,
  getAdminAccessToken,
  type ImpersonatedAccount,
} from './impersonation';

const REQUEST_TIMEOUT_MS = 15 * 1000;

/** One directory row: an account, a waitlist signup, or both merged by phone. */
export interface AdminDirectoryPerson {
  key: string;
  /** Present when a real account exists — this is what can be switched into. */
  userId: string | null;
  /** Present when the person is on the waitlist — this is what an invite targets. */
  waitlistId: string | null;
  name: string | null;
  email: string | null;
  phone: string | null;
  joinedAt: string;
  invitedAt: string | null;
  hasAccount: boolean;
  hasSubscription: boolean;
  isGated: boolean;
  isAdmin: boolean;
}

export interface AdminDirectoryResponse {
  people: AdminDirectoryPerson[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
  search: string;
}

interface AdminImpersonationResponse {
  session: {
    access_token: string;
    refresh_token: string;
    expires_in: number;
    expires_at: number;
    token_type: string;
  };
  user: ImpersonatedAccount;
}

export interface AdminAccountSwitch {
  account: ImpersonatedAccount;
  session: Session;
}

async function parseError(response: Response): Promise<string> {
  try {
    const body = (await response.json()) as { error?: string };
    if (typeof body.error === 'string' && body.error !== '') return body.error;
  } catch {
    // fall through to status-based message
  }
  return `Request failed (${response.status})`;
}

async function adminFetch(path: string, init: RequestInit = {}): Promise<unknown> {
  const token = getAdminAccessToken();
  if (token === null) throw new Error('Not authenticated');

  const controller = new AbortController();
  const timeoutId = window.setTimeout(() => controller.abort(), REQUEST_TIMEOUT_MS);
  try {
    const response = await fetch(`${backendApiUrl()}${path}`, {
      ...init,
      headers: {
        Authorization: `Bearer ${token}`,
        'Content-Type': 'application/json',
        ...init.headers,
      },
      signal: controller.signal,
    });
    if (!response.ok) throw new Error(await parseError(response));
    return await response.json();
  } finally {
    window.clearTimeout(timeoutId);
  }
}

/** One page of the searchable account + waitlist directory. */
export async function fetchAdminDirectory(params: {
  search: string;
  page: number;
  pageSize: number;
  signal?: AbortSignal;
}): Promise<AdminDirectoryResponse> {
  const query = new URLSearchParams({
    page: String(params.page),
    pageSize: String(params.pageSize),
  });
  if (params.search !== '') query.set('search', params.search);
  return (await adminFetch(`/admin-health/users?${query.toString()}`, {
    signal: params.signal,
  })) as AdminDirectoryResponse;
}

/**
 * Mint a session for `userId`. The backend returns bare tokens, so the Supabase
 * `user` object every client path reads is reconstructed here from the identity
 * the same response carries.
 */
export async function requestAccountSwitch(userId: string): Promise<AdminAccountSwitch> {
  const result = (await adminFetch('/admin-health/impersonate', {
    method: 'POST',
    body: JSON.stringify({ userId }),
  })) as AdminImpersonationResponse;

  const session: Session = {
    access_token: result.session.access_token,
    refresh_token: result.session.refresh_token,
    expires_in: result.session.expires_in,
    expires_at: result.session.expires_at,
    token_type: result.session.token_type,
    user: {
      id: result.user.userId,
      phone: result.user.phone ?? '',
      email: result.user.email ?? '',
      is_anonymous: false,
      aud: 'authenticated',
      role: 'authenticated',
      created_at: new Date().toISOString(),
      updated_at: new Date().toISOString(),
      app_metadata: { provider: 'phone', providers: ['phone'] },
      user_metadata: { name: result.user.name ?? '' },
    } as User,
  };

  return { account: result.user, session };
}

/**
 * Reload onto a clean URL after an identity change.
 *
 * A hard reload is deliberate: agent lists, realtime channel subscriptions, and
 * cached user context are all bound to the previous identity, and rebinding them
 * piecemeal is a long tail of stale-state bugs for a tool only admins touch. The
 * query string is dropped because deep links (?agent-id=…) belong to the account
 * we just left.
 */
function reloadAsNewIdentity(): void {
  window.location.replace(`${window.location.origin}${window.location.pathname}`);
}

/**
 * Step into another account. Stashes the admin session (first hop only) so the
 * switch stays reversible, then reloads the app as the target.
 *
 * Shared by the always-on switcher and the admin Users page — it lives here
 * rather than in either feature because features may not import each other.
 */
export async function switchToAccount(userId: string): Promise<void> {
  const { account, session } = await requestAccountSwitch(userId);
  beginImpersonation(account, session);
  reloadAsNewIdentity();
}

/**
 * Return to the administrator's own account. Reloads even when the stashed
 * session has expired — the badge is gone either way, and the app has to
 * re-derive its signed-in state from scratch.
 */
export function returnToOwnAccount(): void {
  endImpersonation();
  reloadAsNewIdentity();
}

/** Best available human label for a directory row or switched-into account. */
export function displayLabel(person: {
  name?: string | null;
  email?: string | null;
  phone?: string | null;
  userId?: string | null;
}): string {
  const name = person.name?.trim();
  if (name !== undefined && name !== '') return name;
  const email = person.email?.trim();
  if (email !== undefined && email !== '') return email;
  const phone = person.phone?.trim();
  if (phone !== undefined && phone !== '') return phone;
  return person.userId?.slice(0, 8) ?? 'Unknown';
}
