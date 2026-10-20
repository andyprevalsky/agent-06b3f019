/**
 * Per-provider account adapters: how a provider's accounts are enumerated and
 * how ONE account's data is removed.
 *
 *   resolveAccountAdapter(provider)
 *     ├─ exact slug  (gmail, plaid, claude_code, imessage, …)
 *     ├─ slug family (browser cookies, *_passwords, *_passkeys, document sources)
 *     └─ fallback    row-only: no provider data exists beyond the Integration row
 *
 * A `todo` hook means account-scoped deletion is not implemented yet: the
 * generic DELETE answers 501 rather than claiming a deletion that left data
 * behind. Each per-integration lane (plan rows I1–I8) replaces its todo with an
 * implemented hook and a blackbox case proving the data is gone.
 */

import { VALID_BROWSERS } from './config';
import * as repo from './repo.integration';
import { findIntegrationAccount } from './repo.accounts';
import { deleteCookiesForProfile, deleteCookieBundlesForProfile } from './repo.bulk';
import { findPlaidItemForUser, PlaidItemStatus } from './repo.plaid';
import { disconnectGmailAccount, GmailAccountNotFoundError } from './service';
import { disconnectPlaidItem } from './service.plaid';
import { deleteLanternIntegration, LanternCredentialError } from './service.lantern';
import { KNOWN_SOURCES as DOCUMENT_SOURCES } from './uploadService.documents';
import { cookieProfileFromAccountId } from './syncAccountsContract';

/** Lanes that own a provider's account-scoped cleanup (plan rows I1–I8). */
export type IntegrationLane =
  | 'L-INT-IMESSAGE'
  | 'L-INT-WHATSAPP'
  | 'L-INT-GMAIL'
  | 'L-INT-LINKEDIN'
  | 'L-INT-PLAID'
  | 'L-INT-COOKIES'
  | 'L-INT-PASSWORDS'
  | 'L-INT-TELEGRAM'
  | 'unassigned';

/** `accountId` is the STORAGE key (`''` = legacy/default account). */
export interface AccountCleanupContext {
  userId: string;
  provider: string;
  accountId: string;
}

export type AccountCleanupHook =
  | {
      status: 'implemented';
      /** Remove the account and its data. Resolves false when it does not exist. */
      deleteAccountData: (ctx: AccountCleanupContext) => Promise<boolean>;
    }
  | { status: 'todo'; owner: IntegrationLane; reason: string };

/**
 * `row`: each Integration row is one account. `email_credentials` / `plaid_items`:
 * one container row fans out to per-address / per-item accounts.
 */
export type AccountListKind = 'row' | 'email_credentials' | 'plaid_items' | 'browser_cookies';

export interface IntegrationAccountAdapter {
  list: AccountListKind;
  cleanup: AccountCleanupHook;
}

/** The account's Integration row IS its data (credential envelope in config). */
async function deleteRowAccount(ctx: AccountCleanupContext): Promise<boolean> {
  const row = await findIntegrationAccount(ctx.userId, ctx.provider, ctx.accountId);
  if (row === null) return false;
  await repo.deleteIntegration(row.id);
  return true;
}

/** Gmail account = one address: drop its credential and queue its Google data purge. */
async function deleteGmailAccount(ctx: AccountCleanupContext): Promise<boolean> {
  if (ctx.accountId === '') return false;
  try {
    await disconnectGmailAccount(ctx.userId, ctx.accountId);
    return true;
  } catch (error: unknown) {
    if (error instanceof GmailAccountNotFoundError) return false;
    throw error;
  }
}

/** Plaid account = one Item: revoke it, delete its transactions, tombstone it. */
async function deletePlaidAccount(ctx: AccountCleanupContext): Promise<boolean> {
  if (ctx.accountId === '') return false;
  const item = await findPlaidItemForUser(ctx.userId, ctx.accountId);
  if (item === null || item.status === PlaidItemStatus.DISCONNECTED) return false;
  await disconnectPlaidItem(ctx.userId, ctx.accountId);
  return true;
}

/**
 * Cookie account = one browser profile. The account id spells the profile as
 * `<browser>:<profile>` (legacy empty profile = `default`/storage `''`), so the
 * deletion resolves back to the exact rows the account view derived. Removes
 * that profile's cookies AND its SSO cookie bundles, nothing else.
 */
async function deleteCookieProfileAccount(ctx: AccountCleanupContext): Promise<boolean> {
  const browserProfile = cookieProfileFromAccountId(ctx.provider, ctx.accountId);
  const cookies = await deleteCookiesForProfile({
    userId: ctx.userId,
    browserSource: ctx.provider,
    browserProfile,
  });
  const bundles = await deleteCookieBundlesForProfile({
    userId: ctx.userId,
    browserSource: ctx.provider,
    browserProfile,
  });
  return cookies.count > 0 || bundles.count > 0;
}

async function deleteLanternAccount(ctx: AccountCleanupContext): Promise<boolean> {
  if (ctx.accountId !== '') return false;
  try {
    await deleteLanternIntegration(ctx.userId);
    return true;
  } catch (error: unknown) {
    if (error instanceof LanternCredentialError && error.status === 404) return false;
    throw error;
  }
}

const hook = (
  deleteAccountData: (ctx: AccountCleanupContext) => Promise<boolean>
): AccountCleanupHook => ({ status: 'implemented', deleteAccountData });
const todo = (owner: IntegrationLane, reason: string): AccountCleanupHook => ({
  status: 'todo',
  owner,
  reason,
});

const ROW_ONLY: IntegrationAccountAdapter = { list: 'row', cleanup: hook(deleteRowAccount) };

const EXACT: Record<string, IntegrationAccountAdapter> = {
  gmail: { list: 'email_credentials', cleanup: hook(deleteGmailAccount) },
  plaid: { list: 'plaid_items', cleanup: hook(deletePlaidAccount) },
  claude_code: ROW_ONLY,
  gpt_code: ROW_ONLY,
  lantern_people: { list: 'row', cleanup: hook(deleteLanternAccount) },
  yahoo: {
    list: 'email_credentials',
    cleanup: todo('unassigned', 'Yahoo has no per-address disconnect or data purge yet'),
  },
  imessage: {
    list: 'row',
    cleanup: todo('L-INT-IMESSAGE', 'messages are keyed by user+source, not by Mac device id'),
  },
  whatsapp: {
    list: 'row',
    cleanup: todo('L-INT-WHATSAPP', 'messages and auth state are not keyed by WhatsApp account'),
  },
  telegram: {
    list: 'row',
    cleanup: todo('L-INT-TELEGRAM', 'messages and sessions are not keyed by Telegram account'),
  },
  linkedin: {
    list: 'row',
    cleanup: todo('L-INT-LINKEDIN', 'imported connections are not keyed by LinkedIn account'),
  },
  // The fingerprint is one credential blob on the Integration row (not keyed by
  // profile), so its single `default` account is removed by dropping the row.
  browser_fingerprint: ROW_ONLY,
  apple_passwords: {
    list: 'row',
    cleanup: todo('L-INT-PASSWORDS', 'BrowserPassword is unique per origin+username, not source'),
  },
  contacts: { list: 'row', cleanup: todo('unassigned', 'VCF contacts are not keyed by source') },
  email: { list: 'row', cleanup: todo('unassigned', 'archive-imported email is not keyed') },
  agentcard: {
    list: 'row',
    cleanup: todo('unassigned', 'payment credential; removed through the AgentCard flow'),
  },
};

function familyAdapter(provider: string): IntegrationAccountAdapter | null {
  if (VALID_BROWSERS.includes(provider)) {
    return { list: 'browser_cookies', cleanup: hook(deleteCookieProfileAccount) };
  }
  if (provider.endsWith('_passwords') || provider.endsWith('_passkeys')) {
    return {
      list: 'row',
      cleanup: todo('L-INT-PASSWORDS', 'passwords/passkeys are not keyed by source+profile'),
    };
  }
  if (DOCUMENT_SOURCES.has(provider)) {
    return { list: 'row', cleanup: todo('unassigned', 'documents are keyed by source only') };
  }
  return null;
}

export function resolveAccountAdapter(provider: string): IntegrationAccountAdapter {
  return EXACT[provider] ?? familyAdapter(provider) ?? ROW_ONLY;
}

/** Container providers: their `''` row holds every account, so its removal removes all. */
export function isContainerProvider(provider: string): boolean {
  return resolveAccountAdapter(provider).list !== 'row';
}
